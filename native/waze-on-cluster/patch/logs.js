#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs — saves log archives and serves them to a phone on the car's
 * hotspot. waze-on-cluster-logs.service runs it as a dynamic user in the
 * systemd-journal group when the app connects to its socket
 * (waze-on-cluster-logs.socket, group tm_oap_app).
 *
 * Socket (newline-delimited JSON):
 *   app -> logs   {"cmd":"save"}
 *   logs -> app   {"ev":"state","url":"http://<address>:8475/<token>/"|null,"saving":bool,
 *                  "error":null|"no-space"|"too-large"|"failed","saved":"<name>"|null,
 *                  "archives":[{"name","size","mtime"}]}   (newest first)
 *                 on connect and on every change
 *
 * Save: with MIN_FREE free in DIR, collect-logs.sh -o DIR writes
 * woc-logs-<UTC>.tar.gz there. One larger than ARCHIVE_MAX is deleted; then
 * the oldest go until at most ARCHIVES are left, together at most TOTAL_MAX
 * bytes. One save at a time, at most one every SAVE_GAP_MS.
 *
 * Page: http on IFACE's IPv4 address (looked up every POLL_MS) at PORT.
 * GET or HEAD /<token>/ lists the archives and /<token>/<name> sends one;
 * anything else is 404. The token is 128 random bits, new at each start, in
 * the url only. A request naming another Host than the address gets 421.
 * Per client address: 10 wrong tokens or REQ_MAX requests in a minute get
 * 429 for the rest of it, and at most 2 downloads at a time.
 *
 * It runs while an app is connected, while a save is underway, and until
 * AFTER_SAVE_MS after the last save (at start, the newest archive's time),
 * then IDLE_MS more, and exits 0; systemd then removes the firewall rule
 * (logs_fw.js).
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var http = require('http');
var crypto = require('crypto');
var cp = require('child_process');

var env = process.env;
var DIR = env.WOC_LOGS_DIR || '/var/opt/waze-on-cluster/saved';
var SOCK = env.WOC_LOGS_SOCK || '/dev/shm/waze-on-cluster/logs.sock';
var COLLECT = env.WOC_LOGS_COLLECT || '/var/opt/waze-on-cluster/current/collect-logs.sh';
var DF = env.WOC_LOGS_DF || 'df';
var IFACE = env.WOC_LOGS_IFACE || require('./logs_fw.js').IFACE;
var PORT = env.WOC_LOGS_PORT !== undefined ? Number(env.WOC_LOGS_PORT) : require('./logs_fw.js').PORT;
var AFTER_SAVE_MS = Number(env.WOC_LOGS_AFTER_SAVE_MS) || 15 * 60000;
var IDLE_MS = Number(env.WOC_LOGS_IDLE_MS) || 10000;
var POLL_MS = Number(env.WOC_LOGS_POLL_MS) || 5000;
var SAVE_GAP_MS = Number(env.WOC_LOGS_SAVE_GAP_MS) || 10000;
var SAVE_TIMEOUT_MS = Number(env.WOC_LOGS_SAVE_TIMEOUT_MS) || 120000;

var ARCHIVES = 5;
var TOTAL_MAX = 20 * 1024 * 1024;
var ARCHIVE_MAX = 16 * 1024 * 1024;
var MIN_FREE = 64 * 1024 * 1024;
var NAME = /^woc-logs-\d{8}T\d{6}Z\.tar\.gz$/;
var PART = /^\.woc-logs-.*\.part$/;
var CLIENTS = 8;
var LINE_MAX = 4096;
var FAIL_MAX = 10;
var REQ_MAX = 120;
var DOWNLOADS = 2;

function say(line) { console.log('logs: ' + line); }

/* The archives, newest first: [{ name, size, mtime }]. */
function archives(dir) {
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    return names.filter(function (n) { return NAME.test(n); }).sort().reverse().map(function (name) {
        try {
            var st = fs.lstatSync(path.join(dir, name));
            return st.isFile() ? { name: name, size: st.size, mtime: st.mtime.getTime() } : null;
        } catch (e) { return null; }
    }).filter(Boolean);
}

/* Deletes the oldest archives (never keep) past ARCHIVES or TOTAL_MAX, and
 * partial ones an interrupted save left unless one is being written. */
function prune(dir, keep, saving) {
    var list = archives(dir), total = list.reduce(function (a, x) { return a + x.size; }, 0);
    while (list.length && (list.length > ARCHIVES || total > TOTAL_MAX) && list[list.length - 1].name !== keep) {
        var old = list.pop();
        total -= old.size;
        try { fs.unlinkSync(path.join(dir, old.name)); say('deleted ' + old.name); } catch (e) { /* gone */ }
    }
    if (saving) return;
    try {
        fs.readdirSync(dir).filter(function (n) { return PART.test(n); })
            .forEach(function (n) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* gone */ } });
    } catch (e) { /* no folder */ }
}

/* Free bytes in dir from df -kP, or null. */
function freeBytes(dir, cb) {
    cp.execFile(DF, ['-kP', dir], { timeout: 10000 }, function (err, out) {
        var cols = !err && String(out).trim().split('\n').pop().split(/\s+/);
        var kb = cols && cols.length >= 4 ? Number(cols[3]) : NaN;
        cb(isFinite(kb) ? kb * 1024 : null);
    });
}

/* cmd in a process group of its own, killed whole (SIGKILL) after ms;
 * cb(err, stdout, stderr), each kept to its last 64 KiB. */
function run(cmd, args, ms, cb) {
    var out = '', errText = '', timedOut = false, done = false;
    var child = cp.spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    var timer = setTimeout(function () {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
    }, ms);
    function finish(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cb(err, out, errText);
    }
    child.stdout.on('data', function (d) { out = (out + d).slice(-65536); });
    child.stderr.on('data', function (d) { errText = (errText + d).slice(-65536); });
    child.on('error', finish);
    child.on('close', function (code, signal) {
        finish(timedOut ? new Error('timed out') : code ? new Error('exit ' + (code || signal)) : signal ? new Error(signal) : null);
    });
}

function ifaceAddr(name) {
    var list = os.networkInterfaces()[name] || [];
    var a = list.filter(function (x) { return x.family === 'IPv4' || x.family === 4; })[0];
    return a ? a.address : null;
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
}

function page(list) {
    var rows = list.map(function (a) {
        return '<li><a href="' + esc(a.name) + '" download>' + esc(a.name) + '</a><span>' +
            Math.max(1, Math.round(a.size / 1024)) + ' KB</span></li>';
    }).join('');
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Waze on cluster logs</title>' +
        '<style>body{margin:0;padding:20px 16px;font:16px/1.4 system-ui,sans-serif;background:#111;color:#eee}' +
        'h1{font-size:20px}ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;gap:12px;' +
        'padding:12px 0;border-bottom:1px solid #333}a{color:#6af;overflow-wrap:anywhere}span{color:#999;flex:none}</style>' +
        '</head><body><h1>Waze on cluster logs</h1>' + (rows ? '<ul>' + rows + '</ul>' : '<p>No logs saved</p>') +
        '</body></html>\n';
}

/* Per-address counters over a minute: { n, fails, since }. */
function Clients() { this.map = new Map(); }
Clients.prototype.get = function (ip) {
    var c = this.map.get(ip), now = Date.now();
    if (!c || now - c.since >= 60000) {
        if (this.map.size >= 1024) this.map.clear();
        c = { n: 0, fails: 0, since: now };
        this.map.set(ip, c);
    }
    return c;
};

function Web(opts) {
    this.dir = opts.dir;
    this.port = opts.port;
    this.token = crypto.randomBytes(16).toString('hex');
    this.tokenHash = crypto.createHash('sha256').update(this.token).digest();
    this.server = null;
    this.sockets = new Set();
    this.addr = null;
    this.host = null;
    this.clients = new Clients();
    this.downloads = new Map();     // address -> downloads under way
    this.onChange = opts.onChange || function () {};
}
Web.prototype.url = function () { return this.host ? 'http://' + this.host + '/' + this.token + '/' : null; };
/* Serves on addr (null: nowhere). */
Web.prototype.at = function (addr) {
    var self = this;
    if (addr === this.addr && (this.server || !addr)) return;
    this.stop();
    this.addr = addr;
    if (!addr) { say('no address on ' + IFACE); return; }
    var server = http.createServer(function (req, res) {
        try {
            self.handle(req, res);
        } catch (err) {
            say('request failed: ' + err.message);
            if (res.headersSent) { res.destroy(); return; }
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('error\n');
        }
    });
    server.maxConnections = 16;
    server.keepAliveTimeout = 5000;
    server.setTimeout(60000);
    server.on('clientError', function (err, sock) { sock.destroy(); });
    server.on('connection', function (sock) {
        self.sockets.add(sock);
        sock.on('close', function () { self.sockets.delete(sock); });
    });
    server.on('error', function (err) {
        say('cannot listen on ' + addr + ':' + self.port + ': ' + (err.code || err.message));
        if (self.server === server) { self.server = null; self.addr = null; self.host = null; self.onChange(); }
    });
    this.server = server;
    server.listen(this.port, addr, function () {
        if (self.server !== server) return;
        self.host = addr + ':' + server.address().port;
        say('page on http://' + self.host + '/');
        self.onChange();
    });
};
Web.prototype.stop = function () {
    if (this.server) this.server.close();
    this.sockets.forEach(function (s) { s.destroy(); });
    this.server = null;
    this.addr = null;
    if (this.host) { this.host = null; this.onChange(); }
};
Web.prototype.tokenOk = function (t) {
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(t).digest(), this.tokenHash);
};
Web.prototype.handle = function (req, res) {
    var self = this, ip = req.socket.remoteAddress, c = this.clients.get(ip);
    function reply(code, type, body, extra) {
        res.writeHead(code, Object.assign({ 'Content-Type': type, 'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; " +
            "base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }, extra || {}));
        res.end(req.method === 'HEAD' ? undefined : body);
    }
    function text(code, body) { reply(code, 'text/plain; charset=utf-8', body + '\n'); }
    c.n++;
    if (c.n > REQ_MAX || c.fails >= FAIL_MAX) return text(429, 'too many requests');
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'method not allowed');
    if (req.url.length > 256) return text(414, 'too long');
    if ((req.headers.host || '').toLowerCase() !== this.host) return text(421, 'misdirected request');
    var t = (/^\/([^/?#]*)/.exec(req.url) || [])[1];
    if (!/^[0-9a-f]{32}$/.test(t || '') || !this.tokenOk(t)) {
        c.fails++;
        return text(404, 'not found');
    }
    var m = /^\/[0-9a-f]{32}\/([^/?#]*)(?:\?.*)?$/.exec(req.url);
    if (!m) return text(404, 'not found');
    var list = archives(this.dir);
    if (m[1] === '') return reply(200, 'text/html; charset=utf-8', page(list));
    var a = NAME.test(m[1]) && list.filter(function (x) { return x.name === m[1]; })[0];
    if (!a) return text(404, 'not found');
    var busy = this.downloads.get(ip) || 0;
    if (busy >= DOWNLOADS) return text(429, 'too many downloads');
    var fd;
    try {
        fd = fs.openSync(path.join(this.dir, a.name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        var st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > ARCHIVE_MAX) throw new Error('not an archive');
    } catch (e) {
        if (fd !== undefined) fs.closeSync(fd);
        return text(404, 'not found');
    }
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': st.size,
        'Content-Disposition': 'attachment; filename="' + a.name + '"', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD' || !st.size) { fs.closeSync(fd); return res.end(); }
    this.downloads.set(ip, busy + 1);
    var done = false, stream = fs.createReadStream(null, { fd: fd, start: 0, end: st.size - 1 });
    function end() {
        if (done) return;
        done = true;
        stream.destroy();
        var n = (self.downloads.get(ip) || 1) - 1;
        if (n) self.downloads.set(ip, n); else self.downloads.delete(ip);
    }
    res.on('close', end);
    res.on('finish', end);
    stream.on('error', function () { res.destroy(); });
    stream.pipe(res);
    say('download ' + a.name + ' to ' + ip);
};

function main() {
    var clients = new Set(), saving = false, error = null, saved = null, lastSave = 0, lastAttempt = -Infinity;
    var idleSince = null;
    var newest = archives(DIR)[0];
    if (newest && newest.mtime <= Date.now() && Date.now() - newest.mtime < AFTER_SAVE_MS) lastSave = newest.mtime;
    prune(DIR, null, false);
    var web = new Web({ dir: DIR, port: PORT, onChange: broadcast });

    function state() {
        return { ev: 'state', url: web.url(), saving: saving, error: error, saved: saved, archives: archives(DIR) };
    }
    function broadcast() {
        var s = JSON.stringify(state()) + '\n';
        clients.forEach(function (c) { c.write(s); });
    }
    function finish(err, name) {
        saving = false;
        error = err;
        if (!err) { saved = name; lastSave = Date.now(); }
        prune(DIR, name, false);
        broadcast();
    }
    function save() {
        if (saving || Date.now() - lastAttempt < SAVE_GAP_MS) return;
        lastAttempt = Date.now();
        saving = true;
        error = null;
        broadcast();
        freeBytes(DIR, function (free) {
            if (free === null || free < MIN_FREE) { say('not saved: ' + (free === null ? 'free space unknown' : free + ' B free')); return finish('no-space'); }
            run('/bin/sh', [COLLECT, '-o', DIR], SAVE_TIMEOUT_MS, function (err, out, stderr) {
                var file = String(out || '').trim().split('\n').pop(), name = path.basename(file);
                if (err || path.dirname(file) !== DIR || !NAME.test(name)) {
                    say('save failed: ' + String(stderr || (err && err.message) || out).trim().slice(0, 200));
                    return finish('failed');
                }
                var st = null;
                try { st = fs.lstatSync(file); } catch (e) { /* gone */ }
                if (!st || !st.isFile() || st.size > ARCHIVE_MAX) {
                    try { fs.unlinkSync(file); } catch (e) { /* gone */ }
                    say('not saved: ' + name + (st ? ' is ' + st.size + ' B' : ' is missing'));
                    return finish(st ? 'too-large' : 'failed');
                }
                try { fs.chmodSync(file, 0o640); } catch (e) { /* the group reads it through the folder's mode */ }
                say('saved ' + name + ' (' + Math.ceil(st.size / 1024) + ' KB)');
                finish(null, name);
            });
        });
    }

    var control = net.createServer(function (sock) {
        if (clients.size >= CLIENTS) { sock.destroy(); return; }
        clients.add(sock);
        var buf = '';
        sock.setEncoding('utf8');
        sock.on('data', function (d) {
            buf += d;
            if (buf.length > LINE_MAX && buf.indexOf('\n') < 0) { sock.destroy(); return; }
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                var msg = null;
                try { msg = JSON.parse(line); } catch (e) { /* not a request */ }
                if (msg && msg.cmd === 'save') save();
            }
        });
        sock.on('error', function () { /* close follows */ });
        sock.on('close', function () { clients.delete(sock); });
        sock.write(JSON.stringify(state()) + '\n');
    });
    if (env.LISTEN_FDS === '1' && Number(env.LISTEN_PID) === process.pid) {
        control.listen({ fd: 3 });
    } else {
        try { fs.unlinkSync(SOCK); } catch (e) { /* none */ }
        control.listen(SOCK);
    }

    function quit() {
        web.stop();
        say('stopped');
        process.exit(0);
    }
    function tick() {
        var now = Date.now();
        if (clients.size || saving || (lastSave && now - lastSave < AFTER_SAVE_MS)) { idleSince = null; return; }
        if (idleSince === null) idleSince = now;
        if (now - idleSince >= IDLE_MS) quit();
    }
    web.at(ifaceAddr(IFACE));
    setInterval(function () { web.at(ifaceAddr(IFACE)); }, POLL_MS);
    setInterval(tick, Math.min(1000, IDLE_MS));
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
}

if (require.main === module) main();

module.exports = { archives: archives, prune: prune, ARCHIVES: ARCHIVES, TOTAL_MAX: TOTAL_MAX,
    ARCHIVE_MAX: ARCHIVE_MAX, MIN_FREE: MIN_FREE };
