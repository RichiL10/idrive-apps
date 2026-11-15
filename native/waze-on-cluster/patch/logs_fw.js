#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* logs_fw — the firewall rule that lets a phone on the car's hotspot reach
 * the logs page. waze-on-cluster-logs-fw.service runs it as root for as long
 * as waze-on-cluster-logs.service runs.
 *
 *   node logs_fw.js prepare makes the archives' folder (SAVED, group
 *                           systemd-journal, mode 2770)
 *   node logs_fw.js watch   keeps exactly one rule tagged COMMENT at the top
 *                           of ip filter input, checked every CHECK_MS (a
 *                           ruleset load drops it), until SIGTERM, or until a
 *                           check from the second on finds the logs service
 *                           neither active nor starting (its start limit
 *                           refused it): then removes it and exits 0:
 *                           iifname "wlan_bridge" tcp dport 8475 accept comment "waze-on-cluster-logs"
 *   node logs_fw.js close   removes every rule tagged COMMENT (the unit's
 *                           ExecStopPost, however the watch ended)
 *
 * The unit's firewall (firewalldz) drops what its input chain does not
 * accept; replies leave through its output chain's accept of established
 * connections. A unit without that table or chain gets nothing and is no
 * error. close exits 1 when nft fails; watch logs a failed check and tries
 * again at the next.
 *
 * Node 8 on the unit. No dependencies.
 */
var cp = require('child_process');

var COMMENT = 'waze-on-cluster-logs';
var IFACE = 'wlan_bridge';
var PORT = 8475;
var SAVED = process.env.WOC_LOGS_DIR || '/var/opt/waze-on-cluster/saved';
var CHECK_MS = Number(process.env.WOC_FW_CHECK_MS) || 30000;
var RULE = ['iifname', '"' + IFACE + '"', 'tcp', 'dport', String(PORT), 'accept', 'comment', '"' + COMMENT + '"'];

function execNft(args) {
    return new Promise(function (resolve, reject) {
        cp.execFile(process.env.WOC_NFT || 'nft', args, { timeout: 15000, maxBuffer: 4 << 20 }, function (err, out, stderr) {
            if (!err) { resolve(out); return; }
            var e = new Error('nft ' + args.join(' ') + ': ' + (String(stderr || '').trim() || err.message));
            e.absent = /No such file or directory/.test(String(stderr));
            reject(e);
        });
    });
}

/* Handles of the tagged rules in ip filter input; null without that chain. */
function tagged(nft) {
    return nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']).then(function (out) {
        return out.split('\n').filter(function (l) { return l.indexOf('comment "' + COMMENT + '"') >= 0; })
            .map(function (l) { return /# handle (\d+)\s*$/.exec(l); }).filter(Boolean)
            .map(function (m) { return m[1]; });
    }, function (err) {
        if (err.absent) return null;
        throw err;
    });
}

/* Removes the tagged rules; resolves the chain's presence. */
function close(nft) {
    nft = nft || execNft;
    return tagged(nft).then(function (handles) {
        return (handles || []).reduce(function (p, h) {
            return p.then(function () { return nft(['delete', 'rule', 'ip', 'filter', 'input', 'handle', h]); });
        }, Promise.resolve()).then(function () { return handles !== null; });
    });
}

/* Exactly one tagged rule, at the top: kept when it is, else the tagged
 * rules replaced by one. Resolves 'kept', 'added' or 'absent' (no chain). */
function ensure(nft) {
    nft = nft || execNft;
    return nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']).then(function (out) {
        var rules = out.split('\n').filter(function (l) { return /# handle \d+\s*$/.test(l) && !/^\s*(chain|table)\b/.test(l); });
        var mine = rules.filter(function (l) { return l.indexOf('comment "' + COMMENT + '"') >= 0; });
        if (mine.length === 1 && rules[0] === mine[0]) return 'kept';
        return close(nft).then(function () {
            return nft(['insert', 'rule', 'ip', 'filter', 'input'].concat(RULE));
        }).then(function () { return 'added'; });
    }, function (err) {
        if (err.absent) return 'absent';
        throw err;
    });
}

/* Whether the logs service runs or is starting (systemctl is-active). */
function logsAlive() {
    return new Promise(function (resolve) {
        cp.execFile(process.env.WOC_SYSTEMCTL || 'systemctl', ['is-active', 'waze-on-cluster-logs.service'], { timeout: 15000 },
            function (err, out) { resolve(/^(active|activating|reloading)\s*$/.test(String(out))); });
    });
}

/* The watch: resolves once its close is done, at SIGTERM (signals: process,
 * or another emitter of 'SIGTERM') or when alive() resolves false. At its
 * start the logs service is still queued behind this unit, so the first
 * check does not ask. */
function watch(nft, log, signals, alive) {
    signals = signals || process;
    alive = alive || logsAlive;
    log = log || function (line) { console.log('logs_fw: ' + line); };
    var timer = null, chain = Promise.resolve(), stopping = false, last = '', checks = 0, stop = null;
    function check() {
        var ask = checks++ > 0;
        chain = chain.then(function () { return stopping || !ask ? true : alive(); }).then(function (up) {
            if (!up) {
                log('the logs service is not running');
                stop();
                return null;
            }
            return stopping ? null : ensure(nft);
        }).then(function (r) {
            if (r && r !== 'kept' && r !== last) log(r === 'added' ? 'rule in place' : 'no ip filter input chain');
            if (r) last = r;
        }, function (err) {
            if (err.message !== last) log(err.message);
            last = err.message;
        });
        return chain;
    }
    return new Promise(function (resolve) {
        stop = function () {
            if (stopping) return;
            stopping = true;
            clearInterval(timer);
            setImmediate(function () {
                chain.then(function () { return close(nft); }).then(function () { log('rule removed'); },
                    function (err) { log(err.message); }).then(resolve);
            });
        };
        signals.on('SIGTERM', stop);
        signals.on('SIGINT', stop);
        timer = setInterval(check, CHECK_MS);
        check();
    });
}

if (require.main === module) {
    var what = process.argv[2];
    if (what === 'prepare') {
        require('./group_dir.js').groupDir(SAVED, 'systemd-journal');
    } else if (what === 'watch') {
        watch().then(function () { process.exit(0); });
    } else if (what === 'close') {
        close().then(function () { process.exit(0); }, function (err) { console.error('logs_fw: ' + err.message); process.exit(1); });
    } else {
        console.error('usage: logs_fw.js prepare|watch|close');
        process.exit(2);
    }
}

module.exports = { ensure: ensure, close: close, watch: watch, logsAlive: logsAlive, COMMENT: COMMENT, IFACE: IFACE, PORT: PORT };
