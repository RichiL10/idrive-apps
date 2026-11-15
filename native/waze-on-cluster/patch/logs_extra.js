#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs_extra: the parts of the Save logs archive (collect-logs.sh) that
 * are read with care: only read, each file at most CAP bytes, and every text
 * passed through scrub(), which replaces a VIN (17 characters) and its last 7
 * characters, where a VIN is known or the field is labelled, with <VIN>. It
 * does nothing about tokens or keys: those are kept out by not reading the
 * files they sit in. Nothing is written but what the commands below name;
 * nothing is read from the network, and no file of a token or credential is
 * opened.
 *
 *   node logs_extra.js report <dir>
 *       as the logs service's user, into dir:
 *       patch-record-carplay.json, patch-record-aapd.json
 *                          the patchers' records (patch_record.js)
 *       aa-boot-recovery.json
 *                          the aapd boot recovery's state (recovery.js)
 *       restart-record-<n>-<boot id>-<recmgr|crashhandler>.xml
 *                          the restart records the carplay boot step kept
 *                          (recovery.js keepRestartRecords)
 *       coding.txt         the cluster coding's KI_KOMBI_VARIANT, the number
 *                          only (aapd_patch.js readCoding)
 *       deploy.txt         the deploy tool's version; each tool installed
 *                          (/var/opt/<id>/current/component.json: id, kind,
 *                          version); and from the deploy tool's state.json
 *                          the tools' versions and firmware, the apps'
 *                          versions, the restarts pending in this boot and
 *                          the last bounce. Nothing else of it or of the
 *                          updater: not their tokens, credentials, sources,
 *                          config or backups (state.json is parsed in
 *                          memory, only those fields are written).
 *
 *   node logs_extra.js snapshot [dir]
 *       as root (waze-on-cluster-logs-fw.service before the logs service
 *       starts, or collect-logs.sh run by root): BMW's records under
 *       /var/opt/public, which only root reads, into dir (default SNAPSHOT,
 *       made group systemd-journal, mode 2750; files 0640; written into
 *       SNAPSHOT.new and renamed into place whole):
 *       restartInfo-recmgr.xml, restartInfo-crashhandler.xml
 *                          recmgr's and crashhandler's restart records, when
 *                          there (each deletes its own at its start)
 *       recmgr-crashes.txt recmgr_stats.db's modification time and its Crash
 *                          table's newest ROWS rows: key, the application's
 *                          name, crash id (and Timestamp and LC, which recmgr
 *                          leaves empty and 0). Not its UserID column (7
 *                          characters, the size of a short VIN). The
 *                          firmware's sqlite3 opens the database read-only
 *                          (file:...?mode=ro) and is killed after SQLITE_MS.
 *       core-dumps.txt     the names and modification times (UTC) of what
 *                          the crash handler and the kernel keep of crashes
 *                          (DUMPS, two levels deep, at most ENTRIES each of
 *                          the first SCAN_MAX found), never their contents
 *
 *   node logs_extra.js scrub <dir>
 *       the last step of collect-logs.sh, on the folder it is about to pack:
 *       every regular file in it passed through scrub() again (the tools'
 *       logs and the journal's lines too; the last 7 characters of every VIN
 *       found in any name or file replaced in all of them; a file named with a
 *       VIN renamed file-<n>), a file past SCRUB_MAX or one that
 *       cannot be rewritten replaced by a line saying so (exit 1 if even
 *       removing it fails).
 *
 * A source that is absent is left out; one that cannot be read says why in
 * its file. A file cut short of its source says so in its last line. WOC_LOGS_ROOT
 * prefixes every path read (tests).
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = process.env.WOC_LOGS_ROOT || '';
var SNAPSHOT = '/run/waze-on-cluster-logs';
var CAP = 64 * 1024;
/* Read past CAP by this much, so a VIN that crosses CAP is whole when
 * scrubbed; cut to CAP - CUT_NOTE after it, with a note saying so. */
var OVERREAD = 128;
var CUT_NOTE = 64;
/* A JSON file parsed in memory (only what is picked from it is written). */
var JSON_MAX = 1024 * 1024;
var ROWS = 200;
var ENTRIES = 100;
var SCAN_MAX = 5000;
var SQLITE_MS = 2000;
var SCRUB_MAX = 8 * 1024 * 1024;
var SIN = '/var/opt/public/sin';
var DUMPS = [SIN + '/crashhandler/coredumps', SIN + '/crashhandler/gpu_hangs', SIN + '/gcd', SIN + '/dlt-cdh', '/var/opt/kerneldump'];
/* Never follow a link, never block on a pipe. */
var OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

function r(p) { return ROOT + p; }

/* What is replaced by <VIN>:
 *  - a VIN (17 of A-HJ-NPR-Z0-9, with a letter and a digit) standing alone;
 *  - one that starts with a BMW or MINI maker code, also inside a longer run,
 *    and written as groups apart by single spaces or dashes (WBA 5R71 070F
 *    K67620), the maker code itself too, with a digit in it;
 *  - the last 7 characters of any such VIN found in the text, or in the rest
 *    of the archive (scrubDir), wherever they stand alone;
 *  - 7 letters and digits with a digit that follow a label: vin, fgnr,
 *    fahrgestell(nummer), chassis (as in vin: K123456, "fgnr":"FK67620",
 *    <vin7>7A12345</vin7>).
 * A 7-character token with no label and no VIN to derive it from (a crash id,
 * a build id such as A123456) is evidence and stays. */
var VIN = /(^|[^A-Za-z0-9])([A-HJ-NPR-Z0-9]{17})(?![A-Za-z0-9])/gi;
var MAKER_VIN = /(?:W[ -]?B[ -]?[ASXY]|W[ -]?M[ -]?W|3[ -]?M[ -]?W|4[ -]?U[ -]?S|5[ -]?U[ -]?[XM]|5[ -]?Y[ -]?M)(?:[ -]?[A-HJ-NPR-Z0-9]){14}/gi;
var LABELLED = /(^|[^A-Za-z0-9])((?:vin|fgnr|fahrgestell(?:nummer)?|chassis(?:[ _-]?(?:no|nr|number))?)(?:[_-]?(?:short|last7|7))?[\s:="'>]+)([A-Z0-9]{7})(?![A-Za-z0-9])/gi;

/* The last 7 characters kept to replace elsewhere: distinct ones only, at most
 * MAX_SHORTS. Past that, a further VIN's own last 7 are not collected: the
 * full VINs and labelled fields are still replaced, a bare 7-character token
 * of such a VIN is not. A car has one VIN; the cap bounds memory (the logs
 * service has 160 MiB) against a file full of different ones. */
var MAX_SHORTS = 64;
function addShort(found, s) { if (found.size < MAX_SHORTS) found.add(s); }

/* text.replace(re, fn) for a global re, without the memory String.replace takes
 * for a callback: it holds every match of the text at once, ~100 MB for an 8 MiB
 * file of VINs. This keeps the output in pieces joined as it goes. */
function replaceEach(text, re, fn) {
    var out = '', parts = [], last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
        parts.push(text.slice(last, m.index), fn(m[0], m[1], m[2], m[3]));
        last = m.index + m[0].length;
        if (parts.length >= 2048) { out += parts.join(''); parts = []; }
    }
    return out + parts.join('') + text.slice(last);
}

/* text with its full VINs replaced; found (a Set) gets their last 7 */
function replaceVins(text, found) {
    return replaceEach(replaceEach(String(text), MAKER_VIN, function (m) {
        var n = m.replace(/[ -]/g, '');
        if (n.length !== m.length && !/[0-9]/.test(n)) return m;
        if (found) addShort(found, n.slice(-7).toUpperCase());
        return '<VIN>';
    }), VIN, function (m, pre, tok) {
        if (!(/[0-9]/.test(tok) && /[A-Z]/i.test(tok))) return m;
        if (found) addShort(found, tok.slice(-7).toUpperCase());
        return pre + '<VIN>';
    });
}

/* The last 7 characters of every full VIN in text, added to into (a Set) and returned as an array. */
function shortsOf(text, into) {
    var found = into || new Set();
    replaceVins(text, found);
    return Array.from(found);
}

/* text scrubbed; shorts: more last-7 forms to replace (those of the VINs
 * found in the rest of the archive). */
function scrub(text, shorts) {
    var found = new Set();
    (shorts || []).forEach(function (s) { if (/^[A-Z0-9]{7}$/.test(s)) addShort(found, s); });
    var t = replaceEach(replaceVins(text, found), LABELLED, function (m, pre, label, tok) {
        return /[0-9]/.test(tok) ? pre + label + '<VIN>' : m;
    });
    if (!found.size) return t;
    var alt = Array.from(found).map(function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
    return replaceEach(t, new RegExp('(^|[^A-Za-z0-9])(' + alt + ')(?![A-Za-z0-9])', 'gi'), function (m, pre) { return pre + '<VIN>'; });
}
/* A regular file's first cap + OVERREAD bytes as { text, more } (more: the
 * file holds more than that), never through a link; null when absent or not
 * a regular file; throws when it cannot be read. */
function readSource(file, cap) {
    var fd;
    try { fd = fs.openSync(file, OPEN_FLAGS); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ELOOP') return null; throw e; }
    try {
        var st = fs.fstatSync(fd);
        if (!st.isFile()) return null;
        var b = Buffer.alloc(Math.min(st.size, cap + OVERREAD)), n = fs.readSync(fd, b, 0, b.length, 0);
        return { text: b.slice(0, n).toString('utf8'), more: st.size > n };
    } finally { fs.closeSync(fd); }
}

/* text scrubbed, then cut to cap bytes with a note when it is longer or
 * its source was (more), as a Buffer. */
function redact(text, cap, more) {
    var b = Buffer.from(scrub(text), 'utf8');
    if (b.length <= cap && !more) return b;
    var keep = Math.min(b.length, cap - CUT_NOTE);
    return Buffer.concat([b.slice(0, keep), Buffer.from('\n... (cut at ' + keep + ' bytes)\n')]);
}

function put(dir, name, part) {
    var src = typeof part === 'string' ? { text: part, more: false } : part;
    fs.writeFileSync(path.join(dir, name), redact(src.text, CAP, src.more), { mode: 0o640 });
}

/* Each part [name, text()] into dir: text() (a string or readSource's
 * result) null leaves it out, a throw writes why. */
function writeParts(dir, parts) {
    parts.forEach(function (p) {
        var text;
        try { text = p[1](); } catch (e) { text = '(failed: ' + (e.code || e.message) + ')\n'; }
        if (text !== null) put(dir, p[0], text);
    });
}

function fileText(file) { return function () { return readSource(file, CAP); }; }

function readJson(file) {
    var src = readSource(file, JSON_MAX);
    return src === null ? null : JSON.parse(src.text);
}

function iso(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }
function str(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : '?'; }

/* ---- report ---------------------------------------------------------------- */

function codingText() {
    var cd = require('./aapd_patch.js').readCoding(r('/dev/shm/rawcodingdata'));
    return (cd.err ? 'unreadable (' + cd.err + ')' : 'KI_KOMBI_VARIANT ' + cd.variant) + '\n';
}

function deployText() {
    var out = [], varOpt = r('/var/opt'), v = null;
    try { v = fs.readlinkSync(path.join(varOpt, 'mgu-deploy', 'current')); } catch (e) { /* not installed */ }
    out.push('mgu-deploy ' + (v ? path.basename(v) : 'absent'));
    out.push('tools installed (/var/opt/<id>/current):');
    var names = [];
    try { names = fs.readdirSync(varOpt).sort(); } catch (e) { out.push('  (' + e.code + ')'); }
    names.forEach(function (n) {
        var cur = path.join(varOpt, n, 'current');
        try { if (!fs.lstatSync(cur).isSymbolicLink()) return; } catch (e) { return; }
        var c = null;
        try { c = readJson(path.join(cur, 'component.json')); } catch (e) { out.push('  ' + n + ' (component.json: ' + (e.code || 'not JSON') + ')'); return; }
        if (c && typeof c === 'object') out.push('  ' + str(c.kind) + ' ' + str(c.id) + ' ' + str(c.version));
    });
    var s = null;
    try { s = readJson(path.join(varOpt, 'mgu-deploy', 'state.json')); } catch (e) { out.push('state.json: ' + (e.code || 'not JSON')); }
    if (s && typeof s === 'object') {
        out.push('state.json:');
        var tools = s.tools && typeof s.tools === 'object' ? s.tools : {};
        Object.keys(tools).sort().forEach(function (id) {
            var t = tools[id] || {};
            out.push('  tool ' + id + ' ' + str(t.version) + (t.firmware ? ' firmware ' + str(t.firmware) : '') +
                (t.needsSetup ? ' (needs setup: ' + str(t.needsSetup) + ')' : '') + (t.afterFirmware ? ' (after a firmware update)' : ''));
        });
        var apps = s.apps && typeof s.apps === 'object' ? s.apps : {};
        Object.keys(apps).sort().forEach(function (id) { out.push('  app ' + id + ' ' + str((apps[id] || {}).version)); });
        var boot = require('./boot_id.js').bootId();
        (Array.isArray(s.pending_reboot) ? s.pending_reboot : []).forEach(function (p) {
            if (p && typeof p === 'object' && boot && p.boot === boot) out.push('  pending restart: ' + str(p.id) + ' - ' + str(p.reason));
        });
        if (typeof s.lastBounceAt === 'number' && s.lastBounceAt > 0) out.push('  last bounce: ' + iso(s.lastBounceAt * 1000));
    }
    return out.join('\n') + '\n';
}

/* The restart records the boot step kept: the files its naming gives them,
 * nothing else in that folder. */
var KEPT = /^\d+-[0-9A-Za-z-]+-(recmgr|crashhandler)\.xml$/;

function report(dir) {
    var records = r('/var/opt/waze-on-cluster/restart-records'), names = [];
    try { names = fs.readdirSync(records).filter(function (n) { return KEPT.test(n); }).sort(); } catch (e) { /* none kept */ }
    writeParts(dir, [
        ['patch-record-carplay.json', fileText(r('/usr/bin/carplay.woc-patch.json'))],
        ['patch-record-aapd.json', fileText(r('/usr/bin/aapd.woc-patch.json'))],
        ['aa-boot-recovery.json', fileText(r('/var/opt/waze-on-cluster/aa-boot-recovery.json'))],
        ['coding.txt', codingText],
        ['deploy.txt', deployText],
    ].concat(names.map(function (n) { return ['restart-record-' + n, fileText(path.join(records, n))]; })));
}

/* ---- snapshot -------------------------------------------------------------- */

function crashesText() {
    var db = r(SIN + '/recmgr/recmgr_stats.db'), st;
    try { st = fs.lstatSync(db); } catch (e) { return null; }
    if (!st.isFile()) return null;
    var sql = 'SELECT c.CrashKey, c.Timestamp, a.Name, c.CrashID, c.LC FROM Crash c LEFT JOIN Appl a ON a.ID = c.AppID ' +
        'ORDER BY c.CrashKey DESC LIMIT ' + ROWS + ';';
    var res = cp.spawnSync('sqlite3', ['-header', 'file:' + db + '?mode=ro', sql],
        { cwd: '/', encoding: 'utf8', timeout: SQLITE_MS, killSignal: 'SIGKILL', maxBuffer: 4 * CAP, stdio: ['ignore', 'pipe', 'pipe'] });
    var head = '-- ' + SIN + '/recmgr/recmgr_stats.db, modified ' + iso(st.mtime.getTime()) + '\n' +
        '-- Crash, newest first (at most ' + ROWS + ')\n';
    if (res.error) return head + '(' + (res.error.code === 'ETIMEDOUT' ? 'sqlite3 killed after ' + SQLITE_MS + ' ms' : 'sqlite3: ' + res.error.code) + ')\n';
    return head + (res.stdout || '') + (res.status ? '(sqlite3 exit ' + res.status + ': ' + String(res.stderr || '').trim().slice(0, 300) + ')\n' :
        res.stdout ? '' : '(no rows)\n');
}

function dumpsText() {
    var out = [];
    DUMPS.forEach(function (base) {
        var lines = [], scanned = 0;
        function walk(rel, depth) {
            var names;
            try { names = fs.readdirSync(r(base) + rel); } catch (e) {
                if (!rel) { if (e.code !== 'ENOENT') out.push('-- ' + base + '\n(' + e.code + ')'); return; }
                lines.push({ t: 0, s: '(' + e.code + ') ' + rel.slice(1) + '/' });
                return;
            }
            names.forEach(function (n) {
                if (scanned >= SCAN_MAX) return;
                scanned++;
                var st;
                try { st = fs.lstatSync(r(base) + rel + '/' + n); } catch (e) { return; }
                lines.push({ t: st.mtime.getTime(), s: iso(st.mtime.getTime()) + '  ' + (rel + '/' + n).slice(1) + (st.isDirectory() ? '/' : '') });
                if (st.isDirectory() && depth < 2) walk(rel + '/' + n, depth + 1);
            });
            if (!rel) {
                lines.sort(function (a, b) { return b.t - a.t; });
                out.push('-- ' + base + (scanned >= SCAN_MAX ? ' (the first ' + SCAN_MAX + ' entries looked at)' : '') +
                    (lines.length > ENTRIES ? ' (the newest ' + ENTRIES + ' of ' + lines.length + ')' : ''));
                lines.slice(0, ENTRIES).forEach(function (l) { out.push(l.s); });
                if (!lines.length) out.push('(empty)');
            }
        }
        walk('', 1);
    });
    return out.join('\n') + '\n';
}

function snapshot(dir) {
    writeParts(dir, [
        ['restartInfo-recmgr.xml', fileText(r(SIN + '/recmgr/restartInfo.xml'))],
        ['restartInfo-crashhandler.xml', fileText(r(SIN + '/crashhandler/restartInfo.xml'))],
        ['recmgr-crashes.txt', crashesText],
        ['core-dumps.txt', dumpsText],
    ]);
}

/* The snapshot into SNAPSHOT.new, then renamed into place whole: a copy
 * from SNAPSHOT under way never reads a file half written or emptied. */
function snapshotInPlace() {
    var next = SNAPSHOT + '.new', old = SNAPSHOT + '.old';
    cp.execFileSync('rm', ['-rf', next, old]);
    fs.mkdirSync(next, 0o750);
    fs.chownSync(next, 0, require('./group_dir.js').gid('systemd-journal'));
    fs.chmodSync(next, 0o2750);
    snapshot(next);
    try { fs.renameSync(SNAPSHOT, old); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.renameSync(next, SNAPSHOT);
    cp.execFileSync('rm', ['-rf', old]);
}

/* ---- scrub ----------------------------------------------------------------- */

/* Every file in dir scrubbed in place; a link is removed, a file that is too
 * large or cannot be rewritten is replaced by a line saying so (removed if
 * even that fails), so what is packed has had the scrub or is not packed. The
 * last 7 characters of every full VIN found in the names or contents are
 * replaced in all of them; a file whose name holds a VIN is renamed file-<n>
 * (removed if that fails), so no VIN is left in the archive's member names. */
function scrubDir(dir) {
    var names = fs.readdirSync(dir), shorts = new Set(), k = 0;
    names.forEach(function (n) {
        shortsOf(n, shorts);
        try {
            var f = path.join(dir, n), st = fs.lstatSync(f);
            if (st.isFile() && st.size <= SCRUB_MAX) shortsOf(fs.readFileSync(f).toString('utf8'), shorts);
        } catch (e) { /* handled below */ }
    });
    function neutral() {
        var t;
        do {
            t = 'file-' + (++k);
            try { fs.lstatSync(path.join(dir, t)); } catch (e) { return t; }
        } while (true);
    }
    var shortList = Array.from(shorts);
    names.forEach(function (n) {
        var f = path.join(dir, n);
        try {
            var st = fs.lstatSync(f);
            if (st.isSymbolicLink() || !st.isFile()) { fs.unlinkSync(f); return; }
            if (scrub(n, shortList) !== n) {
                var g = path.join(dir, neutral());
                try { fs.renameSync(f, g); } catch (e) { fs.unlinkSync(f); return; }
                f = g;
            }
            if (st.size > SCRUB_MAX) throw new Error('too large');
            var before = fs.readFileSync(f).toString('utf8'), after = scrub(before, shortList);
            if (after !== before) fs.writeFileSync(f, after);
        } catch (e) {
            try { fs.writeFileSync(f, '(left out: ' + (e.message === 'too large' ? 'larger than ' + SCRUB_MAX + ' bytes' : e.code || e.message) + ')\n'); } catch (e2) {
                try { fs.unlinkSync(f); } catch (e3) { process.stderr.write('logs_extra scrub: cannot remove ' + n + '\n'); process.exitCode = 1; }
            }
        }
    });
}
if (require.main === module) {
    var cmd = process.argv[2], dir = process.argv[3];
    try {
        if (cmd === 'report' && dir) report(dir);
        else if (cmd === 'snapshot' && dir) snapshot(dir);
        else if (cmd === 'snapshot') snapshotInPlace();
        else if (cmd === 'scrub' && dir) scrubDir(dir);
        else { process.stderr.write('usage: logs_extra.js report <dir> | snapshot [dir] | scrub <dir>\n'); process.exit(2); }
    } catch (e) {
        process.stderr.write('logs_extra ' + cmd + ': ' + e.message + '\n');
        process.exit(1);
    }
}

module.exports = { scrub: scrub, shortsOf: shortsOf, readSource: readSource, redact: redact, report: report, snapshot: snapshot, scrubDir: scrubDir,
    CAP: CAP, ROWS: ROWS, ENTRIES: ENTRIES, SQLITE_MS: SQLITE_MS };
