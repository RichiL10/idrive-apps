// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A stand-in for the unit's MSDK and libva, for decoder_msdk.cpp on the host.
 *
 * Its stream is not H.264 past the NAL headers: an SPS (type 7) carries its
 * picture size as text, "1280x720"; a PPS (8) is required next to it; a
 * slice (1 or 5) carries, after its first byte, one byte that is the
 * picture's content. A picture decodes to every luma and chroma byte equal
 * to that content. An SPS larger than the surfaces the decoder was set up
 * for is incompatible (MFX_ERR_INCOMPATIBLE_VIDEO_PARAM); a smaller one
 * changes the pictures' size in the running sequence.
 *
 * Every call that matters goes to `calls`, in order:
 *   "session"           MFXInit
 *   "session gpucopy N" MFXInitEx, with its GPUCopy
 *   "header WxH"        DecodeHeader read an SPS
 *   "init WxH"          the decoder set up for a sequence
 *   "vpp-init X,Y,W,H"  VPP set up for an input rect
 *   "decode-sync"       SyncOperation on a decode task
 *   "vpp X,Y,W,H"       VPP run on a picture with this input rect
 *   "vpp-sync"          SyncOperation on a VPP task
 *   "vpp-out unaligned" VPP's output surface not page-aligned, or its pitch
 *                       not a multiple of 64, while 16-byte aligned
 *   "vpp-out shifted"   VPP's output planes off 16-byte alignment (the unit's
 *                       library copies into them on the CPU) */
#ifndef WOC_FAKE_MSDK_H
#define WOC_FAKE_MSDK_H

#include <stdint.h>
#include <string>
#include <vector>

namespace fake_msdk {

extern std::vector<std::string> calls;

/* A failure to give in sessions made with GPU copy: call ("MFXInitEx",
 * "SetHandle", "DECODE_QueryIOSurf", "VPP_Init", "VPP_Run") returns status
 * after succeeding `after` times, `times` times (0: every time after). A
 * VPP run fails only into an output its GPU copy would take (planes and
 * pitch 16-byte aligned). */
struct GpuFault {
    std::string call;
    int status = 0, after = 0, times = 0;
};
extern GpuFault gpu_fault;

/* A failure in any session, with or without GPU copy: call ("MFXInit",
 * "DecodeHeader", "DECODE_Init", "DecodeFrameAsync", "VPP_Run", "decode-sync",
 * "vpp-sync") returns status after succeeding `after` times, `times` times
 * (0: every time after). Unlike gpu_fault, a VPP run fails whatever its
 * output's alignment. Used for the device statuses (MFX_ERR_GPU_HANG,
 * MFX_ERR_DEVICE_LOST, MFX_ERR_DEVICE_FAILED) and for any other status. */
struct AnyFault {
    std::string call;
    int status = 0, after = 0, times = 0;
};
extern AnyFault any_fault;

/* "WxH": every picture decoded at this size, whatever its SPS says. */
extern std::string picture_size;

/* An access unit of the fake stream: the SPS and PPS when sps is a size
 * ("1088x480"), then an IDR slice (idr) or a P slice whose picture is
 * content (1-127). */
std::string access_unit(const char *sps, bool idr, uint8_t content);

/* How many entries of calls equal s. */
int count(const std::string &s);

}  // namespace fake_msdk

#endif
