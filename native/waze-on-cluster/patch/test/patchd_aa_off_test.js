#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves S6 (Kiro test build): Android Auto is OFF unless the conf key
 * aa_enabled is 1, and with the default nothing under the aapd paths is read
 * for writing or written. The fake root holds an aapd, an aapd.conf, backups
 * of ours, the running link and the pending marker of an earlier Android Auto
 * patch; the real patchd.js runs against it with a fake mount and systemctl
 * that record every call:
 *  - status reports aa {enabled:false, state:"off"} and does not spawn the aapd
 *    patcher (its states would be absent/unknown/original/patched);
 *  - aa-apply, aa-revert, aa-density and aa-card are refused, change nothing,
 *    remount nothing, write no state file;
 *  - a pending Android Auto marker alone does not make a restart "pending";
 *  - patchd's start keeps a stale aapd running link (it only drops CarPlay's);
 *  - the install and removal hooks (activate, deactivate) leave every aapd path
 *    as it was, exit 0, and say so;
 *  - the switch is the conf key (shipped file, then local file, last wins,
 *    anything but 1 is off), read at each use: flipping it takes effect
 *    without restarting patchd, and with 1 the aapd patcher is consulted;
 *  - the component enables no aa-boot unit, installs it, ships aa_enabled.js,
 *    and the shipped conf does not turn Android Auto on.
 * (The other tests set WOC_AA_ENABLED=1 where they are about Android Auto.)
 *
 *   node patchd_aa_off_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit for every patcher and patchd this runs */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');
var synthetic = require('./synthetic_carplay.js');
var aaSwitch = require('../aa_enabled.js');

var PATCH = path.join(__dirname, '..');
var PATCHD = path.join(PATCH, 'patchd.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  -- ' + detail : '') + '\n');
    if (!cond) fails++;
}

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-aaoff-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});

/* ---- the switch itself (aa_enabled.js) ---- */
(function switchTests() {
    var saved = {};
    ['WOC_AA_ENABLED', 'WOC_CONF', 'WOC_LOCAL_CONF', 'WOC_STATE_DIR'].forEach(function (k) { saved[k] = process.env[k]; delete process.env[k]; });
    function conf(name, text) { var f = path.join(dir, name); if (text === null) { try { fs.unlinkSync(f); } catch (e) {} } else fs.writeFileSync(f, text); return f; }
    var shipped = path.join(dir, 'sw-shipped.conf'), local = path.join(dir, 'sw-local.conf');
    process.env.WOC_CONF = shipped;
    process.env.WOC_LOCAL_CONF = local;
    function on(s, l) { conf('sw-shipped.conf', s); conf('sw-local.conf', l); return aaSwitch.enabled(); }

    ok('switch: no conf files at all is off', on(null, null) === false);
    ok('switch: a conf without the key is off', on('target = map\n', 'verbose = 1\n') === false);
    ok('switch: aa_enabled = 0 is off', on('aa_enabled = 0\n', null) === false);
    ok('switch: aa_enabled = 1 in the local conf is on', on('aa_enabled = 0\n', 'aa_enabled = 1\n') === true);
    ok('switch: aa_enabled = 1 in the shipped conf alone is on', on('aa_enabled = 1\n', null) === true);
    ok('switch: the local conf wins over the shipped one', on('aa_enabled = 1\n', 'aa_enabled = 0\n') === false);
    ok('switch: the last assignment in a file wins', on(null, 'aa_enabled = 1\naa_enabled = 0\n') === false && on(null, 'aa_enabled = 0\naa_enabled = 1\n') === true);
    ok('switch: a commented line is nothing', on('# aa_enabled = 1\n', '   # aa_enabled = 1\n') === false);
    ok('switch: a trailing comment is cut', on(null, 'aa_enabled = 1   # on\n') === true && on(null, 'aa_enabled = 0 # was 1\n') === false);
    ok('switch: only the value 1 turns it on', ['2', 'true', 'yes', 'on', '', '01', '1x', '-1'].every(function (v) { return on(null, 'aa_enabled = ' + v + '\n') === false; }));
    ok('switch: another key that ends in the name is not the key', on(null, 'xaa_enabled = 1\nhide_aa_enabled=1\n') === false);
    ok('switch: no spaces around = is fine, CRLF too', on(null, 'aa_enabled=1\r\n') === true);
    ok('switch: an unreadable conf (a directory) is off', (function () { conf('sw-local.conf', null); fs.mkdirSync(local); var v = aaSwitch.enabled(); fs.rmdirSync(local); return v === false; })());
    process.env.WOC_AA_ENABLED = '1';
    ok('switch: the test override WOC_AA_ENABLED=1 beats the files', on(null, 'aa_enabled = 0\n') === true);
    process.env.WOC_AA_ENABLED = '0';
    ok('switch: the test override WOC_AA_ENABLED=0 beats the files', on(null, 'aa_enabled = 1\n') === false);
    delete process.env.WOC_AA_ENABLED;
    /* The default local conf lives in the state dir. */
    delete process.env.WOC_LOCAL_CONF;
    process.env.WOC_STATE_DIR = path.join(dir, 'sw-state');
    fs.mkdirSync(process.env.WOC_STATE_DIR);
    conf('sw-shipped.conf', null);
    fs.writeFileSync(path.join(process.env.WOC_STATE_DIR, 'waze-on-cluster.local.conf'), 'aa_enabled = 1\n');
    ok('switch: the local conf defaults to waze-on-cluster.local.conf in the state dir', aaSwitch.enabled() === true);
    ok('switch: the shipped conf of this repo does not turn it on', (function () {
        delete process.env.WOC_CONF; delete process.env.WOC_STATE_DIR;
        process.env.WOC_LOCAL_CONF = path.join(dir, 'none.conf');
        var text = fs.readFileSync(path.join(PATCH, '..', 'waze-on-cluster.conf'), 'utf8');
        var v = aaSwitch.parse(text);
        return v === null || v === '0';
    })());
    ['WOC_AA_ENABLED', 'WOC_CONF', 'WOC_LOCAL_CONF', 'WOC_STATE_DIR'].forEach(function (k) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
})();

/* ---- the component: no AA boot unit enabled, the switch shipped ---- */
(function componentTests() {
    var c = JSON.parse(fs.readFileSync(path.join(PATCH, '..', 'component.json'), 'utf8'));
    ok('component: the aa boot unit is not enabled', !c.enable.some(function (e) { return /aa-boot/.test(e.unit); }), JSON.stringify(c.enable));
    ok('component: the aa boot unit is still installed (for whoever opts in)', c.units.some(function (u) { return u.name === 'waze-on-cluster-aa-boot.service'; }));
    ok('component: the CarPlay boot unit stays enabled', c.enable.some(function (e) { return e.unit === 'waze-on-cluster-boot.service'; }));
    ok('component: aa_enabled.js is shipped', c.files.some(function (f) { return f.path === 'aa_enabled.js' && f.from === 'patch/aa_enabled.js'; }));
    var unit = fs.readFileSync(path.join(PATCH, '..', 'systemd', 'waze-on-cluster-aa-boot.service'), 'utf8');
    ok('component: the aa boot unit says it is opt-in', /aa_enabled/.test(unit) && /NOT enabled/.test(unit));
})();

/* ---- patchd against a fake root that holds an old Android Auto patch ---- */
var TGT = path.join(dir, 'usr', 'carplay');
var AAPD = path.join(dir, 'usr', 'aapd');
var AAPD_CONF = path.join(dir, 'etc', 'aapd.conf');
fs.mkdirSync(path.dirname(TGT));
fs.mkdirSync(path.dirname(AAPD_CONF));
var CP_SRC = synthetic.build({}).buf;
fs.writeFileSync(TGT, CP_SRC);
fs.chmodSync(TGT, 0o755);
function rnd(n) { return crypto.randomBytes(n); }
fs.writeFileSync(AAPD, rnd(4096)); fs.chmodSync(AAPD, 0o755);
fs.writeFileSync(AAPD_CONF, 'dpi=160\n');
fs.writeFileSync(AAPD + '.woc-orig', rnd(4096));
fs.writeFileSync(AAPD + '.woc-orig.json', '{"sha256_original":"x"}\n');
fs.writeFileSync(AAPD_CONF + '.woc-orig', 'dpi=240\n');
fs.writeFileSync(AAPD_CONF + '.woc-orig.json', '{"sha256_original":"y"}\n');
fs.writeFileSync(AAPD + '.woc-tmp.1', 'x');
fs.linkSync(AAPD, AAPD + '.woc-running');

var SOCKDIR = path.join(dir, 'sock');
var SOCK = path.join(SOCKDIR, 'patch.sock');
fs.mkdirSync(SOCKDIR);
var AA_PENDING = path.join(SOCKDIR, 'aa-pending');
var STATE = path.join(dir, 'var');
fs.mkdirSync(STATE);
fs.writeFileSync(AA_PENDING, JSON.stringify({ action: 'apply', boot: 'boot-1' }) + '\n');
fs.writeFileSync(path.join(STATE, 'aa-crop.env'), 'WOC_SRC_CROP=-s src_crop=1280x720:0,0,1280,500\n');

var MOUNTS = path.join(dir, 'mounts');
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
var CALLS = path.join(dir, 'calls');
fs.writeFileSync(CALLS, '');
var BIN = path.join(dir, 'bin');
fs.mkdirSync(BIN);
['systemctl', 'kill', 'reboot'].forEach(function (n) {
    fs.writeFileSync(path.join(BIN, n), '#!/bin/sh\necho "' + n + ' $*" >> "' + CALLS + '"\ncase "$1" in show) echo MainPID=0 ;; esac\nexit 0\n');
    fs.chmodSync(path.join(BIN, n), 0o755);
});
fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(BIN, 'journalctl'), 0o755);
var MOUNT = path.join(dir, 'mount');
fs.writeFileSync(MOUNT, '#!/bin/sh\necho "mount $*" >> "' + CALLS + '"\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '" ;; ' +
    '*remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + MOUNTS + '" ;; esac\nexit 0\n');
fs.chmodSync(MOUNT, 0o755);

var LOCAL_CONF = path.join(dir, 'local.conf');
var ENV = Object.assign({}, process.env, {
    PATH: BIN + path.delimiter + process.env.PATH,
    WOC_PATCH_SOCK: SOCK,
    WOC_CARPLAY: TGT,
    WOC_AAPD: AAPD,
    WOC_AAPD_CONF: AAPD_CONF,
    WOC_CODING: path.join(dir, 'no-coding'),
    WOC_MOUNT: MOUNT,
    WOC_PROC_MOUNTS: MOUNTS,
    WOC_RESTART_POLL_MS: '20',
    WOC_RECMGR_CONF: path.join(dir, 'no-recmgr.conf'),
    WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
    WOC_CARPLAY_DROPIN: path.join(dir, 'no-dropin.conf'),
    WOC_PROC_STAT: path.join(dir, 'no-stat'),
    WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
    WOC_UNIT_DIRS: path.join(dir, 'units'),
    WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
    WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
    WOC_DLT_RETRY_MS: '600000',
    WOC_REBOOT_CMD: path.join(BIN, 'reboot'),
    WOC_STATE_DIR: STATE,
    WOC_REMOUNT_LOCK: path.join(SOCKDIR, 'remount.lock'),
    WOC_OP_LOCK_WAIT_MS: '500',
    WOC_PROC: path.join(dir, 'proc'),
    WOC_CONF: path.join(dir, 'shipped.conf'),
    WOC_LOCAL_CONF: LOCAL_CONF,
    WOC_DENSITY_SPACING_MS: '100',
});
delete ENV.WOC_AA_ENABLED;   /* the files decide, as on the car */
fs.mkdirSync(path.join(dir, 'proc'));
fs.writeFileSync(ENV.WOC_CONF, '# the shipped conf: no aa_enabled line\ntarget = map\n');

/* Everything that belongs to Android Auto: content, inode, mode and times. */
function aaPaths() {
    var names = [AAPD, AAPD_CONF].reduce(function (a, f) { return a.concat([f, f + '.woc-orig', f + '.woc-orig.json', f + '.woc-running', f + '.woc-tmp.1']); }, []);
    return names.concat([AA_PENDING, path.join(SOCKDIR, 'aapd-killed'), path.join(STATE, 'aa-density'), path.join(STATE, 'aa-card'), path.join(STATE, 'aa-crop.env'),
        path.join(STATE, 'aa-boot-recovery.json'), path.join(SOCKDIR, 'aa-pending.tmp')]);
}
function snapshot() {
    var s = {};
    aaPaths().forEach(function (f) {
        try {
            var st = fs.lstatSync(f);
            s[f] = [st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs, st.nlink, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')].join(' ');
        } catch (e) { s[f] = 'absent'; }
    });
    return JSON.stringify(s);
}
function calls() { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean); }

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function startDaemon() {
    var d = cp.spawn(process.execPath, [PATCHD], { env: ENV, stdio: ['ignore', 'ignore', 'inherit'] });
    children.push(d);
    return d;
}

/* Connect, optionally send cmd, resolve to the first message done(msg) accepts. */
function session(cmd, done) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(SOCK), buf = '', sent = !cmd;
        var timer = setTimeout(function () { c.destroy(); reject(new Error('timed out waiting on ' + JSON.stringify(cmd))); }, 20000);
        c.setEncoding('utf8');
        c.on('error', reject);
        c.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var m = JSON.parse(buf.slice(0, i));
                buf = buf.slice(i + 1);
                if (m.ev !== 'status' && m.ev !== 'refused' && m.ev !== 'reboot-reply') continue;
                if (!sent) { if (m.ev === 'status') { sent = true; c.write(JSON.stringify(cmd) + '\n'); } continue; }
                if (done(m)) { clearTimeout(timer); c.destroy(); resolve(m); return; }
            }
        });
    });
}
function status() { return session(null, function (m) { return m.ev === 'status' && m.state !== 'busy'; }); }
function refusal(cmd) { return session(cmd, function (m) { return m.ev === 'refused' || (m.ev === 'status' && m.aa && m.aa.state === 'busy'); }); }
function reboot() { return session({ cmd: 'reboot' }, function (m) { return m.ev === 'reboot-reply'; }); }

function hook(which) {
    var r = cp.spawnSync(process.execPath, [PATCHD, which], { env: ENV, encoding: 'utf8', timeout: 60000 });
    var line = (r.stdout || '').trim().split('\n').pop(), res = {};
    try { res = JSON.parse(line); } catch (e) {}
    return { code: r.status, res: res, raw: (r.stdout || '') + (r.stderr || '') };
}

async function main() {
    var before = snapshot();
    ok('fixture: the fake root has the aapd files of an earlier Android Auto patch', JSON.parse(before)[AAPD] !== 'absent' && JSON.parse(before)[AAPD + '.woc-orig'] !== 'absent' &&
        JSON.parse(before)[AAPD + '.woc-running'] !== 'absent' && JSON.parse(before)[AA_PENDING] !== 'absent');

    var d = startDaemon();
    for (var i = 0; i < 200 && !fs.existsSync(SOCK); i++) await sleep(25);
    var r = await status();
    ok('status: aa is {enabled:false, state:"off"} with the reason', r.aa && r.aa.enabled === false && r.aa.state === 'off' && /aa_enabled = 0/.test(r.aa.reason || ''), JSON.stringify(r.aa));
    ok('status: no aapd conflict, no pending, no dpi reported', r.aa && !r.aa.conflict && !r.aa.pending && r.aa.dpi === undefined && !r.aa.aapd, JSON.stringify(r.aa));
    ok('status: CarPlay is reported as ever (the synthetic stock build, unproven)', r.state === 'original' && r.unproven === true, JSON.stringify(r));
    ok('daemon start: the stale aapd running link is kept, nothing remounted', fs.existsSync(AAPD + '.woc-running') && calls().length === 0, JSON.stringify(calls()));

    var refused = {};
    var cmds = [{ cmd: 'aa-apply' }, { cmd: 'aa-revert' }, { cmd: 'aa-density', value: 200 }, { cmd: 'aa-card', value: 'hidden' }];
    for (var k = 0; k < cmds.length; k++) refused[cmds[k].cmd] = await refusal(cmds[k]);
    ok('aa-apply, aa-revert, aa-density, aa-card: each refused with the off reason',
        cmds.every(function (c) { var m = refused[c.cmd]; return m.ev === 'refused' && m.cmd === c.cmd && /aa_enabled = 0/.test(m.reason || ''); }), JSON.stringify(refused));
    ok('refused: every aapd path is exactly as it was (content, inode, mode, times)', snapshot() === before);
    ok('refused: no remount, no systemctl, no kill', calls().length === 0, JSON.stringify(calls()));
    ok('refused: the density and card choices were not saved', !fs.existsSync(path.join(STATE, 'aa-density')) && !fs.existsSync(path.join(STATE, 'aa-card')));
    r = await status();
    ok('after the refusals: still off, patchd not busy', r.aa.state === 'off' && !r.busy, JSON.stringify(r));

    var rb = await reboot();
    ok('reboot: an Android Auto pending marker alone is not a pending restart', rb.ok === false && /no restart is pending/.test(rb.reason || ''), JSON.stringify(rb));
    ok('reboot: nothing was run', calls().length === 0 && snapshot() === before, JSON.stringify(calls()));

    /* Flip the switch in the local conf without restarting patchd: read at each use. */
    fs.writeFileSync(LOCAL_CONF, 'aa_enabled = 1\n');
    r = await status();
    ok('conf aa_enabled = 1: at once on, the aapd patcher is consulted (no longer "off")', r.aa.enabled === true && r.aa.state !== 'off', JSON.stringify(r.aa));
    rb = await reboot();
    ok('conf aa_enabled = 1: the Android Auto pending marker is a pending restart again', rb.ok === true, JSON.stringify(rb));
    d.kill('SIGKILL');
    await sleep(100);
    try { fs.unlinkSync(SOCK); } catch (e) {}
    /* the reboot above wrote reboot records and a restart marker: not aapd paths. Reset the call log. */
    fs.writeFileSync(CALLS, '');
    fs.writeFileSync(LOCAL_CONF, 'aa_enabled = 0\n');
    ['reboots.json', 'restart-requested'].forEach(function (n) { try { fs.unlinkSync(path.join(STATE, n)); } catch (e) {} });
    before = snapshot();

    /* The hooks. CarPlay's step finds the synthetic stock build unproven (a
     * conflict, nothing written); the Android Auto step must not run. */
    var a = hook('activate');
    ok('activate: exits 0 and names Android Auto as off', a.code === 0 && a.res.aa && /aa_enabled = 0/.test(a.res.aa.status || ''), a.raw);
    ok('activate: a backup of an earlier Android Auto patch is mentioned, not used', a.res.aa && /backup of an earlier Android Auto patch/.test(a.res.aa.status || ''), a.raw);
    ok('activate: every aapd path is exactly as it was', snapshot() === before);
    ok('activate: no remount, no systemctl, CarPlay unproven stays unpatched', calls().length === 0 && fs.readFileSync(TGT).equals(CP_SRC), JSON.stringify(calls()));
    ok('activate: no reboot needed reported for the old aa-pending marker', !a.res.reboot, a.raw);
    var x = hook('deactivate');
    ok('deactivate: exits 0 (the removal is not held back by Android Auto being off)', x.code === 0, x.raw);
    ok('deactivate: aapd, aapd.conf, backups, running link, markers all exactly as they were', snapshot() === before);
    ok('deactivate: no remount for aapd; the old aapd running link is not handed to the deploy tool', calls().length === 0 && !(x.res.removeWhenUnused || []).some(function (f) { return /aapd/.test(f); }),
        JSON.stringify([calls(), x.res]));

    /* The same fake root with the switch on: the hooks do consult aapd (the
     * existing aapd tests cover what they then do). */
    fs.writeFileSync(LOCAL_CONF, 'aa_enabled = 1\n');
    var on = hook('activate');
    ok('aa_enabled = 1: activate runs the Android Auto step (its result is not the off text)', on.res.aa && !/aa_enabled = 0/.test(on.res.aa.status || ''), on.raw);
}

main().catch(function (e) { ok('no exception', false, e.stack); }).then(function () {
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
