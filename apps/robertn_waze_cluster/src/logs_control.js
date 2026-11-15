// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * logs_control - the Logs page's client of waze-on-cluster's logs socket
 * (LOGS_PATH, group tm_oap_app). Connecting starts the logs service, which
 * serves the saved archives to a phone on the car's hotspot while the app
 * stays connected and for 15 minutes after a save; the app holds the
 * connection while the Logs page is visible.
 *
 *   app  -> logs  {"cmd":"save"}
 *   logs -> app   {"ev":"state","url":"http://<address>:8475/<token>/"|null,"saving",
 *                  "error":null|"no-space"|"too-large"|"failed","saved","archives":[{"name","size","mtime"}]}
 */
'use strict';

const EventEmitter = require('events');
const { LineSocket } = require('./waze_cluster_control.js');
const { t } = require('./i18n.js');

const LOGS_PATH = '/dev/shm/waze-on-cluster/logs.sock';
const ROWS = 5;
/* A failed save, by the service's error (English keys of src/i18n.js). */
const ERRORS = { 'no-space': 'Not enough space', 'too-large': 'Too large to save', failed: 'Save failed' };

function size(bytes) {
    return bytes >= 1048576 ? t('{0} MB', (bytes / 1048576).toFixed(1)) : t('{0} KB', Math.max(1, Math.round(bytes / 1024)));
}

class LogsControl extends EventEmitter {
    /* options: path, retryMs, log. Emits 'change'. */
    constructor(options) {
        const o = options || {};
        super();
        this.state = null;
        this.socket = new LineSocket({
            path: o.path || LOGS_PATH,
            retryMs: o.retryMs,
            log: o.log,
            onMessage: (msg) => {
                if (msg.ev === 'state') {
                    this.state = msg;
                    this.emit('change');
                }
            }
        });
        this.socket.on('connect', () => this.emit('change'));
        this.socket.on('close', () => {
            this.state = null;
            this.emit('change');
        });
    }

    open() {
        this.socket.open();
        this.emit('change');
    }

    close() {
        this.socket.close();
        this.state = null;
        this.emit('change');
    }

    save() {
        if (this.canSave()) {
            this.socket.send({ cmd: 'save' });
        }
    }

    canSave() {
        return !!(this.state && !this.state.saving);
    }

    url() {
        return (this.state && this.state.url) || null;
    }

    statusText() {
        return t('Saved logs: {0}', this._saved());
    }

    _saved() {
        const s = this.state;
        if (!s) {
            return this.socket.link === 'absent' ? t('Unavailable') : t('Connecting…');
        }
        if (s.saving) {
            return t('Saving…');
        }
        if (s.error) {
            return t(ERRORS[s.error] || ERRORS.failed);
        }
        return s.archives && s.archives.length ? String(s.archives.length) : t('None');
    }

    urlText() {
        return t('Address: {0}', this.state ? this.url() || t('Wi-Fi hotspot off') : '—');
    }

    /* ROWS rows: the archives, newest first, then empty ones. */
    rows() {
        const list = (this.state && this.state.archives) || [];
        return Array.from({ length: ROWS }, (_, i) => (list[i] ? `${list[i].name} · ${size(list[i].size)}` : ''));
    }
}

module.exports = { LogsControl, LOGS_PATH, ROWS, ERRORS };
