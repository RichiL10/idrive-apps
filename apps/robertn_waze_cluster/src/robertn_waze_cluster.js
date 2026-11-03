// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * robertn_waze_cluster - the control panel for the native
 * waze-on-cluster tool, which puts the CarPlay cluster map on the instrument
 * cluster. It drives the tool entirely from the HMI, so no shell is needed.
 *
 * One LT_State_Wide page: a status line combining the patch state and the
 * render state; the cluster setting the map needs; Enable map and Disable
 * map, which apply and revert the carplay patch; the diagnostic capture
 * button and its status; and a scrolling list of both tools' log lines,
 * newest first, one per LT_Label_1Row, redrawn at most every
 * LIST_RENDER_MS. Once patched, the render puts the map on the cluster
 * whenever CarPlay streams it, with no button.
 *
 * Enable map shows for an unpatched or unknown state and Disable map for a
 * patch, both only with no change pending (waze_cluster_control.js
 * canEnable/canDisable); on a CarPlay build outside the patcher's proven
 * list the first Enable press turns the button into a confirm step and the
 * status line says the build is untested (enableButtonText);
 * capture is enabled while the patch daemon is
 * reachable. The app connects both sockets while its page is visible and
 * closes them when it is hidden or the app shuts down; the tools keep
 * running. waze_cluster_control.js holds the protocol.
 */
'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { WazeClusterControl, MAX_LINES } = require('./waze_cluster_control.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_WazeCluster';
const STATUS_NAME = 'wocStatus';
const SETUP_NAME = 'wocSetup';
const ENABLE_NAME = 'wocEnable';
const DISABLE_NAME = 'wocDisable';
const RESTART_NAME = 'wocRestart';
const CAPTURE_NAME = 'wocCapture';
const CAPTURE_STATUS = 'wocCaptureStatus';
const ROW_NAMES = Array.from({ length: MAX_LINES }, (_, i) => `wocRow${String(i + 1).padStart(2, '0')}`);
const LIST_RENDER_MS = 500;
const ROW_CHARS = 90;
const PRESS_DEDUPE_MS = 400;
/* in Map view the stock map is the fallback while CarPlay's cluster stream
 * is not live; the menu names are the HMI's en_GB ones */
const SETUP_TEXT = 'Set Instrument cluster > Central display area to Map view';

/* A line as one row: no line breaks, at most ROW_CHARS characters. */
function oneRow(line) {
    const flat = line.replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? `${flat.slice(0, ROW_CHARS - 1)}…` : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class WazeClusterApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._listTimer = null;
        this._control = new WazeClusterControl({ log: logger });
        this._control.on('change', () => {
            this._render();
            this._scheduleLists();
        });
        this._control.on('log', () => this._scheduleLists());

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error(`robertn_waze_cluster init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._setVisible(false);
            }
        });
    }

    _appInitialized() {
        logger.info(`robertn_waze_cluster ${this.getAppId()} v${this._packageJson.version} starting`);
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
                // A foreground start declares itself ACTIVE before initialized()
                // reports the first app status, so the manager keeps it running.
                if (foregroundStart) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid &&
                    this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK',
            'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.includes(reason);
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE_NAME);
        if (!this._state) {
            return Promise.reject(new Error(`uiDescription has no ${STATE_NAME}`));
        }
        const names = [STATUS_NAME, SETUP_NAME, ENABLE_NAME, DISABLE_NAME, RESTART_NAME, CAPTURE_NAME, CAPTURE_STATUS]
            .concat(ROW_NAMES);
        names.forEach((name) => { this._components[name] = rhmi.getByName(name); });
        const missing = names.filter((name) => !this._components[name]);
        if (missing.length) {
            return Promise.reject(new Error(`uiDescription lacks ${missing.join(', ')}`));
        }
        this._bind(ENABLE_NAME, () => this._control.enableMap());
        this._bind(DISABLE_NAME, () => this._control.disableMap());
        this._bind(RESTART_NAME, () => this._control.requestRestart());
        this._bind(CAPTURE_NAME, () => this._control.capture());
        // Presses also arrive as the application's raw 'userEvent'; both paths
        // land in _press, which keeps a press delivered twice to one.
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler);
            }
        });
        rhmi.on('applicationStackChanged', (stack) => {
            // The app holds the foreground while the stack has a ROOT_APP slot;
            // the empty stack seen during startup is ignored.
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._written = {};
            this._render();
            this._renderLists();
        });
        this._state.on('visible', (event) => {
            const visible = isTrue(event && event.visible);
            if (visible) {
                this._sawForeground = true;
            }
            this._setVisible(visible);
        });
        return Promise.resolve(this._state.updateResources()).then(() => {
            logger.info(`page ready: ${names.length} components found`);
            this._render();
            this._renderLists();
        });
    }

    _bind(name, handler) {
        const comp = this._components[name];
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null) {
            this._actionById[Number(id)] = { name, handler };
        }
        logger.info(`BIND OK: ${name} (id ${id})`);
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[name] = now;
        logger.info(`BUTTON ACTION ${name}`);
        try {
            handler();
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    /* The app manager inserts the public tile from application.json and hands
     * it to the app at start; the SDK emits 'entryPointExecute' on a tap. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription &&
            this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn(`entry point text/icon: ${err && err.message}`)))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._sawForeground = true;
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* ---- visibility ---- */
    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        logger.info(`page ${visible ? 'visible' : 'hidden'}`);
        this._reportVisibilityStatus(visible);
        if (visible) {
            this._control.open();
        } else {
            this._control.close();
        }
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        const reports = visible ?
            [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report).catch((err) =>
            logger.warn(`app status report failed: ${err && err.message}`)));
    }

    /* ---- rendering ---- */
    /* Writes text into a component's row unless it already shows it. */
    _write(name, text) {
        if (this._written[name] !== text) {
            this._written[name] = text;
            Promise.resolve(this._components[name].setValue(0, 'Text', text, 'Text'))
                .catch((err) => logger.warn(`${name} render failed: ${err && err.message}`));
        }
    }

    /* Enables a button unless it already holds that state. */
    _setEnabled(name, enabled) {
        const key = `enabled:${name}`;
        if (this._written[key] !== enabled) {
            this._written[key] = enabled;
            Promise.resolve(this._components[name].setEnabled(enabled))
                .catch((err) => logger.warn(`${name} enable failed: ${err && err.message}`));
        }
    }

    /* Shows or hides a component unless it already holds that state. */
    _setVisibleComp(name, visible) {
        const key = `visible:${name}`;
        if (this._written[key] !== visible) {
            this._written[key] = visible;
            Promise.resolve(this._components[name].setVisible(visible))
                .catch((err) => logger.warn(`${name} visibility failed: ${err && err.message}`));
        }
    }

    _render() {
        if (!this._state || this._shutdownPromise) {
            return;
        }
        this._write(STATUS_NAME, this._control.statusText());
        this._write(SETUP_NAME, SETUP_TEXT);
        this._write(CAPTURE_NAME, this._control.captureButtonText());
        this._write(CAPTURE_STATUS, this._control.captureText());
        /* "Enable map", or the confirm step for an untested CarPlay build. */
        this._write(ENABLE_NAME, this._control.enableButtonText());
        const patch = this._control.connectedPatch();
        /* While a reboot is underway no patch operation should start. */
        const restarting = this._control.restartRequested();
        const enable = this._control.canEnable();
        const disable = this._control.canDisable();
        this._setVisibleComp(ENABLE_NAME, enable);
        this._setEnabled(ENABLE_NAME, enable);
        this._setVisibleComp(DISABLE_NAME, disable);
        this._setEnabled(DISABLE_NAME, disable);
        this._setEnabled(CAPTURE_NAME, patch && !restarting && this._control.captureState.state !== 'closing');
        /* The restart button appears only while a patch is written and waiting
         * for a head-unit start; it is disabled once pressed so one press does
         * one reboot. On units where carplay restarts at once it never shows. */
        const needsRestart = this._control.restartNeeded();
        this._setVisibleComp(RESTART_NAME, needsRestart);
        this._setEnabled(RESTART_NAME, needsRestart && patch && !restarting);
    }

    _scheduleLists() {
        if (!this._listTimer) {
            this._listTimer = setTimeout(() => {
                this._listTimer = null;
                this._renderLists();
            }, LIST_RENDER_MS);
        }
    }

    _renderLists() {
        if (!this._state || this._shutdownPromise) {
            return;
        }
        /* Rows are only written, never hidden: on this HMI a row hidden at
         * run time leaves the page without its other rows (mgu-emulator). */
        const rows = this._control.rows();
        ROW_NAMES.forEach((name, i) => this._write(name, oneRow(rows[i] || '')));
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`robertn_waze_cluster shutdown: ${JSON.stringify(reason)}`);
        clearTimeout(this._listTimer);
        this._control.close();
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new WazeClusterApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`robertn_waze_cluster failed to start: ${err && err.message}`);
});
