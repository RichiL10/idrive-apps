// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* remount_lock.js: a lock names its holder by pid AND start time (field 22 of
 * /proc/<pid>/stat), so a dead holder whose pid was recycled by another
 * process is not taken for alive (review of fix5-p, R3-2). The /proc the lock
 * module reads for it is faked with WOC_LOCK_PROC. */
var fs = require('fs');
var os = require('os');
var path = require('path');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-lock-'));
var LOCKF = path.join(dir, 'remount.lock');
process.env.WOC_REMOUNT_LOCK = LOCKF;
var PROCDIR = path.join(dir, 'proc');
process.env.WOC_LOCK_PROC = PROCDIR;
var lock = require('../remount_lock.js');

var fails = 0;
function ok(name, cond, detail) {
    if (cond) process.stdout.write('ok ' + name + '\n');
    else { fails++; process.stdout.write('FAIL ' + name + (detail ? '  -- ' + detail : '') + '\n'); }
}

/* A /proc/<pid>/stat whose comm holds a ")" and a space, start time = start. */
function fakeStat(pid, start) {
    var d = path.join(PROCDIR, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'stat'), pid + ' (a b) c) S ' + new Array(19).join('0 ') + start + ' 0 0\n');
}
function clean() {
    [LOCKF, LOCKF + '.ro-failed', LOCKF + '.break'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
}
var OTHER = process.ppid;   /* a live process that is not this one */

/* the lock records this process's start time */
fakeStat(process.pid, '4242');
ok('acquire: the lock holds pid, time and the start time', lock.tryAcquire() && /^\d+ \S+ 4242\n$/.test(fs.readFileSync(LOCKF, 'utf8')) &&
    fs.readFileSync(LOCKF, 'utf8').split(' ')[0] === String(process.pid), fs.existsSync(LOCKF) ? fs.readFileSync(LOCKF, 'utf8') : 'no lock');
lock.release();
ok('release: removes it', !fs.existsSync(LOCKF));
fs.rmSync(path.join(PROCDIR, String(process.pid)), { recursive: true });
ok('acquire with no readable start time: the old format, pid and time', lock.tryAcquire() && /^\d+ \S+\n$/.test(fs.readFileSync(LOCKF, 'utf8')), fs.readFileSync(LOCKF, 'utf8'));
lock.release();

/* a dead holder whose pid another, unrelated process now has */
clean();
fakeStat(OTHER, '9000');
var DEAD = OTHER + ' 2020-01-01T00:00:00.000Z 1234\n';   /* the holder started at 1234; the pid now runs one started at 9000 */
fs.writeFileSync(LOCKF, DEAD);
ok('recycled pid: the lock is taken at once', lock.tryAcquire() && fs.readFileSync(LOCKF, 'utf8').split(' ')[0] === String(process.pid), fs.readFileSync(LOCKF, 'utf8'));
lock.release();

/* the same start time: the holder is alive, the lock stays */
fs.writeFileSync(LOCKF, OTHER + ' ' + new Date().toISOString() + ' 9000\n');
ok('same start time: a live holder keeps the lock', !lock.tryAcquire() && fs.readFileSync(LOCKF, 'utf8').split(' ')[0] === String(OTHER));

/* the start time of a live pid cannot be read: not the holder */
fs.rmSync(path.join(PROCDIR, String(OTHER)), { recursive: true });
fs.writeFileSync(LOCKF, OTHER + ' ' + new Date().toISOString() + ' 9000\n');
ok('start time unreadable for another pid: not the holder, the lock is taken', lock.tryAcquire() && fs.readFileSync(LOCKF, 'utf8').split(' ')[0] === String(process.pid));
lock.release();

/* a lock without a start time (older format) is judged by the pid alone, as before */
fs.writeFileSync(LOCKF, OTHER + ' ' + new Date().toISOString() + '\n');
ok('old format: a live pid keeps the lock', !lock.tryAcquire());

/* this process's own entry whose start time cannot be read is still this process */
fs.writeFileSync(LOCKF, process.pid + ' ' + new Date().toISOString() + ' 4242\n');
ok('own pid, start time unreadable: still the holder', lock.ownsLock() && !lock.tryAcquire());
clean();

/* the guard owner whose pid was recycled does not keep the lock either */
fakeStat(OTHER, '9000');
fs.writeFileSync(LOCKF, DEAD);
fs.writeFileSync(LOCKF + '.ro-failed', OTHER + ' 2020-01-01T00:00:00.000Z ro-failed test\n');
ok('guard owner on a recycled pid: the lock is breakable and taken', lock.tryAcquire() && fs.readFileSync(LOCKF, 'utf8').split(' ')[0] === String(process.pid));
lock.release();
var ro = false;
fs.writeFileSync(LOCKF, DEAD);
lock.healRo('ro-failed test', function () { return ro; }, function (done) { ro = true; done(); }, function (why) {
    ok('healRo takes the lock of a dead owner on a recycled pid and clears the guard', why === null && ro && !fs.existsSync(LOCKF) && !fs.existsSync(LOCKF + '.ro-failed'),
        String(why) + ' ' + fs.existsSync(LOCKF) + ' ' + fs.existsSync(LOCKF + '.ro-failed'));
    /* a guard owner that is alive (same start time) is still never broken */
    fs.writeFileSync(LOCKF, OTHER + ' 2020-01-01T00:00:00.000Z 9000\n');
    fs.writeFileSync(LOCKF + '.ro-failed', OTHER + ' 2020-01-01T00:00:00.000Z ro-failed test\n');
    ok('guard owner alive with the same start time: the lock is not broken, however old', !lock.tryAcquire());
    clean();
    try { fs.rmSync(dir, { recursive: true }); } catch (e) {}
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
