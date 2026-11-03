#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* recovery.js — the safety net for the carplay patch (PATCH.md "Boot
 * recovery"). A bad interaction (e.g. the requestStream self-start throwing on
 * a phone connect, PATCH.md "Exception risk") can crash carplay at every
 * session. A carplay crash reboots the head unit (PATCH.md "Boot
 * recovery") with the patched binary still on disk: a boot loop with no HMI
 * to turn the map off.
 *
 *   recovery.js boot   waze-on-cluster-boot.service, a oneshot ordered before
 *                      carplay.service: counts the previous boot and, at the
 *                      threshold, restores the original before carplay starts.
 *   recovery.js        waze-on-cluster-recovery.service: watches carplay for
 *                      the rest of the boot and records each crash the moment
 *                      it is seen; the boot step decides at the next start.
 *                      Where recmgr loaded carplay's entry it also restores
 *                      at the threshold and starts carplay again, for as long
 *                      as the head unit stays up.
 *
 * shutdown_mark.sh (a var-opt-ro.service drop-in) records at each head-unit
 * shutdown, before /var/opt goes read-only, whether carplay was running,
 * failed or stopped. recmgr's reboot and a switch-off are both an NSM fast
 * shutdown that stops no service, so that record, not a SIGTERM, tells a
 * crash from a switch-off.
 *
 * STATE holds fails, the crashes of a patched carplay since the last
 * boot in which carplay ran healthy and did not crash; arm, this boot's record
 * ({boot, crashes, confirmed, clean}), kept while a backup of ours exists;
 * starts ({boot, n}), the carplay starts made this boot; and ended ({boot,
 * run}), the last carplay run whose end was handled. At the next boot a
 * previous boot adds its crashes (one when the mark says failed and none were
 * seen); one with none clears the counter if carplay ran HEALTHY_MS
 * continuously, keeps it if it shut down with carplay running or stopped (or
 * on SIGTERM while the system stops), and otherwise adds one (it ended with no
 * record, e.g. power lost).
 *
 * The restore is the carplay_patch.js revert Disable map uses (a verified
 * backup of the target's own build), under the remount lock shared with
 * patchd, with / read-write only for the write. It acts when the patcher's
 * status reads `restorable: yes` (a revert would change the binary, whatever
 * the locator makes of it); a stock or firmware-replaced binary clears the
 * counter. A state it cannot write loses the count, so a restorable patch is
 * then restored at once, whatever the count.
 * Every command it runs is bounded (STEP_MS), so a restore ends within
 * RESTORE_BOUND_MS. It never kills, restarts or reboots anything; the only
 * start is `systemctl start carplay.service` after a crash or a SIGKILL
 * patchd did not send, never stop or restart, bounded by START_DELAYS_MS
 * per boot.
 *
 * Node 8.16.2 on the unit. No dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var HERE = __dirname;
var PATCHER = path.join(HERE, 'carplay_patch.js');
var TARGET = process.env.WOC_CARPLAY || '/usr/bin/carplay';
var BACKUP = TARGET + '.woc-orig';
var STATE = process.env.WOC_RECOVERY_STATE || '/var/opt/waze-on-cluster/boot-recovery.json';
/* Written by shutdown_mark.sh: "<boot id> running|failed|stopped". */
var MARK = path.join(path.dirname(STATE), 'shutdown');
var SOCK = process.env.WOC_PATCH_SOCK || '/dev/shm/waze-on-cluster/patch.sock';
var PENDING = path.join(path.dirname(SOCK), 'activation-pending');
/* The carplay run (InvocationID) patchd kills to activate a change: its end
 * is not a crash. */
var KILLED = path.join(path.dirname(SOCK), 'carplay-killed');
/* The running (patched) binary, kept hard-linked while restoring so replacing
 * TARGET by rename does not leave an unlinked-but-open file that blocks the
 * read-only remount — the same guard patchd uses (patchd.js, RUNNING). */
var RUNNING = TARGET + '.woc-running';
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';
var PROC = process.env.WOC_PROC || '/proc';
var BOOT_ID = process.env.WOC_BOOT_ID || '/proc/sys/kernel/random/boot_id';
var SYSTEMCTL = process.env.WOC_SYSTEMCTL || 'systemctl';

var THRESHOLD = parseInt(process.env.WOC_RECOVERY_THRESHOLD, 10) || 2;
var HEALTHY_MS = parseInt(process.env.WOC_RECOVERY_HEALTHY_MS, 10) || 60000;
var TICK_MS = parseInt(process.env.WOC_RECOVERY_TICK_MS, 10) || 1000;
/* systemctl is asked this often; between asks a tick only checks /proc. */
var PROBE_MS = 5000;
var START_DELAYS_MS = [5000, 15000, 60000];
/* ExecMainCode of a main process a signal ended without a core dump. */
var CLD_KILLED = '2';
/* The bound on each mount; the classify and the revert get three, since they
 * read the 3.5 MB binary on a head unit still busy starting. A restore
 * (classify, remount rw, revert, two read-only tries) ends within
 * RESTORE_BOUND_MS, which the units' start and stop timeouts cover. */
var STEP_MS = 10000;
var CLASSIFY_MS = 3 * STEP_MS;
var RO_TRIES = 2;
var RESTORE_BOUND_MS = CLASSIFY_MS + STEP_MS * (1 + 3 + RO_TRIES) + 500 * (RO_TRIES - 1);

var lock = require('./remount_lock.js');
var recmgr = require('./recmgr_list.js');

/* / is read-only per /proc/mounts (the last `/` entry is the effective root). */
function rootIsReadOnly() {
    try {
        var lines = fs.readFileSync(PROC_MOUNTS, 'utf8').split('\n');
        var opts = null;
        for (var i = 0; i < lines.length; i++) {
            var p = lines[i].split(' ');
            if (p[1] === '/') opts = p[3];
        }
        if (opts !== null) return /(^|,)ro(,|$)/.test(opts);
    } catch (e) {}
    return false;
}

function remount(rw, cb) {
    cp.execFile(MOUNT, ['-o', 'remount,' + (rw ? 'rw' : 'ro'), '/'], { timeout: STEP_MS }, function (err) { cb(err); });
}

function remountRo(tries, cb) {
    remount(false, function () {
        if (rootIsReadOnly()) { cb(null); return; }
        if (tries > 1) { setTimeout(function () { remountRo(tries - 1, cb); }, 500); return; }
        cb(new Error('/ is still read-write after remount'));
    });
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function readBootId() { return readText(BOOT_ID).trim(); }
function monoMs() { var t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }

/* ---- the real dependencies, injectable for host tests ---- */

/* The on-disk carplay's state. ok is false when the status could not be read
 * (a transient spawn/timeout failure), so the counter is not disturbed. The
 * patch counts as active, and restorable, when the patcher's revert would
 * change the binary (`restorable: yes`): a verified backup of the same build
 * differs from it in one of our edits' regions when the locator recognises
 * both as that build, else anywhere, so a patch any version of this tool
 * wrote is counted and restored. */
function realClassify(cb) {
    cp.execFile(process.execPath, [PATCHER, 'status', '--target', TARGET], { timeout: CLASSIFY_MS }, function (err, out) {
        cb(err ? { ok: false } : classifyStatus((out || '') + ''));
    });
}

/* The patcher's status text as the classify result. Edit 3 (self-start) is
 * the edit whose throw path can crash carplay (PATCH.md "Exception risk"): a
 * binary that has it is our patch even when no backup can restore it, so its
 * crashes are counted and it is marked failed rather than taken for stock. */
function classifyStatus(text) {
    if (!/^size:/m.test(text)) return { ok: false };
    var restorable = /^restorable:\s+yes$/m.test(text);
    var selfStart = /^selfstart:\s+SELF-START/m.test(text);
    var why = /^restorable:\s+no \((.*)\)$/m.exec(text);
    return { ok: true, patchActive: restorable || selfStart, restorable: restorable, why: why ? why[1] : '' };
}

/* Restore the original with the vetted revert, under the shared remount lock,
 * / read-write only for the write and read-only again after. The patched
 * binary is hard-linked to RUNNING first so the rename does not leave an
 * unlinked-but-open file that would keep / writable: always in the watcher,
 * where carplay can start between that check and the rename (patchd removes
 * the link once nothing runs it), and in the boot step, which carplay waits
 * for, only when a process runs it. A RUNNING a process still runs (a change
 * pending this boot) is that link already and stays. With both RUNNING and
 * TARGET run by processes there is no name left to keep TARGET linked, so the
 * restore waits for the next boot. Yields to patchd if the lock is held (cb
 * with an error; the counter stays, so a later try restores). */
function realRestore(onlyIfRunning, cb) {
    if (lock.holds(RUNNING, TARGET) && lock.inUse(TARGET)) { cb(new Error('processes run both ' + TARGET + ' and ' + RUNNING + '; deferring')); return; }
    if (!lock.tryAcquire()) { cb(new Error('remount lock held; deferring')); return; }
    var released = false;
    function finish(err) { if (!released) { released = true; lock.release(); } cb(err); }
    remount(true, function (mErr) {
        if (mErr) { finish(new Error('remount rw: ' + mErr.message)); return; }
        if (!lock.holds(RUNNING, TARGET) && (!onlyIfRunning || lock.inUse(TARGET))) {
            try { fs.unlinkSync(RUNNING); } catch (e) {}
            try { fs.linkSync(TARGET, RUNNING); } catch (e) { log('keeping the running carplay linked failed: ' + e.message); }
        }
        cp.execFile(process.execPath, [PATCHER, 'revert', '--target', TARGET, '--yes'], { timeout: 3 * STEP_MS }, function (pErr, out, errOut) {
            var text = ((out || '') + '') + ((errOut || '') + '');
            try { fs.unlinkSync(PENDING); } catch (e) {}   /* the pending patch is gone */
            remountRo(RO_TRIES, function (roErr) {
                finish(pErr ? new Error('revert: ' + pErr.message + (text ? ' (' + text.trim().slice(-200) + ')' : '')) : roErr);
            });
        });
    });
}

/* carplay.service's current run: its id (InvocationID, else the main
 * process's start time), main PID, ActiveState, Result, and how its main
 * process ended (ExecMainCode, a CLD_* code, and ExecMainStatus). */
function realProbeCarplay(cb) {
    cp.execFile(SYSTEMCTL, ['show', 'carplay.service', '-p', 'InvocationID', '-p', 'ExecMainStartTimestampMonotonic',
        '-p', 'MainPID', '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainCode', '-p', 'ExecMainStatus'], { timeout: STEP_MS }, function (err, out) {
        cb(parseShow((out || '') + ''));
    });
}

function parseShow(text) {
    function get(k) { var m = new RegExp('^' + k + '=(.*)$', 'm').exec(text); return m ? m[1].trim() : ''; }
    var start = get('ExecMainStartTimestampMonotonic');
    return {
        run: get('InvocationID') || (start && start !== '0' ? 't' + start : ''),
        pid: parseInt(get('MainPID'), 10) || 0,
        state: get('ActiveState'),
        result: get('Result'),
        code: get('ExecMainCode'),
        status: get('ExecMainStatus'),
    };
}

function realSystemState(cb) {
    cp.execFile(SYSTEMCTL, ['is-system-running'], { timeout: STEP_MS }, function (err, out) { cb(((out || '') + '').trim()); });
}

function realStartCarplay(cb) {
    cp.execFile(SYSTEMCTL, ['start', 'carplay.service'], { timeout: 30000 }, function (err) { cb(err); });
}

function realMark(boot) {
    var m = /^(\S+) (running|failed|stopped)\s*$/.exec(readText(MARK));
    return m && m[1] === boot ? m[2] : null;
}

function log(line) { process.stdout.write('[' + new Date().toISOString() + '] recovery: ' + line + '\n'); }

/* ---- the counter ---- */

function newArm(boot) { return { boot: boot, crashes: 0, confirmed: false, clean: false }; }

/* waze-on-cluster 0.7.5 and earlier wrote the arm as {boot, state:
 * unconfirmed|confirmed|clean}; a unit updated mid-boot still holds one. */
function normArm(a) {
    if (!a || typeof a !== 'object') return null;
    return { boot: a.boot, crashes: a.crashes || 0, confirmed: !!(a.confirmed || a.state === 'confirmed'), clean: !!(a.clean || a.state === 'clean') };
}

/* The failed mark: a patched carplay crashed at the threshold and no backup
 * can restore it. {since, boot, fails, why}; null when not failed. */
function normFailed(f) {
    if (!f || typeof f !== 'object') return null;
    return { since: f.since || null, boot: f.boot || null, fails: f.fails || 0, why: typeof f.why === 'string' ? f.why : '' };
}

/* What patchd reports for the failed mark: the reason text, or '' when the
 * tool is not marked failed (or the state cannot be read). */
function failedReason(statePath) {
    try {
        var f = normFailed(JSON.parse(fs.readFileSync(statePath || STATE, 'utf8')).failed);
        if (!f) return '';
        return 'carplay crashed ' + f.fails + ' times with the map patch and cannot be restored automatically' +
            (f.why ? ' (' + f.why + ')' : '') + '; keep the phone unplugged and restore carplay by hand (PATCH.md, Boot recovery)';
    } catch (e) { return ''; }
}

/* fails after the previous boot, from its arm and its shutdown mark. */
function tally(fails, arm, mark) {
    var crashes = arm.crashes || (mark === 'failed' ? 1 : 0);
    if (crashes) return fails + crashes;
    if (arm.confirmed) return 0;
    if (arm.clean || mark === 'running' || mark === 'stopped') return fails;
    return fails + 1;
}

function Recovery(opts) {
    opts = opts || {};
    this.statePath = opts.statePath || STATE;
    this.threshold = opts.threshold || THRESHOLD;
    this.healthyMs = opts.healthyMs || HEALTHY_MS;
    this.bootId = opts.bootId || readBootId();
    this._classify = opts.classify || realClassify;
    this._restore = opts.restore || function (cb) { realRestore(false, cb); };
    this._probe = opts.probe || realProbeCarplay;
    this._systemState = opts.systemState || realSystemState;
    this._start = opts.start || realStartCarplay;
    this._mark = opts.mark || realMark;
    this._hasBackup = opts.hasBackup || function () { return fs.existsSync(BACKUP); };
    this._alive = opts.alive || function (pid) { return fs.existsSync(path.join(PROC, String(pid))); };
    this._killed = opts.killed || function () { return readText(KILLED).trim(); };
    this._recmgrLoaded = opts.recmgrLoaded || recmgr.recmgrLoaded;
    this._lock = opts.lock || lock;
    this._now = opts.now || monoMs;
    this._log = opts.log || log;

    this.restoring = false;
    this._restored = [];        /* callbacks waiting for the restore to end */
    this._busy = false;         /* a probe, crash or start is in flight */
    this._pid = 0;              /* the main PID of the active run */
    this._run = '';             /* the active run, for the healthy timer */
    this._lastProbe = -Infinity;
    this._activeSince = null;   /* start of the current continuous-active run */
    this._startAt = null;       /* when the scheduled carplay start is due */
    /* This boot's ended run, crashes and starts, also kept here so a state
     * file that cannot be written neither repeats a crash nor lifts the start
     * limit; the larger of memory and disk counts. */
    this._ended = '';
    this._crashes = 0;
    this._starts = 0;
    this._failed = false;       /* marked failed this run, also when the state cannot be written */
}

Recovery.prototype._load = function () {
    try {
        var st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (st && typeof st === 'object') {
            return { fails: st.fails || 0, arm: normArm(st.arm), starts: st.starts || null, ended: st.ended || null,
                     failed: normFailed(st.failed) };
        }
    } catch (e) {}
    return { fails: 0, arm: null, starts: null, ended: null, failed: null };
};

/* Persist durably: the state must survive the reboot a crash can cause the
 * moment after, so it is on disk, renamed into place, before this returns. A
 * write that fails leaves the previous state whole. false when it failed. */
Recovery.prototype._save = function (st) {
    var dir = path.dirname(this.statePath), tmp = this.statePath + '.tmp', fd;
    try {
        try { fs.mkdirSync(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        fd = fs.openSync(tmp, 'w', 0o644);
        try {
            fs.writeFileSync(fd, JSON.stringify({ fails: st.fails || 0, arm: st.arm || null, starts: st.starts || null, ended: st.ended || null,
                                                  failed: st.failed || null }) + '\n');
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, this.statePath);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        this._log('could not persist state: ' + e.message);
        return false;
    }
    /* The state is written; a folder that cannot be synced (a file system
     * without it) leaves only the rename's timing open. */
    try {
        fd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { this._log('could not sync ' + dir + ': ' + e.message); }
    return true;
};

Recovery.prototype._armed = function (st) { return !!st.arm && st.arm.boot === this.bootId; };
Recovery.prototype._thisBoot = function (rec) { return !!rec && rec.boot === this.bootId; };

/* The boot-time decision: count the previous boot, arm this one, and restore
 * at the threshold, or when this boot's arm could not be saved. Only the
 * restore path classifies the binary. Also run by
 * the watcher at its start, where it counts nothing twice and retries a
 * restore the boot step did not finish. cb(result) for tests; result.action is
 * 'idle' | 'armed' | 'unreadable' | 'restored' | 'restore-failed' |
 * 'restore-unavailable'. */
Recovery.prototype.startBoot = function (cb) {
    cb = cb || function () {};
    var self = this;
    var st = this._load();
    if (st.arm && !this._armed(st)) {
        var was = st.fails;
        st.fails = tally(st.fails, st.arm, this._mark(st.arm.boot));
        st.arm = null;
        if (st.fails !== was) this._log('failed patched boots and crashes now ' + st.fails + ' (was ' + was + ')');
    }
    /* Below the threshold again (carplay ran healthy): no longer failed. */
    if (st.failed && st.fails < this.threshold) { st.failed = null; this._failed = false; }
    if (!this._hasBackup()) {
        /* No backup of ours: nothing of ours to protect or restore. */
        if (st.fails || st.arm || st.failed) { st.fails = 0; st.arm = null; st.failed = null; this._failed = false; this._save(st); }
        cb({ action: 'idle' });
        return;
    }
    if (!st.arm) st.arm = newArm(this.bootId);
    var saved = this._save(st);
    if (saved && st.fails < this.threshold) { cb({ action: 'armed', fails: st.fails }); return; }
    this._classify(function (cls) { self._restoreWith(cls, st.fails, saved, cb); });
};

/* Restore a restorable patch, at the threshold or (saved false) because the
 * count could not be saved; the counter clears once carplay is not ours to
 * protect. */
Recovery.prototype._restoreWith = function (cls, fails, saved, cb) {
    var self = this;
    if (!cls.ok) {
        this._log('could not read carplay state; leaving the boot-recovery counter as is');
        cb({ action: 'unreadable', fails: fails });
        return;
    }
    if (!cls.patchActive) {
        /* Stock, or a binary we do not recognise (a firmware update):
         * nothing to restore. */
        this._clear();
        cb({ action: 'idle' });
        return;
    }
    if (!cls.restorable) {
        /* Patched, crashing, and no backup can undo it. Writing anything
         * else over carplay, or stopping or masking it, could leave the head
         * unit worse off than a crashing CarPlay, so carplay stays as it is.
         * What the tool does: it marks itself failed (patchd reports it to
         * the app), stops starting carplay again itself, and says so loudly
         * at every boot and crash. A crash still restarts the head unit where
         * the firmware does that (carplay.service OnFailure=); only a hand
         * restore ends it. */
        var fst = this._load();
        if (!fst.failed) fst.failed = { since: new Date().toISOString(), boot: this.bootId, fails: fails, why: cls.why || '' };
        else fst.failed.fails = Math.max(fst.failed.fails, fails);
        this._failed = true;
        this._save(fst);
        this._log('ERROR: the map patch is marked FAILED: carplay crashed ' + fails + ' times while patched and no backup ' +
            'can restore it' + (cls.why ? ' (' + cls.why + ')' : '') + '. carplay is left as it is and not started again by ' +
            'this tool. Keep the phone unplugged and restore carplay by hand (PATCH.md, Boot recovery, By hand)');
        cb({ action: 'restore-unavailable', fails: fails });
        return;
    }
    if (this._failed || this._load().failed) {
        /* A backup restores it again (fixed by hand): the mark is stale. */
        var cst = this._load();
        cst.failed = null;
        this._failed = false;
        this._save(cst);
    }
    this._log(saved ? 'restoring the original carplay after ' + fails + ' carplay crashes or failed boots'
        : 'restoring the original carplay: the boot-recovery state cannot be saved');
    this.restoring = true;
    this._restore(function (err) {
        self.restoring = false;
        if (err) self._log('boot recovery restore failed: ' + err.message);
        else { self._log('restored the original carplay; the map is off until Enable map re-applies it'); self._clear(); }
        /* The counter stays after a failure, so a later try restores. */
        cb(err ? { action: 'restore-failed', fails: fails, error: err.message } : { action: 'restored', fails: fails });
        self._restored.splice(0).forEach(function (f) { f(); });
    });
};

Recovery.prototype._clear = function () {
    var st = this._load();
    st.fails = 0;
    st.arm = null;
    st.failed = null;
    this._failed = false;
    this._crashes = 0;
    this._save(st);
};

/* cb once no restore runs: a stop waits for it, so / is never left writable. */
Recovery.prototype.whenRestored = function (cb) {
    if (this.restoring) this._restored.push(cb);
    else cb();
};

/* One watcher poll. A run of carplay is told by its InvocationID. While a
 * run is active a tick only checks that its main PID is in /proc, and asks
 * systemctl every PROBE_MS or once the PID is gone; while carplay is down it
 * asks every PROBE_MS. A run that ended failed (Result not success) is a
 * crash, once per run, unless patchd killed it to activate a change or the
 * system is stopping. A run a SIGKILL ended as a success (the tool's
 * carplay.service drop-in, SuccessExitStatus=SIGKILL) is no crash; unless
 * patchd killed it, which starts it itself, carplay is started again like
 * after a crash. A run continuously active for HEALTHY_MS confirms the boot.
 * cb(result) for tests; result.action is 'skip' | 'watch' | 'confirmed' |
 * 'crash' | 'killed' | 'started' | 'start-skipped'. */
Recovery.prototype.tick = function (cb) {
    cb = cb || function () {};
    var self = this;
    if (this._busy || this.restoring) { cb({ action: 'skip' }); return; }
    var now = this._now();
    if (this._startAt !== null && now >= this._startAt) { this._startDue(cb); return; }
    var fresh = now - this._lastProbe < PROBE_MS;
    if (fresh && (!this._pid || this._alive(this._pid))) { cb({ action: this._healthy(now) }); return; }
    this._busy = true;
    this._probe(function (info) {
        self._lastProbe = now;
        if (info.state === 'active') {
            if (info.run !== self._run) { self._run = info.run; self._activeSince = now; }
            self._pid = info.pid;
        } else {
            self._run = '';
            self._pid = 0;
            self._activeSince = null;
        }
        var ended = info.state === 'failed' || (info.state === 'inactive' && !!info.result && info.result !== 'success');
        var killed = info.state === 'inactive' && info.result === 'success' && info.code === CLD_KILLED && info.status === '9';
        if (!(ended || killed) || !info.run || self._handled(info.run)) { self._busy = false; cb({ action: self._healthy(now) }); return; }
        self._markHandled(info.run);
        if (info.run === self._killed()) { self._busy = false; cb({ action: 'watch' }); return; }
        self._systemState(function (sys) {
            if (sys === 'stopping') { self._busy = false; cb({ action: 'watch' }); return; }
            if (killed) { self._onKill(info, cb); return; }
            self._onCrash(info, cb);
        });
    });
};

Recovery.prototype._handled = function (run) {
    var e = this._load().ended;
    return run === this._ended || (this._thisBoot(e) && e.run === run);
};

Recovery.prototype._markHandled = function (run) {
    this._ended = run;
    var st = this._load();
    st.ended = { boot: this.bootId, run: run };
    this._save(st);
};

Recovery.prototype._healthy = function (now) {
    if (this._activeSince === null || now - this._activeSince < this.healthyMs) return 'watch';
    var st = this._load();
    if (this._armed(st) && !st.arm.confirmed) {
        st.arm.confirmed = true;
        this._save(st);
        this._log('carplay healthy');
        return 'confirmed';
    }
    return 'watch';
};

/* A crash: recorded at once (the next moment can be a reboot), and a
 * restorable patch restored at once when the record could not be saved.
 * Without recmgr's carplay entry nothing more is done here: the boot step
 * counts it and restores at the next start. With it, a patched binary is
 * restored at the threshold, then carplay is started again. */
Recovery.prototype._onCrash = function (info, cb) {
    var self = this, saved = true, loaded = this._recmgrLoaded('carplay');
    function done(extra) { self._busy = false; cb(Object.assign({ action: 'crash' }, extra)); }
    function next(extra) { if (loaded) self._scheduleStart(); done(extra); }
    this._log('carplay (run ' + info.run + ') ended: ' + info.result);
    this._crashes++;
    var st = this._load();
    if (this._armed(st)) { st.arm.crashes = Math.max(st.arm.crashes + 1, this._crashes); saved = this._save(st); }
    if (saved && !loaded) {
        this._log('recmgr did not load a carplay entry this boot: the boot step decides at the next start');
        done({ fails: st.fails + this._crashes });
        return;
    }
    this._classify(function (cls) {
        if (!cls.ok || !cls.patchActive) {
            if (cls.ok) self._clear();
            next();
            return;
        }
        if (!self._armed(st)) { st.arm = newArm(self.bootId); st.arm.crashes = self._crashes; saved = self._save(st); }
        var total = st.fails + Math.max(st.arm.crashes, self._crashes);
        self._log('carplay crashes while patched: ' + total);
        if (saved && total < self.threshold) { next({ fails: total }); return; }
        self._restoreWith(cls, total, saved, function (r) { next({ fails: total, restore: r.action }); });
    });
};

/* A SIGKILL that was not patchd's (the OOM killer, a shell): carplay.service
 * has no Restart=, so it is started again where recmgr loaded its entry
 * (without it, recmgr restarts the head unit for the exit). */
Recovery.prototype._onKill = function (info, cb) {
    this._log('carplay (run ' + info.run + ') was killed');
    if (this._recmgrLoaded('carplay')) this._scheduleStart(true);
    this._busy = false;
    cb({ action: 'killed' });
};

Recovery.prototype._startsThisBoot = function () {
    var s = this._load().starts;
    return Math.max(this._thisBoot(s) ? s.n : 0, this._starts);
};

/* afterKill: the start follows a SIGKILL the patch did not cause, so it is
 * scheduled (bounded by START_DELAYS_MS) even while the patch is marked
 * failed; only restarts after a crash stop then. */
Recovery.prototype._scheduleStart = function (afterKill) {
    if (afterKill && (this._failed || this._load().failed)) {
        this._log('carplay was killed while the map patch is marked failed: starting it again (bounded per boot), ' +
            'since the kill was not a crash of the patch');
    } else if (this._failed || this._load().failed) {
        this._log('carplay stays down: the map patch is marked failed (crashing, no backup restores it); restore it by hand');
        return;
    }
    var n = this._startsThisBoot();
    if (n >= START_DELAYS_MS.length) {
        this._log('carplay stays down: started ' + n + ' times this boot already');
        return;
    }
    this._startAt = this._now() + START_DELAYS_MS[n];
};

/* The scheduled start: only while carplay is down, the system is not
 * stopping, and patchd is not writing (it holds the remount lock; the start
 * waits for the next tick). The run it starts is watched like any other. */
Recovery.prototype._startDue = function (cb) {
    var self = this;
    this._busy = true;
    function done(action) { self._busy = false; cb({ action: action }); }
    this._probe(function (info) {
        if (info.state === 'active' || info.state === 'activating') { self._startAt = null; done('start-skipped'); return; }
        self._systemState(function (sys) {
            if (sys === 'stopping') { self._startAt = null; done('start-skipped'); return; }
            if (!self._lock.tryAcquire()) { done('watch'); return; }
            var n = self._startsThisBoot() + 1;
            self._starts = n;
            var st = self._load();
            st.starts = { boot: self.bootId, n: n };
            self._save(st);
            self._startAt = null;
            self._log('starting carplay (start ' + n + ' this boot)');
            self._start(function (err) {
                self._lock.release();
                if (err) self._log('starting carplay failed: ' + err.message);
                self._lastProbe = -Infinity;   /* probe the new run at the next tick */
                done('started');
            });
        });
    });
};

/* SIGTERM while the system stops (an orderly reboot) exempts a boot with no
 * crash; a SIGTERM from a service restart does not. */
Recovery.prototype.onShutdown = function (cb) {
    var self = this;
    var st = this._load();
    if (!this._armed(st) || st.arm.crashes || this._crashes || st.arm.clean) { cb(); return; }
    this._systemState(function (sys) {
        if (sys === 'stopping') { st.arm.clean = true; self._save(st); }
        cb();
    });
};

module.exports = {
    Recovery: Recovery, tally: tally, parseShow: parseShow, RESTORE_BOUND_MS: RESTORE_BOUND_MS, failedReason: failedReason,
    classifyStatus: classifyStatus,
    realClassify: realClassify, realRestore: realRestore, realProbeCarplay: realProbeCarplay,
};

/* ---- run as the boot step or the watcher ---- */

/* The boot step always exits 0: carplay's start never waits on its failure.
 * Nothing runs carplay before it, so the restore links the patched binary only
 * if a process runs it. */
function runBoot() {
    var rec = new Recovery({ restore: function (cb) { realRestore(true, cb); } });
    rec.startBoot(function (r) { log('boot check: ' + r.action); process.exit(0); });
    /* A stop mid-restore lets the restore finish (it exits then). */
    process.on('SIGTERM', function () { rec.whenRestored(function () { process.exit(0); }); });
}

function runWatcher() {
    var rec = new Recovery({});
    var timer = null;
    var starting = true;
    var stopping = false;
    /* A stop waits for a restore in progress, so / is not left writable. */
    function finish() {
        if (timer) clearInterval(timer);
        rec.whenRestored(function () { rec.onShutdown(function () { process.exit(0); }); });
    }
    rec.startBoot(function () {
        starting = false;
        if (stopping) { finish(); return; }
        /* Polled even with no patch to watch: the service stays up, since
         * Restart=always would otherwise start it again every few seconds
         * and the deploy tool's health check takes that for a crash loop. */
        timer = setInterval(function () { rec.tick(); }, TICK_MS);
    });
    function stop() { if (stopping) return; stopping = true; if (!starting) finish(); }   /* else finish() runs when startBoot returns */
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

if (require.main === module) {
    if (process.argv[2] === 'boot') runBoot();
    else runWatcher();
}
