/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
#include "yuv_atlas.h"

#include <cmath>
#include <cstring>

#if defined(__SSE2__)
#include <emmintrin.h>
#endif

namespace crk {

namespace {

#if defined(__SSE2__)
/* round_levels() on 16 bytes, bits 1-3. */
struct Round16 {
    __m128i half, keep, top;
    explicit Round16(unsigned bits)
        : half(_mm_set1_epi8((char)(1u << (bits - 1)))), keep(_mm_set1_epi8((char)~((1u << bits) - 1u))),
          top(_mm_set1_epi8((char)(256 - (1u << (bits - 1)))))
    {
    }
    __m128i operator()(__m128i v) const
    {
        /* A byte of at least 256 - half rounds past 255: it is 255. */
        const __m128i over = _mm_cmpeq_epi8(_mm_max_epu8(v, top), v);
        return _mm_or_si128(_mm_and_si128(_mm_add_epi8(v, half), keep), over);
    }
};
#endif

uint8_t round_level(unsigned v, unsigned half, unsigned keep)
{
    v = (v + half) & keep;
    return (uint8_t)(v > 255 ? 255 : v);
}

}  // namespace

void pack_nv12_atlas(const uint8_t *y, size_t y_pitch, const uint8_t *uv, size_t uv_pitch, uint32_t w, uint32_t h,
                     uint8_t *out, unsigned bits)
{
    for (uint32_t r = 0; r < h; r++)
        round_levels(out + (size_t)r * w, y + r * y_pitch, w, bits);
    const unsigned half = bits ? 1u << (bits - 1) : 0, keep = ~((1u << bits) - 1u);
    const uint32_t cw = w / 2;
    uint8_t *cu = out + (size_t)h * w;
#if defined(__SSE2__)
    const Round16 round(bits ? bits : 1);
    const __m128i even = _mm_set1_epi16(0x00ff);
#endif
    for (uint32_t r = 0; r < h / 2; r++) {
        const uint8_t *s = uv + r * uv_pitch;
        uint8_t *du = cu + (size_t)r * w, *dv = du + cw;
        uint32_t x = 0;
#if defined(__SSE2__)
        for (; x + 16 <= cw; x += 16) {
            const __m128i a = _mm_loadu_si128(reinterpret_cast<const __m128i *>(s + 2 * x));
            const __m128i b = _mm_loadu_si128(reinterpret_cast<const __m128i *>(s + 2 * x + 16));
            __m128i u = _mm_packus_epi16(_mm_and_si128(a, even), _mm_and_si128(b, even));
            __m128i v = _mm_packus_epi16(_mm_srli_epi16(a, 8), _mm_srli_epi16(b, 8));
            if (bits) {
                u = round(u);
                v = round(v);
            }
            _mm_storeu_si128(reinterpret_cast<__m128i *>(du + x), u);
            _mm_storeu_si128(reinterpret_cast<__m128i *>(dv + x), v);
        }
#endif
        for (; x < cw; x++) {
            du[x] = round_level(s[2 * x], half, keep);
            dv[x] = round_level(s[2 * x + 1], half, keep);
        }
    }
}

void round_levels(uint8_t *dst, const uint8_t *src, size_t n, unsigned bits)
{
    if (bits == 0) {
        std::memcpy(dst, src, n);
        return;
    }
    const unsigned half = 1u << (bits - 1), keep = ~((1u << bits) - 1u);
    size_t i = 0;
#if defined(__SSE2__)
    const Round16 round(bits);
    for (; i + 16 <= n; i += 16)
        _mm_storeu_si128(reinterpret_cast<__m128i *>(dst + i),
                         round(_mm_loadu_si128(reinterpret_cast<const __m128i *>(src + i))));
#endif
    for (; i < n; i++)
        dst[i] = round_level(src[i], half, keep);
}

/* Texel coordinates: luma pixel x's centre is x + 0.5. Chroma sample k sits
 * on luma pixel 2k horizontally and between luma rows 2k and 2k+1
 * vertically, so a luma coordinate L is chroma coordinate L/2 + 0.25 across
 * and L/2 down. highp: a mediump float (10-bit mantissa) is up to half a
 * texel off across a 1088x720 texture. Chroma is centred on 128. */
const char *const kAtlasFragmentShader = R"(#version 100
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_size;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
    vec2 l = v_uv * u_size;
    float th = u_size.y * 1.5;
    vec2 c = clamp(vec2(l.x * 0.5 + 0.25, l.y * 0.5), vec2(0.5), u_size * 0.5 - 0.5);
    float y = texture2D(u_image, vec2(v_uv.x, clamp(l.y, 0.5, u_size.y - 0.5) / th)).r;
    float u = texture2D(u_image, vec2(c.x / u_size.x, (u_size.y + c.y) / th)).r - 128.0 / 255.0;
    float v = texture2D(u_image, vec2((u_size.x * 0.5 + c.x) / u_size.x, (u_size.y + c.y) / th)).r - 128.0 / 255.0;
    vec3 rgb = vec3(y + 1.402 * v, y - 0.344136 * u - 0.714136 * v, y + 1.772 * u);
    gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), u_opacity);
})";

namespace {

/* GL_LINEAR with GL_CLAMP_TO_EDGE at texel coordinates (s, t) of a w x th
 * R8 texture, in 0..1. */
double bilinear(const uint8_t *tex, uint32_t w, uint32_t th, double s, double t)
{
    const double x = s - 0.5, y = t - 0.5;
    const double fx = std::floor(x), fy = std::floor(y);
    const double ax = x - fx, ay = y - fy;
    auto at = [&](long i, long j) {
        i = i < 0 ? 0 : i >= (long)w ? (long)w - 1 : i;
        j = j < 0 ? 0 : j >= (long)th ? (long)th - 1 : j;
        return tex[(size_t)j * w + (size_t)i] / 255.0;
    };
    const long i = (long)fx, j = (long)fy;
    return (1 - ay) * ((1 - ax) * at(i, j) + ax * at(i + 1, j)) + ay * ((1 - ax) * at(i, j + 1) + ax * at(i + 1, j + 1));
}

double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

uint8_t level(double v)
{
    return (uint8_t)std::lround(clampd(v, 0.0, 1.0) * 255.0);
}

}  // namespace

void atlas_rgb(const uint8_t *atlas, uint32_t w, uint32_t h, double u, double v, uint8_t rgb[3])
{
    const double W = w, H = h;
    const double lx = u * W, ly = v * H;
    const double cx = clampd(lx * 0.5 + 0.25, 0.5, W * 0.5 - 0.5);
    const double cy = clampd(ly * 0.5, 0.5, H * 0.5 - 0.5);
    const uint32_t th = atlas_height(h);
    const double y = bilinear(atlas, w, th, lx, clampd(ly, 0.5, H - 0.5));
    const double cu = bilinear(atlas, w, th, cx, H + cy) - 128.0 / 255.0;
    const double cv = bilinear(atlas, w, th, W * 0.5 + cx, H + cy) - 128.0 / 255.0;
    rgb[0] = level(y + 1.402 * cv);
    rgb[1] = level(y - 0.344136 * cu - 0.714136 * cv);
    rgb[2] = level(y + 1.772 * cu);
}

}  // namespace crk
