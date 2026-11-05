#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* file_mode.js under umask 077: a replaced file gets its original's mode
 * with at least the floor's bits and its original's owner, whatever the
 * umask and whatever a temporary file left behind holds; the mode-only
 * repair does the same. A refused rename is not answered by an in-place
 * rewrite (Kiro test change, S1). Run as root it also
 * checks that the owner is set to the original's.
 *
 *   node patch/test/file_mode_test.js
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var fileMode = require('../file_mode.js');

process.umask(0o077);
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-file-mode-'));
var checks = 0;
function check(name, fn) { fn(); checks++; console.log('ok   ' + name); }
function mode(f) { return fs.statSync(f).mode & 0o7777; }
function fresh(name, buf, m) { var f = path.join(dir, name); fs.writeFileSync(f, buf); fs.chmodSync(f, m); return f; }
var me = { uid: process.getuid(), gid: process.getgid() };

try {
    check('wanted: the original\'s mode with at least the floor, its owner; a record wins over the stat', function () {
        var f = fresh('w', 'x', 0o700);
        assert.deepStrictEqual(fileMode.wanted(f, null, fileMode.EXEC), { mode: 0o755, uid: fs.statSync(f).uid, gid: fs.statSync(f).gid });
        assert.strictEqual(fileMode.wanted(f, { mode: 0o775 }, fileMode.EXEC).mode, 0o775);
        assert.strictEqual(fileMode.wanted(f, { mode: 0o600 }, fileMode.READ).mode, 0o644);
        assert.strictEqual(fileMode.wanted(f, { mode: 0o4755 }, fileMode.EXEC).mode, 0o4755);
        assert.strictEqual(fileMode.wanted(f, { mode: 0o2711 }, fileMode.EXEC).mode, 0o2755);
        assert.deepStrictEqual(fileMode.wanted(f, { uid: 0, gid: 0 }, fileMode.EXEC), { mode: 0o755, uid: 0, gid: 0 });
        assert.deepStrictEqual(fileMode.wanted(path.join(dir, 'missing'), null, fileMode.EXEC), { mode: 0o755, uid: me.uid, gid: me.gid });
    });

    check('replace under umask 077: 0755 binary, 0644 conf, the bytes, no temporary file', function () {
        var bin = fresh('bin', 'old', 0o755), conf = fresh('conf', 'old', 0o644);
        fileMode.replace(bin, Buffer.from('new binary'), fileMode.wanted(bin, null, fileMode.EXEC));
        fileMode.replace(conf, Buffer.from('new conf'), fileMode.wanted(conf, null, fileMode.READ));
        assert.strictEqual(mode(bin), 0o755);
        assert.strictEqual(mode(conf), 0o644);
        assert.strictEqual(fs.readFileSync(bin, 'utf8'), 'new binary');
        assert(!fs.existsSync(bin + '.woc-tmp') && !fs.existsSync(conf + '.woc-tmp'));
    });

    check('replace over a 0700 target gives 0755; a 0600 conf gives 0644', function () {
        var bin = fresh('bin7', 'old', 0o700), conf = fresh('conf6', 'old', 0o600);
        fileMode.replace(bin, Buffer.from('b'), fileMode.wanted(bin, null, fileMode.EXEC));
        fileMode.replace(conf, Buffer.from('c'), fileMode.wanted(conf, null, fileMode.READ));
        assert.strictEqual(mode(bin), 0o755);
        assert.strictEqual(mode(conf), 0o644);
    });

    check('a stale temporary file: its mode and its other names are not carried over', function () {
        var bin = fresh('stale', 'old', 0o755), other = fresh('other', 'keep me', 0o600);
        fs.linkSync(other, bin + '.woc-tmp');   /* a hard link: writing through it would change other */
        fileMode.replace(bin, Buffer.from('new'), fileMode.wanted(bin, null, fileMode.EXEC));
        assert.strictEqual(mode(bin), 0o755);
        assert.strictEqual(fs.readFileSync(other, 'utf8'), 'keep me');
        assert.strictEqual(mode(other), 0o600);
        fs.writeFileSync(bin + '.woc-tmp', 'cut short', { mode: 0o600 });
        fileMode.replace(bin, Buffer.from('newer'), fileMode.wanted(bin, null, fileMode.EXEC));
        assert.strictEqual(mode(bin), 0o755);
        assert.strictEqual(fs.readFileSync(bin, 'utf8'), 'newer');
        fs.symlinkSync(other, bin + '.woc-tmp');
        fileMode.replace(bin, Buffer.from('newest'), fileMode.wanted(bin, null, fileMode.EXEC));
        assert.strictEqual(mode(bin), 0o755);
        assert.strictEqual(fs.readFileSync(other, 'utf8'), 'keep me');
        assert(!fs.lstatSync(bin).isSymbolicLink());
    });

    check('a refused rename (S1: no in-place fallback any more) throws, the target keeps its bytes, mode and inode, no temporary file is left', function () {
        var bin = fresh('inplace', 'old bytes, longer', 0o700), rename = fs.renameSync, ino = fs.statSync(bin).ino;
        fs.renameSync = function () { var e = new Error('busy'); e.code = 'EBUSY'; throw e; };
        try {
            /* the 4th argument upstream used for the in-place fallback is ignored now */
            [undefined, true].forEach(function (inPlace) {
                assert.throws(function () { fileMode.replace(bin, Buffer.from('x'), fileMode.wanted(bin, null, fileMode.EXEC), inPlace); }, /busy.*not rewritten in place; .* unchanged/);
                assert.strictEqual(fs.readFileSync(bin, 'utf8'), 'old bytes, longer');
                assert.strictEqual(mode(bin), 0o700);
                assert.strictEqual(fs.statSync(bin).ino, ino);
                assert.deepStrictEqual(fs.readdirSync(dir).filter(function (n) { return /^inplace\.woc-tmp/.test(n); }), []);
            });
        } finally { fs.renameSync = rename; }
        fileMode.replace(bin, Buffer.from('new'), fileMode.wanted(bin, null, fileMode.EXEC));
        assert.strictEqual(fs.readFileSync(bin, 'utf8'), 'new');
        assert.strictEqual(mode(bin), 0o755);
        assert(!fs.existsSync(bin + '.woc-tmp'));
    });

    check('lacks: only what the service\'s user needs; the owner\'s bits do not count', function () {
        [0o755, 0o555, 0o055].forEach(function (m) { assert(!fileMode.lacks(fresh('ok' + m, 'x', m), fileMode.EXEC), m.toString(8)); });
        [0o700, 0o750, 0o705, 0o751, 0o745].forEach(function (m) { assert(fileMode.lacks(fresh('bad' + m, 'x', m), fileMode.EXEC), m.toString(8)); });
        [0o644, 0o444, 0o044 + 0o200].forEach(function (m) { assert(!fileMode.lacks(fresh('cok' + m, 'x', m), fileMode.READ), m.toString(8)); });
        [0o600, 0o640, 0o604].forEach(function (m) { assert(fileMode.lacks(fresh('cbad' + m, 'x', m), fileMode.READ), m.toString(8)); });
        assert(!fileMode.lacks(path.join(dir, 'missing'), fileMode.EXEC));
    });

    check('repair: mode and owner only, the same file and bytes', function () {
        var bin = fresh('repair', 'stock', 0o700), before = fs.statSync(bin);
        assert(fileMode.lacks(bin, fileMode.EXEC));
        assert(/mode 0700, not 0755/.test(fileMode.mismatch(bin, fileMode.wanted(bin, null, fileMode.EXEC))));
        fileMode.repair(bin, fileMode.wanted(bin, null, fileMode.EXEC));
        var after = fs.statSync(bin);
        assert.strictEqual(after.mode & 0o7777, 0o755);
        assert.strictEqual(after.ino, before.ino);
        assert.strictEqual(after.mtime.getTime(), before.mtime.getTime());
        assert(!fileMode.lacks(bin, fileMode.EXEC));
        assert.strictEqual(fileMode.mismatch(bin, fileMode.wanted(bin, null, fileMode.EXEC)), null);
    });

    if (me.uid === 0) {
        check('as root: the original\'s owner is set on the new file and by a repair', function () {
            var bin = fresh('owned', 'old', 0o755);
            fs.chownSync(bin, 1234, 1234);
            fileMode.replace(bin, Buffer.from('new'), fileMode.wanted(bin, { mode: 0o755, uid: 0, gid: 0 }, fileMode.EXEC));
            assert.strictEqual(fs.statSync(bin).uid, 0);
            assert.strictEqual(fs.statSync(bin).gid, 0);
            fs.chownSync(bin, 1234, 1234);
            fs.chmodSync(bin, 0o700);
            fileMode.repair(bin, fileMode.wanted(bin, { uid: 0, gid: 0 }, fileMode.EXEC));
            assert.strictEqual(fs.statSync(bin).uid, 0);
            assert.strictEqual(mode(bin), 0o755);
        });
    } else console.log('skip owner change: not root');

    console.log('\n' + checks + ' checks passed');
} finally {
    cp.execFileSync('rm', ['-rf', dir]);
}
