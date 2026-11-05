// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * The published catalog (mgu-store docs/PUBLISHING.md, "2. Catalog"):
 * schema 2, or 1. Parse
 * and check a catalog, compare versions. No I/O.
 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS = ['app', 'tool'];

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) {
            return pa[i] < pb[i] ? -1 : 1;
        }
    }
    return 0;
}

/* A component's title and description in other languages (its "texts"),
 * as mgu-store's updater reads them (native/mgu-updater/js/catalog.js):
 * { "<code>": { "title": "...", "description": "..." } }, codes as the
 * Store's languages (de, pt-BR, zh-TW). Anything else in it is left out;
 * null when nothing is left. */
const TEXT_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
function textsOf(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
        return null;
    }
    const out = {};
    Object.keys(t).slice(0, 64).forEach((code) => {
        const v = t[code];
        if (!TEXT_CODE.test(code) || !v || typeof v !== 'object') {
            return;
        }
        const e = {};
        if (typeof v.title === 'string' && v.title.trim()) {
            e.title = v.title.replace(/\s+/g, ' ').trim().slice(0, 80);
        }
        if (typeof v.description === 'string' && v.description.trim()) {
            e.description = v.description.slice(0, 1000);
        }
        if (Object.keys(e).length) {
            out[code] = e;
        }
    });
    return Object.keys(out).length ? out : null;
}

/* Parses catalog text; throws with a reason when it is unusable. */
function parse(text) {
    let catalog;
    try {
        catalog = JSON.parse(text);
    } catch (e) {
        throw new Error('catalog is not JSON');
    }
    if (!catalog || (catalog.schema !== 1 && catalog.schema !== 2) || !Array.isArray(catalog.components)) {
        throw new Error('catalog schema is not 1 or 2');
    }
    const seen = new Set();
    catalog.components.forEach((c) => {
        const a = c && c.artifact;
        if (!c || !ID.test(c.id) || KINDS.indexOf(c.kind) < 0 || !SEMVER.test(c.version) ||
            !a || typeof a.name !== 'string' || a.name !== `${c.id}@${c.version}.tgz` ||
            !SHA256.test(a.sha256) || !(a.size > 0)) {
            throw new Error(`catalog entry ${c && c.id} is malformed`);
        }
        const req = c.requires === undefined ? {} : c.requires;
        if ((c.build !== undefined && !(c.build === 'unit' && c.kind === 'app')) ||
            !req || typeof req !== 'object' || Array.isArray(req) ||
            Object.keys(req).some((k) => !ID.test(k) || k === c.id || !SEMVER.test(req[k]))) {
            throw new Error(`catalog entry ${c.id}: build must be "unit" (an app), requires must map ids to x.y.z`);
        }
        if (seen.has(c.id)) {
            throw new Error(`catalog lists ${c.id} twice`);
        }
        seen.add(c.id);
    });
    return catalog;
}

module.exports = { parse, compareVersions, textsOf, SEMVER };
