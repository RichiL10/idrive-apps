/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Runs the compositor on the unit's own libramses (TCP, no renderer) with a
 * display port that grants every request: every layer kind's objects,
 * shaders (compiled by the library's glslang), buffer writes, uniforms,
 * draw-order changes, an exclusive layer, removals and a scene published
 * again must be accepted, with nothing logged as an error by this service
 * or the library. Then the 3D and asset side: the backend's own answers for
 * every new call (uniform arrays, turned quads, views split into passes,
 * parts and their geometry, every kind of animation), and through the
 * compositor a lit rotating cube, an effect sampling an R8 glyph atlas and
 * an RGBA8 sprite with a vec4 array, a turned needle and an effect on the
 * renderer's clock, published again. Run by `make test-ramses ROOTFS=<dir>`;
 * built with CRS_RAMSES27 against iDrive 8's RAMSES 27 (graph_ramses27.h),
 * by `make test-ramses27 ROOTFS=<dir>`. */
#include <cmath>
#include <cstdio>
#include <vector>

#include "../src/compositor.h"
#include "fake_port.h"
#include "log.h"
#ifdef CRS_RAMSES27
#include "../src/graph_ramses27.h"
#include "ramses-client-api/RamsesClient.h"
#include "ramses-framework-api/RamsesFramework.h"
#include "ramses-framework-api/RamsesFrameworkConfig.h"
#else
#include "../src/graph_ramses19.h"
#include "ramses19/ramses.h"
#endif

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const char *const kBars = R"(#version 100
precision mediump float;
uniform float u_level;
uniform float u_time;
varying vec2 v_uv;
void main() {
    float bar = step(abs(v_uv.y - 0.5) * 2.0, u_level * (0.6 + 0.4 * sin(u_time * 6.0 + v_uv.x * 20.0)));
    gl_FragColor = vec4(1.0, 0.1, 0.1, bar);
})";

static const char *const kLitVs = R"(#version 100
attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat4 u_mvp;
uniform mat4 u_normal;
varying vec3 v_n;
void main() {
    v_n = (u_normal * vec4(a_normal, 0.0)).xyz;
    gl_Position = u_mvp * vec4(a_position, 1.0);
})";

static const char *const kLitFs = R"(#version 100
precision mediump float;
uniform vec4 u_color;
varying vec3 v_n;
void main() {
    float d = max(dot(normalize(v_n), normalize(vec3(0.4, 0.7, 0.6))), 0.0);
    gl_FragColor = vec4(u_color.rgb * (0.22 + 0.78 * d), 1.0);
})";

/* Every semantic and attribute a part's shaders can have. */
static const char *const kAllVs = R"(#version 100
attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec2 a_texcoord;
attribute vec4 a_color;
uniform mat4 u_mvp;
uniform mat4 u_mv;
uniform mat4 u_m;
uniform mat4 u_v;
uniform mat4 u_p;
uniform mat4 u_normal;
uniform mat4 u_bones[2];
varying vec2 v_uv;
varying vec4 v_color;
void main() {
    v_uv = a_texcoord;
    v_color = a_color * (u_normal * vec4(a_normal, 0.0)).z;
    vec4 p = u_bones[0] * u_bones[1] * vec4(a_position, 1.0);
    gl_Position = u_mvp * p + (u_p * u_v * u_m * p - u_p * u_mv * p);
})";

static const char *const kAllFs = R"(#version 100
precision mediump float;
uniform sampler2D u_atlas;
uniform vec3 u_tint;
uniform float u_fade;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
    gl_FragColor = vec4(v_color.rgb * u_tint, texture2D(u_atlas, v_uv).r * u_fade);
})";

/* A glyph of an R8 atlas over an RGBA8 sprite, cells from a vec4 array. */
static const char *const kGlyphs = R"(#version 100
precision mediump float;
uniform sampler2D u_atlas;
uniform sampler2D u_sprite;
uniform vec4 u_cells[4];
varying vec2 v_uv;
void main() {
    float a = texture2D(u_atlas, u_cells[0].xy + v_uv * u_cells[0].zw).r;
    vec4 s = texture2D(u_sprite, v_uv);
    gl_FragColor = vec4(mix(s.rgb, u_cells[1].rgb, a), max(s.a, a)) + u_cells[2] * u_cells[3].x;
})";

/* Plasma on the renderer's clock. */
static const char *const kPlasma = R"(#version 100
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float u_time;
varying vec2 v_uv;
void main() {
    vec2 p = (v_uv - 0.5) * 6.0;
    float v = sin(p.x + u_time) + sin(p.y * 1.3 - u_time * 0.7) + sin(length(p) * 2.2 - u_time * 1.4);
    gl_FragColor = vec4(0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v * 1.6), 1.0);
})";

/* A cube: 6 faces x 4 vertices with their normals. */
static MeshData cube_mesh()
{
    static const float n[6][3] = {{0, 0, 1}, {0, 0, -1}, {1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}};
    MeshData d;
    for (int f = 0; f < 6; f++) {
        const float *N = n[f];
        const float a[3] = {N[1], N[2], N[0]};
        const float b[3] = {N[1] * a[2] - N[2] * a[1], N[2] * a[0] - N[0] * a[2], N[0] * a[1] - N[1] * a[0]};
        const uint16_t base = (uint16_t)(d.position.size() / 3);
        for (int v = 0; v < 4; v++) {
            const float sa = (v & 1) ? 1.0f : -1.0f, sb = (v & 2) ? 1.0f : -1.0f;
            for (int c = 0; c < 3; c++) {
                d.position.push_back(N[c] + sa * a[c] + sb * b[c]);
                d.normal.push_back(N[c]);
                d.texcoord.push_back(c == 2 ? 0.0f : (c ? sb : sa) * 0.5f + 0.5f);
            }
            d.texcoord.pop_back();
            d.color.insert(d.color.end(), {1.0f, 0.5f, 0.0f, 1.0f});
        }
        for (uint16_t k : {0, 1, 2, 2, 1, 3})
            d.index.push_back((uint16_t)(base + k));
    }
    d.vertices = (uint32_t)(d.position.size() / 3);
    return d;
}

static Animation keyed(Animated prop, uint32_t width, std::vector<uint32_t> t, std::vector<float> v, bool step = false,
                       const char *uniform = "")
{
    Animation a;
    a.property = prop;
    a.width = width;
    a.t = t;
    a.v = v;
    a.loop = true;
    a.step = step;
    a.uniform = uniform;
    return a;
}

/* The backend's answers to every 3D, asset and animation call, on a scene
 * of its own. */
static void backend(Gpu &gpu)
{
    std::string err;
    TargetSpec t;
    t.name = "check";
    t.scene_id = 0x010004f8;
    t.width = 1920;
    t.height = 720;
    std::unique_ptr<Graph> g = gpu.scene(t, &err);
    const int glyph_fx = gpu.effect(kQuadVertexShader, kGlyphs, &err);
    const int all_fx = gpu.effect(kAllVs, kAllFs, &err);
    const int lit_fx = gpu.effect(kLitVs, kLitFs, &err);
    ok("effects with every semantic, attribute and array compile",
       g && glyph_fx && all_fx && lit_fx &&
           gpu.attributes(all_fx) == (kAttrPosition | kAttrNormal | kAttrTexcoord | kAttrColor) &&
           gpu.attributes(lit_fx) == (kAttrPosition | kAttrNormal));
    if (!g || !glyph_fx || !all_fx || !lit_fx)
        return;
    const int atlas = g->buffer(TexFormat::R8, 64, 32, Sampling::Bilinear, Wrap::Repeat);
    const int sprite = g->buffer(TexFormat::RGBA8, 16, 16, Sampling::Nearest, Wrap::Clamp);
    std::vector<uint8_t> px(64 * 32 * 4, 90);
    Rect r;
    r.x = 100; r.y = 100; r.w = 200; r.h = 80;
    const int q1 = g->quad(glyph_fx, r);
    const float cells[16] = {0, 0, 0.25f, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0};
    Turn turn;
    turn.rotate = 30; turn.sx = 1.5f; turn.px = 100; turn.py = 70;
    ok("repeating and clamped buffers, written, sampled by one quad",
       atlas && sprite && g->write(atlas, 0, 0, 64, 32, px.data()) && g->write(sprite, 0, 0, 16, 16, px.data()) &&
           q1 && g->texture(q1, "u_atlas", atlas) && g->texture(q1, "u_sprite", sprite));
    ok("a vec4 array uniform and a turn", g->uniform_array(q1, "u_cells", UniformType::Vec4, cells, 4) &&
                                             g->turn(q1, turn) && g->show(q1, true) && g->order(q1, 0));
    Projection persp;
    Projection ortho;
    ortho.ortho = true;
    ortho.ortho_h = 4;
    Pose cam;
    cam.t[2] = 6;
    cam.r[0] = -10;
    Rect vr;
    vr.x = -100; vr.y = 50; vr.w = 600; vr.h = 400;   /* reaches past the left edge */
    const int v1 = g->view(vr, persp, cam);
    vr.x = 1000; vr.y = 300;
    const int v2 = g->view(vr, ortho, cam);
    const int q2 = g->quad(glyph_fx, r);
    const int q3 = g->quad(glyph_fx, r);
    for (int q : {q2, q3})
        g->texture(q, "u_atlas", atlas), g->texture(q, "u_sprite", sprite),
            g->uniform_array(q, "u_cells", UniformType::Vec4, cells, 4), g->show(q, true);
    ok("perspective and orthographic views between quads: five passes",
       v1 && v2 && g->show(v1, true) && g->show(v2, true) && g->order(v1, 4) && g->order(q2, 8) &&
           g->order(v2, 12) && g->order(q3, 16) && g->flush(1));
    PartLook flat;
    flat.depth = false; flat.cull = Cull::None; flat.blend = Blend::Add;
    PartLook opaque;
    opaque.blend = Blend::None; opaque.cull = Cull::Front;
    const int p1 = g->part(v1, lit_fx, PartLook());
    const int p2 = g->part(v1, all_fx, flat);
    const int p3 = g->part(v2, all_fx, opaque);
    const MeshData cube = cube_mesh();
    Geometry bare = cube.geometry();
    bare.normal = nullptr;
    const float bones[32] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const float tint[3] = {1, 0.5f, 0.2f}, fade = 1.0f, orange[4] = {1, 0.45f, 0, 1};
    Pose pose;
    pose.r[1] = 30; pose.t[2] = -1; pose.s[0] = 1.5f;
    ok("parts: geometry with every attribute, uniforms of every kind, a sampler, a pose",
       p1 && p2 && p3 && g->geometry(p1, cube.geometry()) && g->geometry(p2, cube.geometry()) &&
           g->geometry(p3, cube.geometry()) && g->uniform(p1, "u_color", orange, 4) &&
           g->uniform_array(p2, "u_bones", UniformType::Mat4, bones, 2) &&
           g->uniform_array(p2, "u_tint", UniformType::Vec3, tint, 1) && g->uniform(p2, "u_fade", &fade, 1) &&
           g->texture(p2, "u_atlas", atlas) && g->pose(p1, pose) && g->flush(2));
    ok("geometry lacking what the shader reads is refused", !g->geometry(p1, bare));
    ok("geometry replaced", g->geometry(p1, cube.geometry()) && g->flush(3));
    const int a1 = g->animate(q1, keyed(Animated::Rotate, 1, {0, 1000}, {0, 90}));
    const int a2 = g->animate(q1, keyed(Animated::Translate, 3, {0, 1000}, {0, 0, 0, 40, 20, 0}));
    const int a3 = g->animate(q2, keyed(Animated::Scale, 3, {0, 500, 1000}, {1, 1, 1, 2, 2, 1, 1, 1, 1}, true));
    const int a4 = g->animate(p1, keyed(Animated::Rotate, 3, {0, 4000}, {0, 0, 0, 0, 360, 0}));
    const int a5 = g->animate(p2, keyed(Animated::Translate, 3, {0, 1000}, {0, 0, 0, 0, 1, 0}, true));
    const int a6 = g->animate(v1, keyed(Animated::Translate, 3, {0, 2000}, {0, 0, 6, 0, 0, 8}));
    const int a7 = g->animate(v2, keyed(Animated::Rotate, 3, {0, 2000}, {0, 0, 0, 0, 30, 0}));
    const int a8 = g->animate(p2, keyed(Animated::Uniform, 1, {0, 1000}, {0, 1}, false, "u_fade"));
    const int a9 = g->animate(p2, keyed(Animated::Uniform, 3, {0, 1000}, {1, 0, 0, 0, 0, 1}, true, "u_tint"));
    const int a10 = g->animate(p1, keyed(Animated::Uniform, 4, {0, 1000}, {1, 0, 0, 1, 0, 0, 1, 1}, false, "u_color"));
    const int a11 = g->animate(p1, keyed(Animated::Uniform, 4, {0, 1000}, {1, 0, 0, 1, 0, 0, 1, 1}, true, "u_color"));
    ok("animations of every property, linear and step, on quads, parts and cameras",
       a1 && a2 && a3 && a4 && a5 && a6 && a7 && a8 && a9 && a10 && a11 && g->flush(4));
    g->stop(a1);
    g->stop(a11);
    g->order(v1, 20);   /* the views together at the top: three passes, a segment fewer */
    g->order(v2, 24);
    ok("stopped, reordered", g->flush(5));
    Projection near = persp;
    near.fov = 50;
    vr.x = 2000;   /* past the right edge: nothing to draw */
    ok("a camera changed, a view moved off the target", g->camera(v1, near, cam) && g->place(v2, vr) && g->flush(6));
    g->drop_part(p2);
    g->drop_view(v2);
    g->drop_quad(q3);
    ok("parts, views and quads dropped with their animations", g->flush(7));
    g.reset();
    gpu.drop_effect(glyph_fx);
    gpu.drop_effect(all_fx);
    gpu.drop_effect(lit_fx);
}

int main()
{
    cld::log_name = "ramses_check";
#ifdef CRS_RAMSES27
    ramses::RamsesFramework::SetConsoleLogLevel(ramses::ELogLevel::Warn);
    ramses::RamsesFrameworkConfig fwc;
    ramses::RamsesFramework framework(fwc);
    ramses::RamsesClient *client = framework.createClient("ramses_check");
    if (!client || framework.connect() != ramses::StatusOK) {
        std::printf("FAIL connect\n");
        return 1;
    }
    Ramses27Gpu gpu(*client);
#else
    const char *args[] = {"ramses_check"};
    ramses::RamsesFrameworkConfig fwc(1, args);
    ramses::RamsesFramework framework(fwc);
    ramses::RamsesClient client("ramses_check", framework);
    if (framework.connect() != ramses::StatusOK) {
        std::printf("FAIL connect\n");
        return 1;
    }
    Ramses19Gpu gpu(client);
#endif
    std::string err;
    ok("the unit quad", gpu.init(&err));

    FakePort port;
    SlotManager slots(&port, nullptr);
    TargetSpec m;
    m.name = "map"; m.slot = 0x100; m.scene_id = 0x010004f0; m.width = 1088; m.height = 480; m.linger_ms = 500;
    m.take_over_stock = true;
    m.take_over_contents = {0x01000300, 0x01000101};   /* the HMI's map and FakePort::steal's stock content */
    TargetSpec p;
    p.name = "panel"; p.slot = 0x203; p.scene_id = 0x01000400; p.width = 1920; p.height = 720; p.linger_ms = 500;
    slots.add(m);
    slots.add(p);
    GovernorConfig gc;
    Compositor comp(&gpu, &slots, gc, 250);
    slots.set_scenes(&comp);
    port.m = &slots;
    ok("the built-in effects compile", comp.init(&err));

    int64_t now = 10000;
    auto run = [&](int64_t ms) {
        for (int64_t t = 0; t < ms; t += 33) {
            now += 33;
            port.tick(now);
            comp.arrange(now);
            slots.tick(now);
            comp.render(now);
        }
    };

    LayerParams lp;
    lp.contend = true;
    lp.rect.w = 1088;
    lp.rect.h = 480;
    VideoParams vp;
    const uint32_t vid = comp.add_video(1, 0, lp, vp, now, &err);
    VideoLayer *video = static_cast<VideoLayer *>(comp.layer(1, vid));
    LayerParams ip;
    ip.klass = Klass::Overlay;
    ip.rect.x = 900; ip.rect.y = 380; ip.rect.w = 160; ip.rect.h = 80;
    const uint32_t img = comp.add_image(2, 0, ip, 160, 80, 30, Sampling::Nearest, now, &err);
    ImageLayer *image = static_cast<ImageLayer *>(comp.layer(2, img));
    LayerParams ep;
    ep.klass = Klass::Overlay;
    ep.rect.x = 740; ep.rect.y = 461; ep.rect.w = 440; ep.rect.h = 132;
    const uint32_t fx = comp.add_effect(3, 1, ep, "", kBars, 30, now, &err);
    ok("a video, an image and an effect layer (the effect compiled by glslang)", vid && img && fx);
    const float level = 0.7f;
    static_cast<EffectLayer *>(comp.layer(3, fx))->set_uniform("u_level", &level, 1);

    std::vector<uint8_t> atlas(video->frame_bytes());
    std::vector<uint8_t> px(160 * 80 * 4, 200);
    image->update({}, px.data(), px.size(), &err);
    for (int i = 0; i < 90; i++) {
        /* Still, then a small change, then whole-picture motion (packed). */
        for (size_t k = 0; k < atlas.size(); k++)
            atlas[k] = (uint8_t)(i < 30 ? k / 13 : i < 60 ? (k / 13 + (k % 1088 < 64 ? i : 0)) : k / 13 + i * 9);
        video->offer(atlas.data(), now);
        if (i % 10 == 0) {
            std::vector<uint8_t> patch(16 * 16 * 4, (uint8_t)i);
            image->update({crk::PixelRect{8, 8, 16, 16}}, patch.data(), patch.size(), &err);
        }
        run(33);
    }
    run(1000);
    std::string reason;
    ok("all shown", comp.state(vid, &reason) == LayerState::Shown && comp.state(img, &reason) == LayerState::Shown &&
                        comp.state(fx, &reason) == LayerState::Shown);
    const std::string s = video->stats();
    std::printf("     video: %s\n", s.c_str());
    ok("whole, partial and packed writes all went", s.find(" 0 whole") == std::string::npos &&
                                                       s.find(" 0 partial") == std::string::npos &&
                                                       s.find(" 0 packed") == std::string::npos &&
                                                       s.find(" 0 failed") != std::string::npos);

    LayerParams xp;
    xp.klass = Klass::Alert;
    xp.exclusive = true;
    const uint32_t alert = comp.add_effect(4, 0, xp, "", "#version 100\nvoid main(){gl_FragColor=vec4(0.0,0.0,1.0,1.0);}",
                                           0, now, &err);
    run(200);
    ok("an exclusive alert suspends the rest", comp.state(vid, &reason) == LayerState::Suspended);
    comp.remove_owner(4);
    comp.layer(2, img)->params.z = -5;
    comp.changed(comp.layer(2, img));
    run(200);
    ok("removed, and the order changed: back", alert && comp.state(vid, &reason) == LayerState::Shown);

    port.steal(m);
    run(2500);
    ok("the scene taken and published again: shown", comp.state(vid, &reason) == LayerState::Shown);
    comp.remove_owner(1);
    comp.remove_owner(2);
    comp.remove_owner(3);
    run(1000);
    ok("every layer gone: both targets released", slots.status(0).state == TargetState::Idle &&
                                                      slots.status(1).state == TargetState::Idle);

    backend(gpu);

    /* Sample content through the compositor, on the panel. */
    AssetParams gp;
    gp.format = TexFormat::R8;
    gp.w = 256;
    gp.h = 64;
    gp.sampling = Sampling::Bilinear;
    const uint32_t glyphs = comp.add_asset(5, 1, gp, &err);
    AssetParams sp;
    sp.w = sp.h = 32;
    sp.wrap = Wrap::Repeat;
    const uint32_t sprite = comp.add_asset(5, 1, sp, &err);
    std::vector<uint8_t> gpx(256 * 64), spx(32 * 32 * 4);
    for (size_t i = 0; i < gpx.size(); i++)
        gpx[i] = (uint8_t)(i * 7);
    for (size_t i = 0; i < spx.size(); i++)
        spx[i] = (uint8_t)(i * 3);
    comp.asset(5, glyphs)->update({}, gpx.data(), gpx.size(), &err);
    comp.asset(5, sprite)->update({}, spx.data(), spx.size(), &err);
    LayerParams tp;
    tp.klass = Klass::Overlay;
    tp.rect.x = 60; tp.rect.y = 560; tp.rect.w = 512; tp.rect.h = 128;
    const uint32_t label = comp.add_effect(5, 1, tp, "", kGlyphs, 0, now, &err);
    EffectLayer *ll = static_cast<EffectLayer *>(comp.layer(5, label));
    const float cells[16] = {0, 0, 0.0625f, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0};
    ll->set_uniform("u_cells", UniformType::Vec4, cells, 4);
    const bool bound = comp.bind(5, label, 0, "u_atlas", glyphs, &err) && comp.bind(5, label, 0, "u_sprite", sprite, &err);

    LayerParams cp;
    cp.rect.x = 660; cp.rect.y = 120; cp.rect.w = 600; cp.rect.h = 480;
    MeshParams mp;
    mp.camera.t[2] = 6;
    const uint32_t box = comp.add_mesh(5, 1, cp, mp, now, &err);
    MeshLayer *ml = static_cast<MeshLayer *>(comp.layer(5, box));
    const bool parted = comp.add_part(5, box, 1, kLitVs, kLitFs, PartLook(), &err) &&
                        comp.geometry(5, box, 1, cube_mesh(), now, &err);
    const float orange[4] = {1, 0.45f, 0, 1};
    ml->set_uniform(1, "u_color", orange, 4);
    Pose tilt;
    tilt.r[0] = 25;
    ml->set_pose(1, tilt);
    const bool spinning = ml->animate(1, 1, keyed(Animated::Rotate, 3, {0, 6000}, {25, 0, 0, 25, 360, 0}), &err);

    LayerParams np;
    np.klass = Klass::Overlay;
    np.rect.x = 1500; np.rect.y = 160; np.rect.w = 24; np.rect.h = 240;
    np.rotate = -120;
    np.pivot_x = np.pivot_y = true;
    np.px = 12; np.py = 228;
    const uint32_t needle = comp.add_image(5, 1, np, 24, 240, 30, Sampling::Bilinear, now, &err);
    std::vector<uint8_t> npx(24 * 240 * 4, 220);
    static_cast<ImageLayer *>(comp.layer(5, needle))->update({}, npx.data(), npx.size(), &err);
    const bool sweeping = comp.layer(5, needle)->animate(1, 0, keyed(Animated::Rotate, 1, {0, 3000, 6000}, {-120, 120, -120}), &err);

    LayerParams pp;
    pp.klass = Klass::Ambient;
    const uint32_t plasma = comp.add_effect(5, 1, pp, "", kPlasma, 0, now, &err);
    static_cast<EffectLayer *>(comp.layer(5, plasma))->cluster_time();
    ok("assets, a mesh layer with a lit cube, a turned needle and a clock effect",
       glyphs && sprite && label && bound && box && parted && spinning && needle && sweeping && plasma);
    run(1500);
    auto all_shown = [&]() {
        for (uint32_t id : {label, box, needle, plasma})
            if (comp.state(id, &reason) != LayerState::Shown) {
                std::printf("     layer %u: %s %s\n", id, layer_state_name(comp.state(id, &reason)), reason.c_str());
                return false;
            }
        return true;
    };
    ok("all shown", all_shown());
    run(1100);
    ok("the cube's geometry replaced a second later", comp.geometry(5, box, 1, cube_mesh(), now, &err));
    run(200);
    port.steal(p);
    run(500);
    port.free_slot(p);   /* the HMI's content gone again */
    run(2500);
    ok("the panel taken and published again: assets, binds, parts and animations back", all_shown());
    comp.layer(5, needle)->stop(1);
    comp.touch(comp.layer(5, needle));
    run(100);
    comp.remove_owner(5);
    run(4000);
    ok("all gone: the panel released", slots.status(1).state == TargetState::Idle);
    ok("nothing logged as an error", cld::log_errors == 0);
    framework.disconnect();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
