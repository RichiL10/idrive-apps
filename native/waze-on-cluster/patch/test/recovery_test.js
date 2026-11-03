// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Host tests for boot recovery (patch/recovery.js: the boot step and the
 * watcher), shutdown_mark.sh and the shared remount lock
 * (patch/remount_lock.js). carplay.service, systemd, recmgr and the patcher
 * are faked through injected dependencies, so the logic runs with no car, no
 * root and no writes to /; the real restore runs on a copy with CARPLAY_BIN.
 *
 *   node patch/test/recovery_test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const { Recovery, tally, RESTORE_BOUND_MS, failedReason, classifyStatus } = require('../recovery.js');

const RECOVERY_PATH = path.join(__dirname, '..', 'recovery.js');
const MARK_SH = path.join(__dirname, '..', 'shutdown_mark.sh');
const CARPLAY_PATCH = path.join(__dirname, '..', 'carplay_patch.js');
const CARPLAY_BIN = process.env.CARPLAY_BIN || '';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let tmpN = 0;
function tmpState() {
    return path.join(os.tmpdir(), `woc-rec-${process.pid}-${tmpN++}.json`);
}

/* A controllable monotonic clock. */
function clock(start) {
    let t = start || 1000000;
    const fn = () => t;
    fn.advance = (ms) => { t += ms; };
    return fn;
}

/* A fake carplay.service and system around a Recovery: carplay's current run
 * (InvocationID), main PID, ActiveState and Result as systemctl show reports
 * them, the live PIDs, the system's state, the shutdown marks, the patch on
 * disk. Every effect lands in world.events in order. */
function makeWorld(opts) {
    opts = opts || {};
    const w = {
        statePath: opts.statePath || tmpState(),
        carplay: { run: '', pid: 0, state: 'inactive', result: 'success' },
        alive: new Set(),
        system: 'running',
        marks: {},
        patched: opts.patched !== false,
        restorable: opts.restorable !== false,
        backup: opts.backup !== false,
        recmgr: !!opts.recmgr,
        killed: '',
        lockHeld: false,
        events: [],
        logs: [],
        now: opts.now || clock(),
    };
    let nextPid = 100;
    w.carplayStarts = () => {
        const pid = nextPid++;
        w.carplay = { run: 'run-' + pid, pid, state: 'active', result: 'success' };
        w.alive.add(pid);
        w.events.push('carplay-start:' + (w.patched ? 'patched' : 'stock'));
        return pid;
    };
    /* The run ends; systemd keeps its InvocationID while the unit is failed. */
    w.carplayCrashes = () => {
        w.alive.delete(w.carplay.pid);
        w.carplay = { run: w.carplay.run, pid: 0, state: 'failed', result: 'core-dump' };
        w.events.push('carplay-crash');
    };
    /* The run ends as systemd reports how: a SIGKILL is a success under the
     * tool's drop-in (code 2, CLD_KILLED), as is a clean exit (code 1). */
    w.carplayEnds = (code, status) => {
        w.alive.delete(w.carplay.pid);
        w.carplay = { run: w.carplay.run, pid: 0, state: 'inactive', result: 'success', code, status };
        w.events.push('carplay-end:' + code + '/' + status);
    };
    w.recovery = (bootId, extra) => new Recovery(Object.assign({
        statePath: w.statePath,
        bootId,
        threshold: opts.threshold || 2,
        healthyMs: opts.healthyMs || 60000,
        now: w.now,
        classify: (cb) => { w.events.push('classify'); cb({ ok: true, patchActive: w.patched, restorable: w.patched && w.restorable }); },
        restore: (cb) => { w.events.push('restore'); w.patched = false; cb(null); },
        probe: (cb) => cb(Object.assign({}, w.carplay)),
        systemState: (cb) => cb(w.system),
        start: (cb) => { w.carplayStarts(); cb(null); },
        mark: (boot) => w.marks[boot] || null,
        hasBackup: () => w.backup,
        alive: (pid) => w.alive.has(pid),
        killed: () => w.killed,
        recmgrLoaded: (name) => name === 'carplay' && w.recmgr,
        lock: { tryAcquire: () => !w.lockHeld, release: () => {} },
        log: (m) => { w.logs.push(m); },
    }, extra || {}));
    return w;
}

function readState(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

const startBoot = (rec) => new Promise((resolve) => rec.startBoot(resolve));
const tick = (rec) => new Promise((resolve) => rec.tick(resolve));
const shutdown = (rec) => new Promise((resolve) => rec.onShutdown(resolve));
const starts = (w) => w.events.filter((e) => e.startsWith('carplay-start')).length;

/* One boot as the units order it: the boot step, carplay's start, the
 * watcher's own start; then the watcher sees one tick. */
async function bootUp(w, bootId) {
    const step = await startBoot(w.recovery(bootId));
    w.events.push('boot-step:' + step.action);
    w.carplayStarts();
    const watcher = w.recovery(bootId);
    await startBoot(watcher);
    await tick(watcher);
    return { step, watcher };
}

/* An orderly reboot: the system stops and the watcher gets SIGTERM. */
async function orderlyReboot(w, watcher) {
    w.system = 'stopping';
    await shutdown(watcher);
    w.system = 'running';
    w.alive.clear();
    w.carplay = { run: '', pid: 0, state: 'inactive', result: 'success' };
}

test('crash loop with orderly reboots: each crash counts despite SIGTERM, and the boot step restores before carplay starts', async () => {
    const w = makeWorld({ recmgr: false });
    for (const boot of ['A', 'B']) {
        const { watcher } = await bootUp(w, boot);
        w.carplayCrashes();
        w.now.advance(5000);
        assert.strictEqual((await tick(watcher)).action, 'crash');
        await orderlyReboot(w, watcher);
        assert.deepStrictEqual(readState(w.statePath).arm, { boot, crashes: 1, confirmed: false, clean: false },
            'persisted at once, and SIGTERM does not exempt a crashed boot');
    }
    assert(!w.events.includes('classify') && !w.events.includes('restore'), 'no in-boot restore without the entry');
    w.events.length = 0;
    const { step } = await bootUp(w, 'C');
    assert.strictEqual(step.action, 'restored');
    assert.deepStrictEqual(w.events.slice(0, 4), ['classify', 'restore', 'boot-step:restored', 'carplay-start:stock']);
});

test('crash loop the watcher never sees: the shutdown mark counts it and the boot step restores before carplay starts', async () => {
    const w = makeWorld({ recmgr: false });
    for (const boot of ['A', 'B']) {
        await bootUp(w, boot);
        w.carplayCrashes();
        w.marks[boot] = 'failed';   /* rebooted before the watcher's next tick */
        w.alive.clear();
    }
    w.events.length = 0;
    const { step } = await bootUp(w, 'C');
    assert.strictEqual(step.action, 'restored');
    assert.deepStrictEqual(w.events.slice(0, 4), ['classify', 'restore', 'boot-step:restored', 'carplay-start:stock'],
        'the restore runs before carplay starts');
});

test('a crash after a healthy minute still counts, so a late crash loops too', async () => {
    const w = makeWorld({ recmgr: false });
    for (const boot of ['A', 'B']) {
        const { watcher } = await bootUp(w, boot);
        w.now.advance(61000);
        assert.strictEqual((await tick(watcher)).action, 'confirmed');
        w.carplayCrashes();
        await tick(watcher);
        await orderlyReboot(w, watcher);
    }
    assert.strictEqual((await bootUp(w, 'C')).step.action, 'restored');
});

test('a healthy boot clears the counter', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: null }));
    const { watcher } = await bootUp(w, 'B');
    assert.strictEqual(readState(w.statePath).fails, 1);
    w.now.advance(30000);
    assert.strictEqual((await tick(watcher)).action, 'watch');
    w.now.advance(31000);
    assert.strictEqual((await tick(watcher)).action, 'confirmed');
    w.marks.B = 'running';
    await bootUp(w, 'C');
    assert.strictEqual(readState(w.statePath).fails, 0);
});

test('a switch-off without a crash keeps the counter; a boot that ended with no record adds one', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: { boot: 'A', crashes: 0, confirmed: false, clean: false } }));
    w.marks.A = 'running';
    await bootUp(w, 'B');
    assert.strictEqual(readState(w.statePath).fails, 1, 'a short trip is exempt');
    w.marks.B = 'stopped';
    await bootUp(w, 'C');
    assert.strictEqual(readState(w.statePath).fails, 1, 'carplay never started: exempt');
    const { step } = await bootUp(w, 'D');
    assert.strictEqual(step.action, 'restored', 'no mark for C: counted, restored at the threshold');
    assert.strictEqual(readState(w.statePath).fails, 0);
});

test('an orderly reboot without a crash exempts the boot; a service restart does not', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: null }));
    const { watcher } = await bootUp(w, 'A');
    await shutdown(watcher);   /* system running: a restart of the watcher */
    assert.strictEqual(readState(w.statePath).arm.clean, false);
    await orderlyReboot(w, watcher);
    assert.strictEqual(readState(w.statePath).arm.clean, true);
    await bootUp(w, 'B');
    assert.strictEqual(readState(w.statePath).fails, 1);
    assert(!w.events.includes('restore'));
});

test('no patch of ours on disk: the boot step neither classifies nor restores, and is fast', async () => {
    const w = makeWorld({ backup: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 7, arm: { boot: 'A', crashes: 3 } }));
    const t0 = Date.now();
    const r = await startBoot(w.recovery('B', { classify: () => { throw new Error('classified'); } }));
    assert.strictEqual(r.action, 'idle');
    assert(Date.now() - t0 < 100);
    assert.deepStrictEqual(readState(w.statePath), { fails: 0, arm: null, starts: null, ended: null, failed: null });
});

test('below the threshold the boot step arms without classifying', async () => {
    const w = makeWorld();
    const r = await startBoot(w.recovery('A', { classify: () => { throw new Error('classified'); } }));
    assert.strictEqual(r.action, 'armed');
    assert.deepStrictEqual(readState(w.statePath).arm, { boot: 'A', crashes: 0, confirmed: false, clean: false });
});

test('the watcher counts nothing twice and retries a restore the boot step did not finish', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: { boot: 'A', crashes: 1 } }));
    let fail = true;
    const restore = (cb) => { w.events.push('restore'); if (fail) { fail = false; cb(new Error('remount lock held; deferring')); return; } w.patched = false; cb(null); };
    assert.strictEqual((await startBoot(w.recovery('B', { restore }))).action, 'restore-failed');
    assert.strictEqual(readState(w.statePath).fails, 2);
    assert.strictEqual((await startBoot(w.recovery('B', { restore }))).action, 'restored');
    assert.deepStrictEqual(readState(w.statePath), { fails: 0, arm: null, starts: null, ended: null, failed: null });
});

test('a firmware-replaced binary at the threshold is never restored, and the counter clears', async () => {
    const w = makeWorld({ patched: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 9, arm: { boot: 'A', crashes: 1 } }));
    assert.strictEqual((await startBoot(w.recovery('B'))).action, 'idle');
    assert(!w.events.includes('restore'));
    assert.strictEqual(readState(w.statePath).fails, 0);
});

test('patched with no verified backup: not restored, flagged unavailable', async () => {
    const w = makeWorld({ restorable: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 2, arm: { boot: 'A', crashes: 1 } }));
    assert.strictEqual((await startBoot(w.recovery('B'))).action, 'restore-unavailable');
    assert(!w.events.includes('restore'));
});

test('patched with no verified backup: the tool is marked failed, says so loudly, and patchd can report it', async () => {
    const w = makeWorld({ restorable: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 2, arm: { boot: 'A', crashes: 1 } }));
    const logs = [];
    const r = await startBoot(w.recovery('B', {
        log: (l) => logs.push(l),
        classify: (cb) => cb({ ok: true, patchActive: true, restorable: false, why: 'backup sha256 mismatch' }),
    }));
    assert.strictEqual(r.action, 'restore-unavailable');
    const st = readState(w.statePath);
    assert(st.failed && st.failed.boot === 'B' && st.failed.fails === 3 && st.failed.why === 'backup sha256 mismatch', JSON.stringify(st));
    assert(st.fails === 3, 'the counter is kept, not cleared as for a stock binary');
    assert(logs.some((l) => /^ERROR: the map patch is marked FAILED/.test(l) && /backup sha256 mismatch/.test(l)), logs.join('\n'));
    const reason = failedReason(w.statePath);
    assert(/crashed 3 times/.test(reason) && /by hand/.test(reason) && !/\u2014/.test(reason), reason);
    assert.strictEqual(failedReason(tmpState()), '', 'no state: not failed');
});

test('marked failed: the watcher starts carplay no more after a crash, but still after a SIGKILL patchd did not send', async () => {
    const w = makeWorld({ recmgr: true, restorable: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 2, arm: { boot: 'A', crashes: 1 } }));
    const { step, watcher } = await bootUp(w, 'B');
    assert.strictEqual(step.action, 'restore-unavailable');
    assert.strictEqual(starts(w), 1, 'only carplay\'s own start');
    w.carplayCrashes();
    w.now.advance(5000);
    const r = await tick(watcher);
    assert.deepStrictEqual([r.action, r.restore], ['crash', 'restore-unavailable']);
    for (let i = 0; i < 4; i++) { w.now.advance(61000); await tick(watcher); }
    assert.strictEqual(starts(w), 1, 'no start of a carplay that crashes while patched and cannot be restored');
    w.carplayStarts();   /* started by hand */
    w.now.advance(5000);
    await tick(watcher);
    w.carplayEnds('2', '9');   /* a SIGKILL patchd did not send */
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'killed');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'started', 'a kill the patch did not cause still restarts carplay');
    assert.strictEqual(starts(w), 3);
    assert(w.logs.some((l) => /killed while the map patch is marked failed/.test(l)), w.logs.join('\n'));
    assert(readState(w.statePath).failed, 'still marked');
});

test('the failed mark clears once carplay is stock again, or a backup restores it, or carplay ran healthy', async () => {
    /* Restored by hand: the next classify reads stock. */
    const w = makeWorld({ restorable: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 2, arm: { boot: 'A', crashes: 1 } }));
    assert.strictEqual((await startBoot(w.recovery('B'))).action, 'restore-unavailable');
    assert(readState(w.statePath).failed);
    w.patched = false;
    assert.strictEqual((await startBoot(w.recovery('C'))).action, 'idle');
    assert.strictEqual(readState(w.statePath).failed, null);
    assert.strictEqual(readState(w.statePath).fails, 0);

    /* The backup fixed by hand: the next boot step restores, the mark goes. */
    const v = makeWorld({ restorable: false });
    fs.writeFileSync(v.statePath, JSON.stringify({ fails: 2, arm: { boot: 'A', crashes: 1 } }));
    await startBoot(v.recovery('B'));
    v.restorable = true;
    assert.strictEqual((await startBoot(v.recovery('C'))).action, 'restored');
    assert.strictEqual(readState(v.statePath).failed, null);

    /* A boot in which carplay ran healthy brings the counter below the
     * threshold: no longer failed, and starts are allowed again. */
    const u = makeWorld({ restorable: false });
    fs.writeFileSync(u.statePath, JSON.stringify({ fails: 2, arm: { boot: 'A', crashes: 0, confirmed: true },
        failed: { since: 'x', boot: 'A', fails: 2, why: '' } }));
    assert.strictEqual((await startBoot(u.recovery('B'))).action, 'armed');
    assert.strictEqual(readState(u.statePath).failed, null);

    /* Our backup gone: nothing of ours, nothing failed. */
    const n = makeWorld({ backup: false });
    fs.writeFileSync(n.statePath, JSON.stringify({ fails: 3, arm: null, failed: { boot: 'A', fails: 3 } }));
    assert.strictEqual((await startBoot(n.recovery('B'))).action, 'idle');
    assert.strictEqual(readState(n.statePath).failed, null);
});

test('the patcher\'s status: self-start without a restorable backup is our patch, not stock', () => {
    const head = 'target:    /usr/bin/carplay\nsize:      3600000\nsha256:    ab\n';
    const tail = (ss) => 'known:     yes, modified build\nproven:    yes\nvariant:   PATCHED -> IC_HIGH\n' +
        'selfstart: ' + ss + '\n';
    assert.deepStrictEqual(classifyStatus(head + 'restorable: yes\n' + tail('SELF-START (CarPlay starts the cluster stream itself)')),
        { ok: true, patchActive: true, restorable: true, why: '' });
    assert.deepStrictEqual(classifyStatus(head + 'restorable: no (backup sha256 mismatch)\n' + tail('SELF-START (CarPlay starts the cluster stream itself)')),
        { ok: true, patchActive: true, restorable: false, why: 'backup sha256 mismatch' });
    assert.deepStrictEqual(classifyStatus(head + 'restorable: no\n' + tail('ORIGINAL (waits for NavController; stream never starts)')),
        { ok: true, patchActive: false, restorable: false, why: '' }, 'stock');
    assert.deepStrictEqual(classifyStatus(head + 'restorable: no (another build: x)\nknown:     NO - not found\n'),
        { ok: true, patchActive: false, restorable: false, why: 'another build: x' }, 'a firmware update');
    assert.deepStrictEqual(classifyStatus(''), { ok: false });
});

test('an unreadable carplay state at the threshold leaves the counter', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 2, arm: null }));
    const r = await startBoot(w.recovery('B', { classify: (cb) => cb({ ok: false }) }));
    assert.strictEqual(r.action, 'unreadable');
    assert.strictEqual(readState(w.statePath).fails, 2);
});

test('a 0.7.5 arm carries over: an unconfirmed one counts, a clean or confirmed one does not', async () => {
    for (const [state, fails] of [['unconfirmed', 2], ['clean', 1], ['confirmed', 0]]) {
        const w = makeWorld();
        fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: { boot: 'A', state } }));
        await startBoot(w.recovery('B', { classify: (cb) => cb({ ok: false }) }));
        assert.strictEqual(readState(w.statePath).fails, fails, state);
    }
    assert.strictEqual(tally(1, { boot: 'A', crashes: 2 }, 'failed'), 3, 'seen crashes are not counted twice');
});

test('a 0.7.5 arm of this boot (an update mid-boot) counts the next crash as one, not a restore', async () => {
    const w = makeWorld({ recmgr: true });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 0, arm: { boot: 'A', state: 'unconfirmed' } }));
    w.carplayStarts();
    const watcher = w.recovery('A');
    await startBoot(watcher);
    await tick(watcher);
    w.carplayCrashes();
    const r = await tick(watcher);
    assert.strictEqual(r.fails, 1);
    assert.strictEqual(r.restore, undefined);
    assert.strictEqual(readState(w.statePath).arm.crashes, 1);
});

test('recmgr loaded carplay: an in-boot crash loop is restored and carplay started again, with no reboot', async () => {
    const w = makeWorld({ recmgr: true });
    const { watcher } = await bootUp(w, 'A');
    w.events.length = 0;
    w.carplayCrashes();
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).fails, 1);
    assert.strictEqual((await tick(watcher)).action, 'watch', 'the start waits its delay');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'started');
    await tick(watcher);
    w.carplayCrashes();
    w.now.advance(5000);
    const r = await tick(watcher);
    assert.strictEqual(r.restore, 'restored');
    w.now.advance(15000);
    assert.strictEqual((await tick(watcher)).action, 'started');
    assert.deepStrictEqual(w.events, ['carplay-crash', 'classify', 'carplay-start:patched',
        'carplay-crash', 'classify', 'restore', 'carplay-start:stock']);
    const st = readState(w.statePath);
    assert.deepStrictEqual([st.fails, st.arm, st.starts], [0, null, { boot: 'A', n: 2 }]);
});

test('(a) a run that crashed before the watcher\'s first probe is a crash', async () => {
    const w = makeWorld({ recmgr: true });
    await startBoot(w.recovery('A'));
    w.carplayStarts();
    w.carplayCrashes();   /* phone off, crashed at start, before the watcher looked */
    const watcher = w.recovery('A');
    await startBoot(watcher);
    assert.strictEqual((await tick(watcher)).action, 'crash');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'started');
    assert.strictEqual(readState(w.statePath).arm.crashes, 1);
});

test('(b) a run the watcher started that dies before the next tick is a crash', async () => {
    const w = makeWorld({ recmgr: true, patched: false });
    const { watcher } = await bootUp(w, 'A');
    w.carplayCrashes();
    w.now.advance(5000);
    await tick(watcher);
    w.now.advance(5000);
    w.carplayStarts = ((orig) => () => { const pid = orig(); w.carplayCrashes(); return pid; })(w.carplayStarts);
    assert.strictEqual((await tick(watcher)).action, 'started');
    assert.strictEqual((await tick(watcher)).action, 'crash', 'probed at the next tick, not PROBE_MS later');
});

test('(c) after patchd\'s activation kill, a crash of the run it started is a crash', async () => {
    const w = makeWorld({ recmgr: true });
    const { watcher } = await bootUp(w, 'A');
    w.killed = w.carplay.run;   /* patchd records the run, SIGKILLs it ... */
    w.alive.delete(w.carplay.pid);
    w.carplay = Object.assign({}, w.carplay, { pid: 0, state: 'failed', result: 'signal' });
    assert.strictEqual((await tick(watcher)).action, 'watch', 'patchd\'s kill is not a crash');
    w.carplayStarts();   /* ... and starts the next run, which crashes before the watcher looks */
    w.carplayCrashes();
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'crash');
    assert.strictEqual(readState(w.statePath).arm.crashes, 1);
});

test('a SIGKILL that was not patchd\'s: no crash, carplay started again where recmgr loaded its entry', async () => {
    for (const recmgr of [true, false]) {
        const w = makeWorld({ recmgr });
        const { watcher } = await bootUp(w, 'A');
        w.carplayEnds('2', '9');
        w.now.advance(5000);
        assert.strictEqual((await tick(watcher)).action, 'killed');
        w.now.advance(5000);
        assert.strictEqual((await tick(watcher)).action, recmgr ? 'started' : 'watch', 'recmgr ' + recmgr);
        assert.strictEqual(starts(w), recmgr ? 2 : 1, 'recmgr ' + recmgr);
        assert.strictEqual(readState(w.statePath).arm.crashes, 0, 'not a crash');
        assert(!w.events.includes('classify') && !w.events.includes('restore'));
    }
});

test('not restarted: patchd\'s kill, a SIGKILL while the system stops, a SIGTERM or a clean exit', async () => {
    for (const how of ['patchd', 'stopping', 'sigterm', 'exit']) {
        const w = makeWorld({ recmgr: true });
        const { watcher } = await bootUp(w, 'A');
        if (how === 'patchd') w.killed = w.carplay.run;
        if (how === 'stopping') w.system = 'stopping';
        if (how === 'sigterm') w.carplayEnds('2', '15');
        else if (how === 'exit') w.carplayEnds('1', '0');
        else w.carplayEnds('2', '9');
        w.now.advance(5000);
        assert.strictEqual((await tick(watcher)).action, 'watch', how);
        w.system = 'running';
        for (let i = 0; i < 3; i++) { w.now.advance(60000); await tick(watcher); }
        assert.strictEqual(starts(w), 1, how);
        assert.strictEqual(readState(w.statePath).arm.crashes, 0, how);
    }
});

test('a failed run is counted once, also across a watcher restart', async () => {
    const w = makeWorld({ recmgr: false });
    const { watcher } = await bootUp(w, 'A');
    w.carplayCrashes();
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'crash');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'watch');
    const again = w.recovery('A');
    await startBoot(again);
    assert.strictEqual((await tick(again)).action, 'watch');
    assert.strictEqual(readState(w.statePath).arm.crashes, 1);
});

test('recmgr loaded carplay: starts are bounded per boot', async () => {
    const w = makeWorld({ recmgr: true, patched: false });
    const { watcher } = await bootUp(w, 'A');
    for (let i = 0; i < 5; i++) {
        w.carplayCrashes();
        w.now.advance(5000);
        await tick(watcher);
        w.now.advance(60000);
        await tick(watcher);
        w.now.advance(5000);
        await tick(watcher);
    }
    assert.strictEqual(starts(w), 1 + 3);
});

test('an unwritable state file restores a patch at its first crash, and does not lift the start limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-ro-'));
    try {
        const w = makeWorld({ recmgr: true, statePath: path.join(dir, 'state.json') });
        const { watcher } = await bootUp(w, 'A');
        /* A directory where the save writes its temp file: no write can
         * succeed, for root too (permissions alone do not stop root). */
        fs.mkdirSync(path.join(dir, 'state.json.tmp'));
        w.carplayCrashes();
        w.now.advance(5000);
        const r = await tick(watcher);
        assert.deepStrictEqual([r.fails, r.restore], [1, 'restored'], 'below the threshold, since the count is not kept');
        for (let i = 0; i < 5; i++) {
            w.now.advance(60000);
            await tick(watcher);
            w.carplayCrashes();
            w.now.advance(5000);
            await tick(watcher);
        }
        assert.strictEqual(starts(w), 1 + 3);
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('recmgr loaded carplay: no start while patchd holds the lock, the system stops, or carplay is up again', async () => {
    const w = makeWorld({ recmgr: true, patched: false });
    const { watcher } = await bootUp(w, 'A');
    w.carplayCrashes();
    w.now.advance(5000);
    await tick(watcher);
    w.now.advance(5000);
    w.lockHeld = true;
    assert.strictEqual((await tick(watcher)).action, 'watch', 'waits for patchd');
    w.lockHeld = false;
    w.system = 'stopping';
    assert.strictEqual((await tick(watcher)).action, 'start-skipped');
    w.system = 'running';
    w.carplayStarts();
    w.carplayCrashes();
    w.now.advance(5000);
    await tick(watcher);
    w.now.advance(5000);
    w.carplayStarts();
    assert.strictEqual((await tick(watcher)).action, 'start-skipped');
    assert.strictEqual(readState(w.statePath).starts, null, 'the watcher started nothing');
});

test('recmgr did not load carplay: a crash is recorded, nothing is classified, restored or started', async () => {
    const w = makeWorld({ recmgr: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 5, arm: null }));
    const { watcher } = await bootUp(w, 'A');
    w.events.length = 0;
    w.carplayCrashes();
    w.now.advance(5000);
    await tick(watcher);
    for (let i = 0; i < 3; i++) { w.now.advance(60000); await tick(watcher); }
    assert.deepStrictEqual(w.events, ['carplay-crash']);
    assert.strictEqual(readState(w.statePath).arm.crashes, 1);
});

test('not a crash: a clean stop, or a death while the system stops', async () => {
    for (const how of ['stopped', 'stopping']) {
        const w = makeWorld({ recmgr: true });
        const { watcher } = await bootUp(w, 'A');
        w.alive.delete(w.carplay.pid);
        w.carplay = Object.assign({}, w.carplay, { pid: 0, state: how === 'stopped' ? 'inactive' : 'failed', result: how === 'stopped' ? 'success' : 'signal' });
        if (how === 'stopping') w.system = 'stopping';
        assert.strictEqual((await tick(watcher)).action, 'watch', how);
        assert.strictEqual(readState(w.statePath).arm.crashes, 0, how);
    }
});

test('a dying PID systemd has not reaped yet is not taken for a crash', async () => {
    const w = makeWorld();
    const { watcher } = await bootUp(w, 'A');
    w.alive.delete(w.carplay.pid);   /* gone from /proc, systemd still says active */
    assert.strictEqual((await tick(watcher)).action, 'watch');
    assert.strictEqual(readState(w.statePath).arm.crashes, 0);
});

test('systemctl is asked every 5 s, not every tick, with carplay up or down', async () => {
    const w = makeWorld();
    let probes = 0;
    const watcher = w.recovery('A', { probe: (cb) => { probes++; cb(Object.assign({}, w.carplay)); } });
    await startBoot(watcher);
    w.carplayStarts();
    for (let i = 0; i < 10; i++) { await tick(watcher); w.now.advance(1000); }
    assert.strictEqual(probes, 2, 'carplay up');
    w.carplayCrashes();
    w.carplay.state = 'inactive';
    w.carplay.result = 'success';
    probes = 0;
    for (let i = 0; i < 10; i++) { await tick(watcher); w.now.advance(1000); }
    assert.strictEqual(probes, 2, 'carplay down');
});

test('a stop during a restore waits for it', async () => {
    const w = makeWorld({ recmgr: true });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: null }));
    let finishRestore = null;
    const watcher = w.recovery('A', { restore: (cb) => { finishRestore = cb; } });
    await startBoot(watcher);
    w.carplayStarts();
    await tick(watcher);
    w.carplayCrashes();
    w.now.advance(5000);
    watcher.tick();
    assert.strictEqual(watcher.restoring, true);
    let stopped = false;
    watcher.whenRestored(() => { stopped = true; });
    assert.strictEqual(stopped, false);
    finishRestore(null);
    assert.strictEqual(stopped, true);
});

/* A state the recovery cannot save: its temporary file's name is taken by a
 * folder. The saved state stays readable. */
function blockSave(statePath) { fs.mkdirSync(statePath + '.tmp'); }
function unblockSave(statePath) { fs.rmdirSync(statePath + '.tmp'); }

test('a save that fails leaves the previous state whole', () => {
    const w = makeWorld();
    const before = JSON.stringify({ fails: 1, arm: { boot: 'A', crashes: 1, confirmed: false, clean: false }, starts: null, ended: null }) + '\n';
    fs.writeFileSync(w.statePath, before);
    blockSave(w.statePath);
    try {
        assert.strictEqual(w.recovery('B')._save({ fails: 0, arm: null }), false);
        assert.strictEqual(fs.readFileSync(w.statePath, 'utf8'), before);
    } finally { unblockSave(w.statePath); }
    assert.strictEqual(w.recovery('B')._save({ fails: 2, arm: null }), true);
    assert.deepStrictEqual(readState(w.statePath), { fails: 2, arm: null, starts: null, ended: null, failed: null });
    assert(!fs.existsSync(w.statePath + '.tmp'), 'no temporary file left');
});

test('a folder that cannot be synced after the rename is a saved state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-nosync-'));
    const statePath = path.join(dir, 'state.json');
    try {
        fs.chmodSync(dir, 0o300);   /* writable, but the folder cannot be opened to sync it */
        const w = makeWorld({ statePath });
        assert.strictEqual(w.recovery('A')._save({ fails: 1, arm: null }), true);
        fs.chmodSync(dir, 0o700);
        assert.deepStrictEqual(readState(statePath), { fails: 1, arm: null, starts: null, ended: null, failed: null });
    } finally { fs.chmodSync(dir, 0o700); cp.execFileSync('rm', ['-rf', dir]); }
});

test('the boot step restores a restorable patch below the threshold when it cannot save the boot\'s arm', async () => {
    const w = makeWorld();
    blockSave(w.statePath);
    try {
        const { step } = await bootUp(w, 'A');
        assert.strictEqual(step.action, 'restored');
        assert.deepStrictEqual(w.events.slice(0, 4), ['classify', 'restore', 'boot-step:restored', 'carplay-start:stock']);
    } finally { unblockSave(w.statePath); }
});

test('the boot step leaves a stock or unrestorable carplay alone when it cannot save', async () => {
    for (const opts of [{ patched: false }, { restorable: false }]) {
        const w = makeWorld(opts);
        blockSave(w.statePath);
        try {
            const r = await startBoot(w.recovery('A'));
            assert.strictEqual(r.action, opts.patched === false ? 'idle' : 'restore-unavailable', JSON.stringify(opts));
            assert(!w.events.includes('restore'), JSON.stringify(opts));
        } finally { unblockSave(w.statePath); }
    }
});

test('recmgr did not load carplay: a crash it cannot save restores at once, and starts nothing', async () => {
    const w = makeWorld({ recmgr: false });
    const { watcher } = await bootUp(w, 'A');
    w.events.length = 0;
    blockSave(w.statePath);
    try {
        w.carplayCrashes();
        w.now.advance(5000);
        const r = await tick(watcher);
        assert.deepStrictEqual([r.action, r.fails, r.restore], ['crash', 1, 'restored']);
        for (let i = 0; i < 3; i++) { w.now.advance(60000); await tick(watcher); }
        assert.deepStrictEqual(w.events, ['carplay-crash', 'classify', 'restore']);
    } finally { unblockSave(w.statePath); }
});

test('the clock is monotonic: the default timer reads process.hrtime', () => {
    const rec = new Recovery({ statePath: tmpState(), bootId: 'A' });
    const a = rec._now(), real = process.hrtime();
    assert(Math.abs(a - (real[0] * 1000 + real[1] / 1e6)) < 1000);
});

/* shutdown_mark.sh against a fake systemctl. */
function runMark(show, opts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-mark-'));
    try {
        fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-X\n');
        const sc = path.join(dir, 'systemctl');
        fs.writeFileSync(sc, '#!/bin/sh\n' + (show === null ? 'exit 1\n' : show === 'hang' ? 'exec sleep 30\n' : 'printf "%s\\n" "' + show.join('" "') + '"\n'));
        fs.chmodSync(sc, 0o755);
        const state = path.join(dir, 'state');
        if (!(opts && opts.noDir)) fs.mkdirSync(state);
        const t0 = Date.now();
        const r = cp.spawnSync('sh', [MARK_SH], { env: Object.assign({}, process.env, { WOC_STATE_DIR: state, WOC_BOOT_ID: path.join(dir, 'boot_id'), WOC_SYSTEMCTL: sc, WOC_MARK_WAIT: '1' }) });
        let mark = null;
        try { mark = fs.readFileSync(path.join(state, 'shutdown'), 'utf8'); } catch (e) {}
        if (opts && opts.ms) opts.ms.v = Date.now() - t0;
        return { status: r.status, mark };
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
}

test('shutdown_mark.sh records running, failed or stopped, and nothing it cannot read', () => {
    assert.deepStrictEqual(runMark(['ActiveState=active', 'Result=success']), { status: 0, mark: 'boot-X running\n' });
    assert.deepStrictEqual(runMark(['ActiveState=failed', 'Result=core-dump']), { status: 0, mark: 'boot-X failed\n' });
    assert.deepStrictEqual(runMark(['ActiveState=deactivating', 'Result=watchdog']), { status: 0, mark: 'boot-X failed\n' });
    assert.deepStrictEqual(runMark(['ActiveState=inactive', 'Result=success']), { status: 0, mark: 'boot-X stopped\n' });
    assert.deepStrictEqual(runMark(null), { status: 0, mark: null });
    assert.deepStrictEqual(runMark(['ActiveState=active', 'Result=success'], { noDir: true }), { status: 0, mark: null });
    const ms = {};
    assert.deepStrictEqual(runMark('hang', { ms }), { status: 0, mark: null }, 'a hung systemctl writes nothing');
    assert(ms.v < 5000, 'and holds the remount up WAIT seconds at most: ' + ms.v);
});

test('the boot step exits 0 whatever fails, so carplay\'s start goes ahead', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-bootfail-'));
    try {
        const tgt = path.join(dir, 'carplay');
        fs.writeFileSync(tgt, 'not a carplay build\n');
        fs.writeFileSync(tgt + '.woc-orig', 'x');
        fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-Z\n');
        fs.writeFileSync(path.join(dir, 'state'), '');
        const cases = [
            { WOC_RECOVERY_STATE: path.join(dir, 'state', 'nested.json') },   /* state unwritable */
            { WOC_RECOVERY_STATE: path.join(dir, 's.json'), WOC_MOUNT: path.join(dir, 'no-mount') },
        ];
        fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ fails: 5, arm: { boot: 'old', crashes: 1 } }));
        for (const env of cases) {
            const t0 = Date.now();
            const r = cp.spawnSync(process.execPath, [RECOVERY_PATH, 'boot'], {
                env: Object.assign({}, process.env, { WOC_CARPLAY: tgt, WOC_BOOT_ID: path.join(dir, 'boot_id') }, env), encoding: 'utf8', timeout: 20000,
            });
            assert.strictEqual(r.status, 0, JSON.stringify(env) + ': ' + r.stdout + r.stderr);
            assert(Date.now() - t0 < 10000);
        }
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('the boot unit orders itself before carplay, never blocks it, and is whitelisted', () => {
    const unit = fs.readFileSync(path.join(__dirname, '..', '..', 'systemd', 'waze-on-cluster-boot.service'), 'utf8');
    const val = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(unit) || [])[1];
    assert.strictEqual(val('Before'), 'carplay.service');
    assert(!/^(Requires|BindsTo|Requisite|RequiredBy)=/m.test(unit), 'carplay does not depend on it');
    assert.strictEqual(val('Type'), 'oneshot');
    assert(/^-/.test(val('ExecStart')), 'its exit status is ignored');
    const start = parseInt(val('TimeoutStartSec'), 10) * 1000, stop = parseInt(val('TimeoutStopSec'), 10) * 1000;
    assert(start > RESTORE_BOUND_MS + 5000 && start <= 120000, 'a restore always ends inside the start timeout');
    assert(stop > RESTORE_BOUND_MS, 'a stop mid-restore lets it finish');
    const watcher = fs.readFileSync(path.join(__dirname, '..', '..', 'systemd', 'waze-on-cluster-recovery.service'), 'utf8');
    assert(parseInt(/^TimeoutStopSec=(\d+)/m.exec(watcher)[1], 10) * 1000 > RESTORE_BOUND_MS);
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'component.json'), 'utf8'));
    assert(c.recmgr.includes('waze-on-cluster-boot'), 'a timed-out oneshot fails; recmgr must not reboot for it');
    assert(!c.restart.includes('waze-on-cluster-boot.service'), 'it runs at boot, not at install');
    assert(c.enable.some((e) => e.unit === 'waze-on-cluster-boot.service' && e.target === 'multi-user.target'));
    assert(c.dropins.some((d) => d.unit === 'var-opt-ro.service'));
    assert(c.files.some((f) => f.path === 'shutdown_mark.sh') && c.files.some((f) => f.path === 'recmgr_list.js'));
});

test('remount lock: mutual exclusion; broken only when its holder is gone (or holds no pid and is old)', () => {
    const lockPath = path.join(os.tmpdir(), `woc-lock-${process.pid}.lock`);
    try { fs.unlinkSync(lockPath); } catch (e) {}
    process.env.WOC_REMOUNT_LOCK = lockPath;
    process.env.WOC_REMOUNT_LOCK_STALE_MS = '50';
    delete require.cache[require.resolve('../remount_lock.js')];
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

    /* A lock whose holder is gone is broken at once, whatever its age. */
    const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(lockPath, dead.stdout + ' 2026-01-01T00:00:00.000Z\n');
    assert.strictEqual(lock.tryAcquire(), true, 'a lock of a pid that is gone is broken and retaken');
    assert.strictEqual(fs.readFileSync(lockPath, 'utf8').split(' ')[0], String(process.pid));
    lock.release();

    /* No pid in it: broken only once older than STALE_MS. */
    fs.writeFileSync(lockPath, '');
    assert.strictEqual(lock.tryAcquire(), false, 'a fresh lock with no pid yet is kept');
    fs.utimesSync(lockPath, old, old);
    assert.strictEqual(lock.tryAcquire(), true, 'an old lock with no pid is broken');
    lock.release();
    try { fs.unlinkSync(lockPath); } catch (e) {}
    delete process.env.WOC_REMOUNT_LOCK;
    delete process.env.WOC_REMOUNT_LOCK_STALE_MS;
});

/* Stage a patched carplay copy (with the verified stock backup) and a fake
 * mount, then run the real realRestore in a child with those env paths. */
function stageAndRestore(dir, mountBody, before, alwaysLink) {
    const sock = path.join(dir, 'sock');
    fs.mkdirSync(sock, { recursive: true });
    const tgt = path.join(dir, 'carplay');
    fs.copyFileSync(CARPLAY_BIN, tgt);
    cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'apply', '--panel', 'high',
        '--sink', 'udp://127.0.0.1:20557?mime_type=video/H264', '--target', tgt, '--yes'], { stdio: 'ignore' });
    const pending = path.join(sock, 'activation-pending');
    fs.writeFileSync(pending, 'pending\n');
    const mounts = path.join(dir, 'mounts');
    fs.writeFileSync(mounts, '/dev/root / ext4 rw 0 0\n');
    const mount = path.join(dir, 'mount');
    fs.writeFileSync(mount, '#!/bin/sh\n' + mountBody);
    fs.chmodSync(mount, 0o755);
    const proc = path.join(dir, 'proc');
    fs.mkdirSync(proc);
    if (before) before(tgt, proc);
    const out = cp.execFileSync(process.execPath, ['-e',
        'require(process.env.RP).realRestore(process.env.ALWAYS_LINK !== "1", function(e){process.stdout.write(JSON.stringify({err:e&&e.message}));process.exit(0);});'], {
        env: Object.assign({}, process.env, {
            RP: RECOVERY_PATH, WOC_CARPLAY: tgt, WOC_MOUNT: mount, WOC_PROC_MOUNTS: mounts,
            WOC_PATCH_SOCK: path.join(sock, 'patch.sock'), WOC_REMOUNT_LOCK: path.join(sock, 'remount.lock'), WOC_PROC: proc,
            ALWAYS_LINK: alwaysLink ? '1' : '',
        }),
        encoding: 'utf8',
    });
    return {
        err: JSON.parse(out).err,
        tgtSha: sha(fs.readFileSync(tgt)),
        mounts: fs.readFileSync(mounts, 'utf8'),
        running: fs.existsSync(tgt + '.woc-running'),
        runningIno: fs.existsSync(tgt + '.woc-running') ? fs.statSync(tgt + '.woc-running').ino : null,
        pendingGone: !fs.existsSync(pending),
    };
}

test('realRestore reverts to the verified stock and leaves / read-only', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        const stock = sha(fs.readFileSync(CARPLAY_BIN));
        const r = stageAndRestore(dir, 'case "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + path.join(dir, 'mounts') +
            '";; *remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + path.join(dir, 'mounts') + '";; esac\n');
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, stock, 'carplay restored to the verified stock');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
        assert(!r.running, 'nothing runs the patched binary: no link kept');
        assert(r.pendingGone, 'the pending-activation marker is cleared');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

const ROMOUNT = (dir) => 'case "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + path.join(dir, 'mounts') +
    '";; *remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + path.join(dir, 'mounts') + '";; esac\n';
/* A process runs file: a fake /proc/<pid>/exe holding its inode. */
function runs(proc, pid, file) { fs.mkdirSync(path.join(proc, pid)); fs.linkSync(file, path.join(proc, pid, 'exe')); }

test('realRestore keeps the patched binary carplay runs linked so / can go read-only', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let patchedIno = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt, proc) => { patchedIno = fs.statSync(tgt).ino; runs(proc, '1', tgt); });
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, sha(fs.readFileSync(CARPLAY_BIN)), 'carplay restored to the verified stock');
        assert.strictEqual(r.runningIno, patchedIno, 'the running binary is linked');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('the watcher\'s realRestore links the patched binary even with nothing running it yet', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let patchedIno = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt) => { patchedIno = fs.statSync(tgt).ino; }, true);
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, sha(fs.readFileSync(CARPLAY_BIN)), 'carplay restored to the verified stock');
        assert.strictEqual(r.runningIno, patchedIno, 'a carplay started meanwhile would run a linked file');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('realRestore keeps a .woc-running a process runs, and restores', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let held = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt, proc) => {
            fs.writeFileSync(tgt + '.woc-running', 'the binary carplay runs\n');
            held = fs.statSync(tgt + '.woc-running').ino;
            runs(proc, '1', tgt + '.woc-running');
        });
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, sha(fs.readFileSync(CARPLAY_BIN)), 'carplay restored to the verified stock');
        assert.strictEqual(r.runningIno, held, 'the link a process runs is left as it is');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('realRestore waits for the next boot while processes run both the target and the link', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let held = null, patched = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt, proc) => {
            fs.writeFileSync(tgt + '.woc-running', 'an older binary\n');
            held = fs.statSync(tgt + '.woc-running').ino;
            patched = sha(fs.readFileSync(tgt));
            runs(proc, '1', tgt + '.woc-running');
            runs(proc, '2', tgt);
        });
        assert(r.err && /deferring/.test(r.err), 'deferred: ' + r.err);
        assert.strictEqual(r.tgtSha, patched, 'carplay untouched');
        assert.strictEqual(r.runningIno, held, 'the link untouched');
        assert(/\brw\b/.test(r.mounts) && !r.pendingGone, 'no remount was made, nothing else changed');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('realRestore takes a link that is the target\'s own file as no reason to wait', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let patchedIno = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt, proc) => {
            fs.linkSync(tgt, tgt + '.woc-running');
            patchedIno = fs.statSync(tgt).ino;
            runs(proc, '1', tgt);
        });
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, sha(fs.readFileSync(CARPLAY_BIN)), 'carplay restored to the verified stock');
        assert.strictEqual(r.runningIno, patchedIno, 'the link holds the patched binary carplay runs');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

/* The boot step (recovery.js boot) at the threshold, with the real status and
 * restore, on a target stage(tgt) writes. */
function bootAtThreshold(dir, stage) {
    const tgt = path.join(dir, 'carplay');
    stage(tgt);
    const mounts = path.join(dir, 'mounts');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(path.join(dir, 'mount'), '#!/bin/sh\n' + ROMOUNT(dir));
    fs.chmodSync(path.join(dir, 'mount'), 0o755);
    fs.mkdirSync(path.join(dir, 'proc'));
    fs.mkdirSync(path.join(dir, 'sock'));
    fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-B\n');
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ fails: 1, arm: { boot: 'boot-A', crashes: 1, confirmed: false, clean: false } }));
    const r = cp.spawnSync(process.execPath, [RECOVERY_PATH, 'boot'], {
        env: Object.assign({}, process.env, {
            WOC_CARPLAY: tgt, WOC_MOUNT: path.join(dir, 'mount'), WOC_PROC_MOUNTS: mounts, WOC_PROC: path.join(dir, 'proc'),
            WOC_PATCH_SOCK: path.join(dir, 'sock', 'patch.sock'), WOC_REMOUNT_LOCK: path.join(dir, 'sock', 'remount.lock'),
            WOC_RECOVERY_STATE: state, WOC_BOOT_ID: path.join(dir, 'boot_id'),
        }),
        encoding: 'utf8',
    });
    return { r, tgt, mounts: fs.readFileSync(mounts, 'utf8'), state: readState(state) };
}

test('the boot step at the threshold restores a patched copy before carplay would start, / read-only after', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-boot-'));
    try {
        const b = bootAtThreshold(dir, (tgt) => {
            fs.copyFileSync(CARPLAY_BIN, tgt);
            cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'apply', '--panel', 'high', '--target', tgt, '--yes'], { stdio: 'ignore' });
        });
        assert.strictEqual(b.r.status, 0, b.r.stdout + b.r.stderr);
        assert(/boot check: restored/.test(b.r.stdout), b.r.stdout);
        assert.strictEqual(sha(fs.readFileSync(b.tgt)), sha(fs.readFileSync(CARPLAY_BIN)), 'carplay starts the verified stock');
        assert(/\bro\b/.test(b.mounts), '/ is read-only again');
        assert(!fs.existsSync(b.tgt + '.woc-running'), 'nothing ran it: no link');
        assert.deepStrictEqual(b.state, { fails: 0, arm: null, starts: null, ended: null, failed: null });
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('the boot step at the threshold restores what an older release patched where the locator now refuses a site', () => {
    if (!fs.existsSync(CARPLAY_BIN) || sha(fs.readFileSync(CARPLAY_BIN)) !== 'ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50') {
        console.log('     (skipped: carplay 22.28.3 not found)'); return;
    }
    const locator = require('../carplay_locate.js');
    require('./carplay_mutations.js')(fs.readFileSync(CARPLAY_BIN)).oldRelease().forEach((f) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-boot-'));
        try {
            const b = bootAtThreshold(dir, (tgt) => {
                fs.writeFileSync(tgt, f.patched, { mode: 0o755 });
                fs.writeFileSync(tgt + '.woc-orig', f.original, { mode: 0o600 });
                fs.writeFileSync(tgt + '.woc-orig.json', JSON.stringify({ buildId: locator.buildId(f.original), sha256_original: sha(f.original) }));
            });
            assert.strictEqual(b.r.status, 0, f.name + ': ' + b.r.stdout + b.r.stderr);
            assert(/boot check: restored/.test(b.r.stdout), f.name + ': ' + b.r.stdout);
            assert(fs.readFileSync(b.tgt).equals(f.original), f.name + ': carplay starts the original');
            assert(/\bro\b/.test(b.mounts), f.name + ': / is read-only again');
            assert.deepStrictEqual(b.state, { fails: 0, arm: null, starts: null, ended: null, failed: null });
        } finally { cp.execFileSync('rm', ['-rf', dir]); }
    });
});

test('realRestore reports a remount failure instead of leaving / writable silently', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        /* mount honours rw but never ro, so / stays writable. */
        const r = stageAndRestore(dir, 'case "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + path.join(dir, 'mounts') + '";; esac\n');
        assert(r.err && /read-write after remount/.test(r.err), 'the remount failure is reported: ' + r.err);
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('the service stays up without a patch to watch, and stops on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-idle-'));
    let child = null;
    try {
        const tgt = path.join(dir, 'carplay');
        fs.writeFileSync(tgt, 'not a carplay build\n');
        fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-idle\n');
        /* systemctl logs each call: the first tick asks for carplay's state */
        const calls = path.join(dir, 'calls');
        const sc = path.join(dir, 'systemctl');
        fs.writeFileSync(sc, '#!/bin/sh\necho "$*" >> "' + calls + '"\n');
        fs.chmodSync(sc, 0o755);
        child = cp.spawn(process.execPath, [RECOVERY_PATH], {
            env: Object.assign({}, process.env, {
                WOC_CARPLAY: tgt, WOC_RECOVERY_STATE: path.join(dir, 'state.json'), WOC_BOOT_ID: path.join(dir, 'boot_id'),
                WOC_SYSTEMCTL: sc, WOC_RECOVERY_TICK_MS: '50',
            }),
            stdio: 'ignore',
        });
        let exit = null;
        const exited = new Promise((r) => child.on('exit', (code, signal) => { exit = { code, signal }; r(); }));
        const probed = () => fs.existsSync(calls) && /^show carplay\.service/m.test(fs.readFileSync(calls, 'utf8'));
        for (let t = Date.now(); !probed() && exit === null && Date.now() - t < 3000;) await new Promise((r) => setTimeout(r, 20));
        assert(probed(), 'the first tick ran: ' + JSON.stringify(exit));
        await new Promise((r) => setTimeout(r, 300));   /* about six more ticks */
        assert.strictEqual(exit, null, 'still running after its ticks: ' + JSON.stringify(exit));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
        assert(exit && exit.code === 0, 'a SIGTERM ends it cleanly: ' + JSON.stringify(exit));
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        cp.execFileSync('rm', ['-rf', dir]);
    }
});

async function main() {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log(`ok   ${t.name}`); }
        catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err && err.stack}`); }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

main();
