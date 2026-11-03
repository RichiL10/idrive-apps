#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The atomic CarPlay write (carplay_patch.js writeInPlace) on a synthetic
 * build (synthetic_carplay.js): a write keeps the target's mode (also 0555
 * for a caller that is not root), its owner and set-id bits (as root) and
 * its extended attributes; and every refusal leaves the target's bytes,
 * owner and mode unchanged and no .woc-tmp.* file behind: an attribute
 * setfattr cannot copy, an attribute that does not read back, temp bytes
 * that do not read back, a rename that fails, a folder it cannot write.
 * getfattr and setfattr are fakes on PATH (WOC_FAKE_XATTR picks the fault).
 * Kiro test change (0.7.10).
 *
 *   node atomic_write_test.js
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var synthetic = require('./synthetic_carplay.js');

var PATCHER = path.join(__dirname, '..', 'carplay_patch.js');
var ROOT = process.getuid && process.getuid() === 0;

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  -- ' + detail : '') + '\n');
    if (!cond) fails++;
}
function skip(name, why) { process.stdout.write('SKIP ' + name + ' (' + why + ')\n'); }

var top = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-atomic-'));
process.on('exit', function () {
    try { cp.execFileSync('chmod', ['-R', 'u+rwx', top]); } catch (e) {}
    try { cp.execFileSync('rm', ['-rf', top]); } catch (e) {}
});

var BIN = path.join(top, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'getfattr'), '#!/bin/sh\n' +
    'for f; do :; done\n' +
    'case "$WOC_FAKE_XATTR" in none|"") exit 0 ;; esac\n' +
    'case "$f" in *.woc-tmp.*)\n' +
    '  case "$WOC_FAKE_XATTR" in lost) exit 0 ;; grow) printf x >> "$f" ;; vanish) rm -f "$f" ;; esac ;;\n' +
    'esac\n' +
    'printf "# file: %s\\nsecurity.capability=0x0100\\n\\n" "$f"\n');
fs.writeFileSync(path.join(BIN, 'setfattr'), '#!/bin/sh\n' +
    'case "$WOC_FAKE_XATTR" in fail-set) echo "setfattr: Operation not permitted" >&2; exit 1 ;; esac\nexit 0\n');
fs.chmodSync(path.join(BIN, 'getfattr'), 0o755);
fs.chmodSync(path.join(BIN, 'setfattr'), 0o755);

var SRC = synthetic.build({}).buf;
var n = 0;

/* A fresh folder holding the stock synthetic build with the given mode. */
function world(mode) {
    var d = path.join(top, 'w' + (n++));
    fs.mkdirSync(d);
    var t = path.join(d, 'carplay');
    fs.writeFileSync(t, SRC);
    fs.chmodSync(t, mode);
    return t;
}
function run(target, args, fault) {
    return cp.spawnSync(process.execPath, [PATCHER].concat(args, ['--target', target, '--yes']), {
        encoding: 'utf8', timeout: 30000,
        env: Object.assign({}, process.env, { PATH: BIN + path.delimiter + process.env.PATH, WOC_FAKE_XATTR: fault || 'none' }),
    });
}
function apply(target, fault) { return run(target, ['apply', '--panel', 'high', '--unproven'], fault); }
function snap(t) { var st = fs.statSync(t); return { bytes: fs.readFileSync(t), mode: st.mode & 0o7777, uid: st.uid, gid: st.gid }; }
function temps(t) { return fs.readdirSync(path.dirname(t)).filter(function (x) { return /\.woc-tmp/.test(x); }); }
function unchanged(name, t, before, r, why) {
    var after = snap(t);
    ok(name + ': refused', r.status !== 0 && why.test(r.stderr) && /unchanged/.test(r.stderr), 'status ' + r.status + ' ' + r.stderr);
    ok(name + ': target bytes unchanged', after.bytes.equals(before.bytes));
    ok(name + ': owner and mode unchanged', after.mode === before.mode && after.uid === before.uid && after.gid === before.gid,
        JSON.stringify([after.mode.toString(8), after.uid, after.gid, before.mode.toString(8), before.uid, before.gid]));
    ok(name + ': no temp file left', temps(t).length === 0, temps(t).join(','));
}

/* Success, no attributes: mode 0555 (no owner write) is kept, also for a
 * caller that is not root (one descriptor writes, sets the mode, fsyncs). */
var t = world(0o555), b = snap(t), r = apply(t, 'none');
ok('mode 0555: written', r.status === 0 && /patched OK/.test(r.stdout), r.stderr);
ok('mode 0555: bytes changed, mode kept', !fs.readFileSync(t).equals(SRC) && (fs.statSync(t).mode & 0o7777) === 0o555,
    (fs.statSync(t).mode & 0o7777).toString(8));
ok('mode 0555: no temp file left', temps(t).length === 0);
r = run(t, ['revert'], 'none');
ok('mode 0555: reverted to the original, mode kept', r.status === 0 && fs.readFileSync(t).equals(SRC) && (fs.statSync(t).mode & 0o7777) === 0o555, r.stderr);

/* Success with an attribute: copied to the temp file and checked. */
t = world(0o751); r = apply(t, 'copy');
ok('an extended attribute: copied, written', r.status === 0 && /carries extended attributes: security\.capability; copying them/.test(r.stdout), r.stdout + r.stderr);
ok('an extended attribute: mode kept, no temp left', (fs.statSync(t).mode & 0o7777) === 0o751 && temps(t).length === 0);

/* Owner, group and set-id bits (chown clears them, chmod restores them). */
if (ROOT) {
    t = world(0o751);
    fs.chownSync(t, 1234, 2345);
    fs.chmodSync(t, 0o4751);   /* after the chown, which clears set-id bits */
    r = apply(t, 'none');
    var st = fs.statSync(t);
    ok('owner, group and set-uid kept', r.status === 0 && st.uid === 1234 && st.gid === 2345 && (st.mode & 0o7777) === 0o4751,
        [r.stderr, st.uid, st.gid, (st.mode & 0o7777).toString(8)].join(' '));
} else {
    skip('owner, group and set-uid kept', 'needs root to chown');
}

/* Refusals. */
t = world(0o751); b = snap(t); r = apply(t, 'fail-set');
unchanged('setfattr fails', t, b, r, /cannot copy extended attribute security\.capability/);

t = world(0o751); b = snap(t); r = apply(t, 'lost');
unchanged('an attribute that does not read back', t, b, r, /extended attributes not preserved: security\.capability/);

t = world(0o751); b = snap(t); r = apply(t, 'grow');
unchanged('temp bytes that do not read back', t, b, r, /temp file verification failed/);

t = world(0o751); b = snap(t); r = apply(t, 'vanish');
unchanged('a rename that fails', t, b, r, /rename .* failed .*not rewritten in place/);

/* A folder it cannot write: the first apply writes the backup, the revert
 * keeps it, then the folder goes read-only. Root ignores the mode. */
if (!ROOT) {
    t = world(0o751);
    r = apply(t, 'none');
    var r2 = run(t, ['revert'], 'none');
    ok('read-only folder: setup', r.status === 0 && r2.status === 0 && fs.readFileSync(t).equals(SRC), r.stderr + r2.stderr);
    fs.chmodSync(path.dirname(t), 0o555);
    b = snap(t); r = apply(t, 'none');
    fs.chmodSync(path.dirname(t), 0o755);
    unchanged('read-only folder', t, b, r, /writing .*\.woc-tmp\.\d+: EACCES/);
} else {
    skip('read-only folder', 'root ignores the folder mode');
}

if (fails) { process.stdout.write(fails + ' FAILED\n'); process.exit(1); }
process.stdout.write('all passed\n');
