/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the wait between two RAMSES connect attempts (connect_wait.h):
 * a timeout and EINTR try again, POLLIN on the signal fd is a stop (exit 0),
 * and any other failure of the wait (poll() < 0 other than EINTR, POLLERR,
 * POLLHUP, POLLNVAL) is a failure (exit 1). Also against a real poll() on a
 * pipe. */
#include <poll.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>

#include "../src/connect_wait.h"

using crs::ConnectWait;
using crs::connect_wait;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

int main()
{
    ok("timeout: connect again", connect_wait(0, 0, 0) == ConnectWait::Retry);
    ok("EINTR: connect again", connect_wait(-1, EINTR, 0) == ConnectWait::Retry);
    ok("EBADF: failure", connect_wait(-1, EBADF, 0) == ConnectWait::Fail);
    ok("ENOMEM: failure", connect_wait(-1, ENOMEM, 0) == ConnectWait::Fail);
    ok("EINVAL: failure", connect_wait(-1, EINVAL, 0) == ConnectWait::Fail);
    ok("EFAULT: failure", connect_wait(-1, EFAULT, 0) == ConnectWait::Fail);
    ok("POLLIN: a stop", connect_wait(1, 0, POLLIN) == ConnectWait::Stop);
    ok("an old errno is of no account when poll() succeeded", connect_wait(1, EBADF, POLLIN) == ConnectWait::Stop);
    ok("POLLERR: failure, not a stop", connect_wait(1, 0, POLLERR) == ConnectWait::Fail);
    ok("POLLHUP: failure, not a stop", connect_wait(1, 0, POLLHUP) == ConnectWait::Fail);
    ok("POLLNVAL: failure, not a stop", connect_wait(1, 0, POLLNVAL) == ConnectWait::Fail);
    ok("POLLIN with POLLERR: failure", connect_wait(1, 0, POLLIN | POLLERR) == ConnectWait::Fail);
    ok("POLLIN with POLLHUP: failure", connect_wait(1, 0, POLLIN | POLLHUP) == ConnectWait::Fail);
    ok("a positive count with nothing we asked for: connect again", connect_wait(1, 0, 0) == ConnectWait::Retry);

    /* With real descriptors. */
    int fds[2];
    if (pipe(fds) != 0) {
        std::printf("FAIL pipe\n");
        return 1;
    }
    pollfd p{fds[0], POLLIN, 0};
    int n = poll(&p, 1, 0);
    ok("a quiet descriptor: connect again", connect_wait(n, errno, p.revents) == ConnectWait::Retry);
    if (write(fds[1], "x", 1) != 1)
        failures++;
    p = pollfd{fds[0], POLLIN, 0};
    n = poll(&p, 1, 1000);
    ok("a readable descriptor: a stop", connect_wait(n, errno, p.revents) == ConnectWait::Stop);
    close(fds[0]);
    close(fds[1]);
    p = pollfd{fds[0], POLLIN, 0};
    n = poll(&p, 1, 0);
    ok("a closed descriptor (POLLNVAL): failure", n > 0 && connect_wait(n, errno, p.revents) == ConnectWait::Fail);
    p = pollfd{-1, POLLIN, 0};
    n = poll(&p, 1, 0);
    ok("a negative descriptor is ignored by poll(): connect again", connect_wait(n, errno, p.revents) == ConnectWait::Retry);

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("connect_wait_test: all passed\n");
    return 0;
}
