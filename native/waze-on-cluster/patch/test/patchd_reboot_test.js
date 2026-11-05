#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* patchd's Restart head unit against a fake nsm_control: the request it
 * sends (`--requestRestart 7 --normal`), a restart NSM takes, nsm_control's
 * "[Error. <why>]" on stdout with exit 0, a non-zero exit, and a unit that
 * stays up past the wait. A failed request ends the restart with its reason
 * in status's restart field, leaves CarPlay's state as it was and lets the
 * next request through; one NSM took keeps the 10-minute limit, which
 * status reports. Only Android Auto's change pending is enough. Pending
 * markers carry the boot id; one from an earlier boot counts as done and is
 * removed, this boot's and one without a boot id are kept whatever their
 * time. No firmware: carplay is a stand-in file, aapd absent.
 *
 *   node patchd_reboot_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit for every patcher and patchd this runs */
process.env.WOC_TEST = '1';   /* the override below is honoured only with this */
process.env.WOC_AA_ENABLED = '1';   /* Android Auto is opt-in (aa_enabled.js); this test is about its pending marker */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var fails = 0, children = [], dirs = [];
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    dirs.forEach(function (d) { try { cp.execFileSync('rm', ['-rf', d]); } catch (e) {} });
});

/* A unit with a pending change (CarPlay's, or the marker `marker` names);
 * nsm_control answers as `mode` says. */
function unit(waitMs, marker) {
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rb-'));
    dirs.push(d);
    ['shm', 'var', 'bin', 'units'].forEach(function (x) { fs.mkdirSync(path.join(d, x)); });
    var t = { d: d, calls: path.join(d, 'calls'), mode: path.join(d, 'mode'), sock: path.join(d, 'shm', 'patch.sock') };
    fs.writeFileSync(t.calls, '');
    fs.writeFileSync(path.join(d, 'carplay'), 'not a carplay build\n');
    fs.writeFileSync(path.join(d, 'mounts'), '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(path.join(d, 'boot_id'), 'boot-2\n');
    fs.writeFileSync(path.join(d, 'stat'), 'btime ' + Math.floor(Date.now() / 1000 - 60) + '\n');
    fs.writeFileSync(path.join(d, 'shm', marker || 'activation-pending'), JSON.stringify({ action: 'apply', boot: 'boot-2' }) + '\n');
    var nsm = path.join(d, 'bin', 'nsm_control');
    fs.writeFileSync(nsm, '#!/bin/sh\necho "$*" >> "' + t.calls + '"\ncase "$(cat "' + t.mode + '")" in\n' +
        'error) echo "[Error. ProxyLifecycleControl not available!]";;\n' +
        'exit) echo "nsm_control: cannot reach NSM" >&2; exit 3;;\n' +
        '*) echo "[Info. request sent]";;\nesac\n');
    fs.chmodSync(nsm, 0o755);
    t.env = Object.assign({}, process.env, {
        PATH: path.join(d, 'bin') + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: t.sock, WOC_CARPLAY: path.join(d, 'carplay'), WOC_AAPD: path.join(d, 'none'),
        WOC_AAPD_CONF: path.join(d, 'none'), WOC_CODING: path.join(d, 'none'), WOC_PROC_MOUNTS: path.join(d, 'mounts'),
        WOC_MOUNT: '/usr/bin/true', WOC_UNIT_DIRS: path.join(d, 'units'), WOC_CAPTURE_SOCK: path.join(d, 'none.sock'),
        WOC_DLT_RECEIVE: path.join(d, 'none'), WOC_DLT_RETRY_MS: '600000', WOC_REMOUNT_LOCK: path.join(d, 'shm', 'remount.lock'),
        WOC_STATE_DIR: path.join(d, 'var'), WOC_REBOOT_CMD: nsm + ' --requestRestart 7 --normal',
        WOC_REBOOT_WAIT_MS: String(waitMs || 600000), WOC_BOOT_ID: path.join(d, 'boot_id'), WOC_PROC_STAT: path.join(d, 'stat')
    });
    return t;
}

function daemon(t) {
    var c = cp.spawn(process.execPath, [PATCHD], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(c);
    var log = '';
    c.stdout.on('data', function (b) { log += b; });
    c.stderr.on('data', function (b) { log += b; });
    return new Promise(function (resolve, reject) {
        (function wait(n) {
            if (!fs.existsSync(t.sock)) {
                if (n > 200) { reject(new Error('patchd did not listen: ' + log)); return; }
                setTimeout(function () { wait(n + 1); }, 50);
                return;
            }
            var s = net.connect(t.sock), buf = '', waiters = [];
            var api = {
                send: function (o) { s.write(JSON.stringify(o) + '\n'); },
                next: function (pred, ms) {
                    return new Promise(function (res, rej) {
                        var tm = setTimeout(function () { rej(new Error('timeout; log: ' + log.slice(-800))); }, ms || 20000);
                        waiters.push({ pred: pred, res: function (m) { clearTimeout(tm); res(m); } });
                    });
                }
            };
            s.setEncoding('utf8');
            s.on('data', function (chunk) {
                buf += chunk;
                var i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    var m = JSON.parse(buf.slice(0, i));
                    buf = buf.slice(i + 1);
                    waiters = waiters.filter(function (w) { if (w.pred(m)) { w.res(m); return false; } return true; });
                }
            });
            s.on('connect', function () { resolve(api); });
        })(0);
    });
}

function calls(t) { return fs.readFileSync(t.calls, 'utf8').split('\n').filter(Boolean); }
function reply(m) { return m.ev === 'reboot-reply'; }
function refused(m) { return m.ev === 'reboot-reply' && m.ok === false; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function status(p) {
    var st = p.next(function (m) { return m.ev === 'status'; });
    p.send({ cmd: 'status' });
    return st;
}

async function main() {
    var t = unit();
    var p = await daemon(t);
    var before = await status(p);

    fs.writeFileSync(t.mode, 'error');
    p.send({ cmd: 'reboot' });
    var first = await p.next(reply);
    var rb = await p.next(refused);
    var st = await status(p);
    ok('the request is NSM\'s normal restart', first.ok === true && calls(t)[0] === '--requestRestart 7 --normal', calls(t).join('; '));
    ok('"[Error. …]" with exit 0: the restart failed, refused, with its reason; CarPlay\'s state as it was', rb.reason === 'ProxyLifecycleControl not available!' &&
        st.restart.state === 'failed' && st.restart.code === 'refused' && st.restart.possibleAt === undefined &&
        st.state === before.state && st.carplay === 'deferred' && st.busy === null, JSON.stringify([rb, st]));

    fs.writeFileSync(t.mode, 'exit');
    p.send({ cmd: 'reboot' });
    first = await p.next(reply);
    rb = await p.next(refused);
    st = await status(p);
    ok('a failed request is no restart: the next one runs; a non-zero exit ends it with stderr', first.ok === true &&
        rb.reason === 'nsm_control: cannot reach NSM' && st.restart.code === 'error' && calls(t).length === 2, JSON.stringify([first, rb]));

    fs.writeFileSync(t.mode, 'ok');
    p.send({ cmd: 'reboot' });
    first = await p.next(reply);
    st = await status(p);
    ok('a restart NSM took: restarting, busy, the limit reported', first.ok === true && st.restart.state === 'restarting' && st.busy === 'restart' &&
        st.restart.possibleAt > Date.now() + 9 * 60000, JSON.stringify(st));
    p.send({ cmd: 'apply', panel: 'high', mode: 'avb' });
    var no = await p.next(function (m) { return m.ev === 'refused'; });
    p.send({ cmd: 'reboot' });
    rb = await p.next(reply);
    for (var i = 0; i < 100 && calls(t).length < 3; i++) await sleep(20);
    ok('meanwhile a command is refused to its asker alone, a second restart too', /restart is in progress/.test(no.reason) && no.cmd === 'apply' &&
        rb.ok === false && /already in progress/.test(rb.reason) && calls(t).length === 3, JSON.stringify([no, rb, calls(t)]));

    var u = unit(300);
    fs.writeFileSync(u.mode, 'ok');
    var q = await daemon(u);
    q.send({ cmd: 'reboot' });
    first = await q.next(reply);
    rb = await q.next(refused, 5000);
    st = await status(q);
    q.send({ cmd: 'reboot' });
    var again = await q.next(reply);
    ok('a unit still up after the wait: the restart failed, stayed, and its request still counts', first.ok === true &&
        rb.reason === 'the head unit did not restart' && st.restart.code === 'stayed' && st.restart.possibleAt > Date.now() &&
        again.ok === false && /possible again in \d+ min/.test(again.reason), JSON.stringify([first, rb, st, again]));

    var a = unit(0, 'aa-pending');
    fs.writeFileSync(a.mode, 'ok');
    var pa = await daemon(a);
    st = await status(pa);
    pa.send({ cmd: 'reboot' });
    rb = await pa.next(reply);
    ok('only Android Auto\'s change pending: the restart is taken, CarPlay has nothing pending', rb.ok === true && !st.pending && !st.carplay,
        JSON.stringify([rb, st]));

    /* markers from an earlier boot */
    var m = unit(0, 'aa-pending');
    fs.writeFileSync(path.join(m.d, 'shm', 'aa-pending'), JSON.stringify({ action: 'apply', boot: 'boot-1' }) + '\n');
    fs.writeFileSync(m.mode, 'ok');
    var pm = await daemon(m);
    st = await status(pm);
    pm.send({ cmd: 'reboot' });
    rb = await pm.next(reply);
    ok('a marker of another boot is done: removed, nothing pending, no restart',
        !st.pending && !st.aa.pending && rb.ok === false && /no restart is pending/.test(rb.reason) &&
        !fs.existsSync(path.join(m.d, 'shm', 'aa-pending')) && calls(m).length === 0, JSON.stringify([st, rb]));

    /* this boot's marker and an older patchd's (no boot id) are kept, the
     * clock stepped so both look older than the boot */
    var stepped = Date.now() / 1000 - 3600;
    var k = unit(0);
    var cpm = path.join(k.d, 'shm', 'activation-pending');
    fs.utimesSync(cpm, stepped, stepped);
    var pk = await daemon(k);
    st = await pk.next(function (m) { return m.ev === 'status' && m.pending; }, 5000).catch(function () { return null; });
    ok('this boot\'s marker is kept however old it looks', !!st && st.pending === 'apply' && fs.existsSync(cpm), JSON.stringify(st));
    var k2 = unit(0, 'aa-pending');
    var aam = path.join(k2.d, 'shm', 'aa-pending');
    fs.writeFileSync(aam, JSON.stringify({ action: 'apply' }) + '\n');
    fs.utimesSync(aam, stepped, stepped);
    fs.writeFileSync(k2.mode, 'ok');
    var pk2 = await daemon(k2);
    pk2.send({ cmd: 'reboot' });
    rb = await pk2.next(reply);
    ok('an older patchd\'s marker without a boot id is kept: the restart it waits for is taken', rb.ok === true && fs.existsSync(aam), JSON.stringify(rb));

    /* a marker patchd writes carries this boot's id: the removal rewrites a
     * pending revert as its own */
    var w = unit(0);
    var wm = path.join(w.d, 'shm', 'activation-pending');
    fs.writeFileSync(wm, JSON.stringify({ action: 'revert' }) + '\n');
    var hr = cp.spawnSync(process.execPath, [PATCHD, 'deactivate'], { env: w.env, encoding: 'utf8', timeout: 60000 });
    var written = JSON.parse(fs.readFileSync(wm, 'utf8'));
    ok('writePending stamps the boot id', written.boot === 'boot-2' && written.by === 'removal' && written.action === 'revert',
        JSON.stringify(written) + ' ' + hr.stdout + hr.stderr);

    process.stdout.write(fails ? fails + ' failed\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
}

main().catch(function (e) { process.stdout.write('FAIL ' + (e && e.stack) + '\n'); process.exit(1); });
