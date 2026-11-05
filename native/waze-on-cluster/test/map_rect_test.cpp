// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
#include "map_rect.h"

#include <stdio.h>

using namespace woc;

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
    MapRect r;
    const char *e = parse_map_rect("", &r);
    expect(!e && !r.set(), "empty is the map area");
    e = parse_map_rect("0,0,1088,480", &r);
    expect(!e && r.set() && r.w == 1088 && r.h == 480, "the whole slot");
    expect(r.fits(1088, 480) && !r.fits(1087, 480), "fits its target only");
    e = parse_map_rect("40,20,900,338", &r);
    expect(!e && r.x == 40 && r.y == 20 && r.fits(1088, 480), "a smaller rect");
    e = parse_map_rect("200,0,900,480", &r);
    expect(!e && !r.fits(1088, 480), "parsed, but outside the slot");
    e = parse_map_rect("5000,0,900,480", &r);
    expect(!e && !r.fits(1920, 720), "an origin past any target parses and never fits");
    e = parse_map_rect("1,2,3", &r);
    expect(e && !r.set(), "three numbers");
    expect(parse_map_rect("0,0,1088,480x", &r) != nullptr, "trailing text");
    expect(parse_map_rect("0,0,8,8", &r) != nullptr, "too small");
    expect(parse_map_rect("0,0,5000,480", &r) != nullptr, "too large");

    e = parse_map_rect("0,0,8,8", &r);
    expect(e && !r.set(), "a bad map_rect is the map area, with a reason");

    if (failures)
        return 1;
    printf("map_rect_test: ok\n");
    return 0;
}
