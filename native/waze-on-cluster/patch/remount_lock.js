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
        fs.writeSync(fd, process.pid + ' ' + new Date().toISOString() + '\n');
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

/* Whether the pid a lock file names is gone: true (no such process), false
 * (it runs, or exists and is not ours to signal: EPERM), null (no pid in it,
 * e.g. a holder that has created the file and not written it yet). */
function holderGone(text) {
    var pid = parseInt((text || '').split(' ')[0], 10);
    if (!(pid > 0)) return null;
    try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
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

module.exports = { acquire, release, tryAcquire, breakDead, inUse, holds };
