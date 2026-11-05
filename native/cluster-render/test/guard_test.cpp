/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the mapping guard (guard.h): a strike kept in its file and
 * read back; a hold's mapping disabled at its strike limit, also after a
 * reboot; a target with limit 0 (the default) never disabled; the map's
 * mapping (0x100, 0x010004f0) never disabled whatever its limit, nor by a
 * file that says it is; another version's file started over; a strike
 * expiring after 3 new boots with no other strike (not after a reload in
 * the same boot), a disabled mapping kept; a removed file starting over; a
 * file that does not read started over; a file that cannot be written
 * leaving the guard working. */
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <string>

#include "../src/guard.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const std::string kPath = "/tmp/crs-guard-test-" + std::to_string(getpid()) + ".txt";

static TargetSpec spec(const char *name, uint64_t slot, uint64_t scene, int limit)
{
    TargetSpec t;
    t.name = name;
    t.slot = slot;
    t.scene_id = scene;
    t.strike_limit = limit;
    return t;
}

static const TargetSpec kHold = spec("guide_0x105", 0x105, 0x010004f1, 2);

static TargetSpec panel()
{
    TargetSpec t;   /* the default strike limit, as main.cpp makes it */
    t.name = "panel";
    t.slot = 0x203;
    t.scene_id = 0x01000400;
    return t;
}

/* A guard read from the file, as at a start of cluster-render. */
static void load(Guard *g, const char *version = "0.3.7", const char *boot = "boot-1")
{
    g->load(kPath, version, boot);
}

int main()
{
    unlink(kPath.c_str());
    {
        Guard g;
        load(&g);
        ok("no file: no strike", g.status_text().empty() && !g.disabled(kHold));
        ok("one strike: not disabled", !g.strike(kHold, "the display service went away") && !g.disabled(kHold));
    }
    {
        Guard g;
        load(&g);
        ok("read back: one strike", g.status_text() == "guard: guide_0x105 0x105 0x10004f1 0: 1 strike\n");
        ok("the second: disabled", g.strike(kHold, "the hold gave up") && g.disabled(kHold));
        ok("another mapping of the target is not", !g.disabled(spec("guide_0x105", 0x103, 0x010004f1, 2)));
        for (int k = 0; k < 5; k++)
            g.strike(panel(), "the display service went away");
        ok("the default strike limit: never disabled", panel().strike_limit == 0 && !g.disabled(panel()));
        const TargetSpec map = spec("map", 0x100, 0x010004f0, 2);
        for (int k = 0; k < 3; k++)
            g.strike(map, "the display service went away");
        ok("the map's mapping with limit 2: never disabled", !g.disabled(map));
    }
    {
        Guard g;
        load(&g, "0.3.7", "boot-2");
        ok("after a reboot: still disabled, the panel's strikes kept",
           g.disabled(kHold) && g.status_text() == "guard: guide_0x105 0x105 0x10004f1 0: disabled, 2 strikes\n"
                                                   "guard: map 0x100 0x10004f0 0: 3 strikes\n"
                                                   "guard: panel 0x203 0x1000400 0: 5 strikes\n");
    }
    std::ofstream(kPath) << "version 0.3.7\nboot boot-2\nmap 0x100 0x10004f0 0 1 0 2\npanel 0x203 0x1000400 0 1 0 2\n";
    {
        Guard g;
        load(&g, "0.3.7", "boot-2");
        ok("a file saying the map or the panel is disabled: neither is",
           !g.disabled(spec("map", 0x100, 0x010004f0, 2)) && !g.disabled(panel()));
    }
    {
        Guard g;
        load(&g, "0.3.8", "boot-2");
        ok("another version: started over", !g.disabled(kHold) && g.status_text().empty());
        g.strike(kHold, "the display service went away");
        g.strike(kHold, "the display service went away");
    }
    for (const char *boot : {"boot-3", "boot-4", "boot-5"}) {
        Guard g;
        load(&g, "0.3.8", boot);
    }
    {
        Guard g;
        load(&g, "0.3.8", "boot-5");
        ok("a disabled mapping does not expire", g.disabled(kHold));
    }
    unlink(kPath.c_str());
    {
        Guard g;
        load(&g, "0.3.8", "boot-5");
        ok("the file removed (guard-reset): nothing disabled", !g.disabled(kHold) && g.status_text().empty());
        g.strike(kHold, "the display service went away");
    }
    for (const char *boot : {"boot-5", "boot-6", "boot-7"}) {
        Guard g;
        load(&g, "0.3.8", boot);
    }
    {
        Guard g;
        load(&g, "0.3.8", "boot-7");
        ok("two new boots and reloads: the strike still counts",
           g.status_text() == "guard: guide_0x105 0x105 0x10004f1 0: 1 strike\n");
    }
    {
        Guard g;
        load(&g, "0.3.8", "boot-8");
        ok("the third new boot without a strike: expired", g.status_text().empty());
    }
    {
        std::ofstream(kPath) << "version 0.3.8\nboot boot-8\nguide_0x105 0x105\n";
        Guard g;
        load(&g, "0.3.8", "boot-8");
        ok("a file that does not read: started over", g.status_text().empty() && !g.disabled(kHold));
    }
    {
        Guard g;
        g.load("/nonexistent-dir/guard.txt", "0.3.8", "boot-8");
        g.strike(kHold, "the display service went away");
        ok("a file that cannot be written: the guard still disables",
           g.strike(kHold, "the display service went away") && g.disabled(kHold));
    }
    unlink(kPath.c_str());
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
