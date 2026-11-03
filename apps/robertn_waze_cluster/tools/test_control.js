// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Drives src/waze_cluster_control.js against tools/fakes.js.
 *
 *   node tools/test_control.js
 *
 * Covers: both sockets unreachable (the patch daemon not yet running);
 * Enable map / Disable map applying the one patch configuration; the map
 * following the stream with no command from the app, and an idle status
 * showing the stream's reason; a page opened while the
 * map is up reading its state, also when opened again;
 * the combined status line across patch and render state, ignoring extra
 * status fields and reading an unrecognised patch state as unknown; the
 * Enable prompt for a unit on an older safe area, and none from a daemon that
 * omits it; the status line a page renders on the link-up change, before the
 * first patch status arrives; the pending patch or removal (from the daemon,
 * or from its marker before the daemon runs) with no Enable or Disable; which
 * states offer Enable and Disable; a conflict the install left alone; the
 * merged, source-tagged log; and reconnect without duplicated backlog.
 */
const assert = require('assert');
const fs = require('fs');
const { WazeClusterControl, SIZE, SAFE, ENABLE_TEXT, CONFIRM_TEXT, CONFIRM_STATUS, FAILED_STATUS } = require('../src/waze_cluster_control.js');
const { FakeRender, FakePatch, RENDER_PAGE, RENDER_FPS } = require('./fakes.js');

/* short: macOS limits a socket path to 104 bytes */
const RSOCK = `/tmp/woc-r-${process.pid}.sock`;
const PSOCK = `/tmp/woc-p-${process.pid}.sock`;
const PENDING = `/tmp/woc-pending-${process.pid}.json`;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* Resolves once check() holds, polling every 10 ms. */
function until(what, check) {
    const deadline = Date.now() + 1000;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) {
                resolve();
            } else if (Date.now() > deadline) {
                reject(new Error(`timed out waiting for ${what}`));
            } else {
                setTimeout(poll, 10);
            }
        };
        poll();
    });
}

function control() {
    return new WazeClusterControl({ renderPath: RSOCK, patchPath: PSOCK, pendingPath: PENDING, retryMs: 100 });
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('patch daemon unreachable: reported, not an error', async () => {
    /* Neither socket exists — the patch service has not come up yet. */
    const c = control();
    c.open();
    await until('patch absent', () => c.patch.link === 'absent');
    assert.strictEqual(c.statusText(), 'Patch service unavailable (reboot may be needed)');
    assert.strictEqual(c.connectedPatch(), false);
    assert.strictEqual(c.connectedRender(), false);
    c.close();
});

test('explicit capture and early stop follow capture status without applying a patch', async (render, patch) => {
    const c=control();c.open();await until('connected',()=>c.connectedPatch());
    c.capture();await until('start sent',()=>patch.count('capture-start')===1);
    patch._broadcast({ev:'capture',capture:{state:'open'}});
    await until('capture ready',()=>c.captureButtonText()==='Stop capture');
    assert(c.captureText().includes('reconnect CarPlay'));
    c.capture();await until('stop sent',()=>patch.count('capture-stop')===1);
    assert.strictEqual(patch.count('apply'),0);
    patch._broadcast({ev:'capture',capture:{state:'restore_failed',error:'daemon unavailable'}});
    await until('restore failure visible',()=>c.captureText().includes('daemon unavailable'));
    c.close();
});

test('connected, original: enable the map', async (render, patch) => {
    const c = control();
    c.open();
    await until('original', () => c.statusText() === 'Original — enable the map');
    assert.strictEqual(c.connectedPatch(), true);
    assert.strictEqual(c.connectedRender(), true);
    c.close();
});

test('Enable map applies the patch; patched line once done', async (render, patch) => {
    const c = control();
    c.open();
    await until('original', () => c.statusText() === 'Original — enable the map');
    c.enableMap();
    await until('applying', () => c.statusText() === 'Applying patch…');
    assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply'), [{ cmd: 'apply', panel: 'high', mode: 'avb' }]);
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    c.close();
});

test('A unit on the older mid-panel patch is prompted to Enable map', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.announce('patched', 'mid', null);
    await until('update patch', () => c.statusText() === 'Patched — Enable map to update the patch');
    c.enableMap();
    await until('apply high', () => patch.count('apply') === 1);
    assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply'), [{ cmd: 'apply', panel: 'high', mode: 'avb' }]);
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    c.close();
});

test('the map follows the stream; the app sends the render nothing', async (render, patch) => {
    const c = control();
    const seen = [];
    c.on('change', () => seen.push(c.statusText()));
    c.open();
    await until('connected', () => c.connectedRender());
    patch.announce('patched', 'high', null);
    await until('patched idle', () => c.statusText() === 'Patched — waiting for CarPlay');
    render.stream(true);
    await until('showing', () => c.statusText() === `Showing: ${RENDER_PAGE} — ${RENDER_FPS}`);
    assert(seen.includes('Starting map…'), `status lines rendered on change: ${JSON.stringify(seen)}`);
    render.stream(false);
    await until('stream stopped', () => c.statusText() === 'Patched — waiting for CarPlay');
    render.announce('idle', 'Stream lost — reconnect CarPlay');
    await until('idle with the stream\'s reason', () => c.statusText() === 'Stream lost — reconnect CarPlay');
    assert.deepStrictEqual(render.received, [], 'no command to the render');
    assert.strictEqual(c.show, undefined);
    assert.strictEqual(c.stop, undefined);
    /* The DLT capture window is the Capture button's alone. */
    assert(!patch.received.some((m) => m.cmd === 'capture-start'), 'the stream does not arm capture');
    assert.strictEqual(SIZE, '1088x480');
    c.close();
});

test('a page opened while the map is up reads it, again after closing', async (render, patch) => {
    patch.res = SIZE;
    patch.safe = SAFE;
    patch.announce('patched', 'high', null);
    render.stream(true);
    await until('fake showing', () => render.state === 'showing');
    const c = control();
    c.open();
    await until('showing', () => c.statusText() === `Showing: ${RENDER_PAGE} — ${RENDER_FPS}`);
    c.close();
    await until('closed', () => render._clients.size === 0);
    c.open();
    await until('showing again', () => c.statusText() === `Showing: ${RENDER_PAGE} — ${RENDER_FPS}`);
    c.close();
});

test('Starting map while the render is mapping', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedRender());
    patch.announce('patched', 'high', null);
    render.announce('starting', null);
    await until('starting', () => c.statusText() === 'Starting map…');
    c.close();
});

test('a frozen stream: the line says to reconnect CarPlay', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedRender());
    patch.announce('patched', 'high', null);
    render.announce('frozen', "the phone's cluster stream froze");
    await until('frozen', () => c.statusText() === 'Map frozen — reconnect CarPlay');
    c.close();
});

test('Disable map reverts', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.announce('patched', 'high', null);
    await until('patched', () => c.statusText().indexOf('Patched') === 0);
    c.disableMap();
    await until('reverting', () => c.statusText() === 'Reverting patch…');
    assert.strictEqual(patch.count('revert'), 1);
    await until('original', () => c.statusText() === 'Original — enable the map');
    c.close();
});

test('status line on the link-up change, before the first patch status', async (render, patch) => {
    const c = control();
    /* The page renders on every change. The link-up change fires with the last
     * patch status cleared and the new one not yet arrived. */
    const seen = [];
    c.on('change', () => seen.push(c.statusText()));
    c.open();
    await until('connected', () => c.connectedPatch());
    assert(seen.includes('Patch state unknown — enable the map'),
        `status lines rendered on change: ${JSON.stringify(seen)}`);
    c.close();
});

test('extra status fields are ignored; an unrecognised state is not shown as patched', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch() && c.connectedRender());
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', selfstart: 'patched', edits: [1, 2, 3, 4] });
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    /* e.g. a binary patched before the self-start edit, reported under a new state name */
    patch._broadcast({ ev: 'status', state: 'partial', panel: 'high', mode: 'udp' });
    await until('needs enable', () => c.statusText() === 'Patch state unknown — enable the map');
    /* written but deferred to the next head-unit start: show the restart-needed
     * line with the daemon's reason, not "enable" */
    patch._broadcast({ ev: 'status', state: 'unknown', panel: 'high', mode: 'udp', carplay: 'deferred', reason: 'patch written; takes effect at the next head-unit start' });
    await until('restart needed', () => c.statusText() === 'Restart needed — patch written; takes effect at the next head-unit start');
    /* patched onto another sink by an older app: the stream never reaches the
     * render, so Enable map is prompted instead of the render line */
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'udp' });
    await until('update capture', () => c.statusText() === 'Patched — Enable map to update the patch');
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: '720x320' });
    await until('update resolution', () => c.statusText() === 'Patched — Enable map to update the patch');
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: '1088x480' });
    await until('patched avb', () => c.statusText() === 'Patched — waiting for CarPlay');
    c.close();
});

test('an older full-frame safe area prompts Enable map, which writes the default', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch() && c.connectedRender());
    /* 1088x480 with the whole frame as the safe area: the guidance banner
     * lands under the gauges, so Enable map is prompted. */
    patch.res = '1088x480';
    patch.safe = '1088x480+0+0';
    patch.announce('patched', 'high', null);
    await until('update safe area', () => c.statusText() === 'Patched — Enable map to update the patch');
    c.enableMap();
    await until('applied', () => patch.count('apply') === 1 && !patch.busy);
    assert.strictEqual(patch.safe, SAFE);
    await until('current', () => c.statusText() === 'Patched — waiting for CarPlay');
    /* A daemon that omits safe (before the safe area) is taken as current. */
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: '1088x480' });
    await until('older daemon', () => c.statusText() === 'Patched — waiting for CarPlay' && c.patchStatus.safe === undefined);
    assert.strictEqual(SAFE, '504x368+286+72');
    c.close();
});

test('installed, before the head-unit start: the marker shows the pending patch, no buttons', async () => {
    /* The install wrote the patch; the daemon starts at the next head-unit
     * start, so only its marker says so. */
    fs.writeFileSync(PENDING, JSON.stringify({ action: 'apply', reason: 'patch written; takes effect at the next head-unit start' }) + '\n');
    const c = control();
    c.open();
    await until('patch absent', () => c.patch.link === 'absent');
    assert.strictEqual(c.statusText(), 'Patch pending — reboot to activate');
    assert.strictEqual(c.canEnable(), false);
    assert.strictEqual(c.canDisable(), false);
    assert.strictEqual(c.restartNeeded(), false, 'no daemon to reboot through');
    fs.writeFileSync(PENDING, JSON.stringify({ action: 'revert' }) + '\n');
    assert.strictEqual(c.statusText(), 'Removal pending — reboot to finish');
    fs.unlinkSync(PENDING);
    assert.strictEqual(c.statusText(), 'Patch service unavailable (reboot may be needed)');
    c.close();
});

test('a pending apply from the daemon: its line, a restart, no Enable or Disable', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.pending = 'apply';
    patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
    await until('pending', () => c.statusText() === 'Patch pending — reboot to activate');
    assert.strictEqual(c.canEnable(), false);
    assert.strictEqual(c.canDisable(), false);
    assert.strictEqual(c.restartNeeded(), true);
    patch.pending = 'revert';
    patch.announce('unknown', null, 'patch removed; the original carplay runs from the next head-unit start', 'deferred');
    await until('removal pending', () => c.statusText() === 'Removal pending — reboot to finish');
    assert.strictEqual(c.canEnable(), false);
    assert.strictEqual(c.canDisable(), false);
    c.requestRestart();
    await until('restarting', () => c.statusText() === 'Restarting head unit…');
    c.close();
});

test('Enable map only for original, unknown or outdated; Disable map only for a patch', async (render, patch) => {
    const c = control();
    c.open();
    await until('original', () => c.statusText() === 'Original — enable the map');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [true, false], 'original');
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: SIZE, safe: SAFE });
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [false, true], 'patched');
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'mid', mode: 'avb', res: null, safe: null });
    await until('outdated', () => c.statusText() === 'Patched — Enable map to update the patch');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [true, true], 'outdated patch');
    patch._broadcast({ ev: 'status', state: 'unknown', panel: 'high', reason: 'self-start edit missing (older patch); enable the map to apply it' });
    await until('unknown', () => c.statusText() === 'Patch state unknown — enable the map');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [true, true], 'unknown');
    patch._broadcast({ ev: 'status', state: 'busy', reason: 'applying' });
    await until('busy', () => c.statusText() === 'Applying patch…');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [false, false], 'busy');
    c.close();
});

test('a conflict the install left alone is shown, and Enable map stays the user\'s choice', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.conflict = 'carplay.service starts /bin/sh (/etc/systemd/system/carplay.service.d/60-other.conf)';
    patch.announce('original', null, null);
    await until('conflict', () => c.statusText() === `Not patched — ${patch.conflict}`);
    assert.strictEqual(c.canEnable(), true);
    patch.conflict = 'not patchable: self-start: onSuggestUi call not found';
    patch.announce('unknown', null, null);
    await until('unknown conflict', () => c.statusText() === `Patch state unknown — ${patch.conflict}`);
    assert.strictEqual(c.canEnable(), true);
    c.close();
});

test('a deferred patch offers a restart; one press reboots once', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    assert.strictEqual(c.restartNeeded(), false, 'no restart before a deferred patch');
    patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
    await until('restart needed', () => c.restartNeeded());
    assert.strictEqual(c.statusText(), 'Restart needed — patch written; takes effect at the next head-unit start');
    c.requestRestart();
    await until('reboot sent', () => patch.count('reboot') === 1);
    await until('restarting', () => c.statusText() === 'Restarting head unit…');
    assert.strictEqual(c.restartRequested(), true);
    /* A second press does not send another reboot. */
    c.requestRestart();
    await sleep(50);
    assert.strictEqual(patch.count('reboot'), 1, 'the restart is sent once');
    assert.strictEqual(patch.reboots, 1, 'the daemon reboots once');
    c.close();
});

test('no restart button when carplay restarts at once (never deferred)', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    /* An apply that restarts carplay reports carplay "restarted", never
     * "deferred": the restart is not needed. */
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: SIZE, safe: SAFE, carplay: 'restarted' });
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    assert.strictEqual(c.restartNeeded(), false);
    c.requestRestart();
    await sleep(50);
    assert.strictEqual(patch.count('reboot'), 0, 'no reboot is sent when none is needed');
    c.close();
});

test('a refused restart reply clears the asked flag so the button returns', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
    await until('restart needed', () => c.restartNeeded());
    /* The daemon refuses this request (a restart is already underway); its
     * reply carries no status, so the deferred state is unchanged. */
    patch._rebooting = true;
    c.requestRestart();
    await until('requested', () => c.restartRequested());
    await until('cleared', () => !c.restartRequested());
    assert.strictEqual(c.restartNeeded(), true, 'still deferred, so the button is offered again');
    assert.strictEqual(patch.reboots, 0, 'the refused request reboots nothing');
    c.close();
});

test('render unreachable while patched', async (render, patch) => {
    /* Only the patch daemon is up (the render socket is absent in this case). */
    const c = new WazeClusterControl({ renderPath: `/tmp/woc-none-${process.pid}.sock`, patchPath: PSOCK, retryMs: 100 });
    c.open();
    await until('patch up', () => c.connectedPatch());
    patch.announce('patched', 'high', null);
    await until('map unavailable', () => c.statusText() === 'Patched — map service unavailable');
    assert.strictEqual(c.connectedRender(), false);
    c.close();
});

test('merged log, newest first, tagged by source', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch() && c.connectedRender());
    render.log('render running');
    patch.log('patchd listening');
    await until('both lines', () => c.rows().some((r) => r.indexOf('render running') >= 0) &&
        c.rows().some((r) => r.indexOf('patchd listening') >= 0));
    const rows = c.rows();
    assert.strictEqual(rows[0], 'patch: patchd listening', 'newest line first');
    assert.ok(rows.some((r) => r === 'map: render running'), 'render line tagged map');
    c.close();
});

test('reconnect does not duplicate the backlog', async (render, patch) => {
    patch.log('boot line');
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    await until('backlog', () => c.rows().some((r) => r === 'patch: boot line'));
    const before = c.rows().filter((r) => r === 'patch: boot line').length;
    assert.strictEqual(before, 1);
    patch.dropClients();
    await until('reconnected', () => c.connectedPatch());
    await sleep(50);
    const after = c.rows().filter((r) => r === 'patch: boot line').length;
    assert.strictEqual(after, 1, 'the resent backlog is not duplicated');
    c.close();
});

test('an untested CarPlay build: Enable map asks to confirm, only the confirmed press sends unproven', async (render, patch) => {
    patch.unproven = true;
    patch.conflict = 'untested carplay build';
    const c = control();
    c.open();
    await until('original', () => c.connectedPatch() && c.patchStatus && c.patchStatus.unproven === true);
    assert.strictEqual(c.enableButtonText(), ENABLE_TEXT);
    assert.strictEqual(c.canEnable(), true);
    c.enableMap();
    assert.strictEqual(c.enableButtonText(), CONFIRM_TEXT);
    assert.strictEqual(c.statusText(), CONFIRM_STATUS);
    await sleep(50);
    assert.strictEqual(patch.count('apply'), 0, 'the first press sends nothing');
    c.enableMap();
    await until('apply sent', () => patch.count('apply') === 1);
    assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply'), [{ cmd: 'apply', panel: 'high', mode: 'avb', unproven: true }]);
    assert.strictEqual(c.enableButtonText(), ENABLE_TEXT);
    await until('patched', () => c.patchStatus && c.patchStatus.state === 'patched');
    assert.strictEqual(c.needsConfirm(), false);
    c.close();
});

test('an untested CarPlay build: the confirm step lapses, and a proven build never asks', async (render, patch) => {
    patch.unproven = true;
    const c = new WazeClusterControl({ renderPath: RSOCK, patchPath: PSOCK, pendingPath: PENDING, retryMs: 100, confirmMs: 100 });
    c.open();
    await until('unproven', () => c.connectedPatch() && c.needsConfirm());
    c.enableMap();
    assert.strictEqual(c.enableButtonText(), CONFIRM_TEXT);
    await until('lapsed', () => c.enableButtonText() === ENABLE_TEXT);
    assert.notStrictEqual(c.statusText(), CONFIRM_STATUS);
    assert.strictEqual(patch.count('apply'), 0, 'a lapsed confirm sends nothing');
    /* the next press asks again */
    c.enableMap();
    assert.strictEqual(c.enableButtonText(), CONFIRM_TEXT);
    c.close();
    assert.strictEqual(c.enableButtonText(), ENABLE_TEXT, 'closing the page drops the confirm step');

    patch.unproven = false;
    const d = control();
    d.open();
    await until('original', () => d.connectedPatch() && d.patchStatus);
    d.enableMap();
    await until('apply sent', () => patch.count('apply') === 1);
    assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply'), [{ cmd: 'apply', panel: 'high', mode: 'avb' }]);
    d.close();
});

test('boot recovery marked the patch failed: the status line says so, whatever the patch state', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch() && c.patchStatus);
    patch.failed = 'carplay crashed 3 times with the map patch and cannot be restored automatically';
    patch.announce('patched', 'high', null);
    await until('failed', () => c.statusText() === FAILED_STATUS);
    patch.announce('unknown', null, null);
    await until('failed, unknown', () => c.patchStatus.state === 'unknown');
    assert.strictEqual(c.statusText(), FAILED_STATUS);
    patch.failed = null;
    patch.announce('original', null, null);
    await until('cleared', () => c.statusText() === 'Original — enable the map');
    c.close();
});

test('the confirm texts carry no em dash and no emoji', async () => {
    [ENABLE_TEXT, CONFIRM_TEXT, CONFIRM_STATUS, FAILED_STATUS].forEach((t) => {
        assert(!/[\u2014\u2013]/.test(t), `dash in ${t}`);
        assert(!/[\u2600-\u27BF\u2B00-\u2BFF\uFE0F]|[\uD83C-\uD83E][\uDC00-\uDFFF]/.test(t), `emoji in ${t}`);
    });
});

async function main() {
    let failed = 0;
    for (const t of tests) {
        const needsServers = t.fn.length > 0;
        const render = new FakeRender(RSOCK);
        const patch = new FakePatch(PSOCK);
        if (needsServers) {
            await render.listen();
            await patch.listen();
        }
        try {
            await t.fn(render, patch);
            console.log(`ok   ${t.name}`);
        } catch (err) {
            failed++;
            console.log(`FAIL ${t.name}\n     ${err && err.stack}`);
        } finally {
            if (needsServers) {
                await render.close();
                await patch.close();
            }
            [RSOCK, PSOCK, PENDING].forEach((p) => {
                try {
                    fs.unlinkSync(p);
                } catch (e) {
                    /* gone */
                }
            });
        }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

main();
