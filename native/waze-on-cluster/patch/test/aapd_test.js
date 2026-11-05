#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
// Copyright (C) 2026 Robert Nisipeanu
/* The Android Auto patch end to end on temporary copies of the unit's aapd
 * (AAPD_BIN, aapd 22.39.3) and aapd.conf (AAPD_CONF): the patcher's
 * refusals (coding, build, every anchor, a conf something else changed, a
 * backup that is not its record's, too little space), its byte-exact undo
 * without anchors, patchd's hooks and socket next to carplay's (CARPLAY_BIN,
 * optional), the head-unit restart guard, and boot recovery for aapd with /,
 * /proc, mount and systemctl faked. Firmware is never in this repository;
 * without AAPD_BIN and AAPD_CONF the test skips.
 *
 *   AAPD_BIN=<aapd> AAPD_CONF=<aapd.conf> [CARPLAY_BIN=<carplay>] node aapd_test.js
 */
'use strict';

var headUnit = require('./head_unit_env.js');   /* a HIGH head unit for every patcher and patchd this runs */
process.env.WOC_AA_ENABLED = '1';   /* Android Auto is opt-in (aa_enabled.js); this test is about Android Auto */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

var PATCH = path.join(__dirname, '..');
var BIN = process.env.AAPD_BIN || '', CONF = process.env.AAPD_CONF || '', CARPLAY = process.env.CARPLAY_BIN || '';
if (!fs.existsSync(BIN) || !fs.existsSync(CONF)) { process.stdout.write('SKIP: set AAPD_BIN and AAPD_CONF to copies of the unit\'s /usr/bin/aapd and /etc/aapd.conf\n'); process.exit(0); }

var ap = require('../aapd_patch.js');
var conf = require('../aapd_conf.js');
var SRC = fs.readFileSync(BIN), SRCCONF = fs.readFileSync(CONF);
var fails = 0, dirs = [], children = [];
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    dirs.forEach(function (d) { try { cp.execFileSync('rm', ['-rf', d]); } catch (e) {} });
});
function sha(x) { return crypto.createHash('sha256').update(Buffer.isBuffer(x) ? x : fs.readFileSync(x)).digest('hex'); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* A coding image with KI_KOMBI_VARIANT v (flags 0x09: valid). */
function coding(v, flags) {
    var b = Buffer.alloc(ap.CODING.size);
    b[ap.CODING.flags] = flags === undefined ? 0x09 : flags;
    b[ap.CODING.at] = (v << ap.CODING.shift) | 0x01;
    return b;
}

/* A fresh unit: aapd, aapd.conf, the coding, a df reporting plenty. */
function unit() {
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-aa-'));
    dirs.push(d);
    var t = { d: d, bin: path.join(d, 'aapd'), conf: path.join(d, 'aapd.conf'), coding: path.join(d, 'coding'), df: path.join(d, 'df') };
    fs.writeFileSync(t.bin, SRC);
    fs.chmodSync(t.bin, 0o755);
    fs.writeFileSync(t.conf, SRCCONF);
    fs.chmodSync(t.conf, 0o644);
    fs.writeFileSync(t.coding, coding(7));
    setFree(t, 1 << 30);
    return t;
}
function setFree(t, bytes) {
    fs.writeFileSync(t.df, '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/root 999999 1 ' + Math.floor(bytes / 1024) + ' 1% /"\n');
    fs.chmodSync(t.df, 0o755);
}
function patcher(t, args) {
    var r = cp.spawnSync(process.execPath, [path.join(PATCH, 'aapd_patch.js')].concat(args, ['--target', t.bin, '--conf', t.conf, '--coding', t.coding]),
        { encoding: 'utf8', env: Object.assign({}, process.env, { WOC_DF: t.df }) });
    return { code: r.status, out: r.stdout + r.stderr };
}
function status(t) { return patcher(t, ['status']).out; }
function untouched(t) { return sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF) && !fs.existsSync(t.bin + '.woc-orig') && !fs.existsSync(t.conf + '.woc-orig'); }
function onlyEdits(a, b) {
    for (var i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (!ap.EDITS.some(function (e) { return i >= e.off && i < e.off + e.original.length / 2; })) return false;
    }
    return a.length === b.length;
}

/* ---- modes under umask 077: aapd runs as cia_13006 ---- */
(function modeTests() {
    var mask = process.umask(0o077);
    function mode(f) { return fs.statSync(f).mode & 0o7777; }
    function modes(t) { return mode(t.bin).toString(8) + ' ' + mode(t.conf).toString(8); }
    try {
        var t = unit(), owner = fs.statSync(t.bin);
        var r = patcher(t, ['apply', '--yes']);
        ok('umask 077: apply writes aapd 0755 and aapd.conf 0644, owner kept; the records keep the originals\' modes',
            r.code === 0 && modes(t) === '755 644' && fs.statSync(t.bin).uid === owner.uid && fs.statSync(t.bin).gid === owner.gid &&
            JSON.parse(fs.readFileSync(t.bin + '.woc-orig.json', 'utf8')).mode === 0o755 && JSON.parse(fs.readFileSync(t.conf + '.woc-orig.json', 'utf8')).mode === 0o644,
            r.out + ' ' + modes(t));
        fs.chmodSync(t.bin, 0o700); fs.chmodSync(t.conf, 0o600);
        ok('umask 077: an apply with nothing to change refuses to set the modes without --yes', patcher(t, ['apply']).code === 1 && modes(t) === '700 600');
        r = patcher(t, ['apply', '--yes']);
        ok('umask 077: an apply with nothing to change sets aapd 0755 and aapd.conf 0644', r.code === 0 && modes(t) === '755 644', r.out + ' ' + modes(t));
        fs.chmodSync(t.bin, 0o700); fs.chmodSync(t.conf, 0o600);
        fs.writeFileSync(t.bin + '.woc-tmp', 'cut short', { mode: 0o600 });
        r = patcher(t, ['revert', '--yes']);
        ok('umask 077: revert over 0700/0600 and a stale temporary file writes the originals at 0755 and 0644', r.code === 0 && sha(t.bin) === sha(SRC) &&
            sha(t.conf) === sha(SRCCONF) && modes(t) === '755 644' && !fs.existsSync(t.bin + '.woc-tmp'), r.out + ' ' + modes(t));
        fs.chmodSync(t.bin, 0o700); fs.chmodSync(t.conf, 0o600);
        r = patcher(t, ['revert', '--yes']);
        ok('umask 077: revert of the originals at 0700/0600 sets 0755 and 0644, bytes untouched', r.code === 0 && sha(t.bin) === sha(SRC) && modes(t) === '755 644', r.out + ' ' + modes(t));
        fs.chmodSync(t.bin, 0o555); fs.chmodSync(t.conf, 0o444);
        r = patcher(t, ['revert']);
        ok('originals at 0555/0444, which aapd\'s user can run and read, keep their modes', r.code === 0 && modes(t) === '555 444', r.out + ' ' + modes(t));
    } finally { process.umask(mask); }
})();

/* ---- the patcher ---- */
(function patcherTests() {
    var t = unit();
    var s = status(t);
    ok('status: the pristine proven build, coding 7, nothing to restore', /known:\s+yes, pristine aapd 22\.39\.3/.test(s) && /coding:\s+KI_KOMBI_VARIANT 7/.test(s) &&
        /restorable:\s+no/.test(s) && /geometry:\s+ORIGINAL/.test(s), s);

    [[coding(9), 'KI_KOMBI_VARIANT 9 is not the proven'], [coding(2), 'KI_KOMBI_VARIANT 2 is not the proven'], [coding(7, 0x0b), 'coding not valid'],
     [Buffer.alloc(16), 'is 16 bytes']].forEach(function (c) {
        var u = unit();
        fs.writeFileSync(u.coding, c[0]);
        var r = patcher(u, ['apply', '--yes']);
        ok('coding: refused (' + c[1] + '), nothing written', r.code === 1 && r.out.indexOf(c[1]) >= 0 && untouched(u), r.out);
    });
    var nc = unit();
    fs.unlinkSync(nc.coding);
    ok('coding: an unreadable coding refuses', patcher(nc, ['apply', '--yes']).code === 1 && untouched(nc));

    /* Every anchor and site, perturbed the way another build differs: refused
     * with the edit's name, nothing written. */
    ap.EDITS.forEach(function (e) {
        [['before', e.off - 1], ['after', e.off + e.original.length / 2], ['site', e.off]].forEach(function (m) {
            var u = unit(), b = Buffer.from(SRC);
            b[m[1]] ^= 0x5a;
            fs.writeFileSync(u.bin, b);
            var r = patcher(u, ['apply', '--yes']);
            ok('mutation: ' + e.name + ' ' + m[0] + ' changed is refused', r.code === 1 && r.out.indexOf(e.name) >= 0 && sha(u.bin) === sha(b) &&
                !fs.existsSync(u.bin + '.woc-orig'), r.out);
        });
    });
    var sz = unit();
    fs.writeFileSync(sz.bin, Buffer.concat([SRC, Buffer.alloc(16)]));
    ok('mutation: another size is refused', /refusing: size/.test(patcher(sz, ['apply', '--yes']).out) && !fs.existsSync(sz.bin + '.woc-orig'));
    var un = unit(), ub = Buffer.from(SRC);
    ub[0x1000] ^= 1;
    fs.writeFileSync(un.bin, ub);
    var r = patcher(un, ['apply', '--yes']);
    ok('unproven: sites intact but another file is refused (first edit needs the pristine build)', r.code === 1 && /pristine build/.test(r.out) && !fs.existsSync(un.bin + '.woc-orig'), r.out);
    ok('unproven: status reads modified, nothing restorable', /known:\s+yes, modified build/.test(status(un)) && /restorable:\s+no/.test(status(un)));
    var cc = unit();
    fs.appendFileSync(cc.conf, '\n');
    r = patcher(cc, ['apply', '--yes']);
    ok('conf: another aapd.conf is refused before anything is written', r.code === 1 && /not the known original aapd.conf/.test(r.out) && sha(cc.bin) === sha(SRC), r.out);
    var lo = unit();
    setFree(lo, 10 << 20);
    r = patcher(lo, ['apply', '--yes']);
    ok('disk: too little free space refuses, nothing written', r.code === 1 && /bytes free/.test(r.out) && untouched(lo), r.out);
    ok('dpi: a density off the steps is refused', patcher(unit(), ['apply', '--dpi', '155', '--yes']).code === 1);

    /* Apply: backups first, each with its record, then the four edits only. */
    r = patcher(t, ['apply', '--yes']);
    var meta = JSON.parse(fs.readFileSync(t.bin + '.woc-orig.json', 'utf8')), cmeta = JSON.parse(fs.readFileSync(t.conf + '.woc-orig.json', 'utf8'));
    ok('apply: both backups are the originals, each with its recorded SHA-256', r.code === 0 && sha(t.bin + '.woc-orig') === sha(SRC) && meta.sha256_original === sha(SRC) &&
        sha(t.conf + '.woc-orig') === sha(SRCCONF) && cmeta.sha256_original === sha(SRCCONF) && !fs.existsSync(t.bin + '.woc-orig.tmp'), r.out);
    ok('apply: aapd differs from the original only in the four edits', onlyEdits(SRC, fs.readFileSync(t.bin)) && !fs.readFileSync(t.bin).equals(SRC));
    var k = JSON.parse(fs.readFileSync(t.conf, 'utf8')).SCREENS.KOMBI_DISPLAY, c = k.CODEC_DEFINITION.HIGH_1080P, sa = k.DIMENSIONS['12.3'];
    var g = conf.GEOMETRY.shown;
    ok('apply: aapd.conf asks for the geometry at 180 dpi; 10.25" and MID left stock', c.CODEC_WIDTH === g.codec.w && c.CODEC_HEIGHT === g.codec.h &&
        c.REPORTED_SCREEN_DENSITY === 180 && c.WIDTH_TARGET_VIEWPORT === g.ui.w && c.HEIGHT_TARGET_VIEWPORT === g.ui.h && sa.SA_WIDTHPIXELS === g.safe.w &&
        sa.SA_OFFSET_TOPPIXELS === g.safe.y && JSON.stringify(k.CODEC_DEFINITION.MID_1080P) === JSON.stringify(JSON.parse(SRCCONF).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.MID_1080P));
    s = status(t);
    ok('status: patched, every edit, 180 dpi, card shown, restorable', /restorable:\s+yes/.test(s) && (s.match(/PATCHED/g) || []).length === 5 &&
        /PATCHED \(180 dpi, card shown, crop 1280x720:0,0,1280,564\)/.test(s), s);
    ok('apply again: nothing to do', /nothing to do/.test(patcher(t, ['apply', '--yes']).out));
    var binAt = sha(t.bin);
    conf.DENSITIES.forEach(function (d) {
        var x = patcher(t, ['apply', '--dpi', String(d), '--yes']);
        if (x.code || JSON.parse(fs.readFileSync(t.conf, 'utf8')).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY !== d) ok('density ' + d, false, x.out);
    });
    ok('density: every step from 150 to 400 rewrites only aapd.conf', sha(t.bin) === binAt && /PATCHED \(400 dpi, card shown/.test(status(t)));

    /* The turn card: hidden is the whole picture as UI with the safe area
     * from the top, and the crop under the card's rows, which grow with the
     * density (the car's values). */
    r = patcher(t, ['apply', '--dpi', '240', '--card', 'hidden', '--yes']);
    k = JSON.parse(fs.readFileSync(t.conf, 'utf8')).SCREENS.KOMBI_DISPLAY; c = k.CODEC_DEFINITION.HIGH_1080P; sa = k.DIMENSIONS['12.3'];
    ok('card hidden: 1280x720 drawn whole, safe area 592x672 at 336,0, 240 dpi', r.code === 0 && c.VERTICAL_MARGIN_SIZE === 0 && c.HEIGHT_TARGET_VIEWPORT === 720 &&
        [sa.SA_OFFSET_LEFTPIXELS, sa.SA_OFFSET_TOPPIXELS, sa.SA_WIDTHPIXELS, sa.SA_HEIGHTPIXELS].join() === '336,0,592,672' && c.REPORTED_SCREEN_DENSITY === 240, r.out);
    ok('card hidden: status names the crop', /PATCHED \(240 dpi, card hidden, crop 1280x720:4,160,1270,560\)/.test(status(t)));
    [[180, '1280x720:0,156,1280,564'], [200, '1280x720:0,156,1280,564'], [240, '1280x720:4,160,1270,560'], [300, '1280x720:46,196,1188,524'],
     [400, '1280x720:116,258,1048,462']].forEach(function (x) {
        var n = x[1].split(':')[1].split(',').map(Number);
        ok('card hidden at ' + x[0] + ' dpi: crop ' + x[1] + ', even, inside, the slot\'s shape', conf.srcCrop('hidden', x[0]) === x[1] &&
            n.every(function (v) { return v % 2 === 0; }) && n[0] + n[2] <= 1280 && n[1] + n[3] <= 720 && Math.abs(n[2] / n[3] / (1088 / 480) - 1) < 0.01);
    });
    var shipped = /^src_crop = (.*)$/m.exec(fs.readFileSync(path.join(PATCH, '..', 'waze-on-cluster.conf'), 'utf8'));
    ok('the shipped conf crops the card-shown geometry', shipped && shipped[1] === conf.srcCrop('shown', 180));
    var origText = SRCCONF.toString('utf8'), every = true;
    conf.DENSITIES.forEach(function (d) {
        conf.CARDS.forEach(function (cd) {
            var e = conf.edited(origText, conf.transform(origText, d, cd));
            if (!e || e.dpi !== d || e.card !== cd || conf.otherFile(conf.transform(origText, d, cd), origText)) every = false;
        });
    });
    ok('every density and card is recognised and is the original\'s file', every);

    /* Undo needs no anchors: the patched aapd with an anchor changed (an
     * older release's edit there), and aapd.conf with KOMBI_DISPLAY numbers
     * no geometry of ours writes. */
    var pb = fs.readFileSync(t.bin);
    pb[ap.EDITS[0].off - 1] ^= 0x5a;
    fs.writeFileSync(t.bin, pb);
    var pc = JSON.parse(fs.readFileSync(t.conf, 'utf8'));
    fs.writeFileSync(t.conf, fs.readFileSync(t.conf, 'utf8').replace('"SA_OFFSET_TOPPIXELS": ' + pc.SCREENS.KOMBI_DISPLAY.DIMENSIONS['12.3'].SA_OFFSET_TOPPIXELS, '"SA_OFFSET_TOPPIXELS": 7'));
    s = status(t);
    ok('undo: anchors and geometry not ours, still restorable', /restorable:\s+yes/.test(s) && /UNKNOWN/.test(s), s);
    r = patcher(t, ['revert', '--yes']);
    ok('undo: revert writes both originals byte-exact', r.code === 0 && sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF), r.out);

    /* A backup that is not its record's original is never trusted. */
    patcher(t, ['apply', '--yes']);
    var bad = fs.readFileSync(t.bin + '.woc-orig');
    bad[5] ^= 1;
    fs.writeFileSync(t.bin + '.woc-orig', bad);
    var patched = sha(t.bin);
    ok('backup: one that differs from its record refuses apply', patcher(t, ['apply', '--dpi', '200', '--yes']).code === 1);
    r = patcher(t, ['revert', '--yes']);
    ok('backup: revert never writes it, restores aapd.conf on its own and fails: aapd is not undone', r.code === 1 && /recorded/.test(r.out) && /not undone: aapd untrusted, aapd\.conf original/.test(r.out) && sha(t.bin) === patched && sha(t.conf) === sha(SRCCONF), r.out);
    r = patcher(t, ['revert', '--yes']);
    ok('backup: with nothing else to restore, revert fails and says why', r.code === 1 && /recorded/.test(r.out) && /restorable:\s+no \(backup sha256/.test(status(t)), r.out);
    fs.writeFileSync(t.bin + '.woc-orig', SRC);
    patcher(t, ['revert', '--yes']);
    patcher(t, ['apply', '--yes']);

    /* A firmware update: another aapd over the backup is left, aapd.conf
     * still restored; --force writes the backup over it. */
    var other = Buffer.concat([SRC, Buffer.from('new firmware')]);
    fs.writeFileSync(t.bin, other);
    r = patcher(t, ['revert', '--yes']);
    ok('another build: aapd left as it is, aapd.conf restored on its own', r.code === 0 && sha(t.bin) === sha(other) && sha(t.conf) === sha(SRCCONF) && /left as it is/.test(r.out), r.out);
    r = patcher(t, ['revert', '--yes']);
    ok('another build: nothing else to restore is an error, nothing written', r.code === 1 && sha(t.bin) === sha(other), r.out);
    r = patcher(t, ['revert', '--yes', '--force', '--drop-backup']);
    ok('another build: --force writes the backup, --drop-backup drops both', r.code === 0 && sha(t.bin) === sha(SRC) && !fs.existsSync(t.bin + '.woc-orig') &&
        !fs.existsSync(t.conf + '.woc-orig') && !fs.existsSync(t.bin + '.woc-orig.json'), r.out);

    /* An apply cut short: a temporary backup without its record. */
    var cut = unit();
    fs.writeFileSync(cut.bin + '.woc-orig.tmp', 'partial');
    r = patcher(cut, ['apply', '--yes']);
    ok('cut short: the next apply replaces the temporary files', r.code === 0 && !fs.existsSync(cut.bin + '.woc-orig.tmp') && sha(cut.bin + '.woc-orig') === sha(SRC), r.out);
    var nr = unit();
    patcher(nr, ['apply', '--yes']);
    fs.unlinkSync(nr.bin + '.woc-orig.json');
    var nrBin = sha(nr.bin);
    r = patcher(nr, ['revert', '--yes']);
    ok('record: a backup without its record is not trusted', /has no record/.test(r.out) && sha(nr.bin) === nrBin && sha(nr.conf) === sha(SRCCONF), r.out);
})();

/* ---- patchd: hooks and socket, next to carplay ---- */
var HAVE_CP = fs.existsSync(CARPLAY);
function patchdUnit(opts) {
    var t = unit();
    var d = t.d;
    ['shm', 'var', 'proc', 'units', 'bin'].forEach(function (x) { fs.mkdirSync(path.join(d, x)); });
    t.carplay = path.join(d, 'carplay');
    fs.writeFileSync(t.carplay, HAVE_CP ? fs.readFileSync(CARPLAY) : 'not a carplay build\n', { mode: 0o755 });
    t.calls = path.join(d, 'calls');
    fs.writeFileSync(t.calls, '');
    t.mounts = path.join(d, 'mounts');
    fs.writeFileSync(t.mounts, '/dev/root / ext4 ro 0 0\n');
    var mount = path.join(d, 'bin', 'mount');
    fs.writeFileSync(mount, '#!/bin/sh\ncase "$*" in *rw*) echo "/dev/root / ext4 rw 0 0" > "' + t.mounts + '";; *) echo "/dev/root / ext4 ro 0 0" > "' + t.mounts + '";; esac\n');
    fs.chmodSync(mount, 0o755);
    /* systemctl: show answers from unit.json, start makes the unit active,
     * every call recorded. */
    t.unitState = path.join(d, 'unit.json');
    fs.writeFileSync(t.unitState, JSON.stringify({ pid: 0 }));
    fs.writeFileSync(path.join(d, 'bin', 'systemctl'), '#!' + process.execPath + '\n' + [
        "var fs = require('fs'), a = process.argv.slice(2), u = JSON.parse(fs.readFileSync(" + JSON.stringify(t.unitState) + ", 'utf8'));",
        "fs.appendFileSync(" + JSON.stringify(t.calls) + ", 'systemctl ' + a.join(' ') + '\\n');",
        "if (a[0] === 'show') process.stdout.write('MainPID=' + u.pid + '\\nInvocationID=run-' + u.pid + '\\nExecMainStartTimestampMonotonic=1\\nActiveState=active\\nDropInPaths=\\n');",
        "else if (a[0] === 'is-active') process.stdout.write('active\\n');",
    ].join('\n') + '\n');
    fs.chmodSync(path.join(d, 'bin', 'systemctl'), 0o755);
    t.reboot = path.join(d, 'bin', 'reboot');
    fs.writeFileSync(t.reboot, '#!/bin/sh\necho reboot >> "' + t.calls + '"\n' + (opts && opts.rebootFails ? 'exit 1\n' : ''));
    fs.chmodSync(t.reboot, 0o755);
    t.recmgr = path.join(d, 'recmgr.conf');
    var names = (opts && opts.recmgr) || [];
    fs.writeFileSync(t.recmgr, '[Whitelist]\n' + names.join('\n') + '\n[WhitelistExitSuccess]\n' + names.join('\n') + '\n');
    var boot = Math.floor(Date.now() / 1000) - 60;
    fs.utimesSync(t.recmgr, boot - 3600, boot - 3600);
    fs.writeFileSync(path.join(d, 'stat'), 'btime ' + boot + '\n');
    t.shm = path.join(d, 'shm');
    t.env = Object.assign({}, process.env, {
        PATH: path.join(d, 'bin') + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: path.join(t.shm, 'patch.sock'), WOC_CARPLAY: t.carplay, WOC_AAPD: t.bin, WOC_AAPD_CONF: t.conf, WOC_CODING: t.coding,
        WOC_DF: t.df, WOC_MOUNT: mount, WOC_PROC_MOUNTS: t.mounts, WOC_PROC: path.join(d, 'proc'), WOC_RECMGR_CONF: t.recmgr,
        WOC_RECMGR_AT_BOOT: path.join(d, 'none.json'), WOC_PROC_STAT: path.join(d, 'stat'), WOC_BOOT_ID: path.join(d, 'none'),
        WOC_UNIT_DIRS: path.join(d, 'units'), WOC_CAPTURE_SOCK: path.join(d, 'none.sock'), WOC_DLT_RECEIVE: path.join(d, 'none'),
        WOC_DLT_RETRY_MS: '600000', WOC_REBOOT_CMD: t.reboot, WOC_REMOUNT_LOCK: path.join(t.shm, 'remount.lock'),
        WOC_STATE_DIR: path.join(d, 'var'), WOC_RESTART_POLL_MS: '20', WOC_CARPLAY_DROPIN: path.join(d, 'dropin.conf'),
    });
    return t;
}
function hook(t, which) {
    var r = cp.spawnSync(process.execPath, [path.join(PATCH, 'patchd.js'), which], { env: t.env, encoding: 'utf8', timeout: 90000 });
    var lines = (r.stdout || '').trim().split('\n'), last = {};
    try { last = JSON.parse(lines[lines.length - 1]); } catch (e) {}
    return { code: r.status, result: last, out: r.stdout + r.stderr };
}
function calls(t) { return fs.readFileSync(t.calls, 'utf8').split('\n').filter(Boolean); }
function marker(t, n) { try { return JSON.parse(fs.readFileSync(path.join(t.shm, n), 'utf8')); } catch (e) { return null; } }
function ro(t) { return /\bro\b/.test(fs.readFileSync(t.mounts, 'utf8')); }

(function hooks() {
    var t = patchdUnit({ recmgr: ['carplay', 'aapd'] });
    var r = hook(t, 'activate');
    ok('activate: Android Auto written, pending its own marker, / read-only', r.code === 0 && /Android Auto patch written/.test(r.result.aa && r.result.aa.status) &&
        marker(t, 'aa-pending').action === 'apply' && /next head-unit start/.test(r.result.reboot || '') && ro(t), r.out);
    ok('activate: CarPlay ' + (HAVE_CP ? 'written alongside' : 'refused on its own (not a carplay build)'),
        HAVE_CP ? /map patch written/.test(r.result.status) && marker(t, 'activation-pending').action === 'apply' : /not patchable/.test(r.result.conflict || ''), JSON.stringify(r.result));
    ok('activate: no systemctl, kill or reboot even with recmgr\'s entries loaded', calls(t).length === 0, calls(t).join('; '));
    r = hook(t, 'activate');
    ok('activate again: Android Auto left pending, nothing rewritten', r.code === 0 && /already waits/.test(r.result.aa.status), JSON.stringify(r.result));
    r = hook(t, 'deactivate');
    ok('deactivate: aapd and aapd.conf restored byte-exact, backups dropped', r.code === 0 && sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF) &&
        !fs.existsSync(t.bin + '.woc-orig') && !fs.existsSync(t.conf + '.woc-orig') && ro(t), r.out);
    if (HAVE_CP) ok('deactivate: carplay restored byte-exact too', sha(t.carplay) === sha(CARPLAY));

    /* Not supported, untested, absent: CarPlay is patched as ever. */
    [['coding 9', function (u) { fs.writeFileSync(u.coding, coding(9)); }, /not supported on this car \(KI_KOMBI_VARIANT 9\)/],
     ['an untested aapd', function (u) { fs.writeFileSync(u.bin, Buffer.concat([SRC, Buffer.alloc(8)])); }, /untested aapd build/],
     ['no aapd', function (u) { fs.unlinkSync(u.bin); }, /no Android Auto/]].forEach(function (c) {
        var u = patchdUnit();
        c[1](u);
        var before = fs.existsSync(u.bin) ? sha(u.bin) : null;
        var x = hook(u, 'activate');
        ok('activate with ' + c[0] + ': Android Auto left as it is, exit 0', x.code === 0 && c[2].test(JSON.stringify(x.result.aa)) &&
            (before === null || sha(u.bin) === before) && sha(u.conf) === sha(SRCCONF) && !marker(u, 'aa-pending'), x.out);
        if (HAVE_CP) ok('activate with ' + c[0] + ': CarPlay patched as ever', /map patch written/.test(x.result.status) && sha(u.carplay) !== sha(CARPLAY), JSON.stringify(x.result));
    });

    /* A running aapd keeps its file linked and is handed over at removal. */
    var w = patchdUnit();
    fs.mkdirSync(path.join(w.d, 'proc', '4242'));
    fs.linkSync(w.bin, path.join(w.d, 'proc', '4242', 'exe'));
    hook(w, 'activate');
    ok('activate: the running aapd stays linked as aapd.woc-running', fs.existsSync(w.bin + '.woc-running') && sha(w.bin + '.woc-running') === sha(SRC));
    /* The next start runs the patched aapd. */
    fs.unlinkSync(path.join(w.d, 'proc', '4242', 'exe'));
    fs.linkSync(w.bin, path.join(w.d, 'proc', '4242', 'exe'));
    fs.unlinkSync(path.join(w.shm, 'aa-pending'));
    r = hook(w, 'deactivate');
    ok('deactivate: the link aapd still runs goes to the deploy tool', (r.result.removeWhenUnused || []).indexOf(w.bin + '.woc-running') >= 0, JSON.stringify(r.result));

    /* A removal that cannot undo Android Auto is refused. */
    var f = patchdUnit();
    hook(f, 'activate');
    fs.writeFileSync(path.join(f.d, 'rw-fails'), '');
    fs.writeFileSync(f.env.WOC_MOUNT, '#!/bin/sh\ncase "$*" in *rw*) exit 32;; esac\n');
    r = hook(f, 'deactivate');
    ok('deactivate: a remount failure that leaves Android Auto patched refuses the removal', r.code === 1 && sha(f.bin) !== sha(SRC) &&
        /patch failed/.test(JSON.stringify(r.result)), r.out);

    /* A removal never leaves aapd patched behind: out of the hook's time
     * for Android Auto's step, or its state unreadable, it is refused. */
    var late = patchdUnit();
    hook(late, 'activate');
    late.env.WOC_HOOK_DEADLINE_MS = '39000';
    r = hook(late, 'deactivate');
    ok('deactivate out of time for Android Auto: refused, aapd still patched (the tool keeps its recovery)', r.code === 1 &&
        /out of time/.test(JSON.stringify(r.result.aa)) && sha(late.bin) !== sha(SRC), r.out);
    var a2 = hook(late, 'activate');
    ok('activate out of time for Android Auto: the install goes on (exit 0)', a2.code === 0 && /out of time/.test(JSON.stringify(a2.result.aa)), a2.out);
    delete late.env.WOC_HOOK_DEADLINE_MS;
    fs.chmodSync(late.bin, 0);
    r = hook(late, 'deactivate');
    fs.chmodSync(late.bin, 0o755);
    ok('deactivate with aapd\'s state unreadable: refused', r.code === 1 && /unreadable/.test(JSON.stringify(r.result.aa)), r.out);
    r = hook(late, 'deactivate');
    ok('deactivate once readable again: restored byte-exact', r.code === 0 && sha(late.bin) === sha(SRC) && sha(late.conf) === sha(SRCCONF), r.out);

    /* A firmware update replaced aapd under our backups: a removal leaves
     * it, as carplay's does; aapd.conf of ours is still restored. */
    var fw = patchdUnit();
    hook(fw, 'activate');
    var newer = Buffer.concat([SRC, Buffer.from('firmware update')]);
    fs.writeFileSync(fw.bin, newer);
    r = hook(fw, 'deactivate');
    ok('deactivate over an aapd firmware update: exit 0, the new aapd left as it is, our aapd.conf restored', r.code === 0 && sha(fw.bin) === sha(newer) &&
        sha(fw.conf) === sha(SRCCONF) && /another build than its backup/.test(r.out), r.out);
    ok('a second removal attempt passes too', hook(fw, 'deactivate').code === 0);
    /* Our aapd.conf already back too: only the stale backups and another
     * build; the removal leaves them. */
    var fw2 = patchdUnit();
    hook(fw2, 'activate');
    fs.writeFileSync(fw2.bin, newer);
    fs.writeFileSync(fw2.conf, SRCCONF);
    r = hook(fw2, 'deactivate');
    ok('deactivate with only another aapd build beside our backups: exit 0, left as it is', r.code === 0 && sha(fw2.bin) === sha(newer) &&
        /another build than our backup/.test(JSON.stringify(r.result.aa)), r.out);

    /* A removal passes only when nothing of Android Auto's is left to undo:
     * aapd restored but aapd.conf not is refused. */
    var half = patchdUnit();
    hook(half, 'activate');
    /* Kiro test change (S1): the temporary file's name is per process now, so a folder in the way
     * no longer fails the write. A file capability aapd.conf carries that setfattr cannot copy does:
     * the write is refused with aapd.conf unchanged. */
    var fakeGet = path.join(half.d, 'bin', 'getfattr'), fakeSet = path.join(half.d, 'bin', 'setfattr');
    fs.writeFileSync(fakeGet, '#!/bin/sh\nfor f; do :; done\ncase "$f" in "' + half.conf + '") printf "# file: %s\\nsecurity.capability=0x0100\\n\\n" "$f";; esac\n');
    fs.writeFileSync(fakeSet, '#!/bin/sh\necho "setfattr: Operation not permitted" >&2\nexit 1\n');
    fs.chmodSync(fakeGet, 0o755); fs.chmodSync(fakeSet, 0o755);
    r = hook(half, 'deactivate');
    ok('deactivate with aapd restored but aapd.conf\'s write failing: refused, aapd.conf\'s backup kept', r.code === 1 && sha(half.bin) === sha(SRC) &&
        sha(half.conf) !== sha(SRCCONF) && fs.existsSync(half.conf + '.woc-orig') && /not undone/.test(JSON.stringify(r.result.aa)), r.out);
    fs.unlinkSync(fakeGet); fs.unlinkSync(fakeSet);
    r = hook(half, 'deactivate');
    ok('deactivate once aapd.conf can be written: restored byte-exact', r.code === 0 && sha(half.bin) === sha(SRC) && sha(half.conf) === sha(SRCCONF), r.out);
    var norec = patchdUnit();
    hook(norec, 'activate');
    fs.unlinkSync(norec.conf + '.woc-orig.json');
    r = hook(norec, 'deactivate');
    ok('deactivate with aapd.conf\'s backup unrecorded: refused, its backup kept', r.code === 1 && sha(norec.bin) === sha(SRC) &&
        sha(norec.conf) !== sha(SRCCONF) && fs.existsSync(norec.conf + '.woc-orig') && /not undone/.test(JSON.stringify(r.result.aa)), r.out);
    var st = patcher(norec, ['revert', '--yes']);
    ok('the patcher\'s revert with aapd.conf unrecorded: exit non-zero', st.code !== 0 && /aapd\.conf/.test(st.out), st.out);
    ok('status names what is left to undo', /^undo:\s+aapd none, aapd\.conf untrusted$/m.test(status(norec)), status(norec));
})();

/* patchd's socket: one connection, its status events and replies. */
function daemon(t) {
    try { fs.unlinkSync(t.env.WOC_PATCH_SOCK); } catch (e) {}
    var c = cp.spawn(process.execPath, [path.join(PATCH, 'patchd.js')], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(c);
    var log = '';
    c.stdout.on('data', function (b) { log += b; });
    c.stderr.on('data', function (b) { log += b; });
    return new Promise(function (resolve) {
        (function wait(n) {
            if (fs.existsSync(t.env.WOC_PATCH_SOCK)) {
                var s = net.connect(t.env.WOC_PATCH_SOCK), buf = '', waiters = [];
                var api = { msgs: [], log: function () { return log; }, proc: c,
                    send: function (o) { s.write(JSON.stringify(o) + '\n'); },
                    next: function (pred, ms) {
                        return new Promise(function (res, rej) {
                            var tm = setTimeout(function () { rej(new Error('timeout; log: ' + log.slice(-800))); }, ms || 20000);
                            waiters.push({ pred: pred, res: function (m) { clearTimeout(tm); res(m); } });
                        });
                    } };
                s.setEncoding('utf8');
                s.on('data', function (d) {
                    buf += d;
                    var i;
                    while ((i = buf.indexOf('\n')) >= 0) {
                        var m = JSON.parse(buf.slice(0, i));
                        buf = buf.slice(i + 1);
                        api.msgs.push(m);
                        waiters = waiters.filter(function (w) { if (w.pred(m)) { w.res(m); return false; } return true; });
                    }
                });
                s.on('connect', function () { resolve(api); });
                return;
            }
            if (n > 200) throw new Error('patchd did not listen: ' + log);
            setTimeout(function () { wait(n + 1); }, 50);
        })(0);
    });
}
function cropEnv(t) { try { return fs.readFileSync(path.join(t.d, 'var', 'aa-crop.env'), 'utf8'); } catch (e) { return null; } }
function aaDone(m) { return m.ev === 'status' && m.aa && m.aa.state !== 'busy' && !/^(applying|reverting)$/.test(m.aa.reason || ''); }

async function socketTests() {
    /* Without recmgr's aapd entry: written, deferred, aapd never touched. */
    var t = patchdUnit({ recmgr: ['carplay'] });
    var p = await daemon(t);
    var st = await p.next(function (m) { return m.ev === 'status'; });
    ok('status: Android Auto original, its density and range', st.aa.state === 'original' && st.aa.density === 180, JSON.stringify(st.aa));
    p.send({ cmd: 'aa-apply' });
    st = await p.next(function (m) { return aaDone(m) && m.aa.aapd; });
    ok('aa-apply without recmgr\'s aapd entry: deferred, pending marker, no systemctl', st.aa.aapd === 'deferred' && st.aa.pending === 'apply' &&
        marker(t, 'aa-pending').action === 'apply' && !calls(t).some(function (l) { return /aapd/.test(l); }) && ro(t), JSON.stringify(st.aa) + calls(t).join(';'));
    p.send({ cmd: 'aa-density', value: 155 });
    st = await p.next(function (m) { return m.ev === 'refused'; });
    ok('aa-density: a value off the steps is refused', /150-400/.test(st.reason), JSON.stringify(st));
    p.send({ cmd: 'aa-density', value: 240 });
    st = await p.next(function (m) { return aaDone(m) && m.aa.aapd; });
    ok('aa-density: aapd.conf rewritten at 240 dpi', JSON.parse(fs.readFileSync(t.conf, 'utf8')).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY === 240 &&
        fs.readFileSync(path.join(t.d, 'var', 'aa-density'), 'utf8').trim() === '240');
    p.send({ cmd: 'status' });
    var spaced = await p.next(function (m) { return m.ev === 'status'; });
    p.send({ cmd: 'aa-density', value: 200 });
    st = await p.next(function (m) { return m.ev === 'refused'; });
    ok('aa-density: a second change within 10 s is refused, nothing rewritten; status says when one is taken again', /moments ago/.test(st.reason) &&
        spaced.aa.changeAt > Date.now() && spaced.aa.changeAt <= Date.now() + 10000 &&
        JSON.parse(fs.readFileSync(t.conf, 'utf8')).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY === 240, JSON.stringify([st, spaced.aa]));
    ok('aa-density: pending, the disk at 240 dpi, aapd still running the original', spaced.aa.pending === 'apply' && spaced.aa.dpi === 240 &&
        spaced.aa.runDpi === null && marker(t, 'aa-pending').run === null, JSON.stringify(spaced.aa));

    /* Restart head unit: once, then refused, and refused again by a new patchd within 10 min. */
    fs.writeFileSync(t.env.WOC_BOOT_ID, 'boot-R\n');
    p.send({ cmd: 'reboot' });
    var rb = await p.next(function (m) { return m.ev === 'reboot-reply'; });
    for (var i = 0; i < 250 && calls(t).indexOf('reboot') < 0; i++) await sleep(20);
    ok('reboot: a pending Android Auto change is enough; one reboot', rb.ok === true && calls(t).filter(function (l) { return l === 'reboot'; }).length === 1, JSON.stringify(rb));
    ok('reboot: the boot it was asked in is recorded for boot recovery', fs.readFileSync(path.join(t.d, 'var', 'restart-requested'), 'utf8') === 'boot-R\n');
    p.send({ cmd: 'reboot' });
    rb = await p.next(function (m) { return m.ev === 'reboot-reply'; });
    ok('reboot: a second request is refused while the first runs', rb.ok === false && /already in progress/.test(rb.reason), JSON.stringify(rb));
    p.proc.kill('SIGKILL');
    await sleep(100);
    var p2 = await daemon(t);
    p2.send({ cmd: 'reboot' });
    rb = await p2.next(function (m) { return m.ev === 'reboot-reply'; });
    ok('reboot: a restarted patchd refuses within 10 minutes of the last request', rb.ok === false && /possible again in \d+ min/.test(rb.reason) &&
        calls(t).filter(function (l) { return l === 'reboot'; }).length === 1, JSON.stringify(rb));
    p2.proc.kill('SIGKILL');

    /* A reboot that fails takes out only its own record. */
    var f = patchdUnit({ rebootFails: true });
    fs.mkdirSync(path.join(f.d, 'var'), { recursive: true });
    var older = Date.now() - 11 * 60 * 1000;
    fs.writeFileSync(path.join(f.d, 'var', 'reboots.json'), JSON.stringify({ at: [older] }));
    fs.writeFileSync(path.join(f.shm, 'aa-pending'), JSON.stringify({ action: 'apply' }));
    var pf = await daemon(f);
    pf.send({ cmd: 'reboot' });
    rb = await pf.next(function (m) { return m.ev === 'reboot-reply' && m.ok === false; });
    var rec = JSON.parse(fs.readFileSync(path.join(f.d, 'var', 'reboots.json'), 'utf8')).at;
    ok('reboot: a failed reboot takes out its own record only, and can be asked again', rec.length === 0 || (rec.length === 1 && rec[0] === older), JSON.stringify(rec));
    ok('reboot: a failed reboot leaves no restart for boot recovery', !fs.existsSync(path.join(f.d, 'var', 'restart-requested')));
    pf.send({ cmd: 'reboot' });
    rb = await pf.next(function (m) { return m.ev === 'reboot-reply'; });
    ok('reboot: after a failed reboot a new request is accepted', rb.ok === true, JSON.stringify(rb));
    await pf.next(function (m) { return m.ev === 'reboot-reply' && m.ok === false; });
    pf.proc.kill('SIGKILL');

    /* With recmgr's aapd entry: SIGKILL, start, the killed run recorded. */
    var r = patchdUnit({ recmgr: ['aapd'] });
    var victim = cp.spawn('sleep', ['300']);
    children.push(victim);
    fs.writeFileSync(r.unitState, JSON.stringify({ pid: victim.pid }));
    var died = new Promise(function (res) { victim.on('exit', function (code, sig) { res(sig); }); });
    var pr = await daemon(r);
    pr.send({ cmd: 'aa-apply' });
    st = await pr.next(function (m) { return aaDone(m) && m.aa.aapd; });
    var sig = await Promise.race([died, sleep(3000)]);
    ok('aa-apply with recmgr\'s aapd entry: aapd SIGKILLed and started, nothing pending', st.aa.aapd === 'restarted' && sig === 'SIGKILL' &&
        calls(r).indexOf('systemctl start aapd.service') >= 0 && !marker(r, 'aa-pending') && ro(r), JSON.stringify(st.aa) + calls(r).join(';'));
    ok('aa-apply: the killed run is recorded for the watcher', fs.readFileSync(path.join(r.shm, 'aapd-killed'), 'utf8').trim() === 'run-' + victim.pid);
    ok('aa-apply: never a systemctl stop, restart or reboot', !calls(r).some(function (l) { return /systemctl (stop|restart)|reboot/.test(l); }), calls(r).join(';'));
    ok('aa-apply: carplay untouched', !calls(r).some(function (l) { return /carplay/.test(l); }) && (HAVE_CP ? sha(r.carplay) === sha(CARPLAY) : true));
    /* Hiding the card changes the render's crop, which it reads at start:
     * aapd.conf and the crop wait for the next head-unit start. */
    var before = calls(r).length;
    pr.send({ cmd: 'aa-card', value: 'hidden' });
    st = await pr.next(function (m) { return aaDone(m) && m.aa.aapd; });
    ok('aa-card hidden: the crop override written, deferred, aapd not restarted', st.aa.aapd === 'deferred' && st.aa.card === 'hidden' &&
        cropEnv(r) === 'WOC_SRC_CROP=-s src_crop=1280x720:0,156,1280,564\n' && marker(r, 'aa-pending').action === 'apply' &&
        !calls(r).slice(before).some(function (l) { return /aapd/.test(l); }), JSON.stringify(st.aa) + calls(r).slice(before).join(';'));
    pr.send({ cmd: 'aa-revert' });
    await pr.next(function (m) { return aaDone(m) && m.aa.state === 'original' || m.aa && m.aa.pending === 'revert'; });
    ok('aa-revert: originals back byte-exact, the crop override gone', sha(r.bin) === sha(SRC) && sha(r.conf) === sha(SRCCONF) && cropEnv(r) === null);
    pr.proc.kill('SIGKILL');

    /* A density or card change is busy from the moment it is accepted:
     * nothing else starts meanwhile, a reboot included. */
    var b = patchdUnit();
    fs.writeFileSync(path.join(b.shm, 'activation-pending'), JSON.stringify({ action: 'apply' }));
    hook(b, 'activate');
    var pb = await daemon(b);
    await pb.next(function (m) { return m.ev === 'status'; });
    pb.send({ cmd: 'aa-density', value: 200 });
    pb.send({ cmd: 'aa-revert' });
    st = await pb.next(function (m) { return m.ev === 'refused' && m.cmd === 'aa-revert'; });
    ok('Zoom then Android Auto\'s Remove patch button: the second is refused as busy', /another operation/.test(st.reason), JSON.stringify(st));
    pb.send({ cmd: 'status' });
    st = await pb.next(function (m) { return m.ev === 'status'; });
    ok('while it runs, status says busy for Android Auto, keeps the values on disk and leaves CarPlay\'s state', st.busy === 'aa' &&
        st.aa.state === 'busy' && st.aa.dpi === 180 && st.aa.diskCard === 'shown' && st.state !== 'busy', JSON.stringify(st));
    pb.send({ cmd: 'revert' });
    st = await pb.next(function (m) { return m.ev === 'refused' && m.cmd === 'revert'; });
    ok('Zoom then CarPlay\'s Remove patch button: refused as busy', /another operation/.test(st.reason), JSON.stringify(st));
    pb.send({ cmd: 'reboot' });
    var rb2 = await pb.next(function (m) { return m.ev === 'reboot-reply'; });
    ok('Zoom then Restart head unit: refused while it runs', rb2.ok === false && /another operation/.test(rb2.reason), JSON.stringify(rb2));
    await pb.next(function (m) { return aaDone(m) && m.aa.dpi === 200; });
    ok('the zoom itself completes, the conf at 200 dpi, carplay untouched', JSON.parse(fs.readFileSync(b.conf, 'utf8')).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY === 200);
    pb.proc.kill('SIGKILL');

    /* What aapd runs, taken before each change and kept in the marker:
     * the first deferred change's stays through a second; a marker
     * without it (an older patchd's) stays without. */
    var n = patchdUnit();
    n.env.WOC_DENSITY_SPACING_MS = '1';
    hook(n, 'activate');
    fs.unlinkSync(path.join(n.shm, 'aa-pending'));   /* the next head-unit start ran it */
    var pn = await daemon(n);
    await pn.next(function (m) { return aaDone(m) && m.aa.state === 'patched'; });
    pn.send({ cmd: 'aa-density', value: 200 });
    st = await pn.next(function (m) { return aaDone(m) && m.aa.aapd; });
    var run = marker(n, 'aa-pending').run;
    ok('a deferred change: the marker\'s run is what was on disk before it', !!run && run.dpi === 180 && run.card === 'shown' &&
        st.aa.runDpi === 180 && st.aa.dpi === 200, JSON.stringify([marker(n, 'aa-pending'), st.aa]));
    pn.send({ cmd: 'aa-card', value: 'hidden' });
    st = await pn.next(function (m) { return aaDone(m) && m.aa.diskCard === 'hidden'; });
    run = marker(n, 'aa-pending').run;
    ok('a second deferred change keeps the first run', !!run && run.dpi === 180 && run.card === 'shown' &&
        st.aa.runDpi === 180 && st.aa.runCard === 'shown', JSON.stringify([marker(n, 'aa-pending'), st.aa]));
    fs.writeFileSync(path.join(n.shm, 'aa-pending'), JSON.stringify({ action: 'apply' }) + '\n');
    pn.send({ cmd: 'aa-density', value: 190 });
    st = await pn.next(function (m) { return aaDone(m) && m.aa.dpi === 190; });
    ok('a marker without run stays without', !marker(n, 'aa-pending').hasOwnProperty('run') && st.aa.runDpi === undefined,
        JSON.stringify([marker(n, 'aa-pending'), st.aa]));
    pn.proc.kill('SIGKILL');

    /* An operation takes what aapd runs from a read that starts after its
     * command: aa-apply sent while a status read runs (patchd just started,
     * nothing read yet) still finds the pending marker and keeps its run. */
    var f = patchdUnit();
    hook(f, 'activate');
    fs.writeFileSync(path.join(f.shm, 'aa-pending'), JSON.stringify({ action: 'apply', run: { dpi: 180, card: 'shown' } }) + '\n');
    fs.writeFileSync(path.join(f.d, 'var', 'aa-density'), '200\n');
    var pf2 = await daemon(f);
    pf2.send({ cmd: 'status' });
    pf2.send({ cmd: 'status' });
    pf2.send({ cmd: 'aa-apply' });
    st = await pf2.next(function (m) { return aaDone(m) && m.aa.dpi === 200; });
    run = marker(f, 'aa-pending').run;
    ok('aa-apply during a status read: run from a read after the command, the marker\'s', !!run && run.dpi === 180 && run.card === 'shown',
        JSON.stringify(marker(f, 'aa-pending')));
    pf2.proc.kill('SIGKILL');

    /* The install hook's failure after the patcher wrote (here the crop
     * override cannot be saved) still writes the marker with run. */
    var h = patchdUnit();
    hook(h, 'activate');
    fs.unlinkSync(path.join(h.shm, 'aa-pending'));   /* the next head-unit start ran it */
    fs.writeFileSync(path.join(h.d, 'var', 'aa-card'), 'hidden\n');
    fs.chmodSync(path.join(h.d, 'var'), 0o555);
    var hr2 = hook(h, 'activate');
    fs.chmodSync(path.join(h.d, 'var'), 0o755);
    run = (marker(h, 'aa-pending') || {}).run;
    ok('the hook\'s failure path keeps run in the marker', /aa-crop\.env/.test(hr2.out) && !!run && run.dpi === 180 && run.card === 'shown',
        JSON.stringify(marker(h, 'aa-pending')) + hr2.out.slice(-600));

    /* Nothing writes / without the remount lock: held by another process,
     * an operation gives up and writes nothing. */
    var l = patchdUnit();
    l.env.WOC_OP_LOCK_WAIT_MS = '500';
    var pl = await daemon(l);
    await pl.next(function (m) { return m.ev === 'status'; });
    fs.writeFileSync(l.env.WOC_REMOUNT_LOCK, '1 held by another\n');
    pl.send({ cmd: 'aa-apply' });
    st = await pl.next(function (m) { return m.ev === 'status' && m.aa && m.aa.state === 'error'; });
    ok('lock held elsewhere: Android Auto\'s Patch button gives up, nothing written, / never remounted', /another change to \/ is running/.test(st.aa.reason) &&
        sha(l.bin) === sha(SRC) && !fs.existsSync(l.bin + '.woc-orig') && ro(l), JSON.stringify(st.aa));
    fs.unlinkSync(l.env.WOC_REMOUNT_LOCK);

    /* A deferred change whose pending marker cannot be written: patchd
     * reports it and stays up. */
    fs.mkdirSync(path.join(l.shm, 'aa-pending'));
    pl.send({ cmd: 'aa-apply' });
    st = await pl.next(function (m) { return aaDone(m) && (m.aa.aapd || m.aa.state === 'error'); });
    pl.send({ cmd: 'status' });
    var alive = await pl.next(function (m) { return m.ev === 'status'; });
    ok('a pending marker that cannot be written does not take patchd down', !!alive && pl.proc.exitCode === null, JSON.stringify(st.aa));
    pl.proc.kill('SIGKILL');
}

/* ---- boot recovery for aapd ---- */
var recovery = require('../recovery.js');
var record = require('../patch_record.js');
/* The aapd watcher on a patched aapd of ours (its backup and record) in a
 * folder of its own, with systemd and the restore stubbed. */
function fakeRec(opts) {
    var d = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'woc-aarec-'));
    dirs.push(d);
    var t = recovery.targets({ state: path.join(d, 'boot-recovery.json'), sock: path.join(d, 'patch.sock'), carplay: path.join(d, 'carplay'),
        aapd: path.join(d, 'aapd'), aapdConf: path.join(d, 'aapd.conf') }).aapd;
    if (!opts.dir) {
        fs.writeFileSync(t.target + '.woc-orig', 'aapd\n');
        fs.writeFileSync(t.target + '.woc-orig.json', JSON.stringify({ sha256_original: sha(Buffer.from('aapd\n')) }));
        fs.writeFileSync(t.target, 'patched aapd\n');
        record.write(t.target, { patched: true, proven: true });
    }
    if (opts.killed) fs.writeFileSync(t.killed, opts.killed + '\n');
    var now = 0, ev = [], info = opts.info || { state: 'active', run: 'r1', pid: 1 };
    var rec = new recovery.Recovery({
        target: t, bootId: opts.boot || 'B1', healthyMs: 60000,
        restore: function (f, cb) { ev.push('restore'); cb(null, 'restored'); },
        probe: function (cb) { cb(rec.info); }, systemState: function (cb) { cb('running'); },
        start: function (cb) { ev.push('start'); cb(null); },
        alive: function () { return false; },
        recmgrLoaded: function (n) { ev.push('recmgr ' + n); return opts.recmgr !== false; },
        lock: { tryAcquire: function () { return true; }, release: function () {} }, now: function () { return now; }, log: function () {},
    });
    rec.info = info;
    rec.ev = ev;
    rec.dir = d;
    rec.advance = function (ms) { now += ms; };
    return rec;
}
function tick(rec) { return new Promise(function (res) { rec.tick(res); }); }

async function recoveryTests() {
    var a = fakeRec({});
    await new Promise(function (r) { a.startBoot(r); });
    a.info = { state: 'failed', result: 'signal', code: '2', status: '9', run: 'r1', pid: 0 };
    a.advance(6000);
    var x = await tick(a);
    ok('aapd SIGKILLed by another (Result=signal, status 9): no crash, started again', x.action === 'killed' && a.ev.indexOf('recmgr aapd') >= 0, JSON.stringify(x));
    for (var i = 0; i < 6; i++) { a.advance(5000); await tick(a); }
    ok('aapd killed: started once 5 s later', a.ev.filter(function (e) { return e === 'start'; }).length === 1 && a.ev.indexOf('restore') < 0, a.ev.join(','));

    var b = fakeRec({});
    await new Promise(function (r) { b.startBoot(r); });
    var crashes = 0;
    for (var run = 1; run <= 5; run++) {
        b.info = { state: 'failed', result: 'core-dump', code: '3', status: '11', run: 'c' + run, pid: 0 };
        b.advance(70000);
        var y = await tick(b);
        if (y.action === 'crash') crashes++;
        await tick(b);   /* the same run seen again: no second count */
        b.advance(70000);
        await tick(b);
    }
    var starts = b.ev.filter(function (e) { return e === 'start'; }).length;
    ok('aapd crashes: each run counted once, restored at the second, before more starts', crashes === 5 && b.ev.indexOf('restore') >= 0 &&
        b.ev.indexOf('restore') < b.ev.lastIndexOf('start'), b.ev.join(','));
    ok('aapd crashes: started again at most three times a boot', starts === 3, String(starts));
    var st = JSON.parse(fs.readFileSync(b.statePath, 'utf8'));
    ok('aapd crashes: the boot\'s starts are on disk', st.starts && st.starts.n === 3, JSON.stringify(st));

    var k = fakeRec({ killed: 'pk' });
    k.info = { state: 'failed', result: 'signal', code: '2', status: '9', run: 'pk', pid: 0 };
    await new Promise(function (r) { k.startBoot(r); });
    k.advance(6000);
    var z = await tick(k);
    ok('patchd\'s own kill (aapd-killed) is neither a crash nor started again', z.action === 'watch' && k.ev.indexOf('start') < 0, JSON.stringify(z));

    var n = fakeRec({ recmgr: false });
    await new Promise(function (r) { n.startBoot(r); });
    n.info = { state: 'failed', result: 'core-dump', code: '3', status: '6', run: 'x1', pid: 0 };
    n.advance(6000);
    await tick(n);
    for (i = 0; i < 20; i++) { n.advance(5000); await tick(n); }
    ok('without recmgr\'s aapd entry: the crash recorded, aapd not started', n.ev.indexOf('start') < 0 && JSON.parse(fs.readFileSync(n.statePath, 'utf8')).arm.crashes === 1);

    /* Across boots: a crash at start (mark failed) twice restores before
     * aapd; a switch-off (mark running) counts nothing. */
    var d = fakeRec({ boot: 'B1' });
    await new Promise(function (r) { d.startBoot(r); });
    fs.writeFileSync(path.join(d.dir, 'shutdown-aapd'), 'B1 failed crash\n');
    var r2 = await new Promise(function (r) { fakeRec({ boot: 'B2', dir: d.dir }).startBoot(r); });
    fs.writeFileSync(path.join(d.dir, 'shutdown-aapd'), 'B2 failed crash\n');
    var r3 = await new Promise(function (r) { fakeRec({ boot: 'B3', dir: d.dir }).startBoot(r); });
    ok('boot step: two boots whose aapd failed restore before aapd starts', r2.action === 'armed' && r3.action === 'restored', JSON.stringify([r2, r3]));
    var s1 = fakeRec({ boot: 'S1' });
    await new Promise(function (r) { s1.startBoot(r); });
    fs.writeFileSync(path.join(s1.dir, 'shutdown-aapd'), 'S1 running\n');
    var rs = await new Promise(function (r) { fakeRec({ boot: 'S2', dir: s1.dir }).startBoot(r); });
    ok('boot step: a switch-off within seconds (mark running) is no failure', rs.action === 'armed' && rs.fails === 0, JSON.stringify(rs));

    /* The real boot step on copies: the restore before aapd, / read-only. */
    var t = patchdUnit();
    patcher(t, ['apply', '--yes']);
    var state = path.join(t.d, 'var', 'boot-recovery.json');
    fs.writeFileSync(path.join(t.d, 'var', 'aa-boot-recovery.json'), JSON.stringify({ fails: 1, unknown: 0, arm: { boot: 'old', crashes: 1 } }));
    fs.writeFileSync(path.join(t.d, 'bootid'), 'new\n');
    var env = Object.assign({}, t.env, { WOC_RECOVERY_STATE: state, WOC_BOOT_ID: path.join(t.d, 'bootid') });
    var res = cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: env, encoding: 'utf8', timeout: 60000 });
    ok('real boot step at the threshold: originals restored byte-exact, / read-only, exit 0', res.status === 0 && sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF) && ro(t) &&
        /aapd boot check: restored/.test(res.stdout), res.stdout + res.stderr);
    var cpState = fs.existsSync(state);
    ok('real boot step: carplay\'s counter untouched', !cpState);

    /* A restore cut short after aapd (aapd.conf still patched): patchd
     * reports the restore, and an install does not apply the patch again. */
    var q = patchdUnit();
    patcher(q, ['apply', '--yes']);
    var patchedConf = fs.readFileSync(q.conf);
    var qr = cp.spawnSync(process.execPath, ['-e', 'var r = require(process.argv[1]); r.restoreTarget(r.TARGETS.aapd, true, 2, function (e, o) { process.stdout.write(String(e || o)); });',
        path.join(PATCH, 'recovery.js')], { env: Object.assign({}, q.env, { WOC_RECOVERY_STATE: path.join(q.d, 'var', 'boot-recovery.json') }), encoding: 'utf8' });
    fs.writeFileSync(q.conf, patchedConf);
    var qh = hook(q, 'activate');
    ok('a restore that left aapd.conf patched: an install leaves aapd off and says why', qr.stdout === 'restored' && sha(q.bin) === sha(SRC) &&
        /boot recovery removed the patch after 2 failed head-unit starts/.test((qh.result.aa || {}).status || ''), qr.stdout + qr.stderr + ' ' + JSON.stringify(qh.result));

    /* The boot step's SIGTERM waits for a restore in progress. */
    var u = patchdUnit();
    patcher(u, ['apply', '--yes']);
    fs.writeFileSync(path.join(u.d, 'var', 'aa-boot-recovery.json'), JSON.stringify({ fails: 2, unknown: 0, arm: null }));
    fs.writeFileSync(u.env.WOC_MOUNT, '#!/bin/sh\nsleep 1\ncase "$*" in *rw*) echo "/dev/root / ext4 rw 0 0" > "' + u.mounts + '";; *) echo "/dev/root / ext4 ro 0 0" > "' + u.mounts + '";; esac\n');
    var envU = Object.assign({}, u.env, { WOC_RECOVERY_STATE: path.join(u.d, 'var', 'boot-recovery.json'), WOC_BOOT_ID: path.join(u.d, 'bootid') });
    fs.writeFileSync(path.join(u.d, 'bootid'), 'x\n');
    var ch = cp.spawn(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: envU });
    children.push(ch);
    await sleep(500);
    ch.kill('SIGTERM');
    await new Promise(function (res2) { ch.on('exit', res2); });
    ok('boot step: SIGTERM mid-restore lets the restore finish, / read-only', sha(u.bin) === sha(SRC) && ro(u));

    /* Both boot steps at their threshold in the same boot: they share the
     * remount lock, and each waits for the other's restore. */
    if (HAVE_CP) {
        var both = patchdUnit();
        patcher(both, ['apply', '--yes']);
        var cpr = cp.spawnSync(process.execPath, [path.join(PATCH, 'carplay_patch.js'), 'apply', '--panel', 'high', '--target', both.carplay, '--yes'], { encoding: 'utf8' });
        fs.writeFileSync(both.env.WOC_MOUNT, '#!/bin/sh\nsleep 1\ncase "$*" in *rw*) echo "/dev/root / ext4 rw 0 0" > "' + both.mounts + '";; *) echo "/dev/root / ext4 ro 0 0" > "' + both.mounts + '";; esac\n');
        var bv = path.join(both.d, 'var');
        fs.writeFileSync(path.join(bv, 'boot-recovery.json'), JSON.stringify({ fails: 2, unknown: 0, arm: null }));
        fs.writeFileSync(path.join(bv, 'aa-boot-recovery.json'), JSON.stringify({ fails: 2, unknown: 0, arm: null }));
        fs.writeFileSync(path.join(both.d, 'bootid'), 'b\n');
        var be = Object.assign({}, both.env, { WOC_RECOVERY_STATE: path.join(bv, 'boot-recovery.json'), WOC_BOOT_ID: path.join(both.d, 'bootid') });
        var ends = await Promise.all(['carplay', 'aapd'].map(function (n) {
            return new Promise(function (res) {
                var c = cp.spawn(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', n], { env: be });
                var o = '';
                c.stdout.on('data', function (d) { o += d; });
                c.on('exit', function () { res(o); });
            });
        }));
        ok('both boot steps at the threshold at once: each restores, one after the other', cpr.status === 0 && /carplay boot check: restored/.test(ends[0]) &&
            /aapd boot check: restored/.test(ends[1]) && sha(both.carplay) === sha(CARPLAY) && sha(both.bin) === sha(SRC) && ro(both), ends.join(' | '));
    }

    /* A boot cut off with no record of its own counts for the service
     * that crashed in it, not for the other; with no crash of either it is
     * unknown for carplay (power lost), and the second such boot in a row
     * counts one. */
    [[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 1]].forEach(function (c) {
        var x = patchdUnit();
        var vs = path.join(x.d, 'var');
        fs.writeFileSync(x.carplay + '.woc-orig', 'x');
        fs.writeFileSync(path.join(vs, 'boot-recovery.json'), JSON.stringify({ fails: 0, unknown: c[3], arm: { boot: 'old', crashes: 0 } }));
        fs.writeFileSync(path.join(vs, 'aa-boot-recovery.json'), JSON.stringify({ fails: 0, unknown: 0, prev: null, arm: { boot: 'old', crashes: c[0] } }));
        fs.writeFileSync(path.join(x.d, 'bootid'), 'new\n');
        var e = Object.assign({}, x.env, { WOC_RECOVERY_STATE: path.join(vs, 'boot-recovery.json'), WOC_BOOT_ID: path.join(x.d, 'bootid') });
        cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'carplay'], { env: e, encoding: 'utf8', timeout: 30000 });
        var cst = JSON.parse(fs.readFileSync(path.join(vs, 'boot-recovery.json'), 'utf8'));
        ok(c[0] ? 'an unrecorded end after aapd crashed in that boot is not carplay\'s failure'
            : c[3] ? 'a second unrecorded end in a row with no aapd crash counts one for carplay' : 'a first unrecorded end with no aapd crash is unknown for carplay (power lost)',
            cst.fails === c[1] && cst.unknown === c[2] && cst.arm.boot === 'new', JSON.stringify(cst));
    });

    /* shutdown_mark.sh: aapd SIGKILLed is stopped (no crash), as for its
     * watcher; carplay's record is unchanged. */
    var md = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-mark-'));
    dirs.push(md);
    fs.writeFileSync(path.join(md, 'boot_id'), 'B\n');
    fs.writeFileSync(path.join(md, 'systemctl'), '#!/bin/sh\nprintf "ActiveState=failed\\nResult=signal\\nExecMainCode=2\\nExecMainStatus=9\\n"\n');
    fs.chmodSync(path.join(md, 'systemctl'), 0o755);
    fs.mkdirSync(path.join(md, 'state'));
    var mr = cp.spawnSync('sh', [path.join(PATCH, 'shutdown_mark.sh')], { env: Object.assign({}, process.env, { WOC_STATE_DIR: path.join(md, 'state'),
        WOC_BOOT_ID: path.join(md, 'boot_id'), WOC_SYSTEMCTL: path.join(md, 'systemctl'), WOC_MARK_WAIT: '2' }) });
    ok('shutdown mark: a SIGKILLed aapd is stopped, a SIGKILLed carplay (no drop-in) failed', mr.status === 0 &&
        /^B stopped up \d+\n$/.test(fs.readFileSync(path.join(md, 'state', 'shutdown-aapd'), 'utf8')) && /^B failed up \d+\n$/.test(fs.readFileSync(path.join(md, 'state', 'shutdown'), 'utf8')));
    fs.writeFileSync(path.join(md, 'systemctl'), '#!/bin/sh\nprintf "ActiveState=failed\\nResult=signal\\nExecMainCode=2\\nExecMainStatus=90\\n"\n');
    cp.spawnSync('sh', [path.join(PATCH, 'shutdown_mark.sh')], { env: Object.assign({}, process.env, { WOC_STATE_DIR: path.join(md, 'state'),
        WOC_BOOT_ID: path.join(md, 'boot_id'), WOC_SYSTEMCTL: path.join(md, 'systemctl'), WOC_MARK_WAIT: '2' }) });
    ok('shutdown mark: another signal end of aapd is failed', /^B failed up \d+\n$/.test(fs.readFileSync(path.join(md, 'state', 'shutdown-aapd'), 'utf8')));
    fs.writeFileSync(path.join(md, 'state', 'shutdown-aapd'), 'B stopped\n');
    fs.writeFileSync(path.join(md, 'systemctl'), '#!/bin/sh\nprintf "ActiveState=failed\\nResult=oom-kill\\nExecMainCode=2\\nExecMainStatus=9\\n"\n');
    cp.spawnSync('sh', [path.join(PATCH, 'shutdown_mark.sh')], { env: Object.assign({}, process.env, { WOC_STATE_DIR: path.join(md, 'state'),
        WOC_BOOT_ID: path.join(md, 'boot_id'), WOC_SYSTEMCTL: path.join(md, 'systemctl'), WOC_MARK_WAIT: '2' }) });
    ok('shutdown mark: an oom-killed aapd (status 9) is failed', /^B failed up \d+\n$/.test(fs.readFileSync(path.join(md, 'state', 'shutdown-aapd'), 'utf8')));

    ok('the units\' timeouts cover the restore bound', [/TimeoutStartSec=(\d+)/, /TimeoutStopSec=(\d+)/].every(function (re) {
        return Number(re.exec(fs.readFileSync(path.join(PATCH, '..', 'systemd', 'waze-on-cluster-aa-boot.service'), 'utf8'))[1]) * 1000 > recovery.BOOT_BOUND_MS + 5000;
    }));
    var unitText = fs.readFileSync(path.join(PATCH, '..', 'systemd', 'waze-on-cluster-aa-boot.service'), 'utf8');
    ok('the aa boot unit runs before aapd.service, a oneshot', /^Before=aapd\.service$/m.test(unitText) && /^Type=oneshot$/m.test(unitText) && /recovery\.js boot aapd$/m.test(unitText));
    var comp = JSON.parse(fs.readFileSync(path.join(PATCH, '..', 'component.json'), 'utf8'));
    ok('component.json: aapd and every unit in recmgr, aapd a crash name, no boot unit restarted on update',
        ['aapd', 'carplay'].concat(comp.units.filter(function (x) { return /\.(service|socket)$/.test(x.name); })
            .map(function (x) { return x.name.replace(/\.(service|socket)$/, ''); })).every(function (n) { return comp.recmgr.indexOf(n) >= 0; }) &&
        comp.crashNames.indexOf('aapd') >= 0 && !comp.restart.some(function (x) { return /boot/.test(x); }), JSON.stringify(comp.recmgr));
}

/* Android Auto on a head unit that refuses our parts, and on MID and HIGH F. */
function headUnitTests() {
    var NOT = headUnit.REFUSED;
    var t = unit();
    headUnit.set(headUnit.NONE);
    var r = patcher(t, ['apply', '--yes']);
    ok('no hwvariant=: aapd apply refuses with the reason line, writes nothing', r.code !== 0 && r.out === 'error: refusing: ' + NOT + '\n' && untouched(t), r.out);
    headUnit.set(null);
    r = patcher(t, ['apply', '--yes']);
    ok('no kernel command line: aapd apply refuses, writes nothing', r.code !== 0 && /unknown variant is not supported \(kernel command line unreadable\)/.test(r.out) && untouched(t), r.out);
    [['MID', headUnit.MID], ['HIGH F', headUnit.HIGHF]].forEach(function (v) {
        headUnit.set(v[1]);
        patcher(t, ['revert', '--yes']);
        r = patcher(t, ['apply', '--yes']);
        ok(v[0] + ': aapd apply patches', r.code === 0 && sha(t.bin) !== sha(SRC), r.out);
    });
    headUnit.set(headUnit.NONE);
    r = patcher(t, ['revert', '--yes']);
    ok('no hwvariant=: aapd revert restores both files', r.code === 0 && sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF), r.out);

    var u = patchdUnit();
    r = hook(u, 'activate');
    ok('no hwvariant=: activate leaves Android Auto, the conflict, no marker', r.code === 0 && r.result.aa && r.result.aa.conflict === 'not supported on this car (' + NOT + ')' &&
        untouched(u) && !marker(u, 'aa-pending'), JSON.stringify(r.result));

    var b = patchdUnit();
    headUnit.set(headUnit.HIGH);
    patcher(b, ['apply', '--yes']);
    headUnit.set(headUnit.NONE);
    fs.writeFileSync(path.join(b.d, 'bootid'), 'new\n');
    var env = Object.assign({}, b.env, { WOC_RECOVERY_STATE: path.join(b.d, 'var', 'boot-recovery.json'), WOC_BOOT_ID: path.join(b.d, 'bootid') });
    r = cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: env, encoding: 'utf8', timeout: 60000 });
    ok('no hwvariant=: the boot step restores aapd and aapd.conf before aapd starts, below the threshold, / read-only', r.status === 0 &&
        sha(b.bin) === sha(SRC) && sha(b.conf) === sha(SRCCONF) && ro(b) && /aapd boot check: restored/.test(r.stdout), r.stdout + r.stderr);

    var c = patchdUnit();
    headUnit.set(headUnit.HIGH);
    patcher(c, ['apply', '--yes']);
    fs.appendFileSync(c.conf, '# another tool\n');
    var conf2 = sha(c.conf);
    headUnit.set(headUnit.NONE);
    var calls = path.join(c.d, 'mount.calls');
    fs.writeFileSync(c.env.WOC_MOUNT, '#!/bin/sh\necho "$*" >> "' + calls + '"\n' +
        'case "$*" in *rw*) echo "/dev/root / ext4 rw 0 0" > "' + c.mounts + '";; *) echo "/dev/root / ext4 ro 0 0" > "' + c.mounts + '";; esac\n');
    var bootEnv = Object.assign({}, c.env, { WOC_RECOVERY_STATE: path.join(c.d, 'var', 'boot-recovery.json'), WOC_BOOT_ID: path.join(c.d, 'bootid') });
    function boot(id) {
        fs.writeFileSync(path.join(c.d, 'bootid'), id + '\n');
        try { fs.unlinkSync(calls); } catch (e) {}
        return cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'], { env: bootEnv, encoding: 'utf8', timeout: 60000 });
    }
    r = boot('b1');
    ok('no hwvariant=, aapd.conf changed by another tool: aapd restored, the conf left', r.status === 0 && sha(c.bin) === sha(SRC) && sha(c.conf) === conf2 &&
        fs.existsSync(calls) && ro(c), r.stdout + r.stderr);
    r = boot('b2');
    ok('no hwvariant=, aapd.conf changed by another tool: the next boot leaves / alone', r.status === 0 && !fs.existsSync(calls) && /aapd boot check: idle/.test(r.stdout), r.stdout + r.stderr);

    /* A car 0.8.2's boot recovery restored on HIGH F: the first install there
     * applies Android Auto's patch again, pending; none after it, nor on
     * HIGH, nor over an untrusted backup. */
    function restored(unit, mark) {
        var x = patchdUnit();
        headUnit.set(headUnit.HIGH);
        hook(x, 'activate');
        ['aa-pending', 'activation-pending'].forEach(function (n) { try { fs.unlinkSync(path.join(x.shm, n)); } catch (e) {} });
        patcher(x, ['revert', '--yes']);
        if (mark) fs.writeFileSync(path.join(x.d, 'var', 'highf-repatched'), '{"carplay":"applied","aa":"applied"}\n');
        headUnit.set(unit);
        return x;
    }
    var x = restored(headUnit.HIGHF);
    r = hook(x, 'activate');
    ok('HIGH F restored by 0.8.2: Android Auto applied again, pending', r.code === 0 && r.result.aa && r.result.aa.reset === true &&
        sha(x.bin) !== sha(SRC) && marker(x, 'aa-pending') && marker(x, 'aa-pending').action === 'apply' &&
        JSON.parse(fs.readFileSync(path.join(x.d, 'var', 'highf-repatched'), 'utf8')).aa === 'applied', JSON.stringify(r.result));
    [['HIGH F, marker present', function () { return restored(headUnit.HIGHF, true); }], ['HIGH', function () { return restored(headUnit.HIGH); }]].forEach(function (c) {
        var y = c[1]();
        r = hook(y, 'activate');
        ok(c[0] + ': Android Auto stays off', r.code === 0 && sha(y.bin) === sha(SRC) && !marker(y, 'aa-pending') && /turned off/.test(r.result.aa.status),
            JSON.stringify(r.result));
    });
    var z = restored(headUnit.HIGHF);
    fs.writeFileSync(z.bin + '.woc-orig.json', JSON.stringify({ sha256_original: '0'.repeat(64) }));
    r = hook(z, 'activate');
    var zMark = {};
    try { zMark = JSON.parse(fs.readFileSync(path.join(z.d, 'var', 'highf-repatched'), 'utf8')); } catch (e) {}
    ok('HIGH F, untrusted aapd backup: Android Auto stays off, left for the next install', r.code === 0 && sha(z.bin) === sha(SRC) &&
        !marker(z, 'aa-pending') && !zMark.aa, JSON.stringify(r.result));
    headUnit.set(headUnit.HIGH);
}

(async function () {
    headUnitTests();
    await socketTests();
    await recoveryTests();
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
})().catch(function (e) { ok('no exception', false, e.stack); process.exit(1); });
