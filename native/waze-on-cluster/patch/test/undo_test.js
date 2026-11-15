#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves that a carplay an older release of this tool patched is undone even
 * where the current locator refuses a site (CARPLAY_BIN, carplay 22.28.3):
 * builds that release's locator accepted and patched in the wrong place
 * (carplay_mutations.js oldRelease), with the backup and record it left.
 * status reports them restorable; revert writes the backup whole without
 * --force, also with no record; a backup whose record does not match, or of
 * another build, is refused; apply refuses them.
 *
 *   CARPLAY_BIN=<copy of /usr/bin/carplay> node undo_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit for every patcher and patchd this runs */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

var REF_SHA = 'ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50';
var SRC = process.env.CARPLAY_BIN || '';
if (!fs.existsSync(SRC)) { process.stdout.write('SKIP: set CARPLAY_BIN to a copy of the unit\'s /usr/bin/carplay (carplay 22.28.3)\n'); process.exit(0); }
var REF = fs.readFileSync(SRC);
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
if (sha256(REF) !== REF_SHA) { process.stdout.write('SKIP: CARPLAY_BIN is not carplay 22.28.3\n'); process.exit(0); }

var SCRIPT = path.join(__dirname, '..', 'carplay_patch.js');
var locator = require('../carplay_locate.js');
var fixtures = require('./carplay_mutations.js')(REF).oldRelease();

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function run(args) {
    var r = cp.spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/* The target as an older release left it: the patched binary, its backup and
 * the record of the original. */
function stage(tgt, f, meta) {
    fs.writeFileSync(tgt, f.patched, { mode: 0o755 });
    fs.writeFileSync(tgt + '.woc-orig', f.original, { mode: 0o600 });
    try { fs.unlinkSync(tgt + '.woc-orig.json'); } catch (e) {}
    if (meta !== null) fs.writeFileSync(tgt + '.woc-orig.json', JSON.stringify(Object.assign({ target: tgt, version: 'carplay 22.28.3+gitr624+993efc1-r0.14',
        buildId: locator.buildId(f.original), sha256_original: sha256(f.original), savedAt: '2026-10-01T00:00:00.000Z' }, meta || {})) + '\n');
}

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-undo-'));
try {
    var tgt = path.join(dir, 'carplay'), r;
    fixtures.forEach(function (f) {
        ok(f.name + ': the current locator refuses it', !locator.locate(f.patched).ok);
        stage(tgt, f);
        r = run(['status', '--target', tgt]);
        ok(f.name + ': status not known, restorable', /known:\s+NO/.test(r.out) && /^restorable: yes$/m.test(r.out), r.out);
        r = run(['apply', '--target', tgt, '--panel', 'high', '--unproven', '--yes']);
        ok(f.name + ': apply refuses it, no write', r.code !== 0 && fs.readFileSync(tgt).equals(f.patched), r.out);
        r = run(['revert', '--target', tgt, '--yes']);
        ok(f.name + ': revert writes the original whole, without --force', r.code === 0 && fs.readFileSync(tgt).equals(f.original) &&
            /restored OK/.test(r.out), r.out);
        r = run(['status', '--target', tgt]);
        ok(f.name + ': then not restorable', /^restorable: no\b/m.test(r.out), r.out);
    });

    var f = fixtures[0];
    stage(tgt, f, null);
    r = run(['revert', '--target', tgt, '--yes', '--drop-backup']);
    ok('no record of the original: a backup of the same build is restored, then dropped', r.code === 0 && fs.readFileSync(tgt).equals(f.original) &&
        !fs.existsSync(tgt + '.woc-orig'), r.out);

    stage(tgt, f, { sha256_original: sha256(REF) });
    r = run(['status', '--target', tgt]);
    ok('a backup that is not the recorded original: not restorable', /^restorable: no\b/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes', '--force']);
    ok('a backup that is not the recorded original: revert refuses, also with --force', r.code !== 0 && /not a verified original/.test(r.out) &&
        fs.readFileSync(tgt).equals(f.patched), r.out);

    stage(tgt, f, { buildId: '00' + locator.buildId(f.original).slice(2) });
    r = run(['revert', '--target', tgt, '--yes']);
    ok('a backup of another recorded build-id: revert refuses', r.code !== 0 && /not a verified original/.test(r.out) && fs.readFileSync(tgt).equals(f.patched), r.out);

    stage(tgt, f);
    var other = Buffer.from(f.patched);
    other[other.indexOf(Buffer.from(locator.buildId(f.original), 'hex'))] ^= 0xff;
    fs.writeFileSync(tgt, other);
    r = run(['status', '--target', tgt]);
    ok('another build over the backup: not restorable', /^restorable: no\b/m.test(r.out), r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('another build over the backup: revert refuses without --force', r.code !== 0 && /another build/.test(r.out) && fs.readFileSync(tgt).equals(other), r.out);
} finally {
    cp.execFileSync('rm', ['-rf', dir]);
}

process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
