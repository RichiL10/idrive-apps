/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for dcsm::HeartbeatTracker (dcsm/heartbeat_tracker.cpp) under
 * a heartbeat every 250 ms: the first reply is reported; no reply for 2 s
 * is a silence, reported once, and the next reply its end; after
 * heartbeats held by the liveness gate (resumed), no silence is reported
 * before a reply is due again, and one still is when none comes. */
#include <cstdio>

#include "dcsm/dcsm_client.h"

using dcsm::HeartbeatReport;
using dcsm::HeartbeatTracker;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const uint8_t kResponse = uint8_t(vsomeip::message_type_e::MT_RESPONSE);
static const uint8_t kOk = uint8_t(vsomeip::return_code_e::E_OK);

/* One heartbeat sent at t and its silence check, as Client::heartbeatLoop
 * does; true if a silence was reported. */
static bool beat(HeartbeatTracker *h, int64_t t)
{
    HeartbeatReport r;
    h->sent(t);
    return h->check(t, &r) && r.event == HeartbeatReport::kSilent;
}

int main()
{
    HeartbeatTracker h;
    HeartbeatReport r;
    bool silent = false;
    int64_t t = 0;
    for (; t < 10000; t += 250) {
        silent = silent || beat(&h, t);
        const bool told = h.reply(t + 20, kResponse, kOk, 0, &r);
        if (t == 0)
            ok("the first reply is reported", told && r.event == HeartbeatReport::kFirstReply);
    }
    ok("replies to every heartbeat for 10 s: no silence", !silent);

    /* The gate holds heartbeats from 10 s to 15 s; none sent, none answered. */
    t = 15000;
    h.resumed(t);
    ok("the first heartbeat after a 5 s hold: no silence reported", !beat(&h, t));
    h.reply(t + 20, kResponse, kOk, 0, &r);
    silent = false;
    for (t += 250; t < 20000; t += 250) {
        silent = silent || beat(&h, t);
        h.reply(t + 20, kResponse, kOk, 0, &r);
    }
    ok("answered again after the hold: no silence", !silent);

    /* Without resumed(), the same hold reported a silence at once (the bug). */
    HeartbeatTracker o;
    beat(&o, 0);
    o.reply(20, kResponse, kOk, 0, &r);
    ok("without resumed(): the first heartbeat after a hold is reported silent", beat(&o, 5000));

    /* Resumed, then no reply at all: a silence 2 s after the resume, once. */
    HeartbeatTracker s;
    beat(&s, 0);
    s.reply(20, kResponse, kOk, 0, &r);
    s.resumed(5000);
    int reports = 0;
    int64_t first = -1;
    for (t = 5000; t < 9000; t += 250)
        if (beat(&s, t)) {
            reports++;
            if (first < 0)
                first = t;
        }
    ok("resumed and never answered: silent 2 s after the resume, reported once", reports == 1 && first == 7000);
    ok("the next reply ends the silence", s.reply(9020, kResponse, kOk, 0, &r) && r.event == HeartbeatReport::kResumed);
    ok("the silence keeps the real time since the last reply", r.stats.sinceReplyMs == 9000);

    if (failures)
        std::printf("%d failed\n", failures);
    return failures ? 1 : 0;
}
