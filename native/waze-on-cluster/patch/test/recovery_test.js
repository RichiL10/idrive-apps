// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Host tests for boot recovery (patch/recovery.js: the boot step and the
 * watcher), its patch record (patch/patch_record.js), shutdown_mark.sh and
 * the shared remount lock (patch/remount_lock.js). Each world is a folder
 * of real files: the targets, their backups and records, the state files,
 * the shutdown marks shutdown_mark.sh writes, and a mount that flips a fake
 * /proc/mounts. Only systemd (the service's runs, the system's state, a
 * start) is faked, so the decisions run on what the unit would have on
 * disk. With CARPLAY_BIN and AAPD_BIN the patchers write real patches of
 * copies and the real boot step restores them.
 *
 *   node patch/test/recovery_test.js
 */
const assert = require('assert');
const headUnit = require('./head_unit_env.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

/* The mount, /proc/mounts, /proc and the remount lock every restore in this
 * process uses. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rec-'));
const MOUNTS = path.join(ROOT, 'mounts');
const MOUNT_LOG = path.join(ROOT, 'mount.log');
const ROMOUNT = 'echo "$*" >> "' + MOUNT_LOG + '"\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS +
    '";; *remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + MOUNTS + '";; esac\n';
fs.writeFileSync(path.join(ROOT, 'mount'), '#!/bin/sh\n' + ROMOUNT, { mode: 0o755 });
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
fs.mkdirSync(path.join(ROOT, 'proc'));
Object.assign(process.env, {
    WOC_MOUNT: path.join(ROOT, 'mount'), WOC_PROC_MOUNTS: MOUNTS, WOC_PROC: path.join(ROOT, 'proc'),
    WOC_REMOUNT_LOCK: path.join(ROOT, 'remount.lock'),
    /* No btime unless a test writes one: the host's own /proc/stat is no boot of the worlds'. */
    WOC_PROC_STAT: path.join(ROOT, 'no-proc-stat'),
    /* Android Auto is opt-in (S6, aa_enabled.js). These tests are about both
     * services, so it is on here; the tests of the default turn it off. */
    WOC_TEST: '1',   /* the override below is honoured only with this */
    WOC_AA_ENABLED: '1',
});

const recovery = require('../recovery.js');
const record = require('../patch_record.js');
const { Recovery, THRESHOLD, RESTORE_BOUND_MS, BOOT_BOUND_MS } = recovery;

const PATCH = path.join(__dirname, '..');
const RECOVERY_PATH = path.join(PATCH, 'recovery.js');
const MARK_SH = path.join(PATCH, 'shutdown_mark.sh');
const CARPLAY_PATCH = path.join(PATCH, 'carplay_patch.js');
const AAPD_PATCH = path.join(PATCH, 'aapd_patch.js');
const CARPLAY_BIN = process.env.CARPLAY_BIN || '';
const AAPD_BIN = process.env.AAPD_BIN || '';
const AAPD_CONF = process.env.AAPD_CONF || '';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ro = () => /\bro\b/.test(fs.readFileSync(MOUNTS, 'utf8'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function clock() {
    let t = 1000000;
    const fn = () => t;
    fn.advance = (ms) => { t += ms; };
    return fn;
}

/* A synthetic binary (no ELF, so no build-id): its original, and a patch of
 * a few bytes, the size of one of ours. */
function synthetic(seed, size) {
    const original = crypto.createHash('sha512').update(seed).digest();
    const out = Buffer.alloc(size || 65536);
    for (let i = 0; i < out.length; i++) out[i] = original[i % original.length] ^ (i & 0xff);
    const patched = Buffer.from(out);
    [100, 2000, 30000].forEach((o) => { patched[o] ^= 0xff; });
    return { original: out, patched };
}
const CONF = { original: Buffer.from('{"SCREENS":{"KOMBI_DISPLAY":{"DENSITY":160}}}\n'), patched: Buffer.from('{"SCREENS":{"KOMBI_DISPLAY":{"DENSITY":180}}}\n') };

/* A backup as the patchers write it: the original and its record. */
function backup(file, buf) {
    fs.writeFileSync(file + '.woc-orig', buf, { mode: 0o600 });
    fs.writeFileSync(file + '.woc-orig.json', JSON.stringify({ target: file, sha256_original: sha(buf) }));
}

/* One head unit's files and its services' runs. */
function makeWorld(opts) {
    opts = opts || {};
    const dir = fs.mkdtempSync(path.join(ROOT, 'w-'));
    ['var', 'shm', 'sin', 'sin/recmgr', 'sin/crashhandler'].forEach((d) => fs.mkdirSync(path.join(dir, d)));
    const T = recovery.targets({ state: path.join(dir, 'var', 'boot-recovery.json'), sock: path.join(dir, 'shm', 'patch.sock'),
        carplay: path.join(dir, 'carplay'), aapd: path.join(dir, 'aapd'), aapdConf: path.join(dir, 'aapd.conf'), sin: path.join(dir, 'sin') });
    const w = { dir, T, system: 'running', recmgr: !!opts.recmgr, lockHeld: false, now: clock(), events: [], logs: [], svc: {}, bin: {} };
    let nextPid = 100;
    ['carplay', 'aapd'].forEach((name) => {
        const s = w.svc[name] = { run: '', pid: 0, state: 'inactive', result: 'success', alive: new Set() };
        s.starts = () => {
            const pid = nextPid++;
            Object.assign(s, { run: name + '-run-' + pid, pid, state: 'active', result: 'success', code: '', status: '' });
            s.alive.add(pid);
            w.events.push(name + '-start:' + w.holds(name));
        };
        s.crashes = () => {
            s.alive.delete(s.pid);
            Object.assign(s, { pid: 0, state: 'failed', result: 'core-dump', code: '3', status: '11' });
            w.events.push(name + '-crash');
        };
        s.ends = (code, status) => {
            s.alive.delete(s.pid);
            Object.assign(s, { pid: 0, state: 'inactive', result: 'success', code, status });
        };
        s.down = () => { s.alive.clear(); Object.assign(s, { run: '', pid: 0, state: 'inactive', result: 'success' }); };
    });
    /* What the service's file holds now: the original or the patch. */
    w.holds = (name) => {
        let cur = null;
        try { cur = fs.readFileSync(T[name].target); } catch (e) { return 'missing'; }
        return cur.equals(w.bin[name].original) ? 'original' : cur.equals(w.bin[name].patched) ? 'patched' : 'other';
    };
    /* The service's file as the patcher leaves it: kind 'proven' |
     * 'unproven' (patched), 'original' (Disable used), 'unknown' (patched,
     * no record), 'none' (stock, no backup). */
    w.install = (name, kind) => {
        const t = T[name], b = w.bin[name] = synthetic(name + kind);
        /* The modes the firmware ships, whatever the umask the tests run under. */
        fs.writeFileSync(t.target, kind === 'original' || kind === 'none' ? b.original : b.patched);
        fs.chmodSync(t.target, 0o755);
        if (kind !== 'none') backup(t.target, b.original);
        if (name === 'aapd') {
            fs.writeFileSync(t.files[1], kind === 'original' || kind === 'none' ? CONF.original : CONF.patched);
            fs.chmodSync(t.files[1], 0o644);
            if (kind !== 'none') backup(t.files[1], CONF.original);
        }
        if (kind === 'proven' || kind === 'unproven' || kind === 'original') record.write(t.target, { patched: kind !== 'original', proven: kind === 'proven' });
    };
    w.recovery = (name, bootId, extra) => new Recovery(Object.assign({
        target: T[name],
        bootId,
        now: w.now,
        probe: (cb) => cb(Object.assign({}, w.svc[name])),
        systemState: (cb) => cb(w.system),
        start: (cb) => { w.svc[name].starts(); cb(null); },
        alive: (pid) => w.svc[name].alive.has(pid),
        recmgrLoaded: () => w.recmgr,
        lock: { tryAcquire: () => !w.lockHeld, release: () => {} },
        log: (l) => w.logs.push(l),
    }, extra || {}));
    w.state = (name) => readJson(T[name].state);
    return w;
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

const startBoot = (rec) => new Promise((resolve) => rec.startBoot(resolve));
const tick = (rec) => new Promise((resolve) => rec.tick(resolve));
const shutdown = (rec) => new Promise((resolve) => rec.onShutdown(resolve));
const starts = (w, name) => w.events.filter((e) => e.startsWith(name + '-start')).length;

/* One boot as the units order it: each boot step (its restore links a
 * running binary only, and waits for the lock, as `recovery.js boot`
 * does), the services' start, then the watcher's own start and a tick. */
async function bootUp(w, bootId, names) {
    names = names || ['carplay'];
    const steps = {}, watchers = {};
    for (const n of names) {
        steps[n] = await startBoot(w.recovery(n, bootId, { restore: (fails, cb) => recovery.restoreTarget(w.T[n], true, fails, cb, 1000) }));
        w.events.push(n + '-boot-step:' + steps[n].action);
    }
    for (const n of names) w.svc[n].starts();
    for (const n of names) {
        watchers[n] = w.recovery(n, bootId);
        await startBoot(watchers[n]);
        await tick(watchers[n]);
    }
    return { steps, watchers, step: steps[names[0]], watcher: watchers[names[0]] };
}

/* shutdown_mark.sh as var-opt-ro.service runs it at an NSM shutdown of boot:
 * each service's state as systemctl shows it (running | failed | stopped |
 * null, unreadable), and, when crash, the restart recmgr asked for. */
function nsmShutdown(w, boot, states, crash, up) {
    const started = '\\nExecMainStartTimestampMonotonic=1234567';
    const d = w.dir, show = { running: 'ActiveState=active\\nResult=success' + started, failed: 'ActiveState=failed\\nResult=core-dump\\nExecMainCode=3\\nExecMainStatus=11' + started,
        stopped: 'ActiveState=inactive\\nResult=success\\nExecMainStartTimestampMonotonic=0',
        killed: 'ActiveState=failed\\nResult=signal\\nExecMainCode=2\\nExecMainStatus=9' + started };
    fs.writeFileSync(path.join(d, 'boot_id'), boot + '\n');
    fs.writeFileSync(path.join(d, 'uptime'), (up || 20) + '.00 50.00\n');
    fs.writeFileSync(path.join(d, 'stat'), 'cpu 1 2 3\nbtime ' + Math.floor(Date.now() / 1000 - (up || 20)) + '\n');
    const unit = (u, s) => u + ') ' + (s ? 'printf "' + show[s] + '\\n"' : 'exit 1') + ' ;;';
    fs.writeFileSync(path.join(d, 'systemctl'), '#!/bin/sh\ncase "$2" in\n' + unit('carplay.service', states.carplay) + '\n' + unit('aapd.service', states.aapd) + '\nesac\n', { mode: 0o755 });
    const info = path.join(d, 'sin', 'recmgr', 'restartInfo.xml');
    if (crash) fs.writeFileSync(info, '<restartInfo/>\n'); else try { fs.unlinkSync(info); } catch (e) {}
    const r = cp.spawnSync('sh', [MARK_SH], { env: Object.assign({}, process.env, { WOC_STATE_DIR: path.join(d, 'var'), WOC_BOOT_ID: path.join(d, 'boot_id'),
        WOC_SYSTEMCTL: path.join(d, 'systemctl'), WOC_MARK_WAIT: '2', WOC_SIN_DIR: path.join(d, 'sin'), WOC_UPTIME: path.join(d, 'uptime'),
        WOC_PROC_STAT: path.join(d, 'stat') }) });
    assert.strictEqual(r.status, 0);
    /* recmgr deletes its restart record when it starts at the next boot. */
    try { fs.unlinkSync(info); } catch (e) {}
    Object.keys(w.svc).forEach((n) => w.svc[n].down());
}

/* The services as systemctl shows them now. */
function shown(w) {
    const one = (s) => s.state === 'failed' ? 'failed' : s.state === 'active' ? 'running' : 'stopped';
    return { carplay: one(w.svc.carplay), aapd: one(w.svc.aapd) };
}

/* How a boot ends. */
const END = {
    /* The patched service crashes at start; its OnFailure= and crashhandler
     * restart the head unit before its watcher looks. */
    crashAtStart: (w, boot, name) => { w.svc[name].crashes(); nsmShutdown(w, boot, shown(w), true); },
    /* Another process crashes; recmgr restarts the head unit. */
    otherCrash: (w, boot) => nsmShutdown(w, boot, shown(w), true),
    /* An engine stop or switch-off after the healthy window. */
    switchOff: (w, boot) => nsmShutdown(w, boot, shown(w), false, 300),
    /* An NSM shutdown within the healthy window with no restart record: a
     * switch-off, or a crash restart whose record was missed. */
    shortOff: (w, boot) => nsmShutdown(w, boot, shown(w), false, 20),
    /* Power lost, or a reset with nothing recorded. */
    powerCut: (w) => Object.keys(w.svc).forEach((n) => w.svc[n].down()),
};

/* A loop: each boot ends as end does; the boot index at which the original
 * is restored, or 0 within max boots. */
async function loop(w, name, kind, end, max, names) {
    w.install(name, kind);
    for (let i = 1; i <= max; i++) {
        const { steps } = await bootUp(w, 'boot-' + i, names || [name]);
        if (steps[name].action === 'restored') return i;
        end(w, 'boot-' + i, name);
    }
    return 0;
}

/* ---- thresholds ---- */

for (const name of ['carplay', 'aapd']) {
    for (const [kind, at] of [['unproven', 2], ['proven', 3], ['unknown', 3]]) {
        test(`${name}, ${kind} patch crashing at start: restored before ${name} starts, at boot ${at}`, async () => {
            const w = makeWorld();
            assert.strictEqual(await loop(w, name, kind, END.crashAtStart, 5), at);
            assert.strictEqual(w.events.filter((e) => e === name + '-start:patched').length, at - 1, 'the patch ran ' + (at - 1) + ' times');
            assert.strictEqual(w.events[w.events.length - 1], name + '-start:original', 'the boot that restored starts the original');
            assert.strictEqual(w.holds(name), 'original', 'byte for byte');
            if (name === 'aapd') assert(fs.readFileSync(w.T.aapd.files[1]).equals(CONF.original), 'aapd.conf restored too');
            assert(ro(), '/ read-only again');
            const rec = record.current(w.T[name].target);
            assert.deepStrictEqual([rec.patched, rec.by, rec.fails], [false, 'recovery', THRESHOLD[kind]], 'the record names the restore');
            assert.deepStrictEqual([w.state(name).fails, w.state(name).arm], [0, null]);
            assert.strictEqual((await bootUp(w, 'boot-after', [name])).steps[name].action, 'idle', 'nothing armed after');
        });
    }
}

test('a failure another process causes counts: unproven restored at boot 2, proven at boot 3', async () => {
    for (const [kind, at] of [['unproven', 2], ['proven', 3]]) {
        const w = makeWorld();
        assert.strictEqual(await loop(w, 'carplay', kind, END.otherCrash, 5), at, kind);
        assert(!w.events.includes('carplay-crash'), 'carplay itself never crashed');
    }
});

test('a crash of the patched service counts even when its watcher saw it and the system then stopped in order', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    for (const boot of ['A', 'B']) {
        const { watcher } = await bootUp(w, boot);
        w.svc.carplay.crashes();
        w.now.advance(5000);
        assert.strictEqual((await tick(watcher)).action, 'crash');
        w.system = 'stopping';
        await shutdown(watcher);
        w.system = 'running';
        w.svc.carplay.down();
    }
    assert.strictEqual((await bootUp(w, 'C')).step.action, 'restored');
});

/* ---- no false restores ---- */

test('a switch-off after the healthy window, every boot, never restores, even unproven', async () => {
    const w = makeWorld();
    assert.strictEqual(await loop(w, 'carplay', 'unproven', END.switchOff, 6), 0);
    assert.strictEqual(w.state('carplay').fails, 0);
});

test('a shutdown within the healthy window with no restart record is a boot with no record: a loop whose records are missed is still caught', async () => {
    for (const [kind, at] of [['unproven', 3], ['proven', 5]]) {
        const w = makeWorld();
        assert.strictEqual(await loop(w, 'carplay', kind, END.shortOff, 6), at, kind);
        const x = makeWorld();
        x.install('carplay', kind);
        await bootUp(x, 'A');
        END.shortOff(x, 'A');
        assert.strictEqual((await bootUp(x, 'B')).step.action, 'armed', kind + ': one restores nothing');
        assert.deepStrictEqual([x.state('carplay').fails, x.state('carplay').unknown], [0, 1]);
    }
});

test('a state written before the counting rules (no unknown) starts its counts again', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, arm: null, starts: null, ended: null }));
    const r = await startBoot(w.recovery('carplay', 'A'));
    assert.deepStrictEqual([r.action, r.fails], ['armed', 0]);
    assert.strictEqual(w.holds('carplay'), 'patched');
});

test('proven: two failed boots with no healthy boot between restore; a healthy boot between does not', async () => {
    for (const healthyBetween of [false, true]) {
        const w = makeWorld();
        w.install('carplay', 'proven');
        await bootUp(w, 'A');
        END.otherCrash(w, 'A');
        const b = await bootUp(w, 'B');
        if (healthyBetween) { w.now.advance(61000); await tick(b.watcher); }
        END.switchOff(w, 'B');
        await bootUp(w, 'C');
        END.otherCrash(w, 'C');
        assert.strictEqual((await bootUp(w, 'D')).step.action, healthyBetween ? 'armed' : 'restored', 'healthy between: ' + healthyBetween);
    }
});

test('a boot the patched service never ran in counts nothing, whatever ended it', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    await startBoot(w.recovery('carplay', 'A'));   /* armed; the restart came before carplay started */
    nsmShutdown(w, 'A', { carplay: 'stopped', aapd: 'stopped' }, true);
    const r = await startBoot(w.recovery('carplay', 'B'));
    assert.deepStrictEqual([r.action, r.fails], ['armed', 0]);
    w.svc.carplay.starts();
    const watcher = w.recovery('carplay', 'B');
    await tick(watcher);   /* seen running, then stopped cleanly */
    w.svc.carplay.ends('1', '0');
    nsmShutdown(w, 'B', { carplay: 'stopped', aapd: 'stopped' }, true);
    assert.strictEqual((await startBoot(w.recovery('carplay', 'C', { restore: (f, cb) => recovery.restoreTarget(w.T.carplay, true, f, cb, 1000) }))).action, 'restored',
        'once it ran, the restart counts');
});

test('a restart the user asked for is not a failure: patchd\'s record, or the watcher stopped while the system stops', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    await bootUp(w, 'A');
    fs.writeFileSync(w.T.carplay.restart, 'A\n');   /* patchd's reboot command; the watcher never got a SIGTERM */
    END.powerCut(w);
    const { watcher } = await bootUp(w, 'B');
    assert.strictEqual(w.state('carplay').fails, 0, 'patchd recorded the restart');
    w.system = 'stopping';
    await shutdown(watcher);
    w.system = 'running';
    END.powerCut(w);
    assert.strictEqual((await bootUp(w, 'C')).step.action, 'armed', 'the watcher saw the orderly stop');
    assert.strictEqual(w.state('carplay').fails, 0);
});

test('a boot that ends with no record is unknown: one restores nothing, two in a row count one failure', async () => {
    for (const [kind, at] of [['unproven', 3], ['proven', 5]]) {
        const w = makeWorld();
        assert.strictEqual(await loop(w, 'carplay', kind, END.powerCut, 6), at, kind + ': a loop that leaves no record is still caught');
        const x = makeWorld();
        x.install('carplay', kind);
        await bootUp(x, 'A');
        END.powerCut(x);
        assert.strictEqual((await bootUp(x, 'B')).step.action, 'armed', kind + ': one power cut restores nothing');
        assert.deepStrictEqual([x.state('carplay').fails, x.state('carplay').unknown], [0, 1]);
        END.switchOff(x, 'B');
        await bootUp(x, 'C');
        END.powerCut(x);
        assert.strictEqual((await bootUp(x, 'D')).step.action, 'armed', kind + ': an orderly boot between breaks the row');
        assert.deepStrictEqual([x.state('carplay').fails, x.state('carplay').unknown], [0, 1]);
    }
});

test('a single unrelated crash restart within the window never removes a proven patch', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    for (const boot of ['A', 'B', 'C', 'D']) {
        const { step, watcher } = await bootUp(w, boot);
        assert.strictEqual(step.action, 'armed', boot);
        if (boot === 'A' || boot === 'C') { END.otherCrash(w, boot); continue; }   /* a BMW process's crash, once */
        w.now.advance(61000);
        assert.strictEqual((await tick(watcher)).action, 'confirmed');
        END.switchOff(w, boot);
    }
    assert.strictEqual(w.holds('carplay'), 'patched');
    await bootUp(w, 'E');
    assert.deepStrictEqual([w.holds('carplay'), w.state('carplay').fails], ['patched', 0], 'D ran healthy');
});

test('with no shutdown mark, a restart record written after this boot started, or ahead of the clock, is no evidence', async () => {
    for (const where of ['this boot', 'future']) {
        const w = makeWorld();
        w.install('carplay', 'unproven');
        const info = path.join(w.dir, 'sin', 'recmgr', 'restartInfo.xml'), stat = path.join(w.dir, 'stat');
        await bootUp(w, 'A');
        END.powerCut(w);
        fs.writeFileSync(info, '<x/>');
        if (where === 'future') { const t = Date.now() / 1000 + 600; fs.utimesSync(info, t, t); }
        fs.writeFileSync(stat, 'btime ' + Math.floor(Date.now() / 1000 - (where === 'future' ? 30 : 0) - 1) + '\n');
        const was = process.env.WOC_PROC_STAT;
        process.env.WOC_PROC_STAT = stat;
        try {
            if (where === 'this boot') { const t = Date.now() / 1000 + 0.5; fs.utimesSync(info, t, t); fs.writeFileSync(stat, 'btime ' + Math.floor(Date.now() / 1000 - 2) + '\n'); }
            const { step } = await bootUp(w, 'B');
            assert.deepStrictEqual([step.action, w.state('carplay').unknown], ['armed', 1], where);
        } finally { process.env.WOC_PROC_STAT = was; }
    }
});

test('with no shutdown mark, a restart record recmgr or crashhandler wrote after the boot was armed is the evidence', async () => {
    for (const who of ['recmgr', 'crashhandler']) {
        for (const fresh of [true, false]) {
            const w = makeWorld();
            w.install('carplay', 'unproven');
            const info = path.join(w.dir, 'sin', who, 'restartInfo.xml');
            if (!fresh) { fs.writeFileSync(info, '<x/>'); const t = Date.now() / 1000 - 3600; fs.utimesSync(info, t, t); }
            await bootUp(w, 'A');
            if (fresh) fs.writeFileSync(info, '<x/>');   /* the crash; var-opt-ro never ran */
            END.powerCut(w);
            /* the next boot starts after the record */
            fs.writeFileSync(path.join(ROOT, 'no-proc-stat'), 'cpu 1 2 3\nbtime ' + Math.ceil(Date.now() / 1000) + '\n');
            let step;
            try { step = (await bootUp(w, 'B')).step; } finally { fs.unlinkSync(path.join(ROOT, 'no-proc-stat')); }
            assert.strictEqual(step.action, fresh ? 'restored' : 'armed', who + (fresh ? ': written in that boot' : ': older than the boot'));
        }
    }
});

test('a healthy boot clears the counter; a crash after a healthy minute still counts', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    await bootUp(w, 'A');
    END.otherCrash(w, 'A');
    const { watcher } = await bootUp(w, 'B');
    assert.strictEqual(w.state('carplay').fails, 1);
    w.now.advance(30000);
    assert.strictEqual((await tick(watcher)).action, 'watch');
    w.now.advance(31000);
    assert.strictEqual((await tick(watcher)).action, 'confirmed');
    END.otherCrash(w, 'B');
    const c = await bootUp(w, 'C');
    assert.strictEqual(w.state('carplay').fails, 0, 'healthy, then a restart for another crash: cleared');
    w.now.advance(61000);
    assert.strictEqual((await tick(c.watcher)).action, 'confirmed');
    w.svc.carplay.crashes();
    await tick(c.watcher);
    END.powerCut(w);
    await bootUp(w, 'D');
    assert.strictEqual(w.state('carplay').fails, 1, 'its own crash counts');
});

test('the original (Disable used) or no backup of ours: nothing armed, counted or restored', async () => {
    for (const kind of ['original', 'none']) {
        const w = makeWorld();
        assert.strictEqual(await loop(w, 'carplay', kind, END.crashAtStart, 4), 0, kind);
        assert.strictEqual(w.state('carplay'), null, kind + ': no state written');
        assert.strictEqual(w.holds('carplay'), 'original');
    }
});

test('a missing or corrupt state file restores nothing on its own; the boot is armed afresh', async () => {
    for (const content of [null, '', '{"fails": ', 'null\n', '[1,2]']) {
        const w = makeWorld();
        w.install('carplay', 'unproven');
        if (content !== null) fs.writeFileSync(w.T.carplay.state, content);
        END.otherCrash(w, 'A');   /* a crash restart of a boot with no record of ours */
        const r = await startBoot(w.recovery('carplay', 'B'));
        assert.deepStrictEqual([r.action, r.fails], ['armed', 0], JSON.stringify(content));
        assert.strictEqual(w.holds('carplay'), 'patched');
    }
});

test('a corrupt or missing patch record: the patch counts as proven (restored at boot 3)', async () => {
    for (const rec of ['{oops', '{"patched":true,"proven":false}\n']) {
        const w = makeWorld();
        w.install('carplay', 'unknown');
        fs.writeFileSync(record.recordPath(w.T.carplay.target), rec);
        const r = await startBoot(w.recovery('carplay', 'A'));
        assert.deepStrictEqual([r.action, r.patch], ['armed', 'unknown'], rec);
        END.crashAtStart(w, 'A', 'carplay');
        assert.strictEqual((await startBoot(w.recovery('carplay', 'B'))).action, 'armed', rec);
        END.crashAtStart(w, 'B', 'carplay');
        assert.strictEqual((await startBoot(w.recovery('carplay', 'C', { restore: (f, cb) => recovery.restoreTarget(w.T.carplay, true, f, cb, 1000) }))).action, 'restored', rec);
    }
});

test('an unknown binary that is the original already: nothing written but the record', async () => {
    const w = makeWorld();
    w.install('carplay', 'unknown');
    fs.writeFileSync(w.T.carplay.target, w.bin.carplay.original);
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 2, unknown: 0, arm: null }));
    const r = await startBoot(w.recovery('carplay', 'A'));
    assert.strictEqual(r.action, 'idle');
    assert.deepStrictEqual([record.current(w.T.carplay.target).patched, record.current(w.T.carplay.target).by], [false, undefined], 'recorded, no restore reported');
    assert.strictEqual((await startBoot(w.recovery('carplay', 'B'))).action, 'idle', 'and not armed again');
});

/* ---- both services ---- */

test('both patched: a failure no record explains counts for both; a crash of one counts for it alone', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    w.install('aapd', 'proven');
    await bootUp(w, 'A', ['carplay', 'aapd']);
    END.otherCrash(w, 'A');
    const b = await bootUp(w, 'B', ['carplay', 'aapd']);
    assert.deepStrictEqual([b.steps.carplay.action, b.steps.aapd.action], ['restored', 'armed'], 'each at its own threshold');
    assert.strictEqual(w.state('aapd').fails, 1);
    w.events.length = 0;

    const x = makeWorld();
    x.install('carplay', 'proven');
    x.install('aapd', 'proven');
    await bootUp(x, 'A', ['carplay', 'aapd']);
    END.crashAtStart(x, 'A', 'aapd');
    await bootUp(x, 'B', ['carplay', 'aapd']);
    assert.deepStrictEqual([x.state('carplay').fails, x.state('aapd').fails], [0, 1], 'aapd\'s crash ended the boot');
    END.crashAtStart(x, 'B', 'aapd');
    const c = await bootUp(x, 'C', ['carplay', 'aapd']);
    assert.deepStrictEqual([c.steps.carplay.action, c.steps.aapd.action], ['armed', 'restored']);
});

test('a crash of the other service explains nothing once that service is not patched', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    w.install('aapd', 'original');
    for (const boot of ['A', 'B']) {
        await bootUp(w, boot, ['carplay', 'aapd']);
        END.crashAtStart(w, boot, 'aapd');
    }
    assert.strictEqual((await bootUp(w, 'C', ['carplay', 'aapd'])).steps.carplay.action, 'restored');
});

/* ---- the restore ---- */

test('a backup that does not match its record: refused, the service starts as it is, the next boot tries again', async () => {
    for (const damage of ['bytes', 'record']) {
        const w = makeWorld();
        w.install('carplay', 'unproven');
        if (damage === 'bytes') fs.appendFileSync(w.T.carplay.target + '.woc-orig', 'x');
        else fs.writeFileSync(w.T.carplay.target + '.woc-orig.json', '{}');
        await bootUp(w, 'A');
        END.crashAtStart(w, 'A', 'carplay');
        fs.writeFileSync(MOUNT_LOG, '');
        const { step } = await bootUp(w, 'B');
        assert.strictEqual(step.action, 'restore-failed', damage);
        assert(/refusing the backup/.test(step.error), step.error);
        assert(w.logs.some((l) => /restore failed: refusing the backup/.test(l)), damage + ': logged');
        assert.deepStrictEqual(w.events.slice(-1), ['carplay-start:patched'], damage + ': carplay starts');
        assert.strictEqual(fs.readFileSync(MOUNT_LOG, 'utf8'), '', damage + ': / never remounted');
        assert.strictEqual(w.state('carplay').fails, 1, damage + ': the count stays');
        END.crashAtStart(w, 'B', 'carplay');
        assert.strictEqual((await bootUp(w, 'C')).step.action, 'restore-failed', damage + ': tried again');
    }
});

test('another build than the backup\'s (a firmware update): not restored, the counter cleared', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    await bootUp(w, 'A');
    END.crashAtStart(w, 'A', 'carplay');
    fs.writeFileSync(w.T.carplay.target, Buffer.concat([w.bin.carplay.patched, Buffer.alloc(16)]));
    const { step } = await bootUp(w, 'B');
    assert.strictEqual(step.action, 'armed', 'not ours to vouch for: counted as proven');
    END.crashAtStart(w, 'B', 'carplay');
    const c = await bootUp(w, 'C');
    assert.strictEqual(c.step.action, 'idle');
    assert.strictEqual(w.holds('carplay'), 'other', 'the newer build stays');
    assert.strictEqual(w.state('carplay').fails, 0);
});

test('aapd.conf another file than its backup is left while aapd is restored', async () => {
    const w = makeWorld();
    w.install('aapd', 'unproven');
    fs.writeFileSync(w.T.aapd.files[1], '{"OTHER":1}\n');
    await bootUp(w, 'A', ['aapd']);
    END.crashAtStart(w, 'A', 'aapd');
    assert.strictEqual((await bootUp(w, 'B', ['aapd'])).step.action, 'restored');
    assert.strictEqual(w.holds('aapd'), 'original');
    assert.strictEqual(fs.readFileSync(w.T.aapd.files[1], 'utf8'), '{"OTHER":1}\n');
});

test('the restore sets carplay to 0755, leaves no temporary file, clears the pending marker and leaves / read-only', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.chmodSync(w.T.carplay.target, 0o751);
    fs.writeFileSync(w.T.carplay.pending, '{"action":"apply"}\n');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    let outcome = null;
    await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (err, o) => { assert.ifError(err); outcome = o; res(); }));
    assert.strictEqual(outcome, 'restored');
    assert.strictEqual(fs.statSync(w.T.carplay.target).mode & 0o777, 0o755);
    assert(!fs.existsSync(w.T.carplay.target + '.woc-tmp') && !fs.existsSync(w.T.carplay.pending) && !fs.existsSync(w.T.carplay.running));
    assert(ro());
});

test('recovery under umask 077 sets 0755 even with a restrictive temporary file and keeps ownership', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    const file = w.T.carplay.target, owner = fs.statSync(file);
    fs.chmodSync(file, 0o700);
    fs.writeFileSync(file + '.woc-tmp', 'interrupted restore', { mode: 0o600 });
    const mask = process.umask(0o077);
    try {
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (err, outcome) => {
            assert.ifError(err); assert.strictEqual(outcome, 'restored'); res();
        }));
    } finally { process.umask(mask); }
    const after = fs.statSync(file);
    assert.strictEqual(after.mode & 0o7777, 0o755);
    assert.strictEqual(after.uid, owner.uid);
    assert.strictEqual(after.gid, owner.gid);
    assert.strictEqual(w.holds('carplay'), 'original');
    assert(ro());
});

/* Permissions-only damage: an original carplay, aapd or aapd.conf that lacks
 * the access its service's user needs, as a write under umask 077 leaves it. */
async function underUmask077(fn) {
    const mask = process.umask(0o077);
    try { return await fn(); } finally { process.umask(mask); }
}

test('the boot step gives a verified original at 0700 its mode back at once, whatever the count; nothing else changes', async () => {
    for (const fails of [0, 1]) {
        const w = makeWorld();
        w.install('carplay', 'original');
        const file = w.T.carplay.target;
        fs.chmodSync(file, 0o700);
        fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails, unknown: 0, arm: null }));
        const before = fs.statSync(file), rec = record.current(file);
        const r = await underUmask077(() => startBoot(w.recovery('carplay', 'A', { repairModes: (cb) => recovery.repairModes(w.T.carplay, 1000, cb) })));
        assert.strictEqual(r.action, 'idle');
        assert.strictEqual(r.repaired, 1);
        const after = fs.statSync(file);
        assert.strictEqual(after.mode & 0o7777, 0o755);
        assert.strictEqual(after.uid, before.uid);
        assert.strictEqual(after.gid, before.gid);
        assert.strictEqual(after.ino, before.ino);
        assert.strictEqual(w.holds('carplay'), 'original');
        assert.deepStrictEqual(record.current(file), rec);
        assert(ro());
        const again = await startBoot(w.recovery('carplay', 'B'));
        assert.strictEqual(again.action, 'idle');
        assert.strictEqual(again.repaired, undefined);
    }
});

test('the watcher\'s start repairs it too; the original\'s recorded mode and owner are the ones set', async () => {
    const w = makeWorld();
    w.install('carplay', 'original');
    const file = w.T.carplay.target, st = fs.statSync(file);
    fs.writeFileSync(file + '.woc-orig.json', JSON.stringify({ target: file, sha256_original: sha(w.bin.carplay.original), mode: 0o775, uid: st.uid, gid: st.gid }));
    fs.chmodSync(file, 0o700);
    const r = await underUmask077(() => startBoot(w.recovery('carplay', 'A')));
    assert.strictEqual(r.repaired, 1);
    assert.strictEqual(fs.statSync(file).mode & 0o7777, 0o775);
});

test('aapd at 0700 and aapd.conf at 0600, each its verified original: 0755 and 0644 at the boot step', async () => {
    const w = makeWorld();
    w.install('aapd', 'original');
    fs.chmodSync(w.T.aapd.files[0], 0o700);
    fs.chmodSync(w.T.aapd.files[1], 0o600);
    const r = await underUmask077(() => startBoot(w.recovery('aapd', 'A')));
    assert.strictEqual(r.repaired, 2);
    assert.strictEqual(fs.statSync(w.T.aapd.files[0]).mode & 0o7777, 0o755);
    assert.strictEqual(fs.statSync(w.T.aapd.files[1]).mode & 0o7777, 0o644);
    assert(ro());
});

test('with no backup of ours, the proven build\'s shipped carplay at 0700 is repaired; any other file is not', async () => {
    for (const stock of [true, false]) {
        const w = makeWorld();
        w.install('carplay', 'none');
        w.T.carplay.stock = (i, cur) => stock && cur.equals(w.bin.carplay.original);
        fs.chmodSync(w.T.carplay.target, 0o700);
        const r = await startBoot(w.recovery('carplay', 'A'));
        assert.strictEqual(r.action, 'idle');
        assert.strictEqual(r.repaired, stock ? 1 : undefined);
        assert.strictEqual(fs.statSync(w.T.carplay.target).mode & 0o7777, stock ? 0o755 : 0o700);
        assert(ro());
    }
});

test('our patch at 0700 is not repaired in place: it counts, and the restore at the threshold writes the original at 0755', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    fs.chmodSync(w.T.carplay.target, 0o700);
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: THRESHOLD.proven, unknown: 0, arm: null }));
    const r = await underUmask077(() => startBoot(w.recovery('carplay', 'A', { restore: (fails, cb) => recovery.restoreTarget(w.T.carplay, true, fails, cb, 1000) })));
    assert.strictEqual(r.repaired, undefined);
    assert.strictEqual(r.action, 'restored');
    assert.strictEqual(w.holds('carplay'), 'original');
    assert.strictEqual(fs.statSync(w.T.carplay.target).mode & 0o7777, 0o755);
    assert(ro());
});

test('the aapd restore under umask 077 writes aapd 0755 and aapd.conf 0644 over a stale temporary file', async () => {
    const w = makeWorld();
    w.install('aapd', 'unproven');
    fs.chmodSync(w.T.aapd.files[0], 0o700);
    fs.chmodSync(w.T.aapd.files[1], 0o600);
    fs.writeFileSync(w.T.aapd.files[0] + '.woc-tmp', 'cut short', { mode: 0o600 });
    await underUmask077(() => new Promise((res) => recovery.restoreTarget(w.T.aapd, true, 1, (err, o) => { assert.ifError(err); assert.strictEqual(o, 'restored'); res(); })));
    assert.strictEqual(w.holds('aapd'), 'original');
    assert(fs.readFileSync(w.T.aapd.files[1]).equals(CONF.original));
    assert.strictEqual(fs.statSync(w.T.aapd.files[0]).mode & 0o7777, 0o755);
    assert.strictEqual(fs.statSync(w.T.aapd.files[1]).mode & 0o7777, 0o644);
    assert(!fs.existsSync(w.T.aapd.files[0] + '.woc-tmp'));
    assert(ro());
});

test('the real boot step under umask 077 repairs an original carplay at 0700 before carplay starts', () => {
    const w = makeWorld();
    w.install('carplay', 'original');
    fs.chmodSync(w.T.carplay.target, 0o700);
    const mask = process.umask(0o077);
    let r;
    try { r = runBootStep(w, 'carplay', 'A'); } finally { process.umask(mask); }
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert(/carplay boot check: idle, mode and owner set on 1 file/.test(r.stdout), r.stdout);
    assert.strictEqual(fs.statSync(w.T.carplay.target).mode & 0o7777, 0o755);
    assert(ro());
});

test('originals the service users can run and read (0555, 0444) are left alone: nothing remounted', async () => {
    for (const name of ['carplay', 'aapd']) {
        const w = makeWorld();
        w.install(name, 'original');
        fs.chmodSync(w.T[name].files[0], 0o555);
        if (name === 'aapd') fs.chmodSync(w.T.aapd.files[1], 0o444);
        const before = fs.existsSync(MOUNT_LOG) ? fs.readFileSync(MOUNT_LOG, 'utf8') : '';
        const r = await startBoot(w.recovery(name, 'A'));
        assert.strictEqual(r.repaired, undefined, name);
        assert.strictEqual(fs.statSync(w.T[name].files[0]).mode & 0o7777, 0o555);
        if (name === 'aapd') assert.strictEqual(fs.statSync(w.T.aapd.files[1]).mode & 0o7777, 0o444);
        assert.strictEqual(fs.existsSync(MOUNT_LOG) ? fs.readFileSync(MOUNT_LOG, 'utf8') : '', before, name + ': no remount');
    }
});

test('a stop during the boot step\'s mode repair waits for it: / read-only and the lock released before it exits', async () => {
    const w = makeWorld();
    w.install('carplay', 'original');
    fs.chmodSync(w.T.carplay.target, 0o700);
    const mounts = path.join(w.dir, 'mounts'), lockFile = path.join(w.dir, 'remount.lock'), mount = path.join(w.dir, 'mount');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    /* remount,rw takes / read-write and returns after 1.5 s */
    fs.writeFileSync(mount, '#!' + process.execPath + '\nvar fs = require("fs"), rw = process.argv.indexOf("remount,rw") > 0;\n' +
        'fs.writeFileSync(' + JSON.stringify(mounts) + ', "/dev/root / ext4 " + (rw ? "rw" : "ro") + " 0 0\\n");\n' +
        'if (rw) setTimeout(function () {}, 1500);\n');
    fs.chmodSync(mount, 0o755);
    cp.execFileSync(mount, ['first']);   /* macOS checks a new executable at its first start */
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(path.join(w.dir, 'boot_id'), 'A\n');
    const child = cp.spawn(process.execPath, [RECOVERY_PATH, 'boot', 'carplay'], {
        env: Object.assign({}, process.env, { WOC_CARPLAY: w.T.carplay.target, WOC_AAPD: w.T.aapd.target, WOC_AAPD_CONF: w.T.aapd.files[1],
            WOC_RECOVERY_STATE: w.T.carplay.state, WOC_PATCH_SOCK: path.join(w.dir, 'shm', 'patch.sock'), WOC_BOOT_ID: path.join(w.dir, 'boot_id'),
            WOC_MOUNT: mount, WOC_PROC_MOUNTS: mounts, WOC_REMOUNT_LOCK: lockFile }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    for (let t = Date.now(); !/\brw\b/.test(fs.readFileSync(mounts, 'utf8')) && Date.now() - t < 5000;) await new Promise((r) => setTimeout(r, 10));
    assert(/\brw\b/.test(fs.readFileSync(mounts, 'utf8')), 'the repair took / read-write: ' + out);
    child.kill('SIGTERM');
    const code = await exited;
    assert.strictEqual(code, 0, out);
    assert(/\bro\b/.test(fs.readFileSync(mounts, 'utf8')), '/ read-only again: ' + out);
    assert(!fs.existsSync(lockFile), 'the remount lock released');
    assert.strictEqual(fs.statSync(w.T.carplay.target).mode & 0o7777, 0o755);
    assert(!/boot check: (idle|armed)/.test(out), 'nothing decided after the stop: ' + out);
});

test('permissions-only recovery leaves unknown originals and firmware replacements untouched', async () => {
    for (const other of [false, true]) {
        const w = makeWorld();
        w.install('carplay', 'original');
        const file = w.T.carplay.target;
        if (other) fs.writeFileSync(file, require('./synthetic_carplay.js').build().buf);
        fs.chmodSync(file, 0o700);
        const before = fs.readFileSync(file);
        let outcome;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 2, (err, o) => {
            assert.ifError(err); outcome = o; res();
        }));
        assert.strictEqual(outcome, other ? 'other' : 'original');
        assert(fs.readFileSync(file).equals(before));
        assert.strictEqual(fs.statSync(file).mode & 0o7777, 0o700);
        assert(ro());
    }
});

test('the restore defers to patchd\'s remount lock, and the boot step waits for it a bounded time', async () => {
    const lock = require('../remount_lock.js');
    const w = makeWorld();
    w.install('carplay', 'unproven');
    assert(lock.tryAcquire());
    try {
        let err = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }));
        assert(err && /deferring/.test(err.message), String(err));
        const t0 = Date.now();
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }, 300));
        assert(err && /held for 300 ms/.test(err.message) && Date.now() - t0 < 2000, String(err));
        assert.strictEqual(w.holds('carplay'), 'patched');
    } finally { lock.release(); }
    setTimeout(() => lock.release(), 200);
    assert(lock.tryAcquire());
    let outcome = null;
    await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e, o) => { assert.ifError(e); outcome = o; res(); }, 3000));
    assert.strictEqual(outcome, 'restored', 'taken once patchd let go');
});

/* A process runs file: a fake /proc/<pid>/exe holding its inode. */
function runs(pid, file) { fs.mkdirSync(path.join(ROOT, 'proc', pid)); fs.linkSync(file, path.join(ROOT, 'proc', pid, 'exe')); }
function noProcs() { fs.readdirSync(path.join(ROOT, 'proc')).forEach((p) => cp.execFileSync('rm', ['-rf', path.join(ROOT, 'proc', p)])); }

test('the patched binary a process runs stays linked so / can go read-only; the watcher links it always', async () => {
    for (const [onlyIfRunning, running] of [[true, true], [false, false], [true, false]]) {
        const w = makeWorld();
        w.install('carplay', 'unproven');
        const ino = fs.statSync(w.T.carplay.target).ino;
        if (running) runs('1', w.T.carplay.target);
        try {
            await new Promise((res) => recovery.restoreTarget(w.T.carplay, onlyIfRunning, 1, (e) => { assert.ifError(e); res(); }));
            const linked = fs.existsSync(w.T.carplay.running) ? fs.statSync(w.T.carplay.running).ino : null;
            assert.strictEqual(linked, running || !onlyIfRunning ? ino : null, JSON.stringify([onlyIfRunning, running]));
            assert.strictEqual(w.holds('carplay'), 'original');
        } finally { noProcs(); }
    }
});

test('with processes running both the target and its link, the restore waits for the next boot', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.running, 'an older binary\n');
    runs('1', w.T.carplay.running);
    runs('2', w.T.carplay.target);
    try {
        let err = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }));
        assert(err && /deferring/.test(err.message));
        assert.strictEqual(w.holds('carplay'), 'patched');
    } finally { noProcs(); }
});

test('a remount that leaves / writable is reported', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    const mount = path.join(ROOT, 'mount'), body = fs.readFileSync(mount, 'utf8');
    fs.writeFileSync(mount, '#!/bin/sh\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '";; esac\n');
    try {
        let err = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }));
        assert(err && /read-write after remount/.test(err.message), String(err));
        assert(err.roFailed, 'the error is the ro-failed one');
        /* Review of fix-p (F-P3): the lock is NOT let go while / is not verified read-only. */
        assertGuardStands('restore');
    } finally { fs.writeFileSync(mount, body); fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n'); await healGuard('restore'); }
});

/* A remount,rw that fails after it changed the mount (non-zero exit, a signal,
 * the timeout) must still be followed by a bounded remount,ro, and only then
 * the lock is let go. Each mount here takes / read-write first and then fails. */
function failingMount(how) {
    const mount = path.join(ROOT, 'mount'), body = fs.readFileSync(mount, 'utf8');
    const rw = 'echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '"\n';
    fs.writeFileSync(mount, '#!/bin/sh\n' + 'echo "$*" >> "' + MOUNT_LOG + '"\n' +
        'case "$*" in *remount,rw*) ' + rw + (how === 'exit' ? 'exit 1' : 'kill -9 $$') + ' ;; *remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + MOUNTS + '";; esac\n');
    fs.writeFileSync(MOUNT_LOG, '');
    return () => { fs.writeFileSync(mount, body); fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n'); };
}
const mountCalls = () => fs.readFileSync(MOUNT_LOG, 'utf8').trim().split('\n').filter(Boolean);
const GUARD = path.join(ROOT, 'remount.lock.ro-failed');
/* The ro-failed guard (review of fix-p): the lock is held by this process and the marker names the reason. */
function assertGuardStands(tag) {
    const lock = require('../remount_lock.js');
    assert.strictEqual(lock.tryAcquire(), false, tag + ': the remount lock is still held (/ is not verified read-only)');
    assert.strictEqual(fs.readFileSync(path.join(ROOT, 'remount.lock'), 'utf8').split(' ')[0], String(process.pid), tag + ': this process holds it');
    assert(fs.existsSync(GUARD) && /ro-failed|read-write/.test(fs.readFileSync(GUARD, 'utf8')), tag + ': the ro-failed marker names the reason');
    assert.strictEqual(lock.tryAcquireWrite(), false, tag + ': no writer passes');
}
/* The mount works again and / is read-only: the next guard check clears the guard and lets go of the lock. */
async function healGuard(tag) {
    fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
    const left = await new Promise((res) => recovery.roGuard(res));
    assert.strictEqual(left, null, tag + ': the guard clears once / is read-only');
    assert(!fs.existsSync(GUARD), tag + ': marker gone');
    assertLockFree();
}
function assertLockFree() {
    const lock = require('../remount_lock.js');
    assert.strictEqual(lock.tryAcquire(), true, 'the remount lock was released');
    lock.release();
}

test('a remount,rw that exits non-zero or is killed by a signal: / is put back read-only before the lock is released, in the restore and in the mode repair', async () => {
    for (const how of ['exit', 'signal']) {
        for (const which of ['restore', 'repair']) {
            const w = makeWorld();
            w.install('carplay', which === 'restore' ? 'unproven' : 'original');
            if (which === 'repair') fs.chmodSync(w.T.carplay.target, 0o700);
            const undo = failingMount(how);
            const seen = { ro: null, locked: null };
            try {
                const lock = require('../remount_lock.js');
                let err = null;
                await new Promise((res) => {
                    const cb = (e) => { err = e; res(); };
                    /* the state of / and of the lock as the caller is told */
                    const wrap = (e) => { seen.ro = ro(); seen.locked = !lock.tryAcquire(); if (!seen.locked) lock.release(); cb(e); };
                    if (which === 'restore') recovery.restoreTarget(w.T.carplay, true, 1, wrap);
                    else recovery.repairModes(w.T.carplay, 0, wrap);
                });
                const tag = how + '/' + which;
                assert(err && /remount rw/.test(err.message), tag + ': ' + err);
                const calls = mountCalls();
                assert(/remount,rw/.test(calls[0]), tag + ': ' + calls);
                assert(calls.slice(1).some((c) => /remount,ro/.test(c)), tag + ': remount,ro attempted: ' + calls);
                assert.strictEqual(seen.ro, true, tag + ': / read-only when the caller is told');
                assert.strictEqual(seen.locked, false, tag + ': lock already free when the caller is told');
                assert(ro(), tag + ': / read-only');
                assertLockFree();
                if (which === 'restore') assert.strictEqual(w.holds('carplay'), 'patched', tag + ': nothing written');
            } finally { undo(); }
        }
    }
});

test('a remount,rw that cannot be undone (the remount,ro fails too) is logged and does not throw; the lock is KEPT with the ro-failed guard', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    const mount = path.join(ROOT, 'mount'), body = fs.readFileSync(mount, 'utf8');
    fs.writeFileSync(mount, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '"; exit 1;; *remount,ro*) exit 1;; esac\n');
    fs.writeFileSync(MOUNT_LOG, '');
    const out = [], realWrite = process.stdout.write;
    process.stdout.write = function (s) { out.push(String(s)); return true; };
    try {
        let err = null;
        try {
            await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }));
        } finally { process.stdout.write = realWrite; }
        assert(err && /remount rw/.test(err.message), String(err));
        assert(/could not be put back read-only/.test(out.join('')), 'logged: ' + out.join(''));
        assert(mountCalls().filter((c) => /remount,ro/.test(c)).length >= 1);
        /* Review of fix-p (F-P3): this used to assert the lock was released. It stays held, with the guard set. */
        assert(err.roFailed, 'the error says ro-failed');
        assertGuardStands('rw failed, ro failed');
    } finally { fs.writeFileSync(mount, body); fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n'); await healGuard('rw failed, ro failed'); }
});

test('the boot step: a remount,rw that times out (killed after the step bound) is followed by remount,ro and the lock is released', () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    const mounts = path.join(w.dir, 'mounts'), lockFile = path.join(w.dir, 'remount.lock'), log = path.join(w.dir, 'mount.log');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    /* remount,rw takes / read-write, then hangs until the step kills it with SIGTERM */
    fs.writeFileSync(path.join(w.dir, 'mount'), '#!' + process.execPath + '\nvar fs = require("fs"), rw = process.argv.indexOf("remount,rw") > 0;\n' +
        'fs.appendFileSync(' + JSON.stringify(log) + ', process.argv.slice(2).join(" ") + "\\n");\n' +
        'fs.writeFileSync(' + JSON.stringify(mounts) + ', "/dev/root / ext4 " + (rw ? "rw" : "ro") + " 0 0\\n");\n' +
        'if (rw) setTimeout(function () {}, 30000);\n', { mode: 0o755 });
    cp.execFileSync(path.join(w.dir, 'mount'), ['first']);   /* macOS checks a new executable at its first start */
    fs.writeFileSync(log, '');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    const r = runBootStep(w, 'carplay', 'B', { WOC_RECOVERY_STEP_MS: '400', WOC_MOUNT: path.join(w.dir, 'mount'), WOC_PROC_MOUNTS: mounts, WOC_REMOUNT_LOCK: lockFile });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert(/remount,rw/.test(calls[0]), String(calls));
    assert(calls.slice(1).some((c) => /remount,ro/.test(c)), 'remount,ro attempted: ' + calls);
    assert(/\bro\b/.test(fs.readFileSync(mounts, 'utf8')), '/ read-only');
    assert(!fs.existsSync(lockFile), 'the remount lock released');
    assert(/remount rw/.test(r.stdout), r.stdout);
});

test('the success path is unchanged: one remount,rw, the write, one remount,ro, nothing else', async () => {
    for (const which of ['restore', 'repair']) {
        const w = makeWorld();
        w.install('carplay', which === 'restore' ? 'unproven' : 'original');
        if (which === 'repair') fs.chmodSync(w.T.carplay.target, 0o700);
        fs.writeFileSync(MOUNT_LOG, '');
        await new Promise((res) => {
            const cb = (e) => { assert.ifError(e); res(); };
            if (which === 'restore') recovery.restoreTarget(w.T.carplay, true, 1, cb); else recovery.repairModes(w.T.carplay, 0, cb);
        });
        const calls = mountCalls();
        assert.strictEqual(calls.length, 2, which + ': ' + calls);
        assert(/remount,rw/.test(calls[0]) && /remount,ro/.test(calls[1]), which + ': ' + calls);
        assert(ro());
        assertLockFree();
    }
});
/* ---- review of fix-p: F-P2 (the link of a running binary) and F-P3 (the ro-failed guard) ---- */

test('F-P2: a process runs the target and it cannot be kept linked: nothing is written, / goes read-only (verified), the lock is released', async () => {
    for (const onlyIfRunning of [true, false]) {
        const w = makeWorld();
        w.install('carplay', 'unproven');
        fs.mkdirSync(w.T.carplay.running);   /* a directory in the way: the old link cannot be unlinked, the new one is EEXIST */
        runs('1', w.T.carplay.target);
        fs.writeFileSync(MOUNT_LOG, '');
        try {
            let err = null;
            await new Promise((res) => recovery.restoreTarget(w.T.carplay, onlyIfRunning, 1, (e) => { err = e; res(); }));
            const tag = 'onlyIfRunning=' + onlyIfRunning;
            assert(err && /keeping .* linked as .* failed.*; nothing written/.test(err.message), tag + ': ' + err);
            assert.strictEqual(w.holds('carplay'), 'patched', tag + ': nothing written');
            assert(ro(), tag + ': / read-only');
            assert(!err.roFailed && !fs.existsSync(GUARD), tag + ': / was verified read-only, so no guard');
            assertLockFree();
            const calls = mountCalls();
            assert(/remount,rw/.test(calls[0]) && /remount,ro/.test(calls[calls.length - 1]), tag + ': ' + calls);
        } finally { noProcs(); fs.rmdirSync(w.T.carplay.running); }
    }
});

test('F-P2 (G2-4): with no process on the target, a link that cannot be made still aborts the restore: nothing is written', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.mkdirSync(w.T.carplay.running);
    try {
        let outcome = null, err = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, false, 1, (e, o) => { err = e; outcome = o; res(); }));
        assert(err && /nothing written/.test(err.message), String(err));
        assert.strictEqual(outcome, undefined);
        assert.strictEqual(w.holds('carplay'), 'patched');
        assert(ro());
        assertLockFree();
    } finally { fs.rmdirSync(w.T.carplay.running); }
});

/* A mount whose remount,ro takes nothing back: / stays read-write once remount,rw ran. */
function brokenRoMount(w, hangRw) {
    const mounts = path.join(w.dir, 'mounts'), log = path.join(w.dir, 'mount.log'), mount = path.join(w.dir, 'mount');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(mount, '#!' + process.execPath + '\nvar fs = require("fs"), rw = process.argv.indexOf("remount,rw") > 0;\n' +
        'fs.appendFileSync(' + JSON.stringify(log) + ', process.argv.slice(2).join(" ") + "\\n");\n' +
        'if (rw) { fs.writeFileSync(' + JSON.stringify(mounts) + ', "/dev/root / ext4 rw 0 0\\n");' + (hangRw ? ' process.on("SIGTERM", function () {}); setTimeout(function () {}, 30000);' : '') + ' }\n', { mode: 0o755 });
    cp.execFileSync(mount, ['first']);   /* macOS checks a new executable at its first start */
    fs.writeFileSync(log, '');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    return { mounts, log, mount, lockFile: path.join(w.dir, 'remount.lock'), env: { WOC_MOUNT: mount, WOC_PROC_MOUNTS: mounts, WOC_REMOUNT_LOCK: path.join(w.dir, 'remount.lock') } };
}
function workingMount(w, m) {
    fs.writeFileSync(m.mount, '#!' + process.execPath + '\nvar fs = require("fs"), rw = process.argv.indexOf("remount,rw") > 0;\n' +
        'fs.appendFileSync(' + JSON.stringify(m.log) + ', process.argv.slice(2).join(" ") + "\\n");\n' +
        'fs.writeFileSync(' + JSON.stringify(m.mounts) + ', "/dev/root / ext4 " + (rw ? "rw" : "ro") + " 0 0\\n");\n', { mode: 0o755 });
    cp.execFileSync(m.mount, ['first']);
    fs.writeFileSync(m.log, '');
}

test('F-P3: the boot step at its hard deadline with a remount,ro that does nothing: lock kept, guard set, failure surfaced (exit 1); a later run with a working mount clears it', () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    const m = brokenRoMount(w, true);   /* remount,rw takes / read-write and hangs past its kill */
    const guard = m.lockFile + '.ro-failed';
    const t0 = Date.now();
    const r = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '400' }, m.env));
    assert(/out of time/.test(r.stdout), r.stdout + r.stderr);
    assert(Date.now() - t0 < 400 + 400 * 3 + 500 + 200 + 400 + 500 + 3000, 'exited by its bound: ' + (Date.now() - t0));
    assert.strictEqual(r.status, 1, 'a terminal failure, not 0: ' + r.stdout + r.stderr);
    assert(/ro-failed/.test(r.stdout) && /boot check failed/.test(r.stdout), 'logged: ' + r.stdout);
    assert(/\brw\b/.test(fs.readFileSync(m.mounts, 'utf8')), '/ is still read-write');
    assert(fs.existsSync(m.lockFile), 'the remount lock is NOT released');
    assert(fs.existsSync(guard) && /ro-failed|out of time/.test(fs.readFileSync(guard, 'utf8')), 'the guard names the reason');
    assert(fs.readFileSync(m.log, 'utf8').split('\n').filter((c) => /remount,ro/.test(c)).length >= 2, 'more than one remount,ro try');
    assert.strictEqual(w.holds('carplay'), 'patched', 'nothing written');
    /* A later recovery run: the holder is gone, the mount works: the guard clears, the restore goes on. */
    workingMount(w, m);
    const r2 = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
    assert(/ro-failed guard is cleared/.test(r2.stdout), r2.stdout);
    assert(!fs.existsSync(guard) && !fs.existsSync(m.lockFile), 'guard and lock gone');
    assert(/\bro\b/.test(fs.readFileSync(m.mounts, 'utf8')), '/ read-only');
    assert.strictEqual(w.holds('carplay'), 'original', 'the restore went on');
});

test('F-P3: the restore whose remount,ro never takes: exit 1, lock kept; a run while it stands writes nothing; a run with a working mount clears it', () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    const m = brokenRoMount(w, false);
    const guard = m.lockFile + '.ro-failed';
    const r = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert(/restore-failed/.test(r.stdout) && /ro-failed/.test(r.stdout), r.stdout);
    assert(fs.existsSync(m.lockFile) && fs.existsSync(guard), 'lock kept, guard set');
    /* Second run, the mount still broken: it tries remount,ro once more, and writes nothing (no remount,rw). */
    fs.writeFileSync(m.log, '');
    const r2 = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r2.status, 1, r2.stdout + r2.stderr);
    assert(/boot check: ro-failed/.test(r2.stdout), r2.stdout);
    const calls = fs.readFileSync(m.log, 'utf8').split('\n').filter(Boolean);
    assert(calls.length > 0 && calls.every((c) => /remount,ro/.test(c)), 'only remount,ro tried: ' + calls);
    assert(fs.existsSync(guard), 'the guard still stands');
    workingMount(w, m);
    const r3 = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r3.status, 0, r3.stdout + r3.stderr);
    assert(!fs.existsSync(guard) && !fs.existsSync(m.lockFile), 'guard and lock gone');
});

test('F-P3: while the guard stands no writer passes, and the watcher retries it once per probe interval and clears it when / is read-only', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    const mount = path.join(ROOT, 'mount'), body = fs.readFileSync(mount, 'utf8');
    fs.writeFileSync(mount, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '";; esac\n');
    fs.writeFileSync(MOUNT_LOG, '');
    const lock = require('../remount_lock.js');
    try {
        let err = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }));
        assert(err && err.roFailed, String(err));
        assertGuardStands('first writer');
        w.install('carplay', 'unproven');   /* the first restore wrote the original before / stayed writable; a patched file again for the others */
        /* a second writer, restore and mode repair: refused with the guard's error, nothing remounted read-write */
        fs.writeFileSync(MOUNT_LOG, '');
        for (const which of ['restore', 'repair']) {
            let e2 = null;
            await new Promise((res) => {
                if (which === 'restore') recovery.restoreTarget(w.T.carplay, true, 1, (e) => { e2 = e; res(); }, 300);
                else { w.install('carplay', 'original'); fs.chmodSync(w.T.carplay.target, 0o700); recovery.repairModes(w.T.carplay, 0, (e) => { e2 = e; res(); }); }
            });
            assert(e2 && e2.roFailed && /ro-failed/.test(e2.message), which + ': ' + e2);
        }
        assert(mountCalls().every((c) => /remount,ro/.test(c)), 'no remount,rw: ' + mountCalls());
        assert.strictEqual(lock.tryAcquireWrite(), false);
        /* the mount works again: the watcher's tick clears it */
        fs.writeFileSync(mount, body);
        const rec = w.recovery('carplay', 'B');
        const r = await tick(rec);
        assert.strictEqual(r.action, 'ro-retry');
        assert(ro());
        assert(!fs.existsSync(GUARD));
        assertLockFree();
        assert.strictEqual(fs.statSync(w.T.carplay.target).mode & 0o7777, 0o700, 'the mode repair did not run');
    } finally { fs.writeFileSync(mount, body); fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n'); await healGuard('watcher'); }
});

/* ---- review of fix3-p, F2: a fresh watcher that imports an on-disk guard keeps retrying it ---- */

test('F2: a fresh watcher with only a guard on disk (nothing in its own memory) retries it every probe interval until / is read-only', async () => {
    const w = makeWorld();
    w.install('carplay', 'original');
    const mount = path.join(ROOT, 'mount'), body = fs.readFileSync(mount, 'utf8');
    const lock = require('../remount_lock.js');
    try {
        /* the guard is another process's: a file only, this process holds neither the lock nor the reason */
        fs.writeFileSync(GUARD, '4242 2026-01-01T00:00:00.000Z / is read-write after a restore\n');
        fs.writeFileSync(MOUNTS, '/dev/root / ext4 rw 0 0\n');
        fs.writeFileSync(mount, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\n');   /* remount,ro does nothing */
        fs.writeFileSync(MOUNT_LOG, '');
        assert.strictEqual(lock.roFailedReason() !== null, true, 'the on-disk guard is seen');
        const rec = w.recovery('carplay', 'B');
        let r = await tick(rec);
        assert.strictEqual(r.action, 'ro-retry', 'the first tick retries the imported guard');
        assert(mountCalls().some((c) => /remount,ro/.test(c)), 'remount,ro was tried: ' + mountCalls());
        assert(fs.existsSync(GUARD), 'still standing: / is read-write');
        /* the lock the retry took stays taken, with the guard now this process's (review of fix4-p, A) */
        assert.strictEqual(fs.readFileSync(path.join(ROOT, 'remount.lock'), 'utf8').split(' ')[0], String(process.pid), 'the lock is kept while / is read-write');
        /* within the probe interval: no new try */
        fs.writeFileSync(MOUNT_LOG, '');
        r = await tick(rec);
        assert.notStrictEqual(r.action, 'ro-retry');
        assert.strictEqual(mountCalls().length, 0);
        /* the next interval, the mount works: the retry clears the guard */
        fs.writeFileSync(mount, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\necho "/dev/root / ext4 ro 0 0" > "' + MOUNTS + '"\n');
        rec._roTry = -Infinity;
        r = await tick(rec);
        assert.strictEqual(r.action, 'ro-retry');
        assert(ro());
        assert(!fs.existsSync(GUARD), 'guard cleared');
        assertLockFree();
    } finally { fs.writeFileSync(mount, body); fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n'); try { fs.unlinkSync(GUARD); } catch (e) {} }
});

/* ---- review of fix3-p, F1: the boot step ends by verifying / read-only, not by finding no guard ---- */

const RW_LINE = '/dev/root / ext4 rw 0 0\n';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/* A process that holds the remount lock (a patchd or recovery write window) and, after releaseMs (none: never),
 * puts / read-only and lets go. Returns the child once its lock file is there. */
function lockHolder(m, releaseMs) {
    const child = cp.spawn(process.execPath, ['-e',
        'var fs = require("fs");\nfs.writeFileSync(' + JSON.stringify(m.lockFile) + ', process.pid + " " + new Date().toISOString() + "\\n");\n' +
        (releaseMs ? 'setTimeout(function () { fs.writeFileSync(' + JSON.stringify(m.mounts) + ', "/dev/root / ext4 ro 0 0\\n"); fs.unlinkSync(' + JSON.stringify(m.lockFile) + '); process.exit(0); }, ' + releaseMs + ');\n'
            : 'setInterval(function () {}, 1000);\n')], { stdio: 'ignore' });
    for (let i = 0; i < 200 && !fs.existsSync(m.lockFile); i++) sleepSync(20);
    assert(fs.existsSync(m.lockFile), 'the holder took the lock');
    return child;
}

test('F1: the boot step starts with / read-write, no marker, no lock: it puts / back read-only (remount,ro) and only then exits 0', () => {
    const w = makeWorld();
    w.install('carplay', 'original');   /* nothing to restore: an idle step */
    const m = brokenRoMount(w, false);
    workingMount(w, m);
    fs.writeFileSync(m.mounts, RW_LINE);
    const r = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const calls = fs.readFileSync(m.log, 'utf8').split('\n').filter(Boolean);
    assert(calls.length > 0 && calls.every((c) => /remount,ro/.test(c)), 'remount,ro only: ' + calls);
    assert(/\bro\b/.test(fs.readFileSync(m.mounts, 'utf8')), '/ is read-only when the step exits 0');
    assert(!fs.existsSync(m.lockFile) && !fs.existsSync(m.lockFile + '.ro-failed'), 'no lock, no guard left');
});

test('F1: the boot step starts with / read-write and no guard and remount,ro does not take: exit 1, the guard is set and the lock kept; a working mount clears it', () => {
    const w = makeWorld();
    w.install('carplay', 'original');
    const m = brokenRoMount(w, false);
    fs.writeFileSync(m.mounts, RW_LINE);
    const guard = m.lockFile + '.ro-failed';
    const r = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r.status, 1, 'not 0 with / read-write: ' + r.stdout + r.stderr);
    assert(/not verified read-only/.test(r.stdout), r.stdout);
    assert(fs.existsSync(m.lockFile) && fs.existsSync(guard), 'lock kept, guard set');
    workingMount(w, m);
    const r2 = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
    assert(!fs.existsSync(m.lockFile) && !fs.existsSync(guard) && /\bro\b/.test(fs.readFileSync(m.mounts, 'utf8')), 'cleared: ' + r2.stdout.replace(/\n/g, ' | ') + ' lock=' + fs.existsSync(m.lockFile) + ' lockfile=' + (fs.existsSync(m.lockFile) ? fs.readFileSync(m.lockFile, 'utf8') : '') + ' r2pid=' + r2.pid + ' guard=' + fs.existsSync(guard) + ' mounts=' + fs.readFileSync(m.mounts, 'utf8').replace(/\n/g, ' '));
});

test('F1: another process holds the remount lock with / read-write: the step waits; it exits 0 only once the holder is done and / is read-only, 1 if the holder is still at it', () => {
    const w = makeWorld();
    w.install('carplay', 'original');
    const m = brokenRoMount(w, false);
    workingMount(w, m);
    /* the holder finishes within the wait */
    fs.writeFileSync(m.mounts, RW_LINE);
    let holder = lockHolder(m, 600);
    let r = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '3000' }, m.env));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert(/\bro\b/.test(fs.readFileSync(m.mounts, 'utf8')) && !fs.existsSync(m.lockFile), '/ read-only, lock free');
    assert.strictEqual(fs.readFileSync(m.log, 'utf8').trim(), '', 'the step did not touch the mount while the holder worked');
    holder.kill();
    /* the holder is still in its window when the step gives up */
    fs.writeFileSync(m.mounts, RW_LINE);
    holder = lockHolder(m, 0);
    try {
        r = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '400' }, m.env));
        assert.strictEqual(r.status, 1, 'not 0 with / read-write: ' + r.stdout + r.stderr);
        assert(/held by another process/.test(r.stdout), r.stdout);
        assert.strictEqual(fs.readFileSync(m.lockFile, 'utf8').split(' ')[0], String(holder.pid), 'the holder\'s lock is untouched');
        assert.strictEqual(fs.readFileSync(m.log, 'utf8').trim(), '', 'no mount call while another process holds the lock');
        assert(/\brw\b/.test(fs.readFileSync(m.mounts, 'utf8')));
    } finally { holder.kill(); }
});

/* ---- review of fix3-p, F3: the ro-failed marker cannot be written ---- */

test('F3: the marker cannot be written (its path is a directory): the restore still keeps the lock and fails the step (exit 1); the next run takes the dead holder\'s lock, verifies / itself, writes nothing; a working mount clears it', () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    const m = brokenRoMount(w, false);
    const guard = m.lockFile + '.ro-failed';
    fs.mkdirSync(guard);   /* markRoFailed's writeFileSync fails with EISDIR */
    const r = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert(/ro-failed marker could not be written/.test(r.stdout), 'the failure is distinct in the log: ' + r.stdout);
    assert(/\brw\b/.test(fs.readFileSync(m.mounts, 'utf8')), '/ is still read-write');
    assert(fs.statSync(guard).isDirectory(), 'no marker could be written');
    assert(fs.existsSync(m.lockFile), 'the lock file is left (its holder is gone, so it can be broken: the next writer must not trust it)');
    /* The next run: no marker, a dead holder's lock, / read-write. It must not write: it takes the lock, sees / read-write,
     * tries remount,ro only, and fails the step with the guard. */
    fs.writeFileSync(m.log, '');
    w.install('carplay', 'unproven');   /* the first restore wrote the original before / stayed writable: a patch again to restore */
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    const r2 = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r2.status, 1, r2.stdout + r2.stderr);
    const calls = fs.readFileSync(m.log, 'utf8').split('\n').filter(Boolean);
    assert(calls.length > 0 && calls.every((c) => /remount,ro/.test(c)), 'only remount,ro tried, never remount,rw: ' + calls);
    assert.strictEqual(w.holds('carplay'), 'patched', 'nothing written');
    workingMount(w, m);
    const r3 = runBootStep(w, 'carplay', 'B', Object.assign({ WOC_RECOVERY_STEP_MS: '2000' }, m.env));
    assert.strictEqual(r3.status, 0, r3.stdout + r3.stderr);
    assert.strictEqual(w.holds('carplay'), 'original', 'the restore went on once / was read-only');
    assert(/\bro\b/.test(fs.readFileSync(m.mounts, 'utf8')) && !fs.existsSync(m.lockFile), '/ read-only, lock released');
});

test('F3: the marker cannot be written in this process: the guard still stands here (writers refused, lock kept), and clears when / is read-only', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    const lock = require('../remount_lock.js');
    fs.mkdirSync(GUARD);
    const mount = path.join(ROOT, 'mount'), body = fs.readFileSync(mount, 'utf8');
    fs.writeFileSync(mount, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\ncase "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + MOUNTS + '";; esac\n');
    fs.writeFileSync(MOUNT_LOG, '');
    try {
        let err = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }));
        assert(err && err.roFailed, String(err));
        assert(fs.statSync(GUARD).isDirectory(), 'no marker file');
        assert(lock.roFailedReason() !== null, 'the guard stands in memory');
        assert.strictEqual(lock.tryAcquire(), false, 'the lock is kept');
        assert.strictEqual(lock.tryAcquireWrite(), false, 'no writer passes');
        fs.writeFileSync(MOUNT_LOG, '');
        w.install('carplay', 'unproven');   /* the first restore wrote the original: a patch again for the next writer */
        let e2 = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { e2 = e; res(); }, 300));
        assert(e2 && e2.roFailed, 'the next writer is refused: ' + e2);
        assert(mountCalls().every((c) => /remount,ro/.test(c)), 'no remount,rw: ' + mountCalls());
    } finally {
        fs.writeFileSync(mount, body); fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
        fs.rmdirSync(GUARD);
        await healGuard('marker unwritable');
    }
});

test('F3: a lock taken from a dead holder with / read-write and no marker: the writer puts / back read-only first (remount,ro, then the write); if it cannot, it writes nothing', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(path.join(ROOT, 'remount.lock'), '999999 2020-01-01T00:00:00.000Z\n');   /* a holder that is gone */
    fs.writeFileSync(MOUNTS, '/dev/root / ext4 rw 0 0\n');
    fs.writeFileSync(MOUNT_LOG, '');
    let err = null;
    await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }));
    assert.ifError(err);
    assert.strictEqual(w.holds('carplay'), 'original');
    const calls = mountCalls();
    assert(/remount,ro/.test(calls[0]), 'verified and healed before anything else: ' + calls);
    assert(ro());
    assertLockFree();
    /* now one that cannot be healed */
    w.install('carplay', 'unproven');
    fs.writeFileSync(path.join(ROOT, 'remount.lock'), '999999 2020-01-01T00:00:00.000Z\n');
    fs.writeFileSync(MOUNTS, '/dev/root / ext4 rw 0 0\n');
    const mount = path.join(ROOT, 'mount'), body = fs.readFileSync(mount, 'utf8');
    fs.writeFileSync(mount, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\n');
    fs.writeFileSync(MOUNT_LOG, '');
    try {
        err = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); }));
        assert(err && err.roFailed, String(err));
        assert(mountCalls().length > 0 && mountCalls().every((c) => /remount,ro/.test(c)), 'never remount,rw: ' + mountCalls());
        assert.strictEqual(w.holds('carplay'), 'patched', 'nothing written');
        assertGuardStands('unhealable');
    } finally { fs.writeFileSync(mount, body); fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n'); await healGuard('unhealable'); }
});

test('the boot step restores a patch at once when it cannot save the boot\'s record; the original it leaves alone', async () => {
    for (const kind of ['unproven', 'original']) {
        const w = makeWorld();
        w.install('carplay', kind);
        fs.mkdirSync(w.T.carplay.state + '.tmp');   /* the temporary file's name is taken */
        const r = await startBoot(w.recovery('carplay', 'A', { restore: (f, cb) => recovery.restoreTarget(w.T.carplay, true, f, cb, 1000) }));
        assert.strictEqual(r.action, kind === 'original' ? 'idle' : 'restored', kind);
        assert.strictEqual(w.holds('carplay'), 'original', kind);
    }
});

/* ---- the watcher ---- */

test('recmgr loaded carplay: an in-boot crash loop is restored and carplay started again, with no reboot', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'proven');
    const { watcher } = await bootUp(w, 'A');
    w.events.length = 0;
    w.svc.carplay.crashes();
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).fails, 1);
    assert.strictEqual((await tick(watcher)).action, 'watch', 'the start waits its delay');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'started');
    await tick(watcher);
    w.svc.carplay.crashes();
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).restore, 'restored');
    w.now.advance(15000);
    assert.strictEqual((await tick(watcher)).action, 'started');
    assert.deepStrictEqual(w.events, ['carplay-crash', 'carplay-start:patched', 'carplay-crash', 'carplay-start:original']);
    const st = w.state('carplay');
    assert.deepStrictEqual([st.fails, st.arm, st.starts], [0, null, { boot: 'A', n: 2 }]);
    assert(fs.existsSync(w.T.carplay.running), 'the watcher kept the binary that ran linked');
});

test('an unproven patch is restored at its first in-boot crash', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'unproven');
    const { watcher } = await bootUp(w, 'A');
    w.svc.carplay.crashes();
    w.now.advance(5000);
    assert.deepStrictEqual(await tick(watcher), { action: 'crash', fails: 1, restore: 'restored' });
});

test('a run that crashed before the watcher\'s first probe is a crash, counted once, also across a watcher restart', async () => {
    const w = makeWorld({ recmgr: false });
    w.install('carplay', 'proven');
    await startBoot(w.recovery('carplay', 'A'));
    w.svc.carplay.starts();
    w.svc.carplay.crashes();
    const watcher = w.recovery('carplay', 'A');
    await startBoot(watcher);
    assert.strictEqual((await tick(watcher)).action, 'crash');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'watch');
    const again = w.recovery('carplay', 'A');
    await startBoot(again);
    assert.strictEqual((await tick(again)).action, 'watch');
    assert.strictEqual(w.state('carplay').arm.crashes, 1);
    assert.strictEqual(starts(w, 'carplay'), 1, 'without recmgr\'s entry nothing is started');
});

test('after patchd\'s activation kill, a crash of the run it started is a crash', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'proven');
    const { watcher } = await bootUp(w, 'A');
    fs.writeFileSync(w.T.carplay.killed, w.svc.carplay.run + '\n');
    w.svc.carplay.alive.clear();
    Object.assign(w.svc.carplay, { pid: 0, state: 'failed', result: 'signal' });
    assert.strictEqual((await tick(watcher)).action, 'watch', 'patchd\'s kill is not a crash');
    w.svc.carplay.starts();
    w.svc.carplay.crashes();
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'crash');
});

test('a SIGKILL that was not patchd\'s: no crash, started again where recmgr loaded the entry', async () => {
    for (const recmgr of [true, false]) {
        const w = makeWorld({ recmgr });
        w.install('carplay', 'proven');
        const { watcher } = await bootUp(w, 'A');
        w.svc.carplay.ends('2', '9');
        w.now.advance(5000);
        assert.strictEqual((await tick(watcher)).action, 'killed');
        w.now.advance(5000);
        assert.strictEqual((await tick(watcher)).action, recmgr ? 'started' : 'watch');
        assert.strictEqual(w.state('carplay').arm.crashes, 0);
    }
});

test('no crash: patchd\'s kill, a death while the system stops, a SIGTERM, a clean exit or stop', async () => {
    for (const how of ['patchd', 'stopping', 'sigterm', 'exit', 'stopped']) {
        const w = makeWorld({ recmgr: true });
        w.install('carplay', 'proven');
        const { watcher } = await bootUp(w, 'A');
        if (how === 'patchd') fs.writeFileSync(w.T.carplay.killed, w.svc.carplay.run + '\n');
        if (how === 'stopping') { w.system = 'stopping'; w.svc.carplay.crashes(); }
        else if (how === 'sigterm') w.svc.carplay.ends('2', '15');
        else if (how === 'exit') w.svc.carplay.ends('1', '0');
        else if (how === 'stopped') w.svc.carplay.ends('', '');
        else w.svc.carplay.ends('2', '9');
        w.now.advance(5000);
        assert.strictEqual((await tick(watcher)).action, 'watch', how);
        w.system = 'running';
        for (let i = 0; i < 3; i++) { w.now.advance(60000); await tick(watcher); }
        assert.strictEqual(starts(w, 'carplay'), 1, how);
        assert.strictEqual(w.state('carplay').arm.crashes, 0, how);
    }
});

test('recmgr loaded carplay: starts are bounded per boot, and none while patchd holds the lock or the system stops', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'original');
    const { watcher } = await bootUp(w, 'A');
    w.svc.carplay.crashes();
    w.now.advance(5000);
    await tick(watcher);
    w.now.advance(5000);
    w.lockHeld = true;
    assert.strictEqual((await tick(watcher)).action, 'watch', 'waits for patchd');
    w.lockHeld = false;
    w.system = 'stopping';
    assert.strictEqual((await tick(watcher)).action, 'start-skipped');
    w.system = 'running';
    w.svc.carplay.starts();   /* by hand */
    for (let i = 0; i < 5; i++) {
        w.svc.carplay.crashes();
        w.now.advance(5000);
        await tick(watcher);
        w.now.advance(60000);
        await tick(watcher);
        w.now.advance(5000);
        await tick(watcher);
    }
    assert.strictEqual(starts(w, 'carplay'), 2 + 3, 'three starts of its own');
});

test('an unwritable state file restores a patch at its first crash, and does not lift the start limit', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'proven');
    const { watcher } = await bootUp(w, 'A');
    fs.mkdirSync(w.T.carplay.state + '.tmp');
    w.svc.carplay.crashes();
    w.now.advance(5000);
    const r = await tick(watcher);
    assert.deepStrictEqual([r.fails, r.restore], [1, 'restored'], 'below the threshold, since the count is not kept');
    for (let i = 0; i < 5; i++) {
        w.now.advance(60000);
        await tick(watcher);
        w.svc.carplay.crashes();
        w.now.advance(5000);
        await tick(watcher);
    }
    assert.strictEqual(starts(w, 'carplay'), 1 + 3);
});

test('a crash the watcher sees once var-opt-ro made /var/opt read-only restores nothing; the next boot counts it', async () => {
    for (const armed of [true, false]) {
        const w = makeWorld({ recmgr: true });
        w.install('carplay', 'proven');
        const { watcher } = armed ? await bootUp(w, 'A') : { watcher: w.recovery('carplay', 'A') };
        if (!armed) { w.svc.carplay.starts(); await tick(watcher); }
        const open = fs.openSync;
        fs.openSync = function (p, flags) {
            if (String(p).indexOf(w.T.carplay.state) === 0 && flags === 'w') { const e = new Error('EROFS: read-only file system, open \'' + p + '\''); e.code = 'EROFS'; throw e; }
            return open.apply(fs, arguments);
        };
        try {
            w.svc.carplay.crashes();
            w.now.advance(5000);
            assert.strictEqual((await tick(watcher)).restore, undefined, 'armed ' + armed);
        } finally { fs.openSync = open; }
        assert.strictEqual(w.holds('carplay'), 'patched', 'armed ' + armed);
        nsmShutdown(w, 'A', shown(w), true);
        await bootUp(w, 'B');
        assert.strictEqual(w.state('carplay').fails, armed ? 1 : 0, 'armed ' + armed + ': counted from the shutdown mark when this boot was armed');
    }
});

test('a dying PID systemd has not reaped yet is no crash', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    await startBoot(w.recovery('carplay', 'A'));
    w.svc.carplay.starts();
    const watcher = w.recovery('carplay', 'A');
    await tick(watcher);
    w.svc.carplay.alive.clear();   /* gone from /proc, systemd still says active */
    assert.strictEqual((await tick(watcher)).action, 'watch');
    assert.strictEqual(w.state('carplay').arm.crashes, 0);
});

test('systemctl is asked every 60 s while the service\'s main PID is in /proc, every 5 s while it is down', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    let probes = 0;
    const watcher = w.recovery('carplay', 'A', { probe: (cb) => { probes++; cb(Object.assign({}, w.svc.carplay)); } });
    await startBoot(watcher);
    w.svc.carplay.starts();
    for (let i = 0; i < 120; i++) { await tick(watcher); w.now.advance(1000); }
    assert.strictEqual(probes, 2, 'carplay up');
    w.svc.carplay.crashes();
    probes = 0;
    assert.strictEqual((await tick(watcher)).action, 'crash', 'its PID gone: a crash seen at the next tick');
    assert.strictEqual(probes, 1);
    w.svc.carplay.ends('', '');
    probes = 0;
    for (let i = 0; i < 10; i++) { w.now.advance(1000); await tick(watcher); }
    assert.strictEqual(probes, 2, 'carplay down');
    w.svc.carplay.starts();
    probes = 0;
    for (let i = 0; i < 5; i++) { w.now.advance(1000); await tick(watcher); }
    assert.strictEqual(probes, 1, 'a new run found within 5 s');
});

test('the state is read for a run\'s healthy minute until it is settled, then not again in that run', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    let loads = 0, failSave = true;
    const watcher = w.recovery('carplay', 'A');
    const load = watcher._load, save = watcher._save;
    watcher._load = function () { loads++; return load.call(this); };
    watcher._save = function (st) { return failSave && st.arm && st.arm.confirmed ? false : save.call(this, st); };
    await startBoot(watcher);
    w.svc.carplay.starts();
    await tick(watcher);
    w.now.advance(61000);
    assert.strictEqual((await tick(watcher)).action, 'confirmed', 'the confirmation could not be saved');
    w.now.advance(1000);
    assert.strictEqual((await tick(watcher)).action, 'confirmed', 'so the next tick confirms again');
    failSave = false;
    w.now.advance(1000);
    assert.strictEqual((await tick(watcher)).action, 'confirmed');
    assert.strictEqual(w.state('carplay').arm.confirmed, true);
    loads = 0;
    for (let i = 0; i < 30; i++) { w.now.advance(1000); await tick(watcher); }
    assert.strictEqual(loads, 0, 'saved: no more reads this run');
    w.svc.carplay.crashes();
    await tick(watcher);
    w.svc.carplay.starts();
    w.now.advance(5000);
    await tick(watcher);
    w.now.advance(61000);
    loads = 0;
    await tick(watcher);
    assert(loads > 0, 'the next run reads it again at its healthy minute');

    const none = makeWorld();
    none.install('carplay', 'none');
    const idle = none.recovery('carplay', 'A');
    let idleLoads = 0;
    const idleLoad = idle._load;
    idle._load = function () { idleLoads++; return idleLoad.call(this); };
    await startBoot(idle);
    none.svc.carplay.starts();
    await tick(idle);
    none.now.advance(61000);
    idleLoads = 0;
    for (let i = 0; i < 30; i++) { await tick(idle); none.now.advance(1000); }
    assert.strictEqual(idleLoads, 1, 'nothing armed: read once');
});

test('a stop during a restore waits for it', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'proven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    let finishRestore = null;
    const watcher = w.recovery('carplay', 'A', { restore: (f, cb) => { finishRestore = cb; } });
    await startBoot(watcher);
    w.svc.carplay.starts();
    await tick(watcher);
    w.svc.carplay.crashes();
    w.now.advance(5000);
    watcher.tick();
    assert.strictEqual(watcher.restoring, true);
    let stopped = false;
    watcher.whenRestored(() => { stopped = true; });
    assert.strictEqual(stopped, false);
    finishRestore(null, 'restored');
    assert.strictEqual(stopped, true);
});

test('a save that fails leaves the previous state whole; a folder that cannot be synced is a saved state', () => {
    const w = makeWorld();
    const before = JSON.stringify({ fails: 1, unknown: 0, arm: { boot: 'A', patch: 'proven', crashes: 1, confirmed: false, clean: false } }) + '\n';
    fs.writeFileSync(w.T.carplay.state, before);
    fs.mkdirSync(w.T.carplay.state + '.tmp');
    assert.strictEqual(w.recovery('carplay', 'B')._save({ fails: 0, arm: null }), false);
    assert.strictEqual(fs.readFileSync(w.T.carplay.state, 'utf8'), before);
    fs.rmdirSync(w.T.carplay.state + '.tmp');
    fs.chmodSync(path.dirname(w.T.carplay.state), 0o300);
    try { assert.strictEqual(w.recovery('carplay', 'B')._save({ fails: 2, arm: null }), true); } finally { fs.chmodSync(path.dirname(w.T.carplay.state), 0o700); }
    assert.strictEqual(w.state('carplay').fails, 2);
});

test('the clock is monotonic: the default timer reads process.hrtime', () => {
    const w = makeWorld();
    const rec = new Recovery({ target: w.T.carplay, bootId: 'A' });
    const real = process.hrtime();
    assert(Math.abs(rec._now() - (real[0] * 1000 + real[1] / 1e6)) < 1000);
});

test('the system counts as stopping while shutdown.target is queued or active, also before the boot finished', () => {
    const w = makeWorld();
    const sc = path.join(w.dir, 'sc');
    /* show prints shutdown.target's block, and var-opt-ro.service's when asked for it */
    const state = (target, running, varOptRo) => {
        fs.writeFileSync(sc, '#!/bin/sh\ncase "$1" in show) printf "' + target + '\\n"; case "$*" in *var-opt-ro.service*) printf "\\n' + (varOptRo || 'ActiveState=inactive\\nJob=') +
            '\\n" ;; esac ;; is-system-running) echo ' + running + ' ;; esac\n', { mode: 0o755 });
        return cp.execFileSync(process.execPath, ['-e', 'require(process.argv[1]).realSystemState(function (s) { process.stdout.write(s); })', RECOVERY_PATH],
            { env: Object.assign({}, process.env, { WOC_SYSTEMCTL: sc }), encoding: 'utf8' });
    };
    assert.strictEqual(state('ActiveState=inactive\\nJob=', 'starting'), 'starting');
    assert.strictEqual(state('ActiveState=inactive\\nJob=', 'running'), 'running');
    assert.strictEqual(state('ActiveState=inactive\\nJob=1234', 'starting'), 'stopping', 'a reboot asked for before the boot finished');
    assert.strictEqual(state('ActiveState=active\\nJob=', 'stopping'), 'stopping');
    assert.strictEqual(state('ActiveState=inactive\\nJob=', 'running', 'ActiveState=activating\\nJob=88'), 'stopping', 'an NSM shutdown: var-opt-ro.service starting');
    assert.strictEqual(state('ActiveState=inactive\\nJob=', 'running', 'ActiveState=inactive\\nJob=91'), 'stopping', 'an NSM shutdown: var-opt-ro.service queued');
});

test('a crash the watcher sees once this boot\'s shutdown mark is written (an NSM shutdown under way) never counts', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'proven');
    const { watcher } = await bootUp(w, 'A');
    fs.writeFileSync(w.T.carplay.mark, 'A running up 30\n');   /* shutdown_mark.sh ran */
    w.svc.carplay.crashes();
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'watch');
    assert.strictEqual(w.state('carplay').arm.crashes, 0);
    await bootUp(w, 'B');
    assert.strictEqual(w.state('carplay').fails, 0, 'a switch-off');
});

/* ---- shutdown_mark.sh ---- */

function runMark(show, opts) {
    opts = opts || {};
    const dir = fs.mkdtempSync(path.join(ROOT, 'mark-'));
    fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-X\n');
    fs.writeFileSync(path.join(dir, 'uptime'), (opts.uptime || '125.50') + ' 300.00\n');
    fs.writeFileSync(path.join(dir, 'stat'), 'cpu 1 2 3\nbtime ' + Math.floor(Date.now() / 1000 - parseFloat(opts.uptime || '125.50')) + '\n');
    const sc = path.join(dir, 'systemctl');
    fs.writeFileSync(sc, '#!/bin/sh\n' + (show === null ? 'exit 1\n' : show === 'hang' ? 'exec sleep 30\n' : 'printf "%s\\n" "' + show.join('" "') + '"\n'), { mode: 0o755 });
    const state = path.join(dir, 'state');
    if (!opts.noDir) fs.mkdirSync(state);
    const sin = path.join(dir, 'sin');
    fs.mkdirSync(path.join(sin, 'recmgr'), { recursive: true });
    fs.mkdirSync(path.join(sin, 'crashhandler'), { recursive: true });
    (opts.info || []).forEach((i) => {
        const f = path.join(sin, i.who, 'restartInfo.xml');
        fs.writeFileSync(f, '<x/>');
        if (i.ageS) { const t = Date.now() / 1000 - i.ageS; fs.utimesSync(f, t, t); }
    });
    const t0 = Date.now();
    const r = cp.spawnSync('sh', [MARK_SH], { env: Object.assign({}, process.env, { WOC_STATE_DIR: state, WOC_BOOT_ID: path.join(dir, 'boot_id'),
        WOC_SYSTEMCTL: sc, WOC_MARK_WAIT: '1', WOC_SIN_DIR: sin, WOC_UPTIME: path.join(dir, 'uptime'), WOC_PROC_STAT: path.join(dir, 'stat') }) });
    const read = (f) => { try { return fs.readFileSync(path.join(state, f), 'utf8'); } catch (e) { return null; } };
    if (opts.ms) opts.ms.v = Date.now() - t0;
    return { status: r.status, mark: read('shutdown'), aa: read('shutdown-aapd') };
}

test('shutdown_mark.sh records running, failed or stopped, and nothing it cannot read', () => {
    const up = ['ActiveState=active', 'Result=success'];
    assert.deepStrictEqual(runMark(up), { status: 0, mark: 'boot-X running up 125\n', aa: 'boot-X running up 125\n' });
    assert.strictEqual(runMark(['ActiveState=failed', 'Result=core-dump']).mark, 'boot-X failed up 125\n');
    assert.strictEqual(runMark(['ActiveState=deactivating', 'Result=watchdog']).mark, 'boot-X failed up 125\n');
    assert.strictEqual(runMark(['ActiveState=inactive', 'Result=success']).mark, 'boot-X stopped up 125\n');
    assert.strictEqual(runMark(['ActiveState=inactive', 'Result=success', 'ExecMainStartTimestampMonotonic=99']).mark, 'boot-X stopped ran up 125\n', 'started, then stopped');
    assert.strictEqual(runMark(['ActiveState=inactive', 'Result=success', 'ExecMainStartTimestampMonotonic=0']).mark, 'boot-X stopped up 125\n', 'never started');
    assert.deepStrictEqual(runMark(null), { status: 0, mark: null, aa: null });
    assert.deepStrictEqual(runMark(up, { noDir: true }), { status: 0, mark: null, aa: null });
    const ms = {};
    assert.strictEqual(runMark('hang', { ms }).mark, null, 'a hung systemctl writes nothing');
    assert(ms.v < 5000, 'and holds the remount up WAIT seconds at most: ' + ms.v);
});

test('shutdown_mark.sh adds crash for a restart recmgr or crashhandler asked for this boot, not for an older record', () => {
    const up = ['ActiveState=active', 'Result=success'];
    for (const who of ['recmgr', 'crashhandler']) {
        assert.deepStrictEqual(runMark(up, { info: [{ who }] }), { status: 0, mark: 'boot-X running crash up 125\n', aa: 'boot-X running crash up 125\n' }, who);
        assert.strictEqual(runMark(up, { info: [{ who, ageS: 200 }], uptime: '125.50' }).mark, 'boot-X running up 125\n', who + ': from before this boot');
        assert.strictEqual(runMark(up, { info: [{ who, ageS: 100 }], uptime: '125.50' }).mark, 'boot-X running crash up 125\n', who + ': from this boot');
        assert.strictEqual(runMark(up, { info: [{ who, ageS: -60 }], uptime: '125.50' }).mark, 'boot-X running up 125\n', who + ': from the future');
    }
    assert.strictEqual(runMark(['ActiveState=failed', 'Result=core-dump'], { info: [{ who: 'crashhandler' }] }).mark, 'boot-X failed crash up 125\n');
});

/* ---- the boot step as the unit runs it ---- */

function runBootStep(w, name, bootId, env) {
    fs.writeFileSync(path.join(w.dir, 'boot_id'), bootId + '\n');
    const t0 = Date.now();
    const r = cp.spawnSync(process.execPath, [RECOVERY_PATH, 'boot', name], {
        env: Object.assign({}, process.env, { WOC_CARPLAY: w.T.carplay.target, WOC_AAPD: w.T.aapd.target, WOC_AAPD_CONF: w.T.aapd.files[1],
            WOC_RECOVERY_STATE: w.T.carplay.state, WOC_PATCH_SOCK: path.join(w.dir, 'shm', 'patch.sock'), WOC_BOOT_ID: path.join(w.dir, 'boot_id') }, env || {}),
        encoding: 'utf8', timeout: 60000,
    });
    r.ms = Date.now() - t0;
    r.own = Number((/ in (\d+) ms,/.exec(r.stdout) || [])[1]);
    return r;
}

test('the boot step decides from stat and small files: an unreadable binary is armed or left alone, in milliseconds', () => {
    for (const kind of ['unproven', 'original', 'none']) {
        const w = makeWorld();
        w.install('carplay', kind);
        fs.chmodSync(w.T.carplay.target, 0o000);   /* reading it would fail */
        try {
            const r = runBootStep(w, 'carplay', 'A');
            assert.strictEqual(r.status, 0, r.stdout + r.stderr);
            assert(new RegExp('carplay boot check: ' + (kind === 'unproven' ? 'armed \\(unproven patch, 0 failed\\)' : 'idle')).test(r.stdout), kind + ': ' + r.stdout);
            assert(r.own < 100, kind + ': its own work took ' + r.own + ' ms');
            console.log(`     (${kind}: boot step ${r.ms} ms in all, ${r.own} ms after node started)`);
        } finally { fs.chmodSync(w.T.carplay.target, 0o755); }
    }
});

test('the boot step exits 0 whatever fails, so the service\'s start goes ahead', () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 5, unknown: 0, arm: { boot: 'old', crashes: 1 } }));
    const noMount = path.join(w.dir, 'no-mount');
    for (const env of [{ WOC_RECOVERY_STATE: path.join(w.T.carplay.target, 'nested.json'), WOC_MOUNT: noMount }, { WOC_MOUNT: noMount }]) {
        const r = runBootStep(w, 'carplay', 'B', env);
        assert.strictEqual(r.status, 0, JSON.stringify(env) + ': ' + r.stdout + r.stderr);
        assert(/boot check: restore-failed/.test(r.stdout), r.stdout);
        assert(r.ms < 10000);
    }
    assert.strictEqual(runBootStep(w, 'nothing', 'B').status, 1, 'an unknown service fails (G2-2)');
});

test('a boot step out of time puts / back read-only and releases the lock before it exits', () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    const mounts = path.join(w.dir, 'mounts'), lockFile = path.join(w.dir, 'remount.lock');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    /* remount,rw takes / read-write, then hangs past its kill (SIGTERM ignored) */
    fs.writeFileSync(path.join(w.dir, 'mount'), '#!' + process.execPath + '\nvar fs = require("fs"), rw = process.argv.indexOf("remount,rw") > 0;\n' +
        'fs.writeFileSync(' + JSON.stringify(mounts) + ', "/dev/root / ext4 " + (rw ? "rw" : "ro") + " 0 0\\n");\n' +
        'if (rw) { process.on("SIGTERM", function () {}); setTimeout(function () {}, 30000); }\n', { mode: 0o755 });
    /* run once first: macOS checks a new executable at its first start, which can outlast a 400 ms step */
    cp.execFileSync(path.join(w.dir, 'mount'), ['first']);
    const t0 = Date.now();
    const r = runBootStep(w, 'carplay', 'B', { WOC_RECOVERY_STEP_MS: '400', WOC_MOUNT: path.join(w.dir, 'mount'), WOC_PROC_MOUNTS: mounts, WOC_REMOUNT_LOCK: lockFile });
    const bound = 400 + 400 * 3 + 500 + 200 + 400 + 500;
    assert(/out of time/.test(r.stdout), r.stdout + r.stderr);
    assert(Date.now() - t0 < bound + 3000, 'exited by its bound: ' + (Date.now() - t0));
    assert(/\bro\b/.test(fs.readFileSync(mounts, 'utf8')), '/ read-only again');
    assert(!fs.existsSync(lockFile), 'the remount lock released');
});

test('G2-1: a read-write remount that would finish after the boot step gave up is killed: / stays read-only, nothing written, lock released', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    const mounts = path.join(w.dir, 'mounts'), lockFile = path.join(w.dir, 'remount.lock');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    /* remount,rw takes / read-write, ignores SIGTERM, and takes / read-write again and exits 0 at 3 s:
     * after the boot step's bound (2.3 s at a 400 ms step) and after the abandon remount,ro reported ro. */
    const put = 'fs.writeFileSync(' + JSON.stringify(mounts) + ', "/dev/root / ext4 " + (rw ? "rw" : "ro") + " 0 0\\n");\n';
    fs.writeFileSync(path.join(w.dir, 'mount'), '#!' + process.execPath + '\nvar fs = require("fs"), rw = process.argv.indexOf("remount,rw") > 0;\n' + put +
        'if (rw) { process.on("SIGTERM", function () {}); setTimeout(function () {' + put + ' process.exit(0); }, 3000); }\n', { mode: 0o755 });
    cp.execFileSync(path.join(w.dir, 'mount'), ['first']);
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    const before = fs.readFileSync(w.T.carplay.target);
    const r = runBootStep(w, 'carplay', 'B', { WOC_RECOVERY_STEP_MS: '400', WOC_MOUNT: path.join(w.dir, 'mount'), WOC_PROC_MOUNTS: mounts, WOC_REMOUNT_LOCK: lockFile });
    assert(/out of time/.test(r.stdout), r.stdout + r.stderr);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    await new Promise((res) => setTimeout(res, 2000));   /* the old remount would have finished by now */
    assert(/\bro\b/.test(fs.readFileSync(mounts, 'utf8')), '/ still read-only after the old remount\'s time: ' + r.stdout);
    assert(fs.readFileSync(w.T.carplay.target).equals(before), 'nothing written');
    assert(!fs.existsSync(lockFile), 'the remount lock released');
});

test('a backup without its record: restored when it is the proven build\'s shipped file, refused otherwise', () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.unlinkSync(w.T.carplay.target + '.woc-orig.json');
    let err = null;
    const synthetic = new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); })).then(() => {
        assert(err && /no record/.test(err.message), 'a build of no table: ' + err);
    });
    if (!fs.existsSync(CARPLAY_BIN) || !fs.existsSync(AAPD_BIN) || !fs.existsSync(AAPD_CONF)) { console.log('     (the proven builds skipped: CARPLAY_BIN, AAPD_BIN, AAPD_CONF not set)'); return synthetic; }
    const x = makeWorld(), tgt = x.T.carplay.target;
    fs.copyFileSync(CARPLAY_BIN, tgt);
    cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'apply', '--panel', 'high', '--yes', '--target', tgt], { stdio: 'ignore' });
    fs.unlinkSync(tgt + '.woc-orig.json');
    aapdPatcher(x)(['apply', '--dpi', '170', '--yes']);
    fs.unlinkSync(x.T.aapd.target + '.woc-orig.json');
    fs.unlinkSync(x.T.aapd.files[1] + '.woc-orig.json');
    const outcome = (t) => new Promise((res) => recovery.restoreTarget(t, true, 1, (e, o) => res(e ? e.message : o)));
    return synthetic.then(() => outcome(x.T.carplay)).then((o) => {
        assert.strictEqual(o, 'restored', 'carplay 22.28.3');
        assert(fs.readFileSync(tgt).equals(fs.readFileSync(CARPLAY_BIN)));
        return outcome(x.T.aapd);
    }).then((o) => {
        assert.strictEqual(o, 'restored', 'aapd 22.39.3');
        assert(fs.readFileSync(x.T.aapd.target).equals(fs.readFileSync(AAPD_BIN)) && fs.readFileSync(x.T.aapd.files[1]).equals(fs.readFileSync(AAPD_CONF)));
    });
});

test('a carplay backup whose record names another build-id is refused (the patcher\'s own check)', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: CARPLAY_BIN not set)'); return; }
    const w = makeWorld(), tgt = w.T.carplay.target;
    fs.copyFileSync(CARPLAY_BIN, tgt);
    cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'apply', '--panel', 'high', '--yes', '--target', tgt], { stdio: 'ignore' });
    const meta = JSON.parse(fs.readFileSync(tgt + '.woc-orig.json', 'utf8'));
    meta.buildId = '00' + meta.buildId.slice(2);
    fs.writeFileSync(tgt + '.woc-orig.json', JSON.stringify(meta));
    let err = null;
    return new Promise((res) => recovery.restoreTarget(w.T.carplay, true, 1, (e) => { err = e; res(); })).then(() => {
        assert(err && /build-id/.test(err.message), String(err));
    });
});

test('the units: before their service, never blocking it, timeouts covering the bound, whitelisted', () => {
    for (const [file, svc] of [['waze-on-cluster-boot.service', 'carplay'], ['waze-on-cluster-aa-boot.service', 'aapd']]) {
        const unit = fs.readFileSync(path.join(PATCH, '..', 'systemd', file), 'utf8');
        const val = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(unit) || [])[1];
        assert.strictEqual(val('Before'), svc + '.service');
        assert(!/^(Requires|BindsTo|Requisite|RequiredBy)=/m.test(unit), svc + ' does not depend on it');
        assert.strictEqual(val('Type'), 'oneshot');
        assert.strictEqual(val('ExecStart'), '-/usr/bin/node /var/opt/waze-on-cluster/current/recovery.js boot ' + svc);
        assert(parseInt(val('TimeoutStartSec'), 10) * 1000 > recovery.BOOT_EXIT_MS + 5000, 'the step exits by its bound, inside the start timeout');
        assert(parseInt(val('TimeoutStopSec'), 10) * 1000 > recovery.BOOT_EXIT_MS, 'a stop mid-restore lets it finish');
    }
    const watcher = fs.readFileSync(path.join(PATCH, '..', 'systemd', 'waze-on-cluster-recovery.service'), 'utf8');
    assert(parseInt(/^TimeoutStopSec=(\d+)/m.exec(watcher)[1], 10) * 1000 > RESTORE_BOUND_MS);
    const c = JSON.parse(fs.readFileSync(path.join(PATCH, '..', 'component.json'), 'utf8'));
    ['waze-on-cluster-boot', 'waze-on-cluster-aa-boot', 'waze-on-cluster-recovery'].forEach((n) => assert(c.recmgr.includes(n), n));
    assert(!c.restart.some((u) => /boot/.test(u)), 'they run at boot, not at install');
    assert(c.dropins.some((d) => d.unit === 'var-opt-ro.service') && c.dropins.some((d) => d.unit === 'carplay.service'));
    ['shutdown_mark.sh', 'recmgr_list.js', 'patch_record.js', 'remount_lock.js'].forEach((f) => assert(c.files.some((x) => x.path === f), f));
});

/* ---- the patchers' record, and the real binaries ---- */

/* A copy of a carplay build with another build-id: outside the proven list. */
function unprovenCarplay(buf) {
    const out = Buffer.from(buf), id = require('../carplay_locate.js').buildId(buf), at = out.indexOf(Buffer.from(id, 'hex'));
    assert(at > 0, 'the build-id note');
    out[at] ^= 0xff;
    return out;
}

test('the carplay patcher records each write: proven, unproven, reverted, a missing record repaired, dropped with the backup', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: CARPLAY_BIN not set)'); return; }
    const w = makeWorld();
    const tgt = w.T.carplay.target, patcher = (args) => cp.execFileSync(process.execPath, [CARPLAY_PATCH].concat(args, ['--target', tgt]), { encoding: 'utf8' });
    fs.copyFileSync(CARPLAY_BIN, tgt);
    patcher(['apply', '--panel', 'high', '--yes']);
    assert.deepStrictEqual([record.current(tgt).patched, record.current(tgt).proven], [true, true]);
    patcher(['revert', '--yes']);
    assert.deepStrictEqual([record.current(tgt).patched, record.current(tgt).by], [false, undefined]);
    patcher(['apply', '--panel', 'high', '--yes']);
    record.remove(tgt);
    assert(/nothing to do/.test(patcher(['apply', '--panel', 'high', '--yes'])));
    assert.strictEqual(record.current(tgt).patched, true, 'repaired by an apply with nothing to write');
    patcher(['revert', '--yes', '--drop-backup']);
    assert(!fs.existsSync(record.recordPath(tgt)), 'dropped with the backup');
    fs.writeFileSync(tgt, unprovenCarplay(fs.readFileSync(CARPLAY_BIN)));
    patcher(['apply', '--panel', 'high', '--unproven', '--yes']);
    assert.deepStrictEqual([record.current(tgt).patched, record.current(tgt).proven], [true, false]);
});

/* The aapd patcher on copies of aapd and aapd.conf in w, with a coding of
 * KI_KOMBI_VARIANT 7 and room on the disk. */
function aapdPatcher(w) {
    const coding = path.join(w.dir, 'coding'), c = Buffer.alloc(0x1030);
    c[0x28] = 0x09;
    c[0x2c + 0x75a] = 7 << 1;
    fs.writeFileSync(coding, c);
    fs.writeFileSync(path.join(w.dir, 'df'), '#!/bin/sh\necho "F 1 2 99999999 1% /"\n', { mode: 0o755 });
    fs.copyFileSync(AAPD_BIN, w.T.aapd.target);
    fs.copyFileSync(AAPD_CONF, w.T.aapd.files[1]);
    return (args) => cp.execFileSync(process.execPath, [AAPD_PATCH].concat(args, ['--target', w.T.aapd.target, '--conf', w.T.aapd.files[1], '--coding', coding]),
        { encoding: 'utf8', env: Object.assign({}, process.env, { WOC_DF: path.join(w.dir, 'df') }) });
}

test('the aapd patcher records each write (only its proven build), and a revert', () => {
    if (!fs.existsSync(AAPD_BIN) || !fs.existsSync(AAPD_CONF)) { console.log('     (skipped: AAPD_BIN, AAPD_CONF not set)'); return; }
    const w = makeWorld();
    const patcher = aapdPatcher(w);
    patcher(['apply', '--yes']);
    assert.deepStrictEqual([record.current(w.T.aapd.target).patched, record.current(w.T.aapd.target).proven], [true, true]);
    patcher(['revert', '--yes']);
    assert.strictEqual(record.current(w.T.aapd.target).patched, false);
});

test('the real boot step restores a patched carplay copy and aapd copy in about a second, byte for byte, / read-only', () => {
    if (!fs.existsSync(CARPLAY_BIN) || !fs.existsSync(AAPD_BIN) || !fs.existsSync(AAPD_CONF)) { console.log('     (skipped: CARPLAY_BIN, AAPD_BIN, AAPD_CONF not set)'); return; }
    const w = makeWorld();
    const cpt = w.T.carplay.target;
    fs.writeFileSync(cpt, unprovenCarplay(fs.readFileSync(CARPLAY_BIN)));
    fs.chmodSync(cpt, 0o755);
    const unpatched = fs.readFileSync(cpt);
    cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'apply', '--panel', 'high', '--unproven', '--yes', '--target', cpt], { stdio: 'ignore' });
    aapdPatcher(w)(['apply', '--dpi', '170', '--yes']);
    assert(!fs.readFileSync(w.T.aapd.target).equals(fs.readFileSync(AAPD_BIN)) && !fs.readFileSync(w.T.aapd.files[1]).equals(fs.readFileSync(AAPD_CONF)), 'both patched');

    const armed = runBootStep(w, 'carplay', 'A');
    assert(/carplay boot check: armed \(unproven patch, 0 failed\)/.test(armed.stdout), armed.stdout);
    END.crashAtStart(w, 'A', 'carplay');
    const r = runBootStep(w, 'carplay', 'B');
    assert(/carplay boot check: restored/.test(r.stdout), r.stdout + r.stderr);
    assert(fs.readFileSync(cpt).equals(unpatched), 'the original, byte for byte');
    assert(ro());
    console.log(`     (carplay restore: boot step ${r.ms} ms in all, ${r.own} ms after node started)`);
    assert(r.own < 2000, r.stdout);

    fs.writeFileSync(w.T.aapd.state, JSON.stringify({ fails: 2, unknown: 0, arm: null }));
    const a = runBootStep(w, 'aapd', 'B');
    assert(/aapd boot check: restored/.test(a.stdout), a.stdout + a.stderr);
    assert(fs.readFileSync(w.T.aapd.target).equals(fs.readFileSync(AAPD_BIN)) && fs.readFileSync(w.T.aapd.files[1]).equals(fs.readFileSync(AAPD_CONF)));
    console.log(`     (aapd restore: boot step ${a.ms} ms in all, ${a.own} ms after node started)`);
    assert(a.own < 2000, a.stdout);
});

test('the boot step restores what an older release patched where the locator now refuses a site', () => {
    if (!fs.existsSync(CARPLAY_BIN) || sha(fs.readFileSync(CARPLAY_BIN)) !== 'ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50') {
        console.log('     (skipped: carplay 22.28.3 not found)'); return;
    }
    require('./carplay_mutations.js')(fs.readFileSync(CARPLAY_BIN)).oldRelease().forEach((f) => {
        const w = makeWorld();
        fs.writeFileSync(w.T.carplay.target, f.patched);
        fs.chmodSync(w.T.carplay.target, 0o755);
        backup(w.T.carplay.target, f.original);
        fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: { boot: 'A', patch: 'unknown', crashes: 1 } }));
        const r = runBootStep(w, 'carplay', 'B');
        assert(/carplay boot check: restored/.test(r.stdout), f.name + ': ' + r.stdout + r.stderr);
        assert(fs.readFileSync(w.T.carplay.target).equals(f.original), f.name + ': the original');
        assert(ro(), f.name);
    });
});

test('a service systemd started in that boot ran, even when it died before the watcher looked: a crash restart counts', async () => {
    const w = makeWorld();
    w.install('aapd', 'proven');
    await startBoot(w.recovery('aapd', 'A'));   /* armed; aapd starts, is SIGKILLed, recmgr restarts the unit */
    nsmShutdown(w, 'A', { carplay: 'running', aapd: 'killed' }, true);
    assert(/^A stopped crash ran up \d+\n$/.test(fs.readFileSync(w.T.aapd.mark, 'utf8')), fs.readFileSync(w.T.aapd.mark, 'utf8'));
    await startBoot(w.recovery('aapd', 'B'));
    assert.strictEqual(w.state('aapd').fails, 1);
});

/* ---- a head unit that refuses our parts ---- */

test('a refused head unit: a patch of ours is restored before its service starts, whatever the count, no patcher run', async () => {
    for (const [name, kind] of [['carplay', 'unproven'], ['carplay', 'proven'], ['carplay', 'unknown'], ['aapd', 'proven']]) {
        const w = makeWorld();
        w.install(name, kind);
        fs.writeFileSync(w.T[name].state, JSON.stringify({ fails: 0, unknown: 0, arm: { boot: 'A', at: Date.now(), patch: kind, crashes: 0, ran: true, confirmed: true, clean: false } }));
        headUnit.set(headUnit.NONE);
        try {
            const { steps } = await bootUp(w, 'B', [name]);
            assert.strictEqual(steps[name].action, 'restored', name + ' ' + kind);
        } finally { headUnit.set(headUnit.HIGH); }
        assert(w.logs.some((l) => l === headUnit.REFUSED + '; restoring the original ' + name), w.logs.join('\n'));
        assert.deepStrictEqual(w.events.slice(-1), [name + '-start:original'], 'restored before it starts');
        assert.deepStrictEqual([w.state(name).fails, w.state(name).arm], [0, null], 'nothing armed');
        assert.strictEqual(record.current(w.T[name].target).by, 'refused', 'not a restore after errors');
    }
});

test('a refused head unit: the original, no backup or an untrusted backup leave the binary and / alone; a deferred restore keeps the count', async () => {
    for (const how of ['original', 'none', 'untrusted']) {
        const w = makeWorld();
        w.install('carplay', how === 'untrusted' ? 'unproven' : how);
        if (how === 'untrusted') fs.writeFileSync(w.T.carplay.target + '.woc-orig.json', JSON.stringify({ sha256_original: '0'.repeat(64) }));
        const before = fs.readFileSync(w.T.carplay.target);
        fs.writeFileSync(MOUNT_LOG, '');
        headUnit.set(headUnit.NONE);
        let r;
        try { r = await startBoot(w.recovery('carplay', 'B', { restore: (f, cb) => recovery.restoreTarget(w.T.carplay, true, f, cb, 1000) })); } finally { headUnit.set(headUnit.HIGH); }
        assert.strictEqual(r.action, how === 'untrusted' ? 'restore-failed' : 'idle', how);
        assert(fs.readFileSync(w.T.carplay.target).equals(before), how + ': the binary as it was');
        assert.strictEqual(fs.readFileSync(MOUNT_LOG, 'utf8'), '', how + ': no remount');
    }
    const lock = require('../remount_lock.js');
    const w = makeWorld();
    w.install('carplay', 'proven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    assert(lock.tryAcquire());
    headUnit.set(headUnit.NONE);
    try {
        const r = await startBoot(w.recovery('carplay', 'B', { restore: (f, cb) => recovery.restoreTarget(w.T.carplay, true, f, cb) }));
        assert.deepStrictEqual([r.action, w.state('carplay').fails], ['restore-failed', 1]);
    } finally { headUnit.set(headUnit.HIGH); lock.release(); }
});

test('a refused head unit: aapd original but aapd.conf still patched is restored too', async () => {
    const w = makeWorld();
    w.install('aapd', 'original');
    fs.writeFileSync(w.T.aapd.files[1], CONF.patched);
    headUnit.set(headUnit.NONE);
    let r;
    try { r = await startBoot(w.recovery('aapd', 'B', { restore: (f, cb) => recovery.restoreTarget(w.T.aapd, true, f, cb, 1000) })); } finally { headUnit.set(headUnit.HIGH); }
    assert.strictEqual(r.action, 'restored');
    assert(fs.readFileSync(w.T.aapd.files[1]).equals(CONF.original));
    assert(ro());
});

test('the boot step restores a patched carplay on a unit whose variant it cannot read and leaves it armed on HIGH, HIGH F and MID', () => {
    for (const [unit, restored] of [[headUnit.NONE, true], [headUnit.HIGH, false], [headUnit.HIGHF, false], [headUnit.MID, false]]) {
        const w = makeWorld();
        w.install('carplay', 'unproven');
        headUnit.set(unit);
        let r;
        try { r = runBootStep(w, 'carplay', 'B'); } finally { headUnit.set(headUnit.HIGH); }
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        if (restored) {
            assert(r.stdout.indexOf(headUnit.REFUSED + '; restoring the original carplay') >= 0 && /boot check: restored/.test(r.stdout), r.stdout);
            assert.strictEqual(w.holds('carplay'), 'original');
            assert(ro());
        } else {
            assert(/boot check: armed/.test(r.stdout), r.stdout);
            assert.strictEqual(w.holds('carplay'), 'patched');
        }
    }
});

/* ---- the remount lock and the watcher service ---- */

/* Kiro test change (S2): upstream broke ANY lock older than STALE_MS, whatever
 * its holder; the lock now goes only with its holder (pid gone), after HUNG_MS
 * for a live one, or after STALE_MS when it names no pid. Cases ported from the
 * 0.7.10 fork, plus EPERM (a holder we may not signal is alive), the timeout
 * of acquire and release by the holder only. */
test('remount lock: mutual exclusion; broken only when its holder is gone (or holds no pid and is old)', () => {
    const lockPath = path.join(ROOT, 'stale.lock');
    const env = { WOC_REMOUNT_LOCK: process.env.WOC_REMOUNT_LOCK, WOC_REMOUNT_LOCK_STALE_MS: process.env.WOC_REMOUNT_LOCK_STALE_MS,
        WOC_REMOUNT_LOCK_HUNG_MS: process.env.WOC_REMOUNT_LOCK_HUNG_MS };
    process.env.WOC_REMOUNT_LOCK = lockPath;
    process.env.WOC_REMOUNT_LOCK_STALE_MS = '50';
    delete process.env.WOC_REMOUNT_LOCK_HUNG_MS;   /* the default, 10 min */
    const key = require.resolve('../remount_lock.js'), cached = require.cache[key];
    delete require.cache[key];
    const realKill = process.kill;
    try {
        const lock = require('../remount_lock.js');
        assert.strictEqual(lock.tryAcquire(), true, 'first acquire');
        assert.strictEqual(lock.tryAcquire(), false, 'held: second acquire fails');
        lock.release();
        assert.strictEqual(lock.tryAcquire(), true, 'reacquire after release');

        /* An old lock whose holder still runs (this process) is kept, however
         * old: a holder that works longer than expected is never cut short. */
        const old = Date.now() / 1000 - 10;
        fs.utimesSync(lockPath, old, old);
        assert.strictEqual(lock.tryAcquire(), false, 'an old lock held by a live pid is not broken');
        assert.strictEqual(fs.readFileSync(lockPath, 'utf8').split(' ')[0], String(process.pid), 'the holder keeps it');

        /* ...up to HUNG_MS (10 min): a live holder past it is taken as hung and
         * its lock broken, so recovery is not kept out until the next boot. */
        const hung = Date.now() / 1000 - 11 * 60;
        fs.utimesSync(lockPath, hung, hung);
        assert.strictEqual(lock.tryAcquire(), true, 'a lock held by a live pid for over 10 min is broken and retaken');
        lock.release();
        assert.strictEqual(lock.tryAcquire(), true, 'reacquire after the hung lock');
        lock.release();

        /* A lock whose holder is gone is broken at once, whatever its age. */
        const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
        fs.writeFileSync(lockPath, dead.stdout + ' 2026-01-01T00:00:00.000Z\n');
        assert.strictEqual(lock.tryAcquire(), true, 'a lock of a pid that is gone is broken and retaken');
        assert.strictEqual(fs.readFileSync(lockPath, 'utf8').split(' ')[0], String(process.pid));
        lock.release();

        /* A holder we may not signal (EPERM) exists: its lock is kept; only ESRCH means gone. */
        fs.writeFileSync(lockPath, '4242 someone\n');
        fs.utimesSync(lockPath, old, old);
        process.kill = (pid, sig) => { if (pid === 4242) { const e = new Error('not permitted'); e.code = 'EPERM'; throw e; } return realKill.call(process, pid, sig); };
        assert.strictEqual(lock.tryAcquire(), false, 'a lock whose holder answers EPERM is alive and kept');
        process.kill = (pid, sig) => { if (pid === 4242) { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; } return realKill.call(process, pid, sig); };
        assert.strictEqual(lock.tryAcquire(), true, 'the same lock once the pid is gone (ESRCH) is broken');
        process.kill = realKill;
        lock.release();

        /* Another holder's lock is not released by us. */
        fs.writeFileSync(lockPath, '999999 someone\n');
        lock.release();
        assert(fs.existsSync(lockPath), 'another holder\'s lock is not released');
        fs.unlinkSync(lockPath);

        /* No pid in it: broken only once older than STALE_MS. */
        fs.writeFileSync(lockPath, '');
        assert.strictEqual(lock.tryAcquire(), false, 'a fresh lock with no pid yet is kept');
        fs.utimesSync(lockPath, old, old);
        assert.strictEqual(lock.tryAcquire(), true, 'an old lock with no pid is broken');
        lock.release();
        fs.writeFileSync(lockPath, 'not-a-pid text\n');
        fs.utimesSync(lockPath, old, old);
        assert.strictEqual(lock.tryAcquire(), true, 'an old lock with garbage for a pid is broken');
        lock.release();
    } finally {
        process.kill = realKill;
        try { fs.unlinkSync(lockPath); } catch (e) {}
        require.cache[key] = cached;
        Object.keys(env).forEach((k) => { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
    }
});

test('remount lock: acquire waits for a live holder up to its timeout, then gives up without breaking the lock; the HUNG_MS override applies', async () => {
    const lockPath = path.join(ROOT, 'wait.lock');
    const env = { WOC_REMOUNT_LOCK: process.env.WOC_REMOUNT_LOCK, WOC_REMOUNT_LOCK_STALE_MS: process.env.WOC_REMOUNT_LOCK_STALE_MS,
        WOC_REMOUNT_LOCK_HUNG_MS: process.env.WOC_REMOUNT_LOCK_HUNG_MS };
    process.env.WOC_REMOUNT_LOCK = lockPath;
    process.env.WOC_REMOUNT_LOCK_STALE_MS = '50';
    process.env.WOC_REMOUNT_LOCK_HUNG_MS = '8000';
    const key = require.resolve('../remount_lock.js'), cached = require.cache[key];
    delete require.cache[key];
    try {
        const lock = require('../remount_lock.js');
        const holder = cp.spawn(process.execPath, ['-e', 'setTimeout(function () {}, 20000)'], { stdio: 'ignore' });
        try {
            fs.writeFileSync(lockPath, holder.pid + ' 2026-01-01T00:00:00.000Z\n');
            const old = Date.now() / 1000 - 5;   /* older than STALE_MS, younger than the HUNG_MS override */
            fs.utimesSync(lockPath, old, old);
            const t0 = Date.now();
            const got = await new Promise((r) => lock.acquire(350, r));
            assert.strictEqual(got, false, 'a live holder is waited for, not overtaken');
            assert(Date.now() - t0 >= 300, 'it waited for its timeout');
            assert.strictEqual(fs.readFileSync(lockPath, 'utf8').split(' ')[0], String(holder.pid), 'the holder still has the lock');
            const hung = Date.now() / 1000 - 9;   /* older than the override */
            fs.utimesSync(lockPath, hung, hung);
            assert.strictEqual(await new Promise((r) => lock.acquire(350, r)), true, 'past the HUNG_MS override a live holder is taken as hung');
            lock.release();
        } finally { holder.kill('SIGKILL'); }
    } finally {
        try { fs.unlinkSync(lockPath); } catch (e) {}
        require.cache[key] = cached;
        Object.keys(env).forEach((k) => { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
    }
});

/* Review finding F2: two waiters that read the same dead lock must not both break it. */
test('remount lock: a second waiter that read the same dead lock does not break the first waiter\'s new lock; breakers are serialised', () => {
    const lockPath = path.join(ROOT, 'race.lock');
    const env = { WOC_REMOUNT_LOCK: process.env.WOC_REMOUNT_LOCK, WOC_REMOUNT_LOCK_STALE_MS: process.env.WOC_REMOUNT_LOCK_STALE_MS,
        WOC_REMOUNT_LOCK_HUNG_MS: process.env.WOC_REMOUNT_LOCK_HUNG_MS };
    process.env.WOC_REMOUNT_LOCK = lockPath;
    process.env.WOC_REMOUNT_LOCK_STALE_MS = '50';
    delete process.env.WOC_REMOUNT_LOCK_HUNG_MS;
    const key = require.resolve('../remount_lock.js'), cached = require.cache[key];
    delete require.cache[key];
    try {
        const lock = require('../remount_lock.js');
        const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
        const deadText = dead.stdout + ' 2026-01-01T00:00:00.000Z\n';

        /* Waiter B read the dead lock; waiter A broke it and took its own; B now tries to break what it read. */
        fs.writeFileSync(lockPath, deadText);
        assert.strictEqual(lock.tryAcquire(), true, 'A breaks the dead lock and takes it');
        assert.strictEqual(lock.breakDead(deadText), false, 'B must not break A\'s new lock');
        assert.strictEqual(fs.readFileSync(lockPath, 'utf8').split(' ')[0], String(process.pid), 'A still holds it');
        assert(!fs.existsSync(lockPath + '.break'), 'the breaker guard is removed after a refused break');
        lock.release();

        /* The guard of a breaker at work keeps a second breaker out; a guard left by a dead breaker goes once old. */
        fs.writeFileSync(lockPath, deadText);
        fs.writeFileSync(lockPath + '.break', '');
        assert.strictEqual(lock.breakDead(deadText), false, 'a breaker at work is waited for');
        assert(fs.existsSync(lockPath), 'the dead lock is left alone meanwhile');
        const oldGuard = Date.now() / 1000 - 60;
        fs.utimesSync(lockPath + '.break', oldGuard, oldGuard);
        assert.strictEqual(lock.breakDead(deadText), false, 'the stale guard is cleared by this call, the break is retried by the caller');
        assert(!fs.existsSync(lockPath + '.break'), 'a stale guard is removed');
        assert.strictEqual(lock.tryAcquire(), true, 'the next attempt breaks the dead lock');
        lock.release();
        assert(!fs.existsSync(lockPath + '.break'), 'no guard left behind');
    } finally {
        try { fs.unlinkSync(lockPath); } catch (e) {}
        try { fs.unlinkSync(lockPath + '.break'); } catch (e) {}
        require.cache[key] = cached;
        Object.keys(env).forEach((k) => { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
    }
});

test('the watcher service stays up without a patch to watch, and stops on SIGTERM', async () => {
    const w = makeWorld();
    w.install('carplay', 'none');
    fs.writeFileSync(path.join(w.dir, 'boot_id'), 'boot-idle\n');
    const calls = path.join(w.dir, 'calls'), sc = path.join(w.dir, 'sc');
    fs.writeFileSync(sc, '#!/bin/sh\necho "$*" >> "' + calls + '"\n', { mode: 0o755 });
    const child = cp.spawn(process.execPath, [RECOVERY_PATH], {
        env: Object.assign({}, process.env, { WOC_CARPLAY: w.T.carplay.target, WOC_AAPD: w.T.aapd.target, WOC_RECOVERY_STATE: w.T.carplay.state,
            WOC_BOOT_ID: path.join(w.dir, 'boot_id'), WOC_SYSTEMCTL: sc, WOC_RECOVERY_TICK_MS: '50' }),
        stdio: 'ignore',
    });
    try {
        let exit = null;
        const exited = new Promise((r) => child.on('exit', (code, signal) => { exit = { code, signal }; r(); }));
        const probed = () => fs.existsSync(calls) && /^show carplay\.service/m.test(fs.readFileSync(calls, 'utf8'));
        for (let t = Date.now(); !probed() && exit === null && Date.now() - t < 3000;) await new Promise((r) => setTimeout(r, 20));
        assert(probed(), 'the first tick ran: ' + JSON.stringify(exit));
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(exit, null, 'still running after its ticks');
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
        assert(exit && exit.code === 0, 'a SIGTERM ends it cleanly: ' + JSON.stringify(exit));
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

/* ---- the failed mark (Kiro test build, S4) ---- */

const failedReason = recovery.failedReason;
const readState = (p) => readJson(p);
const BOOT_RESTORE = (w, n) => ({ restore: (fails, cb) => recovery.restoreTarget(w.T[n], true, fails, cb, 1000) });

/* A new inode under the target's name, as a hand restore or a firmware
 * update leaves it: the patch record no longer describes the file. */
function replaceFile(file, buf) {
    fs.writeFileSync(file + '.new', buf, { mode: 0o755 });
    fs.renameSync(file + '.new', file);
}

/* A patched carplay (kind) whose backup is unusable (how: 'bytes' = the
 * bytes no longer match the record, 'gone' = no backup at all), through boot
 * A (armed) and a crash at its start. */
async function crashedWithoutBackup(w, kind, how) {
    w.install('carplay', kind);
    if (how === 'bytes') fs.appendFileSync(w.T.carplay.target + '.woc-orig', 'x');
    else { fs.unlinkSync(w.T.carplay.target + '.woc-orig'); fs.unlinkSync(w.T.carplay.target + '.woc-orig.json'); }
    const a = await startBoot(w.recovery('carplay', 'A'));
    assert.strictEqual(a.action, 'armed', how + ': ' + JSON.stringify(a));
    w.svc.carplay.starts();
    END.crashAtStart(w, 'A', 'carplay');
}

test('patched, crashing, and no usable backup: marked failed, logged loudly, and patchd can report it', async () => {
    for (const how of ['bytes', 'gone']) {
        const w = makeWorld();
        await crashedWithoutBackup(w, 'unproven', how);
        assert.strictEqual(failedReason(w.T.carplay.state), '', how + ': not failed before the threshold');
        fs.writeFileSync(MOUNT_LOG, '');
        const r = await startBoot(w.recovery('carplay', 'B', BOOT_RESTORE(w, 'carplay')));
        assert.deepStrictEqual([r.action, r.failed], ['restore-failed', true], how + ': ' + JSON.stringify(r));
        const st = w.state('carplay');
        assert(st.failed && st.failed.boot === 'B' && st.failed.fails === 1 && /backup/.test(st.failed.why) && st.failed.since, how + ': ' + JSON.stringify(st));
        assert.strictEqual(st.fails, 1, how + ': the counter is kept');
        assert(w.logs.some((l) => /^ERROR: carplay is marked FAILED/.test(l) && /by hand/.test(l)), how + ': ' + w.logs.join('\n'));
        const reason = failedReason(w.T.carplay.state);
        assert(/crashed 1 times/.test(reason) && /by hand/.test(reason) && /not started again/.test(reason) && !/\u2014/.test(reason), reason);
        assert.strictEqual(w.holds('carplay'), 'patched', how + ': the binary is left as it is');
        assert.strictEqual(fs.readFileSync(MOUNT_LOG, 'utf8'), '', how + ': / never remounted');
        /* Every later boot logs it again and keeps the mark. */
        END.crashAtStart(w, 'B', 'carplay');
        const c = await startBoot(w.recovery('carplay', 'C', BOOT_RESTORE(w, 'carplay')));
        assert.strictEqual(c.action, 'restore-failed', how);
        assert.strictEqual(w.state('carplay').failed.boot, 'B', how + ': since its first boot');
    }
    assert.strictEqual(failedReason(path.join(ROOT, 'no-such-state.json')), '', 'no state: not failed');
    const bad = path.join(ROOT, 'bad-state.json');
    fs.writeFileSync(bad, '{oops');
    assert.strictEqual(failedReason(bad), '', 'an unreadable state: not failed');
});

test('a backup that is merely locked or a remount that fails is no failed mark: a later try may succeed', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    await startBoot(w.recovery('carplay', 'A'));
    END.crashAtStart(w, 'A', 'carplay');
    const r = await startBoot(w.recovery('carplay', 'B', { restore: (fails, cb) => cb(new Error('the remount lock is held')) }));
    assert.strictEqual(r.action, 'restore-failed');
    assert(!r.failed && !w.state('carplay').failed, JSON.stringify(w.state('carplay')));
    assert.strictEqual(failedReason(w.T.carplay.state), '');
});

test('aapd is never marked failed: only carplay has the mark', async () => {
    const w = makeWorld();
    w.install('aapd', 'unproven');
    fs.appendFileSync(w.T.aapd.target + '.woc-orig', 'x');
    await startBoot(w.recovery('aapd', 'A'));
    END.crashAtStart(w, 'A', 'aapd');
    const r = await startBoot(w.recovery('aapd', 'B', BOOT_RESTORE(w, 'aapd')));
    assert.strictEqual(r.action, 'restore-failed');
    assert(!r.failed && !w.state('aapd').failed, JSON.stringify(w.state('aapd')));
});

test('marked failed: no start after a crash, but a SIGKILL patchd did not send still restarts carplay, bounded', async () => {
    const w = makeWorld({ recmgr: true });
    await crashedWithoutBackup(w, 'unproven', 'bytes');
    const { step, watcher } = await bootUp(w, 'B');
    assert.deepStrictEqual([step.action, step.failed], ['restore-failed', true]);
    w.events.length = 0;
    w.logs.length = 0;
    w.svc.carplay.crashes();
    w.now.advance(5000);
    const c = await tick(watcher);
    assert.strictEqual(c.action, 'crash', JSON.stringify(c));
    for (let i = 0; i < 4; i++) { w.now.advance(61000); await tick(watcher); }
    assert.strictEqual(starts(w, 'carplay'), 0, 'a carplay that crashes while patched, with nothing to restore it, is not started by this tool');
    assert(w.logs.some((l) => /stays down: its patch is marked failed/.test(l)), w.logs.join('\n'));
    assert(w.state('carplay').failed, 'still marked');
    /* Started by hand, then SIGKILLed by something that is not patchd. */
    w.svc.carplay.starts();
    w.events.length = 0;
    w.now.advance(5000);
    await tick(watcher);
    w.svc.carplay.ends('2', '9');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'killed');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'started', 'the kill was no crash of the patch');
    assert.strictEqual(starts(w, 'carplay'), 1);
    assert(w.logs.some((l) => /killed while its patch is marked failed/.test(l)), w.logs.join('\n'));
    assert(w.state('carplay').failed, 'still marked after the restart');
    /* Bounded: the same kill again and again stops after START_DELAYS_MS. */
    for (let i = 0; i < 6; i++) {
        w.svc.carplay.ends('2', '9');
        w.now.advance(5000);
        await tick(watcher);
        w.now.advance(61000);
        await tick(watcher);
    }
    assert(starts(w, 'carplay') <= 3, 'starts this boot: ' + starts(w, 'carplay'));
    assert(w.logs.some((l) => /stays down: started \d+ times this boot already/.test(l)), w.logs.join('\n'));
});

test('the mark is process-wide even when the state file cannot be written, and says so', async () => {
    const w = makeWorld({ recmgr: true });
    await crashedWithoutBackup(w, 'unproven', 'bytes');
    fs.mkdirSync(w.T.carplay.state + '.tmp');   /* a save fails */
    const rec = w.recovery('carplay', 'B', BOOT_RESTORE(w, 'carplay'));
    const r = await startBoot(rec);
    assert.strictEqual(r.action, 'restore-failed');
    assert(w.logs.some((l) => /could not persist the failed mark/.test(l)), w.logs.join('\n'));
    w.svc.carplay.starts();
    w.events.length = 0;
    await tick(rec);
    w.svc.carplay.crashes();
    w.now.advance(5000);
    await tick(rec);
    for (let i = 0; i < 3; i++) { w.now.advance(61000); await tick(rec); }
    assert.strictEqual(starts(w, 'carplay'), 0, 'held in memory: no start after the crash');
});

test('the failed mark clears: stock again, a verified backup restores, carplay ran healthy, the backup and record are gone', async () => {
    /* Restored by hand (a new file the record no longer describes). */
    const w = makeWorld();
    await crashedWithoutBackup(w, 'unproven', 'bytes');
    assert.strictEqual((await startBoot(w.recovery('carplay', 'B', BOOT_RESTORE(w, 'carplay')))).action, 'restore-failed');
    assert(w.state('carplay').failed);
    assert.notStrictEqual(failedReason(w.T.carplay.state), '');
    replaceFile(w.T.carplay.target, w.bin.carplay.original);
    /* patchd reports it only while the binary is not the original: the state still holds the mark here. */
    assert(w.state('carplay').failed, 'the mark is still in the file until the next boot step');
    assert.strictEqual((await startBoot(w.recovery('carplay', 'C'))).action, 'idle');
    assert.strictEqual(w.state('carplay').failed, null);
    assert.strictEqual(failedReason(w.T.carplay.state), '');
    assert.deepStrictEqual([w.state('carplay').fails, w.state('carplay').arm], [0, null]);

    /* The backup repaired by hand: the next boot step restores and the mark goes. */
    const v = makeWorld();
    await crashedWithoutBackup(v, 'unproven', 'bytes');
    await startBoot(v.recovery('carplay', 'B', BOOT_RESTORE(v, 'carplay')));
    assert(v.state('carplay').failed);
    fs.writeFileSync(v.T.carplay.target + '.woc-orig', v.bin.carplay.original, { mode: 0o600 });
    END.crashAtStart(v, 'B', 'carplay');
    assert.strictEqual((await startBoot(v.recovery('carplay', 'C', BOOT_RESTORE(v, 'carplay')))).action, 'restored');
    assert.strictEqual(v.state('carplay').failed, null);
    assert.strictEqual(v.holds('carplay'), 'original');

    /* A boot in which carplay ran healthy brings the count below the threshold. */
    const u = makeWorld();
    u.install('carplay', 'proven');
    fs.appendFileSync(u.T.carplay.target + '.woc-orig', 'x');
    fs.writeFileSync(u.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: { boot: 'A', crashes: 0, clean: true },
        failed: { since: 'x', boot: 'A', fails: 2, why: 'backup' } }));
    assert.strictEqual(failedReason(u.T.carplay.state) !== '', true);
    const r = await startBoot(u.recovery('carplay', 'B'));
    assert.strictEqual(r.action, 'armed', JSON.stringify(r));
    assert.strictEqual(u.state('carplay').failed, null);

    /* Our backup and record gone, binary replaced: nothing of ours, nothing failed. */
    const n = makeWorld();
    n.install('carplay', 'none');
    fs.writeFileSync(n.T.carplay.state, JSON.stringify({ fails: 3, unknown: 0, arm: null, failed: { boot: 'A', fails: 3, since: 'x', why: '' } }));
    assert.strictEqual((await startBoot(n.recovery('carplay', 'B'))).action, 'idle');
    assert.strictEqual(n.state('carplay').failed, null);
    assert.strictEqual(n.state('carplay').fails, 0);
});

test('the state file with the failed mark is still written atomically: the previous state stays whole when a save fails', async () => {
    const w = makeWorld();
    await crashedWithoutBackup(w, 'unproven', 'bytes');
    await startBoot(w.recovery('carplay', 'B', BOOT_RESTORE(w, 'carplay')));
    const before = fs.readFileSync(w.T.carplay.state, 'utf8');
    assert(JSON.parse(before).failed);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(w.T.carplay.state)).filter((f) => /\.tmp$/.test(f)), [], 'no temporary file left');
    fs.mkdirSync(w.T.carplay.state + '.tmp');
    await startBoot(w.recovery('carplay', 'C', BOOT_RESTORE(w, 'carplay')));
    assert.strictEqual(fs.readFileSync(w.T.carplay.state, 'utf8'), before, 'a failed save leaves the old file');
});

test('patchd reads the mark: status carries failed only while the binary is not the original', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'patchd.js'), 'utf8');
    assert(/failed: binary !== 'original' \? failedReason\(\) : ''/.test(src), 'status reports the mark while the binary is not original');
    assert(/if \(st\.failed\) msg\.failed = st\.failed/.test(src), 'and sends it');
});

/* ---- Android Auto off (S6): recovery leaves aapd's files alone ---- */

/* Runs fn while every fs call that names a path under any of dirs or
 * matching re is recorded; returns the paths. */
async function spyFs(match, fn) {
    const names = ['readFileSync', 'writeFileSync', 'appendFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'readlinkSync',
        'unlinkSync', 'renameSync', 'linkSync', 'chmodSync', 'chownSync', 'mkdirSync', 'accessSync', 'symlinkSync'];
    const seen = [], orig = {};
    names.forEach((n) => {
        orig[n] = fs[n];
        fs[n] = function (p) {
            if (typeof p === 'string' && match(p)) seen.push(n + ' ' + p);
            return orig[n].apply(fs, arguments);
        };
    });
    try { await fn(); } finally { names.forEach((n) => { fs[n] = orig[n]; }); }
    return seen;
}

function withAa(value, fn) {
    return async () => {
        const saved = process.env.WOC_AA_ENABLED;
        process.env.WOC_AA_ENABLED = value;
        try { await fn(); } finally { process.env.WOC_AA_ENABLED = saved; }
    };
}

test('aa_enabled = 0: the boot step, the watcher and the shutdown hook never look at aapd, its backups, state or marks', withAa('0', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'proven');
    w.install('aapd', 'proven');
    fs.writeFileSync(w.T.aapd.state, JSON.stringify({ fails: 5, unknown: 0, arm: { boot: 'A', crashes: 1 } }));
    const before = {};
    [w.T.aapd.target, w.T.aapd.files[1], w.T.aapd.target + '.woc-orig', w.T.aapd.files[1] + '.woc-orig', w.T.aapd.state].forEach((f) => {
        before[f] = fs.readFileSync(f, 'utf8') + ':' + fs.statSync(f).mtimeMs;
    });
    const aapdPath = (p) => p.indexOf('aapd') >= 0 || p.indexOf('aa-') >= 0;
    const seen = await spyFs(aapdPath, async () => {
        const rec = w.recovery('aapd', 'B', BOOT_RESTORE(w, 'aapd'));
        assert.deepStrictEqual(await startBoot(rec), { action: 'idle' });
        assert.deepStrictEqual(await tick(rec), { action: 'skip' });
        await shutdown(rec);
        /* carplay's own recovery counts nothing from aapd. */
        const cp1 = w.recovery('carplay', 'B', BOOT_RESTORE(w, 'carplay'));
        await startBoot(cp1);
        w.svc.carplay.starts();
        w.svc.carplay.crashes();
        w.now.advance(5000);
        await tick(cp1);
    });
    const aapdSeen = seen.filter((s) => /aapd|aa-boot/.test(s) && !/carplay/.test(s));
    assert.deepStrictEqual(aapdSeen, [], 'nothing under the aapd paths was touched:\n' + aapdSeen.join('\n'));
    Object.keys(before).forEach((f) => assert.strictEqual(fs.readFileSync(f, 'utf8') + ':' + fs.statSync(f).mtimeMs, before[f], f + ' unchanged'));
    assert.strictEqual(starts(w, 'aapd'), 0);
    assert(w.logs.some((l) => /aapd is off \(Android Auto is off/.test(l)), w.logs.join('\n'));
    /* The spy sees aapd's paths when Android Auto is on: the check above is no vacuous one. */
    process.env.WOC_AA_ENABLED = '1';
    const on = await spyFs(aapdPath, async () => { await startBoot(w.recovery('aapd', 'C', BOOT_RESTORE(w, 'aapd'))); });
    assert(on.length > 0, 'the spy records aapd access when it is on');
}));

test('aa_enabled = 0: carplay\'s count ignores aapd\'s state and shutdown mark', withAa('0', async () => {
    const w = makeWorld();
    w.install('carplay', 'proven');
    w.install('aapd', 'proven');
    await bootUp(w, 'A', ['carplay']);
    /* a boot that ends with aapd crashed and a restart recorded: with aapd on, it would explain carplay's count */
    fs.writeFileSync(w.T.aapd.state, JSON.stringify({ fails: 0, unknown: 0, arm: { boot: 'A', crashes: 1 } }));
    END.otherCrash(w, 'A');
    const seen = await spyFs((p) => p === w.T.aapd.state || p === w.T.aapd.mark, async () => {
        await startBoot(w.recovery('carplay', 'B'));
    });
    assert.deepStrictEqual(seen, [], seen.join('\n'));
}));

test('aa_enabled = 0: the real boot step for aapd exits 0 at once and leaves the files and / alone; the watcher does not watch aapd', withAa('0', async () => {
    const w = makeWorld();
    w.install('aapd', 'unproven');
    fs.writeFileSync(w.T.aapd.state, JSON.stringify({ fails: 9, unknown: 0, arm: { boot: 'old', crashes: 1 } }));
    const stateBefore = fs.readFileSync(w.T.aapd.state, 'utf8');
    const binBefore = fs.readFileSync(w.T.aapd.target);
    fs.writeFileSync(MOUNT_LOG, '');
    const r = runBootStep(w, 'aapd', 'B', { WOC_AA_ENABLED: '0' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert(/aapd boot check: off \(Android Auto is off/.test(r.stdout), r.stdout);
    assert.strictEqual(fs.readFileSync(MOUNT_LOG, 'utf8'), '', '/ never remounted');
    assert(fs.readFileSync(w.T.aapd.target).equals(binBefore), 'aapd untouched');
    assert.strictEqual(fs.readFileSync(w.T.aapd.state, 'utf8'), stateBefore, 'its state untouched');
    /* carplay's boot step is unaffected by the switch. */
    w.install('carplay', 'unproven');
    const c = runBootStep(w, 'carplay', 'B', { WOC_AA_ENABLED: '0' });
    assert(/carplay boot check: armed/.test(c.stdout), c.stdout);
    /* With the switch on, the same step works on aapd. */
    const on = runBootStep(w, 'aapd', 'C', { WOC_AA_ENABLED: '1' });
    assert(/aapd boot check: (armed|restore|idle)/.test(on.stdout), on.stdout);
}));

test('G2-2: aa_enabled = 0 and / read-write: the boot step for aapd still puts / back read-only before it exits 0, touching nothing of aapd\'s; an unknown service exits 1', withAa('0', async () => {
    const w = makeWorld();
    w.install('aapd', 'unproven');
    const binBefore = fs.readFileSync(w.T.aapd.target), confBefore = fs.readFileSync(w.T.aapd.files[1]);
    fs.writeFileSync(MOUNT_LOG, '');
    fs.writeFileSync(MOUNTS, '/dev/root / ext4 rw 0 0\n');
    try {
        const r = runBootStep(w, 'aapd', 'B', { WOC_AA_ENABLED: '0' });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert(/aapd boot check: off/.test(r.stdout), r.stdout);
        assert(ro(), '/ read-only when the step exited 0');
        assert(!/remount,rw/.test(fs.readFileSync(MOUNT_LOG, 'utf8')), 'never remounted read-write');
        assert(fs.readFileSync(w.T.aapd.target).equals(binBefore) && fs.readFileSync(w.T.aapd.files[1]).equals(confBefore), 'aapd and its conf untouched');
        assert.strictEqual(runBootStep(w, 'nosuch', 'B', { WOC_AA_ENABLED: '0' }).status, 1, 'an unknown service is a failure');
    } finally { fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n'); }
}));

test('G2-1: the hard deadline with a read-write remount that cannot be reaped exits 1 and keeps the guard and the lock', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.writeFileSync(w.T.carplay.state, JSON.stringify({ fails: 1, unknown: 0, arm: null }));
    const mounts = path.join(w.dir, 'mounts'), lockFile = path.join(w.dir, 'remount.lock');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    /* remount,rw hangs for 8 s ignoring SIGTERM, and the kill is switched off (WOC_TEST_NO_KILL): a mount stuck in the kernel */
    fs.writeFileSync(path.join(w.dir, 'mount'), '#!' + process.execPath + '\nvar rw = process.argv.indexOf("remount,rw") > 0;\n' +
        'if (rw) { process.on("SIGTERM", function () {}); setTimeout(function () {}, 8000); }\n', { mode: 0o755 });
    cp.execFileSync(path.join(w.dir, 'mount'), ['first']);
    const r = runBootStep(w, 'carplay', 'B', { WOC_RECOVERY_STEP_MS: '400', WOC_TEST_NO_KILL: '1', WOC_MOUNT: path.join(w.dir, 'mount'), WOC_PROC_MOUNTS: mounts, WOC_REMOUNT_LOCK: lockFile });
    assert(/out of time/.test(r.stdout), r.stdout + r.stderr);
    assert.strictEqual(r.status, 1, 'not a success: ' + r.stdout + r.stderr);
    assert(fs.existsSync(lockFile) && fs.existsSync(lockFile + '.ro-failed'), 'the lock and the guard are kept');
});

test('G2-4: the watcher\'s restore needs the running link to be the target\'s inode before it replaces the file: a link that cannot be made aborts it', async () => {
    const w = makeWorld();
    w.install('carplay', 'unproven');
    fs.mkdirSync(w.T.carplay.running);   /* the name is taken by something unlink cannot remove */
    try {
        let err = null, outcome = null;
        await new Promise((res) => recovery.restoreTarget(w.T.carplay, false, 1, (e, o) => { err = e; outcome = o; res(); }));
        assert(err && /linked as .* failed.*nothing written/.test(err.message), String(err));
        assert.strictEqual(w.holds('carplay'), 'patched', 'the target is untouched');
        assert(ro(), '/ verified read-only');
        assertLockFree();
    } finally { fs.rmdirSync(w.T.carplay.running); }
});

test('G2-3: a due start is not held back by a standing guard, and the heal retry still runs in the same tick', async () => {
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'original');
    const mount = path.join(ROOT, 'mount'), body = fs.readFileSync(mount, 'utf8');
    try {
        fs.writeFileSync(GUARD, '4242 2026-01-01T00:00:00.000Z / is read-write after a restore\n');
        fs.writeFileSync(MOUNTS, RW_LINE);
        fs.writeFileSync(mount, '#!/bin/sh\necho "$*" >> "' + MOUNT_LOG + '"\n');   /* remount,ro does nothing */
        fs.writeFileSync(MOUNT_LOG, '');
        const rec = w.recovery('carplay', 'B');
        rec._startAt = rec._now() - 1;
        const r = await tick(rec);
        assert.strictEqual(r.action, 'started', 'the due start ran');
        assert(w.events.some((e) => /^carplay-start/.test(e)), 'carplay was started: ' + w.events);
        for (let t = Date.now(); !mountCalls().length && Date.now() - t < 3000;) await new Promise((res) => setTimeout(res, 20));
        assert(mountCalls().some((c) => /remount,ro/.test(c)), 'the heal retry ran beside it: ' + mountCalls());
        assert(fs.existsSync(GUARD), 'still standing: / is read-write');
    } finally {
        fs.writeFileSync(mount, body); fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
        const lock = require('../remount_lock.js');
        lock.clearRoFailed(); lock.release();
    }
});

test('A: healRo that took the lock itself keeps it, with the guard, when remount,ro does not take', () => {
    const lock = require('../remount_lock.js');
    const lockFile = path.join(ROOT, 'remount.lock');
    try {
        fs.writeFileSync(GUARD, '4242 2026-01-01T00:00:00.000Z / is read-write after a restore\n');
        let answer = 'not called';
        lock.healRo('r', () => false, (done) => done(new Error('busy')), (why) => { answer = why; });
        assert.strictEqual(answer, 'r', 'the guard stands');
        assert.strictEqual(fs.readFileSync(lockFile, 'utf8').split(' ')[0], String(process.pid), 'the lock it took is kept');
        assert(fs.existsSync(GUARD), 'the marker stands');
    } finally { lock.clearRoFailed(); lock.release(); }
});

test('B: a live holder of the ro-failed guard is never taken as hung; a start does not release a lock kept for the guard while / is read-write', async () => {
    const lockPath = path.join(ROOT, 'guard-hung.lock');
    const env = { WOC_REMOUNT_LOCK: process.env.WOC_REMOUNT_LOCK, WOC_REMOUNT_LOCK_HUNG_MS: process.env.WOC_REMOUNT_LOCK_HUNG_MS };
    process.env.WOC_REMOUNT_LOCK = lockPath;
    process.env.WOC_REMOUNT_LOCK_HUNG_MS = '8000';
    const key = require.resolve('../remount_lock.js'), cached = require.cache[key];
    delete require.cache[key];
    try {
        const lock = require('../remount_lock.js');
        const holder = cp.spawn(process.execPath, ['-e', 'setTimeout(function () {}, 20000)'], { stdio: 'ignore' });
        try {
            fs.writeFileSync(lockPath, holder.pid + ' 2026-01-01T00:00:00.000Z\n');
            fs.writeFileSync(lockPath + '.ro-failed', holder.pid + ' 2026-01-01T00:00:00.000Z / is read-write\n');
            const hung = Date.now() / 1000 - 9;
            fs.utimesSync(lockPath, hung, hung);
            assert.strictEqual(await new Promise((r) => lock.acquire(300, r)), false, 'past HUNG_MS the guard holder keeps the lock');
            assert.strictEqual(fs.readFileSync(lockPath, 'utf8').split(' ')[0], String(holder.pid));
            /* its own guard: this process holds the lock and the reason */
            fs.unlinkSync(lockPath + '.ro-failed');
            fs.writeFileSync(lockPath, process.pid + ' 2026-01-01T00:00:00.000Z\n');
            lock.markRoFailed('test');
            fs.utimesSync(lockPath, hung, hung);
            assert.strictEqual(lock.tryAcquire(), false, 'this process\'s own guard lock is not broken');
            lock.clearRoFailed(); lock.release();
        } finally { holder.kill('SIGKILL'); }
    } finally {
        try { fs.unlinkSync(lockPath); fs.unlinkSync(lockPath + '.ro-failed'); } catch (e) {}
        require.cache[key] = cached;
        Object.keys(env).forEach((k) => { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
    }
    /* _startDue with the real lock: a guard stands (another process's marker), / is read-write */
    const w = makeWorld({ recmgr: true });
    w.install('carplay', 'original');
    const lock = require('../remount_lock.js');
    try {
        fs.writeFileSync(GUARD, '4242 2026-01-01T00:00:00.000Z / is read-write after a restore\n');
        fs.writeFileSync(MOUNTS, RW_LINE);
        const rec = w.recovery('carplay', 'B', { lock });
        rec._startAt = rec._now() - 1;
        rec._roTry = rec._now();   /* the heal retry is not due */
        const r = await tick(rec);
        assert.strictEqual(r.action, 'started');
        assert.strictEqual(fs.readFileSync(path.join(ROOT, 'remount.lock'), 'utf8').split(' ')[0], String(process.pid), 'the lock is kept: / is read-write with the guard standing');
    } finally { fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n'); lock.clearRoFailed(); lock.release(); }
});
/* TEST_ONLY=<part of a name> runs only the tests it names. */
const run = tests.filter((t) => !process.env.TEST_ONLY || t.name.indexOf(process.env.TEST_ONLY) >= 0);

async function main() {
    let failed = 0;
    try {
        for (const t of run) {
            try { await t.fn(); console.log(`ok   ${t.name}`); }
            catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err && err.stack}`); }
        }
    } finally { cp.execFileSync('rm', ['-rf', ROOT]); }
    console.log(`${run.length - failed}/${run.length} passed`);
    process.exit(failed ? 1 : 0);
}

main();
