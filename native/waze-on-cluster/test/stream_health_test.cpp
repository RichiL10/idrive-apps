// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the stream's health after a loss (stream_health.h): no
 * status reason while decoding through a loss, only its detail; the status
 * reason and its detail while the stream arrives with nothing decoded (a
 * render started mid-stream) and while the decoder waits for a keyframe;
 * the episode's start fixed once; which frames end a decode-through
 * episode; a new stream; the log lines and their limit; the minute's
 * counts. */
#include <cstdio>
#include <string>

#include "../src/stream_health.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

/* 2026-11-01 12:39:50 UTC */
static const int64_t kWall = 1793536790000LL;

int main()
{
    StreamHealth h;
    ok("a whole stream has no reason", h.reason().empty() && h.detail().empty() &&
                                           h.frame(10, 0, true).empty());

    const std::string l = h.loss(1000, kWall, "avb", 1235, 1240, 5, 0);
    ok("a loss is logged with the jump and the source",
       l == "waze: lost 5 packets of the stream from avb (sequence 1240, expected 1235); decoding through it");
    ok("decoding through it: no status reason, the detail says when",
       h.reason().empty() && !h.lost() && h.detail() == "lost part of the stream at 12:39:50; decoding through it");
    ok("a clean frame of the picture the loss cut short does not end it",
       h.frame(1010, 0, false).empty() && !h.detail().empty());
    ok("the first corrupted frame after the loss is logged with its flags",
       h.frame(1050, 0x10, true) == "waze: the first frame after the loss is corrupted (decoder flags 0x10)");
    ok("later ones are not", h.frame(1083, 0x10, true).empty() && h.frame(1116, 0x10, true).empty());
    ok("the first clean frame begun after the loss ends it, logged",
       h.frame(1150, 0, true) == "waze: the picture is clean again 150 ms after the loss at 12:39:50 (3 corrupted frames)" &&
           h.detail().empty());

    const std::string q = h.loss(5000, kWall + 4000, "udp", 9, 12, 3, 3);
    ok("a loss the receive queue caused says so",
       q == "waze: lost 3 packets of the stream from udp (sequence 12, expected 9; 3 dropped by the receive queue); "
            "decoding through it");
    h.loss(5200, kWall + 4200, "avb", 15, 16, 1, 0);
    ok("a further loss in the same episode keeps its start",
       h.detail() == "lost part of the stream at 12:39:54; decoding through it");
    h.keyframe_wait(kWall + 8000, 1999);
    ok("nothing decoded for under 2 s: not lost", !h.lost());
    h.keyframe_wait(kWall + 9000, 2000);
    ok("from 2 s: lost, the detail says since when",
       h.lost() && h.reason() == "Stream lost" &&
           h.detail() == "the stream arrives with nothing decoded since 12:39:57");
    h.keyframe_wait(kWall + 10400, 3001);   /* sampled a little off the second */
    ok("the episode's start is fixed once", h.detail() == "the stream arrives with nothing decoded since 12:39:57");
    h.keyframe_wait(kWall + 11000, 0);
    ok("a frame decoded: no longer lost", !h.lost());

    ok("a new stream ends the episode, logged",
       h.new_stream(6000, "avb", 17, 40000) == "waze: a new stream from avb (sequence 40000, expected 17)" &&
           h.detail().empty());

    StreamHealth mid;   /* a render started mid-stream: no loss, no frame */
    mid.keyframe_wait(kWall, 1000);
    const bool whole = mid.reason().empty();
    mid.keyframe_wait(kWall + 1000, 2000);
    ok("started mid-stream: whole until the wait reaches 2 s, then lost",
       whole && mid.reason() == "Stream lost");

    h.waiting(8000, kWall + 7000, true);
    ok("the decoder giving up: lost whatever the wait",
       h.lost() && h.reason() == "Stream lost" &&
           h.detail() == "the decoder gave up its sequence at 12:39:57 and waits for a keyframe");
    ok("a loss while waiting keeps it waiting",
       h.loss(9500, kWall + 8500, "avb", 20, 22, 2, 0) ==
               "waze: lost 2 packets of the stream from avb (sequence 22, expected 20); the decoder waits for a keyframe" &&
           h.lost());
    ok("a new sequence is whole, logged",
       h.waiting(11000, kWall + 10000, false) == "waze: decoding again from a keyframe after 3 s waiting" &&
           h.reason().empty());
    ok("a sequence that starts without a wait logs nothing", h.waiting(12000, kWall + 11000, false).empty());

    const StreamHealth::Minute m = h.take_minute();
    ok("the minute counts losses (not the new stream), packets lost and corrupted frames",
       m.losses == 4 && m.lost == 11 && m.corrupted == 3);
    const StreamHealth::Minute none = h.take_minute();
    ok("and starts over", none.losses == 0 && none.lost == 0 && none.corrupted == 0);

    StreamHealth caps;
    ok("no overflow: nothing logged or counted", caps.overflow(1000, "RTP fragment buffer (FU-A)", 0).empty());
    ok("an overflow is logged with what and how many",
       caps.overflow(1000, "RTP fragment buffer (FU-A)", 1) ==
           "waze: the RTP fragment buffer (FU-A) overran its size cap (1 dropped); resynchronising at the next start");
    caps.overflow(1001, "decoder's NAL/access unit buffer", 2);
    ok("an overflow does not make the stream lost or give it a reason", !caps.lost() && caps.reason().empty());
    const StreamHealth::Minute cm = caps.take_minute();
    ok("the minute counts every buffer dropped", cm.overflows == 3 && cm.losses == 0);
    ok("and starts over", caps.take_minute().overflows == 0);

    StreamHealth burst;
    unsigned logged = 0;
    for (int i = 0; i < 25; i++)
        logged += !burst.loss(1000 + i, kWall, "avb", (uint16_t)(2 * i), (uint16_t)(2 * i + 1), 1, 0).empty();
    ok("at most 10 lines a minute", logged == 10);
    ok("the next minute logs again", !burst.loss(61001, kWall, "avb", 100, 101, 1, 0).empty());
    ok("the minute line counts every loss", burst.take_minute().losses == 26);

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    return 0;
}
