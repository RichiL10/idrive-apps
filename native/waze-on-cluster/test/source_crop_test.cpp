// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
#include "source_crop.h"

#include <stdio.h>
#include <stdlib.h>

using woc::SourceCrop;
using woc::crop_picture;
using woc::parse_source_crop;
using woc::rect_needs_reset;
using woc::RectRestarts;
using woc::sequence_needs_check;

static int failures = 0;

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

int main()
{
    SourceCrop c;
    expect(parse_source_crop("", &c) == nullptr && !c.enabled(), "empty is off");
    expect(!c.applies(1920, 1080), "off applies to nothing");

    expect(parse_source_crop("1920x1080:0,0,1088,480", &c) == nullptr, "a 1920x1080 crop parses");
    expect(c.enabled() && c.seq_w == 1920 && c.seq_h == 1080, "sequence size");
    expect(c.x == 0 && c.y == 0 && c.w == 1088 && c.h == 480, "rect");
    expect(c.applies(1920, 1080), "applies to its sequence");
    expect(!c.applies(1088, 480), "not to carplay's map-sized stream");
    expect(!c.applies(1920, 900), "not to another size");

    expect(parse_source_crop("1920x1080:416,300,1088,480", &c) == nullptr && c.x == 416 && c.y == 300, "centred rect");
    expect(parse_source_crop("1920x1080:832,600,1088,480", &c) == nullptr, "rect reaching the corner");

    expect(parse_source_crop("1920x1080:834,600,1088,480", &c) != nullptr && !c.enabled(), "rect past the right edge");
    expect(parse_source_crop("1920x1080:0,602,1088,480", &c) != nullptr, "rect past the bottom");
    expect(parse_source_crop("1920x1080:1,0,1088,480", &c) != nullptr, "odd x");
    expect(parse_source_crop("1920x1080:0,0,1087,480", &c) != nullptr, "odd width");
    expect(parse_source_crop("1920x1080:0,0,8,480", &c) != nullptr, "too narrow");
    expect(parse_source_crop("1920x1080", &c) != nullptr, "no rect");
    expect(parse_source_crop("1920x1080:0,0,1088,480x", &c) != nullptr, "trailing text");
    expect(parse_source_crop("0x1080:0,0,16,16", &c) != nullptr, "zero sequence");

    /* Per picture: Android Auto's 1280x720 cropped to its top 1280x564, then
     * CarPlay's 1088x480 after it in the same sequence left whole, then
     * Android Auto's cropped again. */
    expect(parse_source_crop("1280x720:0,0,1280,564", &c) == nullptr, "android auto crop parses");
    struct Pic { uint16_t x, y, w, h; } aa = {0, 0, 1280, 720}, cp = {0, 0, 1088, 480}, aa2 = {0, 0, 1280, 720};
    expect(crop_picture(c, &aa.x, &aa.y, &aa.w, &aa.h) && aa.x == 0 && aa.y == 0 && aa.w == 1280 && aa.h == 564, "android auto's picture cropped");
    expect(!crop_picture(c, &cp.x, &cp.y, &cp.w, &cp.h) && cp.x == 0 && cp.y == 0 && cp.w == 1088 && cp.h == 480, "carplay's picture after it left whole");
    expect(crop_picture(c, &aa2.x, &aa2.y, &aa2.w, &aa2.h) && aa2.h == 564, "android auto's cropped again");
    Pic off = {8, 4, 1280, 720};
    SourceCrop hidden;
    expect(parse_source_crop("1280x720:4,160,1270,560", &hidden) == nullptr, "a card-hidden crop parses");
    expect(crop_picture(hidden, &off.x, &off.y, &off.w, &off.h) && off.x == 12 && off.y == 164 && off.w == 1270 && off.h == 560,
           "the rect is inside the decoder's own visible rect");
    Pic done = {12, 164, 1270, 560};
    expect(!crop_picture(hidden, &done.x, &done.y, &done.w, &done.h) && done.x == 12, "a picture already cropped is left as it is");
    SourceCrop none;
    Pic any = {0, 0, 1280, 720};
    expect(!crop_picture(none, &any.x, &any.y, &any.w, &any.h) && any.w == 1280 && any.h == 720, "no crop: every picture whole");

    /* A bad value is no crop, with why: the whole picture. */
    SourceCrop bad;
    expect(parse_source_crop("1280x720:0,0,1281,564", &bad) != nullptr && !bad.enabled(), "a bad src_crop is no crop, with a reason");

    /* VPP is set up again when a picture's rect after the crop differs from
     * the one it has. */
    SourceCrop aac;
    parse_source_crop("1280x720:0,0,1280,564", &aac);
    expect(!rect_needs_reset(aac, 1280, 564, 1280, 720), "set up for android auto's crop: its next picture needs nothing");
    expect(rect_needs_reset(aac, 1280, 564, 1088, 480), "a carplay picture after it needs a reset");
    expect(!rect_needs_reset(aac, 1088, 480, 1088, 480), "set up for carplay: its next picture needs nothing");
    expect(rect_needs_reset(aac, 1088, 480, 1280, 720), "an android auto picture after it needs a reset");
    expect(rect_needs_reset(SourceCrop(), 1280, 564, 1280, 720), "no crop: a whole picture differs from a cropped setup");

    /* Which sequences need the per-picture decision. */
    expect(!sequence_needs_check(SourceCrop(), 1280, 720, 1280, 720), "no crop: none");
    expect(!sequence_needs_check(aac, 1088, 480, 1088, 480), "carplay's sequence in carplay's rect: none");
    expect(sequence_needs_check(aac, 1280, 564, 1280, 720), "android auto's: cropped");
    expect(sequence_needs_check(aac, 1280, 564, 1088, 480), "carplay's in android auto's rect: needs another");
    expect(sequence_needs_check(aac, 1920, 1080, 1280, 720), "android auto's in a larger whole rect");
    expect(sequence_needs_check(aac, 1088, 480, 0, 0), "a sequence of unknown size");

    /* A rect restart never repeats until a picture fits VPP's rect. */
    RectRestarts rr;
    rr.started(false);
    expect(!rr.restart(false), "a fitting picture: no restart");
    expect(rr.restart(true), "a picture needing another rect after an SPS start: restart");
    rr.started(true);
    expect(!rr.restart(true) && !rr.restart(true), "after the rect restart, a picture still not fitting: converted as is, again and again");
    expect(rr.warn() && !rr.warn(), "with one warning");
    expect(!rr.restart(false), "a picture that fits");
    expect(rr.restart(true), "then a size change restarts again (android auto, carplay, android auto)");

    if (failures)
        return 1;
    printf("source_crop_test: ok\n");
    return 0;
}
