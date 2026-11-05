// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs.js as the service runs, on the loopback address in place of the
 * hotspot's, with a stand-in collect-logs.sh and df: the app's save over the
 * socket, the archive caps, the free-space check, the page's token, Host,
 * method and traversal refusals and its limits, the download, requests in
 * absolute or malformed form, aborted downloads, a save that outlasts its
 * time, and the service stopping by itself. */
var assert = require('assert'), fs = require('fs'), os = require('os'), net = require('net');
var http = require('http'), path = require('path'), cp = require('child_process');
var logs = require('../logs.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wlg-'));
var LO = Object.keys(os.networkInterfaces()).filter(function (n) {
    return os.networkInterfaces()[n].some(function (a) { return a.address === '127.0.0.1'; });
})[0];
var collect = path.join(tmp, 'collect.sh'), df = path.join(tmp, 'df'), sizeFile = path.join(tmp, 'size');
var freeFile = path.join(tmp, 'free'), runs = path.join(tmp, 'runs');
/* writes an archive of $(cat size) bytes into the -o folder, as collect-logs.sh -o does */
fs.writeFileSync(collect, '[ "$1" = -o ] || exit 2\necho run >> ' + runs + '\n' +
    'n=woc-logs-$(date -u +%Y%m%dT%H%M%SZ).tar.gz\nhead -c "$(cat ' + sizeFile + ')" /dev/zero > "$2/.$n.part" && ' +
    'mv "$2/.$n.part" "$2/$n" && echo "$2/$n"\n');
fs.writeFileSync(df, '#!/bin/sh\n[ -s ' + freeFile + ' ] || exit 1\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\n' +
    'echo "/dev/x 1000000 1 $(cat ' + freeFile + ') 1% /var/opt"\n');
fs.chmodSync(df, 0o755);

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(what, fn) {
    for (var i = 0; i < 400; i++) { if (await fn()) return; await delay(25); }
    throw new Error('timed out waiting for ' + what);
}

/* the service on its own folder and socket; resolves { child, dir, sock, exited } */
function start(name, extra) {
    var dir = path.join(tmp, name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    var sock = path.join(tmp, name + '.sock');
    var child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'logs.js')], {
        env: Object.assign({}, process.env, { WOC_LOGS_DIR: dir, WOC_LOGS_SOCK: sock, WOC_LOGS_COLLECT: collect,
            WOC_LOGS_DF: df, WOC_LOGS_IFACE: LO, WOC_LOGS_PORT: '0', WOC_LOGS_IDLE_MS: '300',
            WOC_LOGS_AFTER_SAVE_MS: '1500', WOC_LOGS_POLL_MS: '200', WOC_LOGS_SAVE_GAP_MS: '1' }, extra || {}),
        stdio: ['ignore', 'pipe', 'inherit'] });
    var out = '';
    child.stdout.on('data', function (d) { out += d; });
    var s = { child: child, dir: dir, sock: sock, exited: null, out: function () { return out; } };
    child.on('exit', function (code) { s.exited = { code: code, at: Date.now() }; });
    return s;
}

/* an app on the socket: its last state and how to send */
function app(sock) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(sock), buf = '', a = { state: null, states: [], sock: c };
        a.send = function (o) { c.write(JSON.stringify(o) + '\n'); };
        a.close = function () { c.destroy(); };
        c.setEncoding('utf8');
        c.on('error', reject);
        c.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                a.state = JSON.parse(buf.slice(0, i));
                a.states.push(a.state);
                buf = buf.slice(i + 1);
            }
            resolve(a);
        });
    });
}
async function connect(sock) {
    await until('the socket', function () { return fs.existsSync(sock); });
    return app(sock);
}

/* one raw request line to host:port; resolves the status code, or 0 when the server closed without one */
function raw(host, line) {
    var hp = host.split(':');
    return new Promise(function (resolve) {
        var c = net.connect(Number(hp[1]), hp[0]), buf = '';
        c.on('connect', function () { c.write(line + '\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n'); });
        c.on('data', function (d) { buf += d; });
        c.on('error', function () { /* close follows */ });
        c.on('close', function () { var m = /^HTTP\/1\.1 (\d+)/.exec(buf); resolve(m ? Number(m[1]) : 0); });
    });
}

function get(url, opts) {
    var u = new (require('url').URL)(url), o = opts || {};
    return new Promise(function (resolve, reject) {
        var req = http.request({ host: u.hostname, port: u.port, method: o.method || 'GET', path: o.path || u.pathname,
            headers: Object.assign({ Host: u.host }, o.headers || {}) }, function (res) {
            var parts = [];
            res.on('data', function (d) { parts.push(d); });
            res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }); });
        });
        req.on('error', reject);
        req.end(o.body);
    });
}

(async function () {
    fs.writeFileSync(sizeFile, '2048');
    fs.writeFileSync(freeFile, String(logs.MIN_FREE / 1024 + 1));

    /* ---- the app saves; the page lists and sends ---- */
    var s = start('main');
    var a = await connect(s.sock);
    await until('the page url', function () { return a.state && a.state.url; });
    var m = /^http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{32})\/$/.exec(a.state.url);
    assert(m, 'url ' + a.state.url);
    assert.deepStrictEqual(a.state.archives, []);
    assert(s.out().indexOf(m[2]) < 0, 'the token is not logged');
    a.send({ cmd: 'save' });
    await until('saved', function () { return a.state.saved && !a.state.saving; });
    assert(a.states.some(function (x) { return x.saving; }), 'saving shown while it runs');
    assert.strictEqual(a.state.error, null);
    assert(/^woc-logs-\d{8}T\d{6}Z\.tar\.gz$/.test(a.state.saved));
    assert.strictEqual(a.state.archives[0].name, a.state.saved);
    assert.strictEqual(a.state.archives[0].size, 2048);
    console.log('ok   the app\'s save: saving, then the archive listed and named');

    var base = a.state.url, name = a.state.saved;
    var r = await get(base);
    assert.strictEqual(r.status, 200);
    assert(r.body.toString().indexOf('href="' + name + '"') > 0, 'the page lists it');
    r = await get(base + name);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-length'], '2048');
    assert.strictEqual(r.headers['content-disposition'], 'attachment; filename="' + name + '"');
    assert.strictEqual(r.body.length, 2048);
    r = await get(base + name, { method: 'HEAD' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 0);
    console.log('ok   the page with its token lists the archive and sends it');

    /* refusals */
    var host = /^http:\/\/([^/]+)\//.exec(base)[1], token = m[2];
    fs.writeFileSync(path.join(tmp, 'secret.tar.gz'), 'secret');
    fs.symlinkSync(path.join(tmp, 'secret.tar.gz'), path.join(s.dir, 'woc-logs-20990101T000000Z.tar.gz'));
    var refused = [
        ['/' + token + '/../secret.tar.gz', 404], ['/' + token + '/..%2fsecret.tar.gz', 404],
        ['/' + token + '/%2e%2e%2fsecret.tar.gz', 404], ['/' + token + '//etc/passwd', 404],
        ['/' + token + '/woc-logs-20990101T000000Z.tar.gz', 404], ['/' + token + '/' + name + '/', 404],
        ['/' + token + '/component.json', 404], ['/' + token, 404], ['/' + token + '/x/' + name, 404]];
    for (var i = 0; i < refused.length; i++) {
        r = await get('http://' + host + '/', { path: refused[i][0] });
        assert.strictEqual(r.status, refused[i][1], refused[i][0] + ' -> ' + r.status);
        assert(r.body.toString().indexOf('secret') < 0);
    }
    assert(!a.state.archives.some(function (x) { return x.name === 'woc-logs-20990101T000000Z.tar.gz'; }) &&
        !logs.archives(s.dir).some(function (x) { return /2099/.test(x.name); }), 'a link is no archive');
    console.log('ok   traversal: dot segments, encoded slashes, links, other files and paths refused');

    assert.strictEqual((await get(base, { headers: { Host: 'evil.example:80' } })).status, 421);
    assert.strictEqual((await get(base, { method: 'POST', body: 'x' })).status, 405);
    assert.strictEqual((await get(base + 'a'.repeat(300))).status, 414);
    console.log('ok   another Host, another method, an overlong path refused');

    for (i = 0; i < 9; i++) assert.strictEqual((await get('http://' + host + '/' + 'f'.repeat(32) + '/')).status, 404);
    assert.strictEqual((await get('http://' + host + '/')).status, 404, 'no token');
    assert.strictEqual((await get(base)).status, 429, 'locked out after 10 wrong tokens, the right one too');
    console.log('ok   a wrong token is 404; 10 in a minute lock the address out (429)');

    /* ---- caps ---- */
    var old = ['20260101T000001Z', '20260101T000002Z', '20260101T000003Z', '20260101T000004Z', '20260101T000005Z', '20260101T000006Z'];
    var capDir = path.join(tmp, 'caps');
    fs.mkdirSync(capDir);
    old.forEach(function (t, k) { fs.writeFileSync(path.join(capDir, 'woc-logs-' + t + '.tar.gz'), Buffer.alloc(k === 1 ? 9 << 20 : 1024)); });
    fs.writeFileSync(path.join(capDir, '.woc-logs-20260101T000007Z.tar.gz.part'), 'partial');
    fs.writeFileSync(path.join(capDir, 'keep.txt'), 'not ours');
    var c = start('caps');
    var ca = await connect(c.sock);
    assert(!fs.existsSync(path.join(capDir, '.woc-logs-20260101T000007Z.tar.gz.part')), 'a partial archive is removed at start');
    assert.strictEqual(logs.archives(capDir).length, logs.ARCHIVES, 'the oldest past the count removed at start');
    fs.writeFileSync(sizeFile, String(12 << 20));
    ca.send({ cmd: 'save' });
    await until('saved with caps', function () { return ca.state.saved && !ca.state.saving; });
    var left = logs.archives(capDir), total = left.reduce(function (t, x) { return t + x.size; }, 0);
    assert(left.length <= logs.ARCHIVES && total <= logs.TOTAL_MAX, left.length + ' archives, ' + total + ' B');
    assert.strictEqual(left[0].name, ca.state.saved, 'the new one kept');
    assert(!left.some(function (x) { return x.size === 9 << 20; }), 'the 9 MiB one, oldest past the total, went');
    assert(fs.existsSync(path.join(capDir, 'keep.txt')), 'other files stay');
    console.log('ok   archive caps: at most ' + logs.ARCHIVES + ', ' + (logs.TOTAL_MAX >> 20) + ' MiB together, oldest first; partial ones removed');

    fs.writeFileSync(sizeFile, String(logs.ARCHIVE_MAX + 1));
    var before = logs.archives(capDir).map(function (x) { return x.name; });
    await delay(1100);
    ca.send({ cmd: 'save' });
    await until('too large', function () { return ca.state.error === 'too-large'; });
    assert.deepStrictEqual(logs.archives(capDir).map(function (x) { return x.name; }), before, 'an oversize archive is deleted, nothing else');
    var runsBefore = fs.readFileSync(runs, 'utf8').split('\n').length;
    fs.writeFileSync(freeFile, String(logs.MIN_FREE / 1024 - 1));
    ca.send({ cmd: 'save' });
    await until('no space', function () { return ca.state.error === 'no-space' && !ca.state.saving; });
    fs.writeFileSync(freeFile, '');
    await delay(100);
    ca.send({ cmd: 'save' });
    await until('unknown free space', function () { return ca.states.filter(function (x) { return x.error === 'no-space'; }).length >= 2 && !ca.state.saving; });
    assert.strictEqual(fs.readFileSync(runs, 'utf8').split('\n').length, runsBefore, 'collect-logs not run without the space');
    console.log('ok   an archive over ' + (logs.ARCHIVE_MAX >> 20) + ' MiB deleted; no save below ' + (logs.MIN_FREE >> 20) + ' MiB free or with free space unknown');
    ca.close();

    /* ---- odd requests, aborted downloads, a save that hangs ---- */
    fs.writeFileSync(sizeFile, String(8 << 20));
    fs.writeFileSync(freeFile, String(logs.MIN_FREE / 1024 + 1));
    var o = start('odd', { WOC_LOGS_SAVE_TIMEOUT_MS: '700' });
    var oa = await connect(o.sock);
    oa.send({ cmd: 'save' });
    await until('saved', function () { return oa.state.saved && !oa.state.saving && oa.state.url; });
    var ohost = /^http:\/\/([^/]+)\//.exec(oa.state.url)[1], obase = oa.state.url, oname = oa.state.saved;
    var odd = ['GET http://' + ohost + '/ HTTP/1.1', 'GET ' + 'http://' + ohost + obase.slice(obase.indexOf('/', 7)) + ' HTTP/1.1',
        'GET * HTTP/1.1', 'GET x HTTP/1.1', 'GET ?a=/ HTTP/1.1'];
    for (i = 0; i < 12; i++) {
        var code = await raw(ohost, odd[i % odd.length]);
        assert(code === 404 || code === 0 || code === 400, odd[i % odd.length] + ' -> ' + code);
    }
    assert.strictEqual(o.exited, null, 'the server stays up');
    console.log('ok   absolute-form and malformed request lines: refused, the service stays up');

    var fds = function () { try { return fs.readdirSync('/proc/' + o.child.pid + '/fd').length; } catch (e) { return null; } };
    var fdBefore = fds();
    for (i = 0; i < 6; i++) {
        await new Promise(function (resolve) {
            var u = new (require('url').URL)(obase + oname);
            var req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: u.host } }, function (res) {
                assert.strictEqual(res.statusCode, 200);
                res.once('data', function () { req.abort(); resolve(); });
            });
            req.on('error', function () { /* aborted */ });
        });
    }
    await delay(300);
    r = await get(obase + oname);
    assert.strictEqual(r.status, 200, 'aborted downloads leave no count behind');
    assert.strictEqual(r.body.length, 8 << 20);
    if (fdBefore !== null) assert(fds() <= fdBefore + 1, 'no file left open: ' + fdBefore + ' -> ' + fds());
    console.log('ok   aborted downloads free their count and their file' + (fdBefore === null ? ' (open files not checked here)' : ''));

    var hang = path.join(tmp, 'hang.sh'), pids = path.join(tmp, 'pids');
    fs.writeFileSync(hang, 'n=woc-logs-20260101T000009Z.tar.gz\n(echo $$ >> ' + pids + '; exec sleep 30) &\n' +
        'echo partial > "$2/.$n.part"\nsleep 30\n');
    var h = start('hang', { WOC_LOGS_COLLECT: hang, WOC_LOGS_SAVE_TIMEOUT_MS: '500' });
    var ha = await connect(h.sock);
    ha.send({ cmd: 'save' });
    await until('timed out', function () { return ha.state.error === 'failed' && !ha.state.saving; });
    await delay(200);
    assert(!fs.readdirSync(h.dir).some(function (n) { return /\.part$/.test(n); }), 'the partial archive removed');
    fs.readFileSync(pids, 'utf8').trim().split('\n').forEach(function (pid) {
        assert.throws(function () { process.kill(Number(pid), 0); }, /ESRCH/, 'child ' + pid + ' killed');
    });
    console.log('ok   a save past its time: its whole process group killed, the partial archive removed');
    ha.close();
    oa.close();

    /* ---- stopping by itself ---- */
    a.close();
    await until('main stopped', function () { return s.exited; });
    assert.strictEqual(s.exited.code, 0);
    await get(base).then(function () { throw new Error('still serving'); }, function (e) { assert(/ECONNREFUSED/.test(e.code)); });
    console.log('ok   the app gone and no save for the window: the service exits 0 and the page is gone');
    await until('caps stopped', function () { return c.exited; });
    await until('odd stopped', function () { return o.exited && h.exited; });

    fs.writeFileSync(sizeFile, '100');
    fs.writeFileSync(freeFile, String(logs.MIN_FREE / 1024 + 1));
    var w = start('window');
    var wa = await connect(w.sock);
    var t0 = Date.now();
    wa.send({ cmd: 'save' });
    await until('saved', function () { return wa.state.saved; });
    wa.close();
    await delay(800);
    assert.strictEqual(w.exited, null, 'serving on after a save with the app gone');
    assert.strictEqual((await get(wa.state.url)).status, 200);
    await until('window stopped', function () { return w.exited; });
    var ran = w.exited.at - t0;
    assert(ran >= 1500 && ran < 4000, 'stopped ' + ran + ' ms after the save');
    console.log('ok   after a save the page stays for the window, then the service exits (' + ran + ' ms)');

    /* a start with a fresh archive and no app (the deploy tool's restart) */
    var r2 = start('window');
    await delay(500);
    assert.strictEqual(r2.exited, null, 'a fresh archive keeps the window');
    await until('restart stopped', function () { return r2.exited; });
    var cold = start('window');
    await until('no window', function () { return cold.exited; });
    assert.strictEqual(cold.exited.code, 0);
    console.log('ok   a start with no app: on for what is left of the last save\'s window, else it exits');

    cp.execFileSync('rm', ['-rf', tmp]);
    console.log('logs: all passed');
    process.exit(0);
})().catch(function (e) { console.error('FAIL', e && e.stack); process.exit(1); });
