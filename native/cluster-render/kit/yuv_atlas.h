/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
/* The 4:2:0 atlas: a decoded frame's three planes in one 8-bit picture, so
 * one R8 texture carries the frame at 1.5 bytes a pixel and the map shader
 * turns it into colour on the cluster's GPU.
 *
 * For a w x h frame (both even) the atlas is w x atlas_height(h): rows 0 to
 * h-1 are the Y plane; rows h to h+h/2-1 hold the U plane in columns 0 to
 * w/2-1 and the V plane in columns w/2 to w-1. A 1088x480 frame is a
 * 1088x720 atlas, 783,360 B (RGB8: 1,566,720 B).
 *
 * Both renderers take R8 (VERIFIED, static): MGU's libramses maps public
 * ETextureFormat_R8 (1) to its internal R8 (1) (table 0x6a1620), and the
 * KOMBI's GL format switch (0x2e2130b) uploads internal R8 as
 * GL_R8 / GL_RED / GL_UNSIGNED_BYTE (case 0x2e21619).
 *
 * Colour. The phone's stream is full-range BT.601 (its SPS VUI:
 * video_full_range_flag 1, matrix_coefficients 6, no chroma location, so
 * type 0 — VERIFIED on the car's capture), so the shader converts full range
 * with the BT.601 matrix, its chroma samples left-sited horizontally and
 * centred vertically between luma rows (as decoded; a frame the decoder
 * scales is sited as VPP scales it). Each chroma plane is upsampled
 * bilinearly inside its own part of the atlas: the coordinates are clamped
 * half a texel in from the part's edges, so the filter never mixes U, V and
 * Y.
 *
 * atlas_rgb() is the shader on the CPU, coordinate for coordinate, for the
 * host test. */
#ifndef CRK_YUV_ATLAS_H
#define CRK_YUV_ATLAS_H

#include <stddef.h>
#include <stdint.h>

namespace crk {

inline uint32_t atlas_height(uint32_t h) { return h + h / 2; }

/* Packs an NV12 picture (Y plane, then interleaved U,V at half size in both
 * directions) of w x h into the w x atlas_height(h) atlas at out, each level
 * rounded as round_levels() rounds it with bits (0: exact), in one pass. */
void pack_nv12_atlas(const uint8_t *y, size_t y_pitch, const uint8_t *uv, size_t uv_pitch, uint32_t w, uint32_t h,
                     uint8_t *out, unsigned bits);

/* Copies n bytes from src to dst with each Y, U or V level rounded to the
 * nearest multiple of 2^bits (bits 0-3; 255 stays 255), so each byte is at
 * most 2^(bits-1) levels off and 0, 128 (neutral chroma) and 255 are exact.
 * Flat areas of a decoded map frame wander by a level or two; rounding
 * evens them out before the frame is compared and written. bits 0: a plain
 * copy. */
void round_levels(uint8_t *dst, const uint8_t *src, size_t n, unsigned bits);

/* The map shader for an atlas texture: GLSL ES 1.00 like the HMI's effects,
 * u_image the atlas, u_size the frame's w and h, u_opacity as the RGB
 * shader's. */
extern const char *const kAtlasFragmentShader;

/* The colour kAtlasFragmentShader draws where the quad's v_uv is (u, v), on
 * the CPU: the same coordinates and clamps, GL's bilinear filter with
 * clamp-to-edge, each channel rounded to 8 bits. */
void atlas_rgb(const uint8_t *atlas, uint32_t w, uint32_t h, double u, double v, uint8_t rgb[3]);

}  // namespace crk

#endif
