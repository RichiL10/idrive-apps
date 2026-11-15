// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* This boot's id and start time, shared by patchd, recmgr_list.js and the
 * boot recovery. WOC_BOOT_ID and WOC_PROC_STAT point them elsewhere for
 * tests.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }

/* The kernel's id of this boot, or '' where there is none. */
function bootId() { return readText(process.env.WOC_BOOT_ID || '/proc/sys/kernel/random/boot_id').trim(); }

/* When this boot started, in ms since the epoch, or null. */
function bootTime() {
    var m = /^btime (\d+)$/m.exec(readText(process.env.WOC_PROC_STAT || '/proc/stat'));
    return m ? parseInt(m[1], 10) * 1000 : null;
}

module.exports = { bootId: bootId, bootTime: bootTime };
