#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Review of fix-p (Kiro test build): patchd keeps / from being left writable.
 *
 * F-P1: with carplay in both recmgr restart lists and the drop-in loaded (the
 * restartable path) the old inode of the running carplay is hard-linked as
 * carplay.woc-running BEFORE the new image replaces the file, so a restart that
 * fails (systemctl cannot show the unit) leaves a linked inode and
 * remount,ro succeeds; the link goes once nothing runs the old inode. When the
 * link cannot be made while a process runs the file, nothing is written.
 *
 * F-P3: a change whose remount,ro never takes keeps the remount lock and sets
 * the ro-failed guard (remount.lock.ro-failed): status reports an error, the
 * next change is refused, and it clears once / is read-only.
 *
 * Runs the real patchd.js and carplay_patch.js on a synthetic carplay build
 * (outside the proven list, so every apply carries the user's confirmation)
 * with a fake systemctl, a fake mount that refuses remount,ro while a process
 * runs an inode no name links (as the kernel does), a fake /proc and a dummy
 * process for carplay.
 *
 *   node patchd_ro_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit for every patcher and patchd this runs */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');
var synthetic = require('./synthetic_carplay.js');

var PATCHD = path.join(__dirname, '..', 'patchd.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  -- ' + detail : '') + '\n');
    if (!cond) fails++;
}

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-ro-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});

var SRC = synthetic.build({}).buf;
var TGT = path.join(dir, 'usr', 'carplay');
fs.mkdirSync(path.dirname(TGT));
fs.writeFileSync(TGT, SRC);
fs.chmodSync(TGT, 0o755);
var RUNNING = TGT + '.woc-running';
var MOUNTS = path.join(dir, 'mounts');
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
var MOUNT_LOG = path.join(dir, 'mount.log');
var STUCK = path.join(dir, 'ro-stuck');   /* while it exists, remount,ro answers 0 and changes nothing */
var CALLS = path.join(dir, 'systemctl.calls');
fs.writeFileSync(CALLS, '');
var SYSTEMD = path.join(dir, 'systemd.json');
var DROPIN = path.join(dir, 'carplay.service.d', '50-waze-on-cluster.conf');
var RECMGR = path.join(dir, 'recmgr-restartlist.conf');
var PROC_STAT = path.join(dir, 'stat');
var BOOT_S = Math.floor(Date.now() / 1000) - 60;
fs.writeFileSync(PROC_STAT, 'cpu  1 2 3\nbtime ' + BOOT_S + '\n');
fs.writeFileSync(RECMGR, '[Whitelist]\nHBAdasMgu\ncarplay\n[WhitelistExitSuccess]\nHBAdasMgu\ncarplay\n');
fs.utimesSync(RECMGR, BOOT_S - 3600, BOOT_S - 3600);   /* loaded at boot */
var PROC = path.join(dir, 'proc');
fs.mkdirSync(PROC);
/* carplay's process in a fake /proc: its exe holds the inode it runs. */
function runs(file, proc) {
    var p = path.join(proc || PROC, '4242');
    cp.execFileSync('rm', ['-rf', p]);
    fs.mkdirSync(p);
    fs.linkSync(file, path.join(p, 'exe'));
}
function noProc(proc) { cp.execFileSync('rm', ['-rf', path.join(proc || PROC, '4242')]); }

var BIN = path.join(dir, 'bin');
fs.mkdirSync(BIN);
/* mode: ok (the MainPID of the dummy, start works) | showfail (every `systemctl show -p MainPID` fails) */
fs.writeFileSync(path.join(BIN, 'systemctl'), '#!' + process.execPath + '\n' + [
    "var cp = require('child_process'), path = require('path'), fs = require('fs');",
    "var P = " + JSON.stringify(PROC) + ", T = " + JSON.stringify(TGT) + ", DROPIN = " + JSON.stringify(DROPIN) + ";",
    "var st = JSON.parse(fs.readFileSync(" + JSON.stringify(SYSTEMD) + ", 'utf8'));",
    "var a = process.argv.slice(2);",
    "fs.appendFileSync(" + JSON.stringify(CALLS) + ", a.join(' ') + '\\n');",
    "if (a[0] === 'show' && a.indexOf('DropInPaths') >= 0) process.stdout.write('DropInPaths=/run/other.conf ' + DROPIN + '\\n');",
    "else if (a[0] === 'show') {",
    "    if (st.mode === 'showfail') { process.stderr.write('Failed to connect to bus\\n'); process.exit(1); }",
    "    process.stdout.write('MainPID=' + st.pid + '\\nInvocationID=inv-' + st.pid + '\\nExecMainStartTimestampMonotonic=5\\n');",
    "} else if (a[0] === 'start') {",
    "    st.state = 'active'; fs.writeFileSync(" + JSON.stringify(SYSTEMD) + ", JSON.stringify(st));",
    "    cp.execFileSync('rm', ['-rf', path.join(P, '4242')]); fs.mkdirSync(path.join(P, '4242')); fs.linkSync(T, path.join(P, '4242', 'exe'));",
    "} else if (a[0] === 'is-active') { process.stdout.write(st.state + '\\n'); process.exit(st.state === 'active' ? 0 : 3); }",
].join('\n') + '\n');
fs.chmodSync(path.join(BIN, 'systemctl'), 0o755);
fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(BIN, 'journalctl'), 0o755);
/* remount,ro fails (busy) while a process runs a file no name links any more,
 * as the kernel refuses it; STUCK makes it do nothing at all. */
var MOUNT = path.join(dir, 'mount');
fs.writeFileSync(MOUNT, '#!' + process.execPath + '\n' + [
    "var fs = require('fs'), path = require('path');",
    "var a = process.argv.slice(2).join(' '), M = " + JSON.stringify(MOUNTS) + ";",
    "fs.appendFileSync(" + JSON.stringify(MOUNT_LOG) + ", a + '\\n');",
    "if (/remount,rw/.test(a)) fs.writeFileSync(M, '/dev/root / ext4 rw 0 0\\n');",
    "else if (/remount,ro/.test(a)) {",
    "    if (fs.existsSync(" + JSON.stringify(STUCK) + ")) process.exit(0);",
    "    [" + JSON.stringify(PROC) + "].forEach(function (P) {",
    "        var open = fs.readdirSync(P).some(function (p) { try { return fs.statSync(path.join(P, p, 'exe')).nlink <= 1; } catch (e) { return false; } });",
    "        if (open) { process.stderr.write('mount: / is busy\\n'); process.exit(32); }",
    "    });",
    "    fs.writeFileSync(M, '/dev/root / ext4 ro 0 0\\n');",
    "}",
].join('\n') + '\n');
fs.chmodSync(MOUNT, 0o755);

function setUnit(mode, pid) { fs.writeFileSync(SYSTEMD, JSON.stringify({ mode: mode, pid: pid || 0, state: 'active' })); }
function dummyCarplay() {
    var c = cp.spawn(process.execPath, ['-e', 'setInterval(function () {}, 1e6)'], { stdio: 'ignore' });
    children.push(c);
    c.died = new Promise(function (r) { c.on('exit', function (code, signal) { r(signal || code); }); });
    return c;
}
function diedWithin(c) { return Promise.race([c.died, sleep(5000).then(function () { return 'still running'; })]); }
var callsSeen = 0;
function newCalls() {
    var all = fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean);
    var fresh = all.slice(callsSeen);
    callsSeen = all.length;
    return fresh;
}
var mountSeen = 0;
function newMountCalls() {
    var all = fs.existsSync(MOUNT_LOG) ? fs.readFileSync(MOUNT_LOG, 'utf8').split('\n').filter(Boolean) : [];
    var fresh = all.slice(mountSeen);
    mountSeen = all.length;
    return fresh;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function roNow() { return /\bro\b/.test(fs.readFileSync(MOUNTS, 'utf8')); }
function ino(f) { try { return fs.statSync(f).ino; } catch (e) { return null; } }

function startPatchd(name, tgt, proc) {
    var sockDir = path.join(dir, name), sock = path.join(sockDir, 'patch.sock');
    var child = cp.spawn(process.execPath, [PATCHD], {
        env: Object.assign({}, process.env, {
            PATH: BIN + path.delimiter + process.env.PATH,
            WOC_PATCH_SOCK: sock,
            WOC_CARPLAY: tgt,
            WOC_MOUNT: MOUNT,
            WOC_PROC_MOUNTS: MOUNTS,
            WOC_RESTART_POLL_MS: '20',
            WOC_RECMGR_CONF: RECMGR,
            WOC_CARPLAY_DROPIN: DROPIN,
            WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
            WOC_PROC_STAT: PROC_STAT,
            WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
            WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
            WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
            WOC_DLT_RETRY_MS: '600000',
            WOC_REBOOT_CMD: path.join(dir, 'no-reboot'),
            WOC_STATE_DIR: path.join(dir, 'var-' + name),
            WOC_REMOUNT_LOCK: path.join(sockDir, 'remount.lock'),
            WOC_OP_LOCK_WAIT_MS: '1500',
            WOC_PROC: proc,
            WOC_RECOVERY_STATE: path.join(dir, 'boot-recovery-' + name + '.json'),
            WOC_TEST: '1',
            WOC_AA_ENABLED: '0',
        }),
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    children.push(child);
    return { child: child, sock: sock, lock: path.join(sockDir, 'remount.lock'), guard: path.join(sockDir, 'remount.lock.ro-failed') };
}

/* Connect, wait for the status patchd sends on connect, optionally send cmd,
 * and resolve to the first status message done(msg) accepts. */
function session(d, cmd, done) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(d.sock), buf = '', sent = !cmd;
        var timer = setTimeout(function () { c.destroy(); reject(new Error('timed out waiting on ' + JSON.stringify(cmd))); }, 30000);
        c.setEncoding('utf8');
        c.on('error', reject);
        c.on('data', function (data) {
            buf += data;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var m = JSON.parse(buf.slice(0, i));
                buf = buf.slice(i + 1);
                if (m.ev !== 'status') continue;
                if (!sent) { sent = true; c.write(JSON.stringify(cmd) + '\n'); continue; }
                if (done(m)) { clearTimeout(timer); c.destroy(); resolve(m); return; }
            }
        });
    });
}
function status(d) { return session(d, null, function (m) { return m.state !== 'busy'; }); }
function op(d, cmd) { return session(d, cmd, function (m) { return m.state === 'error' || m.carplay === 'restarted' || m.carplay === 'deferred'; }); }
var APPLY = { cmd: 'apply', panel: 'high', mode: 'avb', unproven: true };

async function main() {
    var d = startPatchd('sock', TGT, PROC);
    for (var i = 0; i < 200 && !fs.existsSync(d.sock); i++) await sleep(25);
    var r, calls, mcalls, dummy, oldIno;

    /* ---- F-P1: restartable, systemctl cannot show the unit, carplay runs the old inode ---- */
    runs(TGT);
    oldIno = ino(TGT);
    setUnit('showfail', 0);
    newCalls(); newMountCalls();
    r = await op(d, APPLY);
    calls = newCalls(); mcalls = newMountCalls();
    ok('F-P1 restart fails: apply reports the restart error, not a read-write /', r.state === 'error' && /reading MainPID failed/.test(r.reason || '') &&
        !/read-write|ro-failed/.test(r.reason || ''), JSON.stringify(r));
    ok('F-P1 restart fails: the change was written (new inode) and the old inode stays linked as carplay.woc-running',
        ino(TGT) !== oldIno && ino(RUNNING) === oldIno && !fs.readFileSync(TGT).equals(SRC), JSON.stringify([ino(TGT), ino(RUNNING), oldIno]));
    ok('F-P1 restart fails: / is read-only again (verified by the mount table)', roNow(), fs.readFileSync(MOUNTS, 'utf8'));
    ok('F-P1 restart fails: remount,rw then one successful remount,ro', mcalls.length === 2 && /remount,rw/.test(mcalls[0]) && /remount,ro/.test(mcalls[1]), JSON.stringify(mcalls));
    ok('F-P1 restart fails: the lock is released and no guard is set (/ is read-only)', !fs.existsSync(d.lock) && !fs.existsSync(d.guard));
    ok('F-P1 restart fails: only reads of the unit, nothing killed or started', calls.every(function (c) { return /^show /.test(c); }) && calls.length >= 2, JSON.stringify(calls));
    r = await status(d);
    ok('F-P1 restart fails: status carries no ro-failed error', !/ro-failed/.test(r.reason || ''), JSON.stringify(r));

    /* ---- the next change restarts carplay: the kept link goes once nothing runs the old inode ---- */
    dummy = dummyCarplay();
    setUnit('ok', dummy.pid);
    newCalls(); newMountCalls();
    r = await op(d, { cmd: 'revert' });
    calls = newCalls(); mcalls = newMountCalls();
    ok('restart works: revert restarted carplay, the main process got SIGKILL', r.carplay === 'restarted' && r.state === 'original' && await diedWithin(dummy) === 'SIGKILL', JSON.stringify(r));
    ok('restart works: the kept link is gone, / read-only, lock free', !fs.existsSync(RUNNING) && roNow() && !fs.existsSync(d.lock) && !fs.existsSync(d.guard));
    ok('restart works: one remount,rw, one remount,ro', mcalls.length === 2 && /remount,rw/.test(mcalls[0]) && /remount,ro/.test(mcalls[1]), JSON.stringify(mcalls));

    /* ---- the success path: a process runs the file, restart works, link made then dropped ---- */
    dummy = dummyCarplay();
    setUnit('ok', dummy.pid);
    runs(TGT);
    newCalls(); newMountCalls();
    r = await op(d, APPLY);
    calls = newCalls(); mcalls = newMountCalls();
    ok('success path: apply restarted carplay', r.carplay === 'restarted' && r.state !== 'error' && await diedWithin(dummy) === 'SIGKILL', JSON.stringify(r));
    ok('success path: the drop-in, MainPID, start, is-active; nothing else', calls.length === 4 && /DropInPaths/.test(calls[0]) && /MainPID/.test(calls[1]) &&
        /^start /.test(calls[2]) && /^is-active/.test(calls[3]), JSON.stringify(calls));
    ok('success path: remount,rw once, remount,ro once; no link left; / read-only', mcalls.length === 2 && !fs.existsSync(RUNNING) && roNow(), JSON.stringify(mcalls));
    ok('success path: the lock is released', !fs.existsSync(d.lock) && !fs.existsSync(d.guard));

    /* ---- F-P3: remount,ro never takes ---- */
    dummy = dummyCarplay();
    setUnit('ok', dummy.pid);
    fs.writeFileSync(STUCK, '');
    newCalls(); newMountCalls();
    r = await op(d, { cmd: 'revert' });
    mcalls = newMountCalls();
    ok('F-P3 ro never takes: the change reports an error naming the writable /', r.state === 'error' && /still read-write/.test(r.reason || ''), JSON.stringify(r));
    ok('F-P3 ro never takes: / is still read-write', !roNow());
    ok('F-P3 ro never takes: the remount lock is KEPT by patchd', fs.existsSync(d.lock) && fs.readFileSync(d.lock, 'utf8').split(' ')[0] === String(d.child.pid), fs.existsSync(d.lock) ? fs.readFileSync(d.lock, 'utf8') : 'no lock');
    ok('F-P3 ro never takes: the ro-failed guard names the reason', fs.existsSync(d.guard) && /read-write/.test(fs.readFileSync(d.guard, 'utf8')));
    r = await status(d);
    ok('F-P3 ro never takes: status reports an error with the ro-failed reason', r.state === 'error' && /ro-failed/.test(r.reason || ''), JSON.stringify(r));
    newMountCalls();
    r = await op(d, APPLY);
    mcalls = newMountCalls();
    ok('F-P3 guard standing: the next change is refused, nothing written, no remount,rw', r.state === 'error' && /ro-failed/.test(r.reason || '') &&
        mcalls.length > 0 && mcalls.every(function (c) { return /remount,ro/.test(c); }), JSON.stringify([r, mcalls]));
    ok('F-P3 guard standing: the lock and the guard are still there', fs.existsSync(d.lock) && fs.existsSync(d.guard));
    /* The operator (or the mount) recovers: the next change clears the guard and goes on. */
    fs.unlinkSync(STUCK);
    dummy = dummyCarplay();
    setUnit('ok', dummy.pid);
    r = await op(d, APPLY);
    ok('F-P3 cleared: with / read-only again the next change clears the guard and runs', r.state !== 'error' && roNow() && !fs.existsSync(d.guard) && !fs.existsSync(d.lock), JSON.stringify(r));

    /* ---- F-P1: the link cannot be made while a process runs the file: nothing is written ---- */
    d.child.kill('SIGKILL');
    var LONG = path.join(dir, 'usr', new Array(245).join('c'));   /* name + '.woc-running' is over NAME_MAX (255) */
    fs.writeFileSync(LONG, SRC);
    fs.chmodSync(LONG, 0o755);
    var PROC2 = path.join(dir, 'proc2');
    fs.mkdirSync(PROC2);
    runs(LONG, PROC2);
    var d2 = startPatchd('sock2', LONG, PROC2);
    for (i = 0; i < 200 && !fs.existsSync(d2.sock); i++) await sleep(25);
    setUnit('ok', 0);
    newCalls(); newMountCalls();
    r = await op(d2, APPLY);
    calls = newCalls(); mcalls = newMountCalls();
    ok('F-P1 link fails: the change is refused with the reason', r.state === 'error' && /keeping it linked as .* failed/.test(r.reason || '') && /nothing written/.test(r.reason || ''), JSON.stringify(r));
    ok('F-P1 link fails: the target is unchanged and no backup was made', fs.readFileSync(LONG).equals(SRC) && !fs.existsSync(LONG + '.woc-orig'));
    ok('F-P1 link fails: / is read-only (verified), the lock released, no guard', roNow() && !fs.existsSync(d2.lock) && !fs.existsSync(d2.guard) &&
        mcalls.length === 2 && /remount,ro/.test(mcalls[1]), JSON.stringify(mcalls));
    ok('F-P1 link fails: carplay is neither killed nor started', calls.every(function (c) { return /^show .*DropInPaths/.test(c); }), JSON.stringify(calls));
    d2.child.kill('SIGKILL');
}

main().catch(function (e) { ok('no exception', false, e.stack); }).then(function () {
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
