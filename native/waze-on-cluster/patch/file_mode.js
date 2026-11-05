// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* How the patchers and boot recovery replace a file they keep a backup of
 * (carplay, aapd, aapd.conf), and repair its mode and owner.
 *
 * carplay and aapd run as their own users (carplay.service User=cia_13002,
 * aapd.service User=cia_13006), so a binary must stay executable and
 * aapd.conf readable by group and other: EXEC (0755) and READ (0644) are
 * the bits each must have at least. A replaced file gets its original's
 * mode with those bits and its original's owner. Both are set explicitly
 * on the new file (fchown, then fchmod) and checked with fstat before it
 * is renamed over the target, and the target is checked after. Nothing
 * depends on the process umask, which an installer may set to 077, or on a
 * temporary file a write cut short left behind: that one is removed and
 * the temporary file is created afresh.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

var EXEC = 0o755;
var READ = 0o644;

function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (e) {} }

/* What target should be, { mode, uid, gid }: the original's mode (its
 * setuid, setgid and sticky bits too) with at least floor's bits, and its
 * owner. orig: the original's mode, uid and gid as a backup record keeps
 * them (any may be missing); target's own stat fills what it does not
 * give, and floor, the running user, a missing target. */
function wanted(target, orig, floor) {
    var st = null;
    try { st = fs.statSync(target); } catch (e) {}
    function pick(k, dflt) { return orig && typeof orig[k] === 'number' ? orig[k] : st ? st[k] : dflt; }
    return {
        mode: (pick('mode', floor) & 0o7777) | floor,
        uid: pick('uid', process.getuid ? process.getuid() : 0),
        gid: pick('gid', process.getgid ? process.getgid() : 0),
    };
}

function differs(st, want) {
    var why = [];
    if ((st.mode & 0o7777) !== want.mode) why.push('mode 0' + (st.mode & 0o7777).toString(8) + ', not 0' + want.mode.toString(8));
    if (st.uid !== want.uid || st.gid !== want.gid) why.push('owner ' + st.uid + ':' + st.gid + ', not ' + want.uid + ':' + want.gid);
    return why.length ? why.join(', ') : null;
}

/* null also when target cannot be stat'd. */
function mismatch(target, want) {
    var st;
    try { st = fs.statSync(target); } catch (e) { return null; }
    return differs(st, want);
}

/* Whether target lacks what the service's user needs of floor: read and
 * execute by group and other for a binary (EXEC), read for aapd.conf
 * (READ). The owner's bits are left out: they do not stop the service. */
function lacks(target, floor) {
    var need = floor & 0o055;
    try { return (fs.statSync(target).mode & need) !== need; } catch (e) { return false; }
}

/* fd's file made want: owner first (a chown clears setuid), then mode,
 * fsynced and checked. */
function setOn(fd, file, want) {
    var st = fs.fstatSync(fd);
    if (st.uid !== want.uid || st.gid !== want.gid) fs.fchownSync(fd, want.uid, want.gid);
    fs.fchmodSync(fd, want.mode);
    fs.fsyncSync(fd);
    var why = differs(fs.fstatSync(fd), want);
    if (why) throw new Error(file + ': ' + why + ' after setting them');
}

function writeAll(fd, buf) {
    for (var off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off, off);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function fsyncDir(dir) {
    var fd;
    try { fd = fs.openSync(dir, 'r'); } catch (e) { return; }
    try { fs.fsyncSync(fd); } catch (e) {} finally { fs.closeSync(fd); }
}

/* Temp files of earlier writes cut short (a power loss, a kill): the legacy
 * fixed name (anything on it: a file, a link; a folder cannot be removed
 * and is left) and per-process names whose process is gone. */
function dropStaleTemps(target) {
    var dir = path.dirname(target), base = path.basename(target) + '.woc-tmp', names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    names.forEach(function (n) {
        if (n !== base && n.indexOf(base + '.') !== 0) return;
        var pid = parseInt(n.slice(base.length + 1), 10);
        if (n !== base && pid > 0 && pid !== process.pid) {
            try { process.kill(pid, 0); return; } catch (e) { if (e.code !== 'ESRCH') return; }
        }
        unlinkQuiet(path.join(dir, n));
    });
}

/* Extended attributes of a file (file capabilities, security labels), by
 * getfattr when the system has it: { attrs: [{ name, value }] }, or
 * { unknown: reason }. Node 8 has no xattr API. */
function readXattrs(file) {
    var r;
    try { r = cp.spawnSync('getfattr', ['-d', '-m', '-', '-e', 'hex', '--absolute-names', file], { encoding: 'latin1', timeout: 5000 }); }
    catch (e) { return { unknown: e.message }; }
    if (r.error) return { unknown: r.error.code === 'ENOENT' ? 'no getfattr' : r.error.message };
    if (r.status !== 0) return { unknown: 'getfattr exited ' + r.status };
    var attrs = [];
    String(r.stdout).split('\n').forEach(function (l) {
        var m = /^([^#=\s][^=]*)=(0x[0-9a-fA-F]*)$/.exec(l.trim());
        if (m) attrs.push({ name: m[1], value: m[2] });
    });
    return { attrs: attrs };
}

/* Copy target's extended attributes to tmp. Throws when it has some that
 * cannot be copied or do not read back from tmp; says (note) when they
 * cannot be read at all. */
function copyXattrs(target, tmp, note) {
    var x = readXattrs(target);
    /* Loud on purpose: a file capability on target would be dropped without a word.
     * Extended attributes are kept only where getfattr works on the unit. */
    if (x.unknown) { note('WARNING: extended attributes of ' + target + ' not checked (' + x.unknown + '); a file capability on it would not be kept'); return; }
    if (!x.attrs.length) return;
    note(target + ' carries extended attributes: ' + x.attrs.map(function (a) { return a.name; }).join(', ') + '; copying them');
    x.attrs.forEach(function (a) {
        var r = cp.spawnSync('setfattr', ['-n', a.name, '-v', a.value, tmp], { encoding: 'latin1', timeout: 5000 });
        if (r.error || r.status !== 0)
            throw new Error('cannot copy extended attribute ' + a.name + ' (' + (r.error ? r.error.message : String(r.stderr).trim()) + ')');
    });
    var y = readXattrs(tmp);
    var miss = x.attrs.filter(function (a) { return !y.attrs || !y.attrs.some(function (b) { return b.name === a.name && b.value === a.value; }); });
    if (miss.length) throw new Error('extended attributes not preserved: ' + miss.map(function (a) { return a.name; }).join(', '));
}

/* target replaced by buf with want's mode and owner, atomically and only
 * so: a per-process temporary file beside it, created afresh ('wx+', one
 * descriptor for everything, so a target mode without owner write does not
 * stop a caller that is not root), written, its owner and mode set (owner
 * first: a chown clears set-id bits and file capabilities), target's
 * extended attributes copied after that and read back, fsynced, its bytes
 * read back and compared by SHA-256, renamed over target, then target and
 * its folder checked and synced. A rename that fails is NOT answered by
 * rewriting target in place: the write is refused, target is as it was and
 * the temporary file is gone. Throws (message ends "; <target> unchanged")
 * when any step fails; up to the rename target is untouched.
 * opts.note(text) hears the extended-attribute notes. */
function replace(target, buf, want, opts) {
    var note = opts && typeof opts.note === 'function' ? opts.note : function () {};
    dropStaleTemps(target);
    var tmp = target + '.woc-tmp.' + process.pid, fd = null;
    function fail(why) {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} fd = null; }
        unlinkQuiet(tmp);
        throw new Error(why + '; ' + target + ' unchanged');
    }
    unlinkQuiet(tmp);
    try {
        fd = fs.openSync(tmp, 'wx+', 0o600);
        writeAll(fd, buf);
    } catch (e) { fail('writing ' + tmp + ': ' + e.message); }
    try { setOn(fd, tmp, want); } catch (e) { fail('setting owner/mode of ' + tmp + ': ' + e.message); }
    try { copyXattrs(target, tmp, note); } catch (e) { fail(e.message); }
    try { fs.fsyncSync(fd); }   /* the bytes (and attributes) must be on disk before the rename */
    catch (e) { fail('fsync ' + tmp + ': ' + e.message); }
    var back = Buffer.alloc(buf.length + 1), got = 0, n;
    try {
        while (got < back.length && (n = fs.readSync(fd, back, got, back.length - got, got)) > 0) got += n;
    } catch (e) { fail('reading back ' + tmp + ': ' + e.message); }
    if (got !== buf.length || sha256(back.slice(0, got)) !== sha256(buf)) fail('temp file verification failed');
    try { fs.closeSync(fd); } catch (e) { fd = null; fail('closing ' + tmp + ': ' + e.message); }
    fd = null;
    try { fs.renameSync(tmp, target); }
    catch (e) { fail('rename ' + tmp + ' -> ' + target + ' failed (' + e.message + '); not rewritten in place'); }
    var why = mismatch(target, want);
    if (why) throw new Error(target + ': ' + why + ' after the write');
    fsyncDir(path.dirname(target));
}

/* target's owner and mode made want, its bytes as they are. Throws when it
 * cannot. */
function repair(target, want) {
    var fd = fs.openSync(target, 'r');
    try { setOn(fd, target, want); } finally { fs.closeSync(fd); }
}

module.exports = { EXEC: EXEC, READ: READ, wanted: wanted, mismatch: mismatch, lacks: lacks, replace: replace, repair: repair };
