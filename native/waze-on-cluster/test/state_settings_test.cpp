// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test of the app's saved choices (state_settings.h).
 * The turn box: hidden by default; the configuration's 0 shows it; a value
 * other than 0 or 1 hides it; the app's choice kept across a restart and
 * replacing the configuration's; a state file without the setting, or one
 * that cannot be read, hides it; one without the setting leaving the
 * configuration's value; the shipped waze-on-cluster.conf hides it;
 * a choice other than 0 or 1 refused; a state file that cannot be written
 * leaving the choice in effect.
 * The map: shown by default; the configuration's 0 takes it off the cluster;
 * a value other than 0 or 1 shows it; the app's choice kept across a restart
 * and replacing the configuration's; a state file written by a version
 * without the key leaving the configuration's value; one that cannot be read,
 * or with a bad value, showing it; the shipped configuration shows it.
 * Both: each key is in the state file only once the app changed it (or the
 * file held it), so a key the app never set keeps following the configuration;
 * the file is written whole, and its folder synced after the rename. */
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

/* The folder sync of a test: how often it was called, with which folder, and
 * the state file's content at that moment (the rename is done by then). */
static const std::string kSyncedFile = "/tmp/woc-state-test-" + std::to_string(getpid()) + ".conf";
static int sync_calls;
static std::string sync_dir, sync_content;
static bool sync_result = true;

static bool record_sync(const std::string &dir)
{
    sync_calls++;
    sync_dir = dir;
    sync_content = slurp(kSyncedFile);
    return sync_result;
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
    ok("a state file without the setting: the configuration's",
       !StateSettings("0", "1", path).hide() && StateSettings("1", "1", path).hide());
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

    /* a key is in the file only once the app changed it, or the file held it */
    unlink(path.c_str());
    {
        StateSettings s("0", "1", path);
        s.set_shown("0");
    }
    ok("both: the map first writes only the map", slurp(path) == "map_shown = 0\n");
    {
        StateSettings s("1", "1", path);   /* the owner edited the local conf's turn box from 0 to 1 */
        ok("both: the edited configuration wins for the turn box, the map as saved", s.hide() && !s.shown());
        ok("both: and with it at 0 again", !StateSettings("0", "1", path).hide());
        s.set_shown("1");
    }
    ok("both: a second map change still leaves the turn box out", slurp(path) == "map_shown = 1\n");
    unlink(path.c_str());
    {
        StateSettings s("1", "1", path);
        s.set_hide("0");
    }
    ok("both: the turn box first writes only the turn box", slurp(path) == "hide_bmw_guidance = 0\n");
    ok("both: the map follows the configuration meanwhile",
       !StateSettings("0", "0", path).shown() && StateSettings("0", "1", path).shown());
    {
        StateSettings s("1", "1", path);
        s.set_shown("0");
    }
    ok("both: then the map: both kept, written whole", slurp(path) == "hide_bmw_guidance = 0\nmap_shown = 0\n");
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
        ok("both: a file of a version before the key: the turn box as saved, the map as configured",
           !s.hide() && !s.shown());
        s.set_hide("1");
    }
    ok("both: and its map stays out of the file until the app sets it", slurp(path) == "hide_bmw_guidance = 1\n");
    std::ofstream(path) << "garbage\nhide_bmw_guidance = 0\n  map_shown = 0\nmap_shown=0\nfoo = 1\n";
    {
        StateSettings s("1", "1", path);
        ok("both: lines that are not the keys are ignored", !s.hide() && s.shown());
        s.set_hide("1");
    }
    ok("both: and dropped at the next write", slurp(path) == "hide_bmw_guidance = 1\n");
    std::ofstream(path) << "map_shown = maybe\nhide_bmw_guidance = 5\n";
    {
        StateSettings s("0", "0", path);
        ok("both: bad values: the safe one per key", s.hide() && s.shown());
        s.set_hide("0");
    }
    ok("both: a bad value held is rewritten as the safe one", slurp(path) == "hide_bmw_guidance = 0\nmap_shown = 1\n");
    std::ofstream(path) << "garbage\n";
    {
        StateSettings s("1", "0", path);
        s.set_shown("1");
    }
    ok("both: a file of garbage only: just the key set", slurp(path) == "map_shown = 1\n");
    std::ofstream(path) << "hide_bmw_guidance = 0\nmap_shown = 0\n";
    chmod(path.c_str(), 0);
    if (access(path.c_str(), R_OK) != 0) {   /* root reads it anyway */
        {
            StateSettings s("0", "0", path);
            ok("both: a file that cannot be read: both safe values", s.hide() && s.shown());
            s.set_shown("0");   /* unwritable too here (the folder is not): only the key set is written */
        }
        chmod(path.c_str(), 0644);
        ok("both: and holds neither key before the app sets one", slurp(path) == "map_shown = 0\n");
    }
    unlink(path.c_str());

    /* the folder is synced after the rename; a failed sync keeps the choice */
    {
        StateSettings s("1", "1", path, record_sync);
        ok("sync: nothing before a change", sync_calls == 0);
        ok("sync: a change syncs the folder once, with the new file already in place",
           s.set_shown("0") && sync_calls == 1 && sync_dir == "/tmp" && sync_content == "map_shown = 0\n" &&
               access((path + ".tmp").c_str(), F_OK) != 0);
        ok("sync: the other key too, the same way",
           s.set_hide("0") && sync_calls == 2 && sync_content == "hide_bmw_guidance = 0\nmap_shown = 0\n");
        sync_result = false;
        ok("sync: a folder that cannot be synced: the choice stays in effect, the file stays",
           s.set_shown("1") && s.shown() && sync_calls == 3 &&
               slurp(path) == "hide_bmw_guidance = 0\nmap_shown = 1\n");
        ok("sync: a refused value syncs nothing", !s.set_shown("2") && sync_calls == 3);
        sync_result = true;
    }
    {
        sync_calls = 0;
        StateSettings b("1", "1", "/nonexistent-dir/state.conf", record_sync);
        ok("sync: a state file that cannot be written never reaches the folder sync",
           b.set_hide("0") && !b.hide() && sync_calls == 0);
    }
    unlink(path.c_str());
    {
        StateSettings real("1", "1", path);   /* the real folder sync */
        ok("sync: the real one on the state file's folder", real.set_shown("1") && slurp(path) == "map_shown = 1\n");
        const std::string bare = "woc-state-test-" + std::to_string(getpid()) + ".conf";   /* the working folder */
        StateSettings in_cwd("1", "1", bare);
        ok("sync: the real one on a bare file name", in_cwd.set_shown("0") && slurp(bare) == "map_shown = 0\n");
        unlink(bare.c_str());
    }
    unlink(path.c_str());
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
