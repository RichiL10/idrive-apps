#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* recovery.js — the safety net for the carplay and aapd patches (PATCH.md
 * "Boot recovery"). A patch that makes the head unit restart, whether the
 * patched binary crashes or another process does, loops it with the patched
 * binary still on disk and no HMI to turn the patch off. Each service has
 * its own counter. On a head unit that refuses our parts (head_unit.js) a
 * patch of ours is restored before its service starts, whatever the
 * counter.
 *
 *   recovery.js boot [carplay|aapd]
 *                      waze-on-cluster-boot.service (carplay) and
 *                      waze-on-cluster-aa-boot.service (aapd), oneshots
 *                      ordered before their service: count the previous
 *                      boot, record this one before the service starts
 *                      and, at the threshold, restore the original first.
 *   recovery.js        waze-on-cluster-recovery.service: watches both for
 *                      the rest of the boot, records each crash the moment
 *                      it is seen and a healthy start once the service has
 *                      run HEALTHY_MS. Where recmgr loaded a service's entry
 *                      it also restores at the threshold and starts the
 *                      service again, for as long as the head unit stays up.
 *
 * The boot step decides from small files only: the backup's presence, the
 * patch record (patch_record.js: whether the binary about to start is our
 * patch, and of a proven build), the service's state file, the previous
 * boot's shutdown mark and, without one, the restart records of recmgr and
 * crashhandler. It reads a binary only to restore it.
 *
 * A service's state ({fails, unknown, arm, prev, starts, ended}): fails,
 * the failed patched boots and crashes since the last healthy boot;
 * unknown, the patched boots in a row since then that ended with no
 * record; arm, this boot's record ({boot, at, patch, crashes, ran,
 * confirmed, clean}), written before a patched binary starts; prev, the
 * last boot counted; starts ({boot, n}), the starts made this boot; ended
 * ({boot, run}), the last run whose end was handled. At the next boot the
 * armed boot counts only on evidence (tally): a crash of the service, or a
 * restart recmgr or crashhandler recorded. A healthy boot clears the count,
 * an orderly one (a switch-off, a restart asked for) or one the service
 * never ran in keeps it, and two boots in a row with no record at all
 * count one. A proven patch is restored at 2 failed boots or crashes with
 * no healthy boot between, an unproven one at 1 (THRESHOLD).
 *
 * shutdown_mark.sh (a var-opt-ro.service drop-in) records at each NSM
 * shutdown, before /var/opt goes read-only, whether each service was
 * running, failed or stopped, "crash" when recmgr or crashhandler asked
 * for that restart, and the boot's uptime. An orderly reboot stops the
 * watcher while the system is stopping (arm.clean); patchd records a
 * restart the user asked for in restart-requested.
 *
 * The restore writes the backup whole, verified against the SHA-256 its
 * record took (or, with no record, the proven stock file's SHA-256), over a
 * target of the backup's own build, atomically and
 * fsynced, with the original's mode and owner set explicitly (file_mode.js),
 * under the remount lock shared with patchd, with / read-write
 * only for the write. Before anything else each boot step gives a file
 * that holds exactly its original but lacks the access the service's user
 * needs (carplay or aapd not readable and executable by group and other,
 * aapd.conf not readable by them, as a write
 * under umask 077 leaves them) its original's mode and owner, nothing
 * else. Each remount is bounded (STEP_MS); a boot step gives
 * up at BOOT_BOUND_MS whatever hangs and exits by BOOT_EXIT_MS, after a few
 * bounded tries to put / back read-only (it exits 1 and keeps the remount lock
 * with the ro-failed guard when / is still not verified read-only). It never kills, restarts or reboots
 * anything; the only start is `systemctl start` of the service after a
 * crash or a SIGKILL patchd did not send, never stop or restart, bounded by
 * START_DELAYS_MS per boot.
 *
 * The failed mark (Kiro test build, S4). A patched carplay that keeps
 * crashing while no usable backup can restore it (the backup is missing, or
 * neither its record nor the proven stock SHA-256 vouches for it) is not
 * touched: nothing else is written over it, and the tool never stops or
 * masks it. It writes a persistent mark to the state file ({failed: {since,
 * boot, fails, why}}), logs an ERROR at every boot and crash, no longer
 * starts carplay again after a crash (the head unit's own restart for the
 * crash is not ours to add to: no reboot storm from this tool), and patchd
 * reports the mark in its status (failedReason) for as long as the binary is
 * not the original. A SIGKILL that patchd did not send (the OOM killer, a
 * shell) is no crash of the patch, so carplay is still started again for it,
 * bounded by START_DELAYS_MS per boot, mark or not. The mark clears when the
 * binary is stock again (restored by hand, a firmware update), when a
 * verified backup restores it, or when the count falls below the threshold
 * (carplay ran healthy). Only carplay has the mark.
 *
 * Android Auto is opt-in (aa_enabled.js, S6): with aa_enabled = 0, the
 * default, the aapd boot step and the watcher's aapd side exit or stay away
 * before they read, stat, write or remount for /usr/bin/aapd, /etc/aapd.conf,
 * their backups and markers, and carplay's count ignores aapd's state and
 * shutdown mark.
 *
 * Node 8.16.2 on the unit. No dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var aaSwitch = require('./aa_enabled.js');
var record = require('./patch_record.js');
var lock = require('./remount_lock.js');
var headUnit = require('./head_unit.js');
var recmgr = require('./recmgr_list.js');
var fileMode = require('./file_mode.js');

/* ExecMainCode of a main process a signal ended without a core dump. */
var CLD_KILLED = '2';

/* What is watched and restored, per service. state: the counter; mark:
 * written by shutdown_mark.sh; restart: patchd's record of a restart the
 * user asked for; pending: patchd's marker of a change waiting for the next
 * start; killed: the run (InvocationID) patchd kills to activate a change,
 * whose end is not a crash; running: the patched binary, kept hard-linked
 * while restoring so replacing the target by rename does not leave an
 * unlinked-but-open file that blocks the read-only remount (patchd.js keeps
 * the same link); files: what a restore writes, the binary first; check(i,
 * cur): files[i]'s verified backup by the patcher's own checks, {buf, other
 * (why cur is not its build or file, or null), orig (its record: the
 * original's mode and owner, when kept)} or {err}, null without one;
 * stock(i, cur): whether cur is files[i] as the proven build ships it;
 * floors: the bits each file must have for the service's user (file_mode.js);
 * killedRun: how a SIGKILL
 * that is no crash ends the run. carplay's drop-in makes SIGKILL a
 * success; aapd.service has none, so SIGKILL ends it failed with
 * Result=signal. */
function targets(o) {
    var dir = path.dirname(o.state), shm = path.dirname(o.sock), restart = path.join(dir, 'restart-requested');
    var sin = o.sin || '/var/opt/public/sin', restartInfo = [path.join(sin, 'recmgr', 'restartInfo.xml'), path.join(sin, 'crashhandler', 'restartInfo.xml')];
    var t = {
        carplay: {
            name: 'carplay', unit: 'carplay.service', target: o.carplay, files: [o.carplay], floors: [fileMode.EXEC], failedMark: true,
            check: function (i, cur) {
                if (!exists(o.carplay + '.woc-orig')) return null;
                var cpp = require('./carplay_patch.js'), b = cpp.trustedBackup(o.carplay, cur || Buffer.alloc(0));
                var stock = Object.keys(cpp.PROVEN).some(function (id) { return cpp.PROVEN[id].sha256 === b.hash; });
                if (b.err) return b;
                if ((!b.meta || !b.meta.sha256_original) && !stock) return { err: 'no record of its SHA-256' };
                return { buf: b.buf, other: cur ? b.other : null, orig: b.meta };
            },
            stock: function (i, cur) {
                var cpp = require('./carplay_patch.js'), h = sha256(cur);
                return Object.keys(cpp.PROVEN).some(function (id) { return cpp.PROVEN[id].sha256 === h; });
            },
            backups: [o.carplay + '.woc-orig'], state: o.state, mark: path.join(dir, 'shutdown'), restart: restart, restartInfo: restartInfo,
            pending: path.join(shm, 'activation-pending'), killed: path.join(shm, 'carplay-killed'), running: o.carplay + '.woc-running',
            killedRun: function (i) { return i.state === 'inactive' && i.result === 'success' && i.code === CLD_KILLED && i.status === '9'; },
        },
        aapd: {
            name: 'aapd', unit: 'aapd.service', target: o.aapd, files: [o.aapd, o.aapdConf], floors: [fileMode.EXEC, fileMode.READ], gated: true,
            check: function (i, cur) {
                var ap = require('./aapd_patch.js'), f = i ? o.aapdConf : o.aapd;
                var b = exists(f + '.woc-orig.json') ? ap.trusted(f) : stockBackup(f, i ? require('./aapd_conf.js').ORIGINAL_SHA256 : ap.KNOWN.sha256);
                if (!b || b.err) return b;
                return { buf: b.buf, other: !cur ? null : i ? require('./aapd_conf.js').otherFile(cur.toString('utf8'), b.buf.toString('utf8'))
                    : require('./aapd_patch.js').binOther(cur, b.buf), orig: b.meta || null };
            },
            stock: function (i, cur) {
                return sha256(cur) === (i ? require('./aapd_conf.js').ORIGINAL_SHA256 : require('./aapd_patch.js').KNOWN.sha256);
            },
            backups: [o.aapd + '.woc-orig', o.aapdConf + '.woc-orig'], state: path.join(dir, 'aa-boot-recovery.json'),
            mark: path.join(dir, 'shutdown-aapd'), restart: restart, restartInfo: restartInfo,
            pending: path.join(shm, 'aa-pending'), killed: path.join(shm, 'aapd-killed'), running: o.aapd + '.woc-running',
            killedRun: function (i) { return (i.state === 'failed' || i.state === 'inactive') && i.result === 'signal' && i.code === CLD_KILLED && i.status === '9'; },
        },
    };
    t.carplay.other = t.aapd;
    t.aapd.other = t.carplay;
    return t;
}
function sha256(buf) { return require('crypto').createHash('sha256').update(buf).digest('hex'); }

/* A backup without its record ({buf}, or {err}), null without one: trusted
 * only when it is the shipped file of the proven build (hash). */
function stockBackup(file, hash) {
    var buf;
    try { buf = fs.readFileSync(file + '.woc-orig'); } catch (e) { return null; }
    return sha256(buf) === hash ? { buf: buf } : { err: file + '.woc-orig has no record and is not the proven build' };
}

var TARGETS = targets({
    state: process.env.WOC_RECOVERY_STATE || '/var/opt/waze-on-cluster/boot-recovery.json',
    sock: process.env.WOC_PATCH_SOCK || '/dev/shm/waze-on-cluster/patch.sock',
    carplay: process.env.WOC_CARPLAY || '/usr/bin/carplay',
    aapd: process.env.WOC_AAPD || '/usr/bin/aapd',
    aapdConf: process.env.WOC_AAPD_CONF || '/etc/aapd.conf',
    sin: process.env.WOC_SIN_DIR,
});
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';
var PROC = process.env.WOC_PROC || '/proc';
var boot = require('./boot_id.js');
var SYSTEMCTL = process.env.WOC_SYSTEMCTL || 'systemctl';

/* Failed boots or crashes before a restore: a build outside the patcher's
 * proven list is restored at its first, a proven one at its second; a
 * binary of the backup's build the record does not describe counts as
 * proven. */
var THRESHOLD = { proven: 2, unknown: 2, unproven: 1 };
/* A start is healthy once the service has run this long without a break:
 * past the head unit's own start-up (its services up and connected) and a
 * phone's CarPlay or Android Auto session, which an attached phone opens
 * within it. */
var HEALTHY_MS = parseInt(process.env.WOC_RECOVERY_HEALTHY_MS, 10) || 60000;
var TICK_MS = parseInt(process.env.WOC_RECOVERY_TICK_MS, 10) || 1000;
/* systemctl is asked this often while the service is down; while its main
 * PID is in /proc, which every tick checks, only every ALIVE_PROBE_MS, as a
 * backstop. */
var PROBE_MS = 5000;
var ALIVE_PROBE_MS = 60000;
var START_DELAYS_MS = [5000, 15000, 60000];
/* How far a file's modification time may stray from the clock: file
 * systems stamp with a coarser one. */
var FS_CLOCK_MS = 1000;
/* The bound on each remount. */
var STEP_MS = parseInt(process.env.WOC_RECOVERY_STEP_MS, 10) || 10000;
var RO_TRIES = 2;
/* Reading, hashing and writing the files of one restore. */
var IO_MS = STEP_MS / 2;
/* A restore: remount rw, the writes, two read-only tries 500 ms apart. */
var RESTORE_BOUND_MS = STEP_MS * (1 + RO_TRIES) + 500 * (RO_TRIES - 1) + IO_MS;
/* The two boot steps run side by side and share the remount lock: a boot
 * step waits this long for the other's restore. */
var BOOT_LOCK_WAIT_MS = STEP_MS;
/* A boot step gives up at BOOT_BOUND_MS whatever hangs, then takes up to
 * STEP_MS more to put / back read-only: it exits by BOOT_EXIT_MS, which the
 * boot units' timeouts cover. */
var BOOT_BOUND_MS = BOOT_LOCK_WAIT_MS + RESTORE_BOUND_MS;
var BOOT_EXIT_MS = BOOT_BOUND_MS + STEP_MS + 500;

/* Whether t is off by the owner's choice: aapd while aa_enabled is not 1
 * (S6). Nothing of an off target is read, written or remounted. */
function off(t) { return !!t.gated && !aaSwitch.enabled(); }

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function monoMs() { var t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }
function exists(f) { return fs.existsSync(f); }
function log(line) { process.stdout.write('[' + new Date().toISOString() + '] recovery: ' + line + '\n'); }

/* What t's target holds, from the backup's presence and the patch record:
 * 'none' (no backup of ours), 'original', our patch of a 'proven' or
 * 'unproven' build, or 'unknown' (a backup of ours beside a target the
 * record does not describe). */
function patchKind(t) {
    if (!t.backups.some(exists)) {
        /* carplay with no backup but a record that names our patch (S4): the
         * binary is patched and nothing can restore it. It is counted like any
         * patch, and marked failed at the threshold instead of restored. */
        var lost = t.failedMark ? record.current(t.target) : null;
        return lost && lost.patched ? (lost.proven ? 'proven' : 'unproven') : 'none';
    }
    var rec = record.current(t.target);
    return !rec ? 'unknown' : !rec.patched ? 'original' : rec.proven ? 'proven' : 'unproven';
}

function hasBackup(t) { return t.backups.some(exists); }

/* Whether t's binary holds exactly the original its backup's record names
 * (sha256_original), or the proven stock build. Read only for a failed mark,
 * which is rare: the boot step otherwise never reads the binary. */
function holdsRecordedOriginal(t) {
    try {
        var cur = fs.readFileSync(t.target), h = sha256(cur), meta = JSON.parse(readText(t.target + '.woc-orig.json'));
        return (!!meta && typeof meta.sha256_original === 'string' && meta.sha256_original === h) || (!!t.stock && t.stock(0, cur));
    } catch (e) { return false; }
}

/* Whether a file besides the binary (aapd.conf) still differs from its
 * verified backup: part of a patch a restore did not get to. */
function leftover(t) {
    return t.files.slice(1).some(function (f, i) {
        var p = restorePlan(t, i + 1);
        return !!p && !!p.out;
    });
}

/* t's shutdown mark of boot: {state: running|failed|stopped, crash, ran:
 * systemd started the service in that boot, up: the boot's uptime in s, or
 * null}. */
function markOf(t, id) {
    var m = /^(\S+) (running|failed|stopped)( crash)?( ran)?(?: up (\d+))?\s*$/.exec(readText(t.mark));
    return m && m[1] === id ? { state: m[2], crash: !!m[3], ran: !!m[4], up: m[5] === undefined ? null : parseInt(m[5], 10) } : null;
}

/* A restart record of recmgr or crashhandler written in the armed boot: at
 * or after the arm, before this boot started (/proc/stat's btime), and not
 * ahead of the clock, each within FS_CLOCK_MS. */
function restartRecorded(t, arm) {
    var now = Date.now(), started = boot.bootTime();
    return !!arm.at && t.restartInfo.some(function (f) {
        var at;
        try { at = fs.statSync(f).mtime.getTime(); } catch (e) { return false; }
        return at >= arm.at - FS_CLOCK_MS && at <= now + FS_CLOCK_MS && (started === null || at <= started + FS_CLOCK_MS);
    });
}

/* Whether t's other service was armed in boot and crashed in it: a crash
 * its watcher recorded, or its shutdown mark. */
function otherCrashed(t, boot) {
    var o = t.other, st = null;
    if (off(o)) return false;   /* Android Auto is off: its state and mark are not read */
    try { st = JSON.parse(fs.readFileSync(o.state, 'utf8')); } catch (e) { return false; }
    var arms = [st && st.arm, st && st.prev].filter(function (a) { return !!a && a.boot === boot; });
    if (!arms.length) return false;
    var m = markOf(o, boot);
    return arms.some(function (a) { return a.crashes > 0; }) || (!!m && m.state === 'failed');
}

/* How the armed boot arm ended for t: its shutdown mark's service state;
 * crash, evidence of a restart recmgr or crashhandler asked for (the mark
 * says so, or, with no mark, their record of that boot); orderly, a
 * switch-off or a restart asked for (a mark without crash from a boot that
 * lasted the healthy window, patchd's restart-requested, the watcher
 * stopped while the system stopped); neverRan, the service never ran in it
 * (stopped at the shutdown, never started by systemd nor seen running, no
 * crash); explained, the
 * other service's patch crashed in it. A mark without crash from a shorter
 * boot is none of these: it may be a crash restart whose record was missed,
 * so it counts as a boot with no record. */
function endOf(t, arm) {
    var m = markOf(t, arm.boot), long = !!m && m.up !== null && m.up * 1000 >= HEALTHY_MS;
    return {
        state: m ? m.state : null,
        crash: m ? m.crash : restartRecorded(t, arm),
        orderly: arm.clean || readText(t.restart).trim() === arm.boot || (!!m && !m.crash && long),
        neverRan: !!m && m.state === 'stopped' && !m.ran && !arm.ran && !arm.crashes,
        explained: otherCrashed(t, arm.boot),
    };
}

/* The count ({fails, unknown}) after an armed boot (arm) that ended as end
 * says, and why. A crash of the service counts each time. Otherwise a
 * healthy boot clears the count; a boot the service never ran in counts
 * nothing; a crash restart counts one, unless the other service's patch
 * crashed in it (it counts there); an orderly end counts nothing. A boot
 * that ended with no record (a power cut, a 12 V disconnect, a dealer
 * tool, or a restart whose records were lost) is unknown: two in a row
 * count one, so a loop that leaves no record is still caught. */
function tally(count, arm, end) {
    var crashes = arm.crashes || (end.state === 'failed' ? 1 : 0);
    if (crashes) return { fails: count.fails + crashes, unknown: 0, why: 'saw ' + crashes + ' crash' + (crashes === 1 ? '' : 'es') + ' of the service' };
    if (arm.confirmed) return { fails: 0, unknown: 0, why: 'ran healthy' };
    if (end.neverRan) return { fails: count.fails, unknown: count.unknown, why: 'ended before the service ran' };
    if (end.explained) return { fails: count.fails, unknown: 0, why: 'ended for the other service\'s crash' };
    if (end.crash) return { fails: count.fails + 1, unknown: 0, why: 'ended in a restart for a crash' };
    if (end.orderly) return { fails: count.fails, unknown: 0, why: 'ended in order' };
    if (count.unknown + 1 >= 2) return { fails: count.fails + 1, unknown: 0, why: 'is the second in a row to end with no record' };
    return { fails: count.fails, unknown: count.unknown + 1, why: 'ended with no record' };
}

/* ---- the restore ---- */

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

function remount(rw, cb, ms) {
    cp.execFile(MOUNT, ['-o', 'remount,' + (rw ? 'rw' : 'ro'), '/'], { timeout: ms || STEP_MS }, function (err) { cb(err); });
}

function remountRo(tries, cb) {
    remount(false, function () {
        if (rootIsReadOnly()) { cb(null); return; }
        if (tries > 1) { setTimeout(function () { remountRo(tries - 1, cb); }, 500); return; }
        cb(new Error('/ is still read-write after remount'));
    });
}

/* The ro-failed guard (Kiro test build, review of fix-p). A write window that
 * ends with / not verified read-only does not hand / on: `writing` stays set,
 * the remount lock stays held and <lock>.ro-failed names the reason (see
 * remount_lock.js), so no other writer (patchd, a later restore or mode
 * repair) takes it while / may be writable. roGuard tries to clear it, before
 * a write and once per PROBE_MS in the watcher: the guard goes when / is
 * verified read-only. The boot step exits 1 while it stands. */
var roFailed = null;
/* What a writer needs to verify / read-only under the lock, or put it back (remount_lock.js verifyRo). */
var RO = { isRo: rootIsReadOnly, remountRo: function (done) { remountRo(RO_TRIES, done); } };
/* The standing guard's reason: this process's, else the marker's (or the lock module's, set in this process); null when none. */
function roStanding() { return roFailed !== null ? roFailed : lock.roFailedReason(); }
function roFailedError(why) {
    var e = new Error('ro-failed: ' + why + '; / may be writable, nothing is written until it is read-only again (mount -o remount,ro /)');
    e.roFailed = true;
    return e;
}
function holdRoFailed(why) {
    roFailed = why;
    writing = true;
    var marked = lock.markRoFailed(why);
    log('ERROR: ro-failed: ' + why + '. / may still be writable: the remount lock is kept and no restore or patch writes until / is read-only again ' +
        '(mount -o remount,ro /; the next run clears the guard)');
    /* A marker that cannot be written (F3 of fix3-p) is a distinct failure: the guard stands in this
     * process only, and once it exits the next writer does not find it. It finds the lock gone (the
     * holder is dead), takes it and verifies / read-only itself before it writes (lock.acquireWrite
     * with RO), and puts / back or refuses. */
    if (!marked) log('ERROR: the ro-failed marker could not be written; the guard stands in this process only, and the next writer verifies / read-only itself before it writes');
}
/* True only when / is read-only per /proc/mounts, now (review of fix3-p, F1:
 * no guard standing is no proof of it); a guard that stands is cleared then. */
function roSettled() {
    if (!rootIsReadOnly()) return false;
    if (roStanding() !== null) {
        roFailed = null;
        writing = false;
        lock.clearRoFailed();
        lock.release();
    }
    return true;
}
/* The boot step's last word, cb(true) once / is verified read-only (roSettled),
 * after it was put back if it was not: a standing guard is retried (roGuard);
 * with / read-write and no guard (a writer that died with it writable, or one
 * in its window) the lock is waited for, and under it / is verified and
 * put back (acquireWrite with RO), else the guard is set and the lock kept.
 * cb(false) when it could not. */
function settleRo(cb) {
    if (roSettled()) { cb(true); return; }
    if (roStanding() !== null) { roGuard(function () { cb(roSettled()); }); return; }
    log('/ is read-write and no ro-failed guard stands: taking the remount lock to verify and put it back read-only');
    lock.acquireWrite(BOOT_LOCK_WAIT_MS, function (got, rf) {
        if (got) { lock.release(); cb(roSettled()); return; }
        if (rf !== null) { if (lock.ownsLock()) holdRoFailed(rf); }
        else log('the remount lock is held by another process for ' + BOOT_LOCK_WAIT_MS + ' ms: / is not verified read-only');
        cb(false);
    }, RO);
}
/* cb(null) with no guard (synchronously) or once it is cleared, else cb(why). */
function roGuard(cb) {
    var why = roStanding();
    if (why === null) { cb(null); return; }
    lock.healRo(why, rootIsReadOnly, function (done) { remountRo(RO_TRIES, done); }, function (left) {
        if (!left) {
            roFailed = null;
            writing = false;
            log('/ is read-only again: the ro-failed guard is cleared');
        }
        cb(left);
    });
}
/* The end of a write window: the lock goes, and `writing` clears, only once
 * / is read-only (roErr null); else the guard is set. Returns err, marked
 * when it is the ro-failed one. */
function endWindow(err, roErr) {
    if (roErr) {
        holdRoFailed(roErr.message);
        if (err) err.roFailed = true;
    } else {
        writing = false;
        lock.release();
    }
    return err;
}
/* The pre-lock part of a write: cb(err) with the guard's error, or cb(null)
 * and the lock taken (waitMs: waited for). */
function takeLock(waitMs, cb) {
    roGuard(function (standing) {
        if (standing) { cb(roFailedError(standing)); return; }
        /* Under the lock, / is verified read-only before anything remounts it read-write; if it is
         * not and cannot be put back, the lock is kept with the guard set (acquireWrite). */
        lock.acquireWrite(waitMs || 0, function (got, rf) {
            if (got) { cb(null); return; }
            if (rf === null) { cb(new Error(waitMs ? 'remount lock held for ' + waitMs + ' ms; deferring' : 'remount lock held; deferring')); return; }
            if (lock.ownsLock()) holdRoFailed(rf);   /* the verification failed here: this process keeps the lock */
            cb(roFailedError(rf));
        }, RO);
    });
}

/* The read-write remount failed (non-zero exit, killed by the timeout or by a
 * signal): it may still have changed the mount before it failed, so / is put
 * back read-only, bounded as everywhere, before the caller clears its writing
 * mark and lets go of the lock. If that fails too, finish(err, roErr) gets
 * the ro-failed error and the caller keeps the lock (endWindow). */
function rwFailed(mErr, finish) {
    var done = false;
    function end(roErr) {
        if (done) return;
        done = true;
        if (roErr) log('after the failed read-write remount, / could not be put back read-only: ' + roErr.message);
        finish(new Error('remount rw: ' + mErr.message), roErr || null);
    }
    try { remountRo(RO_TRIES, end); } catch (e) { end(e); }
}

function sameInode(a, b) {
    try { var x = fs.statSync(a), y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch (e) { return false; }
}

/* What a restore of t.files[i] writes, or null when it has no backup of
 * ours: { out, want } (out null when the file holds it already; want, the
 * original's mode and owner, file_mode.js), { other } (another build or
 * file than the backup's: left as it is) or { err } (a backup neither its
 * record nor the proven stock SHA-256 vouches for). */
function restorePlan(t, i) {
    var cur = null;
    try { cur = fs.readFileSync(t.files[i]); } catch (e) {}
    var b = t.check(i, cur);
    if (!b || b.err) return b;
    return cur && cur.equals(b.buf) ? { out: null } : b.other ? { other: b.other }
        : { out: b.buf, want: fileMode.wanted(t.files[i], b.orig, t.floors[i]) };
}

var fsyncPath = record.fsyncPath;

function unavailable(err) { err.unavailable = true; return err; }

/* Permissions-only damage: the files of t that hold exactly their original
 * (the verified backup of ours, or the proven build's shipped file) but
 * lack the access the service's user needs, as a write under a restrictive
 * umask leaves them; [{file, want}]. One stat per file when none lacks it;
 * a file that does is read and checked. */
function damaged(t) {
    var out = [];
    t.files.forEach(function (f, i) {
        if (!fileMode.lacks(f, t.floors[i])) return;
        var cur, why = f + ' is not ' + (t.floors[i] === fileMode.EXEC ? 'readable and executable' : 'readable') + ' by ' + t.unit + '\'s user';
        try { cur = fs.readFileSync(f); } catch (e) { log(why + ' and cannot be read: ' + e.message); return; }
        var b = t.check(i, cur), orig = b && !b.err && cur.equals(b.buf);
        if (!orig && !t.stock(i, cur)) { log(why + ' but is not its original: left to the restore'); return; }
        out.push({ file: f, want: fileMode.wanted(f, orig ? b.orig : null, t.floors[i]) });
    });
    return out;
}

/* The damaged files of t given their original's mode and owner, nothing
 * else changed, under the shared remount lock (waited for up to waitMs), /
 * read-write only for that and read-only again after. cb(err, n): n, the
 * files set. */
function repairModes(t, waitMs, cb) {
    var list = damaged(t);
    if (!list.length) { cb(null, 0); return; }
    function locked() {
        writing = true;
        function finish(err, roErr) { err = endWindow(err, roErr); cb(err, err ? 0 : list.length); }
        remount(true, function (mErr) {
            if (mErr) { rwFailed(mErr, finish); return; }
            var wErr = null;
            try {
                list.forEach(function (x) {
                    fileMode.repair(x.file, x.want);
                    log('set ' + x.file + ' to its original\'s mode 0' + x.want.mode.toString(8) + ' and owner ' + x.want.uid + ':' + x.want.gid);
                });
            } catch (e) { wErr = e; }
            remountRo(RO_TRIES, function (roErr) { finish(wErr || roErr, roErr); });
        });
    }
    takeLock(waitMs, function (err) {
        if (err) { cb(err, 0); return; }
        locked();
    });
}

/* Restore t's originals from its verified backups, under the shared remount
 * lock, / read-write only for the write and read-only again after; the
 * patch record then names the restore (fails: the count it was made at).
 * cb(err, outcome): 'restored', 'original' (nothing to write) or 'other'
 * (the binary is another build than the backup's: a firmware update; not
 * ours). A backup neither its record nor the proven stock SHA-256 vouches
 * for is refused; aapd.conf in that state, or another file, is left while
 * aapd is restored. The
 * patched binary is hard-linked to t.running first so the rename does not
 * leave an unlinked-but-open file that would keep / writable: always in
 * the watcher, where the service can start between that check and the
 * rename (patchd removes the link once nothing runs it), and in the boot
 * step, which the service waits for, only when a process runs it. A link a
 * process still runs is that link already and stays. With both the link
 * and the target run by processes there is no name left to keep the target
 * linked, so the restore waits for the next boot. Without the lock (patchd
 * writes) it defers: the counter stays, so a later try restores. */
function restoreTarget(t, onlyIfRunning, fails, cb, waitMs) {
    var plans = t.files.map(function (f, i) { return restorePlan(t, i); });
    var bin = plans[0];
    /* These two stay the same on every try: no backup, or one nothing vouches
     * for. Marked so the failed mark (S4) tells them from a lock held or a
     * remount that failed, which a later try may get past. */
    if (!bin) { cb(unavailable(new Error('no backup of ' + t.target))); return; }
    if (bin.err) { cb(unavailable(new Error('refusing the backup: ' + bin.err))); return; }
    if (bin.other) { cb(null, 'other'); return; }
    plans.slice(1).forEach(function (p, i) { if (p && (p.err || p.other)) log(t.files[i + 1] + ' left as it is: ' + (p.err || 'another file than its backup: ' + p.other)); });
    var writes = [];
    plans.forEach(function (p, i) { if (p && p.out) writes.push({ file: t.files[i], buf: p.out, want: p.want }); });
    var rec = record.current(t.target);
    /* On a head unit that refuses our parts nothing is remounted only to
     * correct the record. */
    var refused = headUnit.refused();
    if (!writes.length && ((rec && !rec.patched) || refused)) { cb(null, 'original'); return; }
    if (lock.holds(t.running, t.target) && lock.inUse(t.target)) { cb(new Error('processes run both ' + t.target + ' and ' + t.running + '; deferring')); return; }
    function locked() {
        var released = false;
        writing = true;
        function finish(err, outcome, roErr) { if (!released) { released = true; err = endWindow(err, roErr); } cb(err, outcome); }
        remount(true, function (mErr) {
            if (mErr) { rwFailed(mErr, function (err, roErr) { finish(err, undefined, roErr); }); return; }
            var wErr = null;
            try {
                if (writes.length && !lock.holds(t.running, t.target) && (!onlyIfRunning || lock.inUse(t.target))) {
                    try { fs.unlinkSync(t.running); } catch (e) {}
                    try { fs.linkSync(t.target, t.running); } catch (e) { log('keeping the running ' + t.name + ' linked failed: ' + e.message); }
                    /* A process runs the target and nothing links its inode: the
                     * rename would leave an unlinked file in use, / could not go
                     * read-only. Nothing is written then; / goes read-only below
                     * and the lock goes with it. With no process on the target
                     * (checked again after the failure) the restore goes on
                     * without the link. */
                    if (!sameInode(t.target, t.running) && lock.inUse(t.target))
                        throw new Error('a process runs ' + t.target + ' and keeping it linked as ' + t.running + ' failed; nothing written, the restore waits for the next boot');
                }
                writes.forEach(function (w) { fileMode.replace(w.file, w.buf, w.want); });
                record.write(t.target, !writes.length ? { patched: false } : refused ? { patched: false, by: 'refused', at: new Date().toISOString() }
                    : { patched: false, by: 'recovery', at: new Date().toISOString(), fails: fails });
                try { fs.unlinkSync(t.pending); } catch (e) {}   /* the pending patch is gone */
            } catch (e) { wErr = e; }
            remountRo(RO_TRIES, function (roErr) {
                if (wErr) finish(new Error('writing: ' + wErr.message + (roErr ? '; ' + roErr.message : '')), undefined, roErr);
                else finish(roErr, writes.length ? 'restored' : 'original', roErr);
            });
        });
    }
    takeLock(waitMs, function (err) {
        if (err) { cb(err); return; }
        locked();
    });
}

/* Whether a restore holds the remount lock in this process. */
var writing = false;

/* A restore cut short (the boot step out of time): / is put back read-only,
 * a few bounded tries within one STEP_MS, and `writing` clears and the lock
 * is released only once / is verified read-only. If it is not, the guard is
 * set (holdRoFailed): the lock stays held, <lock>.ro-failed names the reason,
 * and the boot step exits 1. */
var ABANDON_TRIES = 3;
function abandonRestore(cb) {
    if (!writing) { cb(); return; }
    var per = Math.max(100, Math.floor(STEP_MS / ABANDON_TRIES));
    (function attempt(n) {
        remount(false, function () {
            if (rootIsReadOnly()) { roFailed = null; writing = false; lock.clearRoFailed(); lock.release(); cb(); return; }
            if (n > 1) { attempt(n - 1); return; }
            holdRoFailed('the boot step ran out of time and / is still read-write after ' + ABANDON_TRIES + ' remount,ro tries');
            cb();
        }, per);
    })(ABANDON_TRIES);
}

/* ---- the service's run ---- */

/* t.unit's current run: its id (InvocationID, else the main process's start
 * time), main PID, ActiveState, Result, and how its main process ended
 * (ExecMainCode, a CLD_* code, and ExecMainStatus). */
function probeTarget(t, cb) {
    cp.execFile(SYSTEMCTL, ['show', t.unit, '-p', 'InvocationID', '-p', 'ExecMainStartTimestampMonotonic',
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

/* 'stopping' while a shutdown, reboot or poweroff is under way
 * (shutdown.target active or queued: `systemctl is-system-running` says
 * "starting" for one that begins before the boot finished) or an NSM
 * shutdown (var-opt-ro.service queued or running), else is-system-running's
 * answer. */
function realSystemState(cb) {
    cp.execFile(SYSTEMCTL, ['show', 'shutdown.target', 'var-opt-ro.service', '-p', 'ActiveState', '-p', 'Job'], { timeout: STEP_MS }, function (err, out) {
        var t = (out || '') + '';
        if (/^Job=\d+/m.test(t) || /^ActiveState=(active|activating)$/m.test(t)) { cb('stopping'); return; }
        cp.execFile(SYSTEMCTL, ['is-system-running'], { timeout: STEP_MS }, function (err2, out2) { cb(((out2 || '') + '').trim()); });
    });
}

function startTarget(t, cb) {
    cp.execFile(SYSTEMCTL, ['start', t.unit], { timeout: 30000 }, function (err) { cb(err); });
}

/* ---- the counter ---- */

function newArm(id, patch) { return { boot: id, at: Date.now(), patch: patch, crashes: 0, ran: false, confirmed: false, clean: false }; }

/* waze-on-cluster 0.7.5 and earlier wrote the arm as {boot, state:
 * unconfirmed|confirmed|clean}; a unit updated mid-boot still holds one. */
function normArm(a) {
    if (!a || typeof a !== 'object') return null;
    return { boot: a.boot, at: a.at || 0, patch: a.patch || 'unknown', crashes: a.crashes || 0, ran: !!a.ran, confirmed: !!(a.confirmed || a.state === 'confirmed'),
        clean: !!(a.clean || a.state === 'clean') };
}

function Recovery(opts) {
    opts = opts || {};
    var t = this.target = opts.target || TARGETS.carplay;
    this.statePath = t.state;
    this.healthyMs = opts.healthyMs || HEALTHY_MS;
    this.bootId = opts.bootId || boot.bootId();
    this._restore = opts.restore || function (fails, cb) { restoreTarget(t, false, fails, cb); };
    this._repairModes = opts.repairModes || function (cb) { repairModes(t, 0, cb); };
    this._probe = opts.probe || function (cb) { probeTarget(t, cb); };
    this._systemState = opts.systemState || realSystemState;
    this._start = opts.start || function (cb) { startTarget(t, cb); };
    this._alive = opts.alive || function (pid) { return exists(path.join(PROC, String(pid))); };
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
    this._roTry = -Infinity;
    this._activeSince = null;   /* start of the current continuous-active run */
    this._settled = null;       /* the run whose healthy minute needs nothing more */
    this._startAt = null;       /* when the scheduled start is due */
    /* This boot's ended run, crashes and starts, also kept here so a state
     * file that cannot be written neither repeats a crash nor lifts the start
     * limit; the larger of memory and disk counts. */
    this._ended = '';
    this._crashes = 0;
    this._starts = 0;
    /* Marked failed in this process, also when the state cannot be written. */
    this._failed = false;
}

/* The failed mark: {since, boot, fails, why}, or null when not failed. */
function normFailed(f) {
    if (!f || typeof f !== 'object') return null;
    return { since: f.since || null, boot: f.boot || null, fails: f.fails || 0, why: typeof f.why === 'string' ? f.why : '' };
}

/* What patchd reports for the failed mark: the reason text, or '' when the
 * tool is not marked failed (or the state cannot be read). */
function failedReason(statePath) {
    try { return failedText(normFailed(JSON.parse(fs.readFileSync(statePath || TARGETS.carplay.state, 'utf8')).failed)); } catch (e) { return ''; }
}

function failedText(f) {
    if (!f) return '';
    return 'carplay crashed ' + f.fails + ' times with the map patch and cannot be restored automatically' + (f.why ? ' (' + f.why + ')' : '') +
        '; it is not started again by this tool after a crash. Keep the phone unplugged and restore carplay by hand (PATCH.md, Boot recovery)';
}

/* read: the state file was read, or there is none. */
Recovery.prototype._load = function () {
    var read = false;
    try {
        var st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        /* A state without unknown is 0.8.1's or older, counted by other
         * rules: its counts start again. */
        var legacy = !!st && typeof st === 'object' && !('unknown' in st);
        if (st && typeof st === 'object') return { fails: legacy ? 0 : st.fails || 0, unknown: legacy ? 0 : st.unknown || 0, arm: normArm(st.arm),
            prev: normArm(st.prev), starts: st.starts || null, ended: st.ended || null, failed: normFailed(st.failed), read: true };
    } catch (e) { read = e.code === 'ENOENT'; }
    return { fails: 0, unknown: 0, arm: null, prev: null, starts: null, ended: null, failed: null, read: read };
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
            fs.writeFileSync(fd, JSON.stringify({ fails: st.fails || 0, unknown: st.unknown || 0, arm: st.arm || null, prev: st.prev || null, starts: st.starts || null, ended: st.ended || null, failed: st.failed || null }) + '\n');
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, this.statePath);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        this._log('could not persist state: ' + e.message);
        this._saveError = e.code;
        return false;
    }
    /* The state is written; a folder that cannot be synced (a file system
     * without it) leaves only the rename's timing open. */
    try { fsyncPath(dir); } catch (e) { this._log('could not sync ' + dir + ': ' + e.message); }
    return true;
};

Recovery.prototype._armed = function (st) { return !!st.arm && st.arm.boot === this.bootId; };
Recovery.prototype._thisBoot = function (rec) { return !!rec && rec.boot === this.bootId; };

/* The boot-time decision. First an original that lacks the access its
 * service's user needs gets its mode and owner back (repairModes). Then, on
 * a head unit that refuses our parts (head_unit.js), restore a patch of
 * ours at once; otherwise count the previous armed boot, arm this one when
 * its binary is a patch of ours, and restore at the threshold, or when this
 * boot's arm could not be saved. Also run by the watcher at its start,
 * where it counts nothing twice and retries a restore the boot step did not
 * finish. cb(result) for tests; result.action is 'idle' | 'armed' |
 * 'restored' | 'restore-failed' | 'stopped' (a stop came during the mode
 * repair), and result.repaired the files whose mode and owner were set. */
Recovery.prototype.startBoot = function (cb) {
    cb = cb || function () {};
    var self = this;
    /* Android Auto off (S6): nothing of aapd's is read, written or remounted. */
    if (off(this.target)) {
        this._log(this.target.name + ' is off (' + aaSwitch.OFF_REASON + '): nothing checked');
        cb({ action: 'idle' });
        return;
    }
    /* First, whatever the count or the patch: an original that lacks the
     * access its service's user needs gets its mode and owner back. A stop
     * meanwhile waits for it, as for a restore (whenRestored), and nothing
     * more is decided. */
    this.restoring = true;
    /* A guard left by a write window that could not put / back read-only
     * (roGuard): cleared when / is read-only, else nothing is written. */
    roGuard(function (standing) {
        if (standing) {
            self.restoring = false;
            self._log('ERROR: ' + self.target.name + ': ' + roFailedError(standing).message);
            self._restored.splice(0).forEach(function (f) { f(); });
            cb({ action: 'ro-failed', roFailed: true, error: standing });
            return;
        }
        self._repairModes(function (err, n) {
            self.restoring = false;
            if (err) self._log(self.target.name + ': setting its original\'s mode and owner failed: ' + err.message);
            var stops = self._restored.splice(0);
            if (stops.length) { stops.forEach(function (f) { f(); }); cb({ action: 'stopped', repaired: n || undefined }); return; }
            self._decide(function (r) { if (n) r.repaired = n; cb(r); });
        });
    });
};

Recovery.prototype._decide = function (cb) {
    var t = this.target, st = this._load(), tallied = false, refused = headUnit.refused();
    if (refused) {
        /* A head unit that refuses our parts: a patch of ours goes, whatever
         * the count; nothing is armed. */
        var k = patchKind(t);
        /* No backup of ours: nothing to restore, as before the failed mark. */
        if (k === 'none' || !hasBackup(t) || (k === 'original' && !leftover(t))) { cb({ action: 'idle' }); return; }
        this._restoreWith(st.fails, true, cb, refused);
        return;
    }
    if (st.arm && !this._armed(st)) {
        var was = st.fails, r = tally(st, st.arm, endOf(t, st.arm));
        st.fails = r.fails;
        st.unknown = r.unknown;
        st.prev = st.arm;
        st.arm = null;
        tallied = true;
        this._log(t.name + ': failed patched boots and crashes ' + st.fails + ' (was ' + was + '): the last patched boot ' + r.why +
            (st.unknown ? '; 1 boot with no record' : ''));
    }
    var kind = patchKind(t);
    /* Marked failed and restored by hand: the patch record no longer describes
     * the file (a new one), and the backup that failed its check is beside it.
     * The binary holding the original the backup's record names is stock. */
    if (st.failed && t.failedMark && kind !== 'none' && kind !== 'original' && holdsRecordedOriginal(t)) kind = 'original';
    if (kind === 'none' || kind === 'original') {
        /* The binary is stock again (by hand, a firmware update, Disable): the
         * failed mark, if any, is stale. */
        if (tallied || st.fails || st.unknown || st.arm || st.failed) { st.fails = 0; st.unknown = 0; st.arm = null; st.failed = null; this._failed = false; this._save(st); }
        cb({ action: 'idle' });
        return;
    }
    /* Below the threshold again (carplay ran healthy): no longer failed. */
    if (st.failed && st.fails < THRESHOLD[kind]) { st.failed = null; this._failed = false; }
    if (st.failed) this._log('ERROR: ' + t.name + ' is marked FAILED since ' + st.failed.since + ': ' + failedText(st.failed));
    if (!st.arm) st.arm = newArm(this.bootId, kind);
    var saved = this._save(st);
    if (saved && st.fails < THRESHOLD[kind]) { cb({ action: 'armed', patch: kind, fails: st.fails }); return; }
    this._restoreWith(st.fails, saved, cb);
};

/* Restore at the threshold, (saved false) because the count could not be
 * saved, or (refused: why) on a head unit that refuses our parts; the
 * counter clears once the binary is not ours to protect. */
Recovery.prototype._restoreWith = function (fails, saved, cb, refused) {
    var self = this, n = this.target.name, t0 = this._now();
    this._log(refused ? refused + '; restoring the original ' + n
        : saved ? 'restoring the original ' + n + ' after ' + fails + ' failed patched boots or crashes'
        : 'restoring the original ' + n + ': the boot-recovery state cannot be saved');
    this.restoring = true;
    this._restore(fails, function (err, outcome) {
        self.restoring = false;
        var r;
        if (err) {
            /* The counter stays, so the next start tries again. */
            self._log('boot recovery restore failed: ' + err.message + '; ' + n + ' starts as it is');
            r = { action: 'restore-failed', fails: fails, error: err.message };
            if (err.roFailed) r.roFailed = true;
            /* Patched, crashing, and no backup can ever restore it (S4). */
            if (err.unavailable && self.target.failedMark && !refused) { self._markFailed(fails, err.message); r.failed = true; }
        } else {
            self._log(outcome === 'restored' ? 'restored the original ' + n + ' in ' + Math.round(self._now() - t0) + ' ms; its patch is off until its Patch button applies it'
                : outcome === 'other' ? n + ' is another build than our backup (a firmware update): not ours to restore'
                : n + ' is the original already');
            self._clear();
            r = outcome === 'restored' ? { action: 'restored', fails: fails } : { action: 'idle' };
        }
        cb(r);
        self._restored.splice(0).forEach(function (f) { f(); });
    });
};

/* Patched, crashing, and no backup can restore it: carplay is left as it is
 * (writing anything else over it, or stopping or masking it, could leave the
 * head unit worse off than a crashing CarPlay), and the mark is written to the
 * state file for patchd's status. */
Recovery.prototype._markFailed = function (fails, why) {
    var st = this._load();
    if (!st.failed) st.failed = { since: new Date().toISOString(), boot: this.bootId, fails: fails, why: why || '' };
    else st.failed.fails = Math.max(st.failed.fails, fails);
    this._failed = true;
    if (!this._save(st)) this._log('could not persist the failed mark; it holds until this process ends');
    this._log('ERROR: ' + this.target.name + ' is marked FAILED: it crashed ' + fails + ' times while patched and no backup can restore it (' + why +
        '). It is left as it is and not started again by this tool after a crash. Keep the phone unplugged and restore ' + this.target.name +
        ' by hand (PATCH.md, Boot recovery)');
};

Recovery.prototype._clear = function () {
    var st = this._load();
    st.fails = 0;
    st.unknown = 0;
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

/* One watcher poll. A run of the service is told by its InvocationID. While
 * a run is active a tick only checks that its main PID is in /proc, and asks
 * systemctl every ALIVE_PROBE_MS or once the PID is gone; while the service
 * is down it asks every PROBE_MS. A run that ended failed (Result not success)
 * is a crash, once per run, unless patchd killed it to activate a change or
 * the system is stopping. A run a SIGKILL ended as a success (the tool's
 * carplay.service drop-in, SuccessExitStatus=SIGKILL) is no crash; unless
 * patchd killed it, which starts it itself, the service is started again
 * like after a crash. A run continuously active for HEALTHY_MS confirms the
 * boot. cb(result) for tests; result.action is 'skip' | 'watch' |
 * 'confirmed' | 'crash' | 'killed' | 'started' | 'start-skipped'. */
Recovery.prototype.tick = function (cb) {
    cb = cb || function () {};
    var self = this;
    if (this._busy || this.restoring || off(this.target)) { cb({ action: 'skip' }); return; }
    var now = this._now();
    /* A standing ro-failed guard is retried here, once per PROBE_MS. */
    if (roFailed !== null && now - this._roTry >= PROBE_MS) {
        this._roTry = now;
        this._busy = true;
        roGuard(function () { self._busy = false; cb({ action: 'ro-retry' }); });
        return;
    }
    if (this._startAt !== null && now >= this._startAt) { this._startDue(cb); return; }
    var fresh = now - this._lastProbe < (this._pid ? ALIVE_PROBE_MS : PROBE_MS);
    if (fresh && (!this._pid || this._alive(this._pid))) { cb({ action: this._healthy(now) }); return; }
    this._busy = true;
    this._probe(function (info) {
        self._lastProbe = now;
        if (info.state === 'active') {
            if (info.run !== self._run) { self._run = info.run; self._activeSince = now; self._ran(); }
            self._pid = info.pid;
        } else {
            self._run = '';
            self._pid = 0;
            self._activeSince = null;
        }
        var killed = self.target.killedRun(info);
        var ended = !killed && (info.state === 'failed' || (info.state === 'inactive' && !!info.result && info.result !== 'success'));
        if (!(ended || killed) || !info.run || self._handled(info.run)) { self._busy = false; cb({ action: self._healthy(now) }); return; }
        self._markHandled(info.run);
        if (info.run === readText(self.target.killed).trim()) { self._busy = false; cb({ action: 'watch' }); return; }
        self._systemState(function (sys) {
            /* An end while the head unit shuts down, its mark already written, is no crash. */
            if (sys === 'stopping' || markOf(self.target, self.bootId)) { self._busy = false; cb({ action: 'watch' }); return; }
            if (killed) { self._onKill(info, cb); return; }   /* a SIGKILL that was not patchd's (_onKill) */
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

Recovery.prototype._ran = function () {
    var st = this._load();
    if (this._armed(st) && !st.arm.ran) { st.arm.ran = true; this._save(st); }
};

/* A run's healthy minute confirms this boot's arm once. Only the watcher
 * changes the arm once the run is up, so after the state was read (or the
 * confirmation saved) the run needs no more reads. */
Recovery.prototype._healthy = function (now) {
    if (this._activeSince === null || now - this._activeSince < this.healthyMs || this._settled === this._run) return 'watch';
    var st = this._load();
    if (this._armed(st) && !st.arm.confirmed) {
        st.arm.confirmed = true;
        if (this._save(st)) this._settled = this._run;
        this._log(this.target.name + ' healthy');
        return 'confirmed';
    }
    if (st.read) this._settled = this._run;
    return 'watch';
};

/* A crash: recorded at once (the next moment can be a reboot), and a patch
 * restored at once when the record could not be saved, unless /var/opt is
 * read-only: var-opt-ro.service made it so, the head unit is going down and
 * its shutdown mark holds this end. Without recmgr's entry nothing more is
 * done here: the boot step counts it and restores at the next start. With
 * it, a patch is restored at the threshold, then the service is started
 * again. */
Recovery.prototype._onCrash = function (info, cb) {
    var self = this, t = this.target, saved = true, loaded = this._recmgrLoaded(t.name);
    function done(extra) { self._busy = false; cb(Object.assign({ action: 'crash' }, extra)); }
    function next(extra) { if (loaded) self._scheduleStart(); done(extra); }
    function goingDown() {
        if (saved || self._saveError !== 'EROFS') return false;
        self._log('/var/opt is read-only: the head unit is going down; the boot step counts this at the next start');
        done({ fails: st.fails + self._crashes });
        return true;
    }
    this._log(t.name + ' (run ' + info.run + ') ended: ' + info.result);
    this._crashes++;
    var st = this._load();
    if (this._armed(st)) { st.arm.crashes = Math.max(st.arm.crashes + 1, this._crashes); saved = this._save(st); }
    if (goingDown()) return;
    if (saved && !loaded) {
        this._log('recmgr did not load a ' + t.name + ' entry this boot: the boot step decides at the next start');
        done({ fails: st.fails + this._crashes });
        return;
    }
    var kind = patchKind(t);
    if (kind === 'none' || kind === 'original') { this._clear(); next(); return; }
    if (!this._armed(st)) { st.arm = newArm(this.bootId, kind); st.arm.crashes = this._crashes; saved = this._save(st); }
    if (goingDown()) return;
    var total = st.fails + Math.max(st.arm.crashes, this._crashes);
    this._log(t.name + ' crashes while patched: ' + total);
    if (saved && total < THRESHOLD[kind]) { next({ fails: total }); return; }
    this._restoreWith(total, saved, function (r) { next({ fails: total, restore: r.action }); });
};

/* A SIGKILL that was not patchd's (the OOM killer, a shell): the service is
 * started again where recmgr loaded its entry (without it, recmgr restarts
 * the head unit for the exit). */
Recovery.prototype._onKill = function (info, cb) {
    this._log(this.target.name + ' (run ' + info.run + ') was killed');
    if (this._recmgrLoaded(this.target.name)) this._scheduleStart(true);
    this._busy = false;
    cb({ action: 'killed' });
};

Recovery.prototype._startsThisBoot = function () {
    var s = this._load().starts;
    return Math.max(this._thisBoot(s) ? s.n : 0, this._starts);
};

/* afterKill: the start follows a SIGKILL that was not patchd's. That is no
 * crash of the patch, so it is started again (bounded by START_DELAYS_MS per
 * boot) even while the patch is marked failed. After a crash, a failed
 * patch stays down: crashing, with no backup to restore it, carplay is not
 * started again by this tool. */
Recovery.prototype._scheduleStart = function (afterKill) {
    var marked = this._failed || !!this._load().failed;
    if (marked && afterKill) {
        this._log(this.target.name + ' was killed while its patch is marked failed: starting it again (bounded per boot), the kill was not a crash of the patch');
    } else if (marked) {
        this._log(this.target.name + ' stays down: its patch is marked failed (crashing, no backup restores it); restore it by hand');
        return;
    }
    var n = this._startsThisBoot();
    if (n >= START_DELAYS_MS.length) {
        this._log(this.target.name + ' stays down: started ' + n + ' times this boot already');
        return;
    }
    this._startAt = this._now() + START_DELAYS_MS[n];
};

/* The scheduled start: only while the service is down, the system is not
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
            self._log('starting ' + self.target.name + ' (start ' + n + ' this boot)');
            self._start(function (err) {
                self._lock.release();
                if (err) self._log('starting ' + self.target.name + ' failed: ' + err.message);
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
    if (off(this.target)) { cb(); return; }
    var st = this._load();
    if (!this._armed(st) || st.arm.crashes || this._crashes || st.arm.clean) { cb(); return; }
    this._systemState(function (sys) {
        if (sys === 'stopping') { st.arm.clean = true; self._save(st); }
        self._log(self.target.name + ': stopped while the system is ' + (sys || 'unknown') + (sys === 'stopping' ? ': this start ended in order' : ''));
        cb();
    });
};

module.exports = {
    Recovery: Recovery, tally: tally, parseShow: parseShow, targets: targets, TARGETS: TARGETS, THRESHOLD: THRESHOLD,
    RESTORE_BOUND_MS: RESTORE_BOUND_MS, BOOT_BOUND_MS: BOOT_BOUND_MS, BOOT_EXIT_MS: BOOT_EXIT_MS, restoreTarget: restoreTarget, repairModes: repairModes,
    realSystemState: realSystemState, failedReason: failedReason, roGuard: roGuard,
};

/* ---- run as the boot step or the watcher ---- */

/* The boot step for one service (`recovery.js boot [carplay|aapd]`) exits by
 * BOOT_EXIT_MS at the latest, a restore cut short after tries to put / back
 * read-only: 0, or 1 while a ro-failed guard stands (/ not verified read-only).
 * The unit runs it with ExecStart=-, so the service's start never waits on its failure. Nothing runs the service before it, so the restore links
 * the patched binary only if a process runs it. */
function runBoot(name) {
    var t = TARGETS[name || 'carplay'];
    if (!t) { log('unknown service ' + name); process.exit(0); }
    /* Android Auto off (S6): leave before anything of aapd's is read. */
    if (off(t)) { log(t.name + ' boot check: off (' + aaSwitch.OFF_REASON + '); nothing checked'); process.exit(0); }
    /* The exit status: 0, or 1 while a ro-failed guard stands (/ may be
     * writable; the lock and <lock>.ro-failed are kept, see holdRoFailed).
     * The service's unit runs this with ExecStart=-, so the status changes
     * no ordering; it is the terminal failure the journal shows. */
    function exitWith(settled) {
        if (settled) process.exit(0);
        var why = roStanding();
        log('ERROR: ' + t.name + ' boot check failed: / is not verified read-only (' + (why !== null ? 'ro-failed: ' + why : 'read-write, or the remount lock is held by another process') +
            '); any guard and lock are kept and nothing writes / until it is read-only again; exiting 1');
        process.exit(1);
    }
    /* The step ends by verifying / read-only (F1 of fix3-p): never by the mere absence of a guard. */
    var leaving = false;
    function leave() {
        if (leaving) return;
        leaving = true;
        settleRo(exitWith);
    }
    setTimeout(function () {
        log(t.name + ' boot check: out of time after ' + BOOT_BOUND_MS + ' ms; ' + t.name + ' starts as it is');
        setTimeout(function () {
            if (writing && roFailed === null) holdRoFailed('the boot step ran out of time and its remount,ro did not return');
            exitWith(roSettled());   /* the hard deadline: no more waiting */
        }, BOOT_EXIT_MS - BOOT_BOUND_MS).unref();
        abandonRestore(leave);
    }, BOOT_BOUND_MS).unref();
    var t0 = monoMs();
    var rec = new Recovery({ target: t, restore: function (fails, cb) { restoreTarget(t, true, fails, cb, BOOT_LOCK_WAIT_MS); },
        repairModes: function (cb) { repairModes(t, BOOT_LOCK_WAIT_MS, cb); } });
    rec.startBoot(function (r) {
        log(t.name + ' boot check: ' + r.action + (r.patch ? ' (' + r.patch + ' patch, ' + r.fails + ' failed)' : '') +
            (r.repaired ? ', mode and owner set on ' + r.repaired + ' file' + (r.repaired === 1 ? '' : 's') : '') +
            ' in ' + Math.round(monoMs() - t0) + ' ms, ' + Math.round(process.uptime() * 1000) + ' ms since node started');
        leave();
    });
    /* A stop mid-restore lets the restore finish (it exits then). */
    process.on('SIGTERM', function () { rec.whenRestored(leave); });
}

/* The watcher follows carplay, and aapd where the unit has it; each has its
 * own counter and acts alone. */
function runWatcher() {
    var recs = [new Recovery({ target: TARGETS.carplay })];
    /* aapd only when the owner turned Android Auto on (S6): with it off its
     * paths are not even looked at. */
    if (!off(TARGETS.aapd) && exists(TARGETS.aapd.target)) recs.push(new Recovery({ target: TARGETS.aapd }));
    else if (off(TARGETS.aapd)) log('aapd is off (' + aaSwitch.OFF_REASON + '): not watched');
    var timer = null;
    var starting = recs.length;
    var stopping = false;
    function each(fn, cb) {
        var left = recs.length;
        recs.forEach(function (r) { fn(r, function () { if (--left === 0) cb(); }); });
    }
    /* A stop waits for a restore in progress, so / is not left writable. */
    function finish() {
        if (timer) clearInterval(timer);
        each(function (r, cb) { r.whenRestored(function () { r.onShutdown(cb); }); }, function () { process.exit(0); });
    }
    recs.forEach(function (r) {
        r.startBoot(function () {
            if (--starting) return;
            if (stopping) { finish(); return; }
            /* Polled even with no patch to watch: the service stays up, since
             * Restart=always would otherwise start it again every few seconds
             * and the deploy tool's health check takes that for a crash loop. */
            timer = setInterval(function () { recs.forEach(function (x) { x.tick(); }); }, TICK_MS);
        });
    });
    function stop() { if (stopping) return; stopping = true; if (!starting) finish(); }   /* else finish() runs when startBoot returns */
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

if (require.main === module) {
    if (process.argv[2] === 'boot') runBoot(process.argv[3]);
    else runWatcher();
}
