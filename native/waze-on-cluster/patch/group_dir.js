// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* groupDir(dir, group[, opts]): dir made if missing, owned by root (opts.uid)
 * and group, mode 2770: the group's members write in it and its files take
 * the group. Run as root, before the services that write there start.
 * opts.groupFile: /etc/group. Node 8. */
var fs = require('fs');

function gid(group, groupFile) {
    var line = fs.readFileSync(groupFile || '/etc/group', 'utf8').split('\n')
        .filter(function (l) { return l.split(':')[0] === group; })[0];
    if (!line) throw new Error('no group ' + group);
    return Number(line.split(':')[2]);
}

function groupDir(dir, group, opts) {
    var o = opts || {};
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    var st = fs.lstatSync(dir);
    if (!st.isDirectory()) throw new Error(dir + ' is not a folder');
    fs.chownSync(dir, o.uid || 0, gid(group, o.groupFile));
    fs.chmodSync(dir, 0o2770);
}

module.exports = { groupDir: groupDir, gid: gid };
