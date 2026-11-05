// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test of the map feed (map_feed.h) against the shared cluster renderer
 * (cluster-render, the CR tree) on fake display backends, over its socket:
 * - the map is a contending content layer on the map target, covering the
 *   1088x480 slot; before a frame the app sees idle, with the first frames
 *   the slot is asked for (starting) and the map shown with the frames as
 *   they were decoded;
 * - the stock map taking the slot shows as starting with that reason; the
 *   contending map asks again, parks behind it, takes it over and is shown,
 *   the stock map parked behind it;
 * - a control start moves it to the whole panel, centred at 416,120, and an
 *   unknown target is refused;
 * - frames stopping: idle after stall_ms, the slot released;
 * - the renderer restarting: starting while it is gone, an error once it
 *   stays gone 15 s, then the map again with the next frames;
 * - a lowered shared upload cap shows on the status line, with its reason in
 *   the status, and leaves the line once it is back at the ceiling;
 * - frames offered faster than they can be written are newest-wins;
 * - the stream not live: the layer hidden, idle, the slot released and the
 *   stock map back; live again: shown with the frames; frozen: hidden, the
 *   status says so; no longer frozen: shown again;
 * - before the stream is live the layer is made hidden;
 * - the stream's pictures through the change sampler and freeze watch, as
 *   the service runs them: a stream blank from its start (the car's burst,
 *   then a pause) never asks for the slot, the stock map stays and the app
 *   is told it waits for the phone's map; the first non-blank frame, with no frame
 *   after it, takes the slot over and shows that frame; blank spells
 *   shorter than blank_ms between pictures keep the map up without asking
 *   for the slot again; a picture blank for blank_ms gives the slot back to
 *   the stock map, and the next picture takes it again; a stream blank at
 *   full rate from its start is frozen, the stock map showing; live
 *   through a recent frame (no connection to read), a static map's frame
 *   every 10 s takes the slot over each time it makes the stream live;
 *   a frame of the ended stream decoded after it ended, seconds before the
 *   next stream is live, does not take the slot for it, while one decoded
 *   just before it is live does; the stream ending is logged once, whatever
 *   frames still come;
 * - the status is logged when its state, reason or target changes, not for
 *   the frame rate, the page or the upload cap;
 * - BMW's turn box (the layer's guide_hold): hidden by default, the hold of
 *   its slot following the map; the switch off releases it and the box
 *   shows, the map still showing; on again, held; off from the start,
 *   never held; the hold disabled by cluster-render's guard: never held,
 *   and the status says so;
 * - only what the renderer needs goes: a picture repeated (as the producer
 *   hands over a picture the same as the last) keeps a static map showing
 *   past stall_ms; nothing reaches the renderer while the layer is hidden,
 *   and shown again it draws the newest picture first; after the renderer
 *   restarts, and on another target, repeats alone bring the picture. */
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <algorithm>
#include <fstream>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

/* cluster-render's service and fakes, from its tree (-I$(CR)) */
#include "src/service.h"
#include "test/fake_graph.h"
#include "test/fake_port.h"
#include "../src/map_feed.h"
#include "src/log.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static int rigs;
static const uint64_t kBox = 0x01000310, kGuide = 0x010004f1;

struct Rig {
    std::string path = "/tmp/woc-feed-test-" + std::to_string(getpid()) + "-" + std::to_string(++rigs) + ".sock";
    crs::FakeGpu gpu;
    crs::FakePort port;
    crs::ServiceConfig sc;
    std::unique_ptr<crs::Service> svc;
    std::unique_ptr<MapFeed> feed;
    int64_t now = 200000;
    std::vector<uint8_t> spare;   /* the buffer handed to the feed, as the producer's */
    /* watched: the frames' pictures drive the stream state, as in the
     * service's loop; otherwise the stream is live with a picture */
    bool watched;
    /* watched and > 0: live while a frame came within this long, as the
     * service decides without the stream's connection; 0: live while live
     * is set, as the stream's connection says */
    int64_t live_stall_ms = 0;
    bool live = true;
    /* frames the same as the last offered go as repeats, as the producer
     * hands them over */
    bool repeats = false;
    std::vector<uint8_t> offered;
    int64_t last_frame_ms = -1;
    FreezeWatch watch{FreezeConfig()};
    ChangeSampler sampler{1088, 480};

    /* hold: with the guide hold of the turn box's slot following the map, as
     * cluster-render.conf ships it; guide_hold: the feed's setting. */
    explicit Rig(bool w = false, unsigned stall_ms = 6000, bool hold = false, bool guide_hold = true) : watched(w)
    {
        crs::TargetSpec m, p, g;
        m.name = "map"; m.slot = 0x100; m.scene_id = 0x010004f0; m.width = 1088; m.height = 480; m.linger_ms = 1500;
        m.take_over_stock = true;   /* as cluster-render.conf ships it */
        /* map_take_over_contents as shipped (the HMI's map) plus the stock content FakePort::steal
         * maps (the same value cluster-render's own service tests list) */
        m.take_over_contents = {0x01000300, 0x01000101};
        p.name = "panel"; p.slot = 0x203; p.scene_id = 0x01000400; p.width = 1920; p.height = 720; p.linger_ms = 3000;
        g.name = "guide_0x105"; g.slot = 0x105; g.scene_id = kGuide; g.width = g.height = 16; g.linger_ms = 0;
        g.take_over_stock = true; g.follows = "map"; g.take_over_contents = {kBox};
        g.strike_limit = 2;
        sc.targets = {m, p};
        if (hold)
            sc.targets.push_back(g);
        sc.socket_path = path;
        sc.backend = "fake";
        start();
        FeedConfig fc;
        fc.socket = path;
        fc.video.level_bits = 0;
        fc.video.stall_ms = stall_ms;
        fc.guide_hold = guide_hold;
        feed.reset(new MapFeed(fc));
        watch.live(true, now);
        feed->set_stream(true, false, watched ? watch.picture(now) : Picture::Shown);
    }
    void start()
    {
        svc.reset(new crs::Service(&gpu, &port, sc));
        port.m = &svc->slots();
        port.pending.clear();
        std::string err;
        if (!svc->start(&err))
            std::printf("start: %s\n", err.c_str());
    }
    /* Simulated time; each step runs the socket exchange until idle. */
    void pump(int64_t ms, const std::vector<uint8_t> *frame = nullptr, int64_t frame_every = 65)
    {
        for (int64_t t = 0; t < ms; t += 5) {
            now += 5;
            if (frame && t % frame_every == 0) {
                if (repeats && offered == *frame) {
                    feed->repeat((uint64_t)now, now);
                } else {
                    spare.assign(frame->begin(), frame->end());
                    feed->offer(&spare, (uint64_t)now, now);
                    offered = *frame;
                }
                if (watched) {
                    const bool changed = sampler.changed(frame->data());
                    watch.frame(now, changed, sampler.blank());
                    last_frame_ms = now;
                }
            }
            if (watched) {
                const bool on = live_stall_ms ? last_frame_ms >= 0 && now - last_frame_ms <= live_stall_ms : live;
                watch.live(on, now);
                feed->set_stream(on, watch.frozen(now), watch.picture(now));
            }
            for (int round = 0; round < 400; round++) {
                std::vector<pollfd> fds;
                size_t first = 0;
                if (svc)
                    first = svc->poll_fds(&fds);
                const int n = ::poll(fds.data(), fds.size(), 0);
                if (svc) {
                    port.tick(now);
                    svc->after_poll(fds, first, now);
                }
                const bool pending = feed->wants_write();
                feed->poll(now);
                if (round > 0 && n <= 0 && !pending)
                    break;
            }
        }
    }
    FeedStatus st() { return feed->status("decode"); }
    /* The map status of content in the turn box's slot; -1: not mapped. */
    int in_box_slot(uint64_t content) const
    {
        const crs::SlotInfo *s = port.row(0x105, content);
        return s ? (int)s->map_status : -1;
    }
    const crs::Layer *map_layer()
    {
        for (const crs::Layer *l : svc->compositor().layers())
            return l;
        return nullptr;
    }
    /* The map layer's frames the renderer has counted: written, unchanged,
     * within the threshold, superseded. */
    unsigned long long received()
    {
        unsigned long long n[4] = {};
        if (const crs::Layer *l = map_layer())
            std::sscanf(l->stats().c_str(), "%llu sent, %llu unchanged, %llu within threshold, %llu superseded", &n[0],
                        &n[1], &n[2], &n[3]);
        return n[0] + n[1] + n[2] + n[3];
    }
    /* Whether the target's scene draws the map, and with this atlas. */
    bool drawing(const char *target, const std::vector<uint8_t> &f, bool *with)
    {
        crs::FakeGraph *g = gpu.graph(target);
        *with = false;
        if (!g || g->drawn().empty())
            return false;
        for (const auto &kv : g->shown.buffers)
            *with = *with || (kv.second.f == crs::TexFormat::R8 && kv.second.px == f);
        return true;
    }
};

static std::vector<uint8_t> atlas(int seed)
{
    std::vector<uint8_t> f(1088 * 720);
    for (size_t i = 0; i < f.size(); i++)
        f[i] = (uint8_t)(i < 1088 * 480 ? (i / 5 + seed * 17) & 0xff : 128);
    return f;
}

/* The app's switch for BMW's turn box: on by default, the hold following
 * the map and the box taken over; off, the hold released and the box
 * shown, the map still showing; on again, held. */
static void guide_hold()
{
    const std::vector<uint8_t> f = atlas(7);
    Rig h(false, 6000, true);
    h.port.stock_map(0x105, kBox);
    h.pump(1500, &f);
    ok("turn box: hidden by default, the hold shown in its slot with the box parked behind it",
       h.st().state == "showing" && h.st().guide_hold && h.in_box_slot(kGuide) == 1 && h.in_box_slot(kBox) == 3);
    h.feed->set_guide_hold(false);
    h.pump(500, &f);
    const size_t taken = h.port.taken_over.size();
    ok("turn box: the switch off releases the hold, the box shown, the map still showing, the status says so",
       h.in_box_slot(kGuide) == -1 && h.in_box_slot(kBox) == 1 && h.st().state == "showing" && !h.st().guide_hold);
    h.pump(5000, &f);
    ok("turn box: off, no take-over and no hold", h.port.taken_over.size() == taken && h.in_box_slot(kGuide) == -1);
    h.feed->set_guide_hold(true);
    h.pump(500, &f);
    ok("turn box: on again, held, the box taken over",
       h.in_box_slot(kGuide) == 1 && h.in_box_slot(kBox) == 3 && h.port.taken_over.back() == kBox);

    Rig off(false, 6000, true, false);
    off.port.stock_map(0x105, kBox);
    off.pump(3000, &f);
    ok("turn box: set off before the map is made, never held",
       off.st().state == "showing" && off.in_box_slot(kGuide) == -1 && off.in_box_slot(kBox) == 1);
    ok("turn box: the hold not disabled, the status says so", !h.st().guide_disabled);

    const std::string path = "/tmp/woc-feed-guard-" + std::to_string(getpid()) + ".txt";
    std::ofstream(path) << "version t\nboot b\nguide_0x105 0x105 0x10004f1 0 1 0 2\n";
    Rig d(false, 6000, true);
    d.sc.guard_path = path;
    d.sc.version = "t";
    d.sc.boot_id = "b";
    d.start();
    d.port.stock_map(0x105, kBox);
    d.pump(3000, &f);
    ok("turn box: the hold disabled by cluster-render's guard: never held, the status says so",
       d.st().state == "showing" && d.st().guide_disabled && d.in_box_slot(kGuide) == -1 && d.in_box_slot(kBox) == 1);
    unlink(path.c_str());
}

/* Only what the renderer needs goes over its socket. */
static void only_what_is_needed()
{
    const std::vector<uint8_t> f1 = atlas(1), f2 = atlas(2);
    Rig r(false, 6000);
    r.repeats = true;
    r.pump(1500, &f1);
    bool drawn = false;
    r.drawing("map", f1, &drawn);
    ok("repeats: the first frame whole, shown", r.st().state == "showing" && drawn);
    const unsigned long long first = r.received();
    bool steady = true;
    for (int s = 0; s < 10; s++) {
        r.pump(1000, &f1);
        steady = steady && r.st().state == "showing";
    }
    ok("repeats: a static map's repeated picture keeps it showing past stall_ms, each repeat counted",
       steady && r.map_layer()->params.visible && r.received() >= first + 150);
    int fps = 0;
    std::sscanf(r.st().page.c_str(), "Waze map \xe2\x80\x94 %d frames/s", &fps);
    ok("repeats: the frame rate counts them, a frame each 65 ms", fps == 15 || fps == 16);

    r.feed->set_stream(false, false, Picture::Shown);
    r.pump(100, &f1);
    const unsigned long long hidden = r.received();
    r.pump(3000, &f2);
    ok("hidden: nothing reaches the renderer, frames or repeats", r.received() == hidden && r.st().state == "idle");
    r.feed->set_stream(true, false, Picture::Shown);
    bool first_drawn = false, newest_first = false;
    for (int step = 0; step < 300 && !first_drawn; step++) {
        r.pump(5);
        first_drawn = r.drawing("map", f2, &newest_first);
    }
    ok("shown again: the newest picture is what it draws first", first_drawn && newest_first);
    r.pump(1500, &f2);
    ok("shown again: showing", r.st().state == "showing");

    r.svc.reset();
    r.pump(100, &f2);
    r.start();
    r.pump(3000, &f2);
    r.drawing("map", f2, &drawn);
    ok("the renderer restarted: repeats alone bring the picture back", r.st().state == "showing" && drawn);

    ok("another target", r.feed->set_target("panel"));
    r.pump(1500, &f2);
    r.drawing("panel", f2, &drawn);
    ok("another target: repeats alone bring the picture", r.st().state == "showing" && r.st().target == "panel" && drawn);
}

int main()
{
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, nullptr, _IONBF, 0);
    Rig r;
    r.pump(100);
    const crs::Layer *l = r.map_layer();
    ok("connected: one contending content layer on the map target, covering the 1088x480 slot",
       l && l->target() == 0 && l->params.contend && l->params.klass == crs::Klass::Content && l->params.rect.x == 0 &&
           l->params.rect.y == 0 && l->params.rect.w == 1088 && l->params.rect.h == 480);
    ok("no frame yet: idle, and the slot is not asked for", r.st().state == "idle" && r.port.requests == 0);

    const std::vector<uint8_t> f1 = atlas(1);
    r.pump(20, &f1);
    ok("the first frame asks for the slot: starting", r.st().state == "starting" && r.port.requests == 1);
    r.pump(1100, &f1);
    crs::FakeGraph *g = r.gpu.graph("map");
    bool drawn = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            drawn = drawn || (kv.second.f == crs::TexFormat::R8 && kv.second.px == f1);
    ok("granted: showing, with the decoded frame in the slot's scene",
       r.st().state == "showing" && drawn && r.st().page.find("Waze map — ") == 0);
    ok("the status line counts the frames handed over", r.st().page.find("15 frames/s") != std::string::npos);
    const std::string lost = "Stream lost";   /* until the layer stalls */
    ok("showing carries the stream's reason", r.feed->status("decode", lost).state == "showing" &&
                                                  r.feed->status("decode", lost).reason == lost &&
                                                  r.feed->status("decode", lost).stream_reason);

    r.port.steal(r.sc.targets[0]);
    r.pump(20, &f1);
    ok("the stock map takes the slot: starting, with that reason",
       r.st().state == "starting" && r.st().reason == "the stock map holds the slot");
    r.pump(2200, &f1);
    const crs::SlotInfo *ours = r.port.row(0x100, 0x010004f0), *stock = r.port.row(0x100, 0x01000101);
    ok("the map contends: it takes the stock map over and is shown, the stock map parked behind it",
       r.st().state == "showing" && r.port.requests == 2 && r.port.taken_over.size() == 1 &&
           r.port.taken_over[0] == 0x01000101 && ours && ours->map_status == 1 && stock && stock->map_status == 3);

    /* Many frames between two writes: only the newest is drawn. */
    const std::vector<uint8_t> f2 = atlas(2), f3 = atlas(3);
    std::vector<uint8_t> b2 = f2, b3 = f3;
    r.feed->offer(&b2, 2, r.now);
    r.feed->offer(&b3, 3, r.now);
    ok("a frame is taken without a copy: an earlier frame's buffer comes back for each, the last sent kept",
       b2.size() == f2.size() && b3.size() == f3.size() && b2 == f1 && b3 == f1);
    r.pump(200);
    g = r.gpu.graph("map");
    bool newest = false, stale = false;
    for (const auto &kv : g->shown.buffers)
        if (kv.second.f == crs::TexFormat::R8) {
            newest = newest || kv.second.px == f3;
            stale = stale || kv.second.px == f2;
        }
    ok("frames faster than the writes: the newest is drawn", newest && !stale);

    ok("an unknown target is refused", !r.feed->set_target("cockpit"));
    ok("a control start moves the map to the whole panel", r.feed->set_target("panel"));
    r.pump(1200, &f3);
    l = r.map_layer();
    ok("centred in the 1920x720 panel at 416,120, showing",
       l && l->target() == 1 && l->params.rect.x == 416 && l->params.rect.y == 120 && l->params.rect.w == 1088 &&
           r.st().state == "showing" && r.st().target == "panel");
    r.pump(1600);
    ok("the map target, no longer wanted, is released after its linger",
       r.port.releases >= 1 && !r.port.row(0x100, 0x010004f0));
    r.feed->set_target("sail");
    r.pump(1200, &f3);
    ok("sail is the map slot", r.map_layer() && r.map_layer()->target() == 0 && r.st().state == "showing");

    const int releases = r.port.releases;
    r.pump(6100);
    ok("frames stop: idle after stall_ms", r.st().state == "idle");
    const std::string waiting = "Stream lost";
    ok("idle while the stream is live carries the stream's reason", r.feed->status("decode", waiting).reason == waiting);
    r.pump(2000);   /* the fade out, then the linger */
    ok("and the slot is released after the linger",
       r.port.releases > releases && !r.port.row(0x100, 0x010004f0));

    r.svc.reset();
    r.pump(100);
    ok("the renderer gone: starting while it may be starting", r.st().state == "starting" &&
                                                               r.st().reason == "waiting for the cluster renderer");
    r.pump(15000);
    ok("still gone 15 s on: an error the app shows", r.st().state == "error" &&
                                                     r.st().reason == "cluster renderer not reachable");
    r.start();
    r.pump(3000, &f1);
    ok("it comes back: the map layer made again, showing with the next frames",
       r.map_layer() && r.st().state == "showing");

    /* the governor counts evidence seen while writes go */
    r.svc->compositor().governor().activity(r.now);
    r.svc->compositor().governor().evidence(crs::Evidence::LinkStall, r.now);
    r.svc->compositor().governor().evidence(crs::Evidence::LinkStall, r.now);
    r.pump(100, &f1);
    ok("a lowered shared upload cap shows on the status line",
       r.st().page.find("upload cap 5000 KB/s") != std::string::npos);
    ok("the status carries the cap and why",
       r.st().upload_cap_kb == 5000 && r.st().upload_reason.find("lowered from 5500 KB/s") == 0 &&
           r.st().upload_reason.find("heartbeat replies silent") != std::string::npos);
    /* A minute of healthy upload raises it back to the ceiling, which the
     * status line leaves out. */
    for (int s = 0; s < 62; s++) {
        r.svc->compositor().governor().activity(r.now);
        r.pump(1000, &f1);
    }
    ok("back at the ceiling after healthy upload: the cap leaves the status line, its reason stays",
       r.st().upload_cap_kb == 5500 && r.st().page.find("upload cap") == std::string::npos &&
           r.st().upload_reason.find("raised from 5000 KB/s") == 0);
    /* the stream's liveness drives the layer, whatever the frames do */
    const int before = r.port.releases;
    r.feed->set_stream(false, false, Picture::Shown);
    r.pump(2000, &f1);   /* the fade out, then the linger */
    stock = r.port.row(0x100, 0x01000101);
    ok("the stream not live: the layer hidden, idle, and the slot released, the parked stock map shown",
       r.map_layer() && !r.map_layer()->params.visible && r.st().state == "idle" && r.port.releases > before &&
           !r.port.row(0x100, 0x010004f0) && stock && stock->map_status == 1);
    ok("and no stream reason", r.feed->status("decode", waiting).reason.empty());
    r.feed->set_stream(true, false, Picture::Shown);
    r.pump(1200, &f1);
    ok("live again: visible and showing with the frames", r.map_layer()->params.visible && r.st().state == "showing");
    r.feed->set_stream(true, true, Picture::Blank);
    r.pump(100, &f1);
    ok("frozen: hidden, and the status says why",
       !r.map_layer()->params.visible && r.st().state == "frozen" && r.st().reason == "the phone's cluster stream froze");
    r.feed->set_stream(true, false, Picture::Shown);
    r.pump(1200, &f1);
    ok("no longer frozen: shown again", r.map_layer()->params.visible && r.st().state == "showing");

    Rig h;
    h.feed->set_stream(false, false, Picture::None);
    h.svc.reset();
    h.start();
    h.pump(3000, &f1);
    ok("a layer made while the stream is not live is hidden: idle, the slot not asked for",
       h.map_layer() && !h.map_layer()->params.visible && h.st().state == "idle" && h.port.requests == 0);

    /* The stream's own pictures, from a stream start with the stock map up. */
    std::vector<uint8_t> black(1088 * 720, 128);
    std::fill(black.begin(), black.begin() + 1088 * 480, 16);
    Rig b(true, 60000);
    b.port.stock_map(0x100, 0x01000101);
    b.pump(100);
    ok("blank start: live, no frame yet: idle, no reason, the slot not asked for",
       b.st().state == "idle" && b.st().reason.empty() && b.port.requests == 0);
    b.pump(2000, &black, 20);   /* the car's start: about 100 blank frames in 2 s */
    b.pump(60000);              /* then a pause */
    const crs::SlotInfo *stock_b = b.port.row(0x100, 0x01000101);
    ok("blank start: the burst and a minute's pause never ask for the slot; the stock map stays",
       b.port.requests == 0 && !b.port.row(0x100, 0x010004f0) && stock_b && stock_b->map_status == 1 &&
           b.map_layer() && !b.map_layer()->params.visible);
    ok("blank start: idle, and the app told it waits for the phone's map",
       b.st().state == "idle" && b.st().reason == MapFeed::kWaiting && !b.st().stream_reason &&
           b.st().reason == "Waiting for the phone's map");
    ok("blank start: a lost stream's reason comes first",
       b.feed->status("decode", lost).reason == lost && b.feed->status("decode", lost).stream_reason);
    b.pump(5, &f1);   /* one non-blank frame, then nothing */
    b.pump(1500);
    g = b.gpu.graph("map");
    drawn = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            drawn = drawn || (kv.second.f == crs::TexFormat::R8 && kv.second.px == f1);
    stock_b = b.port.row(0x100, 0x01000101);
    ok("first picture: the slot asked for once, the stock map taken over, that frame shown",
       b.st().state == "showing" && drawn && b.port.requests == 1 && b.port.taken_over.size() == 1 && stock_b &&
           stock_b->map_status == 3);
    for (int spell = 0; spell < 6; spell++) {
        b.pump(9000, &black, 1000);   /* a blank frame a second for 9 s */
        b.pump(5, &f1);
    }
    ok("blank spells of 9 s between pictures: showing throughout, the slot not asked for again",
       b.st().state == "showing" && b.port.requests == 1 && b.map_layer()->params.visible);
    const int rel_b = b.port.releases;
    b.pump(5, &black);   /* one blank frame, then nothing */
    b.pump(9900);
    ok("one blank frame, then nothing: the map stays until blank_ms",
       b.st().state == "showing" && b.port.releases == rel_b);
    b.pump(2500);   /* blank_ms, then the fade out and the linger */
    stock_b = b.port.row(0x100, 0x01000101);
    ok("blank for blank_ms: hidden, the slot given back, the stock map shown, the app told it waits for the phone's map",
       !b.map_layer()->params.visible && b.port.releases > rel_b && !b.port.row(0x100, 0x010004f0) && stock_b &&
           stock_b->map_status == 1 && b.st().state == "idle" && b.st().reason == MapFeed::kWaiting);
    b.pump(5, &f1);
    b.pump(1500);
    ok("the next picture takes the slot again", b.st().state == "showing" && b.port.requests == 2);

    Rig fz(true, 60000);
    fz.port.stock_map(0x100, 0x01000101);
    fz.pump(31000, &black, 65);   /* blank at 15 fps from the start */
    ok("blank at full rate from the start: frozen after 30 s, the slot never asked for",
       fz.st().state == "frozen" && fz.port.requests == 0 && !fz.map_layer()->params.visible);

    Rig lf(true, 60000);
    lf.live_stall_ms = 6000;
    lf.port.stock_map(0x100, 0x01000101);
    lf.pump(100);
    bool every = true;
    for (int k = 0; k < 3; k++) {
        lf.pump(5, &f1);   /* one frame, then nothing for 10 s */
        lf.pump(1500);
        every = every && lf.st().state == "showing" && lf.map_layer()->params.visible;
        lf.pump(8500);
        every = every && lf.st().state == "idle";
    }
    ok("live through a recent frame: a static map's frame every 10 s is shown each time it makes the stream live",
       every && lf.port.requests == 3);

    Rig nl(true, 60000);
    nl.port.stock_map(0x100, 0x01000101);
    nl.pump(1500, &f1);
    ok("reconnect: the first stream shows", nl.st().state == "showing" && nl.port.requests == 1);
    uint64_t seq = 0;
    std::vector<std::string> lines;
    cld::log_lines_since(&seq, &lines);
    lines.clear();
    nl.live = false;   /* the connection ends */
    nl.pump(2000);
    nl.pump(5, &f1);   /* the ended stream's last frame, still on its way */
    nl.pump(200, &black, 20);
    nl.pump(3500);
    nl.live = true;   /* the next connection */
    nl.pump(1500);
    const crs::SlotInfo *stock_nl = nl.port.row(0x100, 0x01000101);
    ok("reconnect: a frame decoded after the end, the next stream live seconds later: idle, hidden, the stock map shown",
       nl.st().state == "idle" && nl.st().reason.empty() && !nl.map_layer()->params.visible &&
           nl.port.requests == 1 && stock_nl && stock_nl->map_status == 1);
    cld::log_lines_since(&seq, &lines);
    int not_live = 0;
    for (const std::string &line : lines)
        not_live += line.find("cluster stream is not live") != std::string::npos;
    ok("reconnect: the stream ending is logged once, whatever frames still come", not_live == 1);
    nl.live = false;
    nl.pump(2000);
    nl.pump(5, &f1);
    nl.pump(500);
    nl.live = true;   /* a new stream's first frame, decoded before its connection is read */
    nl.pump(1500);
    ok("reconnect: a frame decoded just before the stream is live takes the slot",
       nl.st().state == "showing" && nl.port.requests == 2);

    StatusLog sl;
    FeedStatus a;
    a.state = "showing";
    a.target = "map";
    a.page = "Waze map — 15 frames/s";
    int64_t t = 1000000;
    ok("status log: the first status", sl.due(a, t));
    a.page = "Waze map — 14 frames/s";
    a.upload_cap_kb = 5500;
    a.upload_reason = "slow flushes";
    ok("status log: not for the page or the upload cap", !sl.due(a, t));
    a.reason = "Stream lost";
    a.stream_reason = true;
    ok("status log: the stream's reason", sl.due(a, t));
    a.reason.clear();
    a.stream_reason = false;
    ok("status log: the stream whole again within 10 s waits", !sl.due(a, t + 2000));
    a.reason = "Stream lost";
    a.stream_reason = true;
    ok("status log: so does its next loss; the logged reason is the same, nothing to log",
       !sl.due(a, t + 4000) && !sl.due(a, t + 10000));
    a.reason.clear();
    a.stream_reason = false;
    ok("status log: a change still standing 10 s after the last such line is logged",
       !sl.due(a, t + 9000) && sl.due(a, t + 10500));
    a.state = "idle";
    a.reason = "Stream lost";
    a.stream_reason = true;
    ok("status log: a state change is logged at once, with its reason", sl.due(a, t + 11000));
    a.state = "starting";
    a.reason = "the stock map holds the slot";
    a.stream_reason = false;
    ok("status log: a state and reason", sl.due(a, t + 11100));
    ok("status log: the same again is not", !sl.due(a, t + 11200));
    a.reason = "another app holds the slot";
    ok("status log: a reason of the feed's own alone, at once", sl.due(a, t + 11300));
    a.target = "panel";
    ok("status log: a target alone", sl.due(a, t + 11400));

    guide_hold();
    only_what_is_needed();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
