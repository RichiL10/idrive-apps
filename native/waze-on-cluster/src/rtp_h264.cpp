// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "rtp_h264.h"

namespace woc {

namespace {

const uint8_t kStartCode[4] = {0, 0, 0, 1};

bool is_vcl(unsigned type) { return type >= 1 && type <= 5; }

}  // namespace

bool RtpH264::push(const uint8_t *pkt, size_t len, const Sink &sink)
{
    /* RFC 3550 5.1: V(2) P X CC(4) | M PT(7) | seq(16) | ts(32) | SSRC(32),
     * then CC CSRCs, an optional extension (16-bit profile, 16-bit length in
     * words), the payload, and with P the padding, its last byte the count. */
    if (len < 12 || (pkt[0] >> 6) != 2) { stats_.bad++; return false; }
    size_t head = 12 + 4 * (size_t)(pkt[0] & 0x0f);
    if (pkt[0] & 0x10) {
        if (len < head + 4) { stats_.bad++; return false; }
        head += 4 + 4 * (size_t)(pkt[head + 2] << 8 | pkt[head + 3]);
    }
    size_t end = len;
    if (pkt[0] & 0x20) {
        size_t pad = pkt[len - 1];
        if (pad == 0 || pad > len) { stats_.bad++; return false; }
        end = len - pad;
    }
    if (head >= end) { stats_.bad++; return false; }

    const bool marker = pkt[1] & 0x80;
    const uint16_t seq = (uint16_t)(pkt[2] << 8 | pkt[3]);
    const uint32_t ts = (uint32_t)pkt[4] << 24 | (uint32_t)pkt[5] << 16 | (uint32_t)pkt[6] << 8 | pkt[7];
    const uint32_t ssrc = (uint32_t)pkt[8] << 24 | (uint32_t)pkt[9] << 16 | (uint32_t)pkt[10] << 8 | pkt[11];
    if (!replaying_)
        stats_.packets++;

    /* A held packet (RFC 3550 A.1 probation) is confirmed only by the very
     * next packet: its SSRC and the next sequence number. Anything else
     * leaves it isolated: dropped, counted stray. */
    bool confirmed = false;
    if (held_) {
        confirmed = ssrc == held_ssrc_ && seq == (uint16_t)(held_seq_ + 1);
        if (!confirmed) {
            held_ = false;
            stats_.stray++;
        }
    }

    if (have_ssrc_ && ssrc != ssrc_) {
        if (!confirmed) {
            /* Another SSRC: a new stream only once a second packet of it
             * follows in sequence. A stray packet of an old stream or of a
             * second sender changes nothing. */
            hold(pkt, len, ssrc, seq);
            return true;
        }
        /* A new stream: its sequence and timestamps are its own. */
        Gap g;
        g.expected = (uint16_t)(seq_ + 1);
        g.got = held_seq_;
        g.new_ssrc = true;
        stats_.streams++;
        drop_fu();
        have_seq_ = false;
        ssrc_ = ssrc;
        if (on_gap)
            on_gap(g);
        /* The old stream's access unit still open ends here, as on an idle
         * reset, and its timestamp is forgotten: the new stream's timestamps
         * are its own, so one equal to the old one's must still start an
         * access unit of its own instead of joining the old one's NAL
         * units. */
        end_au(sink);
        have_ts_ = false;
        replay(sink);
    } else if (confirmed) {
        /* Same SSRC, a jump confirmed by the packet after it: the sequence
         * restarted. Nothing is known lost. */
        Gap g;
        g.expected = (uint16_t)(seq_ + 1);
        g.got = held_seq_;
        stats_.gaps++;
        drop_fu();
        have_seq_ = false;
        if (on_gap)
            on_gap(g);
        /* The access unit still open ends here, as at an SSRC switch, and its
         * timestamp is forgotten: the restarted sequence may carry the same
         * timestamp, which must not join its NAL units to the old unit. */
        end_au(sink);
        have_ts_ = false;
        replay(sink);
    }
    ssrc_ = ssrc;
    have_ssrc_ = true;

    if (have_seq_ && seq != (uint16_t)(seq_ + 1)) {
        const uint16_t behind = (uint16_t)(seq_ - seq), ahead = (uint16_t)(seq - seq_);
        if (behind < kMisorder && (int32_t)(ts - ts_) <= 0) {
            /* Late or a duplicate, however many in a row: what it carried
             * is already delivered or given up. */
            stats_.late++;
            return true;
        }
        if (ahead >= kMaxDropout) {
            /* Far ahead, far behind, or a little behind with a newer
             * timestamp: held until the next packet shows whether the
             * sequence restarted. */
            hold(pkt, len, ssrc, seq);
            return true;
        }
        Gap g;
        g.expected = (uint16_t)(seq_ + 1);
        g.got = seq;
        g.lost = (uint16_t)(ahead - 1);
        stats_.gaps++;
        stats_.lost += g.lost;
        drop_fu();
        if (on_gap)
            on_gap(g);
    }
    seq_ = seq;
    have_seq_ = true;
    if (have_ts_ && ts != ts_) {
        drop_fu();   /* an FU-A never spans pictures */
        end_au(sink);
    }
    ts_ = ts;
    have_ts_ = true;

    const uint8_t *p = pkt + head;
    const size_t n = end - head;
    const unsigned type = p[0] & 0x1f;
    vcl_done_ = false;
    bool ok = true;
    if (type >= 1 && type <= 23) {
        single(p, n, sink);
    } else if (type == 24) {
        /* STAP-A: entries of a 16-bit size and a NAL unit. */
        size_t i = 1;
        while (i < n) {
            if (i + 2 > n) { ok = false; break; }
            size_t sz = (size_t)(p[i] << 8 | p[i + 1]);
            i += 2;
            if (sz == 0 || i + sz > n) { ok = false; break; }
            single(p + i, sz, sink);
            i += sz;
        }
    } else if (type == 28) {
        /* FU-A: indicator (F, NRI, 28), FU header (S, E, R, type), fragment. */
        if (n < 2) {
            ok = false;
        } else {
            const bool start = p[1] & 0x80, last = p[1] & 0x40;
            const uint8_t hdr = (uint8_t)((p[0] & 0xe0) | (p[1] & 0x1f));
            if (start) {
                drop_fu();
                fu_.assign(kStartCode, kStartCode + 4);
                fu_.push_back(hdr);
                in_fu_ = true;
            } else if (!in_fu_ || fu_[4] != hdr) {
                drop_fu();
                stats_.dropped++;   /* no start fragment for it */
            }
            if (in_fu_ && fu_.size() + (n - 2) > kMaxFuBytes) {
                /* No end fragment within any plausible slice size: drop it,
                 * free the memory, and wait for the next start fragment. */
                drop_fu();
                std::vector<uint8_t>().swap(fu_);
                stats_.overflows++;
            }
            if (in_fu_) {
                fu_.insert(fu_.end(), p + 2, p + n);
                if (last) {
                    in_fu_ = false;
                    deliver(fu_.data(), fu_.size(), sink);
                }
            }
        }
    } else {
        stats_.dropped++;   /* STAP-B, MTAP, FU-B: interleaved mode only */
    }

    if (marker && vcl_done_)
        end_au(sink);
    if (!ok) { stats_.bad++; return false; }
    return true;
}

void RtpH264::arrival(int64_t now_ms, const Sink &sink)
{
    if (last_arrival_ms_ >= 0 && now_ms - last_arrival_ms_ >= kIdleResetMs &&
        (have_seq_ || have_ts_ || have_ssrc_ || held_)) {
        drop_fu();
        end_au(sink);
        have_seq_ = have_ts_ = have_ssrc_ = false;
        held_ = false;
        stats_.idle_resets++;
    }
    last_arrival_ms_ = now_ms;
}

void RtpH264::hold(const uint8_t *pkt, size_t len, uint32_t ssrc, uint16_t seq)
{
    held_pkt_.assign(pkt, pkt + len);
    held_ = true;
    held_ssrc_ = ssrc;
    held_seq_ = seq;
}

void RtpH264::replay(const Sink &sink)
{
    held_ = false;
    replay_.swap(held_pkt_);
    replaying_ = true;
    push(replay_.data(), replay_.size(), sink);
    replaying_ = false;
}

void RtpH264::single(const uint8_t *nal, size_t len, const Sink &sink)
{
    nal_.assign(kStartCode, kStartCode + 4);
    nal_.insert(nal_.end(), nal, nal + len);
    deliver(nal_.data(), nal_.size(), sink);
}

void RtpH264::deliver(const uint8_t *annexb, size_t len, const Sink &sink)
{
    sink(annexb, len, false);
    stats_.nals++;
    au_open_ = true;
    vcl_done_ = vcl_done_ || is_vcl(annexb[4] & 0x1f);
}

void RtpH264::drop_fu()
{
    if (in_fu_) {
        in_fu_ = false;
        stats_.dropped++;
    }
}

void RtpH264::end_au(const Sink &sink)
{
    if (!au_open_)
        return;
    au_open_ = false;
    stats_.aus++;
    sink(nullptr, 0, true);
}

}  // namespace woc
