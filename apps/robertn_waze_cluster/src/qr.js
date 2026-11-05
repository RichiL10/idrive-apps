// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * A QR code as a PNG the HMI shows: the text at error correction level M
 * (src/qrcodegen.js), black on white with the 4-module quiet zone, each module
 * a whole number of pixels so the picture stays sharp, at most maxPx wide.
 * qrPng(null) is a blank white square of maxPx, for no code.
 */
'use strict';

const zlib = require('zlib');
const qrcodegen = require('./qrcodegen.js');

const QUIET = 4;
const MAX_PX = 360;

const CRC_TABLE = (() => {
    const t = [];
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t.push(c >>> 0);
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/** { png: Buffer, width, modules } for text (RGBA, deflated). */
function qrPng(text, maxPx) {
    const max = maxPx || MAX_PX;
    const code = text ? qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM) : null;
    const modules = code ? code.size + 2 * QUIET : max;
    const scale = Math.max(1, Math.floor(max / modules));
    const width = modules * scale;
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * width, 255);
    for (let y = 0; y < width; y += 1) {
        raw[y * stride] = 0;
        const my = Math.floor(y / scale) - QUIET;
        for (let mx = 0; code && my >= 0 && my < code.size && mx < code.size; mx += 1) {
            if (code.getModule(mx, my)) {
                const x0 = (mx + QUIET) * scale;
                raw.fill(0, y * stride + 1 + x0 * 4, y * stride + 1 + (x0 + scale) * 4);
                for (let x = x0; x < x0 + scale; x += 1) {
                    raw[y * stride + 1 + x * 4 + 3] = 255;
                }
            }
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(width, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
    return { png, width, modules: code ? code.size : 0 };
}

module.exports = { qrPng };
