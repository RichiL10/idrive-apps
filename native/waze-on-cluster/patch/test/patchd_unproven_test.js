#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves, on a synthetic carplay build (synthetic_carplay.js, outside the
 * proven list), that patchd patches a build outside the proven list only when
 * the app sends the user's confirmation (S3), and never writes without the
 * shared remount lock: status says "unproven"; a plain apply is refused with a
 * reason the app shows, nothing written; an apply while another process holds
 * the lock is refused after the wait, nothing written, the other's lock kept;
 * the confirmed apply writes the patch, keeping the binary's mode, leaving no
 * temp file, and then needs no confirmation any more. The install-time
 * activation never passes the confirmation. Runs the real patchd.js and
 * carplay_patch.js with a fake systemctl, mount and /proc; carplay is not in
 * the restart lists, so each change waits for the next head-unit start.
 * (Kiro test build; ported from the fork's test of the same name.)
 *
 *   node patchd_unproven_test.js
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
fs.chmodSync(TGT, 0o2751);   /* set-gid kept; "other" gets the exec bit the service user needs (file_mode.js, PR #52) */
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
var MOUNT_LOG = path.join(dir, 'mount.log');   /* every call of the fake mount, to prove a refusal remounts nothing */
var RECOVERY_STATE = path.join(dir, 'boot-recovery.json');
fs.writeFileSync(MOUNT, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '" ;; ' +
    '*remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + MOUNTS + '" ;; esac\nexit 0\n');
fs.chmodSync(MOUNT, 0o755);

var SOCK = path.join(dir, 'sock', 'patch.sock');
var LOCK = path.join(dir, 'sock', 'remount.lock');
var ENV = Object.assign({}, process.env, {
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
    WOC_STATE_DIR: path.join(dir, 'var'),
    WOC_REMOUNT_LOCK: LOCK,
    WOC_OP_LOCK_WAIT_MS: '1500',
    WOC_PROC: PROC,
    WOC_RECOVERY_STATE: RECOVERY_STATE,
    WOC_TEST: '1',
    WOC_AA_ENABLED: '0',
});
var patchd = cp.spawn(process.execPath, [PATCHD], { env: ENV, stdio: ['ignore', 'ignore', 'inherit'] });
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

    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb' });
    ok('apply without the confirmation: refused with the reason the app shows', r.state === 'error' && /untested carplay build/.test(r.reason || '') &&
        /needs your confirmation/.test(r.reason || ''), JSON.stringify(r));
    ok('apply without the confirmation: nothing written, no backup', same() && !fs.existsSync(TGT + '.woc-orig'));
    /* Review F5: the refusal comes before anything is remounted or linked. */
    ok('apply without the confirmation: / is not remounted for a request known to be refused',
        !fs.existsSync(MOUNT_LOG) || fs.readFileSync(MOUNT_LOG, 'utf8') === '', fs.existsSync(MOUNT_LOG) ? fs.readFileSync(MOUNT_LOG, 'utf8') : '');
    ok('apply without the confirmation: the running binary is not linked aside',
        fs.readdirSync(path.dirname(TGT)).filter(function (n) { return /running/.test(n); }).length === 0, JSON.stringify(fs.readdirSync(path.dirname(TGT))));
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb', unproven: 'true' });
    ok('a confirmation that is not the boolean true counts as none', r.state === 'error' && /needs your confirmation/.test(r.reason || '') && same(), JSON.stringify(r));
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb', unproven: false });
    ok('unproven:false counts as none', r.state === 'error' && /needs your confirmation/.test(r.reason || '') && same(), JSON.stringify(r));
    r = await status();
    ok('status after the refusals: still original and unproven, not busy', r.state === 'original' && r.unproven === true && !r.busy, JSON.stringify(r));

    /* Another process (this test) holds the remount lock, as a boot-recovery
     * restore does. */
    fs.writeFileSync(LOCK, process.pid + ' ' + new Date().toISOString() + '\n');
    var t0 = Date.now();
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb', unproven: true });
    ok('apply while the lock is held: refused after the wait, with a reason', r.state === 'error' && /another change to \/ is running/.test(r.reason || '') &&
        /try again in two minutes/.test(r.reason || '') && Date.now() - t0 >= 1400, JSON.stringify(r) + ' after ' + (Date.now() - t0) + ' ms');
    ok('apply while the lock is held: nothing written, the holder\'s lock kept', same() && !fs.existsSync(TGT + '.woc-orig') &&
        fs.readFileSync(LOCK, 'utf8').indexOf(String(process.pid)) === 0);
    fs.unlinkSync(LOCK);

    /* Stale temp files of an earlier write cut short: the legacy name and a
     * process that is gone. */
    fs.writeFileSync(TGT + '.woc-tmp', 'x');
    fs.writeFileSync(TGT + '.woc-tmp.999999', 'x');
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb', unproven: true });
    ok('the confirmed apply writes the patch (deferred to the next start)', r.carplay === 'deferred' && !same() && fs.existsSync(TGT + '.woc-orig'), JSON.stringify(r));
    ok('the written binary keeps its mode (set-id bit and owner/group bits; the exec floor of file_mode.js)', (fs.statSync(TGT).mode & 0o7777) === 0o2755,
        (fs.statSync(TGT).mode & 0o7777).toString(8));
    ok('no temp file is left, stale ones dropped', temps().length === 0, JSON.stringify(temps()));
    ok('the lock is released', !fs.existsSync(LOCK));
    r = await status();
    ok('status: once patched (our backup present) no confirmation is asked', !r.unproven, JSON.stringify(r));
    ok('the confirmed apply did remount / (the check above is not vacuous)', fs.existsSync(MOUNT_LOG) && /remount,rw/.test(fs.readFileSync(MOUNT_LOG, 'utf8')));

    /* Review F3: patchd reports the failed mark boot recovery wrote (S4) while the
     * binary is not the original, and not once the original is back. */
    ok('status: no failed mark without one on disk', !r.failed, JSON.stringify(r));
    fs.writeFileSync(RECOVERY_STATE, JSON.stringify({ fails: 2, unknown: 0, arm: null,
        failed: { since: '2026-11-05T10:00:00.000Z', boot: 'b1', fails: 3, why: 'no backup can restore it' } }) + '\n');
    r = await status();
    ok('status: a failed mark on disk is reported while the binary is patched', !same() && typeof r.failed === 'string' && r.failed.length > 0, JSON.stringify(r));
    /* The stock binary back in place (as a hand restore leaves it): the mark is stale and not reported. */
    var patchedBin = fs.readFileSync(TGT), patchedMode = fs.statSync(TGT).mode & 0o7777;
    fs.writeFileSync(TGT, SRC);
    r = await status();
    ok('status: the failed mark is not reported once the binary is the original', !r.failed, JSON.stringify(r));
    fs.writeFileSync(TGT, patchedBin);
    fs.chmodSync(TGT, patchedMode);
    r = await status();
    ok('status: the mark is reported again with the patched binary back', typeof r.failed === 'string' && r.failed.length > 0, JSON.stringify(r));
    fs.unlinkSync(RECOVERY_STATE);
    r = await status();
    ok('status: the mark gone from disk is gone from the status', !r.failed, JSON.stringify(r));

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
    patchd.kill('SIGKILL');

    /* The install hook never passes the confirmation: on a fresh synthetic
     * build `patchd.js activate` leaves it as a conflict, writes nothing. */
    fs.readdirSync(path.dirname(TGT)).filter(function (n) { return /^carplay\.woc-/.test(n); }).forEach(function (n) { fs.unlinkSync(path.join(path.dirname(TGT), n)); });
    fs.writeFileSync(TGT, SRC);
    fs.chmodSync(TGT, 0o2751);
    try { fs.unlinkSync(path.join(dir, 'sock', 'activation-pending')); } catch (e) {}
    var h = cp.spawnSync(process.execPath, [PATCHD, 'activate'], { env: ENV, encoding: 'utf8', timeout: 60000 });
    var line = (h.stdout || '').trim().split('\n').pop();
    var res = {};
    try { res = JSON.parse(line); } catch (e) {}
    ok('activate on an unproven build: exits 0, a conflict, nothing written', h.status === 0 && /untested carplay build/.test(res.conflict || '') && same() &&
        !fs.existsSync(TGT + '.woc-orig'), (h.stdout || '') + (h.stderr || ''));
}

main().catch(function (e) { ok('no exception', false, e.stack); }).then(function () {
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
