/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the render loop's liveness (liveness.h): alive before the
 * first beat, alive while beats come less than 3 s apart, stalled from 3 s
 * without one, alive again with the next beat; and dcsm::Client's
 * heartbeat gate, as Dcsm2Link wires it, holds heartbeats while stalled. */
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

    /* Dcsm2Link's gate: a heartbeat every 250 ms goes only while alive. */
    Liveness g;
    int sent = 0, held = 0;
    g.beat(0);
    for (int64_t t = 0; t <= 10000; t += 250) {
        if (t <= 2000)
            g.beat(t);   /* the loop runs for 2 s, then freezes */
        (g.alive(t) ? sent : held)++;
    }
    ok("a loop frozen at 2 s: heartbeats until 5 s, none after", sent == 20 && held == 21);

    if (failures)
        std::printf("%d failed\n", failures);
    return failures ? 1 : 0;
}
