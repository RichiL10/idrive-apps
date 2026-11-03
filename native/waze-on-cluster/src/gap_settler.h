// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* What an RTP sequence gap (rtp_h264.h) was, and which access units began
 * after the latest loss.
 *
 * A gap is settled at the next NAL unit delivered: a new SSRC or an SPS
 * makes it a new stream (the phone's stream restarted), anything else a
 * loss. Gaps before
 * that NAL unit add up. Each access unit is tagged with the losses settled
 * before its first NAL unit, so a frame decoded from it is after the latest
 * loss only if it began after it; the picture a gap cut short, delivered
 * before the gap is settled, is not. Not thread-safe. */
#ifndef WOC_GAP_SETTLER_H
#define WOC_GAP_SETTLER_H

#include <stdint.h>

#include "rtp_h264.h"

namespace woc {

class GapSettler {
public:
    enum Outcome { None, Loss, NewStream };

    /* A gap reported by the depacketiser, with the source's tag and the
     * packets the receive queue dropped before the packet that showed it. */
    void gap(const RtpH264::Gap &g, int source, uint32_t dropped)
    {
        if (!pending_) {
            pending_ = true;
            gap_ = g;
            dropped_ = 0;
        } else {
            gap_.got = g.got;
            gap_.lost += g.lost;
            gap_.new_ssrc = gap_.new_ssrc || g.new_ssrc;
        }
        source_ = source;
        dropped_ += dropped;
    }

    /* A NAL unit of this type delivered: what the pending gap was. */
    Outcome nal(unsigned type)
    {
        Outcome o = None;
        if (pending_) {
            pending_ = false;
            o = type == 7 || gap_.new_ssrc ? NewStream : Loss;
            if (o == Loss)
                losses_++;
        }
        if (!au_open_) {
            au_open_ = true;
            au_tag_ = losses_;
        }
        return o;
    }
    /* The access unit ends; its frames still count as its own. */
    void au_end() { au_open_ = false; }

    /* The last access unit opened began after the latest loss, and no gap
     * is pending. */
    bool after_loss() const { return !pending_ && au_tag_ == losses_; }
    /* The gap just settled (summed). */
    const RtpH264::Gap &settled() const { return gap_; }
    int source() const { return source_; }
    uint32_t dropped() const { return dropped_; }

private:
    bool pending_ = false;
    RtpH264::Gap gap_;
    int source_ = 0;
    uint32_t dropped_ = 0;
    uint64_t losses_ = 0;
    bool au_open_ = false;
    uint64_t au_tag_ = 0;
};

}  // namespace woc

#endif
