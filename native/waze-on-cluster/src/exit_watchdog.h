// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A hard exit after a grace period, armed when the process is on its way out
 * on a device failure (DeviceWatch::failed). The orderly teardown closes the
 * MSDK session (MFXClose), which may block for good on a GPU that is truly
 * hung; without this the exit would never finish, systemd would never see the
 * failure and would never restart the service. Armed once; the process ends
 * with `code` through _exit (no destructors, no atexit) when the time is up.
 * If the orderly exit finishes first, the process is gone and the thread with
 * it. */
#ifndef WOC_EXIT_WATCHDOG_H
#define WOC_EXIT_WATCHDOG_H

#include <atomic>
#include <chrono>
#include <thread>
#include <unistd.h>

namespace woc {

inline void arm_exit_watchdog(int grace_ms, int code)
{
    static std::atomic<bool> armed{false};
    if (armed.exchange(true))
        return;
    std::thread([grace_ms, code] {
        std::this_thread::sleep_for(std::chrono::milliseconds(grace_ms));
        _exit(code);
    }).detach();
}

}  // namespace woc

#endif
