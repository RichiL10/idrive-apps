/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test of the whole service over its socket (service.h, server.h,
 * PROTOCOL.md) with the C++ client (cluster_render/client.h), on fake
 * display backends: the hello; a video layer stalled until its first frame,
 * then mapped and shown with that frame; a second client's overlay in the
 * same scene with no second request; the stock HMI taking the slot from a
 * contending layer and the retry; a client going away taking its layers
 * and nothing else; the last one going releasing the slot after the linger;
 * the service restarting under a client, which makes its layers again and
 * sends its image whole; refusals reported to the client; the status;
 * assets, binds, uniform arrays, a turned image, a mesh layer with a part,
 * its geometry and transform, and animations, all made again after a
 * restart; malformed and oversized mesh messages and bad animation keys
 * refused without harm; on a KOMBI that parks a map behind the one it
 * shows: the map parked behind the stock map, which is unmapped as the HMI,
 * then shown and faded in, the stock map parked behind it; when the stream
 * ends the map fades out, is released and the stock map is shown again; the
 * stream back at once, the map is asked for again in the same scene as soon
 * as the KOMBI confirms the release; a target that does not take over stays parked, with no timeout, reported
 * as parked behind the stock HMI, and is shown when the stock content goes. */
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstring>

#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include "../kit/yuv_atlas.h"
#include "../src/service.h"
#include "cluster_render/client.h"
#include "fake_graph.h"
#include "fake_port.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

struct Events {
    std::map<uint32_t, std::string> layer;    /* ref -> last state */
    std::map<std::string, std::string> target, holder;
    std::vector<std::string> errors;
    int ready = 0;
    void wire(cr::Client &c)
    {
        c.on_ready = [this] { ready++; };
        c.on_layer = [this](uint32_t r, const std::string &s, const std::string &) { layer[r] = s; };
        c.on_target = [this](const std::string &t, const std::string &s, const std::string &h, const std::string &) {
            target[t] = s;
            holder[t] = h;
        };
        c.on_error = [this](const std::string &op, uint32_t, const std::string &why) {
            errors.push_back(op + ": " + why);
        };
    }
};

static int next_rig()
{
    static int rigs;
    return ++rigs;
}

struct Rig {
    std::string path = "/tmp/crs-service-test-" + std::to_string(getpid()) + "-" + std::to_string(next_rig()) + ".sock";
    FakeGpu gpu;
    FakePort port;
    ServiceConfig sc;
    std::unique_ptr<Service> svc;
    std::vector<cr::Client *> clients;
    int64_t now = 100000;

    explicit Rig(uint64_t budget_bps = 0)
    {
        TargetSpec m;
        m.name = "map"; m.slot = 0x100; m.scene_id = 0x010004f0; m.width = 1088; m.height = 480; m.linger_ms = 1500;
        m.take_over_stock = true;
        m.take_over_contents = {0x01000300, 0x01000101};   /* the HMI's map and FakePort::steal's stock content */
        TargetSpec p;
        p.name = "panel"; p.slot = 0x203; p.scene_id = 0x01000400; p.width = 1920; p.height = 720; p.linger_ms = 3000;
        sc.targets = {m, p};
        sc.socket_path = path;
        sc.backend = "fake";
        sc.budget.max_bps = budget_bps;
        sc.budget.floor_bps = budget_bps / 3;
        start();
    }
    ~Rig() { svc.reset(); }
    void start()
    {
        port.m = nullptr;
        port.watchdog();
        svc.reset(new Service(&gpu, &port, sc));
        port.m = &svc->slots();
        std::string err;
        if (!svc->start(&err))
            std::printf("start: %s\n", err.c_str());
    }
    /* Each step of simulated time runs the socket exchange until it is
     * idle, as the event-driven loops on the unit do within a few ms. */
    void pump(int64_t ms, int64_t step = 5)
    {
        for (int64_t t = 0; t < ms; t += step) {
            now += step;
            for (int round = 0; round < 400; round++) {
                bool pending = false;
                for (cr::Client *c : clients)
                    pending = pending || c->wants_write();
                std::vector<pollfd> fds;
                size_t first = 0;
                if (svc)
                    first = svc->poll_fds(&fds);
                const int n = ::poll(fds.data(), fds.size(), 0);
                if (svc) {
                    port.tick(now);
                    svc->after_poll(fds, first, now);
                }
                for (cr::Client *c : clients)
                    c->poll(now);
                if (round > 0 && n <= 0 && !pending)
                    break;
            }
        }
    }
};

/* A client that writes protocol bytes as given, to send what the clients
 * never would. */
struct Raw {
    int fd = -1;
    std::string in;
    explicit Raw(const std::string &path)
    {
        struct sockaddr_un a;
        std::memset(&a, 0, sizeof a);
        a.sun_family = AF_UNIX;
        std::snprintf(a.sun_path, sizeof a.sun_path, "%s", path.c_str());
        fd = socket(AF_UNIX, SOCK_STREAM, 0);
        connect(fd, (struct sockaddr *)&a, sizeof a);
    }
    ~Raw() { close(fd); }
    void send(const std::string &json) { send_message(cr::encode(cr::kJson, json)); }
    void send_message(const std::string &m)
    {
        if (write(fd, m.data(), m.size()) != (ssize_t)m.size())
            std::printf("raw write failed\n");
    }
    std::string events()
    {
        char b[4096];
        pollfd p{fd, POLLIN, 0};
        while (::poll(&p, 1, 0) > 0) {
            ssize_t n = read(fd, b, sizeof b);
            if (n <= 0)
                break;
            in.append(b, (size_t)n);
        }
        return in;
    }
};

/* A mesh message body: header and then raw bytes as given. */
static std::string mesh_body(uint32_t ref, uint32_t part, uint32_t vertices, uint32_t indices, uint8_t mask,
                             const std::string &rest)
{
    std::string b;
    for (uint32_t v : {ref, part, vertices, indices})
        for (int i = 0; i < 4; i++)
            b.push_back((char)(v >> (8 * i)));
    b.push_back((char)mask);
    return cr::encode(cr::kMesh, b + rest);
}

static cr::Geometry cube()
{
    static const float n[6][3] = {{0, 0, 1}, {0, 0, -1}, {1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}};
    cr::Geometry g;
    for (int f = 0; f < 6; f++) {
        const float *N = n[f];
        const float a[3] = {N[1], N[2], N[0]};
        const float b[3] = {N[1] * a[2] - N[2] * a[1], N[2] * a[0] - N[0] * a[2], N[0] * a[1] - N[1] * a[0]};
        const uint16_t base = (uint16_t)(g.positions.size() / 3);
        for (int v = 0; v < 4; v++) {
            const float sa = (v & 1) ? 1.0f : -1.0f, sb = (v & 2) ? 1.0f : -1.0f;
            for (int c = 0; c < 3; c++) {
                g.positions.push_back(N[c] + sa * a[c] + sb * b[c]);
                g.normals.push_back(N[c]);
            }
        }
        for (uint16_t k : {0, 1, 2, 2, 1, 3})
            g.indices.push_back((uint16_t)(base + k));
    }
    return g;
}

static std::vector<uint8_t> atlas(int seed)
{
    std::vector<uint8_t> f(1088 * 720);
    for (size_t i = 0; i < f.size(); i++)
        f[i] = (uint8_t)(i < 1088 * 480 ? (i / 7 + seed * 13) & 0xff : 128);
    return f;
}

/* The atlas quad's opacity as shown; -1: no such quad. */
static float atlas_opacity(FakeGraph *g)
{
    if (!g)
        return -1.0f;
    for (auto &kv : g->shown.quads) {
        auto t = kv.second.textures.find("u_image");
        if (t != kv.second.textures.end() && g->shown.buffers.at(t->second).f == TexFormat::R8)
            return kv.second.uniforms["u_opacity"].empty() ? -1.0f : kv.second.uniforms["u_opacity"][0];
    }
    return -1.0f;
}

static void take_over_and_fall_back()
{
    Rig r;
    r.sc.targets[0].linger_ms = 0;   /* as the map's default */
    r.start();
    const uint64_t kHmiMap = 0x01000300;
    r.port.stock_map(0x100, kHmiMap);   /* Map view: the HMI's map shown */
    cr::Client a("waze", r.path);
    Events ea;
    ea.wire(a);
    std::vector<std::string> states;
    a.on_target = [&](const std::string &t, const std::string &st, const std::string &h, const std::string &why) {
        ea.target[t] = st;
        ea.holder[t] = h;
        if (t == "map")
            states.push_back(st + (why.empty() ? "" : " (" + why + ")"));
    };
    r.clients = {&a};
    r.pump(50);
    cr::LayerOptions lo;
    lo.target = "map";
    lo.contend = true;
    const uint32_t map = a.video(lo, cr::VideoOptions());
    const std::vector<uint8_t> f = atlas(1);
    a.frame(map, f.data(), f.size(), 1);
    r.pump(100);
    bool parked = false;
    for (const std::string &st : states)
        parked = parked || st.find("parked") == 0;
    const SlotInfo *ours = r.port.row(0x100, 0x010004f0), *hmi = r.port.row(0x100, kHmiMap);
    ok("the map parked behind the stock map, which is unmapped as the HMI: ours shown, the HMI's parked behind",
       parked && r.port.taken_over == std::vector<uint64_t>{kHmiMap} && ea.target["map"] == "shown" && ours &&
           ours->map_status == 1 && hmi && hmi->map_status == 3);
    const float early = atlas_opacity(r.gpu.graph("map"));
    r.pump(300);
    ok("shown: faded in", early >= 0.0f && early < 1.0f && atlas_opacity(r.gpu.graph("map")) == 1.0f &&
                              ea.layer[map] == "shown");
    for (int k = 0; k < 20; k++) {
        a.frame(map, f.data(), f.size(), 2 + k);
        r.pump(500);
    }
    ok("the HMI's map parked behind ours: no more take-overs", r.port.taken_over.size() == 1 &&
                                                                   ea.target["map"] == "shown");

    /* The stream ends: the app hides the map. */
    lo.visible = false;
    a.set(map, lo);
    r.pump(150);
    const float mid = atlas_opacity(r.gpu.graph("map"));
    ok("the stream ended: the map fades out, the slot still ours", ea.target["map"] == "shown" && mid > 0.0f &&
                                                                       mid < 1.0f);
    for (int k = 0; k < 60 && ea.target["map"] != "idle"; k++)
        r.pump(5);
    hmi = r.port.row(0x100, kHmiMap);
    ok("then released: idle, the stock map shown again", ea.target["map"] == "idle" && hmi && hmi->map_status == 1 &&
                                                             !r.port.row(0x100, 0x010004f0));
    const int scenes = r.gpu.scenes, requests = r.port.requests;
    lo.visible = true;
    a.set(map, lo);
    a.frame(map, f.data(), f.size(), 100);
    r.pump(100);
    const int64_t after = r.port.last_request_ms - r.port.last_release_ms;
    ok("the stream back at once: asked for again in the same scene once the KOMBI confirms the release",
       r.port.requests == requests + 1 && r.gpu.scenes == scenes && after >= r.port.confirm_ms &&
           after < r.port.confirm_ms + 20);
    lo.visible = false;
    a.set(map, lo);
    r.pump(500);
    ok("and released again", ea.target["map"] == "idle");
    const size_t overs = r.port.taken_over.size();

    /* The panel does not take over: parked until the stock content goes. */
    cr::LayerOptions pl;
    pl.target = "panel";
    pl.contend = true;
    a.effect(pl, cr::EffectOptions{"#version 100\nvoid main(){gl_FragColor=vec4(1.0);}", "", 0});
    r.pump(10);   /* requested; the HMI maps its speech dialog before the answer */
    r.port.stock_map(0x203, 0x01000401);
    r.pump(7000);
    const std::string text = r.svc->server().status_text(r.now);
    ok("a target that does not take over: parked, no timeout, in the events and the status",
       ea.target["panel"] == "parked" && ea.holder["panel"] == "stock" && r.port.taken_over.size() == overs &&
           text.find("target panel: slot 0x203 scene 0x1000400 1920x720: parked (stock) parked behind stock") !=
               std::string::npos);
    ok("the status: the map's released scene still published, subscriptions not observable",
       text.find("target map: slot 0x100 scene 0x10004f0 1088x480: idle; scene published") != std::string::npos &&
           text.find("renderer: subscription not observable") != std::string::npos);
    r.port.stock_unmap(0x203, 0x01000401);
    r.pump(50);
    ok("the stock content gone: shown", ea.target["panel"] == "shown");
}

int main()
{
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, nullptr, _IONBF, 0);
    Rig r;
    cr::Client a("waze", r.path), b("overlay", r.path);
    Events ea, eb;
    ea.wire(a);
    eb.wire(b);
    r.clients = {&a, &b};
    r.pump(50);
    ok("hello: both clients ready, the backend and targets named",
       ea.ready == 1 && eb.ready == 1 && a.backend == "fake" && a.targets == "map:1088x480,panel:1920x720");


    cr::LayerOptions lo;
    lo.target = "map";
    lo.contend = true;
    const uint32_t map = a.video(lo, cr::VideoOptions());
    r.pump(100);
    ok("a video layer without frames is stalled and asks for nothing",
       ea.layer[map] == "stalled" && r.port.requests == 0 && ea.target["map"] == "idle");
    const std::vector<uint8_t> f1 = atlas(1);
    ok("a frame of the wrong size is refused by the client", !a.frame(map, f1.data(), 100, 1));
    ok("its first frame is taken", a.frame(map, f1.data(), f1.size(), 1));
    r.pump(20);
    ok("the target is requested, the layer waits for it", r.port.requests == 1 && ea.layer[map] == "waiting");
    r.pump(100);
    FakeGraph *g = r.gpu.graph("map");
    std::vector<uint8_t> rounded(f1.size());
    crk::round_levels(rounded.data(), f1.data(), f1.size(), 2);
    bool atlas_shown = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            atlas_shown = atlas_shown || (kv.second.f == TexFormat::R8 && kv.second.px == rounded);
    ok("granted: shown, with the frame in the scene", ea.layer[map] == "shown" && ea.target["map"] == "shown" &&
                                                         atlas_shown);
    cr::LayerOptions turned = lo;
    turned.rotate = 10;
    turned.sx = 0.75f;
    a.set(map, turned);
    r.pump(20);
    const Layer *video = nullptr;
    for (const Layer *x : r.svc->compositor().layers())
        if (std::string(x->kind()) == "video")
            video = x;
    ok("the C++ client turns a video layer", video && video->params.rotate == 10 && video->params.sx == 0.75f);

    cr::LayerOptions ov;
    ov.target = "map";
    ov.klass = "overlay";
    ov.x = 900;
    ov.y = 400;
    ov.w = 64;
    ov.h = 64;
    cr::ImageOptions io;
    io.w = io.h = 64;
    const uint32_t badge = b.image(ov, io);
    std::vector<uint8_t> px(64 * 64 * 4, 255);
    b.pixels(badge, {}, px.data(), px.size());
    r.pump(100);
    ok("a second client's overlay joins the same scene: shown, no second request",
       eb.layer[badge] == "shown" && r.port.requests == 1 && g && g->visible().size() == 2);

    r.port.steal(r.sc.targets[0]);
    r.pump(20);
    ok("the stock HMI takes the slot: both layers wait, the target names the stock HMI",
       ea.layer[map] == "waiting" && eb.layer[badge] == "waiting" && ea.target["map"] == "waiting" &&
           ea.holder["map"] == "stock");
    a.frame(map, f1.data(), f1.size(), 2);   /* frames keep coming while it waits */
    r.pump(2100);
    ok("the contending video asks again after 2 s and both are shown",
       r.port.requests == 2 && ea.layer[map] == "shown" && eb.layer[badge] == "shown");
    {
        std::vector<uint8_t> f2 = atlas(2), wrong(100);
        const std::vector<uint8_t> want = f2;
        ok("a frame handed over without a copy: a wrong size is refused and left as it was",
           !a.frame(map, &wrong, 3) && wrong.size() == 100);
        ok("a frame handed over: taken, and a buffer of its size comes back",
           a.frame(map, &f2, 3) && f2.size() == want.size());
        r.pump(100);
        std::vector<uint8_t> rounded2(want.size());
        crk::round_levels(rounded2.data(), want.data(), want.size(), 2);
        bool shown2 = false;
        g = r.gpu.graph("map");
        if (g)
            for (const auto &kv : g->shown.buffers)
                shown2 = shown2 || (kv.second.f == TexFormat::R8 && kv.second.px == rounded2);
        ok("and the scene shows it", shown2);
    }

    /* The video's client goes; the overlay keeps the target up. */
    r.clients = {&b};
    {
        cr::Client *pa = new cr::Client("waze2", r.path);
        Events e;
        e.wire(*pa);
        r.clients.push_back(pa);
        r.pump(50);
        cr::LayerOptions l2;
        l2.target = "panel";
        const uint32_t ref = pa->effect(l2, cr::EffectOptions{"#version 100\nvoid main(){gl_FragColor=vec4(1.0);}", "", 0});
        r.pump(100);
        ok("an effect layer on another target is shown", e.layer[ref] == "shown");
        r.clients.pop_back();
        delete pa;
        r.pump(50);
    }
    ok("its client gone: its layer is removed, the panel lingers", r.svc->compositor().layers().size() == 2 &&
                                                                     eb.target["panel"] == "lingering");
    const int releases = r.port.releases;
    a.drop(map);
    r.clients = {&a, &b};
    r.pump(50);
    r.clients = {&b};
    ok("the video dropped: the overlay keeps the map up, no release",
       r.port.releases == releases && eb.target["map"] == "shown");
    b.drop(badge);
    r.pump(1400);
    ok("the last layer gone: the map lingers", eb.target["map"] == "lingering");
    r.pump(200);
    ok("then is released", eb.target["map"] == "idle");
    {
        const SlotInfo *stock = r.port.row(0x100, 0x01000101);
        ok("the stock map, parked behind ours since the take-over, is shown again",
           r.port.taken_over.size() == 1 && stock && stock->map_status == 1 && !r.port.row(0x100, 0x010004f0));
    }
    r.port.free_slot(r.sc.targets[0]);   /* the HMI leaves the map slot */

    /* Errors reach the client. */
    cr::LayerOptions bad;
    bad.target = "nowhere";
    b.effect(bad, cr::EffectOptions{"x", "", 0});
    r.pump(20);
    ok("a layer on an unknown target is refused with a reason",
       !eb.errors.empty() && eb.errors.back().find("unknown target") != std::string::npos);

    /* The service restarts under the client: its layers are made again and
     * its image sent whole. */
    const uint32_t badge2 = b.image(ov, io);
    px.assign(px.size(), 77);
    b.pixels(badge2, {}, px.data(), px.size());
    r.pump(100);
    ok("before the restart: shown", eb.layer[badge2] == "shown");
    r.svc.reset();
    r.pump(100);
    r.start();
    eb.layer.clear();
    r.pump(1500);
    g = r.gpu.graph("map");
    bool resent = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            resent = resent || (kv.second.f == TexFormat::RGBA8 && kv.second.px[0] == 77);
    ok("after it: the client reconnected, its layer made again and its image sent whole",
       eb.ready >= 2 && eb.layer[badge2] == "shown" && resent);

    /* What a client could send that the clients never do. */
    Raw raw(r.path);
    raw.send("{\"op\":\"hello\",\"app\":\"raw\"}");
    raw.send("{\"op\":\"layer\",\"ref\":1,\"target\":\"panel\",\"kind\":\"effect\",\"fs\":\"x\","
             "\"opacity\":nan}");
    raw.send("{\"op\":\"layer\",\"ref\":2,\"target\":\"panel\",\"kind\":\"effect\",\"fs\":\"x\"}");
    for (int k = 0; k < 40; k++)
        raw.send("{\"op\":\"uniform\",\"ref\":2,\"name\":\"u_" + std::to_string(k) + "\",\"v\":\"1\"}");
    raw.send("{\"op\":\"uniform\",\"ref\":2,\"name\":\"u_x\",\"v\":\"inf\"}");
    r.pump(50);
    const std::string got = raw.events();
    ok("NaN is not a number in range", got.find("opacity must be a number") != std::string::npos);
    ok("a layer's uniform names are limited", got.find("at most 32 uniforms") != std::string::npos);
    ok("a uniform must be finite", got.find("finite numbers") != std::string::npos);

    /* A target waiting on a timer is reported once, not every pass. */
    r.port.grant_ms = 100000;   /* requests go unanswered: the 5 s timeout, then the ladder */
    cr::Client w("waiter", r.path);
    Events ew;
    ew.wire(w);
    r.clients.push_back(&w);
    int target_events = 0;
    w.on_target = [&](const std::string &t, const std::string &, const std::string &, const std::string &) {
        if (t == "map")
            target_events++;
    };
    r.pump(50);
    cr::LayerOptions wl;
    wl.target = "map";
    w.effect(wl, cr::EffectOptions{"#version 100\nvoid main(){gl_FragColor=vec4(1.0);}", "", 0});
    r.pump(5100);
    target_events = 0;
    r.pump(1900);
    ok("waiting for its retry: no repeated target events", target_events == 0);

    /* An image layer the app has not drawn yet is not sent, so it asks for
     * nothing; overlapping updates bigger than the image go whole. */
    cr::LayerOptions il;
    il.target = "panel";
    il.w = 1920;
    il.h = 720;
    cr::Client big("big", r.path);
    Events ebig;
    ebig.wire(big);
    const uint32_t full = big.image(il, cr::ImageOptions());
    r.clients.push_back(&big);
    r.pump(200);
    ok("an image layer never drawn stays stalled", ebig.layer[full] == "stalled");
    /* The whole image is still being written when two updates of 3 MB
     * follow: together they would be a 6.1 MB message, over the service's
     * limit, so they go as the whole image. */
    std::vector<uint8_t> whole(1920 * 720 * 4, 20), rows(1920 * 400 * 4, 50);
    big.pixels(full, {}, whole.data(), whole.size());
    big.pixels(full, {cr::FrameRect{0, 0, 1920, 400}}, rows.data(), rows.size());
    big.pixels(full, {cr::FrameRect{0, 300, 1920, 400}}, rows.data(), rows.size());
    r.pump(300);
    ok("updates outgrowing the image go whole: the client is not disconnected",
       ebig.ready == 1 && ebig.layer[full] == "shown");
    r.clients.pop_back();
    r.clients.pop_back();

    /* Assets, binds, uniform arrays, a turned image, a mesh layer and
     * animations, over the socket. */
    r.port.grant_ms = 50;
    cr::Client dash("dash", r.path);
    Events ed;
    ed.wire(dash);
    r.clients.push_back(&dash);
    r.pump(50);
    cr::AssetOptions ga;
    ga.target = "panel";
    ga.r8 = true;
    ga.w = 64;
    ga.h = 32;
    const uint32_t glyphs = dash.asset(ga);
    std::vector<uint8_t> gpx(64 * 32, 200);
    ok("an asset is taken and its pixels too", glyphs && dash.pixels(glyphs, {}, gpx.data(), gpx.size()));
    cr::LayerOptions tl;
    tl.target = "panel";
    tl.klass = "overlay";
    tl.x = 100;
    tl.y = 100;
    tl.w = 64;
    tl.h = 32;
    const uint32_t label = dash.effect(tl, cr::EffectOptions{"#version 100\nprecision mediump float;\n"
                                                            "uniform sampler2D u_atlas;\nuniform vec4 u_cells[2];\n"
                                                            "uniform float u_time;\nvarying vec2 v_uv;\nvoid main(){"
                                                            "gl_FragColor=texture2D(u_atlas,v_uv)*u_cells[1]*u_time;}",
                                                            "", 0},
                                      true);
    dash.bind(label, "u_atlas", glyphs);
    dash.uniform(label, "u_cells", cr::UniformType::Vec4, {0, 0, 1, 1, 1, 1, 1, 1});
    cr::LayerOptions nl;
    nl.target = "panel";
    nl.klass = "overlay";
    nl.x = 1500;
    nl.y = 100;
    nl.w = nl.h = 32;
    nl.rotate = 45;
    nl.pivot = true;
    nl.px = 16;
    nl.py = 30;
    cr::ImageOptions nio;
    const uint32_t needle = dash.image(nl, nio);
    std::vector<uint8_t> npx(32 * 32 * 4, 128);
    dash.pixels(needle, {}, npx.data(), npx.size());
    cr::AnimationOptions sweep;
    sweep.property = "rotate";
    sweep.keys = "0:0 1000:90 2000:0";
    sweep.loop = true;
    const uint32_t sweep_id = dash.animate(needle, sweep);
    cr::LayerOptions ml;
    ml.target = "panel";
    ml.x = 600;
    ml.y = 200;
    ml.w = 400;
    ml.h = 300;
    cr::MeshOptions mo;
    mo.cz = 6;
    const uint32_t box = dash.mesh(ml, mo);
    cr::PartOptions po;
    po.vs = "#version 100\nattribute vec3 a_position;\nattribute vec3 a_normal;\nuniform mat4 u_mvp;\n"
            "uniform mat4 u_normal;\nvarying vec3 v_n;\nvoid main(){v_n=(u_normal*vec4(a_normal,0.0)).xyz;"
            "gl_Position=u_mvp*vec4(a_position,1.0);}";
    po.fs = "#version 100\nprecision mediump float;\nuniform vec4 u_color;\nvarying vec3 v_n;\n"
            "void main(){gl_FragColor=u_color*max(v_n.z,0.2);}";
    ok("a mesh layer's part and its geometry are taken", box && dash.part(box, 1, po) && dash.geometry(box, 1, cube()));
    cr::Transform tf;
    tf.ry = 30;
    dash.transform(box, 1, tf);
    dash.uniform(box, "u_color", cr::UniformType::Vec4, {1, 0.5f, 0, 1}, 1);
    cr::AnimationOptions spin;
    spin.part = 1;
    spin.property = "rotate";
    spin.keys = "0:0,0,0 4000:0,360,0";
    spin.loop = true;
    dash.animate(box, spin);
    r.pump(300);
    FakeGraph *pg = r.gpu.graph("panel");
    auto check_dash = [&](const char *when) {
        pg = r.gpu.graph("panel");
        const FakeQuad *tq = nullptr, *nq = nullptr;
        const FakePart *part = nullptr;
        const FakeBuffer *ab = nullptr;
        if (pg) {
            for (const auto &kv : pg->shown.quads) {
                if (kv.second.textures.count("u_atlas"))
                    tq = &kv.second;
                if (kv.second.turn.rotate == 45)
                    nq = &kv.second;
            }
            for (const auto &kv : pg->shown.parts)
                part = &kv.second;
            if (tq)
                ab = &pg->shown.buffers.at(tq->textures.at("u_atlas"));
        }
        int clock = 0, sweeps = 0, spins = 0;
        if (pg)
            for (const auto &kv : pg->shown.animations) {
                clock += kv.second.a.uniform == "u_time";
                sweeps += kv.second.a.property == crs::Animated::Rotate && kv.second.a.width == 1;
                spins += kv.second.a.property == crs::Animated::Rotate && kv.second.a.width == 3;
            }
        ok((std::string(when) + ": every layer shown").c_str(),
           ed.layer[label] == "shown" && ed.layer[needle] == "shown" && ed.layer[box] == "shown");
        ok((std::string(when) + ": the effect samples the asset, written whole, with its uniform array").c_str(),
           tq && tq->visible && ab && ab->px == gpx && tq->types.count("u_cells") &&
               tq->uniforms.at("u_cells").size() == 8);
        ok((std::string(when) + ": the image turned about its pivot").c_str(),
           nq && nq->turn.px == 16 && nq->turn.py == 30);
        ok((std::string(when) + ": the part with its geometry, transform and uniform").c_str(),
           part && part->geometry && part->vertices == 24 && part->indices == 36 && part->pose.r[1] == 30 &&
               part->uniforms.count("u_color"));
        ok((std::string(when) + ": u_time, the sweep and the spin played by the renderer").c_str(),
           clock == 1 && sweeps == 1 && spins == 1);
    };
    check_dash("over the socket");
    dash.drop(glyphs);
    r.pump(20);
    ok("an asset a layer samples is not dropped", !ed.errors.empty() && ed.errors.back() == "drop: asset in use");
    dash.stop(needle, sweep_id);
    r.pump(20);
    int sweeping = 0;
    for (const auto &kv : pg->shown.animations)
        sweeping += kv.second.a.width == 1 && kv.second.a.property == crs::Animated::Rotate;
    ok("a stopped animation leaves the scene", sweeping == 0);
    dash.animate(needle, sweep);
    r.pump(20);

    /* The service restarts: everything is made again from the client. */
    r.svc.reset();
    r.pump(100);
    r.start();
    ed.layer.clear();
    r.pump(1500);
    check_dash("after a restart");
    r.clients.pop_back();

    /* What a client could send that the clients never do. */
    Raw rawm(r.path);
    rawm.send("{\"op\":\"hello\",\"app\":\"bad\"}");
    rawm.send("{\"op\":\"layer\",\"ref\":1,\"target\":\"panel\",\"kind\":\"mesh\"}");
    rawm.send("{\"op\":\"part\",\"ref\":1,\"part\":1,\"vs\":\"attribute vec3 a_position;\",\"fs\":\"x\"}");
    const std::string tri(3 * 12, '\0');
    const std::string idx = std::string("\0\0\1\0\2\0", 6);
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, tri.substr(0, 10)));
    rawm.send_message(mesh_body(1, 1, 3, 3, 8, tri + idx));
    rawm.send_message(mesh_body(1, 1, 1000000, 3, 0, tri + idx));
    rawm.send_message(mesh_body(1, 1, 3, 4, 0, tri + idx + std::string(2, '\0')));
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, tri + std::string("\0\0\1\0\7\0", 6)));
    std::string nan = tri;
    const uint32_t qnan = 0x7fc00000;
    std::memcpy(&nan[4], &qnan, 4);
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, nan + idx));
    rawm.send_message(cr::encode(cr::kMesh, "abc"));
    rawm.send_message(mesh_body(9, 1, 3, 3, 0, tri + idx));
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, tri + idx));
    rawm.send_message(mesh_body(1, 1, 3, 3, 0, tri + idx));
    rawm.send("{\"op\":\"animate\",\"ref\":1,\"anim\":1,\"part\":1,\"property\":\"rotate\",\"keys\":\"5:1 2:1\"}");
    rawm.send("{\"op\":\"animate\",\"ref\":1,\"anim\":1,\"part\":1,\"property\":\"rotate\",\"keys\":\"0:1,2\"}");
    rawm.send("{\"op\":\"uniform\",\"ref\":1,\"part\":1,\"name\":\"u_m\",\"type\":\"mat4\",\"v\":\"1 2 3\"}");
    rawm.send("{\"op\":\"asset\",\"ref\":2,\"target\":\"panel\",\"w\":4096,\"h\":4}");
    rawm.send("{\"op\":\"status\"}");
    r.pump(100);
    const std::string said = rawm.events();
    ok("a short mesh message is refused", said.find("this mesh is") != std::string::npos);
    ok("unknown mask bits are refused", said.find("mask bits") != std::string::npos);
    ok("too many vertices are refused", said.find("1 to 65535 vertices") != std::string::npos);
    ok("indices that are not whole triangles are refused", said.find("whole triangles") != std::string::npos);
    ok("an index past the vertices is refused", said.find("past its vertices") != std::string::npos);
    ok("a value that is not finite is refused", said.find("must be finite") != std::string::npos);
    ok("a header too short is refused", said.find("header is 17 bytes") != std::string::npos);
    ok("geometry for no layer is refused", said.find("no such layer") != std::string::npos);
    ok("a part's geometry replaced within a second is refused", said.find("once a second") != std::string::npos);
    ok("keys out of order or of the wrong width are refused",
       said.find("keys are t:v") != std::string::npos && said.find("3 values") != std::string::npos);
    ok("a uniform of part elements is refused", said.find("whole elements") != std::string::npos);
    ok("an asset too big is refused", said.find("w must be a number from 1 to 2048") != std::string::npos);
    ok("and the service still answers", said.find("\"ev\":\"status\"") != std::string::npos);

    {
        /* The shared cap, steered by the governor, reaches every client. */
        Rig lr(6000 * 1024);
        cr::Client c("budget", lr.path);
        int budgets = 0;
        unsigned cap = 0;
        std::string why, status;
        c.on_budget = [&](unsigned kb, unsigned, const std::string &reason) {
            budgets++;
            cap = kb;
            why = reason;
        };
        c.on_status = [&](const std::string &t) { status = t; };
        lr.clients = {&c};
        lr.pump(50);
        lr.svc->compositor().governor().activity(lr.now);   /* evidence counts while writes go */
        lr.svc->compositor().governor().evidence(Evidence::Removal, lr.now);
        lr.pump(50);
        c.request_status();
        lr.pump(50);
        ok("the C++ client hears the cap at hello and when the governor lowers it, and gets the status",
           budgets == 2 && cap == 5500 && why.find("1 x scene removed") != std::string::npos &&
               status.find("upload: cap 5500 KB/s") != std::string::npos);
    }

    std::string text = r.svc->server().status_text(r.now);
    ok("the status names the targets and the layers",
       text.find("target map") != std::string::npos && text.find("image of overlay") != std::string::npos);
    take_over_and_fall_back();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
