// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Builds the app's source package, and its OAP tgz when an oap-sdk donor is
 * at hand.
 *
 *   node tools/build.js [--sdk <donor .tgz|.js>]      (or MGU_SDK_DONOR)
 *
 *  1. Writes src/locales.js and the RHMI text files from locales/
 *     (tools/gen_locales.js).
 *  2. Packs the source package robertn_waze_cluster@<version>.src.tgz:
 *     mgu-app.json, the modules (src/) and the staged tree
 *     (tools/oap_link.js). The catalog publishes it with "build": "unit";
 *     the head unit's deploy tool links it against the unit's own oap-sdk
 *     and takes the package's entry point from the unit's own packages.
 *  3. With a donor (a browserify bundle carrying oap-sdk, e.g. one from the
 *     unit: `mgu-deploy.sh sdk-donor`), also builds the OAP tgz
 *     robertn_waze_cluster@<version>.tgz as the unit would. The repository
 *     carries no oap-sdk.
 */
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const REPO = path.join(HERE, '..', '..');
const link = require(path.join(REPO, 'tools', 'oap_link.js'));

function donorArg(argv) {
    const i = argv.indexOf('--sdk');
    if (i >= 0) {
        if (!argv[i + 1]) {
            throw new Error('--sdk needs a donor .tgz or .js');
        }
        return path.resolve(argv[i + 1]);
    }
    return process.env.MGU_SDK_DONOR ? path.resolve(process.env.MGU_SDK_DONOR) : null;
}

function main() {
    const donor = donorArg(process.argv.slice(2));
    require('./gen_locales.js').write();
    const m = link.readManifest(HERE);
    const src = path.join(HERE, `${m.id}@${m.version}.src.tgz`);
    const out = { source: path.basename(src), sourceMembers: link.packSource(HERE, src).length };
    if (donor) {
        const r = link.build(HERE, path.join(HERE, `${m.id}@${m.version}.tgz`),
            { donors: [donor], epoch: process.env.SOURCE_DATE_EPOCH });
        Object.assign(out, { tgz: path.basename(r.file), donor: r.donor, entry: r.entry,
            bundleModules: r.moduleCount, bundleBytes: r.bytes });
    }
    console.log(JSON.stringify(out, null, 2));
}

try {
    main();
} catch (e) {
    console.error(`build: ${e.message}`);
    process.exitCode = 1;
}
