#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
// Copyright (C) 2026 mlurker@gmail.com
/* aapd_patch.js — the Android Auto patch: four reversible edits to the
 * Android Auto Projected Daemon (/usr/bin/aapd) and the cluster geometry in
 * /etc/aapd.conf (aapd_conf.js), which together make Google Maps send its
 * cluster view to the stream waze-on-cluster shows (PATCH.md "Android
 * Auto").
 *
 *   gate       `cmp dword [rbx+0x21c],1 ; setbe al` in secondVideoEnabled()
 *              (featureFlag && KombiVariant <= 1): the immediate 1 -> 2.
 *              aapd maps raw KI_KOMBI_VARIANT 9 -> 0, 10 -> 1, 1..8 and
 *              11 -> 2, 0 -> 3, so this admits every raw value of class 2;
 *              apply refuses unless the coding is the proven 7.
 *   selfstart  onNewNavigationStatus()'s call of setNaviStreamStatus
 *              retargeted to requestStream() (same `this`), and
 *              requestStream()'s `je` on a StreamCommandChanged field that is
 *              never set made a `jmp`: aapd starts the cluster stream itself
 *              once navigation is active.
 *   screen     the KombiVariant -> screen-size helper's fall-through: class 2
 *              reads 12.3 as class 0 does, so aapd uses aapd.conf's 12.3
 *              geometry instead of its built-in 800x480 default.
 *
 * Only the one build is proven: its first edit needs the whole file to be
 * the shipped one (KNOWN.sha256), and every edit site is checked by its
 * anchor bytes on both sides. aapd.conf is pinned the same way. Backups of
 * both are taken before the first edit, each with its record, and trusted
 * by the recorded SHA-256; revert needs no anchors. apply is refused on a
 * head unit that refuses our parts (head_unit.js); revert works on any.
 *
 *   aapd_patch.js status [--target <aapd>] [--conf <aapd.conf>] [--coding <shm>]
 *   aapd_patch.js apply  [--dpi <n>] [--card shown|hidden] [--target ...] [--conf ...] [--coding ...] [--yes]
 *   aapd_patch.js revert [--target ...] [--conf ...] [--yes] [--force] [--drop-backup]
 *
 * Every write is an atomic rename; the running aapd keeps its old binary
 * until it next starts. Each file keeps its original's owner and mode, aapd
 * executable and aapd.conf readable by aapd.service's user (file_mode.js).
 * Node 8 on the unit, no dependencies. */
'use strict';

var fs = require('fs');
var crypto = require('crypto');
var path = require('path');
var cp = require('child_process');
var conf = require('./aapd_conf.js');
var buildId = require('./carplay_locate.js').buildId;
var headUnit = require('./head_unit.js');
var record = require('./patch_record.js');
var fileMode = require('./file_mode.js');

/* aapd 22.39.3 as shipped on MGU P18_23w44.2-1-3. */
var KNOWN = {
    version: 'aapd 22.39.3+gitrAUTOINC+d5a1db18c4-r0',
    size: 7367952,
    sha256: '6880f54c3abba40c1368f2bf254c77bd4a169323c0d4cab8f9662a7c912dcf89',
};

/* Each edit: its offset, the stock and patched bytes, and the anchors that
 * end at it and start after it. */
var EDITS = [
    { name: 'gate', off: 0x998bd, original: '83bb1c02000001', patched: '83bb1c02000002',
      before: 'ff928000000084c0740a', after: '0f96c0488b4c240864' },
    { name: 'selfstart call', off: 0x1d43eb, original: 'e800f8ffff', patched: 'e840fbffff',
      before: '4889442410', after: '488b442428' },
    { name: 'selfstart guard', off: 0x1d3f5d, original: '0f848d000000', patched: 'e98e00000090',
      before: '837b4402', after: 'e8a805ebff' },
    { name: 'screen', off: 0x15b440, original: '660fefc0ebe1662e0f1f840000000000', patched: '83f802740b660fefc0ebdc0f1f440000',
      before: '4883c418c30f1f4000', after: 'f20f1005189d3c00ebcd' },
];
/* The most bytes aapd may differ in from its backup and still be its build:
 * the edits' bytes, twice over. */
var SAME_BUILD_MAX_DIFF = 2 * EDITS.reduce(function (n, e) { return n + e.original.length / 2; }, 0);

/* /dev/shm/rawcodingdata, the coding image CodingShmApp publishes: a 0x2c
 * byte header (flags at 0x28, 0x09 = valid coding) and the blocks. aapd's
 * and carplay's CodingKOMBI_HUD is the 150 bytes at block offset 0x75a;
 * KI_KOMBI_VARIANT is getBits(0, 0x7e, 1) of it. */
var CODING = { size: 0x1030, flags: 0x28, valid: 0x09, at: 0x2c + 0x75a, mask: 0x7e, shift: 1, proven: 7 };

var MIN_FREE_MARGIN = 1 << 20;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function die(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }
function backupPath(t) { return t + '.woc-orig'; }
function metaPath(t) { return t + '.woc-orig.json'; }
function readOr(p) { try { return fs.readFileSync(p); } catch (e) { return null; } }

/* {variant} or {err}. */
function readCoding(p) {
    var b = readOr(p);
    if (!b) return { err: p + ' unreadable' };
    if (b.length !== CODING.size) return { err: p + ' is ' + b.length + ' bytes, not ' + CODING.size };
    if ((b[CODING.flags] & 0x0f) !== CODING.valid) return { err: 'coding not valid (flags 0x' + b[CODING.flags].toString(16) + ')' };
    return { variant: (b[CODING.at] & CODING.mask) >> CODING.shift };
}

function hexAt(buf, off, len) { return buf.toString('hex', off, off + len); }

/* original | patched | unknown (with why) for one edit site. */
function siteState(buf, e) {
    var len = e.original.length / 2, bl = e.before.length / 2;
    if (hexAt(buf, e.off - bl, bl) !== e.before || hexAt(buf, e.off + len, e.after.length / 2) !== e.after)
        return { state: 'unknown', reason: e.name + ': anchors do not match the proven build' };
    var cur = hexAt(buf, e.off, len);
    return cur === e.original ? { state: 'original' } : cur === e.patched ? { state: 'patched' }
        : { state: 'unknown', reason: e.name + ': bytes ' + cur + ' are neither stock nor patched' };
}

/* { states, bad: [why] } for the binary. */
function classify(buf) {
    if (buf.length !== KNOWN.size) return { states: null, bad: ['size ' + buf.length + ' is not the proven build\'s ' + KNOWN.size] };
    var states = EDITS.map(function (e) { return siteState(buf, e); });
    return { states: states, bad: states.filter(function (s) { return s.state === 'unknown'; }).map(function (s) { return s.reason; }) };
}

/* The backup with its record, trusted by the recorded SHA-256: {buf, meta}
 * or {err}; null when there is no backup. */
function trusted(file) {
    var buf = readOr(backupPath(file));
    if (!buf) return null;
    var meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath(file), 'utf8')); } catch (e) {}
    if (!meta || !meta.sha256_original) return { err: 'backup ' + backupPath(file) + ' has no record' };
    if (sha256(buf) !== meta.sha256_original) return { err: 'backup sha256 ' + sha256(buf) + ' != recorded ' + meta.sha256_original };
    return { buf: buf, meta: meta };
}

function binOther(cur, orig) {
    if (cur.length !== orig.length) return 'its size differs';
    var a = buildId(cur), b = buildId(orig);
    if (a && b) return a === b ? null : 'its build-id differs';
    for (var i = 0, n = 0; i < cur.length; i++) if (cur[i] !== orig[i] && ++n > SAME_BUILD_MAX_DIFF) return 'more than ' + SAME_BUILD_MAX_DIFF + ' bytes differ';
    return null;
}

/* What a revert writes to one file: {out, other} or {err}; null without a
 * backup. The binary: over the proven build with every site read, only the
 * edits' bytes (another tool's changes stay), else the whole backup. */
function restorePlan(file, cur, isBin) {
    var b = trusted(file);
    if (!b || b.err) return b;
    if (!cur) return { out: b.buf, other: 'it is missing' };
    var other = isBin ? binOther(cur, b.buf) : conf.otherFile(cur.toString('utf8'), b.buf.toString('utf8'));
    var out = b.buf;
    if (isBin && !other && !classify(cur).bad.length && sha256(b.buf) === KNOWN.sha256) {
        out = Buffer.from(cur);
        EDITS.forEach(function (e) { b.buf.copy(out, e.off, e.off, e.off + e.original.length / 2); });
    }
    return { out: out, other: other };
}

/* Why the revert would not change anything, or null when it would. */
function notRestorable(t) {
    var bad = [], any = false;
    [[t.target, true], [t.conf, false]].forEach(function (f) {
        var cur = readOr(f[0]), p = restorePlan(f[0], cur, f[1]);
        if (!p) return;
        if (p.err) bad.push(p.err);
        else if (p.other) bad.push(path.basename(f[0]) + ' is another build than its backup: ' + p.other);
        else if (!cur || !p.out.equals(cur)) any = true;
    });
    return any ? null : bad.length ? bad.join('; ') : 'nothing of ours to undo';
}

/* What undoing one file would find: none (no backup of ours), untrusted (a
 * backup whose record does not vouch for it), other (another build than
 * the backup), original (nothing to restore) or restorable. */
function undoState(file, isBin) {
    var cur = readOr(file), p = restorePlan(file, cur, isBin);
    return !p ? 'none' : p.err ? 'untrusted' : p.other ? 'other' : cur && p.out.equals(cur) ? 'original' : 'restorable';
}
function undoLine(t) { return 'aapd ' + undoState(t.target, true) + ', aapd.conf ' + undoState(t.conf, false); }

/* The backup and its record, which keeps the original's SHA-256, mode and
 * owner. */
function saveBackup(file, buf, meta) {
    var bak = backupPath(file), bakTmp = bak + '.tmp', metaTmp = metaPath(file) + '.tmp', st = fs.statSync(file);
    [bakTmp, metaTmp].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
    fs.writeFileSync(bakTmp, buf, { mode: 0o600 });
    fsyncFile(bakTmp);
    if (!fs.readFileSync(bakTmp).equals(buf)) { try { fs.unlinkSync(bakTmp); } catch (e) {} die('backup verification failed; no change made'); }
    fs.writeFileSync(metaTmp, JSON.stringify(Object.assign({ target: path.resolve(file), sha256_original: sha256(buf),
        mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, savedAt: new Date().toISOString() }, meta), null, 2) + '\n', { mode: 0o600 });
    fsyncFile(metaTmp);
    fs.renameSync(metaTmp, metaPath(file));
    fs.renameSync(bakTmp, bak);
}

function fsyncFile(p) {
    var fd = fs.openSync(p, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/* file's mode and owner (file_mode.js): its original's, recorded with the
 * backup, with at least floor's bits. */
function wantedMode(file, floor) {
    var meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath(file), 'utf8')); } catch (e) {}
    return fileMode.wanted(file, meta, floor);
}

function writeInPlace(target, buf, floor) {
    try { fileMode.replace(target, buf, wantedMode(target, floor)); } catch (e) { die('writing ' + target + ': ' + e.message); }
    if (!fs.readFileSync(target).equals(buf)) die('post-write verification failed: ' + target + '; restore from ' + backupPath(target));
}

/* Each of files ([file, floor]) that aapd.service's user cannot use given
 * its original's mode and owner, with --yes; files holding bytes this tool
 * did not write are the caller's to leave out. */
function repairModes(files, yes) {
    files.forEach(function (f) {
        if (!fileMode.lacks(f[0], f[1])) return;
        var want = wantedMode(f[0], f[1]), fix = fileMode.mismatch(f[0], want);
        if (!yes) die(f[0] + ' has ' + fix + '; pass --yes to set them');
        try { fileMode.repair(f[0], want); } catch (e) { die('setting ' + f[0] + '\'s mode and owner: ' + e.message); }
        process.stdout.write('set ' + f[0] + '\'s mode and owner (it had ' + fix + ')\n');
    });
}

/* Free bytes on the file system holding dir, or null. */
function freeBytes(dir) {
    try {
        var out = cp.execFileSync(process.env.WOC_DF || 'df', ['-Pk', dir], { encoding: 'utf8', timeout: 10000 });
        var f = out.trim().split('\n').pop().split(/\s+/);
        var kb = parseInt(f[3], 10);
        return isNaN(kb) ? null : kb * 1024;
    } catch (e) { return null; }
}

function geometryText(cur, t) {
    if (!cur) return 'MISSING';
    if (sha256(cur) === conf.ORIGINAL_SHA256) return 'ORIGINAL';
    var b = trusted(t.conf);
    var g = b && !b.err && sha256(b.buf) === conf.ORIGINAL_SHA256 ? conf.edited(b.buf.toString('utf8'), cur.toString('utf8')) : null;
    return g ? 'PATCHED (' + g.dpi + ' dpi, card ' + g.card + ', crop ' + conf.srcCrop(g.card, g.dpi) + ')' : 'UNKNOWN (not the known original or our edit of it)';
}

/* Only the one proven build can be patched (KNOWN), so a patch of ours is
 * always of it. */
var PATCHED = { patched: true, proven: true };

function line(k, v) { process.stdout.write((k + ':                ').slice(0, 17) + v + '\n'); }

function cmdStatus(t) {
    var buf = readOr(t.target);
    if (!buf) die('cannot read ' + t.target);
    var c = classify(buf), cd = readCoding(t.coding), bak = trusted(t.target);
    line('target', t.target);
    line('size', buf.length);
    line('sha256', sha256(buf));
    line('conf', t.conf);
    line('coding', cd.err ? 'unreadable (' + cd.err + ')' : 'KI_KOMBI_VARIANT ' + cd.variant);
    var why = notRestorable(t);
    line('restorable', why ? 'no (' + why + ')' : 'yes');
    line('undo', undoLine(t));
    line('known', c.bad.length ? 'NO — ' + c.bad[0] : sha256(buf) === KNOWN.sha256 ? 'yes, pristine ' + KNOWN.version : 'yes, modified build');
    if (c.states) EDITS.forEach(function (e, i) {
        var s = c.states[i];
        line(e.name.replace(' ', '-'), s.state === 'unknown' ? 'UNKNOWN (' + s.reason + ')' : s.state.toUpperCase());
    });
    line('geometry', geometryText(readOr(t.conf), t));
    line('backup', (bak ? backupPath(t.target) + (bak.err ? ' (' + bak.err + ')' : '') : 'none') +
        (fs.existsSync(backupPath(t.conf)) ? ', ' + backupPath(t.conf) : ''));
}

function cmdApply(t, dpi, card, yes) {
    var hu = headUnit.refused();
    if (hu) die('refusing: ' + hu);
    if (conf.DENSITIES.indexOf(dpi) < 0) die('--dpi must be ' + conf.DENSITY_MIN + '-' + conf.DENSITY_MAX + ' in steps of ' + conf.DENSITY_STEP);
    if (conf.CARDS.indexOf(card) < 0) die('--card must be ' + conf.CARDS.join(' or '));
    var cd = readCoding(t.coding);
    if (cd.err) die('refusing: the cluster coding cannot be read (' + cd.err + ')');
    if (cd.variant !== CODING.proven) die('refusing: KI_KOMBI_VARIANT ' + cd.variant + ' is not the proven cluster coding (' + CODING.proven + ')');

    var buf = readOr(t.target);
    if (!buf) die('cannot read ' + t.target);
    var c = classify(buf);
    if (c.bad.length) die('refusing: ' + c.bad.join('; '));
    var bb = trusted(t.target);
    if (bb && bb.err) die('refusing: ' + bb.err);
    if (bb && (sha256(bb.buf) !== KNOWN.sha256 || binOther(buf, bb.buf))) die('refusing: backup ' + backupPath(t.target) + ' is not the original of this build');
    if (!bb && sha256(buf) !== KNOWN.sha256) die('first edit requires the pristine build (sha256 ' + KNOWN.sha256 + '), got ' + sha256(buf));

    var text = readOr(t.conf);
    if (!text) die('cannot read ' + t.conf);
    var cb = trusted(t.conf), origText = cb ? cb.buf : text;
    if (cb && cb.err) die('refusing: ' + cb.err);
    if (sha256(origText) !== conf.ORIGINAL_SHA256) die('refusing: ' + (cb ? 'backup ' + backupPath(t.conf) : t.conf) + ' is not the known original aapd.conf (sha256 ' + conf.ORIGINAL_SHA256 + ')');
    if (cb && !text.equals(cb.buf) && !conf.edited(cb.buf.toString('utf8'), text.toString('utf8'))) die('refusing: ' + t.conf + ' was modified by something else');

    var outBin = Buffer.from(buf);
    EDITS.forEach(function (e) { Buffer.from(e.patched, 'hex').copy(outBin, e.off); });
    var outConf = Buffer.from(conf.transform(origText.toString('utf8'), dpi, card), 'utf8');
    var binChange = !outBin.equals(buf), confChange = !outConf.equals(text);
    if (!binChange && !confChange) {
        repairModes([[t.target, fileMode.EXEC], [t.conf, fileMode.READ]], yes);
        process.stdout.write('nothing to do; already in the requested state\n'); record.ensure(t.target, PATCHED); return;
    }

    var need = (binChange ? (bb ? 0 : buf.length) + buf.length : 0) + (confChange ? (cb ? 0 : text.length) + outConf.length : 0) + MIN_FREE_MARGIN;
    var free = freeBytes(path.dirname(t.target));
    if (free === null) die('refusing: free space on ' + path.dirname(t.target) + ' unknown');
    if (free < need) die('refusing: ' + free + ' bytes free on ' + path.dirname(t.target) + ', ' + need + ' needed');

    process.stdout.write('About to patch ' + t.target + ' and ' + t.conf + ' (' + dpi + ' dpi, card ' + card + ')\n');
    if (!yes) die('pass --yes to proceed');
    if (binChange && !bb) saveBackup(t.target, buf, { version: KNOWN.version, buildId: buildId(buf) });
    if (confChange && !cb) saveBackup(t.conf, text, {});
    if (binChange) writeInPlace(t.target, outBin, fileMode.EXEC);
    if (confChange) writeInPlace(t.conf, outConf, fileMode.READ);
    repairModes([[t.target, fileMode.EXEC], [t.conf, fileMode.READ]], yes);
    record.ensure(t.target, PATCHED);
    process.stdout.write('patched OK. aapd sha256 ' + sha256(outBin) + ', aapd.conf ' + dpi + ' dpi, card ' + card + '\n');
}

/* Each file is restored on its own: one whose backup is not trusted, or
 * that is another build than its backup (a firmware update replaced it;
 * --force overwrites that one), is left as it is while the other is still
 * restored. */
function cmdRevert(t, yes, force, dropBackup) {
    var plans = [], wrote = false, left = [];
    [[t.target, true], [t.conf, false]].forEach(function (f) {
        var cur = readOr(f[0]), p = restorePlan(f[0], cur, f[1]);
        plans.push({ file: f[0], cur: cur, p: p });
    });
    if (!plans.some(function (x) { return x.p; })) die('no backup at ' + backupPath(t.target) + ' or ' + backupPath(t.conf) + '; cannot revert');
    var floor = function (file) { return file === t.target ? fileMode.EXEC : fileMode.READ; };
    plans.forEach(function (x) {
        if (x.p && x.p.err) { left.push(x.p.err + '; ' + x.file + ' left as it is'); return; }
        if (!x.p) return;
        /* At its original already: only the mode and owner, when the file
         * is exactly the verified backup. */
        if (x.cur && x.p.out.equals(x.cur)) { if (!x.p.other && x.cur.equals(trusted(x.file).buf)) repairModes([[x.file, floor(x.file)]], yes); return; }
        if (x.p.other && !force) { left.push(x.file + ' is another build than its backup (' + x.p.other + '); left as it is (--force overwrites it)'); return; }
        if (!yes) die('pass --yes to proceed');
        writeInPlace(x.file, x.p.out, floor(x.file));
        wrote = true;
        process.stdout.write('restored ' + x.file + '\n');
    });
    if (!wrote && left.length) die(left.join('; '));
    left.forEach(function (l) { process.stdout.write(l + '\n'); });
    if (!wrote) process.stdout.write('already at the original; nothing to do\n');
    if (/^(original|other)$/.test(undoState(t.target, true))) record.ensure(t.target, { patched: false });
    /* A file left restorable or with an untrusted backup keeps its backup,
     * and the revert fails: it is not undone. */
    var undone = plans.every(function (x) { var u = undoState(x.file, x.file === t.target); return u !== 'restorable' && u !== 'untrusted'; });
    if (dropBackup) {
        plans.forEach(function (x) {
            var u = undoState(x.file, x.file === t.target);
            if (u === 'restorable' || u === 'untrusted') return;
            [backupPath(x.file), metaPath(x.file), backupPath(x.file) + '.tmp', metaPath(x.file) + '.tmp', x.file + '.woc-tmp', record.recordPath(x.file)].forEach(function (f) {
                try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') die('dropping ' + f + ': ' + e.message); }
            });
        });
        process.stdout.write('backup dropped\n');
    }
    if (!undone) die('not undone: ' + undoLine(t));
}

function main() {
    var argv = process.argv.slice(2), a = { _: [] };
    for (var i = 0; i < argv.length; i++) {
        var k = argv[i];
        if (k === '--yes' || k === '--force' || k === '--drop-backup') a[k.slice(2)] = true;
        else if (k === '--target' || k === '--conf' || k === '--coding' || k === '--dpi' || k === '--card') a[k.slice(2)] = argv[++i];
        else a._.push(k);
    }
    var t = { target: a.target || '/usr/bin/aapd', conf: a.conf || '/etc/aapd.conf', coding: a.coding || '/dev/shm/rawcodingdata' };
    if (a._[0] === 'status') cmdStatus(t);
    else if (a._[0] === 'apply') cmdApply(t, a.dpi === undefined ? conf.DEFAULT_DPI : Number(a.dpi), a.card || conf.DEFAULT_CARD, a.yes);
    else if (a._[0] === 'revert') cmdRevert(t, a.yes, a.force, a['drop-backup']);
    else { process.stderr.write('usage: aapd_patch.js status|apply|revert [--target <aapd>] [--conf <aapd.conf>] [--coding <shm>] [--dpi <n>] [--card shown|hidden] [--yes] [--force] [--drop-backup]\n'); process.exit(2); }
}

module.exports = { EDITS: EDITS, CODING: CODING, KNOWN: KNOWN, trusted: trusted, binOther: binOther };

if (require.main === module) main();
