// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Writes the app's languages from locales/<code>.json (one file per
 * language; README.md, "Languages"):
 *
 *   { "hmiLanguages": ["CHINESISCH_SIMPLE", "KANTONESISCH_SIMPLE"],
 *                                               the HMI's display languages it is for
 *                                               (CommonTypes.Language, HMIContext)
 *     "rhmiTexts": ["zh_CN", "zh_yue_Hans_CN"], its RHMI text files, named as the
 *                                               oap-sdk names those languages
 *     "words": { "<English>": "<translation>" } }
 *
 * into src/locales.js, one of the app's modules, and the RHMI text files
 * (rhmiData/variantGroups/Common/texts of the staged tree): the string ids
 * the HMI shows itself (RHMI_TEXTS: the tile's name, the Logs page's
 * title), en_GB.json and en_US.json in English and those each language
 * names in its words, English where it has none.
 *
 *   node tools/gen_locales.js
 */
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const DIR = path.join(HERE, 'locales');
const OUT = path.join(HERE, 'src', 'locales.js');
const TREE = path.join(HERE, fs.readdirSync(HERE).find((n) => /^robertn_waze_cluster@\d+\.\d+\.\d+$/.test(n)));
const TEXTS = path.join(TREE, 'rhmiData', 'variantGroups', 'Common', 'texts');

/* The string ids of application.json and uiDescription.json, in English. */
const RHMI_TEXTS = {
    SID_WOC_TITLE: 'Waze on cluster',
    SID_WOC_LOGS: 'Logs'
};

/* The HMI's English text files (the oap-sdk's names for ENGLISCH__UK and ENGLISCH__US). */
const ENGLISH = ['en_GB', 'en_US'];

/* The locales, by file name: { code, hmiLanguages, rhmiTexts, words }. */
function read() {
    return fs.readdirSync(DIR).filter((n) => /\.json$/.test(n)).sort().map((n) => {
        const l = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
        if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(n.slice(0, -5)) || !Array.isArray(l.hmiLanguages) ||
            !Array.isArray(l.rhmiTexts) || !l.words || typeof l.words !== 'object') {
            throw new Error(`locales/${n}: not a locale (hmiLanguages, rhmiTexts, words)`);
        }
        return Object.assign({ code: n.slice(0, -5) }, l);
    });
}

function source() {
    return "'use strict';\n/* The app's languages, written by tools/gen_locales.js from locales/*.json. */\n" +
        `module.exports = ${JSON.stringify(read(), null, 1)};\n`;
}

/* The RHMI text files, by file name: English, and each locale's (its rhmiTexts). */
function texts() {
    const out = {};
    ENGLISH.forEach((n) => { out[`${n}.json`] = RHMI_TEXTS; });
    read().forEach((l) => {
        const file = {};
        Object.keys(RHMI_TEXTS).forEach((id) => {
            const en = RHMI_TEXTS[id];
            file[id] = Object.prototype.hasOwnProperty.call(l.words, en) ? l.words[en] : en;
        });
        l.rhmiTexts.forEach((n) => { out[`${n}.json`] = file; });
    });
    return out;
}

function write() {
    fs.writeFileSync(OUT, source());
    const files = texts();
    Object.keys(files).forEach((n) => fs.writeFileSync(path.join(TEXTS, n), JSON.stringify(files[n], null, 2) + '\n'));
}

if (require.main === module) {
    write();
    console.log(`wrote ${path.relative(process.cwd(), OUT)} and ${Object.keys(texts()).length} RHMI text files: ` +
        read().map((l) => l.code).join(', '));
}

module.exports = { read, source, texts, write, RHMI_TEXTS, OUT };
