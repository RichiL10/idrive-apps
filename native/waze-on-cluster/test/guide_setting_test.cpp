// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test of the turn-box setting (guide_setting.h): hidden by default;
 * the configuration's 0 shows it; a value other than 0 or 1 hides it; the
 * app's choice kept across a restart and replacing the configuration's; a
 * state file without the setting, or one that cannot be read, hides it;
 * the shipped waze-on-cluster.conf hides it; a choice other than 0 or 1
 * refused; a state file that cannot be written leaving the choice in
 * effect. */
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <string>

#include "guide_setting.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

int main()
{
    const std::string path = "/tmp/woc-guide-test-" + std::to_string(getpid()) + ".conf";
    unlink(path.c_str());
    ok("default: hidden", GuideSetting("1", path).hide());
    ok("the configuration's 0: shown", !GuideSetting("0", path).hide());
    ok("the configuration's other values: hidden", GuideSetting("yes", path).hide() && GuideSetting("", path).hide());
    {
        GuideSetting g("1", path);
        ok("the app's 0: shown", g.set("0") && !g.hide());
        ok("a choice other than 0 or 1: refused, nothing changed", !g.set("2") && !g.set("") && !g.hide());
    }
    ok("after a restart: still shown, over the configuration's 1", !GuideSetting("1", path).hide());
    {
        GuideSetting g("0", path);
        ok("the app's 1: hidden", g.set("1") && g.hide());
    }
    ok("after a restart: hidden, over the configuration's 0", GuideSetting("0", path).hide());
    std::ofstream(path) << "hide_bmw_guidance = maybe\n";
    ok("a saved value other than 0 or 1: hidden", GuideSetting("0", path).hide());
    std::ofstream(path) << "garbage\n";
    ok("a state file without the setting: hidden", GuideSetting("0", path).hide());
    std::ofstream(path) << "hide_bmw_guidance = 0\n";
    chmod(path.c_str(), 0);
    if (access(path.c_str(), R_OK) != 0)   /* root reads it anyway */
        ok("a state file that cannot be read: hidden, over the configuration's 0", GuideSetting("0", path).hide());
    unlink(path.c_str());
    std::ifstream conf("waze-on-cluster.conf");
    std::string line, shipped;
    while (std::getline(conf, line))
        if (line.compare(0, 20, "hide_bmw_guidance = ") == 0)
            shipped = line.substr(20);
    ok("shipped: hide_bmw_guidance = 1, hidden", shipped == "1" && GuideSetting(shipped, path).hide());
    GuideSetting g("1", "/nonexistent-dir/state.conf");
    ok("a state file that cannot be written: the choice still in effect", g.set("0") && !g.hide());
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
