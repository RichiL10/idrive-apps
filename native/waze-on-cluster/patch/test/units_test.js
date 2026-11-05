// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* What keeps the journal and logs units from restarting the head unit or
 * holding up its boot: each service's name in both recmgr lists; no ordering
 * against a unit not ours, no unit of the head unit's waiting for them (the
 * journal service comes from a timer, the logs service from its socket);
 * a core limit on every service, root only in node (on the crash handler's
 * list) or in the firewall unit, whose limit its children inherit; bounded
 * restarts and resources; and an update restarting only the journal
 * service. */
var assert = require('assert'), fs = require('fs'), path = require('path');

var root = path.join(__dirname, '..', '..');
var c = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
var SERVICES = ['waze-on-cluster-journal.service', 'waze-on-cluster-logs.service', 'waze-on-cluster-logs-fw.service'];
var NEW = SERVICES.concat(['waze-on-cluster-journal.timer', 'waze-on-cluster-logs.socket']);
var OURS = /^waze-on-cluster-(journal|logs|logs-fw)\.(service|socket|timer)$/;

function unit(name) {
    var text = fs.readFileSync(path.join(root, 'systemd', name), 'utf8'), keys = {};
    text.split('\n').forEach(function (l) {
        var m = /^([A-Za-z]+)=(.*)$/.exec(l);
        if (m) (keys[m[1]] = keys[m[1]] || []).push(m[2]);
    });
    return keys;
}
function list(u, k) { return (u[k] || []).join(' ').split(/\s+/).filter(Boolean); }

NEW.forEach(function (name) {
    var u = unit(name);
    assert(c.units.some(function (x) { return x.name === name; }), name + ' installed');
    assert(!u.Before, name + ' orders itself before nothing');
    ['After', 'Wants', 'Requires', 'BindsTo', 'PartOf', 'Requisite'].forEach(function (k) {
        list(u, k).forEach(function (other) { assert(OURS.test(other), name + ' ' + k + '=' + other + ': only our own units'); });
    });
    assert(!u.DefaultDependencies, name + ' keeps systemd\'s default dependencies');
    list(u, 'WantedBy').forEach(function (t) { assert(t === 'timers.target' || t === 'sockets.target', name + ' WantedBy=' + t); });
});
SERVICES.forEach(function (name) {
    var u = unit(name);
    assert(c.recmgr.indexOf(name.replace(/\.service$/, '')) >= 0, name + ' in recmgr');
    assert(!u.WantedBy, name + ' is started by its timer, socket or service, nothing else');
    assert.deepStrictEqual(u.LimitCORE, ['1'], name);
    assert(u.Restart && u.RestartSec && Number(u.StartLimitBurst) > 0, name + ' restarts, bounded');
    assert(u.MemoryLimit && u.CPUQuota && u.TasksMax, name + ' bounded');
    ['ExecStartPre', 'ExecStart', 'ExecStopPost'].forEach(function (k) {
        (u[k] || []).forEach(function (cmd) {
            assert(!/ulimit/.test(cmd), cmd);
            if (/^-?\+/.test(cmd)) assert(/^-?\+\/usr\/bin\/node \S+\.js \w+$/.test(cmd), 'a root command runs node: ' + cmd);
        });
    });
});
['waze-on-cluster-journal.service', 'waze-on-cluster-logs.service'].forEach(function (name) {
    var u = unit(name);
    assert.deepStrictEqual(u.DynamicUser, ['yes'], name);
    assert.deepStrictEqual(u.Nice, ['19'], name);
    assert.deepStrictEqual(u.IOSchedulingClass, ['idle'], name);
});
var fw = unit('waze-on-cluster-logs-fw.service');
assert(!fw.User, 'the firewall unit runs as root, in its own service so LimitCORE covers nft');
assert.deepStrictEqual(fw.BindsTo, ['waze-on-cluster-logs.service']);
assert.deepStrictEqual(fw.ExecStopPost, ['/usr/bin/node /var/opt/waze-on-cluster/current/logs_fw.js close']);
assert.deepStrictEqual(fw.ExecStart, ['/usr/bin/node /var/opt/waze-on-cluster/current/logs_fw.js watch']);
var logs = unit('waze-on-cluster-logs.service');
assert(list(logs, 'Wants').indexOf('waze-on-cluster-logs-fw.service') >= 0 && list(logs, 'After').indexOf('waze-on-cluster-logs-fw.service') >= 0);
assert(!(logs.ExecStartPre || []).length && !(logs.ExecStopPost || []).length, 'nothing in the logs service runs as root');
assert(/^\d+$/.test(unit('waze-on-cluster-journal.timer').OnBootSec[0]) && Number(unit('waze-on-cluster-journal.timer').OnBootSec[0]) >= 60);
assert(c.enable.some(function (e) { return e.unit === 'waze-on-cluster-journal.timer' && e.target === 'timers.target'; }));
assert(c.enable.some(function (e) { return e.unit === 'waze-on-cluster-logs.socket' && e.target === 'sockets.target'; }));
assert(!c.enable.some(function (e) { return /journal\.service|logs(-fw)?\.service/.test(e.unit); }), 'no service enabled on its own');
/* The deploy tool restarts the journal service on an update and checks it is
 * up 10 s later; the logs services, which their socket starts and which exit
 * by themselves, are left to run out their window. */
assert(c.restart.indexOf('waze-on-cluster-journal.service') >= 0);
assert(c.restart.indexOf('waze-on-cluster-logs.service') < 0 && c.restart.indexOf('waze-on-cluster-logs-fw.service') < 0);
console.log('ok   journal and logs units: in recmgr, ordered against none of the head unit\'s, started late or on demand, no core dumps, root only in node and the firewall unit');

/* On a head unit that refuses it the capture stays up and exits only on a
 * stop, with 0: restarted on a failure only, so a clean stop stays stopped. */
var capture = unit('waze-on-cluster.service');
assert.deepStrictEqual(capture.Restart, ['on-failure']);
assert.deepStrictEqual(capture.User, ['hmi_5000']);
console.log('ok   waze-on-cluster.service: restarted on a failure only, as hmi_5000');

/* Review F4 (S5): the restart cap is in [Unit], where systemd 237 reads it; the
 * same keys under [Service] are ignored there. unit() flattens the sections, so
 * look at the text. Same for cluster-render.service (review N5). */
[['waze-on-cluster.service', path.join(root, 'systemd', 'waze-on-cluster.service')],
 ['cluster-render.service', path.join(root, '..', 'cluster-render', 'systemd', 'cluster-render.service')]].forEach(function (p) {
    var text = fs.readFileSync(p[1], 'utf8'), at = text.indexOf('\n[Service]'), lines = text.split('\n');
    assert(at > 0, p[0] + ' has a [Service] section');
    var before = text.slice(0, at).split('\n'), after = text.slice(at).split('\n');
    assert(before.indexOf('[Unit]') >= 0, p[0] + ' starts with [Unit]');
    assert(before.indexOf('StartLimitIntervalSec=600') >= 0, p[0] + ': StartLimitIntervalSec=600 in [Unit]');
    assert(before.indexOf('StartLimitBurst=30') >= 0, p[0] + ': StartLimitBurst=30 in [Unit]');
    assert(!after.some(function (l) { return /^StartLimit/.test(l); }), p[0] + ': no StartLimit key after [Service], where systemd 237 ignores it');
    assert(after.indexOf('Restart=on-failure') >= 0, p[0] + ': Restart=on-failure kept');
    assert.strictEqual(lines.filter(function (l) { return /^StartLimit(IntervalSec|Burst)=/.test(l); }).length, 2, p[0] + ': each key once');
});
console.log('ok   waze-on-cluster.service and cluster-render.service: StartLimitIntervalSec=600, StartLimitBurst=30 in [Unit], Restart=on-failure');

/* The capture waits for BMW's media bus by ordering alone: a requirement on
 * a head-unit unit could start or stop it, and a Before= of ours on the bus
 * units could delay them or close an ordering cycle, which systemd breaks by
 * dropping a job. */
var MEDIA = ['ufipc_daemon.service', 'avbstreamhandler.service'];
MEDIA.forEach(function (m) { assert(list(capture, 'After').indexOf(m) >= 0, 'waze-on-cluster.service After=' + m); });
['Wants', 'Requires', 'BindsTo', 'PartOf', 'Requisite'].forEach(function (k) {
    list(capture, k).forEach(function (other) {
        assert(/^(waze-on-cluster|cluster-render)[\w.-]*$/.test(other), 'waze-on-cluster.service ' + k + '=' + other + ': only our own units');
    });
});
c.units.forEach(function (x) {
    list(unit(x.name), 'Before').forEach(function (other) {
        assert(MEDIA.concat(['gptp.service', 'early.target']).indexOf(other) < 0, x.name + ' Before=' + other);
    });
});
console.log('ok   waze-on-cluster.service: after ufipc_daemon and avbstreamhandler, ordering only, none of ours before them');
