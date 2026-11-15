// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
/* Where the map is drawn in its target: `map_rect` in the conf, "X,Y,W,H" in
 * the target's pixels from its top-left (cluster-render PROTOCOL.md, a
 * layer's rect), whichever target is current. The map is stretched to it.
 * Empty: the map area (map_geometry.h), all of the map slot. The target's
 * size is known only once the renderer answers, so the rect is checked
 * against it there (MapFeed). */
#ifndef WOC_MAP_RECT_H
#define WOC_MAP_RECT_H

#include <stdint.h>
#include <stdio.h>
#include <string>

namespace woc {

struct MapRect {
    uint32_t x = 0, y = 0, w = 0, h = 0;   /* w 0: the map area */

    bool set() const { return w != 0; }
    bool fits(uint32_t tw, uint32_t th) const { return (uint64_t)x + w <= tw && (uint64_t)y + h <= th; }
};

/* Parses `text` into *out. Returns null, or why it cannot be used. */
inline const char *parse_map_rect(const std::string &text, MapRect *out)
{
    *out = MapRect();
    if (text.empty())
        return nullptr;
    unsigned x, y, w, h;
    char tail;
    if (sscanf(text.c_str(), "%u,%u,%u,%u%c", &x, &y, &w, &h, &tail) != 4)
        return "must be X,Y,W,H, or empty";
    if (w < 16 || h < 16 || w > 4096 || h > 4096)
        return "the rect must be from 16x16 to 4096x4096";
    out->x = x;
    out->y = y;
    out->w = w;
    out->h = h;
    return nullptr;
}

}  // namespace woc

#endif
