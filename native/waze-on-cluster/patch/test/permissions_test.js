#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/* Executable permissions across apply, revert and the recovery restore,
 * under a restrictive installer umask. Uses only synthetic ELF fixtures. */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
require('./head_unit_env.js');
var synthetic = require('./synthetic_carplay.js');
var script = path.join(__dirname, '..', 'carplay_patch.js');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-permissions-'));
var target = path.join(dir, 'carplay');
var preload = path.join(dir, 'preload.js');
var original = synthetic.build().buf;
var checks = 0;

function mode(file) { return fs.statSync(file).mode & 0o7777; }
function run(cmd, yes, busy) {
    var args = ['--require', preload, script, cmd, '--target', target];
    if (cmd === 'apply') args = args.concat(['--panel', 'high', '--unproven']);
    if (yes) args.push('--yes');
    return cp.spawnSync(process.execPath, args, {
        encoding: 'utf8', env: Object.assign({}, process.env, { WOC_TEST_BUSY: busy ? '1' : '' })
    });
}
function success(r) { assert.strictEqual(r.status, 0, r.stdout + r.stderr); }
function check(name, fn) { fn(); checks++; console.log('ok   ' + name); }
function statusRestorable(want) {
    var r = run('status'); success(r);
    assert.strictEqual(/^restorable: yes$/m.test(r.stdout), want, r.stdout);
}

try {
    fs.writeFileSync(preload, "process.umask(0o077);\n" +
        "if (process.env.WOC_TEST_BUSY === '1') { var fs = require('fs'), rename = fs.renameSync;" +
        " fs.renameSync = function(a, b) { if (/\\.woc-tmp(\\.\\d+)?$/.test(a)) { var e = new Error('busy'); e.code = 'EBUSY'; throw e; } return rename(a, b); }; }\n");
    fs.writeFileSync(target, original);
    fs.chmodSync(target, 0o755);
    var owner = fs.statSync(target);

    check('apply under umask 077 keeps 0755 and ownership; backup stays private', function () {
        success(run('apply', true));
        assert.strictEqual(mode(target), 0o755);
        assert.strictEqual(fs.statSync(target).uid, owner.uid);
        assert.strictEqual(fs.statSync(target).gid, owner.gid);
        assert.strictEqual(mode(target + '.woc-orig'), 0o600);
    });
    check('idempotent apply repairs 0700 only with --yes', function () {
        fs.chmodSync(target, 0o700);
        assert.notStrictEqual(run('apply').status, 0);
        assert.strictEqual(mode(target), 0o700);
        success(run('apply', true));
        assert.strictEqual(mode(target), 0o755);
    });
    check('revert under umask 077 restores original bytes and 0755', function () {
        fs.chmodSync(target, 0o700);
        success(run('revert', true));
        assert(fs.readFileSync(target).equals(original));
        assert.strictEqual(mode(target), 0o755);
    });
    check('original bytes with 0700 request recovery; status is read-only', function () {
        fs.chmodSync(target, 0o700);
        statusRestorable(true);
        assert.strictEqual(mode(target), 0o700);
    });
    check('permissions-only revert needs --yes, repairs mode and clears recovery request', function () {
        assert.notStrictEqual(run('revert').status, 0);
        assert.strictEqual(mode(target), 0o700);
        success(run('revert', true));
        assert(fs.readFileSync(target).equals(original));
        assert.strictEqual(mode(target), 0o755);
        statusRestorable(false);
    });
    check('an existing restrictive temporary file gets executable permissions', function () {
        fs.writeFileSync(target + '.woc-tmp', 'interrupted write', { mode: 0o600 });
        success(run('apply', true));
        assert.strictEqual(mode(target), 0o755);
        success(run('revert', true));
    });
    check('a busy rename refuses apply and revert (S1: no in-place fallback); the target, its mode and its folder are as they were, and a mode repair needs no rename', function () {
        var before = fs.readFileSync(target), ino = fs.statSync(target).ino;
        fs.chmodSync(target, 0o700);
        var r = run('apply', true, true);
        assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
        assert(/not rewritten in place/.test(r.stderr) && /unchanged/.test(r.stderr), r.stderr);
        assert(fs.readFileSync(target).equals(before));
        assert.strictEqual(fs.statSync(target).ino, ino);
        assert.strictEqual(mode(target), 0o700);
        assert.deepStrictEqual(fs.readdirSync(dir).filter(function (n) { return /\.woc-tmp/.test(n); }), []);
        /* the original's bytes with a wrong mode: apply's repair and revert's repair set the mode in place, no rename */
        fs.chmodSync(target, 0o700);
        success(run('revert', true, true));
        assert.strictEqual(mode(target), 0o755);
        assert(fs.readFileSync(target).equals(original));
        assert.strictEqual(fs.statSync(target).ino, ino);
    });
    check('a firmware replacement is not eligible for permissions-only recovery', function () {
        var other = synthetic.build({ pad: 16 }).buf;
        fs.writeFileSync(target, other);
        fs.chmodSync(target, 0o700);
        statusRestorable(false);
        assert.notStrictEqual(run('revert', true).status, 0);
        assert.strictEqual(mode(target), 0o700);
        assert(fs.readFileSync(target).equals(other));
    });
    check('an original at 0555 runs for carplay.service\'s user: apply and revert leave its mode', function () {
        fs.writeFileSync(target, original);
        fs.chmodSync(target, 0o555);
        statusRestorable(false);
        success(run('revert'));
        assert.strictEqual(mode(target), 0o555);
        success(run('apply', true));
        success(run('revert', true));
        assert(fs.readFileSync(target).equals(original));
        fs.chmodSync(target, 0o555);
        success(run('revert'));
        assert.strictEqual(mode(target), 0o555);
        fs.chmodSync(target, 0o700);
    });
    check('unknown equal bytes and backup do not request permissions-only recovery', function () {
        fs.writeFileSync(target, 'unknown build');
        fs.writeFileSync(target + '.woc-orig', 'unknown build');
        fs.unlinkSync(target + '.woc-orig.json');
        statusRestorable(false);
        assert.strictEqual(mode(target), 0o700);
    });
    console.log('\n' + checks + ' checks passed');
} finally {
    cp.execFileSync('rm', ['-rf', dir]);
}
