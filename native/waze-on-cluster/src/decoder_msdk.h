// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Hardware H.264 decoder: Annex-B byte stream in, 4:2:0 atlases (yuv_atlas.h)
 * out.
 *
 * Runs on the head unit's Intel Media SDK (libmfxhw64.so, API 1.24) over
 * VA-API on a DRM render node:
 *   - Annex-B bytes are framed into access units (nal_reader.h). Each one is
 *     passed as a complete frame, so a picture is decoded as soon as its
 *     access unit is complete.
 *   - MSDK decodes to NV12 in GPU memory that it allocates itself ("opaque"
 *     surfaces) and shares with MSDK VPP.
 *   - VPP scales NV12 to NV12 on the GPU, to the requested size, into one
 *     reused system-memory surface, and the CPU packs its planes into one
 *     reused atlas (pack_nv12_atlas). Nothing is converted to colour on MGU:
 *     the cluster's GPU does that (the map shader).
 * A frame fed without a picture (feed's picture false, to catch up with a
 * backlog) is decoded as every frame must be, for the frames that refer to
 * it, and waited for (its decode task only), but VPP and the packing are
 * skipped: it comes out with no atlas.
 * Frames come out in decoding order, each as soon as it is decoded. A stream
 * with B frames needs display order: the first B slice switches the decoder
 * to it at the next SPS, and B frames before that come out of order.
 *
 * Decoding starts at the first access unit that carries an SPS; anything
 * before it is dropped. Damaged or incomplete access units (a lost packet)
 * are decoded as they are: MSDK conceals what is missing and flags the frame
 * (VideoFrame::corrupted). An access unit that fails to decode is skipped;
 * only kFailLimit in a row give the sequence up, and the decoder then waits
 * for the next SPS (decoding() false). A new SPS that needs a larger picture or more
 * surfaces restarts the decoder, in a new MSDK session, from that access
 * unit. With out_w/out_h 0 the output is the size of the sequence the
 * decoder was last started for.
 *
 * Not thread-safe: call every method from one thread. Frames are delivered
 * synchronously from feed() and flush().
 *
 * Checked offline:
 *   - the vendored MSDK structs, constants and prototypes against Intel's
 *     headers;
 *   - every import against the unit's libmfxhw64, libva and libva-drm, by
 *     export list and by loading with RTLD_NOW under the unit's ld.so;
 *   - the whole decode and VPP path against the unit's libmfxsw64 (the same
 *     MSDK release, software implementation): on the car's capture at its
 *     own 1920x900, 40 of 40 atlases equal ffmpeg's decoded planes byte for
 *     byte, and the decoder also scales it to 1088x480;
 *   - the NAL framing by test/nal_reader_test.cpp.
 * UNVERIFIED (CAR-ONLY): the hardware library's VA-API path (render node,
 * VA display, GPU surfaces, opaque decode-to-VPP), that it honours
 * DecodedOrder as the software library does, whether the phone's stream has
 * B frames, and throughput. The decoder has never run on the GPU. Frames
 * without a picture (decode synced alone, no VPP) are checked against
 * neither library. */
#ifndef WOC_DECODER_MSDK_H
#define WOC_DECODER_MSDK_H

#include <stddef.h>
#include <stdint.h>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace woc {

struct VideoFrame {
    uint32_t w, h;        /* the picture's size */
    uint16_t corrupted;   /* MSDK's mfxFrameData::Corrupted flags; 0: decoded whole */
    /* Its atlas, w x atlas_height(h) bytes, the decoder's buffer. The sink
     * may change it in place, or swap it for another buffer (the decoder
     * sizes what it gets back for the next frame). Valid until the next
     * feed/flush/shutdown. Null for a frame decoded without a picture. */
    std::vector<uint8_t> *atlas;
};

class Decoder {
public:
    using FrameSink = std::function<void(const VideoFrame &)>;
    static const int kFailLimit = 30;

    Decoder();
    ~Decoder();
    Decoder(const Decoder &) = delete;
    Decoder &operator=(const Decoder &) = delete;

    /* dev: the render node, "/dev/dri/renderD128". out_w/out_h: output size,
     * even, or both 0 for the stream's own size. */
    bool init(const char *dev, uint32_t out_w, uint32_t out_h, std::string *err);

    /* Feeds Annex-B bytes, split anywhere; cb gets each decoded frame.
     * end_of_au: the bytes end exactly at the end of an access unit (one
     * whole frame per call), so that frame is decoded now instead of when the
     * next one starts. picture false: the frames that come out of this call
     * have no atlas. Returns false, with *err, when an access unit failed
     * to decode or a sequence could not start, or before init(). */
    bool feed(const uint8_t *data, size_t len, const FrameSink &cb, std::string *err, bool end_of_au = false,
              bool picture = true);

    /* End of stream: decodes what is buffered and delivers every remaining
     * frame. The next feed() starts a new stream at its first SPS. */
    void flush(const FrameSink &cb);

    void shutdown();

    /* Initialised and holding a sequence: false before the first SPS and
     * after a sequence was given up, until the next SPS. */
    bool decoding() const;

    /* Sessions closed since init() because MSDK reported a GPU hang or a
     * lost or failed device (MFX_ERR_GPU_HANG, MFX_ERR_DEVICE_LOST,
     * MFX_ERR_DEVICE_FAILED). Such a session is closed at the first failure;
     * the decoder then waits for the next SPS, in a new session. */
    uint64_t device_failures() const;

private:
    struct State;
    std::unique_ptr<State> s_;
};

}  // namespace woc

#endif
