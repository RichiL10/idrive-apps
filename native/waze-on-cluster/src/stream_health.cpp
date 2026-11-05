// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "stream_health.h"

#include <cstdio>

#include "log.h"

namespace woc {

namespace {

std::string hhmmss(int64_t wall_ms) { return cld::utc_time(wall_ms).substr(11, 8); }

}  // namespace

bool StreamHealth::line_due(int64_t now_ms)
{
    if (lines_since_ms_ < 0 || now_ms - lines_since_ms_ >= 60000) {
        lines_since_ms_ = now_ms;
        lines_ = 0;
    }
    return lines_++ < kLinesPerMinute;
}

std::string StreamHealth::loss(int64_t now_ms, int64_t wall_ms, const char *source, uint16_t expected, uint16_t got,
                               uint32_t lost, uint32_t queue_dropped)
{
    minute_.losses++;
    minute_.lost += lost;
    if (state_ == Whole) {
        state_ = Through;
        since_ = hhmmss(wall_ms);
        loss_ms_ = now_ms;
        corrupted_since_ = 0;
    }
    if (!line_due(now_ms))
        return std::string();
    char line[256];
    std::snprintf(line, sizeof line, "waze: lost %u packets of the stream from %s (sequence %u, expected %u%s); %s",
                  lost, source, got, expected,
                  queue_dropped ? ("; " + std::to_string(queue_dropped) + " dropped by the receive queue").c_str() : "",
                  state_ == Waiting ? "the decoder waits for a keyframe" : "decoding through it");
    return line;
}

std::string StreamHealth::new_stream(int64_t now_ms, const char *source, uint16_t expected, uint16_t got)
{
    if (state_ == Through)
        state_ = Whole;
    if (!line_due(now_ms))
        return std::string();
    char line[160];
    std::snprintf(line, sizeof line, "waze: a new stream from %s (sequence %u, expected %u)", source, got, expected);
    return line;
}

std::string StreamHealth::frame(int64_t now_ms, uint16_t corrupted, bool after_loss)
{
    if (corrupted)
        minute_.corrupted++;
    if (state_ != Through || !after_loss)
        return std::string();
    if (corrupted) {
        if (++corrupted_since_ > 1 || !line_due(now_ms))
            return std::string();
        char line[128];
        std::snprintf(line, sizeof line, "waze: the first frame after the loss is corrupted (decoder flags 0x%x)",
                      (unsigned)corrupted);
        return line;
    }
    state_ = Whole;
    if (!line_due(now_ms))
        return std::string();
    char line[160];
    std::snprintf(line, sizeof line, "waze: the picture is clean again %lld ms after the loss at %s (%u corrupted frames)",
                  (long long)(now_ms - loss_ms_), since_.c_str(), corrupted_since_);
    return line;
}

std::string StreamHealth::waiting(int64_t now_ms, int64_t wall_ms, bool on)
{
    if (on) {
        if (state_ != Waiting) {
            waiting_ms_ = now_ms;
            since_ = hhmmss(wall_ms);
        }
        state_ = Waiting;
        return std::string();
    }
    if (state_ != Waiting)
        return std::string();
    state_ = Whole;
    return "waze: decoding again from a keyframe after " + std::to_string((now_ms - waiting_ms_) / 1000) +
           " s waiting";
}

std::string StreamHealth::overflow(int64_t now_ms, const char *what, uint32_t count)
{
    if (count == 0)
        return std::string();
    minute_.overflows += count;
    if (!line_due(now_ms))
        return std::string();
    char line[192];
    std::snprintf(line, sizeof line, "waze: the %s overran its size cap (%u dropped); resynchronising at the next start",
                  what, count);
    return line;
}

std::string StreamHealth::rtp_events(int64_t now_ms, uint32_t late, uint32_t stray, uint32_t streams, uint32_t idle_resets)
{
    if (late == 0 && stray == 0 && streams == 0 && idle_resets == 0)
        return std::string();
    minute_.late += late;
    minute_.stray += stray;
    minute_.streams += streams;
    minute_.idle_resets += idle_resets;
    if (rtp_lines_since_ms_ < 0 || now_ms - rtp_lines_since_ms_ >= 60000) {
        rtp_lines_since_ms_ = now_ms;
        rtp_lines_ = 0;
    }
    if (rtp_lines_++ >= kRtpLinesPerMinute)
        return std::string();
    char line[192];
    std::snprintf(line, sizeof line,
                  "waze: RTP: %u late or duplicate packets dropped, %u stray, %u new streams, %u resets after silence",
                  late, stray, streams, idle_resets);
    return line;
}

void StreamHealth::keyframe_wait(int64_t wall_ms, int64_t keyframe_wait_ms)
{
    if (keyframe_wait_ms < kLostMs)
        arriving_since_.clear();
    else if (arriving_since_.empty())
        arriving_since_ = hhmmss(wall_ms - keyframe_wait_ms);
}

bool StreamHealth::lost() const
{
    return state_ == Waiting || !arriving_since_.empty();
}

std::string StreamHealth::reason() const
{
    return lost() ? "Stream lost" : std::string();
}

std::string StreamHealth::detail() const
{
    if (state_ == Waiting)
        return "the decoder gave up its sequence at " + since_ + " and waits for a keyframe";
    if (!arriving_since_.empty())
        return "the stream arrives with nothing decoded since " + arriving_since_;
    return state_ == Through ? "lost part of the stream at " + since_ + "; decoding through it" : std::string();
}

StreamHealth::Minute StreamHealth::take_minute()
{
    const Minute m = minute_;
    minute_ = Minute();
    return m;
}

}  // namespace woc
