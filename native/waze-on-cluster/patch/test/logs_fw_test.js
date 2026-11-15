// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs_fw.js against a stand-in nft holding ip filter input: ensure leaves
 * exactly one tagged rule at the top, also over rules a stopped page left;
 * the watch puts it back after a ruleset load and removes it at SIGTERM;
 * close removes every tagged rule and nothing else; a unit without the chain
 * gets nothing; an nft failure is an error. The folder helper. */
var assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
var EventEmitter = require('events');
process.env.WOC_FW_CHECK_MS = '50';
var fw = require('../logs_fw.js');
var gd = require('../group_dir.js');
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* chain: null (no such chain) or [{ handle, text }], top first */
function fakeNft(chain) {
    var next = 100, calls = [];
    function nft(args) {
        calls.push(args.join(' '));
        var a = args.join(' ');
        if (!chain) {
            var e = new Error('nft: Error: No such file or directory'); e.absent = true;
            return Promise.reject(e);
        }
        if (a === '-a list chain ip filter input') {
            return Promise.resolve('table ip filter {\n\tchain input {\n\t\ttype filter hook input priority 0; policy drop;\n' +
                chain.map(function (r) { return '\t\t' + r.text + ' # handle ' + r.handle + '\n'; }).join('') + '\t}\n}\n');
        }
        var m = /^delete rule ip filter input handle (\d+)$/.exec(a);
        if (m) {
            var i = chain.findIndex(function (r) { return String(r.handle) === m[1]; });
            if (i < 0) return Promise.reject(new Error('no rule ' + m[1]));
            chain.splice(i, 1);
            return Promise.resolve('');
        }
        m = /^insert rule ip filter input (.*)$/.exec(a);
        if (m) { chain.unshift({ handle: next++, text: m[1] }); return Promise.resolve(''); }
        return Promise.reject(new Error('unexpected nft ' + a));
    }
    nft.calls = calls;
    return nft;
}

var RULE = 'iifname "wlan_bridge" tcp dport 8475 accept comment "waze-on-cluster-logs"';

(async function () {
    var chain = [{ handle: 5, text: 'ct state established,related accept' },
        { handle: 6, text: RULE }, { handle: 7, text: 'iifname "lo" accept' }, { handle: 8, text: RULE }];
    var nft = fakeNft(chain);
    assert.strictEqual(await fw.ensure(nft), 'added');
    assert.deepStrictEqual(chain.map(function (r) { return r.text; }),
        [RULE, 'ct state established,related accept', 'iifname "lo" accept'], 'one tagged rule, at the top');
    console.log('ok   ensure: the rules a stopped page left are removed, one rule inserted at the top');

    var writes = nft.calls.length;
    assert.strictEqual(await fw.ensure(nft), 'kept');
    assert.strictEqual(nft.calls.length, writes + 1, 'a rule in place: only listed');
    chain.push(chain.shift());
    assert.strictEqual(await fw.ensure(nft), 'added', 'not at the top: put back at the top');
    assert.strictEqual(chain[0].text, RULE);
    assert.strictEqual(chain.filter(function (r) { return r.text === RULE; }).length, 1, 'still one');
    await fw.close(nft);
    assert.deepStrictEqual(chain.map(function (r) { return r.text; }), ['ct state established,related accept', 'iifname "lo" accept']);
    await fw.close(nft);
    console.log('ok   close: every tagged rule removed, the others kept; closing again changes nothing');

    var none = fakeNft(null);
    assert.strictEqual(await fw.ensure(none), 'absent');
    await fw.close(none);
    assert(!none.calls.some(function (c) { return /^(insert|delete)/.test(c); }), 'nothing written without the chain');
    console.log('ok   a unit without ip filter input: nothing to do, no error');

    var failing = function () { return Promise.reject(new Error('nft: Operation not permitted')); };
    await fw.ensure(failing).then(function () { throw new Error('resolved'); }, function (e) { assert(/not permitted/.test(e.message)); });
    console.log('ok   an nft failure is an error');

    /* the watch: a ruleset load drops the rule, the next check puts it back; SIGTERM removes it */
    var live = [{ handle: 1, text: 'ct state established,related accept' }], lines = [];
    var signals = new EventEmitter(), wnft = fakeNft(live);
    var asked = 0, up = function () { asked++; return Promise.resolve(true); };
    var done = fw.watch(wnft, function (l) { lines.push(l); }, signals, up);
    await delay(30);
    assert.strictEqual(live[0].text, RULE);
    live.splice(0, live.length, { handle: 2, text: 'ct state established,related accept' });
    await delay(120);
    assert.strictEqual(live[0].text, RULE, 'put back after a ruleset load');
    assert.strictEqual(live.filter(function (r) { return r.text === RULE; }).length, 1);
    signals.emit('SIGTERM');
    await done;
    assert(!live.some(function (r) { return r.text === RULE; }), 'removed at SIGTERM');
    assert.deepStrictEqual(lines.slice(-1), ['rule removed']);
    assert(asked >= 1, 'the logs service asked after');
    console.log('ok   watch: the rule put back after a ruleset load, removed at SIGTERM');

    /* the logs service refused (its start limit): the next check removes the rule and the watch ends */
    var gone = [{ handle: 1, text: 'ct state established,related accept' }], glines = [], calls = 0;
    var gdone = fw.watch(fakeNft(gone), function (l) { glines.push(l); }, new EventEmitter(),
        function () { calls++; return Promise.resolve(false); });
    await delay(25);
    assert.strictEqual(gone[0].text, RULE, 'the first check does not ask: the logs service is still queued behind it');
    assert.strictEqual(calls, 0);
    await gdone;
    assert(!gone.some(function (r) { return r.text === RULE; }), 'removed');
    assert.deepStrictEqual(glines, ['rule in place', 'the logs service is not running', 'rule removed']);
    console.log('ok   watch: with the logs service gone, the rule is removed and the watch ends');

    /* is-active: active, activating and reloading count as running */
    var sc = path.join(os.tmpdir(), 'wfw-systemctl-' + process.pid);
    var states = { active: true, activating: true, reloading: true, inactive: false, failed: false };
    for (var st in states) {
        fs.writeFileSync(sc, '#!/bin/sh\necho ' + st + '\n[ ' + st + ' = active ]\n');
        fs.chmodSync(sc, 0o755);
        process.env.WOC_SYSTEMCTL = sc;
        assert.strictEqual(await fw.logsAlive(), states[st], st);
    }
    fs.unlinkSync(sc);
    console.log('ok   the logs service counts as running while active, activating or reloading');

    /* the folder: root and the group, 2770; something else in its place refused */
    var gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgd-')), groups = path.join(gdir, 'group');
    var mygid = process.getgid();
    fs.writeFileSync(groups, 'root:x:0:\nsystemd-journal:x:' + mygid + ':sin_dltsys\n');
    gd.groupDir(path.join(gdir, 'saved'), 'systemd-journal', { groupFile: groups, uid: process.getuid() });
    var st = fs.statSync(path.join(gdir, 'saved'));
    assert.strictEqual(st.mode & 0o7777, 0o2770);
    assert.strictEqual(st.gid, mygid);
    assert.throws(function () { gd.gid('nosuch', groups); }, /no group nosuch/);
    fs.writeFileSync(path.join(gdir, 'file'), 'x');
    assert.throws(function () { gd.groupDir(path.join(gdir, 'file'), 'systemd-journal', { groupFile: groups, uid: process.getuid() }); }, /not a folder/);
    cp.execFileSync('rm', ['-rf', gdir]);
    console.log('ok   the folder: made, the group\'s, 2770; a file in its place refused');

    /* the command line, with nft as a script */
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfw-')), script = path.join(dir, 'nft'), log = path.join(dir, 'log');
    fs.writeFileSync(script, '#!/bin/sh\necho "$@" >> ' + log + '\n' +
        'case "$*" in "-a list chain ip filter input") echo \'\t\t' + RULE + ' # handle 9\';; esac\n');
    fs.chmodSync(script, 0o755);
    var r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'logs_fw.js'), 'close'],
        { env: Object.assign({}, process.env, { WOC_NFT: script }), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert(/delete rule ip filter input handle 9/.test(fs.readFileSync(log, 'utf8')));
    assert.strictEqual(cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'logs_fw.js'), 'open']).status, 2);
    cp.execFileSync('rm', ['-rf', dir]);
    console.log('ok   logs_fw.js close removes the tagged rule; an unknown action is refused');
    console.log('logs_fw: all passed');
})().catch(function (e) { console.error('FAIL', e && e.stack); process.exit(1); });
