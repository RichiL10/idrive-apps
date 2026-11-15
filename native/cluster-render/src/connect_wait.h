/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* What the wait between two RAMSES connect attempts does with the result of
 * its poll() on the signal fd (unit_idrive8.cpp). Only a stop signal (POLLIN)
 * ends the service with 0. A poll() that fails other than by EINTR, or one
 * that reports POLLERR, POLLHUP or POLLNVAL on the signal fd, is a failure:
 * the service leaves with 1 so systemd (Restart=on-failure) starts it again,
 * as the main loops do (unit_idrive7.cpp, unit_idrive8.cpp). EINTR and a
 * timeout mean the next attempt. n, err and revents are poll()'s return
 * value, errno taken right after it, and the descriptor's revents. */
#ifndef CRS_CONNECT_WAIT_H
#define CRS_CONNECT_WAIT_H

#include <poll.h>

#include <cerrno>

namespace crs {

enum class ConnectWait {
    Retry,   /* try to connect again */
    Stop,    /* a stop signal: leave with 0 */
    Fail     /* the wait itself failed: leave with 1 */
};

inline ConnectWait connect_wait(int n, int err, short revents)
{
    if (n < 0)
        return err == EINTR ? ConnectWait::Retry : ConnectWait::Fail;
    if (n == 0)
        return ConnectWait::Retry;
    if (revents & (POLLERR | POLLHUP | POLLNVAL))
        return ConnectWait::Fail;
    if (revents & POLLIN)
        return ConnectWait::Stop;
    return ConnectWait::Retry;
}

}  // namespace crs

#endif
