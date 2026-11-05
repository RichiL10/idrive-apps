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
 * looking at the pid, so a slow but live holder lost it to a second writer.)
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
            var gone = holderGone(fs.readFileSync(LOCK, 'utf8'));
            var age = Date.now() - fs.statSync(LOCK).mtime.getTime();
            if (gone === true || (gone === null && age > STALE_MS) || age > HUNG_MS) {
                if (gone === false)
                    console.error('remount lock: holder alive but holding for ' + Math.round(age / 1000) + ' s, taken as hung, lock broken');
                fs.unlinkSync(LOCK);
                return tryAcquire();
            }
        } catch (e3) {}
        return false;
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

module.exports = { acquire, release, tryAcquire, inUse, holds };
