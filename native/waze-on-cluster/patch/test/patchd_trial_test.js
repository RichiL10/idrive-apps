#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves, on a synthetic carplay build that WOC_TEST_PROVEN_BUILD lists as
 * proven (synthetic_carplay.js, a stand-in for the firmware the other patch
 * tests need), what the cluster coding and the first patch on trial do to
 * carplay's patch, with the Kiro test build's safeguards:
 *
 *  - carplay_patch.js: a car not coded KI_KOMBI_VARIANT 7, or whose coding
 *    cannot be read, is patched only with --unproven; the patch record says
 *    trial for the first patch of a proven build (and for a proven build
 *    patched while the coding cannot be read), proven once the watcher
 *    recorded it, and keeps proven across applies and a revert (healthy).
 *  - patchd, the Patch button (S3): on such a car status says unproven and
 *    names the conflict; a plain apply is refused before anything is
 *    remounted, nothing written; only {"unproven":true} patches it.
 *  - patchd activate (the install): writes the patch only on a variant-7 car,
 *    on trial; otherwise nothing is written and the conflict is reported,
 *    with Android Auto off (S6) left alone; a patch an earlier release left
 *    waiting for its start is put on trial.
 *
 * Runs the real patchd.js and carplay_patch.js with a fake systemctl, mount
 * and /proc. (Kiro test build; the firmware-bound versions of these cases
 * are in patch_test.js, patchd_patch_test.js and patchd_activate_test.js.)
 *
 *   node patchd_trial_test.js
 */
'use strict';

var car = require('./head_unit_env.js');   /* a HIGH head unit, coded KI_KOMBI_VARIANT 7, for every patcher and patchd this runs */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');
var synthetic = require('./synthetic_carplay.js');
var record = require('../patch_record.js');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var CARPLAY_PATCH = path.join(__dirname, '..', 'carplay_patch.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  -- ' + detail : '') + '\n');
    if (!cond) fails++;
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-trial-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});

var BUILD = synthetic.build({});
var SRC = BUILD.buf, SRC_SHA = sha(SRC);
var TGT = path.join(dir, 'usr', 'carplay');
fs.mkdirSync(path.dirname(TGT));
var MOUNTS = path.join(dir, 'mounts');
var MOUNT = path.join(dir, 'mount');
var MOUNT_LOG = path.join(dir, 'mount.log');
var RW_FAILS = path.join(dir, 'rw-fails');
var PROC = path.join(dir, 'proc');
var EXE = path.join(PROC, '4242', 'exe');
var BIN = path.join(dir, 'bin');
var SOCK = path.join(dir, 'sock', 'patch.sock');
var PENDING = path.join(dir, 'sock', 'activation-pending');
var RECOVERY_STATE = path.join(dir, 'boot-recovery.json');
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
fs.mkdirSync(path.join(PROC, '4242'), { recursive: true });
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'systemctl'), '#!/bin/sh\n' +
    'case "$1" in show) echo MainPID=4242; echo InvocationID=inv; echo ExecMainStartTimestampMonotonic=5; echo DropInPaths= ;; ' +
    'is-active) echo active ;; esac\nexit 0\n');
fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(BIN, 'systemctl'), 0o755);
fs.chmodSync(path.join(BIN, 'journalctl'), 0o755);
fs.writeFileSync(MOUNT, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\ncase "$*" in *remount,rw*) [ -e "' + RW_FAILS + '" ] && exit 1; echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '" ;; ' +
    '*remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + MOUNTS + '" ;; esac\nexit 0\n');
fs.chmodSync(MOUNT, 0o755);
var RECMGR = path.join(dir, 'recmgr-restartlist.conf');
fs.writeFileSync(RECMGR, '[Whitelist]\nHBAdasMgu\n[WhitelistExitSuccess]\nHBAdasMgu\n');
var PROC_STAT = path.join(dir, 'stat');
fs.writeFileSync(PROC_STAT, 'cpu  1 2 3\nbtime ' + (Math.floor(Date.now() / 1000) - 60) + '\n');

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
    WOC_REMOUNT_LOCK: path.join(dir, 'sock', 'remount.lock'),
    WOC_OP_LOCK_WAIT_MS: '1500',
    WOC_PROC: PROC,
    WOC_RECOVERY_STATE: RECOVERY_STATE,
    WOC_TEST: '1',
    WOC_AA_ENABLED: '0',
    WOC_TEST_PROVEN_BUILD: BUILD.at.buildId + ':' + SRC_SHA,
});

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ro() { return /\bro\b/.test(fs.readFileSync(MOUNTS, 'utf8')); }
function disk() { return sha(fs.readFileSync(TGT)); }
function marker() { try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch (e) { return null; } }
function mountCalls() { try { return fs.readFileSync(MOUNT_LOG, 'utf8'); } catch (e) { return ''; } }
function sidecars(t) { return [t + '.woc-orig', t + '.woc-orig.json', record.recordPath(t), t + '.woc-running', t + '.woc-running.1', t + '.woc-running.2', t + '.woc-tmp']; }
function relink() { try { fs.unlinkSync(EXE); } catch (e) {} fs.linkSync(TGT, EXE); }

/* The stock proven build in place, nothing of ours beside it, carplay running it. */
function reset() {
    sidecars(TGT).concat([PENDING, RECOVERY_STATE, MOUNT_LOG, RW_FAILS]).forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    try { fs.unlinkSync(TGT); } catch (e) {}
    fs.writeFileSync(TGT, SRC);
    fs.chmodSync(TGT, 0o755);
    relink();
}
/* The next head-unit start: carplay runs the file on disk, the markers are gone. */
function headUnitStart() {
    [PENDING, TGT + '.woc-running', TGT + '.woc-running.1', TGT + '.woc-running.2'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    relink();
}

function view(t) {
    var x = record.current(t);
    return x ? JSON.stringify({ patched: x.patched, proven: x.proven, trial: x.trial, healthy: x.healthy }) : 'none';
}
function want(o) { return JSON.stringify({ patched: o.patched, proven: o.proven, trial: o.trial, healthy: o.healthy }); }

/* ---- carplay_patch.js ---- */

function patcher(t, args) {
    var r = cp.spawnSync(process.execPath, [CARPLAY_PATCH].concat(args, ['--target', t]), { env: ENV, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function patcherCases() {
    var ct = path.join(dir, 'usr', 'carplay_cli'), r;
    function fresh() {
        sidecars(ct).forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
        fs.writeFileSync(ct, SRC);
        fs.chmodSync(ct, 0o755);
    }
    function rec() { return view(ct); }
    try {
        fresh();
        r = patcher(ct, ['status']);
        ok('coding: status names it', /^coding:\s+KI_KOMBI_VARIANT 7$/m.test(r.out) && /^proven:\s+yes$/m.test(r.out), r.out);
        [[function () { car.coding(9); }, 'KI_KOMBI_VARIANT 9 is not the proven cluster coding (7)', /^coding:\s+KI_KOMBI_VARIANT 9$/m, false],
         [function () { car.coding(7, 0x0b); }, 'the cluster coding cannot be read (coding not valid (flags 0xb))', /^coding:\s+unreadable \(coding not valid/m, true],
         [function () { car.coding(null); }, 'the cluster coding cannot be read', /^coding:\s+unreadable \(.* unreadable\)$/m, true]].forEach(function (c) {
            fresh();
            c[0]();
            r = patcher(ct, ['status']);
            ok('coding: status reads ' + c[2], c[2].test(r.out), r.out);
            r = patcher(ct, ['apply', '--panel', 'high', '--yes']);
            ok('coding: apply refused (' + c[1] + '), nothing written, no backup', r.code !== 0 && r.out.indexOf('refusing: ' + c[1]) >= 0 && /pass --unproven/.test(r.out) &&
                sha(fs.readFileSync(ct)) === SRC_SHA && !fs.existsSync(ct + '.woc-orig') && rec() === 'none', r.out);
            r = patcher(ct, ['apply', '--panel', 'high', '--unproven', '--yes']);
            /* A coding that cannot be read may be a variant-7 car's: on trial, so a healthy run proves it. Another variant: unproven for good. */
            ok('coding: with --unproven (the Patch button) patched, recorded ' + (c[3] ? 'on trial' : 'unproven'), r.code === 0 && /patched OK/.test(r.out) &&
                rec() === want(c[3] ? { patched: true, proven: false, trial: true } : { patched: true, proven: false }), r.out + rec());
            r = patcher(ct, ['apply', '--panel', 'mid', '--yes']);
            ok('coding: a later apply without --unproven refused too', r.code !== 0 && r.out.indexOf('refusing: ' + c[1]) >= 0, r.out);
            r = patcher(ct, ['revert', '--yes']);
            ok('coding: revert needs no confirmation', r.code === 0 && sha(fs.readFileSync(ct)) === SRC_SHA, r.out);
            car.coding(7);
        });

        fresh();
        r = patcher(ct, ['apply', '--panel', 'high', '--yes']);
        ok('record: the first patch of a proven build on a variant-7 car is on trial, unproven', r.code === 0 && rec() === want({ patched: true, proven: false, trial: true }), r.out + rec());
        r = patcher(ct, ['apply', '--panel', 'high', '--yes']);
        ok('record: an apply with nothing to do keeps the trial', /nothing to do/.test(r.out) && rec() === want({ patched: true, proven: false, trial: true }), r.out + rec());
        r = patcher(ct, ['apply', '--panel', 'mid', '--yes']);
        ok('record: an apply that rewrites a patch on trial keeps it on trial', r.code === 0 && /patched OK/.test(r.out) && rec() === want({ patched: true, proven: false, trial: true }), r.out + rec());
        r = patcher(ct, ['revert', '--yes']);
        ok('record: reverting a patch on trial leaves no healthy mark', r.code === 0 && rec() === want({ patched: false }), r.out + rec());
        r = patcher(ct, ['apply', '--panel', 'high', '--yes']);
        ok('record: patched again, on trial again', r.code === 0 && rec() === want({ patched: true, proven: false, trial: true }), r.out + rec());

        /* The watcher's record once carplay ran it healthy. */
        record.write(ct, { patched: true, proven: true });
        r = patcher(ct, ['apply', '--panel', 'high', '--yes']);
        ok('record: a patch that ran healthy stays proven (nothing to do)', /nothing to do/.test(r.out) && rec() === want({ patched: true, proven: true }), r.out + rec());
        r = patcher(ct, ['apply', '--panel', 'mid', '--yes']);
        ok('record: and when an apply rewrites it', r.code === 0 && /patched OK/.test(r.out) && rec() === want({ patched: true, proven: true }), r.out + rec());
        r = patcher(ct, ['revert', '--yes']);
        ok('record: its revert remembers it ran healthy', r.code === 0 && sha(fs.readFileSync(ct)) === SRC_SHA && rec() === want({ patched: false, healthy: true }), r.out + rec());
        r = patcher(ct, ['revert', '--yes']);
        ok('record: a revert with nothing to do keeps that', /already at the original/.test(r.out) && rec() === want({ patched: false, healthy: true }), r.out + rec());
        r = patcher(ct, ['apply', '--panel', 'high', '--yes']);
        ok('record: patched again, the same build is proven at once', r.code === 0 && rec() === want({ patched: true, proven: true }), r.out + rec());
        car.coding(9);
        r = patcher(ct, ['apply', '--panel', 'mid', '--unproven', '--yes']);
        ok('record: on a car coded otherwise, the Patch button\'s patch is unproven whatever ran before', r.code === 0 && rec() === want({ patched: true, proven: false }), r.out + rec());
        car.coding(7);

        /* A patch an earlier release wrote and recorded proven (no trial): kept proven across an update's apply. */
        fresh();
        patcher(ct, ['apply', '--panel', 'high', '--yes']);
        record.write(ct, { patched: true, proven: true });
        var m0 = fs.statSync(record.recordPath(ct)).mtime.getTime();
        r = patcher(ct, ['apply', '--panel', 'high', '--yes']);
        ok('record: an earlier release\'s proven record stays proven, not rewritten', /nothing to do/.test(r.out) && rec() === want({ patched: true, proven: true }) &&
            fs.statSync(record.recordPath(ct)).mtime.getTime() === m0, r.out + rec());

        /* A patch on trial on a car whose coding then reads otherwise: the Patch button's apply ends the trial. */
        fresh();
        patcher(ct, ['apply', '--panel', 'high', '--yes']);
        car.coding(10);
        r = patcher(ct, ['apply', '--panel', 'high', '--unproven', '--yes']);
        ok('record: a trial ends when the coding is not the proven one', /nothing to do/.test(r.out) && rec() === want({ patched: true, proven: false, trial: false }), r.out + rec());
        car.coding(7);

        /* A build outside the proven list stays unproven: the test hook lists one build only. */
        var other = synthetic.build({ pad: 16 }).buf;
        fresh();
        fs.writeFileSync(ct, other);
        r = patcher(ct, ['apply', '--panel', 'high', '--unproven', '--yes']);
        ok('record: a build outside the proven list is unproven, not on trial', r.code === 0 && rec() === want({ patched: true, proven: false }), r.out + rec());
    } finally {
        car.coding(7);
        sidecars(ct).concat([ct]).forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    }
}

/* ---- patchd, the Patch button ---- */

function startPatchd() {
    var d = cp.spawn(process.execPath, [PATCHD], { env: ENV, stdio: ['ignore', 'ignore', 'inherit'] });
    children.push(d);
    return d;
}
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

async function daemonCases() {
    var d = startPatchd(), r, i;
    for (i = 0; i < 200 && !fs.existsSync(SOCK); i++) await sleep(25);
    var CASES = [['coding 9', function () { car.coding(9); }, 'not supported on this car (KI_KOMBI_VARIANT 9)', { patched: true, proven: false }],
        ['invalid coding flags', function () { car.coding(7, 0x0b); }, 'cluster coding unreadable', { patched: true, proven: false, trial: true }],
        ['no coding', function () { car.coding(null); }, 'cluster coding unreadable', { patched: true, proven: false, trial: true }]];
    for (var k = 0; k < CASES.length; k++) {
        var c = CASES[k];
        reset();
        c[1]();
        r = await status();
        ok(c[0] + ': status says original, the conflict, and asks for the confirmation', r.state === 'original' && r.conflict === c[2] && r.unproven === true, JSON.stringify(r));
        r = await op({ cmd: 'apply', panel: 'high', mode: 'avb' });
        ok(c[0] + ': a plain apply (S3) is refused with the reason the app shows', r.state === 'error' && /cluster coding is not the proven one/.test(r.reason || '') &&
            /needs your confirmation/.test(r.reason || ''), JSON.stringify(r));
        ok(c[0] + ': nothing written, no backup, no record, / never remounted', disk() === SRC_SHA && !fs.existsSync(TGT + '.woc-orig') && view(TGT) === 'none' && mountCalls() === '', mountCalls());
        r = await op({ cmd: 'apply', panel: 'high', mode: 'avb', unproven: 'true' });
        ok(c[0] + ': a confirmation that is not the boolean true counts as none', r.state === 'error' && /needs your confirmation/.test(r.reason || '') && disk() === SRC_SHA, JSON.stringify(r));
        r = await op({ cmd: 'apply', panel: 'high', mode: 'avb', unproven: true });
        ok(c[0] + ': the confirmed apply patches it (deferred to the next start), recorded ' + (c[3].trial ? 'on trial' : 'unproven'),
            r.carplay === 'deferred' && disk() !== SRC_SHA && view(TGT) === want(c[3]), JSON.stringify([r, view(TGT)]));
        headUnitStart();
        r = await status();
        ok(c[0] + ': after the start it reads patched, the conflict still named', r.state === 'patched' && r.conflict === c[2], JSON.stringify(r));
        var patched = disk();
        r = await op({ cmd: 'apply', panel: 'mid', mode: 'avb' });
        ok(c[0] + ': a later plain apply is refused too, nothing written', r.state === 'error' && /needs your confirmation/.test(r.reason || '') && disk() === patched, JSON.stringify(r));
        r = await op({ cmd: 'revert' });
        ok(c[0] + ': Remove patch needs no confirmation', (r.carplay === 'deferred' || r.carplay === 'restarted') && disk() === SRC_SHA && view(TGT) === want({ patched: false }), JSON.stringify([r, view(TGT)]));
        car.coding(7);
    }

    /* An untested build on a car with another coding: one confirmation covers both, so the refusal names both. */
    var OTHER = synthetic.build({ pad: 16 }).buf;
    reset();
    fs.writeFileSync(TGT, OTHER);
    car.coding(9);
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb' });
    ok('untested build and coding 9: a plain apply is refused naming both, nothing written', r.state === 'error' && /untested carplay build and cluster coding/.test(r.reason || '') &&
        /needs your confirmation/.test(r.reason || '') && sha(fs.readFileSync(TGT)) === sha(OTHER) && !fs.existsSync(TGT + '.woc-orig') && mountCalls() === '', JSON.stringify(r));
    car.coding(7);

    /* A variant-7 car, the proven build: the first patch is on trial and needs no confirmation. */
    reset();
    r = await status();
    ok('coding 7: a proven build, no conflict, nothing to confirm', r.state === 'original' && !r.conflict && !r.unproven, JSON.stringify(r));
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb' });
    ok('coding 7: the Patch button patches it, recorded on trial', r.carplay === 'deferred' && disk() !== SRC_SHA && view(TGT) === want({ patched: true, proven: false, trial: true }), JSON.stringify([r, view(TGT)]));
    headUnitStart();
    r = await status();
    ok('coding 7: after the start it reads patched, no conflict', r.state === 'patched' && !r.conflict && !r.unproven, JSON.stringify(r));
    record.write(TGT, { patched: true, proven: true });   /* the watcher's record after a healthy run */
    r = await op({ cmd: 'revert' });
    ok('coding 7: Remove patch of a patch that ran healthy remembers it', disk() === SRC_SHA && view(TGT) === want({ patched: false, healthy: true }), JSON.stringify([r, view(TGT)]));
    headUnitStart();
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb' });
    ok('coding 7: patched again, the same build is proven at once', r.carplay === 'deferred' && view(TGT) === want({ patched: true, proven: true }), JSON.stringify([r, view(TGT)]));
    d.kill('SIGKILL');
    await sleep(100);
}

/* ---- patchd activate and deactivate ---- */

function hook(which) {
    var h = cp.spawnSync(process.execPath, [PATCHD, which], { env: ENV, encoding: 'utf8', timeout: 90000 });
    var out = (h.stdout || '') + (h.stderr || ''), res = {};
    try { res = JSON.parse((h.stdout || '').trim().split('\n').pop()); } catch (e) {}
    return { code: h.status, result: res, out: out };
}

function hookCases() {
    var r, before;
    var TRIAL = want({ patched: true, proven: false, trial: true }), PROVEN = want({ patched: true, proven: true });
    try { fs.unlinkSync(path.join(dir, 'sock', 'remount.lock')); } catch (e) {}

    reset();
    r = hook('activate');
    ok('coding 7: the install patches, pending, the record on trial', r.code === 0 && !r.result.conflict && marker() && marker().action === 'apply' &&
        view(TGT) === TRIAL && ro(), JSON.stringify([r.result, view(TGT)]));
    headUnitStart();
    r = hook('activate');
    ok('coding 7: the next install leaves the trial as it is', r.code === 0 && !r.result.reboot && view(TGT) === TRIAL, JSON.stringify([r.result, view(TGT)]));
    record.write(TGT, { patched: true, proven: true });
    r = hook('activate');
    ok('migration: a patch recorded proven by an earlier release stays proven', r.code === 0 && !r.result.reboot && view(TGT) === PROVEN, JSON.stringify([r.result, view(TGT)]));

    var BAD = [['coding 9', 9, undefined, 'not supported on this car (KI_KOMBI_VARIANT 9)', want({ patched: true, proven: false })],
        ['invalid coding flags', 7, 0x0b, 'cluster coding unreadable', TRIAL], ['no coding', null, undefined, 'cluster coding unreadable', TRIAL]];
    BAD.forEach(function (c) {
        reset();
        car.coding(c[1], c[2]);
        r = hook('activate');
        ok(c[0] + ': the install writes nothing, no backup, no marker, only the conflict (S3: no confirmation passed)', r.code === 0 && disk() === SRC_SHA && !fs.existsSync(TGT + '.woc-orig') &&
            marker() === null && !r.result.reboot && r.result.conflict === c[3] && view(TGT) === 'none' && ro(), JSON.stringify(r.result));
        ok(c[0] + ': Android Auto is off (S6) and says so; nothing of aapd is touched', /Android Auto is off/.test((r.result.aa || {}).status || '') && !fs.existsSync(path.join(dir, 'usr', 'aapd')), JSON.stringify(r.result));
        /* CarPlay's Patch button, confirmed (patchd runs the patcher with --unproven). */
        cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'apply', '--target', TGT, '--panel', 'high', '--unproven', '--yes'], { env: ENV });
        headUnitStart();
        before = disk();
        r = hook('activate');
        ok(c[0] + ': a patch CarPlay\'s Patch button wrote: the install leaves it and its record', r.code === 0 && disk() === before && marker() === null &&
            r.result.conflict === c[3] && view(TGT) === c[4], JSON.stringify([r.result, view(TGT)]));
        r = hook('deactivate');
        ok(c[0] + ': the removal reverts it as ever', r.code === 0 && disk() === SRC_SHA && !fs.existsSync(TGT + '.woc-orig') && marker() && marker().action === 'revert' && ro(), JSON.stringify(r.result));
        car.coding(7);
    });

    /* HIGH F, the unit 0.8.2 refused: its recovery put the patch back to the original and kept the backup, and the
     * install applies the patch again (once, HIGH F's re-apply, the only automatic patch there is besides the
     * install's own). On a car not coded 7, or with no coding, it writes nothing and names the conflict. */
    var MARK = path.join(ENV.WOC_STATE_DIR, 'highf-repatched');
    function highfRestored() {
        try { fs.unlinkSync(MARK); } catch (e) {}
        car.set(car.HIGH);
        car.coding(7);
        reset();
        hook('activate');
        headUnitStart();
        cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'revert', '--target', TGT, '--yes'], { env: ENV });
        headUnitStart();
        car.set(car.HIGHF);
    }
    BAD.forEach(function (c) {
        highfRestored();
        ok(c[0] + ', HIGH F restored by 0.8.2: the original with our trusted backup', disk() === SRC_SHA && fs.existsSync(TGT + '.woc-orig') && marker() === null);
        car.coding(c[1], c[2]);
        r = hook('activate');
        ok(c[0] + ', HIGH F: the re-apply writes nothing, no marker, the conflict, left for the next install', r.code === 0 && disk() === SRC_SHA && marker() === null &&
            !r.result.reset && r.result.conflict === c[3] && !fs.existsSync(MARK) && ro(), JSON.stringify(r.result));
        car.coding(7);
        r = hook('activate');
        ok(c[0] + ', HIGH F: coded 7 again, the next install applies it, on trial', r.code === 0 && r.result.reset === true && marker() && marker().action === 'apply' &&
            disk() !== SRC_SHA && view(TGT) === TRIAL, JSON.stringify([r.result, view(TGT)]));
    });
    car.set(car.HIGH);

    /* A car coded otherwise on which an earlier release's install wrote the patch and recorded it proven: while that
     * patch has not started (its apply pending, or carplay running the file it replaced), an install puts its record
     * on trial, carplay's bytes as they are. A patch that has started, and a variant-7 car's pending one, keep their
     * record; a write that fails leaves it. */
    var RECORD = record.recordPath(TGT);
    function earlierRelease(pending) {
        car.coding(7);
        reset();
        hook('activate');
        if (!pending) fs.unlinkSync(PENDING);
        record.write(TGT, { patched: true, proven: true });
    }
    [['its apply pending', true], ['carplay running the file it replaced, no marker', false]].forEach(function (c) {
        earlierRelease(c[1]);
        before = disk();
        car.coding(9);
        r = hook('activate');
        ok('coding 9, an earlier release\'s patch not started (' + c[0] + '): its record on trial, carplay as it was, / read-only', r.code === 0 && disk() === before &&
            view(TGT) === TRIAL && (marker() !== null) === c[1] && ro() && /recorded on trial/.test(r.out), JSON.stringify([r.result, view(TGT)]) + r.out);
    });
    /* The replaced file a running carplay holds may be kept under one of the other names a change gives it (.1, .2). */
    earlierRelease(false);
    fs.renameSync(TGT + '.woc-running', TGT + '.woc-running.1');
    before = disk();
    car.coding(9);
    r = hook('activate');
    ok('coding 9, an earlier release\'s patch whose replaced file runs under another name: its record on trial too', r.code === 0 && disk() === before && view(TGT) === TRIAL && ro(),
        JSON.stringify([r.result, view(TGT)]) + r.out);
    earlierRelease(true);
    var recBefore = fs.readFileSync(RECORD, 'utf8');
    car.coding(9);
    fs.writeFileSync(RW_FAILS, '');
    r = hook('activate');
    fs.unlinkSync(RW_FAILS);
    ok('coding 9, the record\'s write fails: the record as it was, exit 0, / read-only', r.code === 0 && fs.readFileSync(RECORD, 'utf8') === recBefore && view(TGT) === PROVEN && ro(), JSON.stringify([r.result, view(TGT)]));
    earlierRelease(true);
    headUnitStart();
    recBefore = fs.readFileSync(RECORD, 'utf8');
    car.coding(9);
    r = hook('activate');
    ok('coding 9, an earlier release\'s patch that started: its proven record untouched, the conflict', r.code === 0 && fs.readFileSync(RECORD, 'utf8') === recBefore &&
        r.result.conflict === 'not supported on this car (KI_KOMBI_VARIANT 9)', JSON.stringify([r.result, view(TGT)]));
    earlierRelease(true);
    recBefore = fs.readFileSync(RECORD, 'utf8');
    r = hook('activate');
    ok('coding 7, an earlier release\'s patch waiting for its start: its proven record untouched', r.code === 0 && fs.readFileSync(RECORD, 'utf8') === recBefore &&
        marker() && marker().action === 'apply', JSON.stringify([r.result, view(TGT)]));
    earlierRelease(true);
    recBefore = fs.readFileSync(RECORD, 'utf8');
    car.coding(null);
    r = hook('activate');
    ok('no coding, an earlier release\'s patch waiting for its start: its record untouched (only a car coded otherwise is put on trial)', r.code === 0 &&
        fs.readFileSync(RECORD, 'utf8') === recBefore && view(TGT) === PROVEN, JSON.stringify([r.result, view(TGT)]));
    car.coding(7);
}

async function main() {
    patcherCases();
    await daemonCases();
    hookCases();
}

main().catch(function (e) { ok('no exception', false, e.stack); }).then(function () {
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
