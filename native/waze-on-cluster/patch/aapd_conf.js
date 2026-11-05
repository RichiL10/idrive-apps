// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
// Copyright (C) 2026 Robert Nisipeanu
/* aapd_conf.js — the cluster geometry Android Auto is given, in /etc/aapd.conf
 * (PATCH.md "Android Auto: the geometry").
 *
 * aapd describes its cluster display to the phone from the KOMBI_DISPLAY
 * block, for the screen size its KombiVariant maps to (aapd_patch.js
 * "screen": 12.3 on a KI_KOMBI_VARIANT 7 car): the DIMENSIONS "12.3" entry
 * and the HIGH_1080P codec definition CODEC_SUPPORTED names for it. The
 * video resolution follows CODEC_HEIGHT (480 -> 800x480, 720 -> 1280x720,
 * 1080 -> 1920x1080), the density REPORTED_SCREEN_DENSITY, and the margins
 * are
 *     left/top     = OFFSET_LEFT/TOP_TARGET_VIEWPORT
 *     right/bottom = HORIZONTAL/VERTICAL_MARGIN_SIZE - left/top
 * with the content insets the entry's safe area (SA_*PIXELS) less that
 * offset.
 *
 * The edit asks for a 1280x720 stream with the UI in its top 1280x564, the
 * map slot's 2.27:1 (as proven on a car), at the owner's density
 * (DENSITIES; a lower one shows more map with smaller text). The decoder
 * crops the picture to that UI and scales it 0.85x into the 1088x480 slot
 * (srcCrop). The safe area is the CarPlay patch's for the slot (504x368 at
 * 286,72) at that scale, 592x432 at 336,84, so the phone keeps its turn
 * card where the gauges leave the slot clear. With the turn card hidden the
 * UI is the whole picture and the safe area starts at its top, where Maps
 * pins the card, and the crop cuts the card's rows off (cardCut). The
 * numbers are replaced in place; the rest of the file stays byte for
 * byte.
 *
 * Node 8 on the unit, no dependencies. */
'use strict';

/* /etc/aapd.conf of MGU P18_23w44.2-1-3. */
var ORIGINAL_SHA256 = '9584c540f287bb79744e79cf973795208719ca798f13d881c4dac582656b0f16';

var DENSITY_MIN = 150, DENSITY_MAX = 400, DENSITY_STEP = 10, DEFAULT_DPI = 180;
var CARDS = ['shown', 'hidden'], DEFAULT_CARD = 'shown';
var DENSITIES = [];
for (var d = DENSITY_MIN; d <= DENSITY_MAX; d += DENSITY_STEP) DENSITIES.push(d);

var CODEC = 'SCREENS/KOMBI_DISPLAY/CODEC_DEFINITION/HIGH_1080P/';
var DIMS = 'SCREENS/KOMBI_DISPLAY/DIMENSIONS/12.3/';
var BLOCK = 'SCREENS/KOMBI_DISPLAY/';

/* The stream, the part of it the phone draws its UI in, and the safe area,
 * for each turn-card setting. Hidden keeps the safe area's lower edge where
 * the shown layout has it on the cluster (672 = 84 + 432 + 156). */
var STREAM = { w: 1280, h: 720 };
var GEOMETRY = {
    shown: { codec: STREAM, ui: { x: 0, y: 0, w: 1280, h: 564 }, safe: { x: 336, y: 84, w: 592, h: 432 } },
    hidden: { codec: STREAM, ui: { x: 0, y: 0, w: 1280, h: 720 }, safe: { x: 336, y: 0, w: 592, h: 672 } },
};
var SLOT = { w: 1088, h: 480 };

/* The rows the crop cuts off the top with the card hidden: the card's
 * bottom edge is about 0.62 x dpi rows down, so at least the shown layout's
 * 156 rows, else that plus 10, rounded up to even. */
var CARD_CUT = STREAM.h - GEOMETRY.shown.ui.h;
function cardCut(dpi) { return Math.max(CARD_CUT, Math.ceil((0.62 * dpi + 10) / 2) * 2); }

/* waze-on-cluster's src_crop for a geometry: the UI with the card shown;
 * with it hidden, the rows under the card, narrowed and centred to keep the
 * slot's 1088:480 when fewer than 564 rows are left. Every number even. */
function srcCrop(card, dpi) {
    var W = STREAM.w, H = STREAM.h, keep = H - CARD_CUT;
    if (card !== 'hidden') return W + 'x' + H + ':0,0,' + W + ',' + keep;
    var cut = cardCut(dpi), h = H - cut;
    if (h >= keep) return W + 'x' + H + ':0,' + cut + ',' + W + ',' + keep;
    var w = Math.min(W, Math.round(h * SLOT.w / SLOT.h / 2) * 2), x = Math.floor((W - w) / 4) * 2;
    return W + 'x' + H + ':' + x + ',' + cut + ',' + w + ',' + h;
}

/* Every number in a JSON text, by its key path ("A/B/C"), with its span. */
function numberSpans(text) {
    var spans = {};
    var i = 0;
    function ws() { while (i < text.length && /\s/.test(text[i])) i++; }
    function str() {
        var start = ++i;
        while (text[i] !== '"') { if (text[i] === '\\') i++; i++; if (i >= text.length) throw new Error('unterminated string'); }
        return text.slice(start, i++);
    }
    function value(p) {
        ws();
        var c = text[i];
        if (c === '{') {
            i++; ws();
            if (text[i] === '}') { i++; return; }
            for (;;) {
                ws();
                if (text[i] !== '"') throw new Error('key expected at ' + i);
                var k = str();
                ws();
                if (text[i++] !== ':') throw new Error('colon expected at ' + i);
                value(p ? p + '/' + k : k);
                ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === '}') { i++; return; }
                throw new Error('comma or } expected at ' + i);
            }
        }
        if (c === '[') {
            i++; ws();
            if (text[i] === ']') { i++; return; }
            for (var n = 0; ; n++) {
                value(p + '/' + n);
                ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === ']') { i++; return; }
                throw new Error('comma or ] expected at ' + i);
            }
        }
        if (c === '"') { str(); return; }
        var m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?|^(true|false|null)/.exec(text.slice(i, i + 40));
        if (!m) throw new Error('value expected at ' + i);
        if (!m[3]) spans[p] = [i, i + m[0].length, Number(m[0])];
        i += m[0].length;
    }
    value('');
    ws();
    if (i !== text.length) throw new Error('trailing text at ' + i);
    return spans;
}

function mm(px, dpi) { return Math.round(px / dpi * 25.4 * 1000) / 1000; }

/* The values the edit at dpi and card sets, by key path. */
function wanted(dpi, card) {
    var g = GEOMETRY[card], w = {};
    w[CODEC + 'CODEC_WIDTH'] = g.codec.w;
    w[CODEC + 'CODEC_HEIGHT'] = g.codec.h;
    w[CODEC + 'REPORTED_SCREEN_DENSITY'] = dpi;
    w[CODEC + 'REAL_SCREEN_DENSITY'] = dpi;
    w[CODEC + 'HORIZONTAL_MARGIN_SIZE'] = g.codec.w - g.ui.w;
    w[CODEC + 'VERTICAL_MARGIN_SIZE'] = g.codec.h - g.ui.h;
    w[CODEC + 'OFFSET_LEFT_TARGET_VIEWPORT'] = g.ui.x;
    w[CODEC + 'OFFSET_TOP_TARGET_VIEWPORT'] = g.ui.y;
    w[CODEC + 'WIDTH_TARGET_VIEWPORT'] = g.ui.w;
    w[CODEC + 'HEIGHT_TARGET_VIEWPORT'] = g.ui.h;
    w[DIMS + 'SA_PHYSICALDENSITY'] = dpi;
    w[DIMS + 'SA_OFFSET_LEFTPIXELS'] = g.safe.x;
    w[DIMS + 'SA_OFFSET_TOPPIXELS'] = g.safe.y;
    w[DIMS + 'SA_WIDTHPIXELS'] = g.safe.w;
    w[DIMS + 'SA_HEIGHTPIXELS'] = g.safe.h;
    w[DIMS + 'SA_WIDTH'] = mm(g.safe.w, dpi);
    w[DIMS + 'SA_HEIGHT'] = mm(g.safe.h, dpi);
    return w;
}

/* The original's text edited for dpi and card, or throws why it cannot be. */
function transform(text, dpi, card) {
    if (DENSITIES.indexOf(dpi) < 0) throw new Error('density ' + dpi + ' is not ' + DENSITY_MIN + '-' + DENSITY_MAX + ' in steps of ' + DENSITY_STEP);
    if (CARDS.indexOf(card) < 0) throw new Error('card ' + card + ' is not one of ' + CARDS.join(', '));
    var spans = numberSpans(text), w = wanted(dpi, card), keys = Object.keys(w);
    keys.forEach(function (k) { if (!spans[k]) throw new Error('no ' + k); });
    keys.sort(function (a, b) { return spans[b][0] - spans[a][0]; });
    var out = text;
    keys.forEach(function (k) { out = out.slice(0, spans[k][0]) + String(w[k]) + out.slice(spans[k][1]); });
    var check = numberSpans(out);
    keys.forEach(function (k) { if (check[k][2] !== w[k]) throw new Error('edit of ' + k + ' did not take'); });
    return out;
}

/* {dpi, card} of `cur` when it is the edit of `orig` at one of DENSITIES
 * and CARDS, else null. */
function edited(orig, cur) {
    for (var c = 0; c < CARDS.length; c++) {
        for (var i = 0; i < DENSITIES.length; i++) {
            try { if (transform(orig, DENSITIES[i], CARDS[c]) === cur) return { dpi: DENSITIES[i], card: CARDS[c] }; } catch (e) { return null; }
        }
    }
    return null;
}

/* Why `cur` is not the file `orig` is the original of, or null: the same
 * text but for numbers in the KOMBI_DISPLAY block. Independent of the
 * geometry, so any edit there of any version of this tool is undone. */
function otherFile(cur, orig) {
    var a, b;
    try { a = numberSpans(cur); } catch (e) { return 'it is not JSON (' + e.message + ')'; }
    b = numberSpans(orig);
    function masked(text, spans) {
        var keys = Object.keys(spans).sort(function (x, y) { return spans[y][0] - spans[x][0]; }), out = text;
        keys.forEach(function (k) { out = out.slice(0, spans[k][0]) + '#' + out.slice(spans[k][1]); });
        return out;
    }
    if (masked(cur, a) !== masked(orig, b)) return 'its text differs outside the numbers';
    var outside = Object.keys(a).filter(function (k) { return a[k][2] !== b[k][2] && k.indexOf(BLOCK) !== 0; });
    return outside.length ? outside[0] + ' differs' : null;
}

module.exports = {
    ORIGINAL_SHA256: ORIGINAL_SHA256, GEOMETRY: GEOMETRY, DENSITIES: DENSITIES, DEFAULT_DPI: DEFAULT_DPI,
    DENSITY_MIN: DENSITY_MIN, DENSITY_MAX: DENSITY_MAX, DENSITY_STEP: DENSITY_STEP, CARDS: CARDS, DEFAULT_CARD: DEFAULT_CARD,
    transform: transform, edited: edited, otherFile: otherFile, srcCrop: srcCrop,
};
