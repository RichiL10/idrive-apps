// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The GPU decoder's failure accounting (DeviceWatch) wired to the decoder
 * (Decoder::set_device_failure_hook), and the flag the main loop polls to
 * arm the exit watchdog.
 *
 * A device failure is counted and, at the kLimit-th in a row, published as
 * fatal() from the hook, that is before the decoder tears the session down:
 * MFXClose and the closes before it can block for good on a hung GPU. The
 * publication also arms the exit watchdog (set_exit_watchdog) at once, so a
 * main loop that is blocked elsewhere and never polls fatal() cannot leave
 * the process without it; the main loop arms the same one-shot watchdog when
 * it sees fatal() (a no-op then). A decoder
 * that cannot even start on a lost device (init fails on a device status) is
 * counted the same way. After a device failure, a decoder that cannot start
 * for another reason counts too (init_failed): the device is likely gone.
 * Without a prior device failure, a start that fails for another reason (bad
 * parameters, a missing node) does not count. A decoded frame (frame())
 * starts the count over.
 *
 * Not thread-safe except fatal(): the thread that feeds the decoder does all
 * the rest. */
#ifndef WOC_DEVICE_GUARD_H
#define WOC_DEVICE_GUARD_H

#include <atomic>
#include <stdint.h>
#include <string>

#include "decoder_msdk.h"
#include "device_watch.h"
#include "exit_watchdog.h"
#include "log.h"

namespace woc {

class DeviceGuard {
public:
    /* Wires itself to d; must not move, and must outlive d's use. */
    void attach(Decoder *d)
    {
        d->set_device_failure_hook([this](const std::string &what) { failure(what); });
    }

    /* The GPU decoder is beyond recovery: the service should exit non-zero. */
    bool fatal() const { return fatal_.load(); }

    /* Arms the one-shot exit watchdog (exit_watchdog.h) from the fatal
     * publication itself, with `code` after grace_ms, before the decoder
     * tears the session down: the main loop may be blocked elsewhere and
     * never poll fatal(), while MFXClose hangs. grace_ms 0 (the default):
     * not armed from here. exit_fn replaces _exit in tests only. Before the
     * decoder is used (not thread-safe). */
    void set_exit_watchdog(int grace_ms, int code, ExitFn exit_fn = nullptr)
    {
        grace_ms_ = grace_ms;
        exit_code_ = code;
        exit_fn_ = exit_fn;
    }

    /* A decoded frame: the device works. */
    void frame() { watch_.frame(); }

    /* Device failures reported since construction, for init_failed's mark. */
    uint64_t reported() const { return reported_; }

    /* Decoder::init failed with err. mark is reported() from before the call:
     * a device failure init reported itself is counted already. */
    void init_failed(uint64_t mark, const std::string &err)
    {
        if (reported_ != mark || watch_.in_a_row() == 0)
            return;
        if (watch_.failed(1))
            publish(err);
    }

    uint64_t in_a_row() const { return watch_.in_a_row(); }

private:
    void failure(const std::string &what)
    {
        reported_++;
        if (watch_.failed(1)) {
            publish(what);
        } else if (!watch_.fatal()) {
            log_warn("waze: the GPU decoder failed (%s); %llu in a row, the decoder starts again at the next SPS",
                     what.c_str(), (unsigned long long)watch_.in_a_row());
        }
    }
    void publish(const std::string &what)
    {
        fatal_ = true;
        log_error("waze: the GPU decoder failed %u times in a row (the last: %s); exiting for systemd to restart the "
                  "service", DeviceWatch::kLimit, what.c_str());
        if (grace_ms_ > 0)
            arm_exit_watchdog(grace_ms_, exit_code_, exit_fn_);
    }

    DeviceWatch watch_;
    std::atomic<bool> fatal_{false};
    uint64_t reported_ = 0;
    int grace_ms_ = 0, exit_code_ = 1;
    ExitFn exit_fn_ = nullptr;
};

}  // namespace woc

#endif
