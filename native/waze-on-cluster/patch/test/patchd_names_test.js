#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Every file a process runs keeps a name through a change (Kiro test build,
 * port of upstream waze-on-cluster 0.9.2: dd89d64 and a89bbf0 to our patchd).
 *
 * patchd links the file a change replaces, and while it puts the running
 * file back the file the change wrote, as <target>.woc-running.1 and .2 (the
 * running file itself is <target>.woc-running). After the change each one a
 * process runs is kept and the rest go, so a crash restart into either leaves
 * no unnamed running file and the remount,ro of / takes. Three failures are
 * proven here, none needing a firmware file:
 *  - a second change before the restart (a file already waits, another is
 *    running) names the file it replaces;
 *  - a patcher that fails after writing leaves the change waiting only when a
 *    process runs a stale file (a binary other than the one on disk, or, for
 *    aapd, one that read aapd.conf before it changed);
 *  - with no name free for the file a change wrote, the running file is not
 *    put back over it.
 * Also: remount_lock.js `runs` (a process maps the inode: its exe is a
 * binary translator), the names handed over by the removal hook, and
 * Android Auto's side (aa_enabled = 1), whose aapd.conf is read at start.
 *
 * Runs the real patchd.js on a synthetic carplay build with a fake mount that
 * refuses remount,ro while a process runs an inode no name links (as the
 * kernel does), a fake /proc, a fake systemctl and a preloaded hook that
 * stands in for the patchers' writes and for a crash restart of the service.
 *
 *   node patchd_names_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit for every patcher and patchd this runs */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var cp = require('child_process');
var synthetic = require('./synthetic_carplay.js');

var PATCHD = path.join(__dirname, '..', 'patchd.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  -- ' + detail : '') + '\n');
    if (!cond) fails++;
}

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-names-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var SRC = synthetic.build({}).buf;
function variant(n) { var b = Buffer.from(SRC); b[b.length - 1] = n; return b; }   /* the build with one byte another */

/* The hook every patchd and patcher child preloads (NODE_OPTIONS). It stands
 * in for carplay_patch.js apply|revert and aapd_patch.js: a change is a script
 * (<hook dir>/<carplay|aapd>.<apply|revert>.json, used once):
 *   before / after: [{ pid, file }]  the service's process pid starts from the file
 *                    now at `file`, before the writes / after them (a crash restart)
 *   writes:         [{ file, bytes | copy }]  a new file renamed over `file`
 *   fail, out:      the patcher exits 1 / what it prints
 * carplay_patch.js status is the real one; aapd_patch.js status is faked. */
var HOOK = path.join(dir, 'hook.js');
fs.writeFileSync(HOOK, [
    "var fs = require('fs'), path = require('path'), cp = require('child_process');",
    "var base = path.basename(process.argv[1] || ''), D = process.env.WOC_HOOK_DIR;",
    "if (D && (base === 'carplay_patch.js' || base === 'aapd_patch.js')) {",
    "    var kind = base === 'carplay_patch.js' ? 'carplay' : 'aapd', cmd = process.argv[2];",
    "    if (kind === 'aapd' && cmd === 'status') {",
    "        process.stdout.write(['size: 4096', 'gate: ORIGINAL', 'selfstart-call: ORIGINAL', 'selfstart-guard: ORIGINAL', 'screen: ORIGINAL', 'geometry: ORIGINAL',",
    "            'coding: KI_KOMBI_VARIANT 7', 'backup: none', 'known: yes, pristine', 'undo: aapd none, aapd.conf none', 'restorable: no'].join('\\n') + '\\n');",
    "        process.exit(0);",
    "    }",
    "    if (cmd === 'apply' || cmd === 'revert') {",
    "        var sf = path.join(D, kind + '.' + cmd + '.json'), spec = { out: 'nothing to do' };",
    "        if (fs.existsSync(sf)) { spec = JSON.parse(fs.readFileSync(sf, 'utf8')); fs.unlinkSync(sf); }",
    "        var start = function (l) { (l || []).forEach(function (s) {",
    "            var p = path.join(process.env.WOC_PROC, String(s.pid));",
    "            cp.execFileSync('rm', ['-rf', p]); fs.mkdirSync(p); fs.linkSync(s.file, path.join(p, 'exe')); }); };",
    "        start(spec.before);",
    "        (spec.writes || []).forEach(function (w) {",
    "            var tmp = w.file + '.hook-new';",
    "            fs.writeFileSync(tmp, w.copy ? fs.readFileSync(w.copy) : Buffer.from(w.bytes, 'latin1'));",
    "            fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, w.file); });",
    "        start(spec.after);",
    "        if (spec.fail) { process.stderr.write('error: the patcher failed after writing\\n'); process.exit(1); }",
    "        process.stdout.write((spec.out || 'patched') + '\\n');",
    "        process.exit(0);",
    "    }",
    "}",
].join('\n') + '\n');

/* A unit: its own files, fake /proc, mount, systemctl and recmgr list. */
var n = 0;
function unit(opts) {
    opts = opts || {};
    var d = path.join(dir, 'u' + (++n)), t = { d: d, children: [] };
    ['usr', 'etc', 'proc', 'bin', 'sock', 'var', 'hook'].forEach(function (s) { fs.mkdirSync(path.join(d, s), { recursive: true }); });
    t.tgt = path.join(d, 'usr', 'carplay');
    t.aapd = path.join(d, 'usr', 'aapd');
    t.conf = path.join(d, 'etc', 'aapd.conf');
    t.proc = path.join(d, 'proc');
    t.mounts = path.join(d, 'mounts');
    t.sock = path.join(d, 'sock', 'patch.sock');
    t.hook = path.join(d, 'hook');
    t.recmgr = path.join(d, 'recmgr-restartlist.conf');
    t.systemd = path.join(d, 'systemd.json');
    t.dropin = path.join(d, 'carplay.service.d', '50-waze-on-cluster.conf');
    t.calls = path.join(d, 'systemctl.calls');
    t.mountLog = path.join(d, 'mount.log');
    fs.writeFileSync(t.tgt, SRC);
    fs.chmodSync(t.tgt, 0o755);
    fs.writeFileSync(t.aapd, 'aapd stock');
    fs.chmodSync(t.aapd, 0o755);
    fs.writeFileSync(t.conf, 'aapd.conf stock\n');
    fs.writeFileSync(t.mounts, '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(t.calls, '');
    fs.writeFileSync(path.join(d, 'stat'), 'cpu  1 2 3\nbtime ' + (Math.floor(Date.now() / 1000) - 60) + '\n');
    t.setRecmgr = function (names) {
        fs.writeFileSync(t.recmgr, '[Whitelist]\n' + names.join('\n') + '\n[WhitelistExitSuccess]\n' + names.join('\n') + '\n');
        var at = Math.floor(Date.now() / 1000) - 3660;
        fs.utimesSync(t.recmgr, at, at);   /* loaded at boot */
    };
    t.setRecmgr(['HBAdasMgu']);   /* carplay not listed: a change waits for the next head-unit start */
    t.setUnit = function (pid) { fs.writeFileSync(t.systemd, JSON.stringify({ pid: pid, state: 'active' })); };
    t.setUnit(0);
    fs.writeFileSync(path.join(d, 'bin', 'systemctl'), '#!' + process.execPath + '\n' + [
        "var cp = require('child_process'), path = require('path'), fs = require('fs');",
        "var P = " + JSON.stringify(t.proc) + ", T = " + JSON.stringify(t.tgt) + ", ST = " + JSON.stringify(t.systemd) + ";",
        "var st = JSON.parse(fs.readFileSync(ST, 'utf8')), a = process.argv.slice(2);",
        "fs.appendFileSync(" + JSON.stringify(t.calls) + ", a.join(' ') + '\\n');",
        "if (a[0] === 'show' && a.indexOf('DropInPaths') >= 0) process.stdout.write('DropInPaths=/run/other.conf ' + " + JSON.stringify(t.dropin) + " + '\\n');",
        "else if (a[0] === 'show') process.stdout.write('MainPID=' + st.pid + '\\nInvocationID=inv-' + st.pid + '\\nExecMainStartTimestampMonotonic=5\\n');",
        "else if (a[0] === 'start') {",
        "    st.state = 'active'; fs.writeFileSync(ST, JSON.stringify(st));",
        "    cp.execFileSync('rm', ['-rf', path.join(P, '4242')]); fs.mkdirSync(path.join(P, '4242')); fs.linkSync(T, path.join(P, '4242', 'exe'));",
        "} else if (a[0] === 'is-active') { process.stdout.write(st.state + '\\n'); process.exit(st.state === 'active' ? 0 : 3); }",
    ].join('\n') + '\n');
    fs.chmodSync(path.join(d, 'bin', 'systemctl'), 0o755);
    fs.writeFileSync(path.join(d, 'bin', 'journalctl'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(d, 'bin', 'journalctl'), 0o755);
    /* remount,ro fails (busy) while a process runs a file no name links any
     * more, as the kernel refuses it. */
    t.mount = path.join(d, 'mount');
    fs.writeFileSync(t.mount, '#!' + process.execPath + '\n' + [
        "var fs = require('fs'), path = require('path');",
        "var a = process.argv.slice(2).join(' '), P = " + JSON.stringify(t.proc) + ", M = " + JSON.stringify(t.mounts) + ";",
        "fs.appendFileSync(" + JSON.stringify(t.mountLog) + ", a + '\\n');",
        "if (/remount,rw/.test(a)) fs.writeFileSync(M, '/dev/root / ext4 rw 0 0\\n');",
        "else if (/remount,ro/.test(a)) {",
        "    var open = fs.readdirSync(P).some(function (p) { try { return fs.statSync(path.join(P, p, 'exe')).nlink <= 1; } catch (e) { return false; } });",
        "    if (open) { process.stderr.write('mount: / is busy\\n'); process.exit(32); }",
        "    fs.writeFileSync(M, '/dev/root / ext4 ro 0 0\\n');",
        "}",
    ].join('\n') + '\n');
    fs.chmodSync(t.mount, 0o755);
    t.env = Object.assign({}, process.env, {
        PATH: path.join(d, 'bin') + path.delimiter + process.env.PATH,
        NODE_OPTIONS: '--require=' + HOOK,
        WOC_HOOK_DIR: t.hook,
        WOC_PATCH_SOCK: t.sock,
        WOC_CARPLAY: t.tgt,
        WOC_AAPD: t.aapd,
        WOC_AAPD_CONF: t.conf,
        WOC_MOUNT: t.mount,
        WOC_PROC_MOUNTS: t.mounts,
        WOC_RESTART_POLL_MS: '20',
        WOC_RECMGR_CONF: t.recmgr,
        WOC_CARPLAY_DROPIN: t.dropin,
        WOC_RECMGR_AT_BOOT: path.join(d, 'no-recmgr-at-boot.json'),
        WOC_PROC_STAT: path.join(d, 'stat'),
        WOC_BOOT_ID: path.join(d, 'no-boot-id'),
        WOC_CAPTURE_SOCK: path.join(d, 'no-capture.sock'),
        WOC_DLT_RECEIVE: path.join(d, 'no-dlt-receive'),
        WOC_DLT_RETRY_MS: '600000',
        WOC_REBOOT_CMD: path.join(d, 'no-reboot'),
        WOC_STATE_DIR: path.join(d, 'var'),
        WOC_REMOUNT_LOCK: path.join(d, 'sock', 'remount.lock'),
        WOC_OP_LOCK_WAIT_MS: '1500',
        WOC_PROC: t.proc,
        WOC_RECOVERY_STATE: path.join(d, 'boot-recovery.json'),
        WOC_TEST: '1',
        WOC_AA_ENABLED: opts.aa ? '1' : '0',
    });
    return t;
}
/* A process of the unit runs the file now at `file` (its exe is that inode). */
function runs(t, pid, file) {
    var p = path.join(t.proc, String(pid));
    cp.execFileSync('rm', ['-rf', p]);
    fs.mkdirSync(p);
    fs.linkSync(file, path.join(p, 'exe'));
}
function noProc(t, pid) { cp.execFileSync('rm', ['-rf', path.join(t.proc, String(pid))]); }
function script(t, kind, cmd, spec) { fs.writeFileSync(path.join(t.hook, kind + '.' + cmd + '.json'), JSON.stringify(spec)); }
function ino(f) { try { return fs.statSync(f).ino; } catch (e) { return null; } }
function names(t, target) { return ['', '.1', '.2'].filter(function (s) { return fs.existsSync(target + '.woc-running' + s); }).map(function (s) { return '.woc-running' + s; }); }
function roNow(t) { return /\bro\b/.test(fs.readFileSync(t.mounts, 'utf8')); }
function pendingOf(t, which) {
    try { return JSON.parse(fs.readFileSync(path.join(t.d, 'sock', which === 'aa' ? 'aa-pending' : 'activation-pending'), 'utf8')); } catch (e) { return null; }
}
/* The pids of the unit whose file has no name (not the target, no link). */
function unnamed(t, target) {
    var named = [target].concat(names(t, target).map(function (s) { return target + s; })).map(ino);
    return fs.readdirSync(t.proc).filter(function (p) {
        var i = ino(path.join(t.proc, p, 'exe'));
        return i !== null && named.indexOf(i) < 0;
    });
}

function start(t) {
    t.child = cp.spawn(process.execPath, [PATCHD], { env: t.env, stdio: ['ignore', 'ignore', 'inherit'] });
    children.push(t.child);
    return (async function () { for (var i = 0; i < 200 && !fs.existsSync(t.sock); i++) await sleep(25); })();
}
/* Sends cmd, resolves to the first status after the operation ran (busy seen, then not busy). */
function send(t, cmd, aa) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(t.sock), buf = '', sent = false, sawBusy = false;
        var timer = setTimeout(function () { c.destroy(); reject(new Error('timed out on ' + JSON.stringify(cmd))); }, 30000);
        c.setEncoding('utf8');
        c.on('error', reject);
        c.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var m = JSON.parse(buf.slice(0, i));
                buf = buf.slice(i + 1);
                if (m.ev === 'refused') { clearTimeout(timer); c.destroy(); resolve(m); return; }
                if (m.ev !== 'status') continue;
                if (!sent) { sent = true; c.write(JSON.stringify(cmd) + '\n'); continue; }
                var s = aa ? m.aa && m.aa.state : m.state;
                if (s === 'busy') { sawBusy = true; continue; }
                if (sawBusy) { clearTimeout(timer); c.destroy(); resolve(m); return; }
            }
        });
    });
}
function revertCmd() { return { cmd: 'revert' }; }
var APPLY = { cmd: 'apply', panel: 'high', mode: 'avb', unproven: true };

/* The unit with CarPlay's change waiting: the service runs P0 (kept linked as
 * the running file), the target is P1, an apply is pending. */
async function waiting(t) {
    t.p0 = ino(t.tgt);
    runs(t, 4242, t.tgt);
    script(t, 'carplay', 'apply', { writes: [{ file: t.tgt, bytes: variant(1).toString('latin1') }] });
    var r = await send(t, APPLY);
    t.p1 = ino(t.tgt);
    return r;
}

async function main() {
    var r, t, w;

    /* ---- remount_lock.runs: a process that maps the inode runs it ---- */
    (function mapsTest() {
        var lockDir = path.join(dir, 'lockproc'), file = path.join(dir, 'mapped-binary');
        fs.mkdirSync(lockDir);
        fs.writeFileSync(file, 'x');
        var st = fs.statSync(file);
        function mapLine() {
            var major = (st.dev >> 8) & 0xfff, minor = (st.dev & 0xff) | ((st.dev >> 12) & 0xfff00);
            function h(x) { return (x < 16 ? '0' : '') + x.toString(16); }
            return '00400000-00500000 r-xp 00000000 ' + h(major) + ':' + h(minor) + ' ' + st.ino + '    /usr/bin/something\n';
        }
        var res = cp.spawnSync(process.execPath, ['-e', [
            "var lock = require(" + JSON.stringify(path.join(__dirname, '..', 'remount_lock.js')) + "), fs = require('fs'), path = require('path');",
            "var P = " + JSON.stringify(lockDir) + ", F = " + JSON.stringify(file) + ", st = fs.statSync(F), out = [];",
            "fs.mkdirSync(path.join(P, '77')); fs.writeFileSync(path.join(P, '77', 'maps'), '08:01 99999 /other\\n');",
            "out.push(lock.runs(st), lock.inUse(F));",
            "fs.writeFileSync(path.join(P, '77', 'maps'), " + JSON.stringify(mapLine()) + ");",
            "out.push(lock.runs(st), lock.inUse(F));",
            "fs.writeFileSync(path.join(P, '77', 'maps'), " + JSON.stringify(mapLine().replace(' ' + st.ino + ' ', ' ' + (st.ino + 1) + ' ')) + ");",
            "out.push(lock.runs(st));",
            "fs.unlinkSync(path.join(P, '77', 'maps')); fs.linkSync(F, path.join(P, '77', 'exe'));",
            "out.push(lock.runs(st), lock.inUse(F));",
            "fs.mkdirSync(path.join(P, '78')); fs.writeFileSync(path.join(P, '78', 'maps'), '00400000-00500000 r-xp 00000000 08:01 4242    /usr/bin/x\\n');",
            "out.push(lock.runs({ dev: 0x801, ino: 4242 }), lock.runs({ dev: 0x802, ino: 4242 }));",
            "console.log(JSON.stringify(out));",
        ].join('\n')], { env: Object.assign({}, process.env, { WOC_PROC: lockDir }), encoding: 'utf8' });
        var got = null;
        try { got = JSON.parse(res.stdout); } catch (e) {}
        ok('runs: a process whose maps hold the inode runs it (exe not needed)', got && got[2] === true && got[3] === true, res.stdout + res.stderr);
        ok('runs: a maps line of another file, or another inode, is not it', got && got[0] === false && got[1] === false && got[4] === false, res.stdout + res.stderr);
        ok('runs: a process whose exe is the inode still runs it', got && got[5] === true && got[6] === true, res.stdout + res.stderr);
        ok('runs: the device in a maps line is major:minor of st.dev (0x801 is 08:01, not 08:02)', got && got[7] === true && got[8] === false, res.stdout + res.stderr);
    })();

    /* ---- a change written while the service cannot be restarted: the running file stays named ---- */
    t = unit();
    await start(t);
    r = await waiting(t);
    ok('setup: the apply waits, the running file kept linked as .woc-running, / read-only', r.carplay === 'deferred' && pendingOf(t, 'cp').action === 'apply' &&
        ino(t.tgt + '.woc-running') === t.p0 && ino(t.tgt) === t.p1 && names(t, t.tgt).join() === '.woc-running' && roNow(t), JSON.stringify(r));

    /* ---- failure 1: a second change before the restart; the service starts from the file it replaces ---- */
    script(t, 'carplay', 'apply', { before: [{ pid: 4242, file: t.tgt }], writes: [{ file: t.tgt, bytes: variant(2).toString('latin1') }] });
    r = await send(t, { cmd: 'apply', panel: 'mid', mode: 'avb', unproven: true });
    ok('second change before the restart, crash restart from the replaced file: it stays named, nothing runs unnamed, / read-only', r.state !== 'error' &&
        unnamed(t, t.tgt).length === 0 && ino(t.tgt + '.woc-running') === t.p1 && roNow(t) && !fs.existsSync(t.tgt + '.woc-running.1') && !fs.existsSync(t.tgt + '.woc-running.2'),
        JSON.stringify(r) + ' ' + names(t, t.tgt).join() + ' unnamed ' + unnamed(t, t.tgt).join());
    ok('... the change waits for the start', r.carplay === 'deferred' && pendingOf(t, 'cp') !== null && ino(t.tgt) !== t.p1, JSON.stringify(r));
    t.child.kill('SIGKILL');

    /* ---- the same with no crash: the old running file is dropped when nothing runs it, the replaced one never kept ---- */
    t = unit();
    await start(t);
    await waiting(t);
    runs(t, 4242, t.tgt + '.woc-running');   /* still the first file */
    script(t, 'carplay', 'apply', { writes: [{ file: t.tgt, bytes: variant(2).toString('latin1') }] });
    r = await send(t, { cmd: 'apply', panel: 'mid', mode: 'avb', unproven: true });
    ok('second change, no restart: the running file stays the one name, the replaced one is not kept, / read-only', r.carplay === 'deferred' &&
        names(t, t.tgt).join() === '.woc-running' && ino(t.tgt + '.woc-running') === t.p0 && unnamed(t, t.tgt).length === 0 && roNow(t), JSON.stringify(r) + names(t, t.tgt).join());
    t.child.kill('SIGKILL');

    /* ---- failure 2: the patcher fails after writing ---- */
    t = unit();
    await start(t);
    t.p0 = ino(t.tgt);
    runs(t, 4242, t.tgt);
    script(t, 'carplay', 'apply', { writes: [{ file: t.tgt, bytes: variant(1).toString('latin1') }], fail: true });
    r = await send(t, APPLY);
    ok('the patcher fails after writing while the service runs the old file: the change waits for the start', r.state === 'error' || r.carplay === 'deferred', JSON.stringify(r));
    ok('... pending marker written, the running file named, / read-only', pendingOf(t, 'cp') !== null && pendingOf(t, 'cp').action === 'apply' &&
        ino(t.tgt + '.woc-running') === t.p0 && ino(t.tgt) !== t.p0 && roNow(t) && unnamed(t, t.tgt).length === 0, JSON.stringify(pendingOf(t, 'cp')));
    t.child.kill('SIGKILL');

    t = unit();
    await start(t);
    t.p0 = ino(t.tgt);
    script(t, 'carplay', 'apply', { writes: [{ file: t.tgt, bytes: variant(1).toString('latin1') }], fail: true });
    r = await send(t, APPLY);
    ok('the patcher fails after writing and nothing runs the old file: nothing waits, the status reads the disk, no link left, / read-only', pendingOf(t, 'cp') === null &&
        r.carplay !== 'deferred' && r.state !== 'busy' && names(t, t.tgt).length === 0 && roNow(t), JSON.stringify([r, pendingOf(t, 'cp'), names(t, t.tgt)]));
    t.child.kill('SIGKILL');

    t = unit();
    await start(t);
    t.p0 = ino(t.tgt);
    runs(t, 4242, t.tgt);
    script(t, 'carplay', 'apply', { writes: [{ file: t.tgt, bytes: variant(1).toString('latin1') }], after: [{ pid: 4242, file: t.tgt }], fail: true });
    r = await send(t, APPLY);
    ok('the patcher fails after writing and the service restarted from the written file: nothing waits, the old file is not kept, / read-only', pendingOf(t, 'cp') === null &&
        names(t, t.tgt).length === 0 && unnamed(t, t.tgt).length === 0 && roNow(t), JSON.stringify([r, pendingOf(t, 'cp'), names(t, t.tgt)]));
    t.child.kill('SIGKILL');

    /* ---- the running file put back, with a name for the file the change wrote ---- */
    t = unit();
    await start(t);
    await waiting(t);
    script(t, 'carplay', 'revert', { writes: [{ file: t.tgt, copy: t.tgt + '.woc-running' }] });
    r = await send(t, revertCmd());
    ok('a waiting change undone: the running file is back in place, nothing waits, no name left, / read-only', ino(t.tgt) === t.p0 && pendingOf(t, 'cp') === null &&
        names(t, t.tgt).length === 0 && roNow(t) && r.state !== 'error', JSON.stringify(r) + names(t, t.tgt).join());
    t.child.kill('SIGKILL');

    /* the service started from the file the undo replaced, meanwhile */
    t = unit();
    await start(t);
    await waiting(t);
    script(t, 'carplay', 'revert', { before: [{ pid: 4242, file: t.tgt }], writes: [{ file: t.tgt, copy: t.tgt + '.woc-running' }] });
    r = await send(t, revertCmd());
    ok('undo while the service starts from the file it replaces: that file stays named, the undo waits, / read-only', pendingOf(t, 'cp') !== null &&
        ino(t.tgt + '.woc-running') === t.p1 && ino(t.tgt) !== t.p1 && unnamed(t, t.tgt).length === 0 && roNow(t) && names(t, t.tgt).join() === '.woc-running', JSON.stringify(r) + names(t, t.tgt).join());
    t.child.kill('SIGKILL');

    /* the service started from the file the undo wrote, before the put-back: CarPlay reads no other file, so nothing waits */
    t = unit();
    await start(t);
    await waiting(t);
    script(t, 'carplay', 'revert', { writes: [{ file: t.tgt, copy: t.tgt + '.woc-running' }], after: [{ pid: 4242, file: t.tgt }] });
    r = await send(t, revertCmd());
    w = ino(t.tgt + '.woc-running');
    ok('undo while the service starts from the file it wrote: that file stays named, nothing waits (carplay reads no other file), / read-only', pendingOf(t, 'cp') === null &&
        ino(t.tgt) === t.p0 && w !== null && w === ino(path.join(t.proc, '4242', 'exe')) && w !== ino(t.tgt) && unnamed(t, t.tgt).length === 0 && roNow(t) && r.state !== 'error',
        JSON.stringify(r) + names(t, t.tgt).join());
    t.child.kill('SIGKILL');

    /* ---- failure 3: no name free for the file the change wrote ---- */
    t = unit();
    await start(t);
    await waiting(t);
    /* the replaced file P1 runs from the start of the undo (name .1), another process runs a file named .2 */
    var other = path.join(t.d, 'usr', 'other-binary');
    fs.writeFileSync(other, 'another running file');
    fs.linkSync(other, t.tgt + '.woc-running.2');
    runs(t, 4300, other);
    script(t, 'carplay', 'revert', { before: [{ pid: 4242, file: t.tgt }], writes: [{ file: t.tgt, copy: t.tgt + '.woc-running' }] });
    r = await send(t, revertCmd());
    ok('no name free for the file the undo wrote: the running file is not put back over it, it stays at the target', ino(t.tgt) !== t.p0 && ino(t.tgt) !== t.p1 &&
        fs.readFileSync(t.tgt).equals(SRC) && ino(t.tgt + '.woc-running') !== ino(t.tgt), JSON.stringify(r) + names(t, t.tgt).join());
    ok('... the change is handled as any other: it waits, every running file named, / read-only', pendingOf(t, 'cp') !== null && unnamed(t, t.tgt).length === 0 && roNow(t),
        JSON.stringify(pendingOf(t, 'cp')) + ' unnamed ' + unnamed(t, t.tgt).join());
    t.child.kill('SIGKILL');

    /* nothing is written when no name is free for the file the change replaces */
    t = unit();
    await start(t);
    await waiting(t);
    var o1 = path.join(t.d, 'usr', 'o1'), o2 = path.join(t.d, 'usr', 'o2');
    fs.writeFileSync(o1, 'one'); fs.writeFileSync(o2, 'two');
    fs.linkSync(o1, t.tgt + '.woc-running.1'); fs.linkSync(o2, t.tgt + '.woc-running.2');
    runs(t, 4301, o1); runs(t, 4302, o2);
    var before = fs.readFileSync(t.tgt);
    script(t, 'carplay', 'apply', { writes: [{ file: t.tgt, bytes: variant(3).toString('latin1') }] });
    r = await send(t, { cmd: 'apply', panel: 'mid', mode: 'avb', unproven: true });
    ok('every name taken by a running file: the change is refused, nothing written, / read-only', r.state === 'error' && /every name/.test(r.reason || '') && fs.readFileSync(t.tgt).equals(before) &&
        roNow(t) && unnamed(t, t.tgt).length === 0, JSON.stringify(r));
    t.child.kill('SIGKILL');

    /* ---- the service can be restarted: the names are gone after the restart ---- */
    t = unit();
    await start(t);
    await waiting(t);
    var dummy = cp.spawn(process.execPath, ['-e', 'setInterval(function () {}, 1e6)'], { stdio: 'ignore' });
    children.push(dummy);
    t.setRecmgr(['HBAdasMgu', 'carplay']);
    t.setUnit(dummy.pid);
    script(t, 'carplay', 'apply', { before: [{ pid: 4242, file: t.tgt }], writes: [{ file: t.tgt, bytes: variant(2).toString('latin1') }] });
    r = await send(t, { cmd: 'apply', panel: 'mid', mode: 'avb', unproven: true });
    ok('restartable second change cut by a crash restart: carplay restarted, no name left over, nothing unnamed, / read-only', r.carplay === 'restarted' && names(t, t.tgt).length === 0 &&
        unnamed(t, t.tgt).length === 0 && ino(path.join(t.proc, '4242', 'exe')) === ino(t.tgt) && roNow(t) && pendingOf(t, 'cp') === null, JSON.stringify(r) + names(t, t.tgt).join());
    t.child.kill('SIGKILL');

    /* ---- the removal hands over every name that stays ---- */
    t = unit();
    await start(t);
    await waiting(t);
    t.child.kill('SIGKILL');
    await sleep(100);
    var other2 = path.join(t.d, 'usr', 'other2');
    fs.writeFileSync(other2, 'a second running file');
    fs.linkSync(other2, t.tgt + '.woc-running.1');
    runs(t, 4300, other2);
    var hook = cp.spawnSync(process.execPath, [PATCHD, 'deactivate'], { env: t.env, encoding: 'utf8', timeout: 90000 }), result = {};
    try { var ls = (hook.stdout || '').split('\n').filter(function (l) { return l.trim(); }); result = JSON.parse(ls[ls.length - 1]); } catch (e) {}
    ok('the removal hands both names over (each a running file), not the target\'s own', (result.removeWhenUnused || []).slice().sort().join() === [t.tgt + '.woc-running', t.tgt + '.woc-running.1'].join(), (hook.stdout || '') + (hook.stderr || ''));

    /* ---- Android Auto (aa_enabled = 1): aapd.conf is read when aapd starts ---- */
    var A0 = 'aapd stock', A1 = 'aapd patched one', C0 = 'aapd.conf stock\n', C1 = 'aapd.conf edited\n';
    async function aaWaiting(t) {
        t.a0 = ino(t.aapd);
        runs(t, 4300, t.aapd);
        script(t, 'aapd', 'apply', { writes: [{ file: t.aapd, bytes: A1 }, { file: t.conf, bytes: C1 }] });
        return send(t, { cmd: 'aa-apply' }, true);
    }
    t = unit({ aa: true });
    await start(t);
    r = await aaWaiting(t);
    ok('Android Auto setup: the apply waits (aapd cannot be restarted), the running aapd kept linked, / read-only', pendingOf(t, 'aa') && pendingOf(t, 'aa').action === 'apply' &&
        ino(t.aapd + '.woc-running') === t.a0 && roNow(t), JSON.stringify(r.aa));
    t.child.kill('SIGKILL');

    t = unit({ aa: true });
    await start(t);
    t.a0 = ino(t.aapd);
    runs(t, 4300, t.aapd);
    script(t, 'aapd', 'apply', { writes: [{ file: t.aapd, bytes: A1 }], fail: true });
    r = await send(t, { cmd: 'aa-apply' }, true);
    ok('Android Auto: aapd replaced and the aapd.conf write failed, aapd runs the old file: the change waits, the old file named, / read-only', pendingOf(t, 'aa') !== null &&
        ino(t.aapd + '.woc-running') === t.a0 && roNow(t) && unnamed(t, t.aapd).length === 0, JSON.stringify(r.aa));
    t.child.kill('SIGKILL');

    t = unit({ aa: true });
    await start(t);
    runs(t, 4300, t.aapd);
    script(t, 'aapd', 'apply', { writes: [{ file: t.conf, bytes: C1 }], fail: true });
    r = await send(t, { cmd: 'aa-apply' }, true);
    ok('Android Auto: only aapd.conf written, then a failure, aapd runs the file on disk and may have read the old aapd.conf: the change waits', pendingOf(t, 'aa') !== null && roNow(t) &&
        unnamed(t, t.aapd).length === 0, JSON.stringify(r.aa));
    t.child.kill('SIGKILL');

    t = unit({ aa: true });
    await start(t);
    script(t, 'aapd', 'apply', { writes: [{ file: t.conf, bytes: C1 }], fail: true });
    r = await send(t, { cmd: 'aa-apply' }, true);
    ok('Android Auto: only aapd.conf written, then a failure, aapd does not run: nothing waits, no link left, / read-only', pendingOf(t, 'aa') === null && names(t, t.aapd).length === 0 && roNow(t),
        JSON.stringify([r.aa, pendingOf(t, 'aa')]));
    t.child.kill('SIGKILL');

    t = unit({ aa: true });
    await start(t);
    await aaWaiting(t);
    script(t, 'aapd', 'revert', { writes: [{ file: t.aapd, copy: t.aapd + '.woc-running' }] });
    r = await send(t, { cmd: 'aa-revert' }, true);
    ok('Android Auto: a waiting change undone, aapd running its own file: put back, nothing waits, no name left, / read-only', pendingOf(t, 'aa') === null && ino(t.aapd) === t.a0 &&
        names(t, t.aapd).length === 0 && roNow(t), JSON.stringify(r.aa) + names(t, t.aapd).join());
    t.child.kill('SIGKILL');

    t = unit({ aa: true });
    await start(t);
    await aaWaiting(t);
    script(t, 'aapd', 'revert', { writes: [{ file: t.aapd, copy: t.aapd + '.woc-running' }], after: [{ pid: 4300, file: t.aapd }] });
    r = await send(t, { cmd: 'aa-revert' }, true);
    w = ino(t.aapd + '.woc-running');
    ok('Android Auto: aapd started from the reverted file before the put-back (it may have read aapd.conf before the revert): the removal waits, the file stays named, / read-only',
        pendingOf(t, 'aa') !== null && pendingOf(t, 'aa').action === 'revert' && ino(t.aapd) === t.a0 && w !== null && w === ino(path.join(t.proc, '4300', 'exe')) && unnamed(t, t.aapd).length === 0 && roNow(t),
        JSON.stringify(r.aa) + names(t, t.aapd).join());
    t.child.kill('SIGKILL');

    t = unit({ aa: true });
    await start(t);
    await aaWaiting(t);
    script(t, 'aapd', 'revert', { before: [{ pid: 4300, file: t.aapd }], writes: [{ file: t.aapd, copy: t.aapd + '.woc-running' }] });
    r = await send(t, { cmd: 'aa-revert' }, true);
    ok('Android Auto: aapd started from the file the revert replaced: the removal waits, that file stays named, / read-only', pendingOf(t, 'aa') !== null && unnamed(t, t.aapd).length === 0 && roNow(t) &&
        ino(t.aapd + '.woc-running') !== ino(t.aapd), JSON.stringify(r.aa));
    t.child.kill('SIGKILL');

    /* ---- undo only what is ours (dd89d64): without a backup of ours nothing is rebuilt ---- */
    (function noBackup() {
        var d = path.join(dir, 'nobackup'), tgt = path.join(d, 'carplay');
        fs.mkdirSync(d);
        function patcher(args) {
            var res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'carplay_patch.js')].concat(args, ['--target', tgt]), { encoding: 'utf8', env: Object.assign({}, process.env, { NODE_OPTIONS: '' }) });
            return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
        }
        fs.writeFileSync(tgt, SRC, { mode: 0o755 });
        var a = patcher(['apply', '--panel', 'high', '--unproven', '--yes']);
        var patched = fs.readFileSync(tgt);
        ok('no backup: the synthetic build is patched first', a.code === 0 && !patched.equals(SRC), a.out);
        fs.unlinkSync(tgt + '.woc-orig'); fs.unlinkSync(tgt + '.woc-orig.json');
        var s = patcher(['status']), v = patcher(['revert', '--yes']);
        ok('no backup of ours: a patched file reads not restorable, and the revert leaves it byte for byte', /^restorable: no\b/m.test(s.out) && v.code !== 0 && fs.readFileSync(tgt).equals(patched), s.out + v.out);
        var foreign = Buffer.from(SRC);
        foreign[foreign.length - 1] ^= 0xff;
        fs.writeFileSync(tgt, foreign);
        s = patcher(['status']); v = patcher(['revert', '--yes']);
        ok('no backup of ours: a file another tool changed reads not restorable, and the revert leaves it byte for byte', /^restorable: no\b/m.test(s.out) && v.code !== 0 && fs.readFileSync(tgt).equals(foreign), s.out + v.out);
    })();

    /* Android Auto off (S6): the same failure of the CarPlay patcher touches no aapd path */
    t = unit();
    await start(t);
    runs(t, 4300, t.aapd);
    var aaBefore = [fs.statSync(t.aapd).mtimeMs, fs.statSync(t.conf).mtimeMs];
    await waiting(t);
    ok('aa_enabled = 0: a CarPlay change leaves aapd, aapd.conf and their names alone', names(t, t.aapd).length === 0 && fs.statSync(t.aapd).mtimeMs === aaBefore[0] && fs.statSync(t.conf).mtimeMs === aaBefore[1] &&
        pendingOf(t, 'aa') === null, names(t, t.aapd).join());
    t.child.kill('SIGKILL');
}

main().catch(function (e) { ok('no exception', false, e.stack); }).then(function () {
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
