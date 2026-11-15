// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* When the GPU decoder is beyond recovery in this process.
 *
 * A decoder session that hits a GPU hang or a lost or failed device
 * (decoder_msdk.h device_failures) is closed, and the video producer drops
 * the whole decoder, VA display and render node with it, so the next SPS
 * starts it afresh. A decoder start that fails after such a failure counts
 * as one more. kLimit of them in a row, with no frame decoded in between,
 * is fatal: the service exits non-zero and systemd starts it again
 * (Restart=on-failure, bounded by the unit's StartLimit). A decoded frame
 * starts the count over.
 *
 * Not thread-safe; the decode thread alone counts, any thread may read
 * fatal() once it is set (the flag is read after the decode thread wrote it
 * under the producer's lock). */
#ifndef WOC_DEVICE_WATCH_H
#define WOC_DEVICE_WATCH_H

#include <stdint.h>

namespace woc {

class DeviceWatch {
public:
    static const unsigned kLimit = 3;

    /* n more session failures. True when this one made it fatal. */
    bool failed(uint64_t n)
    {
        if (n == 0 || fatal_)
            return false;
        in_a_row_ += n;
        total_ += n;
        if (in_a_row_ >= kLimit) {
            fatal_ = true;
            return true;
        }
        return false;
    }

    /* A decoded frame: the device works. */
    void frame() { in_a_row_ = 0; }

    /* Failures since the last decoded frame. */
    uint64_t in_a_row() const { return in_a_row_; }
    uint64_t total() const { return total_; }
    bool fatal() const { return fatal_; }

private:
    uint64_t in_a_row_ = 0, total_ = 0;
    bool fatal_ = false;
};

}  // namespace woc

#endif
