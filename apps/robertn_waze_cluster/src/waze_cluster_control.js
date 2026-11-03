// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * waze_cluster_control - the app's client of the two native waze-on-cluster
 * sockets. No OAP runtime: the app opens both while its page is visible,
 * closes them when the page is hidden, and renders statusText(),
 * rows() and the connected() flags.
 *
 * LineSocket holds the connection: a Unix stream socket, newline-delimited
 * JSON, one object per line, with retry while open. One drives the render
 * control socket, one the root patch daemon.
 *
 *   Render control socket (RENDER_PATH; read only, the app sends nothing)
 *     tool -> app   {"ev":"status","state":"idle"|"starting"|"showing"|"frozen"|"error",
 *                    "target","page","reason"}   (idle's reason: why a live stream shows no map)
 *                   {"ev":"log","line"}      the backlog on connect, then each new line
 *                   {"ev":"slots",...}       ignored here
 *
 *   Patch daemon socket (PATCH_PATH; root helper, group tm_oap_app)
 *     app    -> daemon  {"cmd":"status"}
 *                       {"cmd":"apply","panel":"high","mode":"avb"[,"unproven":true]}
 *                        unproven only after the user confirmed patching a
 *                        build the daemon reports as unproven
 *                       {"cmd":"revert"}
 *                       {"cmd":"reboot"}  activate a deferred patch with a
 *                        normal reboot (only when carplay is "deferred")
 *     daemon -> app     {"ev":"status","state":"original"|"patched"|"unknown"|
 *                        "busy"|"error","panel":"high"|"mid"|null,"mode","res","safe",
 *                        "carplay","reason","pending","conflict"}
 *                       res "WxH" and safe "WxH+X+Y": the advertised size and
 *                       its safe area (a daemon before the safe area omits safe)
 *                       carplay "deferred": the patch is written but takes effect
 *                       only at the next head-unit start (a restart is needed)
 *                       pending "apply" | "revert": which change waits for it
 *                       conflict: why the install left carplay as it was
 *                       unproven true: a carplay build outside the patcher's
 *                       proven list, not patched yet; Enable map asks the
 *                       user to confirm before it sends unproven:true
 *                       {"ev":"reboot-reply","ok":true|false,"reason"}
 *                       {"ev":"log","line"}  the backlog on connect, then each new line
 *
 *   Pending marker (PENDING_PATH; world-readable JSON {"action":"apply"|"revert"})
 *     written with the change, so a patch the install wrote is shown before the
 *     next head-unit start starts the daemon.
 *
 * The render runs from boot and maps the map into the native central-map slot
 * whenever the CarPlay stream flows, and takes it down when the stream stops,
 * whether or not this app is open; its status says which. Enable map applies
 * the one patch configuration (high panel, the resolution SIZE the render
 * displays with its guidance safe area SAFE, the stock media-bus sink), and
 * Disable map reverts it, which is what turns the map off. Installing the tool
 * writes the same patch, which takes effect at the next head-unit start. The
 * patch daemon is a new root service that may not be running until then, so
 * an unreachable patch socket is reported, not an error, and retried like the
 * render socket.
 */
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');

const RENDER_PATH = '/dev/shm/waze-on-cluster/ctl.sock';
const PATCH_PATH = '/dev/shm/waze-on-cluster/patch.sock';
const PENDING_PATH = '/dev/shm/waze-on-cluster/activation-pending';
const RETRY_MS = 1000;
const MAX_LINES = 30;

/* The native central-map slot's size, which the patch advertises to the phone. */
const SIZE = '1088x480';
/* The safe area Enable map writes: where the phone keeps its guidance UI,
 * inside the part of the map the gauges leave visible. */
const SAFE = '504x368+286+72';

/* The Enable button's label, and while it asks to confirm patching a
 * CarPlay build outside the patcher's proven list, for CONFIRM_MS. */
const ENABLE_TEXT = 'Enable map';
const CONFIRM_TEXT = 'Confirm: patch untested CarPlay';
const CONFIRM_MS = 15000;
const CONFIRM_STATUS = 'Untested CarPlay build: this patch has never run on this firmware. ' +
    'Press Confirm to patch it anyway, or wait to cancel';

/* One newline-delimited-JSON stream socket, reconnecting while open.
 * link: 'down' | 'up' | 'absent' (ENOENT) | 'refused' (ECONNREFUSED) | 'failed'.
 * Emits 'connect' and 'close'; each parsed object goes to onMessage(msg). */
class LineSocket extends EventEmitter {
    constructor(options) {
        super();
        const o = options || {};
        this.path = o.path;
        this.retryMs = o.retryMs || RETRY_MS;
        this._log = o.log || { info() {}, warn() {} };
        this._onMessage = o.onMessage || function () {};
        this.link = 'down';
        this.linkCode = null;
        this._open = false;
        this._socket = null;
        this._buf = '';
        this._retryTimer = null;
    }

    open() {
        if (!this._open) {
            this._open = true;
            this._connect();
        }
    }

    close() {
        this._open = false;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        if (this._socket) {
            /* forgotten here, so its late events cannot touch a new connection */
            this._socket.end();
            this._socket = null;
        }
        this.link = 'down';
    }

    connected() {
        return this.link === 'up';
    }

    send(obj) {
        if (this._socket && this.link === 'up') {
            this._socket.write(JSON.stringify(obj) + '\n');
        }
    }

    _connect() {
        if (!this._open || this._socket) {
            return;
        }
        const socket = net.connect(this.path);
        this._socket = socket;
        this._buf = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            if (this._socket === socket) {
                this._log.info(`connected to ${this.path}`);
                this.link = 'up';
                this.linkCode = null;
                this.emit('connect');
            }
        });
        socket.on('data', (chunk) => {
            if (this._socket === socket) {
                this._onData(chunk);
            }
        });
        socket.on('error', (err) => {
            if (this._socket !== socket) {
                return;
            }
            const code = (err && err.code) || 'ERROR';
            this.link = code === 'ENOENT' ? 'absent' : code === 'ECONNREFUSED' ? 'refused' : 'failed';
            this.linkCode = code;
            this._log.warn(`${this.path}: ${code}`);
        });
        socket.on('close', () => {
            if (this._socket !== socket) {
                return;
            }
            this._socket = null;
            if (this.link === 'up') {
                this._log.info(`${this.path}: connection closed`);
                this.link = 'refused';
            }
            this.emit('close');
            this._retryTimer = setTimeout(() => {
                this._retryTimer = null;
                this._connect();
            }, this.retryMs);
        });
    }

    _onData(chunk) {
        this._buf += chunk;
        let nl;
        while ((nl = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, nl).trim();
            this._buf = this._buf.slice(nl + 1);
            if (!line) {
                continue;
            }
            let msg = null;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                this._log.warn(`bad line from ${this.path}: ${line.slice(0, 80)}`);
            }
            if (msg) {
                this._onMessage(msg, line);
            }
        }
    }
}

class WazeClusterControl extends EventEmitter {
    /* options: renderPath, patchPath, pendingPath, retryMs, log ({info, warn}). Emits
     * 'change' whenever statusText() or the connected() flags may
     * have changed, and 'log' when the merged log lines changed. */
    constructor(options) {
        super();
        const o = options || {};
        this._log = o.log || { info() {}, warn() {} };
        this._pendingPath = o.pendingPath || PENDING_PATH;
        this._lastPatchCmd = 'apply';
        this._confirmMs = o.confirmMs || CONFIRM_MS;
        this._confirmUntil = 0;           /* Enable map asks to confirm an untested build until then */
        this._confirmTimer = null;
        this._restartRequested = false;   /* a reboot was asked for; waiting for the unit to restart */
        this.captureState = { state: 'unavailable' };
        this.renderStatus = null;   /* the render tool's last status while connected */
        this.patchStatus = null;    /* the patch daemon's last status while connected */
        this._lines = [];           /* merged log: [{src, text}], newest first */

        this.render = new LineSocket({
            path: o.renderPath || RENDER_PATH,
            retryMs: o.retryMs,
            log: this._log,
            onMessage: (msg) => this._onRender(msg)
        });
        this.patch = new LineSocket({
            path: o.patchPath || PATCH_PATH,
            retryMs: o.retryMs,
            log: this._log,
            onMessage: (msg) => this._onPatch(msg)
        });

        /* On (re)connect each tool resends its backlog, so that source's lines
         * are dropped first to keep the merged log free of duplicates. */
        this.render.on('connect', () => this._onLinkChange('map', () => { this.renderStatus = null; }));
        this.render.on('close', () => { this.renderStatus = null; this.emit('change'); });
        this.patch.on('connect', () => this._onLinkChange('patch', () => { this.patchStatus = null; }));
        this.patch.on('close', () => { this.patchStatus = null; this._restartRequested = false; this.emit('change'); });
    }

    /* Open both sockets, each reconnecting while open. */
    open() {
        this.render.open();
        this.patch.open();
    }

    /* Close both; the tools keep running. */
    close() {
        this._cancelConfirm();
        this.render.close();
        this.patch.close();
        this.renderStatus = null;
        this.patchStatus = null;
        this.emit('change');
    }

    connectedRender() {
        return this.render.connected();
    }

    connectedPatch() {
        return this.patch.connected();
    }

    /* ---- controls ---- */
    /* On a CarPlay build outside the patcher's proven list (status
     * "unproven"), the first press only asks for confirmation: the button
     * reads CONFIRM_TEXT and the status line says the build is untested,
     * for CONFIRM_MS. Only a press while it asks sends unproven:true. */
    enableMap() {
        if (this.needsConfirm() && !this.confirming()) {
            this._confirmUntil = Date.now() + this._confirmMs;
            clearTimeout(this._confirmTimer);
            this._confirmTimer = setTimeout(() => {
                this._confirmTimer = null;
                this._confirmUntil = 0;
                this.emit('change');
            }, this._confirmMs);
            this.emit('change');
            return;
        }
        const confirmed = this.confirming();
        this._cancelConfirm();
        this._lastPatchCmd = 'apply';
        /* The stock media-bus sink: the capture path the render joins. */
        const cmd = { cmd: 'apply', panel: 'high', mode: 'avb' };
        if (confirmed) {
            cmd.unproven = true;
        }
        this.patch.send(cmd);
    }

    /* The daemon reports a build outside the proven list, not patched yet. */
    needsConfirm() {
        const ps = this.patchStatus;
        return !!(ps && ps.unproven === true);
    }

    /* The Enable button is asking to confirm an untested build. */
    confirming() {
        return this._confirmUntil > Date.now() && this.needsConfirm();
    }

    enableButtonText() {
        return this.confirming() ? CONFIRM_TEXT : ENABLE_TEXT;
    }

    _cancelConfirm() {
        clearTimeout(this._confirmTimer);
        this._confirmTimer = null;
        this._confirmUntil = 0;
    }

    disableMap() {
        this._lastPatchCmd = 'revert';
        this.patch.send({ cmd: 'revert' });
    }

    /* True while the daemon reports a written patch that takes effect only at
     * the next head-unit start (a restart is needed to activate it). On a unit
     * where carplay restarts at once this never holds, so no restart is shown. */
    restartNeeded() {
        const ps = this.patchStatus;
        return !!(ps && ps.carplay === 'deferred');
    }

    restartRequested() {
        return this._restartRequested;
    }

    /* The change waiting for the next head-unit start: "apply", "revert",
     * "unknown" (a daemon that does not say which), or null. From the daemon,
     * else from its marker, which the install writes before the daemon runs. */
    pending() {
        const ps = this.patchStatus;
        if (this.patch.link === 'up') {
            return ps && ps.pending ? ps.pending : ps && ps.carplay === 'deferred' ? 'unknown' : null;
        }
        let marker = null;
        try {
            marker = JSON.parse(fs.readFileSync(this._pendingPath, 'utf8'));
        } catch (e) {
            return null;
        }
        return marker && (marker.action === 'apply' || marker.action === 'revert') ? marker.action : null;
    }

    /* A patch other than the one Enable map writes: another capture sink,
     * panel, size or safe area, from an older app. */
    _outdated(ps) {
        return !!((ps.mode && ps.mode !== 'avb') || (ps.panel && ps.panel !== 'high') ||
            (ps.res && ps.res !== SIZE) || (ps.safe && ps.safe !== SAFE));
    }

    /* Enable map is offered for an original (never patched, or reverted), an
     * unknown or failed state, or an outdated patch, with nothing pending. */
    canEnable() {
        const ps = this.patchStatus;
        if (!this.connectedPatch() || this._restartRequested || !ps || this.pending()) {
            return false;
        }
        return ['original', 'unknown', 'error'].includes(ps.state) || (ps.state === 'patched' && this._outdated(ps));
    }

    /* Disable map is offered for a patch, or a state that may be one, with
     * nothing pending. */
    canDisable() {
        const ps = this.patchStatus;
        if (!this.connectedPatch() || this._restartRequested || !ps || this.pending()) {
            return false;
        }
        return ['patched', 'unknown', 'error'].includes(ps.state);
    }

    /* Ask the daemon to activate the pending patch with a normal system reboot.
     * Guarded: only when a restart is actually needed and not already asked. */
    requestRestart() {
        if (!this.restartNeeded() || this._restartRequested) {
            return;
        }
        this._restartRequested = true;
        this.patch.send({ cmd: 'reboot' });
        this.emit('change');
    }

    capture() {
        const active = ['opening', 'open'].includes(this.captureState.state);
        this.patch.send({ cmd: active ? 'capture-stop' : 'capture-start' });
    }

    captureButtonText() {
        return ['opening', 'open'].includes(this.captureState.state) ? 'Stop capture' : 'Capture logs (5 min)';
    }

    captureText() {
        const s = this.captureState;
        if (s.state === 'unavailable') return 'Logs: update Waze tool and reboot to enable capture';
        if (s.state === 'open') return 'Logs: recording — reconnect CarPlay now';
        if (s.state === 'opening') return 'Logs: checking and opening capture…';
        if (s.state === 'closing') return 'Logs: restoring tracing mode…';
        if (s.error) return `Logs: ${s.error}`;
        return 'Logs: capture stopped; saved markers available in diagnostics';
    }

    /* ---- status ---- */
    /* The patch state gates the flow, then the render state drives the line. */
    statusText() {
        const p = this.patch.link;
        if (p === 'down') {
            return 'Connecting…';
        }
        const pending = this.pending();
        if (pending === 'apply' && !this._restartRequested) {
            return 'Patch pending — reboot to activate';
        }
        if (pending === 'revert' && !this._restartRequested) {
            return 'Removal pending — reboot to finish';
        }
        if (p !== 'up') {
            return 'Patch service unavailable (reboot may be needed)';
        }
        if (this._restartRequested) {
            return 'Restarting head unit…';
        }
        if (this.confirming() && this.canEnable()) {
            return CONFIRM_STATUS;
        }
        const ps = this.patchStatus;
        const state = ps && ps.state;
        if (state === 'busy') {
            return this._lastPatchCmd === 'revert' ? 'Reverting patch…' : 'Applying patch…';
        }
        if (state === 'error') {
            return 'Patch error' + (ps.reason ? `: ${ps.reason}` : '');
        }
        /* A change written by a daemon that does not say which. */
        if (pending) {
            return `Restart needed — ${ps.reason || 'restart to activate the map patch'}`;
        }
        if (state === 'original') {
            return ps.conflict ? `Not patched — ${ps.conflict}` : 'Original — enable the map';
        }
        /* Any state other than patched (unknown, or one this app does not know)
         * needs Enable map, which applies every edit the daemon has. */
        if (state !== 'patched') {
            return ps && ps.conflict ? `Patch state unknown — ${ps.conflict}` : 'Patch state unknown — enable the map';
        }
        /* A unit patched by an older app can sit on another capture sink,
         * panel, size or safe area; the stream then misses the render, or the
         * guidance UI sits under the gauges. Enable map re-applies the current
         * patch. */
        if (this._outdated(ps)) {
            return 'Patched — Enable map to update the patch';
        }
        /* patched: the render tool owns the line */
        if (this.render.link !== 'up') {
            return 'Patched — map service unavailable';
        }
        const rs = this.renderStatus;
        switch (rs && rs.state) {
        case 'starting':
            return 'Starting map…';
        case 'showing':
            return `Showing: ${rs.page || 'Waze map'}` + (rs.reason ? ` — ${rs.reason}` : '');
        case 'error':
            return 'Map error' + (rs.reason ? `: ${rs.reason}` : '');
        case 'frozen':
            return 'Map frozen — reconnect CarPlay';
        default:
            return (rs && rs.reason) || 'Patched — waiting for CarPlay';
        }
    }

    /* Up to MAX_LINES merged log rows, newest first, each tagged by source. */
    rows() {
        return this._lines.map((l) => `${l.src}: ${l.text}`);
    }

    /* ---- internals ---- */
    _onLinkChange(src, reset) {
        this._lines = this._lines.filter((l) => l.src !== src);
        reset();
        this.emit('log');
        this.emit('change');
    }

    _onRender(msg) {
        if (msg.ev === 'status') {
            this.renderStatus = msg;
            this.emit('change');
        } else if (msg.ev === 'log') {
            this._addLine('map', String(msg.line));
            this.emit('log');
        }
    }

    _onPatch(msg) {
        if (msg.ev === 'capture') {
            this.captureState = msg.capture;
            this.emit('change');
        } else if (msg.ev === 'status') {
            this.patchStatus = msg;
            this.emit('change');
        } else if (msg.ev === 'reboot-reply') {
            /* A refused request (nothing pending, busy, or already restarting)
             * clears the asked flag so the button returns. A successful one
             * leaves it set until the unit restarts. */
            if (!msg.ok) {
                this._restartRequested = false;
            }
            this.emit('change');
        } else if (msg.ev === 'log') {
            this._addLine('patch', String(msg.line));
            this.emit('log');
        }
    }

    _addLine(src, line) {
        this._lines.unshift({ src, text: line });
        if (this._lines.length > MAX_LINES) {
            this._lines.length = MAX_LINES;
        }
    }
}

module.exports = {
    WazeClusterControl, LineSocket,
    RENDER_PATH, PATCH_PATH, PENDING_PATH, MAX_LINES,
    SIZE, SAFE, ENABLE_TEXT, CONFIRM_TEXT, CONFIRM_STATUS
};
