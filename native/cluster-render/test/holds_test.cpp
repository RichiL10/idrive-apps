/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the guide hold's settings (holds.h): on as shipped
 * (cluster-render.conf), its slot from the slot table (guide_slots = auto)
 * and its scene id in the shipped scene_ids_allowed, and with 1, off with
 * 0; auto alone, one hold with guide_scene_id in 0x105 or 0x103, never
 * with slot ids or with another target in either; one
 * hold per slot of guide_slots following the map, scene ids from
 * guide_scene_id up;
 * separators commas or spaces; guide_hold other than 0 or 1 taken as 1 with
 * a warning; every other malformed value refused with what was wrong and no
 * target added: a slot that is not whole hex from 0x1 to 0xfff, a slot
 * listed twice or another target's, a scene id not allowed or another
 * target's, a take-over content that is not whole hex, none, no map, no
 * slot. */
#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <cstdio>
#include <string>
#include <vector>

#include "../src/holds.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const std::vector<uint64_t> kAllowed = {0x010004f0, 0x010004f1, 0x010004f2};

/* key's value in the shipped cluster-render.conf. */
static std::string shipped(const std::string &key)
{
    std::ifstream f("cluster-render.conf");
    for (std::string line; std::getline(f, line);)
        if (line.compare(0, key.size() + 2, key + " =") == 0) {
            /* "key = value", or "key =" for an empty one */
            const size_t at = line.find_first_not_of(' ', key.size() + 2);
            return at == std::string::npos ? std::string() : line.substr(at);
        }
    return "?";
}

/* The targets with the map, after load_holds with the given settings over
 * the shipped defaults (key=value). */
static bool load(const std::vector<std::string> &pairs, std::vector<TargetSpec> *t, std::string *err)
{
    HoldSettings h{shipped("guide_hold"), "0x105", "0x010004f1", "0", "0x01000310"};
    for (const std::string &p : pairs) {
        const std::string k = p.substr(0, p.find('=')), v = p.substr(p.find('=') + 1);
        (k == "guide_hold"       ? h.hold
         : k == "guide_slots"    ? h.slots
         : k == "guide_scene_id" ? h.scene_id
         : k == "guide_take_over" ? h.take_over
                                  : h.content_class) = v;
    }
    TargetSpec map;
    map.name = "map";
    map.slot = 0x100;
    map.scene_id = 0x010004f0;
    *t = {map};
    err->clear();
    return load_holds(h, kAllowed, t, err);
}

static bool refused(const std::vector<std::string> &pairs, const std::string &why)
{
    std::vector<TargetSpec> t;
    std::string err;
    const bool good = !load(pairs, &t, &err) && t.size() == 1 && err.find(why) != std::string::npos;
    if (!good)
        std::printf("     got \"%s\", %zu targets\n", err.c_str(), t.size());
    return good;
}

int main()
{
    std::vector<TargetSpec> t;
    std::string err;
    ok("shipped: a hold", shipped("guide_hold") == "1" && load({}, &t, &err) && t.size() == 2 && err.empty());
    {
        std::vector<uint64_t> allowed;
        std::stringstream ss(shipped("scene_ids_allowed"));
        for (std::string id; std::getline(ss, id, ',');)
            allowed.push_back(std::strtoull(id.c_str(), nullptr, 0));
        TargetSpec map;
        map.name = "map";
        map.slot = std::strtoull(shipped("map_slot").c_str(), nullptr, 0);
        map.scene_id = std::strtoull(shipped("map_scene_id").c_str(), nullptr, 0);
        std::vector<TargetSpec> s = {map};
        ok("shipped, with the shipped scene_ids_allowed and guide_ settings: a hold from the slot table with "
           "0x10004f1",
           std::find(allowed.begin(), allowed.end(), 0x010004f1) != allowed.end() &&
               load_holds(HoldSettings{shipped("guide_hold"), shipped("guide_slots"), shipped("guide_scene_id"),
                                       shipped("guide_content_class"), shipped("guide_take_over")},
                          allowed, &s, &err) &&
               s.size() == 2 && s[1].table_slots == std::vector<uint64_t>{0x105, 0x103} && s[1].slot == 0 &&
               s[1].scene_id == 0x010004f1 &&
               err.empty());
    }
    ok("off with 0: no hold", load({"guide_hold=0"}, &t, &err) && t.size() == 1 && err.empty());

    ok("on: a hold of 0x105 following the map, never drawn",
       load({"guide_hold=1"}, &t, &err) && t.size() == 2 && t[1].name == "guide_0x105" && t[1].slot == 0x105 &&
           t[1].scene_id == 0x010004f1 && t[1].follows == "map" && t[1].take_over_stock && t[1].linger_ms == 0 &&
           t[1].width == 16 && t[1].height == 16 && t[1].content_class == 0 && t[1].strike_limit == 2 &&
           t[0].strike_limit == 0 &&
           t[1].take_over_contents == std::vector<uint64_t>{0x01000310});
    ok("auto: one hold whose slot is 0x105 or 0x103 from the slot table, with guide_scene_id, following the map",
       load({"guide_hold=1", "guide_slots=auto"}, &t, &err) && t.size() == 2 && t[1].name == "guide_auto" &&
           t[1].slot == 0 && t[1].table_slots == std::vector<uint64_t>{0x105, 0x103} &&
           t[1].scene_id == 0x010004f1 && t[1].follows == "map" &&
           t[1].take_over_stock && t[1].strike_limit == 2 &&
           t[1].take_over_contents == std::vector<uint64_t>{0x01000310} && err.empty());
    ok("a slot id: no slot from the table", load({"guide_hold=1"}, &t, &err) && t[1].table_slots.empty());
    {
        TargetSpec map, panel;
        map.name = "map";
        map.slot = 0x100;
        map.scene_id = 0x010004f0;
        panel.name = "panel";
        panel.slot = 0x105;
        panel.scene_id = 0x010004f2;
        std::vector<TargetSpec> v = {map, panel};
        ok("auto with another target in 0x105: refused",
           !load_holds(HoldSettings{"1", "auto", "0x010004f1", "0", "0x01000310"}, kAllowed, &v, &err) &&
               v.size() == 2 && err == "guide_slots: slot 0x105 is target panel's");
    }
    ok("auto with slot ids: refused",
       refused({"guide_hold=1", "guide_slots=auto, 0x105"}, "guide_slots: auto is given alone, without slot ids") &&
           refused({"guide_hold=1", "guide_slots=0x105 auto"}, "auto is given alone"));
    ok("auto with a scene id not allowed: refused",
       refused({"guide_hold=1", "guide_slots=auto", "guide_scene_id=0x010004f3"},
               "guide_auto's scene id 0x10004f3 is not in scene_ids_allowed"));
    ok("guide_take_over: a list, as given", load({"guide_hold=1", "guide_take_over=0x01000310 0x01000315"}, &t, &err) &&
                                                t[1].take_over_contents ==
                                                    std::vector<uint64_t>{0x01000310, 0x01000315});
    ok("guide_take_over malformed or empty: refused",
       refused({"guide_hold=1", "guide_take_over=0x1000310x"}, "\"0x1000310x\" is not a hex content id") &&
           refused({"guide_hold=1", "guide_take_over=16777744"}, "is not a hex content id") &&
           refused({"guide_hold=1", "guide_take_over= "}, "guide_take_over names no content"));
    ok("the seat-belt-warning panel in guide_take_over: refused",
       refused({"guide_hold=1", "guide_take_over=0x01000310,0x01000314"}, "0x1000314 is the seat-belt-warning panel"));
    ok("two slots, by comma or space: the next scene id each",
       load({"guide_hold=1", "guide_slots=0x105, 0x103"}, &t, &err) && t.size() == 3 && t[2].slot == 0x103 &&
           t[2].scene_id == 0x010004f2 && load({"guide_hold=1", "guide_slots=0x105 0x103"}, &t, &err) &&
           t.size() == 3 && t[2].name == "guide_0x103");
    ok("the class as given", load({"guide_hold=1", "guide_content_class=0x400"}, &t, &err) &&
                                 t[1].content_class == 0x400);

    for (const char *v : {"guide_hold=yes", "guide_hold=2", "guide_hold="})
        ok(("taken as 1, with a warning: " + std::string(v)).c_str(),
           load({v}, &t, &err) && t.size() == 2 && err.find("guide_hold must be 0 or 1") != std::string::npos &&
               err.find("taken as 1") != std::string::npos);
    ok("a placeholder slot: refused", refused({"guide_hold=1", "guide_slots=<slot>"}, "\"<slot>\" is not a slot id"));
    ok("a slot that is not whole hex: refused",
       refused({"guide_hold=1", "guide_slots=0xO5"}, "\"0xO5\" is not a slot id") &&
           refused({"guide_hold=1", "guide_slots=261"}, "\"261\" is not a slot id") &&
           refused({"guide_hold=1", "guide_slots=0x105;0x103"}, "\"0x105;0x103\" is not a slot id"));
    ok("a slot out of 0x1-0xfff: refused", refused({"guide_hold=1", "guide_slots=0x0"}, "\"0x0\"") &&
                                               refused({"guide_hold=1", "guide_slots=0x1000"}, "\"0x1000\""));
    ok("a slot twice: refused", refused({"guide_hold=1", "guide_slots=0x105,0x105"}, "slot 0x105 is listed twice"));
    ok("another target's slot: refused", refused({"guide_hold=1", "guide_slots=0x100"}, "slot 0x100 is target map's"));
    ok("a scene id not allowed: refused, nothing added",
       refused({"guide_hold=1", "guide_slots=0x105,0x103,0x101"}, "guide_0x101's scene id 0x10004f3 is not in "
                                                                  "scene_ids_allowed"));
    ok("a scene id or class that is not a number: refused",
       refused({"guide_hold=1", "guide_scene_id=0x10004fg"}, "guide_scene_id and guide_content_class must be") &&
           refused({"guide_hold=1", "guide_content_class=-1"}, "guide_scene_id and guide_content_class must be"));
    ok("the map's scene id: refused", refused({"guide_hold=1", "guide_scene_id=0x010004f0"},
                                              "guide_0x105's scene id 0x10004f0 is target map's"));
    ok("no slot: refused", refused({"guide_hold=1", "guide_slots= , "}, "guide_slots names no slot"));
    std::vector<TargetSpec> none;
    ok("no map to follow: refused",
       !load_holds(HoldSettings{"1", "0x105", "0x010004f1", "0", "0x01000310"}, kAllowed, &none, &err) &&
                                       err.find("no map target") != std::string::npos);
    /* <target>_take_over_contents (parse_take_over_contents). */
    {
        std::vector<uint64_t> got;
        std::string why;
        auto parse = [&](const std::string &list) { return parse_take_over_contents("map_take_over_contents", list, kAllowed, &got, &why); };
        auto refuses = [&](const std::string &list, const std::string &what) {
            const bool good = !parse(list) && got.empty() && why.find(what) != std::string::npos &&
                              why.find("map_take_over_contents") != std::string::npos;
            if (!good)
                std::printf("     \"%s\": got \"%s\", %zu ids\n", list.c_str(), why.c_str(), got.size());
            return good;
        };
        ok("take_over_contents shipped: the HMI's map alone, and it parses",
           shipped("map_take_over_contents") == "0x01000300" && parse(shipped("map_take_over_contents")) &&
               got == std::vector<uint64_t>{0x01000300} && why.empty());
        ok("take_over_contents shipped for the panel and the hud: empty, so no take-over",
           shipped("panel_take_over_contents") == "" && shipped("hud_take_over_contents") == "" &&
               parse(shipped("panel_take_over_contents")) && got.empty());
        ok("take_over_contents: a list by commas or spaces, decimal or hex, as given",
           parse("0x01000300,0x01000101") && got == std::vector<uint64_t>{0x01000300, 0x01000101} &&
               parse(" 0x01000300  0x01000101 ,") && got == std::vector<uint64_t>{0x01000300, 0x01000101} &&
               parse("16777984") && got == std::vector<uint64_t>{0x01000300});
        ok("take_over_contents empty or only separators: no ids, no error (take-over off)",
           parse("") && got.empty() && parse(" , ") && got.empty());
        ok("take_over_contents: one listed twice counts once", parse("0x01000300,0x1000300") &&
                                                                  got == std::vector<uint64_t>{0x01000300});
        ok("take_over_contents: a leading + or - is refused, not wrapped to a huge number",
           refuses("-1", "not \"-1\"") && refuses("+0x01000300", "not \"+0x01000300\"") &&
               refuses("-16777984", "not \"-16777984\""));
        ok("take_over_contents: not a number, zero, or trailing text refused",
           refuses("abc", "not \"abc\"") && refuses("0", "not \"0\"") && refuses("0x01000300x", "not \"0x01000300x\"") &&
               refuses("0x", "not \"0x\"") && refuses("0x01000300;0x01000101", "not \"0x01000300;0x01000101\""));
        ok("take_over_contents: out of range (ERANGE) refused",
           refuses("0x1ffffffffffffffff", "not \"0x1ffffffffffffffff\"") &&
               refuses("99999999999999999999999", "not \"99999999999999999999999\""));
        ok("take_over_contents: a good id before a bad one: refused, nothing kept",
           refuses("0x01000300,-1", "not \"-1\"") && refuses("0x01000300,0x02000300", "not a stock HMI content"));
        ok("take_over_contents: not a stock HMI content (0x0100xxxx): refused",
           refuses("0x02000300", "\"0x02000300\" is not a stock HMI content") &&
               refuses("0x4d4755000108", "is not a stock HMI content") && refuses("0x300", "is not a stock HMI content"));
        ok("take_over_contents: one of scene_ids_allowed (ours) refused, even in the stock range",
           refuses("0x010004f0", "\"0x010004f0\" is not a stock HMI content") &&
               refuses("0x01000300,0x010004f1", "is not a stock HMI content"));
        ok("take_over_contents: the seat-belt-warning panel refused, as for guide_take_over",
           refuses("0x01000314", "0x1000314 is the seat-belt-warning panel"));
        /* The guide hold's list is its own: the map's list neither widens nor narrows it. */
        std::vector<TargetSpec> h;
        TargetSpec map;
        map.name = "map";
        map.slot = 0x100;
        map.scene_id = 0x010004f0;
        map.take_over_stock = true;
        ok("take_over_contents: the map's list is left alone by load_holds, which gives the hold guide_take_over's",
           parse("0x01000300") && (map.take_over_contents = got, h = {map}, true) &&
               load_holds(HoldSettings{"1", "0x105", "0x010004f1", "0", "0x01000310 0x01000315"}, kAllowed, &h, &err) &&
               h.size() == 2 && h[0].take_over_contents == std::vector<uint64_t>{0x01000300} &&
               h[1].take_over_contents == std::vector<uint64_t>{0x01000310, 0x01000315});
    }
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
