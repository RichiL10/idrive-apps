#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The evidence logs_extra.js adds to the Save logs archive, from a stand-in
 * unit (WOC_LOGS_ROOT) whose files hold fake secrets: a GitHub token, a Wi-Fi
 * passphrase, a private key, a VIN and its short form, and a position.
 * collect-logs.sh runs from a copy of the installed folder (the script beside
 * the patch tools). Not root: the root-only part comes from the firewall
 * unit's snapshot; as root it takes it itself. Either way the archive holds
 * the patch records, the aapd recovery's state, the coding's variant, the
 * aapd status, the deploy tool's versions and state, the restart records,
 * recmgr's crash table and the list of kept core dumps, each at most 64 KiB,
 * and none of the secrets or VINs. */
'use strict';
var assert = require('assert');
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var extra = require('../logs_extra.js');
var SCRIPT = path.join(__dirname, '..', '..', 'tools', 'collect-logs.sh');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-collect-'));
var bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
var i;

/* The scrub itself: what it replaces and what it leaves. */
(function () {
    var VIN = 'WBA8E9C50GK123456';
    var cases = [
        ['<crashID>' + VIN + '</crashID>', '<crashID><VIN></crashID>'],
        ['vin=' + VIN.toLowerCase() + ';', 'vin=<VIN>;'],
        [VIN, '<VIN>'],
        [VIN + '\n' + VIN, '<VIN>\n<VIN>'],
        /* a short VIN needs its label or a full VIN in the same text: a crash or build id such as A123456 stays */
        ['crash A123456 build AB12345 (GK12345) K123456', 'crash A123456 build AB12345 (GK12345) K123456'],
        ['vin: K123456, "fgnr":"FK67620" <vin7>GK12345</vin7> owner_vin=1234567', 'vin: <VIN>, "fgnr":"<VIN>" <vin7><VIN></vin7> owner_vin=<VIN>'],
        ['Fahrgestellnummer: PA12345 chassis 7A12345 VIN 5G12345', 'Fahrgestellnummer: <VIN> chassis <VIN> VIN <VIN>'],
        ['vinyl records, vin version, devin A123456, vin A1234567', 'vinyl records, vin version, devin A123456, vin A1234567'],
        [VIN + ' then K123456 and (k123456) not K1234567', '<VIN> then <VIN> and (<VIN>) not K1234567'],
        ['WBA 5R71 070F K67620 / FK67620', '<VIN> / <VIN>'],
        ['WBA-5R7-1070-FK6-7620 and W B A 5R71 070F K67620', '<VIN> and <VIN>'],
        ['WBA 5R71 070F, 1HG CM82 633A 004352, WBA  5R71 070F K67620', 'WBA 5R71 070F, 1HG CM82 633A 004352, WBA  5R71 070F K67620'],
        ['id' + VIN + 'x', 'id<VIN>x'],
        ['5UXTR9C5XJ1234567', '<VIN>'],
        ['WMWXU3C53B1234567', '<VIN>'],
        ['1HGCM82633A004352', '<VIN>']
    ];
    cases.forEach(function (c) { assert.strictEqual(extra.scrub(c[0]), c[1], c[0]); });
    /* not VINs: all letters, all digits, a hex id, a time stamp, a longer run, a plain word */
    ['ABCDEFGHJKLMNPRST', '12345678901234567', '3f2a9c1d7e8b4a60b5c4d3e2f1a09182', '20261108204714_000_carplay', '2026-11-08T20:47:14Z',
        'ABCDEFGHJKLMNPRSTUVWXYZ', 'restartInfo', '1234567', 'KI_KOMBI_VARIANT 7', '0x1d43eb'].forEach(function (s) {
        assert.strictEqual(extra.scrub(s), s, s);
    });
    console.log('ok   scrub: 17-character VINs (also lower case, in a run or in groups for a BMW or MINI maker code), their last 7 characters, labelled 7-character fields; ids, times and words stay');
})();

/* journalctl prints a VIN into the unit journals (a file the scrub step meets
 * last); sqlite3 comes below, per case. */
fs.writeFileSync(path.join(bin, 'journalctl'), '#!/bin/sh\ncase " $* " in *" -u carplay "*) echo "carplay[7]: vin WBA8E9C50GK123456 short K123456 crash A123456 ok";; esac\nexit 0\n', { mode: 0o755 });
var ENV = Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH });
var SECRETS = ['ghp_FAKEtoken0123456789abcdefghijklmnop', 'hunter2-wifi-passphrase', 'BEGIN PRIVATE KEY', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'ghp_FAKEstatetoken', 'WBA8E9C50GK123456',
    'GK12345', '48.137154', '11.576124', 'CORE-DUMP-BYTES'];
var U = path.join(dir, 'unit'), CUR = path.join(dir, 'current'), SNAP = path.join(dir, 'snapshot');
function mk(rel, text) {
    var f = path.join(U, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
}
/* a private key block, and a token under a key the report does not pick */
var PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
fs.mkdirSync(CUR);
fs.copyFileSync(SCRIPT, path.join(CUR, 'collect-logs.sh'));
fs.readdirSync(path.join(__dirname, '..')).filter(function (n) { return /\.js$/.test(n); }).forEach(function (n) {
    fs.copyFileSync(path.join(__dirname, '..', n), path.join(CUR, n));
});
mk('usr/bin/carplay.woc-patch.json', '{"patched":true,"proven":true,"trial":false,"ino":5,"size":3484912,"mtime":1794170822000}\n');
mk('usr/bin/aapd.woc-patch.json', '{"patched":false,"proven":true,"ino":6,"size":7367952,"mtime":1794170823000}\n');
mk('var/opt/waze-on-cluster/aa-boot-recovery.json', '{"fails":1,"unknown":0,"arm":null,"prev":"b1","starts":null,"ended":null}\n');
/* the coding image: KI_KOMBI_VARIANT 7, a VIN elsewhere in it */
var coding = Buffer.alloc(0x1030);
coding[0x28] = 0x09;
coding[0x2c + 0x75a] = 7 << 1;
coding.write('WBA8E9C50GK123456', 0x100);
mk('dev/shm/rawcodingdata', coding);
/* the deploy tool: its version, the tools, state.json with what must stay out (and past 64 KiB) */
fs.mkdirSync(path.join(U, 'var/opt/mgu-deploy/versions/0.8.9'), { recursive: true });
fs.symlinkSync('versions/0.8.9', path.join(U, 'var/opt/mgu-deploy/current'));
['waze-on-cluster@0.9.7', 'cluster-render@0.4.3'].forEach(function (t) {
    var id = t.split('@')[0], v = t.split('@')[1];
    mk('var/opt/' + id + '/versions/' + v + '/component.json', JSON.stringify({ id: id, kind: 'tool', version: v, token: 'ghp_FAKEtoken0123456789abcdefghijklmnop', privateKey: PEM }));
    fs.symlinkSync('versions/' + v, path.join(U, 'var/opt', id, 'current'));
});
var stash = [];
for (i = 0; i < 6000; i++) stash.push({ path: '/var/opt/x/' + i });
mk('var/opt/mgu-deploy/state.json', JSON.stringify({
    tools: { 'waze-on-cluster': { version: '0.9.7', firmware: 'S18A-23-07-550', token: 'ghp_FAKEtoken0123456789abcdefghijklmnop', key: PEM } },
    apps: { robertn_store: { uid: 12001, version: '1.4.0', passphrase: 'hunter2-wifi-passphrase' } },
    pending_reboot: [{ id: 'waze-on-cluster', reason: 'new units', boot: 'boot-now' }, { id: 'cluster-render', reason: 'done', boot: 'boot-old' }],
    lastBounceAt: 1794170000,
    github_token: 'ghp_FAKEstatetoken', config: { key: PEM },
    vin: 'WBA8E9C50GK123456', position: { lat: 48.137154, lon: 11.576124 }, data_stash: stash }));
assert(fs.statSync(path.join(U, 'var/opt/mgu-deploy/state.json')).size > 100 * 1024, 'the state is longer than a file may be in the archive');
mk('var/opt/mgu-deploy/config.json', '{"token":"ghp_FAKEtoken0123456789abcdefghijklmnop"}\n');
mk('var/opt/mgu-updater/credentials/token-0a1b2c3d', 'ghp_FAKEtoken0123456789abcdefghijklmnop\n');
mk('var/opt/mgu-updater/sources.json', '{"wifi":{"psk":"hunter2-wifi-passphrase"},"key":"-----BEGIN PRIVATE KEY-----"}\n');
/* BMW's records: restart records, recmgr's database, kept core dumps */
mk('var/opt/public/sin/recmgr/restartInfo.xml', '<RestartInfo><name>carplay</name><crashID>WBA8E9C50GK123456-carplay</crashID>' +
    '<vin7>GK12345</vin7><resets>3</resets></RestartInfo>\n');
mk('var/opt/public/sin/crashhandler/restartInfo.xml', '<RestartInfo>' + 'x'.repeat(200000) + '</RestartInfo>\n');
var DB = mk('var/opt/public/sin/recmgr/recmgr_stats.db', 'SQLite format 3\0');
fs.utimesSync(DB, 1794298365, 1794298365);
/* restart records the boot step kept, and what is not one of them */
mk('var/opt/waze-on-cluster/restart-records/1-boot-old-recmgr.xml', '<RestartInfo><crashID>WBA8E9C50GK123456</crashID></RestartInfo>\n');
mk('var/opt/waze-on-cluster/restart-records/1-boot-old-crashhandler.xml', '<RestartInfo><name>carplay</name></RestartInfo>\n');
mk('var/opt/waze-on-cluster/restart-records/notes.xml', 'ghp_FAKEtoken0123456789abcdefghijklmnop');
mk('var/opt/waze-on-cluster/restart-records/2-boot-old-recmgr.xml.tmp', 'ghp_FAKEtoken0123456789abcdefghijklmnop');
mk('boot_id', 'boot-now\n');
mk('var/opt/public/sin/crashhandler/coredumps/20261108204714_000_carplay/core.gz', 'CORE-DUMP-BYTES');
mk('var/opt/public/sin/crashhandler/coredumps/20261108204714_000_carplay/context_WBA8E9C50GK123456.txt', 'CORE-DUMP-BYTES');
mk('var/opt/public/sin/dlt-cdh/core.1794170822.carplay.4222.gz', 'CORE-DUMP-BYTES');
for (i = 0; i < 130; i++) mk('var/opt/kerneldump/dump-' + i, 'CORE-DUMP-BYTES');
/* sqlite3: records its arguments; rows as the firmware's would print them */
var SQL_ARGS = path.join(dir, 'sqlite-args');
fs.writeFileSync(path.join(bin, 'sqlite3'), '#!/bin/sh\nprintf "%s\\n" "$@" > ' + SQL_ARGS + '\n' +
    'printf "CrashKey|Timestamp|Name|CrashID|LC\\n2|2026-11-05 06:53:00|carplay|WBA8E9C50GK123456-7|41\\n1|2026-11-05 06:51:00|carplay|c1|40\\n"\n', { mode: 0o755 });

var XENV = Object.assign({}, ENV, { WOC_LOGS_ROOT: U, WOC_LOGS_SNAPSHOT: SNAP, WOC_BOOT_ID: path.join(U, 'boot_id') });
var asRoot = process.getuid && process.getuid() === 0;
if (!asRoot) {
    fs.mkdirSync(SNAP);
    cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', SNAP], { env: XENV });
}
var out = path.join(dir, 'out-extra');
fs.mkdirSync(out);
var archive = cp.execFileSync('sh', [path.join(CUR, 'collect-logs.sh'), '-o', out], { env: XENV, encoding: 'utf8' }).trim();
cp.execFileSync('tar', ['-xzf', archive, '-C', out]);
var A = path.join(out, path.basename(archive).replace(/\.tar\.gz$/, ''));
function get(n) { return fs.readFileSync(path.join(A, n), 'utf8'); }

assert.strictEqual(get('patch-record-carplay.json'), fs.readFileSync(path.join(U, 'usr/bin/carplay.woc-patch.json'), 'utf8'));
assert.strictEqual(get('patch-record-aapd.json'), fs.readFileSync(path.join(U, 'usr/bin/aapd.woc-patch.json'), 'utf8'));
assert.strictEqual(get('aa-boot-recovery.json'), fs.readFileSync(path.join(U, 'var/opt/waze-on-cluster/aa-boot-recovery.json'), 'utf8'));
assert.strictEqual(get('coding.txt'), 'KI_KOMBI_VARIANT 7\n');
assert(/^target: +\/usr\/bin\/aapd$|^error: /m.test(get('aapd-status.txt')), get('aapd-status.txt'));
assert.strictEqual(get('deploy.txt'), 'mgu-deploy 0.8.9\ntools installed (/var/opt/<id>/current):\n  tool cluster-render 0.4.3\n' +
    '  tool waze-on-cluster 0.9.7\nstate.json:\n  tool waze-on-cluster 0.9.7 firmware S18A-23-07-550\n  app robertn_store 1.4.0\n' +
    '  pending restart: waze-on-cluster - new units\n  last bounce: 2026-11-08T20:33:20Z\n');
assert.strictEqual(get('restartInfo-recmgr.xml'), '<RestartInfo><name>carplay</name><crashID><VIN>-carplay</crashID>' +
    '<vin7><VIN></vin7><resets>3</resets></RestartInfo>\n');
var big = fs.statSync(path.join(A, 'restartInfo-crashhandler.xml')).size;
assert(big <= 64 * 1024, 'capped: ' + big);
assert.strictEqual(get('restartInfo-crashhandler.xml').match(/\(cut at/g).length, 1, 'one note for the cut');
assert(/^<RestartInfo>x+\n\.\.\. \(cut at 65472 bytes\)\n$/.test(get('restartInfo-crashhandler.xml')));
assert.strictEqual(get('restart-record-1-boot-old-recmgr.xml'), '<RestartInfo><crashID><VIN></crashID></RestartInfo>\n');
assert.strictEqual(get('restart-record-1-boot-old-crashhandler.xml'), '<RestartInfo><name>carplay</name></RestartInfo>\n');
assert.deepStrictEqual(fs.readdirSync(A).filter(function (n) { return /^restart-record-/.test(n); }).sort(),
    ['restart-record-1-boot-old-crashhandler.xml', 'restart-record-1-boot-old-recmgr.xml'], 'only the files the boot step names');
assert.strictEqual(get('recmgr-crashes.txt'), '-- /var/opt/public/sin/recmgr/recmgr_stats.db, modified 2026-11-10T08:12:45Z\n' +
    '-- Crash, newest first (at most 200)\n' +
    'CrashKey|Timestamp|Name|CrashID|LC\n2|2026-11-05 06:53:00|carplay|<VIN>-7|41\n1|2026-11-05 06:51:00|carplay|c1|40\n');
var sqlArgs = fs.readFileSync(SQL_ARGS, 'utf8').split('\n');
assert.strictEqual(sqlArgs[1], 'file:' + path.join(U, 'var/opt/public/sin/recmgr/recmgr_stats.db') + '?mode=ro', 'opened read-only');
assert(/^SELECT /.test(sqlArgs[2]) && !/UserID/.test(sqlArgs[2]) && /LIMIT 200;$/.test(sqlArgs[2]), sqlArgs[2]);
var dumps = get('core-dumps.txt').split('\n');
assert(dumps.indexOf('-- /var/opt/public/sin/crashhandler/coredumps') >= 0 && dumps.indexOf('-- /var/opt/public/sin/dlt-cdh') >= 0);
assert(dumps.some(function (l) { return /Z  20261108204714_000_carplay\/context_<VIN>\.txt$/.test(l); }), 'two levels, the VIN in a name hidden');
assert(dumps.some(function (l) { return /Z  core\.1794170822\.carplay\.4222\.gz$/.test(l); }));
assert(dumps.indexOf('-- /var/opt/kerneldump (the newest 100 of 130)') >= 0, 'at most 100 a folder');
assert.strictEqual(dumps.filter(function (l) { return / {2}dump-\d+$/.test(l); }).length, 100);
/* the VIN scrub reaches every file, the unit journals too */
assert.strictEqual(get('journal-carplay.txt'), 'carplay[7]: vin <VIN> short <VIN> crash A123456 ok\n', 'the last 7 of a VIN found goes, a crash id stays');
var everything = fs.readdirSync(A).map(get).join('\n');
SECRETS.forEach(function (x) { assert(everything.indexOf(x) < 0, 'the archive holds ' + x); });
/* the files logs_extra writes keep to the cap, whatever the source */
fs.readdirSync(A).filter(function (n) { return /^(restart|patch-record|aa-boot|coding|deploy|recmgr-crashes|core-dumps)/.test(n); }).forEach(function (n) {
    assert(fs.statSync(path.join(A, n)).size <= 64 * 1024, n);
});
console.log('ok   the archive adds the patch records, aapd recovery, coding, aapd status, deploy state, restart records, ' +
    'recmgr crashes and core-dump names (' + (asRoot ? 'as root' : 'from the snapshot') + '), capped, no secret or VIN');

/* a VIN across the cap is scrubbed whole before the cut */
var edge = path.join(dir, 'edge');
fs.mkdirSync(edge);
mk('var/opt/public/sin/crashhandler/restartInfo.xml', 'y'.repeat(65472 - 8) + ' WBA8E9C50GK123456 ' + 'y'.repeat(300));
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', edge], { env: XENV });
var cut = fs.readFileSync(path.join(edge, 'restartInfo-crashhandler.xml'), 'utf8');
assert(cut.indexOf('WBA8E9') < 0 && / <VIN/.test(cut) && /\(cut at 65472 bytes\)\n$/.test(cut), cut.slice(-120));
/* a source past what is read that scrubbing shrinks under the cap still says it was cut */
mk('var/opt/public/sin/crashhandler/restartInfo.xml', new Array(5000).join('WBA8E9C50GK123456 '));
var edge2 = path.join(dir, 'edge2');
fs.mkdirSync(edge2);
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', edge2], { env: XENV });
var shrunk = fs.readFileSync(path.join(edge2, 'restartInfo-crashhandler.xml'), 'utf8');
assert(shrunk.length < 30000 && shrunk.indexOf('WBA') < 0 && /\n\.\.\. \(cut at \d+ bytes\)\n$/.test(shrunk), shrunk.slice(-80));
console.log('ok   a VIN across the cap is scrubbed before the cut; a shrunk source still says it was cut');

/* sqlite3 that hangs is killed at 2 s; a missing database or folder is left out */
fs.writeFileSync(path.join(bin, 'sqlite3'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
var snap2 = path.join(dir, 'snap2');
fs.mkdirSync(snap2);
var t0 = Date.now();
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', snap2], { env: XENV });
assert(Date.now() - t0 < 6000, 'bounded: ' + (Date.now() - t0) + ' ms');
assert(/\(sqlite3 killed after 2000 ms\)\n$/.test(fs.readFileSync(path.join(snap2, 'recmgr-crashes.txt'), 'utf8')));
cp.execFileSync('rm', ['-rf', path.join(U, 'var/opt/public/sin/recmgr'), path.join(U, 'var/opt/kerneldump')]);
var snap3 = path.join(dir, 'snap3');
fs.mkdirSync(snap3);
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', snap3], { env: XENV });
assert.deepStrictEqual(fs.readdirSync(snap3).sort(), ['core-dumps.txt', 'restartInfo-crashhandler.xml']);
assert(fs.readFileSync(path.join(snap3, 'core-dumps.txt'), 'utf8').indexOf('kerneldump') < 0);
console.log('ok   a hung sqlite3 is killed at 2 s; what is absent is left out');

/* fail closed: a link is never followed, a path that is no folder is a line, not a crash; the crash table is a
 * capped file whatever the rows */
var snap4 = path.join(dir, 'snap4');
fs.mkdirSync(snap4);
var secret = mk('secret-target', 'ghp_FAKEtoken0123456789abcdefghijklmnop');
fs.unlinkSync(path.join(U, 'var/opt/public/sin/crashhandler/restartInfo.xml'));
fs.symlinkSync(secret, path.join(U, 'var/opt/public/sin/crashhandler/restartInfo.xml'));
fs.writeFileSync(path.join(U, 'var/opt/public/sin/recmgr'), 'not a folder');
var rr = cp.spawnSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', snap4], { env: XENV, encoding: 'utf8' });
assert.strictEqual(rr.status, 0, rr.stderr);
assert(!fs.existsSync(path.join(snap4, 'restartInfo-crashhandler.xml')), 'a link is no record');
assert.strictEqual(fs.readFileSync(path.join(snap4, 'restartInfo-recmgr.xml'), 'utf8'), '(failed: ENOTDIR)\n');
assert(fs.readdirSync(snap4).every(function (n) { return fs.readFileSync(path.join(snap4, n), 'utf8').indexOf('ghp_') < 0; }));
console.log('ok   a link is never followed; an odd path is a line in the file, never a failure');

/* the folder scan stops at SCAN_MAX entries and says so */
var many = path.join(U, 'var/opt/public/sin/gcd');
fs.mkdirSync(many, { recursive: true });
for (i = 0; i < 5100; i++) fs.writeFileSync(path.join(many, 'g' + i), '');
var snap5 = path.join(dir, 'snap5');
fs.mkdirSync(snap5);
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', snap5], { env: XENV });
var gcd = fs.readFileSync(path.join(snap5, 'core-dumps.txt'), 'utf8').split('\n');
assert(gcd.indexOf('-- /var/opt/public/sin/gcd (the first 5000 entries looked at) (the newest 100 of 5000)') >= 0, gcd.filter(function (l) { return /gcd/.test(l); }).join('|'));
console.log('ok   a folder of thousands of entries is cut at 5000 looked at, 100 listed');

/* scrub <dir>: every file, a link removed, a file too large replaced by a line */
var sd = path.join(dir, 'scrub');
fs.mkdirSync(sd);
fs.writeFileSync(path.join(sd, 'a.txt'), 'x WBA8E9C50GK123456 y\n');
fs.writeFileSync(path.join(sd, 'clean.txt'), 'nothing here\n');
fs.symlinkSync(secret, path.join(sd, 'link'));
fs.writeFileSync(path.join(sd, 'huge.txt'), Buffer.alloc(9 * 1024 * 1024, 0x61));
rr = cp.spawnSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'scrub', sd], { env: XENV, encoding: 'utf8' });
assert.strictEqual(rr.status, 0, rr.stderr);
assert.strictEqual(fs.readFileSync(path.join(sd, 'a.txt'), 'utf8'), 'x <VIN> y\n');
assert.strictEqual(fs.readFileSync(path.join(sd, 'clean.txt'), 'utf8'), 'nothing here\n');
assert(!fs.existsSync(path.join(sd, 'link')), 'the link is gone');
assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'ghp_FAKEtoken0123456789abcdefghijklmnop', 'its target is not touched');
assert.strictEqual(fs.readFileSync(path.join(sd, 'huge.txt'), 'utf8'), '(left out: larger than 8388608 bytes)\n');
console.log('ok   scrub <dir>: VINs replaced in every file, a link removed, a file too large left out with a line');

/* a scrub that fails stops the archive: nothing is packed that was not scrubbed */
var CUR2 = path.join(dir, 'current2');
fs.mkdirSync(CUR2);
fs.readdirSync(CUR).forEach(function (n) { fs.copyFileSync(path.join(CUR, n), path.join(CUR2, n)); });
fs.writeFileSync(path.join(CUR2, 'logs_extra.js'), 'if (process.argv[2] === "scrub") process.exit(1);\n');
var out2 = path.join(dir, 'out-fail');
fs.mkdirSync(out2);
rr = cp.spawnSync('sh', [path.join(CUR2, 'collect-logs.sh'), '-o', out2], { env: XENV, encoding: 'utf8' });
assert.strictEqual(rr.status, 1, rr.stdout + rr.stderr);
assert(/could not scrub/.test(rr.stderr) && fs.readdirSync(out2).length === 0, 'no archive: ' + fs.readdirSync(out2));
console.log('ok   a failed scrub: no archive is written');

/* scrub <dir>: the last 7 of a VIN found in any file go from all of them; a file named with a VIN is renamed, so
 * no VIN is left in the archive's member names */
var nd = path.join(dir, 'names');
fs.mkdirSync(nd);
fs.writeFileSync(path.join(nd, 'a.txt'), 'owner WBA8E9C50GK123456, crash A123456, short K123456\n');
fs.writeFileSync(path.join(nd, 'run-WBA8E9C50GK123456.json'), 'c1');
fs.writeFileSync(path.join(nd, 'status-K123456.json'), 'c2');
fs.writeFileSync(path.join(nd, 'kept-WBA-5R7-1070-FK6-7620.log'), 'c3');
fs.writeFileSync(path.join(nd, 'crash-A123456.txt'), 'c4');
fs.writeFileSync(path.join(nd, 'journal-carplay.txt'), 'c5 FK67620\n');
rr = cp.spawnSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'scrub', nd], { env: XENV, encoding: 'utf8' });
assert.strictEqual(rr.status, 0, rr.stderr);
var left = fs.readdirSync(nd).sort();
assert.deepStrictEqual(left.filter(function (n) { return !/^file-\d+$/.test(n); }), ['a.txt', 'crash-A123456.txt', 'journal-carplay.txt'], left.join(' '));
assert.deepStrictEqual(left.filter(function (n) { return /^file-\d+$/.test(n); }).map(function (n) { return fs.readFileSync(path.join(nd, n), 'utf8'); }).sort(), ['c1', 'c2', 'c3']);
assert.strictEqual(fs.readFileSync(path.join(nd, 'a.txt'), 'utf8'), 'owner <VIN>, crash A123456, short <VIN>\n');
assert.strictEqual(fs.readFileSync(path.join(nd, 'journal-carplay.txt'), 'utf8'), 'c5 <VIN>\n', 'the last 7 of a spaced VIN found in a name');
assert.strictEqual(fs.readFileSync(path.join(nd, 'crash-A123456.txt'), 'utf8'), 'c4');
console.log('ok   scrub <dir>: files named with a VIN are renamed file-<n>; a crash id in a name or text stays');
/* scrub <dir>: a file of one VIN repeated to the size limit does not grow the process by its occurrences (the
 * logs service has 160 MiB; collecting every occurrence took 224 MB of RSS) */
var big = path.join(dir, 'bigvin');
fs.mkdirSync(big);
fs.writeFileSync(path.join(big, 'big.txt'), Buffer.from('WBA8E9C50GK123456 '.repeat(Math.floor(8 * 1024 * 1024 / 18))));
var memJs = 'var x=require(process.argv[1]),r0=process.memoryUsage().rss;x.scrubDir(process.argv[2]);console.log(process.memoryUsage().rss-r0)';
rr = cp.spawnSync(process.execPath, ['-e', memJs, path.join(CUR, 'logs_extra.js'), big], { env: XENV, encoding: 'utf8' });
assert.strictEqual(rr.status, 0, rr.stderr);
var bigText = fs.readFileSync(path.join(big, 'big.txt'), 'utf8');
assert(/^(<VIN> )+$/.test(bigText), 'every occurrence replaced');
assert(Number(rr.stdout) < 80 * 1024 * 1024, 'RSS grew by ' + rr.stdout.trim() + ' bytes');
console.log('ok   scrub <dir>: 8 MiB of one repeated VIN is scrubbed whole, the process grows by under 80 MB');

/* scrub <dir>: at most 64 distinct last-7 forms are kept; the full VINs past that are replaced, their bare last 7 are not */
var many = path.join(dir, 'manyvin');
fs.mkdirSync(many);
function vinN(n) { return 'WBA8E9C50GK' + String(n).padStart(6, '0'); }
var lines = [];
for (i = 1; i <= 70; i++) lines.push('v ' + vinN(i));
fs.writeFileSync(path.join(many, 'a.txt'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(many, 'b.txt'), 'first K000001 last K000070\n');
rr = cp.spawnSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'scrub', many], { env: XENV, encoding: 'utf8' });
assert.strictEqual(rr.status, 0, rr.stderr);
assert(!/WBA8E9C50GK/.test(fs.readFileSync(path.join(many, 'a.txt'), 'utf8')), 'all 70 full VINs replaced');
assert.strictEqual(fs.readFileSync(path.join(many, 'b.txt'), 'utf8'), 'first <VIN> last K000070\n');
console.log('ok   scrub <dir>: past 64 distinct VINs the full ones are still replaced, the bare last 7 of the later ones are not');

var members = cp.execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
assert(!/WBA8E9C50GK123456|K123456/i.test(members), 'no VIN in the archive\'s member names');

/* the report and the snapshot never emit a token or a private key of the files they do not pick from: a token
 * and a key block in state.json under other keys, in a component manifest, in the deploy tool's config and the
 * updater's files (the free text of the files they do copy is copied as it is) */
var leaks = path.join(dir, 'leaks');
fs.mkdirSync(leaks);
fs.mkdirSync(path.join(leaks, 'snap'));
fs.mkdirSync(path.join(leaks, 'rep'));
mk('var/opt/mgu-updater/key.pem', PEM);
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'snapshot', path.join(leaks, 'snap')], { env: XENV });
cp.execFileSync(process.execPath, [path.join(CUR, 'logs_extra.js'), 'report', path.join(leaks, 'rep')], { env: XENV });
var emitted = fs.readdirSync(path.join(leaks, 'rep')).map(function (n) { return fs.readFileSync(path.join(leaks, 'rep', n), 'utf8'); })
    .concat(fs.readdirSync(path.join(leaks, 'snap')).map(function (n) { return fs.readFileSync(path.join(leaks, 'snap', n), 'utf8'); })).join('\n');
assert(/tool waze-on-cluster 0\.9\.7 firmware/.test(emitted), 'the report ran');
['ghp_FAKE', 'PRIVATE KEY', 'MIIEvQIBADANBgkq', 'hunter2'].forEach(function (x) { assert(emitted.indexOf(x) < 0, 'emitted: ' + x); });
console.log('ok   report and snapshot: a token and a private key under a key or in a file they do not pick are not emitted');

/* a symlink planted at the name the old script wrote its root-opened temporary file to is neither followed nor
 * touched, and the archive is written; an output name that is a link or a folder is refused */
var out3 = path.join(dir, 'out-oldname'), victim = mk('victim', 'precious\n');
fs.mkdirSync(out3);
fs.writeFileSync(path.join(bin, 'date'), '#!/bin/sh\ncase "$*" in *+%Y%m%dT%H%M%SZ*) echo 20261101T000000Z;; *) exec /bin/date "$@";; esac\n', { mode: 0o755 });
var old = path.join(out3, '.woc-logs-20261101T000000Z.tar.gz.part');
fs.symlinkSync(victim, old);
rr = cp.spawnSync('sh', [path.join(CUR, 'collect-logs.sh'), '-o', out3], { env: XENV, encoding: 'utf8' });
assert.strictEqual(rr.status, 0, rr.stdout + rr.stderr);
assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious\n', 'the link\'s target is untouched');
assert.strictEqual(fs.readlinkSync(old), victim, 'the link is as it was');
var made = path.join(out3, 'woc-logs-20261101T000000Z.tar.gz');
assert.strictEqual(rr.stdout.trim(), made);
assert(fs.lstatSync(made).isFile() && !fs.lstatSync(made).isSymbolicLink(), 'a regular file');
cp.execFileSync('tar', ['-tzf', made]);
assert.deepStrictEqual(fs.readdirSync(out3).sort(), ['.woc-logs-20261101T000000Z.tar.gz.part', 'woc-logs-20261101T000000Z.tar.gz'], 'no other file left');
['link', 'folder'].forEach(function (kind) {
    var o = path.join(dir, 'out-' + kind);
    fs.mkdirSync(o);
    var target = path.join(o, 'woc-logs-20261101T000000Z.tar.gz');
    if (kind === 'link') fs.symlinkSync(victim, target); else fs.mkdirSync(target);
    var r4 = cp.spawnSync('sh', [path.join(CUR, 'collect-logs.sh'), '-o', o], { env: XENV, encoding: 'utf8' });
    assert.strictEqual(r4.status, 1, r4.stdout + r4.stderr);
    assert(/folder or a link/.test(r4.stderr), r4.stderr);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious\n');
    assert.deepStrictEqual(fs.readdirSync(o), ['woc-logs-20261101T000000Z.tar.gz'], 'nothing else written');
});
console.log('ok   collect-logs: a link at the old temporary name is not followed; a link or a folder as the output is refused');

/* the published archive is 0640 (the output folder's group reads it; root's mktemp file is 0600); a chmod that
 * fails is a failure to write the archive. A folder that appears at the output name after the check (a fake gzip
 * makes it, as another writer of the folder could) is not moved into: the publish fails and leaves nothing in it. */
var bin2 = path.join(dir, 'bin2');
fs.mkdirSync(bin2);
var XENV2 = Object.assign({}, XENV, { PATH: bin2 + ':' + XENV.PATH });
var STAMPED = 'woc-logs-20261101T000000Z.tar.gz';
var out6 = path.join(dir, 'out-mode');
fs.mkdirSync(out6);
rr = cp.spawnSync('sh', [path.join(CUR, 'collect-logs.sh'), '-o', out6], { env: XENV, encoding: 'utf8' });
assert.strictEqual(rr.status, 0, rr.stdout + rr.stderr);
assert.strictEqual(fs.statSync(path.join(out6, STAMPED)).mode & 0o777, 0o640, 'published 0640');
fs.writeFileSync(path.join(bin2, 'chmod'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
var out7 = path.join(dir, 'out-chmod');
fs.mkdirSync(out7);
rr = cp.spawnSync('sh', [path.join(CUR, 'collect-logs.sh'), '-o', out7], { env: XENV2, encoding: 'utf8' });
assert.strictEqual(rr.status, 1, rr.stdout + rr.stderr);
assert(/could not write/.test(rr.stderr) && fs.readdirSync(out7).length === 0, 'no archive: ' + fs.readdirSync(out7));
fs.unlinkSync(path.join(bin2, 'chmod'));
var realGzip = cp.execFileSync('sh', ['-c', 'command -v gzip'], { env: XENV, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(bin2, 'gzip'), '#!/bin/sh\nmkdir "' + path.join(dir, 'out-race', STAMPED) + '"\nexec ' + realGzip + ' "$@"\n', { mode: 0o755 });
var out8 = path.join(dir, 'out-race');
fs.mkdirSync(out8);
rr = cp.spawnSync('sh', [path.join(CUR, 'collect-logs.sh'), '-o', out8], { env: XENV2, encoding: 'utf8' });
assert.strictEqual(rr.status, 1, rr.stdout + rr.stderr);
assert(/could not write/.test(rr.stderr), rr.stderr);
assert.deepStrictEqual(fs.readdirSync(out8), [STAMPED], 'only the folder that was there');
assert.deepStrictEqual(fs.readdirSync(path.join(out8, STAMPED)), [], 'nothing moved into it');
console.log('ok   collect-logs: the archive is published 0640; a failed chmod or a folder that appeared at the output name is a failure, nothing left');

/* the scrub does not fail open: without logs_extra.js there is no archive */
var CUR3 = path.join(dir, 'current3');
fs.mkdirSync(CUR3);
fs.readdirSync(CUR).filter(function (n) { return n !== 'logs_extra.js'; }).forEach(function (n) { fs.copyFileSync(path.join(CUR, n), path.join(CUR3, n)); });
var out5 = path.join(dir, 'out-noextra');
fs.mkdirSync(out5);
rr = cp.spawnSync('sh', [path.join(CUR3, 'collect-logs.sh'), '-o', out5], { env: XENV, encoding: 'utf8' });
assert.notStrictEqual(rr.status, 0, rr.stdout + rr.stderr);
assert(/logs_extra\.js is missing/.test(rr.stderr) && fs.readdirSync(out5).length === 0, 'no archive: ' + rr.stderr + fs.readdirSync(out5));
console.log('ok   collect-logs: no logs_extra.js, no archive');

try { fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null; } catch (e) { /* left in tmp */ }
