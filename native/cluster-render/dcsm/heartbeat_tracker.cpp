/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* HeartbeatTracker (dcsm_client.h): plain bookkeeping, no vsomeip calls, so
 * the host tests link it alone (test/heartbeat_tracker_test.cpp). */
#include "dcsm_client.h"

namespace dcsm {

void HeartbeatTracker::sent(int64_t nowMs) {
    if (firstSentMs_ < 0) firstSentMs_ = nowMs;
    sent_++;
}

// Heartbeats held by the caller's gate go again: the silence counts from
// now, as the KOMBI had nothing to answer while none went.
void HeartbeatTracker::resumed(int64_t nowMs) { quietFromMs_ = nowMs; }

HeartbeatStats HeartbeatTracker::stats(int64_t nowMs) const {
    HeartbeatStats s;
    s.sent = sent_;
    s.replies = replies_;
    s.badReplies = badReplies_;
    s.sinceReplyMs = lastReplyMs_ < 0 ? -1 : nowMs - lastReplyMs_;
    return s;
}

// The KOMBI answers a heartbeat REQUEST with an empty E_OK RESPONSE. Any
// other return code, or an ERROR, means it did not take the heartbeat: more
// requests would starve its watchdog, so the stock form takes over.
bool HeartbeatTracker::reply(int64_t nowMs, uint8_t messageType, uint8_t returnCode,
                             size_t length, HeartbeatReport *r) {
    int64_t previous = lastReplyMs_;
    lastReplyMs_ = nowMs;
    replies_++;
    bool resumed = silent_;
    silent_ = false;
    bool taken = messageType == uint8_t(vsomeip::message_type_e::MT_RESPONSE) &&
                 returnCode == uint8_t(vsomeip::return_code_e::E_OK);
    if (taken && length != 0) badReplies_++;
    r->stats = stats(nowMs);
    r->stats.sinceReplyMs = previous < 0 ? -1 : nowMs - previous;
    r->messageType = messageType;
    r->returnCode = returnCode;
    r->length = uint32_t(length);
    if (!taken) {
        if (refused_) return false;
        refused_ = true;
        r->event = HeartbeatReport::kRefused;
        return true;
    }
    if (length != 0) {
        if (!badReported_) {
            badReported_ = true;
            r->event = HeartbeatReport::kBadReply;
            return true;
        }
    } else if (!answered_) {
        answered_ = true;
        r->event = HeartbeatReport::kFirstReply;
        return true;
    }
    if (!resumed) return false;
    r->event = HeartbeatReport::kResumed;
    return true;
}

bool HeartbeatTracker::check(int64_t nowMs, HeartbeatReport *r) {
    if (refused_ || silent_ || sent_ == 0) return false;
    int64_t from = lastReplyMs_ >= 0 ? lastReplyMs_ : firstSentMs_;
    if (quietFromMs_ > from) from = quietFromMs_;
    if (nowMs - from < kHeartbeatSilence.count()) return false;
    silent_ = true;
    *r = HeartbeatReport();
    r->event = HeartbeatReport::kSilent;
    r->stats = stats(nowMs);
    return true;
}

}  // namespace dcsm
