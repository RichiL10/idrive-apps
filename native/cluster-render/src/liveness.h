/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Whether the render loop is still making progress, for the heartbeat
 * thread (dcsm2_link.h). The loop beats once per iteration, at least four
 * times a second (Service::timeout_ms); the heartbeat thread asks alive()
 * before each heartbeat. With no beat for kStallMs the heartbeats stop, so
 * the KOMBI's own watchdog drops our content about 10 s later (DCSM.md
 * "Heartbeat") instead of a frozen map staying on the cluster; they go
 * again with the next beat. The limit is dcsm_liveness_ms (default
 * kStallMs; 0 turns the gate off). Times are cld::now_ms() (CLOCK_MONOTONIC).
 * Lock-free: one writer, any number of readers. iDrive 7 only: iDrive 8
 * sends no heartbeat of ours (unit_idrive8.cpp). */
#ifndef CRS_LIVENESS_H
#define CRS_LIVENESS_H

#include <stdint.h>
#include <atomic>

namespace crs {

class Liveness {
public:
    static const int64_t kStallMs = 3000;

    /* stall_ms 0 (dcsm_liveness_ms = 0): never stalled, the gate off. */
    explicit Liveness(int64_t stall_ms = kStallMs) : stall_ms_(stall_ms) {}

    /* Before the heartbeat thread starts (Dcsm2Link::start). */
    void set_stall_ms(int64_t stall_ms) { stall_ms_ = stall_ms; }
    int64_t stall_ms() const { return stall_ms_; }

    /* The render loop made progress (render thread). */
    void beat(int64_t now_ms) { last_.store(now_ms, std::memory_order_relaxed); }

    /* Alive until the first beat, so nothing stops before the loop runs;
     * then while the last beat is less than stall_ms old (any thread). */
    bool alive(int64_t now_ms) const
    {
        const int64_t last = last_.load(std::memory_order_relaxed);
        return stall_ms_ <= 0 || last == kNever || now_ms - last < stall_ms_;
    }

    /* How long since the last beat; -1: none yet. */
    int64_t since(int64_t now_ms) const
    {
        const int64_t last = last_.load(std::memory_order_relaxed);
        return last == kNever ? -1 : now_ms - last;
    }

private:
    static const int64_t kNever = INT64_MIN;
    int64_t stall_ms_;
    std::atomic<int64_t> last_{kNever};
};

/* dcsm::Client's heartbeat gate as Dcsm2Link wires it (heartbeat thread
 * only): allow() says whether this heartbeat goes, and reports a change of
 * state once, Stalled when the loop stops beating and Moving when it beats
 * again, for the log. */
class HeartbeatGate {
public:
    enum Change { None, Stalled, Moving };

    explicit HeartbeatGate(const Liveness *l) : l_(l) {}

    bool allow(int64_t now_ms, Change *change)
    {
        const bool alive = l_->alive(now_ms);
        *change = !alive && !stalled_ ? Stalled : alive && stalled_ ? Moving : None;
        stalled_ = !alive;
        return alive;
    }

    bool stalled() const { return stalled_; }

private:
    const Liveness *l_;
    bool stalled_ = false;
};

}  // namespace crs

#endif
