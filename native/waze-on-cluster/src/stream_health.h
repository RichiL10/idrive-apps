// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* What losses in the phone's stream did to the picture, for the status
 * reason, the log, probe.txt and the minute line.
 *
 * The phone sends a keyframe only when its stream starts, so a loss is
 * decoded through: the decoder conceals what is missing and the map shows
 * smudges until the phone codes those areas again. The stream is whole;
 * decoding through a loss, from that loss until a frame the decoder does not
 * flag corrupted, decoded from an access unit that began after the latest
 * loss; or lost, while the stream arrives with nothing decoded for
 * kLostMs (the keyframe wait, keyframe_wait.h: a decoder that never started,
 * or one that conceals nothing), and while the decoder has given up its
 * sequence (decoder_msdk.h) until it starts a new one. A sequence jump
 * followed by an SPS is a new stream, not a loss.
 *
 * Only a lost stream has a status reason, short operator text; the map
 * shows through a loss. The detail, with when the episode began, is for the
 * log and probe.txt. Each loss, new stream and return to a clean picture is
 * a log line, at most kLinesPerMinute a minute; the minute line counts them
 * all. Not thread-safe. */
#ifndef WOC_STREAM_HEALTH_H
#define WOC_STREAM_HEALTH_H

#include <stdint.h>
#include <string>

namespace woc {

class StreamHealth {
public:
    static const unsigned kLinesPerMinute = 10;
    static const int64_t kLostMs = 2000;

    struct Minute {
        uint32_t losses = 0, lost = 0, corrupted = 0;
        uint32_t overflows = 0;   /* buffers dropped at their size cap */
    };

    /* A sequence gap at now_ms (monotonic) and wall_ms (since the epoch):
     * the packet expected, the one that came, the sequence numbers between,
     * and how many of those the receive queue dropped. The line to log;
     * empty past the minute's lines. */
    std::string loss(int64_t now_ms, int64_t wall_ms, const char *source, uint16_t expected, uint16_t got,
                     uint32_t lost, uint32_t queue_dropped);
    /* A sequence jump followed by an SPS: a new stream ends a decode-through
     * episode. The line to log, or empty. */
    std::string new_stream(int64_t now_ms, const char *source, uint16_t expected, uint16_t got);
    /* A decoded frame, its decoder corruption flags (0: clean) and whether
     * its access unit began after the latest loss. The line to log, or
     * empty. */
    std::string frame(int64_t now_ms, uint16_t corrupted, bool after_loss);
    /* The decoder gave up its sequence (on) or started a new one. The line
     * to log for a new one after a wait, or empty. */
    std::string waiting(int64_t now_ms, int64_t wall_ms, bool on);
    /* `count` buffers of `what` (the RTP fragment buffer, the decoder's
     * framing) dropped at their size cap; the stream resynchronises at the
     * next start. Counted in the minute; the line to log, or empty. */
    std::string overflow(int64_t now_ms, const char *what, uint32_t count);

    /* The keyframe wait (keyframe_wait.h) as sampled at wall_ms: from
     * kLostMs the stream is lost, since wall_ms - keyframe_wait_ms. */
    void keyframe_wait(int64_t wall_ms, int64_t keyframe_wait_ms);

    /* The decoder gave up, or the keyframe wait reached kLostMs. */
    bool lost() const;
    /* The status reason: empty unless the stream is lost. */
    std::string reason() const;
    /* What the stream is, with when the episode began; empty while it is
     * whole. */
    std::string detail() const;
    /* The counts since the last call. */
    Minute take_minute();

private:
    enum State { Whole, Through, Waiting };
    bool line_due(int64_t now_ms);

    State state_ = Whole;
    std::string since_;            /* the episode's start, "HH:MM:SS" UTC */
    std::string arriving_since_;   /* the keyframe wait's, once it reached kLostMs; empty below */
    int64_t loss_ms_ = 0, waiting_ms_ = 0;
    uint32_t corrupted_since_ = 0;
    Minute minute_;
    int64_t lines_since_ms_ = -1;
    unsigned lines_ = 0;
};

}  // namespace woc

#endif
