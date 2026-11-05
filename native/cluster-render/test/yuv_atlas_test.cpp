/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the 4:2:0 atlas (yuv_atlas.h): that packing an NV12 picture
 * puts Y, U and V where the shader reads them; that the shader (through its
 * CPU twin, atlas_rgb) converts full-range BT.601; that its bilinear chroma
 * never mixes U, V and Y, also at the frame's edges; that chroma is sited
 * as H.264 defaults when a stream names no chroma location, as the phone's
 * does (left horizontally, centred vertically); and
 * that a whole frame's colours match a direct conversion of the decoded
 * picture.
 *
 * With a path argument (an NV12 file of 1088x480 frames, such as ffmpeg's
 * -pix_fmt nv12 -f rawvideo output) the last check also runs on that
 * picture's first frame. */
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "../kit/yuv_atlas.h"

using namespace crk;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

struct Nv12 {
    uint32_t w, h, pitch;
    std::vector<uint8_t> y, uv;   /* uv: h/2 rows of w bytes, U,V interleaved */
    Nv12(uint32_t w_, uint32_t h_, uint32_t pitch_) : w(w_), h(h_), pitch(pitch_), y((size_t)pitch_ * h_), uv((size_t)pitch_ * h_ / 2) {}
    uint8_t &Y(uint32_t x, uint32_t r) { return y[(size_t)r * pitch + x]; }
    uint8_t &U(uint32_t k, uint32_t r) { return uv[(size_t)r * pitch + 2 * k]; }
    uint8_t &V(uint32_t k, uint32_t r) { return uv[(size_t)r * pitch + 2 * k + 1]; }
};

static std::vector<uint8_t> atlas_of(Nv12 &f)
{
    std::vector<uint8_t> a((size_t)f.w * atlas_height(f.h), 0xee);
    pack_nv12_atlas(f.y.data(), f.pitch, f.uv.data(), f.pitch, f.w, f.h, a.data(), 0);
    return a;
}

/* Full-range BT.601, as the stream is coded. */
static void bt601_full(double y, double u, double v, double rgb[3])
{
    y /= 255.0;
    u = (u - 128) / 255.0;
    v = (v - 128) / 255.0;
    rgb[0] = y + 1.402 * v;
    rgb[1] = y - 0.344136 * u - 0.714136 * v;
    rgb[2] = y + 1.772 * u;
}

static int level(double v)
{
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    return (int)std::lround(v * 255.0);
}

/* The shader's colour at frame pixel (x, y) of a w x h quad drawn 1:1. */
static void pixel(const std::vector<uint8_t> &a, uint32_t w, uint32_t h, uint32_t x, uint32_t y, uint8_t rgb[3])
{
    atlas_rgb(a.data(), w, h, (x + 0.5) / w, (y + 0.5) / h, rgb);
}

/* The reference: chroma upsampled with that siting (sample k on luma
 * pixel 2k across, between luma rows 2k and 2k+1 down; edges replicated),
 * then converted. */
static void reference(Nv12 &f, uint32_t x, uint32_t y, int rgb[3])
{
    const double cxp = x / 2.0, cyp = (y + 0.5) / 2.0 - 0.5;
    auto chroma = [&](bool v) {
        const long cw = f.w / 2, ch = f.h / 2;
        const double fx = std::floor(cxp), fy = std::floor(cyp);
        const double ax = cxp - fx, ay = cyp - fy;
        auto at = [&](long i, long j) {
            i = i < 0 ? 0 : i >= cw ? cw - 1 : i;
            j = j < 0 ? 0 : j >= ch ? ch - 1 : j;
            return (double)(v ? f.V((uint32_t)i, (uint32_t)j) : f.U((uint32_t)i, (uint32_t)j));
        };
        const long i = (long)fx, j = (long)fy;
        return (1 - ay) * ((1 - ax) * at(i, j) + ax * at(i + 1, j)) + ay * ((1 - ax) * at(i, j + 1) + ax * at(i + 1, j + 1));
    };
    double c[3];
    bt601_full(f.Y(x, y), chroma(false), chroma(true), c);
    for (int k = 0; k < 3; k++)
        rgb[k] = level(c[k]);
}

/* Largest channel difference between the shader and the reference over the
 * whole frame. */
static int frame_error(Nv12 &f, double *mean)
{
    const std::vector<uint8_t> a = atlas_of(f);
    int worst = 0;
    double sum = 0;
    for (uint32_t y = 0; y < f.h; y++)
        for (uint32_t x = 0; x < f.w; x++) {
            uint8_t got[3];
            int want[3];
            pixel(a, f.w, f.h, x, y, got);
            reference(f, x, y, want);
            for (int k = 0; k < 3; k++) {
                const int d = std::abs(got[k] - want[k]);
                worst = d > worst ? d : worst;
                sum += d;
            }
        }
    *mean = sum / ((double)f.w * f.h * 3);
    return worst;
}

static void test_layout()
{
    Nv12 f(1088, 480, 1088 + 64);
    for (size_t i = 0; i < f.y.size(); i++) f.y[i] = (uint8_t)(i * 7 + 3);
    for (size_t i = 0; i < f.uv.size(); i++) f.uv[i] = (uint8_t)(i * 13 + 5);
    const std::vector<uint8_t> a = atlas_of(f);
    ok("atlas of 1088x480 is 1088x720", atlas_height(480) == 720 && a.size() == (size_t)1088 * 720);
    bool y_ok = true, u_ok = true, v_ok = true;
    for (uint32_t r = 0; r < 480; r++)
        for (uint32_t x = 0; x < 1088; x++)
            y_ok &= a[(size_t)r * 1088 + x] == f.Y(x, r);
    for (uint32_t r = 0; r < 240; r++)
        for (uint32_t k = 0; k < 544; k++) {
            u_ok &= a[(size_t)(480 + r) * 1088 + k] == f.U(k, r);
            v_ok &= a[(size_t)(480 + r) * 1088 + 544 + k] == f.V(k, r);
        }
    ok("Y plane in rows 0-479, pitch dropped", y_ok);
    ok("U plane in rows 480-719, columns 0-543", u_ok);
    ok("V plane in rows 480-719, columns 544-1087", v_ok);
}

static void test_colours()
{
    struct { uint8_t y, u, v; int r, g, b; const char *name; } c[] = {
        {255, 128, 128, 255, 255, 255, "white"},
        {0, 128, 128, 0, 0, 0, "black"},
        {128, 128, 128, 128, 128, 128, "grey"},
        {76, 85, 255, 255, 0, 1, "red"},
        {150, 44, 21, 0, 255, 1, "green"},
        {29, 255, 107, 0, 0, 255, "blue"},
    };
    for (const auto &k : c) {
        Nv12 f(64, 32, 64);
        std::fill(f.y.begin(), f.y.end(), k.y);
        for (uint32_t r = 0; r < 16; r++)
            for (uint32_t i = 0; i < 32; i++) {
                f.U(i, r) = k.u;
                f.V(i, r) = k.v;
            }
        const std::vector<uint8_t> a = atlas_of(f);
        uint8_t got[3];
        pixel(a, 64, 32, 10, 10, got);
        char name[96];
        std::snprintf(name, sizeof name, "full-range BT.601 %s (got %u,%u,%u)", k.name, got[0], got[1], got[2]);
        const bool neutral = k.u == 128 && k.v == 128;   /* exact: no chroma */
        const int tol = neutral ? 0 : 1;
        ok(name, std::abs(got[0] - k.r) <= tol && std::abs(got[1] - k.g) <= tol && std::abs(got[2] - k.b) <= tol);
    }
}

/* Y, U and V each one value, all different: every pixel, the edges
 * included, must be exactly that colour, so no sample mixes the planes. */
static void test_no_bleed()
{
    for (uint32_t w : {1088u, 816u, 64u}) {
        const uint32_t h = w == 1088 ? 480 : w == 816 ? 360 : 32;
        Nv12 f(w, h, w);
        std::fill(f.y.begin(), f.y.end(), 200);
        for (uint32_t r = 0; r < h / 2; r++)
            for (uint32_t i = 0; i < w / 2; i++) {
                f.U(i, r) = 40;
                f.V(i, r) = 230;
            }
        const std::vector<uint8_t> a = atlas_of(f);
        uint8_t want[3];
        pixel(a, w, h, w / 2, h / 2, want);
        bool same = true;
        for (uint32_t y = 0; y < h; y++)
            for (uint32_t x = 0; x < w; x++) {
                uint8_t got[3];
                pixel(a, w, h, x, y, got);
                same &= !std::memcmp(got, want, 3);
            }
        char name[80];
        std::snprintf(name, sizeof name, "%ux%u: planes never mix, edges included", w, h);
        ok(name, same);
    }
}

/* Chroma siting: a U ramp across and down. Luma pixel 2k reads chroma
 * sample k alone horizontally, 2k+1 the mean of k and k+1; luma rows 2k and
 * 2k+1 read rows k-1/k and k/k+1 at 1/4 : 3/4. */
static void test_siting()
{
    const uint32_t w = 64, h = 32;
    Nv12 f(w, h, w);
    std::fill(f.y.begin(), f.y.end(), 128);
    for (uint32_t r = 0; r < h / 2; r++)
        for (uint32_t i = 0; i < w / 2; i++) {
            f.U(i, r) = (uint8_t)(64 + 4 * i);
            f.V(i, r) = 128;
        }
    const std::vector<uint8_t> a = atlas_of(f);
    /* With V neutral, B = Y + 1.772 (U - 0.5): read U back from blue. */
    auto u_at = [&](uint32_t x, uint32_t y) {
        uint8_t rgb[3];
        pixel(a, w, h, x, y, rgb);
        return (rgb[2] / 255.0 - 128 / 255.0) / 1.772 * 255.0 + 128;
    };
    ok("luma pixel 2k reads chroma sample k", std::fabs(u_at(20, 8) - (64 + 4 * 10)) < 1.0);
    ok("luma pixel 2k+1 reads the mean of k and k+1", std::fabs(u_at(21, 8) - (64 + 4 * 10 + 2)) < 1.0);

    Nv12 g(w, h, w);
    std::fill(g.y.begin(), g.y.end(), 128);
    for (uint32_t r = 0; r < h / 2; r++)
        for (uint32_t i = 0; i < w / 2; i++) {
            g.U(i, r) = (uint8_t)(40 + 8 * r);
            g.V(i, r) = 128;
        }
    const std::vector<uint8_t> b = atlas_of(g);
    auto u_row = [&](uint32_t y) {
        uint8_t rgb[3];
        pixel(b, w, h, 10, y, rgb);
        return (rgb[2] / 255.0 - 128 / 255.0) / 1.772 * 255.0 + 128;
    };
    ok("luma row 2k reads chroma rows k-1 and k at 1/4 : 3/4", std::fabs(u_row(10) - (40 + 8 * 4.75)) < 1.0);
    ok("luma row 2k+1 reads chroma rows k and k+1 at 3/4 : 1/4", std::fabs(u_row(11) - (40 + 8 * 5.25)) < 1.0);
}

/* round_levels: 0 bits is a copy; n bits keeps each byte within 2^(n-1)
 * levels, keeps 0, 128 (neutral chroma) and 255 exact, and is idempotent. */
static void test_round_levels()
{
    std::vector<uint8_t> src(256), dst(256), again(256);
    for (int i = 0; i < 256; i++) src[i] = (uint8_t)i;
    round_levels(dst.data(), src.data(), 256, 0);
    ok("0 bits copies exactly", dst == src);
    for (unsigned bits = 1; bits <= 3; bits++) {
        round_levels(dst.data(), src.data(), 256, bits);
        int worst = 0;
        for (int i = 0; i < 256; i++) worst = std::max(worst, std::abs(dst[i] - i));
        round_levels(again.data(), dst.data(), 256, bits);
        char name[96];
        std::snprintf(name, sizeof name, "%u bits: at most %d levels off, idempotent (worst %d)", bits, 1 << (bits - 1),
                      worst);
        ok(name, worst <= (1 << (bits - 1)) && again == dst);
    }
    for (unsigned bits = 1; bits <= 3; bits++) {
        round_levels(dst.data(), src.data(), 256, bits);
        char name[80];
        std::snprintf(name, sizeof name, "%u bits: 0, 128 and 255 stay exact", bits);
        ok(name, dst[0] == 0 && dst[128] == 128 && dst[255] == 255);
    }
    round_levels(dst.data(), src.data(), 256, 2);
    ok("2 bits: chroma noise 127 / 129 lands on 128", dst[127] == 128 && dst[129] == 128);

    /* Every level at every length and alignment: the nearest multiple of
     * 2^bits, half up, 255 past the top. */
    std::vector<uint8_t> big(4096 + 64), out(big.size());
    for (size_t i = 0; i < big.size(); i++) big[i] = (uint8_t)(i * 37 + i / 256);
    bool all = true;
    for (unsigned bits = 1; bits <= 3 && all; bits++)
        for (size_t off = 0; off < 17 && all; off++)
            for (size_t n : {size_t(0), size_t(1), size_t(15), size_t(16), size_t(17), size_t(31), size_t(4096)}) {
                std::fill(out.begin(), out.end(), 0xa5);
                round_levels(out.data() + off, big.data() + off, n, bits);
                const unsigned step = 1u << bits;
                for (size_t i = 0; i < out.size(); i++) {
                    const unsigned v = big[i], r = (v + step / 2) / step * step;
                    const unsigned want = i < off || i >= off + n ? 0xa5 : r > 255 ? 255 : r;
                    all = all && out[i] == want;
                }
            }
    ok("every level, length and alignment rounds as defined, nothing outside written", all);
}

/* Packing with rounding is a plain copy of Y and split of U and V, then
 * round_levels() over the atlas, byte for byte: on random pictures and on
 * every level, at widths whose chroma rows are and are not a multiple of 16
 * and with a padded pitch. */
static std::vector<uint8_t> plain_pack(const Nv12 &f)
{
    std::vector<uint8_t> a((size_t)f.w * atlas_height(f.h));
    for (uint32_t r = 0; r < f.h; r++)
        std::memcpy(&a[(size_t)r * f.w], &f.y[(size_t)r * f.pitch], f.w);
    for (uint32_t r = 0; r < f.h / 2; r++)
        for (uint32_t k = 0; k < f.w / 2; k++) {
            a[(size_t)(f.h + r) * f.w + k] = f.uv[(size_t)r * f.pitch + 2 * k];
            a[(size_t)(f.h + r) * f.w + f.w / 2 + k] = f.uv[(size_t)r * f.pitch + 2 * k + 1];
        }
    return a;
}

static void test_pack_rounded()
{
    bool same = true;
    std::srand(11);
    for (uint32_t w : {64u, 72u, 1088u, 1280u})
        for (uint32_t h : {32u, 480u})
            for (uint32_t pad : {0u, 32u}) {
                Nv12 f(w, h, w + pad);
                for (uint8_t &b : f.y) b = (uint8_t)std::rand();
                for (uint8_t &b : f.uv) b = (uint8_t)std::rand();
                for (uint32_t i = 0; i < 256 && i < f.uv.size(); i++) f.uv[i] = f.y[i] = (uint8_t)i;
                const std::vector<uint8_t> plain = plain_pack(f);
                for (unsigned bits = 0; bits <= 3; bits++) {
                    std::vector<uint8_t> want(plain.size()), got(plain.size(), 0xee);
                    round_levels(want.data(), plain.data(), plain.size(), bits);
                    pack_nv12_atlas(f.y.data(), f.pitch, f.uv.data(), f.pitch, w, h, got.data(), bits);
                    same = same && got == want;
                }
            }
    ok("packing with rounding equals packing, then rounding, byte for byte", same);
}

static void test_frame(const char *path)
{
    Nv12 f(1088, 480, 1088);
    if (path) {
        FILE *fp = std::fopen(path, "rb");
        const bool read = fp && std::fread(f.y.data(), 1, f.y.size(), fp) == f.y.size() &&
                          std::fread(f.uv.data(), 1, f.uv.size(), fp) == f.uv.size();
        if (fp) std::fclose(fp);
        ok("read the NV12 frame", read);
        if (!read) return;
    } else {
        std::srand(7);
        for (uint32_t y = 0; y < 480; y++)
            for (uint32_t x = 0; x < 1088; x++)
                f.Y(x, y) = (uint8_t)((x * 3 + y * 5 + std::rand() % 9) & 0xff);
        for (uint32_t r = 0; r < 240; r++)
            for (uint32_t k = 0; k < 544; k++) {
                f.U(k, r) = (uint8_t)(128 + 60 * std::sin(k / 37.0 + r / 23.0));
                f.V(k, r) = (uint8_t)(128 + 60 * std::cos(k / 29.0 - r / 31.0));
            }
    }
    double mean = 0;
    const int worst = frame_error(f, &mean);
    char name[128];
    std::snprintf(name, sizeof name, "%s 1088x480 frame matches the direct conversion (largest %d, mean %.3f levels)",
                  path ? "the" : "a synthetic", worst, mean);
    ok(name, worst <= 1);
}

int main(int argc, char **argv)
{
    test_layout();
    test_colours();
    test_no_bleed();
    test_siting();
    test_round_levels();
    test_pack_rounded();
    test_frame(nullptr);
    if (argc > 1)
        test_frame(argv[1]);
    if (failures) {
        std::printf("%d failure(s)\n", failures);
        return 1;
    }
    std::printf("all passed\n");
    return 0;
}
