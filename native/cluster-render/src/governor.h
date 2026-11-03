/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The upload governor: the one byte budget every client's writes share
 * (upload_pacer.h), steered by what the link to the display shows
 * (README.md "Upload budget").
 *
 * The cap starts at the ceiling (upload_kb_per_s, 4500 KB/s by default;
 * GovernorConfig's own 5500, which the tests use, applies only when no
 * configuration sets it). Evidence of
 * the link falling behind the writes scores points in a sliding window, but
 * only while writes go (within kActiveMs of activity(), which the
 * compositor reports from 64 KB a second written); at other times it is
 * logged, not counted:
 *
 *   a shown scene removed by the display, not by the stock HMI    6
 *   heartbeat replies silent (the link stalled)                    3
 *   a flush or a setData refused                                   2
 *   a flush that took longer than slow_flush_ms                    1
 *
 * A slot request refused or not answered is arbitration, not bandwidth: the
 * slot manager retries it and the cap does not move.
 *
 * When the window (30 s) holds kThreshold points the cap steps down by
 * one step (500 KB/s), not below the floor (2000 KB/s), and the window
 * starts empty. A removal reaches the threshold alone: on the car the
 * KOMBI dropped a shown scene, with healthy heartbeats and no lock, after
 * the busiest minute of upload. No other single event does, so one
 * transient error never lowers the cap. After a step down, kCooldownMs pass
 * before the next one. The cap steps back up one step at a time, each after
 * recover_ms of healthy upload (nothing in the window while writes go;
 * idle time neither counts nor resets). A step down within kProbationMs
 * of a step up doubles recover_ms (to at most kRecoverMaxMs), so a level
 * that failed is tried less often; kSettledMs with no step down sets it
 * back to kRecoverMs. A removal that steps the cap down, or that comes at
 * the floor, holds the cap there for kRemovalHoldMs: on the car the KOMBI
 * dropped the map again within a minute of the cap going back up. Down is quick and up is slow,
 * so the cap does not oscillate. */
#ifndef CRS_GOVERNOR_H
#define CRS_GOVERNOR_H

#include <stdint.h>
#include <deque>
#include <string>

namespace crs {

enum class Evidence { Removal, LinkStall, FlushFailure, WriteRefused, SlowFlush };
const char *evidence_name(Evidence e);

struct GovernorConfig {
    uint64_t max_bps = 5500 * 1024;
    uint64_t floor_bps = 2000 * 1024;
    uint64_t step_bps = 500 * 1024;
};

class Governor {
public:
    static const int64_t kWindowMs = 30000;
    static const int kThreshold = 6;
    static const int64_t kCooldownMs = 15000;
    static const int64_t kRecoverMs = 60000;
    static const int64_t kRecoverMaxMs = 600000;
    static const int64_t kProbationMs = 60000;
    static const int64_t kSettledMs = 600000;
    static const int64_t kRemovalHoldMs = 600000;
    /* Writes within this long count as the link being used. */
    static const int64_t kActiveMs = 1000;

    explicit Governor(const GovernorConfig &cfg);

    void evidence(Evidence e, int64_t now_ms, const std::string &detail = "");
    /* Bytes went to the display at now_ms. */
    void activity(int64_t now_ms);
    /* Applies the rules; true when the cap changed. */
    bool tick(int64_t now_ms);

    uint64_t cap() const { return cap_; }
    uint64_t max() const { return cfg_.max_bps; }
    uint64_t floor() const { return cfg_.floor_bps; }
    /* Why the cap is what it is. */
    const std::string &reason() const { return reason_; }
    int score(int64_t now_ms);
    int64_t recover_ms() const { return recover_ms_; }

private:
    struct Event {
        int64_t at;
        Evidence kind;
        std::string detail;
    };
    void prune(int64_t now_ms);
    std::string summary() const;
    std::string hold(int64_t now_ms);

    GovernorConfig cfg_;
    uint64_t cap_;
    std::string reason_;
    std::deque<Event> events_;
    int64_t cooldown_until_ms_ = 0;
    int64_t last_up_ms_ = -1, last_down_ms_ = -1;
    int64_t last_active_ms_ = -1, last_tick_ms_ = -1;
    int64_t healthy_ms_ = 0;
    int64_t recover_ms_ = kRecoverMs;
    int64_t hold_until_ms_ = -1;   /* no step up before this: the last removal's hold */
};

}  // namespace crs

#endif
