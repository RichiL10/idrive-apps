// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* The kernel command line the host tests give head_unit.js: WOC_CMDLINE,
 * a file in a temporary folder this process and every child it spawns
 * read. Required, it is the owner's car's (HIGH); set() rewrites it, null
 * removes it.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-hu-'));
var CMDLINE = process.env.WOC_CMDLINE = path.join(dir, 'cmdline');

var HIGH = 'console=ttyS0 hwvariant=HIGH hwrevision=D1 quiet\n';
var HIGHF = 'console=ttyS0 hwvariant=HIGHF quiet\n';
var MID = 'hwvariant=MID hwrevision=D1\n';
/* A unit the tool refuses: its variant cannot be read. */
var NONE = 'console=ttyS0 quiet\n';
/* The refusal NONE gets. */
var REFUSED = 'head unit: unknown variant is not supported (no hwvariant= on the kernel command line)';

function set(cmdline) {
    if (cmdline === null) { try { fs.unlinkSync(CMDLINE); } catch (e) {} return; }
    fs.writeFileSync(CMDLINE, cmdline);
}

set(HIGH);
process.on('exit', function () { try { fs.unlinkSync(CMDLINE); } catch (e) {} try { fs.rmdirSync(dir); } catch (e) {} });

module.exports = { set: set, HIGH: HIGH, HIGHF: HIGHF, MID: MID, NONE: NONE, REFUSED: REFUSED };
