#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* patchd — the root helper that applies and reverts the carplay patch when the
 * iDrive app asks, so no shell is needed. It is the same model as
 * mgu-updater: a root daemon on a /dev/shm socket (root:tm_oap_app, 0660) that
 * the unprivileged app drives.
 *
 * It does two privileged things. On an apply/revert request it runs the vetted,
 * reversible carplay_patch.js (which refuses an unknown binary and keeps a
 * verified backup), with / remounted read-write only for the write. The new
 * binary takes effect when carplay next starts: patchd restarts carplay only
 * when recmgr loaded a carplay restart entry this boot and systemd loaded the
 * tool's carplay.service drop-in (restartCarplay), else at the next head-unit
 * start. It applies no patch on its own. Explicit
 * capture commands go to a separately supervised DLT helper; reading logs does
 * not change tracing mode.
 *
 * Protocol (newline-delimited JSON, one object per line):
 *   app -> patchd  {"cmd":"status"}
 *                  {"cmd":"apply","panel":"high"|"mid","mode":"fifo"|"udp"|"avb","unproven":true?}
 *                    unproven:true only after the user confirmed patching a
 *                    build outside the proven list (status "unproven"); without
 *                    it the first edit of such a build is refused, nothing
 *                    changed. An apply or revert that cannot take the shared
 *                    remount lock within 15 s is refused (state error), never
 *                    written without it.
 *                    all modes apply the variant gate + self-start; they differ
 *                    only in the sink. avb = stock avb:// sink (the mode the app
 *                    applies; the render joins the media bus); udp = udp://
 *                    stream sink (the bridge accepts a stream where it rejects a
 *                    file); fifo = file:// FIFO sink
 *                  {"cmd":"revert"}
 *                  {"cmd":"reboot"} activate a deferred patch with a normal
 *                                   system reboot (so carplay next starts from
 *                                   the patched binary). Only when a change is
 *                                   actually pending (the activation-pending
 *                                   marker exists); never stops/restarts
 *                                   carplay. reboot-reply carries ok/reason.
 *                  {"cmd":"logs"}   carplay + marker + avb log lines, dlt-receive health, patchd log
 *                                   (to the asker, read-only)
 *                  {"cmd":"capture-start"|"capture-stop"|"capture-status"}
 *                                   (capture-reply to the asker; every client gets
 *                                   ev capture, also once a second)
 *   patchd -> app  {"ev":"status","state":...,"panel":...,"mode":...,"res":...,"safe":...,"reason":...,"carplay":...,
 *                   "pending":...,"conflict":...}
 *                    state: original | patched | unknown | busy | error
 *                    mode (when patched): fifo | udp | avb
 *                    res, safe (when the IC_HIGH geometry is patched): the
 *                    advertised size "WxH" and its safe area "WxH+X+Y", else null
 *                    carplay (after an apply/revert that changed the binary):
 *                    restarted | deferred (takes effect at the next head-unit
 *                    start; state is unknown with that reason until then)
 *                    unproven: true when the carplay build is outside the proven
 *                    list and not patched yet (Enable map needs the user's
 *                    confirmation, sent as apply's unproven:true)
 *                    pending: apply | revert, while a written change waits for
 *                    the next head-unit start (carplay is then deferred)
 *                    conflict: why the patch is not applied when the tool is
 *                    installed (a binary the patcher cannot patch, one
 *                    something else modified, a build outside the patcher's
 *                    proven list that Enable map has not patched yet, a
 *                    carplay.service that starts another program)
 *                  {"ev":"log","line":...}   the backlog on connect, then each new line
 *
 * Install-time activation (the deploy tool's activate and deactivate hooks,
 * run as root once a version is in place and before it is removed):
 *
 *   patchd.js activate     applies what Enable map applies to an original or
 *                          an older patch of ours, unless the user reverted
 *                          it or a conflict stands; writes only, never stops
 *                          or restarts carplay: the change waits for the next
 *                          head-unit start (pending apply)
 *   patchd.js deactivate   reverts our patch the same way (pending revert)
 *                          and drops our backup
 *
 * Each prints a JSON line last: "status" what it did, "reboot" why a head-unit
 * start is needed. It exits non-zero only when it changed nothing and could
 * not do its job (the install is then rolled back, the removal refused); a
 * refusal of the patcher to touch a binary it does not know is a conflict,
 * not a failure.
 *
 * Node 8.16.2 on the unit. No dependencies.
 */
'use strict';

var fs = require('fs');
var net = require('net');
var path = require('path');
var cp = require('child_process');

var lock = require('./remount_lock.js');

var HERE = __dirname;
var PATCHER = path.join(HERE, 'carplay_patch.js');
var TARGET = process.env.WOC_CARPLAY || '/usr/bin/carplay';
var FIFO = process.env.WOC_FIFO || '/run/waze-on-cluster/alt.h264';
/* The local UDP sink for udp mode. Must match the render's udp_port
 * (waze-on-cluster.conf); the render listens on 127.0.0.1:UDP_PORT. */
var UDP_PORT = process.env.WOC_UDP_PORT || '20557';
var SOCK = process.env.WOC_PATCH_SOCK || '/dev/shm/waze-on-cluster/patch.sock';
var SOCK_GROUP = process.env.WOC_PATCH_GROUP || 'tm_oap_app';
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';

var clients = [];
var logLines = [];
var busy = false;
var rebooting = false;       /* a reboot was requested; ignore further requests */
var quitting = false;        /* SIGTERM: finish the active patch operation */

/* A deferred patch is activated by a normal head-unit reboot, which makes
 * carplay start from the patched binary. Never a systemctl stop/restart of
 * carplay (that power-cycles the unit via the crash handler). */
var REBOOT_CMD = (process.env.WOC_REBOOT_CMD || 'systemctl reboot').split(' ');
var statusInFlight = false;  /* coalesce the carplay_patch status spawns */
var MAX_LINE = 64 * 1024;    /* drop a client that floods without a newline */

/* How long a write waits for the shared remount lock before it is refused
 * (never written without it): a boot-recovery restore holds it for at most
 * recovery.js RESTORE_BOUND_MS. */
var LOCK_WAIT_MS = parseInt(process.env.WOC_LOCK_WAIT_MS, 10) || 15000;
var LOCK_BUSY_REASON = 'another write to carplay is in progress (boot recovery); nothing changed, try again in a minute';
/* Enable map on a build outside the proven list without the user's
 * confirmation: the patcher refused it, nothing changed. */
var UNPROVEN_REASON = 'untested carplay build: Enable map needs your confirmation; nothing changed';

/* A ring of recent carplay log lines (carplay.service's journal and, by marker,
 * DLT), so the remote diagnostic endpoint can say why "no map" happened without
 * an HMI screenshot. The lines that matter are flagged (the verified carplay
 * 22.28.3 strings; on DLT any app's line with one of them counts). */
var CARPLAY_RING = 600;
var carplayLines = [];
/* The marker lines alone, in their own ring, so the few projection-config
 * markers are not evicted from carplayLines by journal volume over a long
 * capture window before the diagnostics are pulled. */
var MARKER_RING = 500;   /* generous: markers are small, and some patterns are broad */
var markerLines = [];
function pushCarplay(entry) {
    carplayLines.push(entry);
    if (carplayLines.length > CARPLAY_RING) carplayLines.shift();
    if (entry.marker) {
        markerLines.push(entry);
        if (markerLines.length > MARKER_RING) markerLines.shift();
    }
}
var CARPLAY_MARKERS = [
    /* start() preconditions: the variant gate and the advert run only after
     * ConfigCollector has every required property and configInitialized fires;
     * without these lines the gate/advert lines below never appear. */
    'Not all required properties present',                         /* ConfigCollector waiting */
    'configInitialized',                                            /* start() about to run */
    'setupDisplaysConfiguration',                                  /* the /info advert builder */
    'Kombi variant is =',                                           /* Edit 1 took effect */
    'Head-Unit does not support Alternate Displays feature.',       /* patch not active */
    'Adding display:',                                              /* 2 = alt display advertised */
    'The provided IC variant does not support 2nd video screen',    /* ICSafeArea refused */
    'Resolution =',                                                 /* ICSafeArea built a config */
    'Alternate Displays feature not supported by Mobile Device.',   /* the phone declined */
    'Projection Bridge successfully configured',                   /* sink accepted */
    'Projection Bridge configuration failed',                      /* sink rejected/open failed */
    'ShowUI', 'instrumentcluster', 'StopUI', 'ForceKeyframe', 'setStreamStatus',
];
function isMarker(line) {
    for (var i = 0; i < CARPLAY_MARKERS.length; i++)
        if (line.indexOf(CARPLAY_MARKERS[i]) >= 0) return true;
    return false;
}

/* AVB log lines (the streamhandler's journal and, by marker, DLT), for the "avb"
 * test mode (stock sink): does
 * the CarPlay->Kombi video talker (AVB_MGU_CarPlay_Kombi, stream 0x301a9ee108e)
 * appear/activate? Talker active with 0 FIFO bytes means the phone IS sending
 * and our file:// sink was the culprit; silent means the phone never streams. */
var avbLines = [];
var AVB_MARKERS = [
    '301a9ee',             /* the CarPlay->Kombi video stream id */
    'CarPlay', 'D14_1722', 'Talker', 'talker', 'TalkerActive',
];
function isAvbMarker(line) {
    for (var i = 0; i < AVB_MARKERS.length; i++)
        if (line.indexOf(AVB_MARKERS[i]) >= 0) return true;
    return false;
}

function log(line) {
    var l = '[' + new Date().toISOString() + '] ' + line;
    logLines.push(l);
    if (logLines.length > 60) logLines.shift();
    send({ ev: 'log', line: l });
    process.stdout.write(l + '\n');
}

function send(obj) {
    var s = JSON.stringify(obj) + '\n';
    clients.forEach(function (c) { try { c.write(s); } catch (e) {} });
}

function groupId(name) {
    try {
        var line = fs.readFileSync('/etc/group', 'utf8').split('\n').find(function (l) { return l.split(':')[0] === name; });
        if (line) return parseInt(line.split(':')[2], 10);
    } catch (e) {}
    return -1;
}

var cachedState = { state: 'unknown', panel: null, mode: null, res: null, safe: null };   /* last good readState */

/* Why the patch should not be written without the user asking, or null: a
 * carplay.service that starts another program (another tool's drop-in, which
 * the patch would switch off or which would bypass it). The stock unit and
 * drop-ins that only set an environment are fine. */
var UNIT_DIRS = (process.env.WOC_UNIT_DIRS || '/etc/systemd/system,/run/systemd/system').split(',');
function foreignStart() {
    var files = [];
    UNIT_DIRS.forEach(function (d) {
        files.push(path.join(d, 'carplay.service'));
        var dd = path.join(d, 'carplay.service.d');
        try {
            fs.readdirSync(dd).sort().forEach(function (n) { if (/\.conf$/.test(n)) files.push(path.join(dd, n)); });
        } catch (e) {}
    });
    for (var i = 0; i < files.length; i++) {
        var text = readText(files[i]);
        if (text === null) continue;
        var lines = text.split('\n');
        for (var j = 0; j < lines.length; j++) {
            var m = /^\s*ExecStart\s*=\s*[-@:+!]*\s*(\S+)/.exec(lines[j]);
            if (m && m[1] !== TARGET) return 'carplay.service starts ' + m[1] + ' (' + files[i] + ')';
        }
    }
    return null;
}

/* The written change waiting for the next head-unit start, or null:
 * { action: "apply" | "revert" | null (a marker without one), reason, by:
 * "removal" for the tool's removal, else null }. */
function readPending() {
    var text = readText(PENDING);
    if (text === null) return null;
    try {
        var p = JSON.parse(text);
        if (p && (p.action === 'apply' || p.action === 'revert')) return { action: p.action, reason: PENDING_REASON[p.action], by: p.by === 'removal' ? 'removal' : null };
    } catch (e) {}
    return { action: null, reason: PENDING_REASON.apply, by: null };
}

/* Who writes the change: "removal" while deactivate runs. */
var markBy = null;

/* World-readable, so the app can read it while patchd is not running yet (a
 * fresh install waits for the next head-unit start to start it). */
function writePending(action) {
    try {
        var m = { action: action, reason: PENDING_REASON[action] };
        if (markBy) m.by = markBy;
        fs.writeFileSync(PENDING, JSON.stringify(m) + '\n', { mode: 0o644 });
        fs.chmodSync(PENDING, 0o644);
    } catch (e) { log('pending marker: ' + e.message); }
}

/* Read the patcher's state of the target binary. Only one hashing subprocess
 * runs at a time; a caller that arrives while one is in flight gets the last
 * known state (never null), so the status/logs ops always carry a real value. */
function readState(cb) {
    if (statusInFlight) { cb(cachedState); return; }
    statusInFlight = true;
    cp.execFile(process.execPath, [PATCHER, 'status', '--target', TARGET], { timeout: 15000 }, function (err, out) {
        statusInFlight = false;
        var text = (out || '') + '';
        var variant = /variant:\s+PATCHED -> IC_(HIGH|MID)/.exec(text);
        var redirect = /sink:\s+REDIRECTED -> (\S+)/.exec(text);
        var sinkRedirected = !!redirect;
        var sinkOriginal = /sink:\s+ORIGINAL/.test(text);
        var selfstart = /selfstart:\s+SELF-START/.test(text);
        var resMatch = /res:\s+PATCHED \(IC_HIGH advertises (\d+x\d+)/.exec(text);
        var safeMatch = /res:\s+PATCHED \(IC_HIGH advertises [^,\n]*, safe (\d+x\d+) at (\d+),(\d+)\)/.exec(text);
        var resOriginal = /res:\s+ORIGINAL/.test(text);
        var known = /known:\s+NO/.test(text) ? false : true;
        var unknownWhy = /known:\s+NO — (.*)/.exec(text);
        var pristine = /known:\s+yes, pristine/.test(text);
        var proven = !/proven:\s+no/.test(text);
        var restorable = /^restorable:\s+yes$/m.test(text);
        var backup = /backup:\s+(\S+)/.exec(text);
        var hasBackup = !!backup && backup[1] !== 'none';
        /* "patched" requires every edit: the variant gate, a known sink
         * (redirected to this tool, or stock in avb mode), self-start, and —
         * on the high panel — the resolution geometry. A binary missing one
         * (variant+sink but stock self-start; or self-start but the stock
         * 1920x900 geometry) reports "unknown" with a reason — the app then
         * prompts Enable, and apply adds the missing edit. The mid panel
         * keeps the stock geometry by design. mode distinguishes the capture
         * sink: stock avb:// the media bus the render joins, udp:// the
         * stream sink the bridge accepts, file:// the FIFO. */
        var state, mode = null, reason = null;
        var res = resMatch ? resMatch[1] : null;
        /* The advertised safe area as "WxH+X+Y". A patched binary with another
         * safe area than the one Enable writes is still patched; the app
         * compares the two and prompts Enable. */
        var safe = safeMatch ? safeMatch[1] + '+' + safeMatch[2] + '+' + safeMatch[3] : null;
        var resOk = !variant || variant[1] !== 'HIGH' || !!resMatch;
        if (!known) state = 'unknown';
        else if (variant && selfstart && resOk && (sinkRedirected || sinkOriginal)) {
            state = 'patched';
            mode = !sinkRedirected ? 'avb' : /^file:\/\//.test(redirect[1]) ? 'fifo'
                : /^udp:\/\//.test(redirect[1]) ? 'udp' : redirect[1].replace(/:.*/, '');
        }
        else if (variant && !selfstart && (sinkRedirected || sinkOriginal)) {
            state = 'unknown';
            reason = 'self-start edit missing (older patch); enable the map to apply it';
        }
        else if (variant && selfstart && resOriginal && (sinkRedirected || sinkOriginal)) {
            state = 'unknown';
            reason = 'resolution edit missing (older patch); enable the map to apply it';
        }
        else if (/variant:\s+ORIGINAL/.test(text) && sinkOriginal) state = 'original';
        else state = 'unknown';
        /* What keeps the tool from writing the patch by itself: a binary the
         * patcher cannot patch (an edit site not found, or one it does not
         * recognise), one something else modified (no backup of ours, not the
         * pristine build), a build outside the proven list that Enable map has
         * not patched (no backup of ours), or another program started as
         * carplay. */
        var conflict = err && !text ? 'carplay status unreadable: ' + err.message
            : !known ? 'not patchable' + (unknownWhy ? ': ' + unknownWhy[1] : '')
            : !hasBackup && !pristine ? 'carplay was modified by something else'
            : !hasBackup && !proven ? 'untested carplay build'
            : foreignStart();
        /* A change waiting for the next head-unit start: the running carplay is
         * not the binary on disk, so neither state applies to it yet. */
        var carplay = null, binary = state;
        var pending = readPending();
        if (pending) { state = 'unknown'; mode = null; reason = pending.reason; carplay = 'deferred'; }
        cachedState = { state: state, panel: variant ? variant[1].toLowerCase() : null, mode: mode, res: res, safe: safe, reason: reason, carplay: carplay,
                        pending: pending ? pending.action || 'apply' : null, pendingBy: pending ? pending.by : null,
                        conflict: conflict, binary: binary, known: known, backup: hasBackup, restorable: restorable,
                        /* the first edit of this build needs the user's confirmation */
                        /* the first edit of this build needs the user's confirmation; a
                         * modified build is refused by the patcher anyway (conflict) */
                        unproven: known && !hasBackup && pristine && !proven,
                        /* boot recovery marked the patch failed: crashing, no backup restores
                         * it. Not while carplay reads stock (restored by hand): the mark is
                         * stale then and clears at the next boot step or crash. */
                        failed: binary !== 'original' ? failedReason() : '' };
        cb(cachedState);
    });
}

function status(extra) {
    readState(function (st) {
        var msg = { ev: 'status', state: busy ? 'busy' : st.state, panel: st.panel, mode: st.mode, res: st.res, safe: st.safe };
        if (!busy && st.reason) msg.reason = st.reason;
        if (!busy && st.carplay) msg.carplay = st.carplay;
        if (!busy && st.pending) msg.pending = st.pending;
        if (!busy && st.conflict) msg.conflict = st.conflict;
        if (st.unproven) msg.unproven = true;
        if (st.failed) msg.failed = st.failed;
        if (extra) Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
        send(msg);
    });
}

function remount(rw, cb) {
    cp.execFile(MOUNT, ['-o', 'remount,' + (rw ? 'rw' : 'ro'), '/'], { timeout: 15000 }, function (err) { cb(err); });
}

/* / is read-only on / per /proc/mounts. */
function rootIsReadOnly() {
    try {
        var lines = fs.readFileSync(PROC_MOUNTS, 'utf8').split('\n');
        var opts = null;
        /* The last `/` entry is the effective root mount (mgu-deploy.js scans
         * from the end too). */
        for (var i = 0; i < lines.length; i++) {
            var p = lines[i].split(' ');
            if (p[1] === '/') opts = p[3];
        }
        if (opts !== null) return /(^|,)ro(,|$)/.test(opts);
    } catch (e) {}
    return false;
}

/* Remount read-only and confirm it took, retrying a few times. */
function remountRo(tries, cb) {
    remount(false, function () {
        if (rootIsReadOnly()) { cb(null); return; }
        if (tries > 0) { setTimeout(function () { remountRo(tries - 1, cb); }, 500); return; }
        cb(new Error('/ is still read-write after remount'));
    });
}

/* Restarting carplay is safe only while nothing takes its SIGKILL for a
 * failure: recmgr loaded its entry this boot (recmgr_list.js), and systemd
 * loaded the tool's drop-in, whose SuccessExitStatus=SIGKILL keeps the kill
 * from failing carplay.service and so from running its
 * OnFailure=mediaddpserver_kill.service, which restarts the head unit
 * (PATCH.md "Activation"). Otherwise a change is left to take effect at the
 * next head-unit start. */
var recmgrLoaded = require('./recmgr_list.js').recmgrLoaded;
var parseShow = require('./recovery.js').parseShow;
var failedReason = require('./recovery.js').failedReason;
var DROPIN = process.env.WOC_CARPLAY_DROPIN || '/etc/systemd/system/carplay.service.d/50-waze-on-cluster.conf';

/* cb(null) when carplay may be restarted, else cb(why not). */
function restartBlocked(cb) {
    if (!recmgrLoaded('carplay')) { cb('recmgr did not load a carplay restart entry this boot'); return; }
    cp.execFile('systemctl', ['show', 'carplay.service', '-p', 'DropInPaths'], { timeout: 15000 }, function (err, out) {
        var m = /^DropInPaths=(.*)$/m.exec((out || '') + '');
        cb(m && m[1].split(' ').indexOf(DROPIN) >= 0 ? null : 'systemd has not loaded ' + DROPIN);
    });
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

/* A change written while carplay could not be restarted, and which one:
 * {"action":"apply"|"revert","reason":...}. The marker sits next to the
 * socket in /dev/shm, which the next head-unit start clears; until then
 * status reports it instead of the binary's state. */
var PENDING = path.join(path.dirname(SOCK), 'activation-pending');
/* The carplay run restartCarplay kills, for recovery.js. */
var KILLED = path.join(path.dirname(SOCK), 'carplay-killed');
var PENDING_REASON = {
    apply: 'patch written; takes effect at the next head-unit start',
    revert: 'patch removed; the original carplay runs from the next head-unit start'
};

/* Restart carplay: SIGKILL its main process, wait until systemd has reaped it,
 * `systemctl start` it, and confirm the unit is active. A systemd stop or
 * restart of carplay.service power-cycles the head unit, so neither is used,
 * not even as a fallback: no main PID, a failed start or a unit that never
 * becomes active is an error. Each wait is bounded (RESTART_TRIES x
 * RESTART_POLL_MS). Only called when restartBlocked found nothing. */
var RESTART_POLL_MS = parseInt(process.env.WOC_RESTART_POLL_MS, 10) || 250;
var RESTART_TRIES = 40;
function restartCarplay(cb) {
    cp.execFile('systemctl', ['show', 'carplay.service', '-p', 'MainPID', '-p', 'InvocationID', '-p', 'ExecMainStartTimestampMonotonic'],
        { timeout: 15000 }, function (err, out) {
        if (err) { cb(new Error('carplay restart: reading MainPID failed: ' + err.message)); return; }
        var run = parseShow((out || '') + ''), pid = run.pid;
        if (!(pid > 0)) { cb(new Error('carplay restart: carplay.service has no main PID (MainPID=' + pid + '); not restarted')); return; }
        log('restarting carplay: SIGKILL main PID ' + pid + ', then systemctl start');
        /* The boot-recovery watcher takes the end of this run for patchd's
         * kill, not a crash. */
        try { fs.writeFileSync(KILLED, run.run + '\n'); } catch (e) { log('recording the killed run failed: ' + e.message); }
        try { process.kill(pid, 'SIGKILL'); }
        catch (e) { if (e.code !== 'ESRCH') { cb(new Error('carplay restart: SIGKILL ' + pid + ': ' + e.message)); return; } }
        waitCarplayGone(pid, RESTART_TRIES, function (gErr) {
            if (gErr) { cb(gErr); return; }
            cp.execFile('systemctl', ['start', 'carplay.service'], { timeout: 30000 }, function (sErr) {
                if (sErr) { cb(new Error('carplay restart: systemctl start failed: ' + sErr.message)); return; }
                waitCarplayActive(RESTART_TRIES, function (aErr) {
                    if (!aErr) try { fs.unlinkSync(PENDING); } catch (e) {}
                    cb(aErr);
                });
            });
        });
    });
}

/* The killed PID is gone once systemd has reaped it (a zombie still answers
 * signal 0), so the start below never lands on the dying instance. */
function waitCarplayGone(pid, tries, cb) {
    try { process.kill(pid, 0); }
    catch (e) { if (e.code === 'ESRCH') { cb(null); return; } }
    if (tries <= 0) { cb(new Error('carplay restart: PID ' + pid + ' still present after SIGKILL; not started')); return; }
    setTimeout(function () { waitCarplayGone(pid, tries - 1, cb); }, RESTART_POLL_MS);
}

function waitCarplayActive(tries, cb) {
    cp.execFile('systemctl', ['is-active', 'carplay.service'], { timeout: 15000 }, function (err, out) {
        var st = ((out || '') + '').trim();
        if (st === 'active') { cb(null); return; }
        if (tries <= 0) { cb(new Error('carplay restart: carplay.service is ' + (st || 'unknown') + ' after start')); return; }
        setTimeout(function () { waitCarplayActive(tries - 1, cb); }, RESTART_POLL_MS);
    });
}

/* Follow one or more units' journals; onLine(text) decides what to keep. oformat
 * is journalctl's -o value: "cat" is the message only (so content matching does
 * not trip on the unit identifier in the prefix). Respawns if journalctl exits;
 * root reads the journal directly. */
function followJournal(units, oformat, onLine) {
    var args = [];
    units.forEach(function (u) { args.push('-u', u); });
    args.push('-f', '-o', oformat, '-n', '0');
    var j;
    try {
        j = cp.spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { log('journalctl spawn failed: ' + e.message); return; }
    var buf = '';
    j.stdout.setEncoding('utf8');
    j.stdout.on('data', function (d) {
        buf += d;
        if (buf.length > 1 << 20) buf = buf.slice(-(1 << 16));
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line) onLine(line);
        }
    });
    j.on('close', function () { setTimeout(function () { followJournal(units, oformat, onLine); }, 5000); });
    j.on('error', function (e) { log('journalctl error: ' + e.message); });
}

/* Keep carplay's journal lines (timestamped), flagging the "no map" markers;
 * the LD_PRELOAD scheduler shim's lines carry nothing about CarPlay. */
function followCarplayJournal() {
    followJournal(['carplay.service'], 'short-iso', function (line) {
        if (line.indexOf('libschedconfig') >= 0) return;
        pushCarplay({ t: Date.now(), msg: line.slice(0, 4096), marker: isMarker(line) });
    });
}

/* Keep only marker lines of the AVB talker's messages (otherwise noisy); -o cat
 * so the match is on the message, not the avbstreamhandler identifier. */
function followAvbJournal() {
    followJournal(['avbstreamhandler.service', 'avbsourcesinkcontroller.service'], 'cat', function (line) {
        if (!isAvbMarker(line)) return;
        avbLines.push({ t: Date.now(), msg: line.slice(0, 4096) });
        if (avbLines.length > 400) avbLines.shift();
    });
}

/* carplay and the AVB streamhandler log to DLT (BMW's logging bus), not to the
 * journal — the journal carries only the LD_PRELOAD shim's noise — so the gate
 * and advert lines ("Kombi variant is =", "Adding display:", ...) are only on
 * DLT. dlt-receive -a connects to the DLT daemon over TCP and prints each
 * message's ASCII payload (prefixed with its app/context id); root may connect.
 * Lines are routed by content, not app id: carplay's marker strings to
 * carplayLines; the CarPlay->Kombi stream's ids and any AVB talker message to
 * avbLines. Kept lines are copied, so they do not pin the chunk they came from. */
var DLT_AVB_MARKERS = ['301a9ee', 'CarPlay_Kombi', 'D14_1722', 'alker'];
function isDltAvbMarker(line) {
    for (var i = 0; i < DLT_AVB_MARKERS.length; i++)
        if (line.indexOf(DLT_AVB_MARKERS[i]) >= 0) return true;
    return false;
}
var dltErrorLogged = false;
function own(s) { return Buffer.from(s, 'utf8').toString('utf8'); }

/* dlt-receive's health, so an empty DLT capture can be told apart from no
 * CarPlay activity. Each start of dlt-receive is a run: its DLT lines, when the
 * first and last arrived, and the last DLT_TAIL chars of its own messages
 * (stderr, and the "[..]~DLT~" / "DLT| " lines its logger may print on stdout,
 * which are not DLT data). failed_runs counts the runs in a row that ended
 * without a DLT line; a DLT line resets it. last_exit is the previous run as it
 * ended. The "logs" reply carries it all as "dlt". The patchd log gets a line
 * when DLT_FAIL_LOG_AFTER runs in a row fail, and when DLT lines arrive for the
 * first time or after such a streak; never one per retry. */
var DLT_RECEIVE = process.env.WOC_DLT_RECEIVE || 'dlt-receive';
var DLT_RETRY_MS = parseInt(process.env.WOC_DLT_RETRY_MS, 10) || 5000;
var DLT_RETRY_MAX_MS = parseInt(process.env.WOC_DLT_RETRY_MAX_MS, 10) || 60000;
var DLT_TAIL = 1024;
var DLT_FAIL_LOG_AFTER = 3;
var dlt = { state: 'starting', runs: 0, failed_runs: 0, run: null, last_exit: null };
var dltEverReceived = false;
var dltRetryTimer = null;      /* the pending dlt-receive restart */
var dltStreakLogged = false;   /* a failure streak was logged; log the recovery */
function isDltClientMsg(line) { return /^\[[\d. ]+\]~DLT~/.test(line) || line.indexOf('DLT| ') === 0; }
function dltMessage(run, s) { run.messages = own((run.messages + s).slice(-DLT_TAIL)); }
function dltHow(run) {
    var how = run.error || (run.signal ? 'signal ' + run.signal : 'exit code ' + run.code);
    var m = run.messages.replace(/\s+$/, '');
    m = m.slice(m.lastIndexOf('\n') + 1);
    return m ? how + ': ' + m.slice(-200) : how;
}
function dltReceiving(run, now) {
    run.first_data = now;
    dlt.state = 'receiving';
    if (!dltEverReceived || dltStreakLogged)
        log('dlt-receive: receiving DLT' + (dltStreakLogged ? ' after ' + dlt.failed_runs + ' failed starts' : ''));
    dltEverReceived = true;
    dltStreakLogged = false;
    dlt.failed_runs = 0;
}
function dltEnded(run, code, signal) {
    run.ended = Date.now();
    run.code = code;
    run.signal = signal;
    dlt.run = null;
    dlt.last_exit = run;
    if (run.lines) return;
    dlt.failed_runs++;
    if (dlt.failed_runs === DLT_FAIL_LOG_AFTER) {
        log('dlt-receive: no DLT data from ' + DLT_FAIL_LOG_AFTER + ' starts in a row (last: ' + dltHow(run) +
            '); backing off, see "dlt" in the logs reply');
        dltStreakLogged = true;
    }
}

/* How long to wait before the next dlt-receive start. A capped doubling delay
 * over consecutive failed starts, from DLT_RETRY_MS up to DLT_RETRY_MAX_MS, so a
 * DLT daemon that never accepts a local client (its socket is not opened at
 * startup) is not respawned every few seconds for the life of the unit; a run
 * that carries DLT data resets failed_runs and so the delay to the base. */
function dltRetryDelay() {
    var n = dlt.failed_runs > 0 ? dlt.failed_runs - 1 : 0;
    var d = DLT_RETRY_MS * Math.pow(2, n < 20 ? n : 20);
    return d < DLT_RETRY_MAX_MS ? d : DLT_RETRY_MAX_MS;
}

function followDlt() {
    var j;
    var run = { started: Date.now(), first_data: null, last_data: null, lines: 0, messages: '', error: null };
    dlt.runs++;
    dlt.run = run;
    dlt.state = 'starting';
    try {
        j = cp.spawn(DLT_RECEIVE, ['-a', 'localhost'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        log('dlt-receive spawn failed: ' + e.message + ' (DLT markers unavailable)');
        run.error = e.message;
        dltEnded(run, null, null);
        dlt.state = 'stopped';
        return;
    }
    var buf = '';
    j.stderr.setEncoding('utf8');
    j.stderr.on('data', function (d) { dltMessage(run, d); });
    j.stdout.setEncoding('utf8');
    j.stdout.on('data', function (d) {
        buf += d;
        if (buf.length > 1 << 20) buf = buf.slice(-(1 << 16)); /* a stuck partial line cannot grow unbounded */
        var now = Date.now();
        var had = run.lines;
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, i).replace(/\s+$/, '');
            buf = buf.slice(i + 1);
            if (!line) continue;
            if (isDltClientMsg(line)) dltMessage(run, line + '\n');
            else run.lines++;
            if (isMarker(line)) {
                pushCarplay({ t: Date.now(), msg: own('DLT ' + line.slice(0, 4096)), marker: true });
            } else if (isDltAvbMarker(line)) {
                avbLines.push({ t: Date.now(), msg: own('DLT ' + line.slice(0, 4096)) });
                if (avbLines.length > 400) avbLines.shift();
            }
        }
        if (run.lines > had) {
            run.last_data = now;
            if (!run.first_data) dltReceiving(run, now);
        }
    });
    j.on('close', function (code, signal) {
        dltEnded(run, code, signal);
        dlt.state = 'retrying';
        dltRetryTimer = setTimeout(function () { dltRetryTimer = null; followDlt(); }, dltRetryDelay());
    });
    j.on('error', function (e) {
        run.error = e.message;
        if (!dltErrorLogged) log('dlt-receive: ' + e.message + ' (DLT markers unavailable)');
        dltErrorLogged = true;
    });
}

var CAPTURE_SOCK = process.env.WOC_CAPTURE_SOCK || '/run/woc-dlt-capture/control.sock';
function captureCommand(command, cb) {
    var socket = net.connect(CAPTURE_SOCK), buf = '', done = false;
    var timer = setTimeout(function () { finish(new Error('capture service timed out')); }, 3000);
    function finish(err, result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        var state = err ? { state: 'unavailable', error: err.message } : result;
        if (state.state === 'open') dltRetryNow();
        cb(state);
    }
    socket.on('connect', function () { socket.write(JSON.stringify({ cmd: command }) + '\n'); });
    socket.on('error', function (err) { finish(err); });
    socket.on('end', function () { finish(new Error('capture service closed without a reply')); });
    socket.on('data', function (data) {
        buf += data;
        if (buf.length > 8192) return finish(new Error('capture reply too large'));
        var i = buf.indexOf('\n');
        if (i < 0) return;
        try { finish(null, JSON.parse(buf.slice(0, i))); } catch (err) { finish(err); }
    });
}
function dltRetryNow() {
    if (!dltRetryTimer || quitting) return;
    clearTimeout(dltRetryTimer);
    dltRetryTimer = null;
    followDlt();
}
function quit() {
    if (quitting) return;
    quitting = true;
    quitWhenIdle();
}
function quitWhenIdle() {
    if (quitting && !busy) process.exit(0);
}

/* Restore / to read-only, and never leave it writable: if the remount keeps
 * failing (the old, now-unlinked carplay binary is still held open), restart
 * carplay to drop it and try once more, whatever made the patch step fail —
 * when carplay is restartable (an install never restarts it). */
function finalizeRo(errSoFar, done, restartable) {
    remountRo(3, function (roErr) {
        if (!roErr || !restartable) { done(errSoFar, roErr); return; }
        log('/ still writable; restarting carplay to release the old binary, then retrying');
        restartCarplay(function () {
            remountRo(3, function (roErr2) { done(errSoFar, roErr2); });
        });
    });
}

/* The running carplay's binary, kept linked while a process still executes
 * it: the patcher replaces TARGET by rename, and an unlinked file still held
 * open keeps / from going read-only again. Once nothing executes it (after
 * the next head-unit start, or a carplay restart) it is removed: by the next
 * write window, by patchd when it starts, and after the tool's removal by the
 * deploy tool (deactivate's "removeWhenUnused"). */
var RUNNING = TARGET + '.woc-running';
function needed() { return lock.holds(RUNNING, TARGET); }
function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (e) {} }

/* Removes RUNNING when nothing executes it, / read-write only for that. */
function dropUnusedRunning(cb) {
    if (!fs.existsSync(RUNNING) || needed()) { cb(); return; }
    lock.acquire(5000, function (got) {
        if (!got) { log('remount lock busy; the unused ' + RUNNING + ' waits for the next write window'); cb(); return; }
        remount(true, function (mErr) {
            if (!mErr && !needed()) { unlinkQuiet(RUNNING); log('removed ' + RUNNING + ': nothing runs it'); }
            remountRo(3, function (roErr) {
                if (roErr) log('WARNING: ' + roErr.message);
                lock.release();
                cb();
            });
        });
    });
}

function sameFile(a, b) {
    try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (e) { return false; }
}
function sameInode(a, b) {
    try { var x = fs.statSync(a), y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch (e) { return false; }
}

/* One apply/revert (action): remount rw, run the patcher; when the binary
 * changed, restart carplay unless the caller forbids it or restartBlocked
 * names a reason (so the new one takes effect and the old one is dropped),
 * else leave the change for the next head-unit start; then finalizeRo. A change that writes the bytes
 * carplay runs (a pending change undone) moves the running binary's own file
 * back into place, so nothing is pending and no unlinked file stays open.
 * done(err, roErr, activation, patcherErr): "restarted", "deferred", or null
 * for nothing to activate; patcherErr is the patcher's own error line. */
function runPatch(args, action, noRestart, done) {
    (noRestart ? function (cb) { cb('installing'); } : restartBlocked)(function (blocked) { patchWith(args, action, blocked, done); });
}
function patchWith(args, action, blocked, done) {
    var restartable = !blocked;
    remount(true, function (mErr) {
        if (mErr) { finalizeRo(new Error('remount rw: ' + mErr.message), function (e, r) { done(e, r, null); }, restartable); return; }
        if (!needed()) unlinkQuiet(RUNNING);
        var linked = false;
        if (!restartable && !fs.existsSync(RUNNING)) {
            try { fs.linkSync(TARGET, RUNNING); linked = true; } catch (e) { log('keeping the running carplay linked failed: ' + e.message); }
        }
        cp.execFile(process.execPath, [PATCHER].concat(args), { timeout: 60000 }, function (pErr, out, errOut) {
            var text = (out || '') + '';
            text.split('\n').forEach(function (l) { if (l.trim()) log(l.trim()); });
            if (errOut) (errOut + '').split('\n').forEach(function (l) { if (l.trim()) log(l.trim()); });
            var why = /^error: (.*)$/m.exec((errOut || '') + '');
            var changed = !pErr && !/nothing to do|already at the original/i.test(text);
            if (changed && restartable) {
                restartCarplay(function (rErr) {
                    if (!rErr) unlinkQuiet(RUNNING);
                    finalizeRo(pErr || rErr || null, function (e, r) { done(e, r, 'restarted'); });
                });
            } else if (changed && sameFile(RUNNING, TARGET)) {
                var back = null;
                try { fs.renameSync(RUNNING, TARGET); } catch (e) { back = e; }
                if (back) {
                    log('putting the running carplay back failed: ' + back.message + '; ' + PENDING_REASON[action]);
                    writePending(action);
                    finalizeRo(null, function (e, r) { done(e, r, 'deferred'); }, restartable);
                    return;
                }
                log('carplay runs these bytes already; its binary is back in place and nothing waits for a head-unit start');
                unlinkQuiet(PENDING);
                finalizeRo(null, function (e, r) { done(e, r, null); }, restartable);
            } else if (changed) {
                log('carplay not restarted (' + blocked + '); ' + PENDING_REASON[action]);
                if (!needed()) unlinkQuiet(RUNNING);
                writePending(action);
                finalizeRo(null, function (e, r) { done(e, r, 'deferred'); }, restartable);
            } else if (linked && !sameInode(RUNNING, TARGET)) {
                /* The patcher failed after replacing the binary: the running
                 * one stays linked and the change waits like any other. */
                log(action + ' failed after writing; ' + PENDING_REASON[action]);
                if (!needed()) unlinkQuiet(RUNNING);
                writePending(action);
                finalizeRo(pErr || null, function (e, r) { done(e, r, 'deferred', why ? why[1] : null); }, restartable);
            } else {
                if (linked) unlinkQuiet(RUNNING);
                finalizeRo(pErr || null, function (e, r) { done(e, r, null, why ? why[1] : null); }, restartable);
            }
        });
    });
}

/* Every mode applies Edit 1 (variant gate) + Edit 3 (self-start) — without
 * self-start the phone never streams. The modes differ only in the sink:
 * "avb": the stock avb:// sink, the media bus the render joins (the mode the
 * app applies). "udp": Edit 2 sink -> udp://127.0.0.1:UDP_PORT, the stream
 * sink the projection bridge accepts, which this tool receives. "fifo": sink
 * -> the file:// FIFO (the bridge rejects it on the car). `unproven`: an
 * Enable map the user confirmed for a build outside the proven list;
 * install-time activation never does. */
function apply(panel, mode, noRestart, unproven, done) {
    if (panel !== 'high' && panel !== 'mid') { done(new Error('panel must be high or mid')); return; }
    var args = ['apply', '--panel', panel, '--target', TARGET, '--yes'].concat(unproven ? ['--unproven'] : []);
    if (mode === 'avb') {
        log('apply IC_' + panel.toUpperCase() + ', stock AVB sink (the render joins the media bus)');
    } else if (mode === 'udp') {
        var url = 'udp://127.0.0.1:' + UDP_PORT + '?mime_type=video/H264';
        log('apply IC_' + panel.toUpperCase() + ' + capture to ' + url);
        args.splice(3, 0, '--sink', url);
    } else {
        log('apply IC_' + panel.toUpperCase() + ' + capture to ' + FIFO);
        args.splice(3, 0, '--capture', FIFO);
    }
    runPatch(args, 'apply', noRestart, done);
}

function revert(noRestart, dropBackup, done) {
    log('revert');
    runPatch(['revert', '--target', TARGET, '--yes'].concat(dropBackup ? ['--drop-backup'] : []), 'revert', noRestart, done);
}

function handle(line, sock) {
    var msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (!msg || !msg.cmd) return;
    if (msg.cmd === 'status') { status(); return; }
    if (msg.cmd === 'logs') {
        /* The captured carplay and AVB lines (markers flagged), dlt-receive's
         * health and patchd's own log, for the remote diagnostic endpoint; now
         * is patchd's clock, to read the times against. Reply only to the
         * asking client. */
        captureCommand('status', function (capture) {
            dlt.window = capture;
            readState(function (st) {
                var reply = { ev: 'logs', now: Date.now(), patch: st.state, panel: st.panel, mode: st.mode, res: st.res, safe: st.safe,
                              carplay: carplayLines.slice(), markers: markerLines.slice(),
                              avb: avbLines.slice(), dlt: dlt, patchd: logLines.slice() };
                try { sock.write(JSON.stringify(reply) + '\n'); } catch (e) {}
            });
        });
        return;
    }
    if (quitting && msg.cmd === 'capture-start') return;
    if (msg.cmd === 'capture-start' || msg.cmd === 'capture-stop' || msg.cmd === 'capture-status') {
        captureCommand(msg.cmd.slice(8), function (state) {
            try { sock.write(JSON.stringify({ ev: 'capture-reply', capture: state }) + '\n'); } catch (e) {}
            send({ ev: 'capture', capture: state });
        });
        return;
    }
    if (msg.cmd === 'reboot') {
        /* Activate a deferred patch with a normal reboot. Guarded so a stray or
         * repeated press cannot reboot at the wrong time: only when a change is
         * actually pending, not while an operation runs, and once. */
        var deny = rebooting ? 'a restart is already in progress'
            : busy ? 'another operation is running'
            : quitting ? 'patchd is stopping'
            : !fs.existsSync(PENDING) ? 'no restart is pending'
            : null;
        if (deny) { try { sock.write(JSON.stringify({ ev: 'reboot-reply', ok: false, reason: deny }) + '\n'); } catch (e) {} return; }
        rebooting = true;
        log('restart requested: normal system reboot to activate the pending patch (' + REBOOT_CMD.join(' ') + ')');
        try { sock.write(JSON.stringify({ ev: 'reboot-reply', ok: true }) + '\n'); } catch (e) {}
        send({ ev: 'status', state: 'busy', reason: 'restarting the head unit' });
        cp.execFile(REBOOT_CMD[0], REBOOT_CMD.slice(1), { timeout: 30000 }, function (err) {
            if (err) {
                rebooting = false;
                log('reboot failed: ' + err.message);
                send({ ev: 'reboot-reply', ok: false, reason: err.message });
                /* Keep carplay/reason from the current state so the still-pending
                 * patch (and the app's restart button) is not lost. */
                status({ state: 'error', reason: 'reboot failed: ' + err.message });
            }
        });
        return;
    }

    if (busy || quitting || rebooting) { send({ ev: 'status', state: 'busy', reason: quitting ? 'patchd is stopping' : rebooting ? 'a restart is in progress' : 'another operation is running' }); return; }

    if (msg.cmd === 'apply' || msg.cmd === 'revert') {
        var op = msg.cmd;
        var panel = msg.panel;
        var mode = (msg.mode === 'avb' || msg.mode === 'udp') ? msg.mode : 'fifo';   /* capture mode; default fifo */
        busy = true;
        status({ reason: op === 'apply' ? 'applying' : 'reverting' });
        /* A build outside the proven list is patched only when the app says
         * the user confirmed it ({"unproven":true}); a plain Enable map on an
         * untested carplay build is refused by the patcher, changing nothing. */
        var unproven = op === 'apply' && msg.unproven === true;
        if (unproven) log('apply: the user confirmed patching a carplay build outside the proven list');
        var fn = op === 'apply' ? function (cb) { apply(panel, mode, false, unproven, cb); } : function (cb) { revert(false, false, cb); };
        /* Hold the shared remount lock so the boot-recovery service does not
         * remount / or write carplay at the same time. Never proceed without
         * it: the holder (a restore) ends within recovery.js RESTORE_BOUND_MS
         * and a lock abandoned by a killed holder is broken after
         * remount_lock.js STALE_MS, so the user retries shortly. */
        lock.acquire(LOCK_WAIT_MS, function (got) {
            if (!got) {
                busy = false;
                log('remount lock busy; ' + op + ' not started, nothing changed');
                status({ state: 'error', reason: LOCK_BUSY_REASON });
                quitWhenIdle();
                return;
            }
            fn(function (pErr, roErr, activation, refused) {
                lock.release();
                busy = false;
                if (roErr) log('WARNING: ' + roErr.message + ' — run: mount -o remount,ro /');
                if (pErr || roErr) {
                    var reason = [pErr && (refused && /not a proven build/.test(refused) ? UNPROVEN_REASON : pErr.message),
                        roErr && roErr.message].filter(Boolean).join('; ');
                    log(op + ' failed: ' + reason);
                    send({ ev: 'status', state: 'error', reason: reason });
                } else {
                    log(op + ' done' + (activation === 'restarted' ? '' : activation === 'deferred' ? ' (' + PENDING_REASON[op] + ')' : ' (no change)'));
                    status(activation ? { carplay: activation } : {});
                }
                quitWhenIdle();
            });
        });
    }
}

function accept(sock) {
    clients.push(sock);
    sock.setEncoding('utf8');
    var buf = '';
    sock.on('data', function (d) {
        buf += d;
        if (buf.length > MAX_LINE) { try { sock.destroy(); } catch (e) {} return; }
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) handle(line.trim(), sock);
        }
    });
    sock.on('error', function () {});
    sock.on('close', function () { clients = clients.filter(function (c) { return c !== sock; }); });
    /* The backlog, then the current state. */
    logLines.forEach(function (l) { try { sock.write(JSON.stringify({ ev: 'log', line: l }) + '\n'); } catch (e) {} });
    status();
}

/* Make the socket's directory exist and be a real directory this process's
 * user (root on the unit) owns, not a symlink or a folder another user planted
 * in the sticky, world-writable /dev/shm (the guard mgu-updater uses). Refuse
 * rather than chown/chmod through someone else's symlink. The
 * waze-on-cluster.socket unit normally creates it as root at boot before this
 * runs; a fresh install's activate creates it before that. */
function ensureDir(dir) {
    var st;
    try { st = fs.lstatSync(dir); } catch (e) { st = null; }
    if (st) {
        if (!st.isDirectory() || st.uid !== (process.getuid ? process.getuid() : 0)) {
            throw new Error(dir + ' is not a directory of uid ' + (process.getuid ? process.getuid() : 0) + '; refusing (uid ' + (st.uid) + ', symlink ' + st.isSymbolicLink() + ')');
        }
    } else {
        fs.mkdirSync(dir, 0o755);
    }
    fs.chmodSync(dir, 0o755);
}

/* ---- install-time activation (patchd.js activate | deactivate) ---------- */

/* What activate and deactivate do with the binary as readState found it:
 * { op: "apply" | "revert", or none and why }. activate applies Enable map's
 * patch (high panel, the stock media-bus sink, the patcher's size and safe
 * area) to a known binary without a conflict: a proven original (no backup of
 * ours) or a patch of ours, any configuration of it, which the patcher brings
 * up to date or leaves as it is; an original with our backup was reverted by
 * the user and stays so, as does a pending change other than a removal's
 * revert. After a removal's revert an install patches a proven build again; a
 * build outside the proven list, its backup dropped, stays reverted (a
 * conflict). deactivate reverts a patch of ours, a pending one too, also one
 * the patcher no longer recognises when our verified backup of the same build
 * differs from it (restorable), and drops our backup, so a later install
 * starts from the original as a fresh one does. */
function plan(which, st) {
    if (st.pending && which === 'activate' && !(st.pending === 'revert' && st.pendingBy === 'removal')) {
        return { why: 'a change already waits for the next head-unit start' };
    }
    if (which === 'deactivate' && st.restorable) return { op: 'revert' };
    if (st.conflict && (which === 'activate' || !st.known)) return { conflict: st.conflict };
    if (which === 'deactivate') return st.binary === 'original' && !st.backup ? { why: 'carplay is the original' } : { op: 'revert' };
    if (st.binary === 'original' && st.backup) return { why: 'the map patch was turned off; Enable map applies it' };
    return { op: 'apply' };
}

function sha(f) {
    try { return require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return null; }
}

/* Runs activate or deactivate once and exits; the last stdout line is its
 * JSON result. Never stops or restarts carplay. */
function oneShot(which) {
    var result = {};
    function finish(code) {
        lock.release();
        /* After the removal nothing of this tool is left to remove the link:
         * one that holds nothing goes now; one left (a process runs it, or
         * dropping it failed) goes to the deploy tool, which removes it once
         * nothing runs it. carplay's own file is not a link to hand over. */
        (which === 'deactivate' ? dropUnusedRunning : function (cb) { cb(); })(function () {
            var p = readPending();
            if (p && !result.reboot) result.reboot = p.reason;
            if (which === 'deactivate' && fs.existsSync(RUNNING) && !sameInode(RUNNING, TARGET)) result.removeWhenUnused = [RUNNING];
            /* A revert pending when the tool goes is the removal's: an install
             * before the next start patches again. */
            if (which === 'deactivate' && p && p.action === 'revert' && p.by !== 'removal') writePending('revert');
            process.stdout.write(JSON.stringify(result) + '\n');
            process.exit(code);
        });
    }
    if (which === 'deactivate') markBy = 'removal';
    try { ensureDir(path.dirname(SOCK)); } catch (e) { result.status = e.message; finish(1); return; }
    lock.acquire(LOCK_WAIT_MS, function (got) {
        if (!got) {
            /* Never write carplay beside a running restore: nothing changed,
             * so the install is rolled back and can be retried. */
            result.status = 'remount lock busy (a boot-recovery restore may be running); nothing changed';
            log(which + ': ' + result.status);
            finish(1);
            return;
        }
        readState(function (st) {
            var p = plan(which, st);
            if (!p.op) {
                result.status = p.conflict ? 'carplay left as it is: ' + p.conflict : p.why;
                if (p.conflict) result.conflict = p.conflict;
                log(which + ': ' + result.status);
                finish(0);
                return;
            }
            var before = sha(TARGET);
            var run = p.op === 'apply' ? function (cb) { log(which + ': applying the map patch'); apply('high', 'avb', true, false, cb); }
                : function (cb) { log(which + ': reverting the map patch'); revert(true, true, cb); };
            run(function (pErr, roErr, activation, refused) {
                var written = sha(TARGET) !== before;
                if (roErr) log('WARNING: ' + roErr.message + ' — the next head-unit start mounts / read-only again');
                if (written && pErr) writePending(p.op);
                if (written || !pErr) {
                    result.status = activation === 'deferred' || written ? (p.op === 'apply' ? 'map patch written' : 'map patch removed') +
                        (pErr ? ' (' + pErr.message + ')' : '') : 'carplay already as wanted';
                    log(which + ': ' + result.status);
                    finish(0);
                    return;
                }
                /* The patcher would not touch it: left as it is, for the user. */
                if (refused && /refusing|requires the pristine|not a proven build|not a recognised|no backup/.test(refused)) {
                    result.status = 'carplay left as it is: ' + refused;
                    result.conflict = refused;
                    log(which + ': ' + result.status);
                    finish(0);
                    return;
                }
                result.status = (p.op === 'apply' ? 'applying' : 'reverting') + ' failed: ' + pErr.message;
                log(which + ': ' + result.status);
                finish(1);
            });
        });
    });
}

function main() {
    var dir = path.dirname(SOCK);
    ensureDir(dir);
    try { if (fs.lstatSync(SOCK)) fs.unlinkSync(SOCK); } catch (e) {}

    var server = net.createServer(accept);
    /* A link left from before the last head-unit start goes before the
     * socket opens. */
    dropUnusedRunning(function () { server.listen(SOCK, function () {
        if (process.getuid && process.getuid() === 0 && SOCK_GROUP) {
            var gid = groupId(SOCK_GROUP);
            if (gid >= 0) try { fs.chownSync(SOCK, 0, gid); } catch (e) {}
        }
        try { fs.chmodSync(SOCK, 0o660); } catch (e) {}
        log('patchd listening on ' + SOCK);
        followCarplayJournal();
        followAvbJournal();
        followDlt();
        setInterval(function () {
            captureCommand('status', function (state) { send({ ev: 'capture', capture: state }); });
        }, 1000);
    }); });
    server.on('error', function (e) { process.stderr.write('patchd: ' + e.message + '\n'); process.exit(1); });
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
}

if (process.argv[2] === 'activate' || process.argv[2] === 'deactivate') oneShot(process.argv[2]);
else main();
