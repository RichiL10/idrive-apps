// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* When a datagram arrived, from the time it is taken off the receive queue
 * and how long it waited there (PacketQueue::Packet::waited_us).
 *
 * The RTP depacketiser's idle reset (RtpH264::kIdleResetMs) must see the wire's
 * silence, not the decoder's: a decoder stalled for over a second (a GPU
 * recovery) leaves a live stream's packets waiting in the queue, and judging
 * them by the time they are popped would reset a stream that never went quiet.
 * Kept in its own header so a test can pin the arithmetic without a
 * VideoProducer. */
#ifndef WOC_ARRIVAL_TIME_H
#define WOC_ARRIVAL_TIME_H

#include <stdint.h>

namespace woc {

inline int64_t arrival_ms(int64_t now_ms, uint64_t waited_us)
{
    return now_ms - (int64_t)(waited_us / 1000);
}

}  // namespace woc

#endif
