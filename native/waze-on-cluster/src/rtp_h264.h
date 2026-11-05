// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* RTP H.264 depacketiser: one RTP datagram (RFC 3550) carrying an H.264
 * payload (RFC 6184) in, Annex-B NAL units out, for nal_reader.h / the
 * decoder.
 *
 * CarPlay's projection bridge muxes the 2nd stream as AVC_RTP: one RTP packet
 * per datagram, payload type 96, no CSRC or header extension (VERIFIED from
 * the AVB stream 15 capture, test/data). Its payloads are single NAL units
 * (SPS, PPS, small slices) and FU-A fragments (large slices, including the
 * IDR). STAP-A is handled too; STAP-B, MTAP and FU-B (interleaved mode only)
 * are dropped.
 *
 * Access units. Every NAL unit of an access unit carries the same RTP
 * timestamp, so a timestamp change ends the previous access unit, and so does
 * the marker bit on a packet that completes a slice (the RFC's last-packet
 * rule). The phone sets the marker only on SPS and PPS, which do not end an
 * access unit, so on this stream the timestamp rule frames every picture: a
 * picture is complete when the next one's first packet arrives.
 *
 * Losses. A sequence-number gap drops only the FU-A in progress, the one NAL
 * unit missing bytes; every NAL unit after it is delivered, so the decoder
 * keeps decoding through the loss and conceals what is missing. A fragment
 * that joins an FU-A mid-way (after a loss, or a start mid-stream) is dropped
 * with its FU-A. Each gap is reported (on_gap) before anything after it is
 * delivered.
 *
 * Streams and late packets (RFC 3550 5.1, A.1). A packet of the same SSRC up
 * to kMisorder sequence numbers behind the last one, with a timestamp no
 * newer, is late or a duplicate: it is dropped (counted late) and changes
 * nothing, however many arrive in a row, rather than read as a 65 k gap. A
 * packet ahead by less than kMaxDropout goes on after a gap of the packets
 * between. Anything else (another SSRC, a jump of kMaxDropout or more ahead,
 * more than kMisorder behind, or a little behind with a newer timestamp) is
 * held on probation: only when the very next packet follows it in sequence
 * (same SSRC, next number) is it a new stream (another SSRC) or a restarted
 * sequence (same SSRC). The held packet is then delivered first, so nothing
 * of the new stream is lost; the change is reported as a gap with nothing
 * lost, new_ssrc set for a new SSRC, and the FU-A in progress is dropped.
 * A held packet that the next one does not confirm is dropped (counted
 * stray) and changes nothing: one stray packet of an old stream, or of a
 * second sender on the port, does not reset the stream.
 *
 * Bounds. An FU-A is reassembled up to kMaxFuBytes; one with no end fragment
 * by then is dropped (and its memory freed), counted in overflows, and the
 * depacketiser resynchronises at the next start fragment.
 *
 * Not thread-safe; one caller at a time. No allocation once the buffers have
 * grown to the largest NAL unit. */
#ifndef WOC_RTP_H264_H
#define WOC_RTP_H264_H

#include <stddef.h>
#include <stdint.h>
#include <functional>
#include <vector>

namespace woc {

class RtpH264 {
public:
    /* Called with one whole NAL unit behind a 00 00 00 01 start code
     * (end_of_au false), or with len 0 and end_of_au true at the end of an
     * access unit. `data` is valid only during the call. */
    using Sink = std::function<void(const uint8_t *data, size_t len, bool end_of_au)>;

    /* The largest FU-A NAL unit reassembled: far above an IDR slice of the
     * phone's stream (well under 1 MB), small enough to bound memory. */
    static const size_t kMaxFuBytes = 4u << 20;
    /* How far behind the last sequence number a packet of the same SSRC is
     * still late or a duplicate (RFC 3550 A.1 MAX_MISORDER). */
    static const uint16_t kMisorder = 100;
    /* How far ahead a packet of the same SSRC still goes on after a gap
     * rather than being held as a possible restart (RFC 3550 A.1
     * MAX_DROPOUT). */
    static const uint16_t kMaxDropout = 3000;
    /* A stream silent this long has ended (a phone reconnect takes seconds;
     * a live stream sends many packets a second): see arrival(). */
    static const int64_t kIdleResetMs = 1000;

    /* A sequence-number discontinuity: the packet expected and the one that
     * came; lost is how many sequence numbers lie between them (mod 2^16).
     * new_ssrc: the packet that came starts a new SSRC, a new stream; lost
     * is then 0. */
    struct Gap {
        uint16_t expected = 0, got = 0;
        uint32_t lost = 0;
        bool new_ssrc = false;
    };

    struct Stats {
        uint64_t packets = 0;   /* RTP packets parsed */
        uint64_t nals = 0;      /* NAL units delivered */
        uint64_t aus = 0;       /* access unit ends delivered */
        uint64_t gaps = 0;      /* sequence-number discontinuities */
        uint64_t lost = 0;      /* packets missing by sequence number, over all gaps */
        uint64_t dropped = 0;   /* NAL units or fragments discarded (loss, unsupported) */
        uint64_t bad = 0;       /* datagrams that are not a parseable RTP H.264 packet */
        uint64_t late = 0;      /* late or duplicate packets dropped (same SSRC, a little behind) */
        uint64_t streams = 0;   /* SSRC changes: new streams */
        uint64_t stray = 0;     /* isolated packets dropped: another SSRC or a far jump the next packet did not confirm */
        uint64_t overflows = 0; /* FU-A NAL units dropped past kMaxFuBytes */
        uint64_t idle_resets = 0; /* stream state forgotten after kIdleResetMs of silence */
    };

    /* Each datagram's arrival time (monotonic ms), called before push().
     * After kIdleResetMs or more of silence the old stream is over: its
     * sequence number, timestamp and SSRC are forgotten (the open access unit
     * is ended and a half FU-A dropped first), so the next packet starts a
     * stream afresh. Without it a new session that keeps the SSRC and
     * restarts its sequence a little below the old one would be dropped as
     * late, SPS, PPS and IDR included, and the map would stay blank. */
    void arrival(int64_t now_ms, const Sink &sink);

    /* One datagram. Returns false, and drops it, if it is not an RTP v2
     * packet with a parseable H.264 payload. */
    bool push(const uint8_t *pkt, size_t len, const Sink &sink);

    const Stats &stats() const { return stats_; }

    std::function<void(const Gap &)> on_gap;

private:
    void deliver(const uint8_t *annexb, size_t len, const Sink &sink);
    void single(const uint8_t *nal, size_t len, const Sink &sink);
    void drop_fu();
    void end_au(const Sink &sink);
    void hold(const uint8_t *pkt, size_t len, uint32_t ssrc, uint16_t seq);
    void replay(const Sink &sink);

    std::vector<uint8_t> nal_;   /* start code + a single NAL unit or STAP-A entry, being delivered */
    std::vector<uint8_t> fu_;    /* start code + the FU-A NAL unit being reassembled */
    bool in_fu_ = false;
    bool have_seq_ = false, have_ts_ = false, have_ssrc_ = false;
    uint16_t seq_ = 0;
    uint32_t ts_ = 0;
    uint32_t ssrc_ = 0;
    std::vector<uint8_t> held_pkt_;  /* the packet on probation */
    std::vector<uint8_t> replay_;    /* the held packet, being delivered */
    bool held_ = false;
    uint32_t held_ssrc_ = 0;
    uint16_t held_seq_ = 0;
    bool replaying_ = false;
    int64_t last_arrival_ms_ = -1;
    bool au_open_ = false;       /* NAL units delivered since the last access unit end */
    bool vcl_done_ = false;      /* this packet completed a slice */
    Stats stats_;
};

}  // namespace woc

#endif
