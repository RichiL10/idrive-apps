/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The guide hold's settings (cluster-render.conf "guide hold", iDrive 7):
 * unless guide_hold = 0, a hold (slots.h) that follows the map, appended to
 * the targets: one in 0x105 or 0x103, as the slot table reports them and
 * the box in them (guide_slots = auto), or one per slot of guide_slots; the
 * mapping guard disables a hold at its second strike (guard.h). */
#ifndef CRS_HOLDS_H
#define CRS_HOLDS_H

#include <stdint.h>
#include <string>
#include <vector>

#include "slots.h"

namespace crs {

/* The settings as written. */
struct HoldSettings {
    std::string hold, slots, scene_id, content_class, take_over;   /* guide_hold, guide_slots, ... */
};

/* Appends a hold per slot of slots unless hold is 0; hold other than 0 or 1
 * counts as 1, with *warn saying so. slots: auto, one hold guide_auto with
 * scene_id whose slot is 0x105 or 0x103 (TargetSpec::table_slots),
 * neither another target's; or hex slot ids 0x1-0xfff, separated by commas
 * or spaces, each once and no other target's. Scene ids from scene_id up,
 * one per slot, each in allowed and no other target's.
 * take_over: the hex content ids the holds' take-overs may unmap, at least
 * one, separated the same way, never 0x01000314 (the seat-belt-warning
 * panel). Anything else adds no hold: false, with *warn naming it, and
 * targets left as they were. */
bool load_holds(const HoldSettings &cfg, const std::vector<uint64_t> &allowed, std::vector<TargetSpec> *targets,
                std::string *warn);

/* A target's <target>_take_over_contents (TargetSpec::take_over_contents):
 * the stock contents its take-over may unmap, scene ids separated by commas
 * or spaces, decimal or 0x hex; empty: none, the target takes nothing over.
 * Each must be a whole number without a sign, not out of range, a stock
 * HMI content (0x0100xxxx), not one of allowed (our own scene ids) and not
 * 0x01000314 (the seat-belt-warning panel, as for guide_take_over); one
 * listed twice counts once. key names the setting in *why. Anything else:
 * false, with *why saying what was wrong and *out left empty. The guide
 * hold's own list (guide_take_over, load_holds) is separate: it is what
 * the holds' take-overs may unmap and what they yield to. */
bool parse_take_over_contents(const std::string &key, const std::string &list, const std::vector<uint64_t> &allowed,
                              std::vector<uint64_t> *out, std::string *why);

}  // namespace crs

#endif
