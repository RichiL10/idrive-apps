// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test of the app's saved choices (state_settings.h).
 * The turn box: hidden by default; the configuration's 0 shows it; a value
 * other than 0 or 1 hides it; the app's choice kept across a restart and
 * replacing the configuration's; a state file without the setting, or one
 * that cannot be read, hides it; the shipped waze-on-cluster.conf hides it;
 * a choice other than 0 or 1 refused; a state file that cannot be written
 * leaving the choice in effect.
 * The map: shown by default; the configuration's 0 takes it off the cluster;
 * a value other than 0 or 1 shows it; the app's choice kept across a restart
 * and replacing the configuration's; a state file written by a version
 * without the key leaving the configuration's value; one that cannot be read,
 * or with a bad value, showing it; the shipped configuration shows it.
 * Both: either change keeps the other choice in the file, written whole. */
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "control.h"
#include "state_settings.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static std::string slurp(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

/* What the service does with a control line {"cmd":"map","shown":...}: the value
 * parsed from it must be one set_shown takes; a line without it, or with
 * another value, changes nothing. */
static bool map_command(StateSettings *s, const std::string &line)
{
    std::map<std::string, std::string> msg;
    return parse_flat_json(line, &msg) && msg["cmd"] == "map" && msg.count("shown") && s->set_shown(msg["shown"]);
}

/* The configuration's value of key in the shipped waze-on-cluster.conf. */
static std::string shipped(const std::string &key)
{
    std::ifstream conf("waze-on-cluster.conf");
    std::string line, value = "(none)";
    const std::string prefix = key + " = ";
    while (std::getline(conf, line))
        if (line.compare(0, prefix.size(), prefix) == 0)
            value = line.substr(prefix.size());
    return value;
}

int main()
{
    const std::string path = "/tmp/woc-state-test-" + std::to_string(getpid()) + ".conf";
    unlink(path.c_str());
    ok("default: hidden", StateSettings("1", "1", path).hide());
    ok("the configuration's 0: shown", !StateSettings("0", "1", path).hide());
    ok("the configuration's other values: hidden",
       StateSettings("yes", "1", path).hide() && StateSettings("", "1", path).hide());
    {
        StateSettings g("1", "1", path);
        ok("the app's 0: shown", g.set_hide("0") && !g.hide());
        ok("a choice other than 0 or 1: refused, nothing changed",
           !g.set_hide("2") && !g.set_hide("") && !g.hide());
    }
    ok("after a restart: still shown, over the configuration's 1", !StateSettings("1", "1", path).hide());
    {
        StateSettings g("0", "1", path);
        ok("the app's 1: hidden", g.set_hide("1") && g.hide());
    }
    ok("after a restart: hidden, over the configuration's 0", StateSettings("0", "1", path).hide());
    std::ofstream(path) << "hide_bmw_guidance = maybe\n";
    ok("a saved value other than 0 or 1: hidden", StateSettings("0", "1", path).hide());
    std::ofstream(path) << "garbage\n";
    ok("a state file without the setting: hidden", StateSettings("0", "1", path).hide());
    std::ofstream(path) << "hide_bmw_guidance = 0\n";
    chmod(path.c_str(), 0);
    if (access(path.c_str(), R_OK) != 0) {   /* root reads it anyway */
        ok("a state file that cannot be read: hidden, over the configuration's 0",
           StateSettings("0", "1", path).hide());
        ok("a state file that cannot be read: the map shown, over the configuration's 0",
           StateSettings("1", "0", path).shown());
    }
    unlink(path.c_str());
    ok("shipped: hide_bmw_guidance = 1, hidden", shipped("hide_bmw_guidance") == "1" &&
                                                   StateSettings(shipped("hide_bmw_guidance"), "1", path).hide());
    StateSettings g("1", "1", "/nonexistent-dir/state.conf");
    ok("a state file that cannot be written: the choice still in effect", g.set_hide("0") && !g.hide());

    unlink(path.c_str());
    ok("map: shown by default", StateSettings("1", "1", path).shown());
    ok("map: the configuration's 0: off", !StateSettings("1", "0", path).shown());
    ok("map: the configuration's other values: shown",
       StateSettings("1", "no", path).shown() && StateSettings("1", "", path).shown() &&
           StateSettings("1", "2", path).shown());
    {
        StateSettings s("1", "1", path);
        ok("map: the app's 0: off", s.set_shown("0") && !s.shown());
        ok("map: a choice other than 0 or 1: refused, nothing changed",
           !s.set_shown("2") && !s.set_shown("") && !s.set_shown("off") && !s.shown());
        ok("map: the choice does not touch the turn box", s.hide());
    }
    ok("map: after a restart, still off over the configuration's 1", !StateSettings("1", "1", path).shown());
    {
        StateSettings s("1", "0", path);
        ok("map: the app's 1: shown", s.set_shown("1") && s.shown());
    }
    ok("map: after a restart, shown over the configuration's 0", StateSettings("1", "0", path).shown());
    std::ofstream(path) << "hide_bmw_guidance = 1\nmap_shown = maybe\n";
    ok("map: a saved value other than 0 or 1: shown", StateSettings("1", "0", path).shown());
    std::ofstream(path) << "garbage\n";
    ok("map: a state file without the key: the configuration's", !StateSettings("1", "0", path).shown() &&
                                                                  StateSettings("1", "1", path).shown());
    std::ofstream(path) << "hide_bmw_guidance = 0\n";
    ok("map: a state file of a version before it: the configuration's, the turn box as saved",
       !StateSettings("1", "0", path).shown() && StateSettings("1", "1", path).shown() &&
           !StateSettings("1", "0", path).hide());
    unlink(path.c_str());
    ok("map: shipped map_shown = 1, shown", shipped("map_shown") == "1" &&
                                              StateSettings("1", shipped("map_shown"), path).shown());
    StateSettings bad("1", "1", "/nonexistent-dir/state.conf");
    ok("map: a state file that cannot be written: the choice still in effect",
       bad.set_shown("0") && !bad.shown() && bad.set_shown("1") && bad.shown());

    unlink(path.c_str());
    {
        StateSettings s("1", "1", path);
        ok("control: {\"cmd\":\"map\",\"shown\":0} switches the map off", map_command(&s, "{\"cmd\":\"map\",\"shown\":0}") && !s.shown());
        ok("control: {\"cmd\":\"map\",\"shown\":1} switches it on", map_command(&s, "{\"cmd\":\"map\",\"shown\":1}") && s.shown());
        ok("control: a quoted 0 or 1 is taken as well", map_command(&s, "{\"cmd\":\"map\",\"shown\":\"0\"}") && !s.shown() &&
                                                         map_command(&s, "{\"cmd\":\"map\",\"shown\":\"1\"}") && s.shown());
        ok("control: other values, a missing value and a line that is not the protocol are refused, nothing changes",
           !map_command(&s, "{\"cmd\":\"map\",\"shown\":2}") && !map_command(&s, "{\"cmd\":\"map\",\"shown\":true}") &&
               !map_command(&s, "{\"cmd\":\"map\",\"shown\":-1}") && !map_command(&s, "{\"cmd\":\"map\",\"shown\":\"\"}") &&
               !map_command(&s, "{\"cmd\":\"map\"}") && !map_command(&s, "{\"cmd\":\"map\",\"hide\":0}") &&
               !map_command(&s, "{\"cmd\":\"map\",\"shown\":0") && s.shown());
    }

    /* both keys, written whole, whichever changes */
    unlink(path.c_str());
    {
        StateSettings s("0", "1", path);   /* the configuration's turn box 0 is what the file takes */
        s.set_shown("0");
    }
    ok("both: the map's change writes both keys, the turn box as it was in effect",
       slurp(path) == "hide_bmw_guidance = 0\nmap_shown = 0\n");
    {
        StateSettings s("1", "1", path);
        ok("both: read back, the saved choices over the configuration's", !s.hide() && !s.shown());
        s.set_hide("1");
    }
    ok("both: the turn box's change keeps the map's", slurp(path) == "hide_bmw_guidance = 1\nmap_shown = 0\n");
    {
        StateSettings s("0", "1", path);
        ok("both: read back", s.hide() && !s.shown());
        s.set_shown("1");
    }
    ok("both: the map shown again keeps the turn box", slurp(path) == "hide_bmw_guidance = 1\nmap_shown = 1\n");
    ok("both: no temporary file left", access((path + ".tmp").c_str(), F_OK) != 0);
    std::ofstream(path) << "hide_bmw_guidance = 0\n";   /* a file of a version before map_shown */
    {
        StateSettings s("1", "0", path);
        s.set_hide("1");
    }
    ok("both: a file of a version before the key gets it from the configuration's value",
       slurp(path) == "hide_bmw_guidance = 1\nmap_shown = 0\n");
    unlink(path.c_str());
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
