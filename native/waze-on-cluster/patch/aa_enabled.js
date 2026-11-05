// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Android Auto is OFF unless the owner turns it on (Kiro test build, S6).
 *
 * The switch is the conf key `aa_enabled`, 0 (the default) or 1, in
 * waze-on-cluster.local.conf (or, below it, in the shipped
 * waze-on-cluster.conf). With 0, patchd and the boot recovery never read for
 * writing, write, restore, link, or remount for /usr/bin/aapd, /etc/aapd.conf,
 * their backups (*.woc-orig, *.woc-orig.json), their running link, their
 * markers and the aapd boot record; patchd reports Android Auto as off and
 * refuses the aa-* commands; the install and removal hooks leave aapd alone.
 * Only the value 1 turns it on: anything else, an unreadable file, a
 * missing key, is off.
 *
 * Read at each use (two tiny files), so a change needs no restart of patchd.
 * The render (waze-on-cluster) ignores this key; it must be defined there so
 * a local conf that sets it still starts the service (src/main.cpp).
 *
 * Tests only: WOC_AA_ENABLED=0|1 in the environment overrides the files.
 * The units do not set it.
 *
 * Node 8.16.2 on the unit. No dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var KEY = 'aa_enabled';

function stateDir() { return process.env.WOC_STATE_DIR || '/var/opt/waze-on-cluster'; }

/* The conf files, lowest priority first: the shipped one beside this
 * script, then the owner's local one (the render's local_conf default). */
function files() {
    return [
        process.env.WOC_CONF || path.join(__dirname, 'waze-on-cluster.conf'),
        process.env.WOC_LOCAL_CONF || path.join(stateDir(), 'waze-on-cluster.local.conf')
    ];
}

/* The value of KEY in a conf text as the render reads it: `key = value`,
 * a `#` starts a comment, the last assignment wins; null for none. */
function parse(text) {
    var value = null;
    String(text).split('\n').forEach(function (line) {
        var hash = line.indexOf('#');
        if (hash >= 0) line = line.slice(0, hash);
        var eq = line.indexOf('=');
        if (eq < 0) return;
        if (line.slice(0, eq).trim() === KEY) value = line.slice(eq + 1).trim();
    });
    return value;
}

function enabled() {
    var env = process.env.WOC_AA_ENABLED;
    if (env !== undefined && env !== '') return env === '1';
    var on = false;
    files().forEach(function (f) {
        var text;
        try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
        var v = parse(text);
        if (v !== null) on = v === '1';
    });
    return on;
}

/* What the app and the logs say while it is off. */
var OFF_REASON = 'Android Auto is off on this install (aa_enabled = 0); aapd and aapd.conf are never touched';

module.exports = { enabled: enabled, parse: parse, files: files, KEY: KEY, OFF_REASON: OFF_REASON };
