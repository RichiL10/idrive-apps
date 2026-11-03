#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves, on a synthetic carplay build (synthetic_carplay.js, outside the
 * proven list), that patchd patches a build outside the proven list only when
 * the app sends the user's confirmation, and never writes without the shared
 * remount lock: status says "unproven"; a plain apply is refused with a reason
 * the app shows, nothing written; an apply while another process holds the
 * lock is refused after the wait, nothing written, the other's lock kept; the
 * confirmed apply writes the patch, keeping the binary's mode, leaving no
 * temp file, and then needs no confirmation any more. Runs the real patchd.js
 * and carplay_patch.js with a fake systemctl, mount and /proc; carplay is not
 * in the restart lists, so each change waits for the next head-unit start.
 *
 *   node patchd_unproven_test.js
 */
'use strict';

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

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-unproven-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});

var SRC = synthetic.build({}).buf;
var TGT = path.join(dir, 'usr', 'carplay');
fs.mkdirSync(path.dirname(TGT));
fs.writeFileSync(TGT, SRC);
fs.chmodSync(TGT, 0o751);
var MOUNTS = path.join(dir, 'mounts');
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
var RECMGR = path.join(dir, 'recmgr-restartlist.conf');
fs.writeFileSync(RECMGR, '[Whitelist]\nHBAdasMgu\n[WhitelistExitSuccess]\nHBAdasMgu\n');
var PROC_STAT = path.join(dir, 'stat');
fs.writeFileSync(PROC_STAT, 'cpu  1 2 3\nbtime ' + (Math.floor(Date.now() / 1000) - 60) + '\n');
var PROC = path.join(dir, 'proc');
fs.mkdirSync(PROC);
fs.mkdirSync(path.join(PROC, '4242'));
fs.linkSync(TGT, path.join(PROC, '4242', 'exe'));   /* carplay runs the binary on disk */
var BIN = path.join(dir, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'systemctl'), '#!/bin/sh\n' +
    'case "$1" in show) echo MainPID=4242; echo InvocationID=inv; echo ExecMainStartTimestampMonotonic=5; echo DropInPaths= ;; ' +
    'is-active) echo active ;; esac\nexit 0\n');
fs.chmodSync(path.join(BIN, 'systemctl'), 0o755);
fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(BIN, 'journalctl'), 0o755);
var MOUNT = path.join(dir, 'mount');
fs.writeFileSync(MOUNT, '#!/bin/sh\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '" ;; ' +
    '*remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + MOUNTS + '" ;; esac\nexit 0\n');
fs.chmodSync(MOUNT, 0o755);

var SOCK = path.join(dir, 'sock', 'patch.sock');
var LOCK = path.join(dir, 'sock', 'remount.lock');
var RSTATE = path.join(dir, 'boot-recovery.json');
var patchd = cp.spawn(process.execPath, [PATCHD], {
    env: Object.assign({}, process.env, {
        PATH: BIN + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: SOCK,
        WOC_CARPLAY: TGT,
        WOC_MOUNT: MOUNT,
        WOC_PROC_MOUNTS: MOUNTS,
        WOC_RESTART_POLL_MS: '20',
        WOC_RECMGR_CONF: RECMGR,
        WOC_CARPLAY_DROPIN: path.join(dir, 'no-dropin.conf'),
        WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
        WOC_PROC_STAT: PROC_STAT,
        WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
        WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
        WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
        WOC_DLT_RETRY_MS: '600000',
        WOC_REBOOT_CMD: path.join(dir, 'no-reboot'),
        WOC_REMOUNT_LOCK: LOCK,
        WOC_LOCK_WAIT_MS: '1500',
        WOC_PROC: PROC,
        WOC_RECOVERY_STATE: RSTATE,
    }),
    stdio: ['ignore', 'ignore', 'inherit'],
});
children.push(patchd);

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* Connect, wait for the status patchd sends on connect, optionally send cmd,
 * and resolve to the first status message done(msg) accepts. */
function session(cmd, done) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(SOCK), buf = '', sent = !cmd;
        var timer = setTimeout(function () { c.destroy(); reject(new Error('timed out waiting on ' + JSON.stringify(cmd))); }, 30000);
        c.setEncoding('utf8');
        c.on('error', reject);
        c.on('data', function (d) {
            buf += d;
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
function status() { return session(null, function (m) { return m.state !== 'busy'; }); }
function op(cmd) { return session(cmd, function (m) { return m.state === 'error' || m.carplay === 'restarted' || m.carplay === 'deferred'; }); }
function same() { return fs.readFileSync(TGT).equals(SRC); }
function temps() { return fs.readdirSync(path.dirname(TGT)).filter(function (n) { return /woc-tmp/.test(n); }); }

async function main() {
    for (var i = 0; i < 200 && !fs.existsSync(SOCK); i++) await sleep(25);
    var r;

    r = await status();
    ok('status: the stock synthetic build is original and unproven', r.state === 'original' && r.unproven === true, JSON.stringify(r));

    /* A failed mark left while carplay reads stock (restored by hand): stale,
     * not reported. */
    fs.writeFileSync(RSTATE, JSON.stringify({ fails: 3, arm: null, failed: { since: 'x', boot: 'b', fails: 3, why: 'backup sha256 mismatch' } }) + '\n');
    r = await status();
    ok('status: a failed mark is not reported while carplay reads stock', r.state === 'original' && r.failed === undefined, JSON.stringify(r));
    fs.writeFileSync(RSTATE, JSON.stringify({ fails: 0, arm: null, failed: null }) + '\n');

    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb' });
    ok('apply without the confirmation: refused with the reason the app shows', r.state === 'error' && /untested carplay build/.test(r.reason || ''), JSON.stringify(r));
    ok('apply without the confirmation: nothing written, no backup', same() && !fs.existsSync(TGT + '.woc-orig'));

    /* Another process (this test) holds the remount lock, as a boot-recovery
     * restore does. */
    fs.writeFileSync(LOCK, process.pid + ' ' + new Date().toISOString() + '\n');
    var t0 = Date.now();
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb', unproven: true });
    ok('apply while the lock is held: refused after the wait, with a reason', r.state === 'error' && /another write to carplay is in progress/.test(r.reason || '') &&
        Date.now() - t0 >= 1400, JSON.stringify(r) + ' after ' + (Date.now() - t0) + ' ms');
    ok('apply while the lock is held: nothing written, the holder\'s lock kept', same() && !fs.existsSync(TGT + '.woc-orig') &&
        fs.readFileSync(LOCK, 'utf8').indexOf(String(process.pid)) === 0);
    fs.unlinkSync(LOCK);

    /* Stale temp files of an earlier write cut short: the legacy name and a
     * process that is gone. */
    fs.writeFileSync(TGT + '.woc-tmp', 'x');
    fs.writeFileSync(TGT + '.woc-tmp.999999', 'x');
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb', unproven: true });
    ok('the confirmed apply writes the patch (deferred to the next start)', r.carplay === 'deferred' && !same() && fs.existsSync(TGT + '.woc-orig'), JSON.stringify(r));
    ok('the written binary keeps its mode', (fs.statSync(TGT).mode & 0o7777) === 0o751, (fs.statSync(TGT).mode & 0o7777).toString(8));
    ok('no temp file is left, stale ones dropped', temps().length === 0, JSON.stringify(temps()));
    ok('the lock is released', !fs.existsSync(LOCK));
    r = await status();
    ok('status: once patched (our backup present) no confirmation is asked', !r.unproven, JSON.stringify(r));
    ok('status: not marked failed without a boot-recovery mark', r.failed === undefined, JSON.stringify(r));

    /* Boot recovery marked the patch failed (crashing, no backup restores it). */
    fs.writeFileSync(RSTATE, JSON.stringify({ fails: 3, arm: null, failed: { since: 'x', boot: 'b', fails: 3, why: 'backup sha256 mismatch' } }) + '\n');
    r = await status();
    ok('status: a failed mark is reported for the app, with the count and the reason',
        /crashed 3 times/.test(r.failed || '') && /backup sha256 mismatch/.test(r.failed || ''), JSON.stringify(r));
    fs.writeFileSync(RSTATE, JSON.stringify({ fails: 0, arm: null, failed: null }) + '\n');
    r = await status();
    ok('status: a cleared mark is not reported', r.failed === undefined, JSON.stringify(r));

    /* A modified build with no backup of ours (our backup moved away): the
     * patcher refuses it ("first edit requires the pristine build"), so no
     * confirmation is offered, only the conflict. */
    var aside = path.join(dir, 'aside');
    fs.mkdirSync(aside);
    fs.readdirSync(path.dirname(TGT)).filter(function (n) { return /^carplay\.woc-/.test(n); }).forEach(function (n) {
        fs.renameSync(path.join(path.dirname(TGT), n), path.join(aside, n));
    });
    r = await status();
    ok('status: a modified build without our backup is not offered the confirmation',
        !r.unproven && /modified by something else/.test(r.conflict || ''), JSON.stringify(r));
}

main().catch(function (e) { ok('no exception', false, e.stack); }).then(function () {
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
