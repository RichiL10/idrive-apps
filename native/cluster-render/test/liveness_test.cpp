/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the render loop's liveness (liveness.h): alive before the
 * first beat, alive while beats come less than 3 s apart, stalled from 3 s
 * without one, alive again with the next beat; a limit of 0 never stalls;
 * and HeartbeatGate, the gate Dcsm2Link gives dcsm::Client, holds
 * heartbeats while stalled and reports the stall and the end of it once
 * each. (Client::heartbeatLoop skipping a held heartbeat needs vsomeip and
 * is not host-tested; its tracker is, in heartbeat_tracker_test.cpp.) */
#include <cstdio>

#include "../src/liveness.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

int main()
{
    Liveness l;
    ok("no beat yet: alive", l.alive(0) && l.alive(1000000) && l.since(5) == -1);
    l.beat(1000);
    ok("beaten: alive", l.alive(1000) && l.since(1250) == 250);
    bool steady = true;
    for (int64_t t = 1000; t < 60000; t += 250) {
        l.beat(t);
        steady = steady && l.alive(t + 249);
    }
    ok("beats every 250 ms for a minute: alive throughout", steady);
    l.beat(100000);
    ok("2999 ms without a beat: still alive", l.alive(102999));
    ok("3000 ms without a beat: stalled", !l.alive(103000) && l.since(103000) == 3000);
    ok("still stalled 20 s on", !l.alive(120000));
    l.beat(120000);
    ok("the next beat: alive again", l.alive(120000));

    Liveness s(500);
    s.beat(0);
    ok("a shorter limit is kept", s.alive(499) && !s.alive(500));

    Liveness off(0);
    off.beat(0);
    ok("dcsm_liveness_ms 0: never stalled", off.alive(3000) && off.alive(1000000));
    Liveness set;
    set.set_stall_ms(0);
    set.beat(0);
    ok("set_stall_ms(0) before start: never stalled", set.alive(60000));

    /* Dcsm2Link's gate (HeartbeatGate): a heartbeat every 250 ms goes only
     * while alive; each change reported once. */
    Liveness g;
    HeartbeatGate gate(&g);
    int sent = 0, held = 0, stalls = 0, moves = 0;
    int64_t stalled_at = -1, moving_at = -1;
    g.beat(0);
    for (int64_t t = 0; t <= 20000; t += 250) {
        if (t <= 2000 || t >= 15000)
            g.beat(t);   /* the loop runs for 2 s, freezes, moves again at 15 s */
        HeartbeatGate::Change c = HeartbeatGate::None;
        (gate.allow(t, &c) ? sent : held)++;
        if (c == HeartbeatGate::Stalled) {
            stalls++;
            stalled_at = t;
        } else if (c == HeartbeatGate::Moving) {
            moves++;
            moving_at = t;
        }
    }
    ok("a loop frozen from 2 s to 15 s: heartbeats held from 5 s to 14.75 s", held == 40 && sent == 41);
    ok("the stall reported once, at 5 s", stalls == 1 && stalled_at == 5000);
    ok("moving again reported once, at 15 s", moves == 1 && moving_at == 15000 && !gate.stalled());

    Liveness n;
    HeartbeatGate ng(&n);
    bool all = true, changed = false;
    for (int64_t t = 0; t <= 20000; t += 250) {
        n.beat(t);
        HeartbeatGate::Change c = HeartbeatGate::None;
        all = all && ng.allow(t + 200, &c);
        changed = changed || c != HeartbeatGate::None;
    }
    ok("a healthy loop: every heartbeat goes, no change reported", all && !changed);

    Liveness z(0);
    HeartbeatGate zg(&z);
    z.beat(0);
    HeartbeatGate::Change zc = HeartbeatGate::None;
    ok("the gate with dcsm_liveness_ms 0: heartbeats go though the loop froze", zg.allow(60000, &zc) &&
                                                                               zc == HeartbeatGate::None);

    if (failures)
        std::printf("%d failed\n", failures);
    return failures ? 1 : 0;
}
