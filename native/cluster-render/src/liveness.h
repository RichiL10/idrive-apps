/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Whether the render loop is still making progress, for the heartbeat
 * thread (dcsm2_link.h). The loop beats once per iteration, at least four
 * times a second (Service::timeout_ms); the heartbeat thread asks alive()
 * before each heartbeat. With no beat for kStallMs the heartbeats stop, so
 * the KOMBI's own watchdog drops our content about 10 s later (DCSM.md
 * "Heartbeat") instead of a frozen map staying on the cluster; they go
 * again with the next beat. Times are cld::now_ms() (CLOCK_MONOTONIC).
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

    explicit Liveness(int64_t stall_ms = kStallMs) : stall_ms_(stall_ms) {}

    /* The render loop made progress (render thread). */
    void beat(int64_t now_ms) { last_.store(now_ms, std::memory_order_relaxed); }

    /* Alive until the first beat, so nothing stops before the loop runs;
     * then while the last beat is less than stall_ms old (any thread). */
    bool alive(int64_t now_ms) const
    {
        const int64_t last = last_.load(std::memory_order_relaxed);
        return last == kNever || now_ms - last < stall_ms_;
    }

    /* How long since the last beat; -1: none yet. */
    int64_t since(int64_t now_ms) const
    {
        const int64_t last = last_.load(std::memory_order_relaxed);
        return last == kNever ? -1 : now_ms - last;
    }

private:
    static const int64_t kNever = INT64_MIN;
    const int64_t stall_ms_;
    std::atomic<int64_t> last_{kNever};
};

}  // namespace crs

#endif
