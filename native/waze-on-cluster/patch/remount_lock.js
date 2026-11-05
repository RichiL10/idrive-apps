// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* A single advisory lock shared by patchd and the boot-recovery service so the
 * two never remount / read-write and rewrite /usr/bin/carplay at the same time.
 * Holding it around a remount-rw -> write -> remount-ro window keeps a
 * concurrent operation from writing while the other has already put / back to
 * read-only, which would fail the write and could leave / writable.
 *
 * The lock is a file created with O_EXCL in the socket directory (tmpfs,
 * cleared each boot), holding the holder's pid. A lock is broken only when
 * that pid is gone (a killed holder), so a holder that works longer than
 * expected keeps it, up to HUNG_MS (10 min), after which a live holder is
 * taken as hung; a lock with no readable pid is broken once older than
 * STALE_MS. Nobody writes without it: patchd (user-driven)
 * waits and then refuses the operation, nothing changed, so the user retries
 * once the holder is done; recovery (automatic) yields: its restore reports
 * a failure and keeps the counter, so the next boot retries.
 * (Kiro test change, S2: upstream broke ANY lock older than STALE_MS without
 * looking at the pid, so a slow but live holder lost it to a second writer.
 * Breaking is serialised by a second O_EXCL file, <lock>.break, and the lock
 * is read again under it, so two waiters cannot both break one dead lock.)
 *
 * inUse(file) is whether a process runs file (a /proc/<pid>/exe is its
 * inode): such a file, once replaced, has to stay linked for / to go
 * read-only again. holds(link, target) is whether link keeps such a
 * replaced binary: a process runs it and it is not target's own file
 * (which target keeps linked).
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');

var LOCK = process.env.WOC_REMOUNT_LOCK || '/dev/shm/waze-on-cluster/remount.lock';
var STALE_MS = parseInt(process.env.WOC_REMOUNT_LOCK_STALE_MS, 10) || 120000;
/* A holder that is alive but has held the lock this long is hung (patchd's
 * longest hold, every timeout spent, is a few minutes): its lock is broken
 * too, so a stuck patchd cannot keep recovery from restoring CarPlay until
 * the next boot. */
var HUNG_MS = parseInt(process.env.WOC_REMOUNT_LOCK_HUNG_MS, 10) || 600000;

function ensureDir(dir) {
    try { fs.mkdirSync(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function tryAcquire() {
    var fd;
    try {
        fd = fs.openSync(LOCK, 'wx');
        var id = startId(process.pid);   /* read once, here: a recycled pid is told from the holder by it (R3-2) */
        fs.writeSync(fd, process.pid + ' ' + new Date().toISOString() + (id ? ' ' + id : '') + '\n');
        fs.closeSync(fd);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT') { try { ensureDir(path.dirname(LOCK)); } catch (e2) { return false; } return tryAcquire(); }
        if (e.code !== 'EEXIST') return false;
        try {
            var seen = fs.readFileSync(LOCK, 'utf8');
            if (breakable(seen) && breakDead(seen)) return tryAcquire();
        } catch (e3) {}
        return false;
    }
}

/* Whether the lock a process read (text) is one to break: its holder is gone,
 * or it holds no pid and is older than STALE_MS, or it is older than HUNG_MS. */
function breakable(text) {
    var gone = holderGone(text);
    var age = Date.now() - fs.statSync(LOCK).mtime.getTime();
    /* A live holder that keeps the lock with the ro-failed guard (this process, or the one the
     * marker names) is never taken as hung: its lock is the guard's (review of fix4-p, B). */
    if (gone === false && parseInt(text.split(' ')[0], 10) === guardOwnerPid()) return false;
    return gone === true || (gone === null && age > STALE_MS) || age > HUNG_MS;
}

/* Breaking is check-then-act, so two waiters that both read the same dead lock
 * could each unlink it in turn: the second one would delete the first one's NEW
 * lock and both would write at once. Breakers are therefore serialised by a
 * second O_EXCL file, and under it the lock is read again: it is unlinked only
 * if it is still the very lock that was judged dead. (Kiro test change, S2.)
 * Returns true when the lock was removed by this call. */
var BREAK_STALE_MS = 10000;
function breakDead(seen) {
    var guard = LOCK + '.break';
    var fd;
    try { fd = fs.openSync(guard, 'wx'); } catch (e) {
        /* Another breaker is at work; a guard left by a breaker that died is old. */
        try { if (Date.now() - fs.statSync(guard).mtime.getTime() > BREAK_STALE_MS) fs.unlinkSync(guard); } catch (e2) {}
        return false;
    }
    try {
        fs.closeSync(fd);
        var now = fs.readFileSync(LOCK, 'utf8');
        if (now !== seen || !breakable(now)) return false;   /* replaced or taken since: not ours to break */
        if (holderGone(now) === false)
            console.error('remount lock: holder alive but holding for ' + Math.round((Date.now() - fs.statSync(LOCK).mtime.getTime()) / 1000) + ' s, taken as hung, lock broken');
        fs.unlinkSync(LOCK);
        return true;
    } catch (e3) {
        return false;
    } finally {
        try { fs.unlinkSync(guard); } catch (e4) {}
    }
}

/* Whether the process a lock file names is gone: true (no such process, or the pid now belongs to another one), false
 * (it runs, or exists and is not ours to signal: EPERM), null (no pid in it,
 * e.g. a holder that has created the file and not written it yet). */
function holderGone(text) {
    var f = (text || '').trim().split(' ');
    var pid = parseInt(f[0], 10);
    if (!(pid > 0)) return null;
    try { process.kill(pid, 0); } catch (e) { return e.code === 'ESRCH'; }
    /* The pid runs. A lock that carries the holder's start time (field 22 of /proc/<pid>/stat, written at
     * acquire) names that process only while the start time still matches: another process on a recycled
     * pid, which shows a different readable start time, is not the holder (R3-2); an unreadable start time proves nothing.
     * A lock without it (older, or the start time was unreadable at acquire) is judged by the pid alone. */
    var id = /^\d+$/.test(f[2] || '') ? f[2] : '';
    if (id) {
        var now = startId(pid);
        /* Only a start time that can be read and differs proves a recycled pid. A read that fails (permission,
         * transient /proc error) proves nothing: the pid runs, so it stays the holder (fail closed, no second writer). */
        if (now !== '' && now !== id) return true;
    }
    return false;
}

/* Field 22 (starttime) of /proc/<pid>/stat; '' when it cannot be read. WOC_LOCK_PROC is read at each call (tests). */
function startId(pid) {
    try {
        var s = fs.readFileSync(path.join(process.env.WOC_LOCK_PROC || '/proc', String(pid), 'stat'), 'utf8');
        var rest = s.slice(s.lastIndexOf(')') + 2).split(' ');   /* rest[0] is field 3 (state) */
        return /^\d+$/.test(rest[19]) ? rest[19] : '';
    } catch (e) { return ''; }
}

/* acquire within timeoutMs, polling; cb(true) on success, cb(false) on timeout. */
function acquire(timeoutMs, cb) {
    var deadline = Date.now() + timeoutMs;
    (function attempt() {
        if (tryAcquire()) { cb(true); return; }
        if (Date.now() >= deadline) { cb(false); return; }
        setTimeout(attempt, 100);
    })();
}

/* Release only a lock this process holds, so a process that gave up waiting
 * cannot delete the holder's lock. */
function release() {
    try {
        if ((fs.readFileSync(LOCK, 'utf8').split(' ')[0] || '') === String(process.pid)) fs.unlinkSync(LOCK);
    } catch (e) {}
}

/* The ro-failed guard (Kiro test build, review of fix-p). A writer that could
 * not put / back read-only must not hand / to the next writer: it keeps the
 * lock and writes <lock>.ro-failed ("pid time reason"), which outlives the
 * writer (the lock goes with a dead holder, and with a live one after
 * HUNG_MS). While the marker stands no writer takes the lock
 * (tryAcquireWrite, acquireWrite); readers and plain tryAcquire (a service
 * start) are not held back. The marker is in the socket directory (tmpfs,
 * cleared each boot) and clears when a run verifies / read-only: healRo
 * below, or by hand (`mount -o remount,ro /`, then any run of patchd or
 * recovery clears it, or delete the file).
 * The marker is only a message to the other processes, never the only
 * safeguard (review of fix3-p, F3): markRoFailed also keeps the reason in
 * this process (memRoFailed), so a marker that cannot be written (tmpfs full,
 * I/O error) still stops this process's writers and keeps its lock; and a
 * writer that took the lock verifies / read-only itself before it remounts
 * read-write (acquireWrite with `ro`, verifyRo), so a lock broken from a dead
 * holder that left / writable, with or without a marker, is never written past. */
var RO_FAILED = LOCK + '.ro-failed';
var memRoFailed = null;
function roFailedReason() {
    if (memRoFailed !== null) return memRoFailed;
    try {
        var t = fs.readFileSync(RO_FAILED, 'utf8').trim().split(' ');
        return t.slice(2).join(' ') || 'ro-failed';
    } catch (e) { return null; }
}
/* The guard stands in this process whatever the marker write does. Returns
 * whether the marker file was written; false is a distinct failure the caller
 * logs (the other processes then rely on verifying / themselves). */
function markRoFailed(reason) {
    reason = String(reason || 'ro-failed').replace(/\s+/g, ' ');
    memRoFailed = reason;
    try { ensureDir(path.dirname(LOCK)); } catch (e) {}
    try { fs.writeFileSync(RO_FAILED, process.pid + ' ' + new Date().toISOString() + ' ' + reason + '\n'); return true; }
    catch (e) { return false; }
}
/* The pid that set the standing guard: this process (memRoFailed), else the marker's; 0 when none. */
function guardOwnerPid() {
    if (memRoFailed !== null) return process.pid;
    try { return parseInt(fs.readFileSync(RO_FAILED, 'utf8').split(' ')[0], 10) || 0; } catch (e) { return 0; }
}
function clearRoFailed() { memRoFailed = null; try { fs.unlinkSync(RO_FAILED); } catch (e) {} }
function ownsLock() {
    try { return (fs.readFileSync(LOCK, 'utf8').split(' ')[0] || '') === String(process.pid); } catch (e) { return false; }
}
/* tryAcquire for a writer: false while the ro-failed marker stands (and the
 * lock is let go again if it was taken a moment before the marker). */
function tryAcquireWrite() {
    if (!tryAcquire()) return false;
    if (roFailedReason() !== null) { release(); return false; }
    return true;
}
/* With the lock held by this process: / is read-only per ro.isRo(), else
 * ro.remountRo(done) is tried and checked again; cb(null) once it is, else the
 * guard is set (markRoFailed) with the lock kept, and cb(why). */
function verifyRo(ro, cb) {
    if (ro.isRo()) { cb(null); return; }
    ro.remountRo(function () {
        if (ro.isRo()) { cb(null); return; }
        var why = '/ is read-write when the remount lock was taken, and remount,ro did not take it back';
        markRoFailed(why);
        cb(why);
    });
}
/* acquire for a writer: cb(true), or cb(false, why): why is the marker's
 * reason, null when the lock was only busy. With ro ({ isRo, remountRo }) the
 * writer has verified / read-only under the lock before cb(true); when it
 * could not, cb(false, why) with the guard set and the lock KEPT (held by
 * this process, see markRoFailed). */
function acquireWrite(timeoutMs, cb, ro) {
    var deadline = Date.now() + timeoutMs;
    (function attempt() {
        if (tryAcquireWrite()) {
            if (!ro) { cb(true, null); return; }
            verifyRo(ro, function (why) { cb(why === null, why); });
            return;
        }
        var why = roFailedReason();
        if (why !== null || Date.now() >= deadline) { cb(false, why); return; }
        setTimeout(attempt, 100);
    })();
}
/* Try to clear a standing guard. why: the reason (the marker's, or this
 * process's own). isRo(): / is read-only per /proc/mounts. remountRo(done):
 * a bounded remount,ro, done(err). cb(null) once / is verified read-only (the
 * marker is gone and a lock this process held is released), else cb(why) with
 * the guard, and a lock this process held, left in place. A lock another live
 * process holds is not taken: cb(why). */
function healRo(why, isRo, remountRo, cb) {
    var mine = ownsLock();
    function cleared() {
        clearRoFailed();
        release();
        /* the lock a dead writer kept with the guard goes with it (breakDead re-checks that it is dead) */
        if (!mine) { try { var seen = fs.readFileSync(LOCK, 'utf8'); if (holderGone(seen) === true) breakDead(seen); } catch (e) {} }
        cb(null);
    }
    if (isRo()) { cleared(); return; }
    if (!mine && !tryAcquire()) { cb(why); return; }
    remountRo(function () {
        if (isRo()) { cleared(); return; }
        /* A lock taken here stays taken while / is not verified read-only: the guard stands, and the
         * lock is the guard's (review of fix4-p, A), marked with this pid; the next retry finds it. */
        if (!mine) markRoFailed(why);
        cb(why);
    });
}

var PROC = process.env.WOC_PROC || '/proc';
function inUse(file) {
    var st;
    try { st = fs.statSync(file); } catch (e) { return false; }
    var pids = [];
    try { pids = fs.readdirSync(PROC).filter(function (n) { return /^\d+$/.test(n); }); } catch (e) {}
    return pids.some(function (pid) {
        try { var x = fs.statSync(path.join(PROC, pid, 'exe')); return x.ino === st.ino && x.dev === st.dev; } catch (e) { return false; }
    });
}

function holds(link, target) {
    var a, b;
    try { a = fs.statSync(link); } catch (e) { return false; }
    try { b = fs.statSync(target); } catch (e) { b = null; }
    return !(b && a.ino === b.ino && a.dev === b.dev) && inUse(link);
}

module.exports = { acquire, release, tryAcquire, breakDead, inUse, holds, roFailedReason, markRoFailed, clearRoFailed, ownsLock,
    tryAcquireWrite, acquireWrite, healRo, verifyRo };
