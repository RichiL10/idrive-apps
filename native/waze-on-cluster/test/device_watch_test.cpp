// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* DeviceWatch (device_watch.h): kLimit session failures in a row, with no
 * decoded frame between, are fatal. */
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

#include "device_watch.h"
#include "exit_watchdog.h"

using woc::DeviceWatch;

static int failures = 0;

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

int main()
{
    {
        DeviceWatch w;
        expect(!w.fatal() && w.in_a_row() == 0 && w.total() == 0, "starts clean");
        expect(!w.failed(0) && w.in_a_row() == 0, "no failures counted for 0");
    }
    {
        DeviceWatch w;
        expect(!w.failed(1) && !w.failed(1), "two failures are not fatal");
        expect(!w.fatal() && w.in_a_row() == 2, "two in a row");
        expect(w.failed(1), "the third in a row is fatal, and says so once");
        expect(w.fatal() && w.in_a_row() == 3 && w.total() == 3, "fatal after kLimit");
        expect(!w.failed(1) && w.fatal() && w.total() == 3, "once fatal, further failures are not counted again");
        w.frame();
        expect(w.fatal(), "fatal stays after a frame");
    }
    {
        DeviceWatch w;
        w.failed(1);
        w.failed(1);
        w.frame();
        expect(w.in_a_row() == 0 && w.total() == 2, "a decoded frame starts the count over");
        expect(!w.failed(1) && !w.failed(1) && !w.fatal(), "two more after it are not fatal");
        expect(w.failed(1) && w.fatal(), "three in a row after it are");
    }
    {
        DeviceWatch w;
        expect(w.failed(DeviceWatch::kLimit), "kLimit failures counted at once are fatal");
    }
    {
        DeviceWatch w;
        expect(!w.failed(2), "two at once are not fatal");
        expect(w.failed(1), "the next one is");
    }
    expect(DeviceWatch::kLimit == 3, "three failures in a row");
    {
        /* Review N6: the watchdog ends a process whose teardown hangs, with the given code. */
        const pid_t pid = fork();
        if (pid == 0) {
            woc::arm_exit_watchdog(200, 1);
            woc::arm_exit_watchdog(60000, 7);   /* armed once: a second call changes nothing */
            sleep(30);                          /* stands for a teardown stuck in MFXClose */
            _exit(99);
        }
        int st = 0, waited = 0;
        pid_t r = 0;
        for (int i = 0; i < 100 && r == 0; i++) {
            r = waitpid(pid, &st, WNOHANG);
            if (r == 0) { usleep(50000); waited += 50; }
        }
        if (r == 0) { kill(pid, SIGKILL); waitpid(pid, &st, 0); }
        expect(r == pid && WIFEXITED(st) && WEXITSTATUS(st) == 1, "the watchdog ends a hung process with its code (1)");
        expect(waited < 4000, "and within its grace period, not at the end of the hang");
    }
    if (failures) {
        fprintf(stderr, "device_watch_test: %d failures\n", failures);
        return 1;
    }
    printf("device_watch_test: ok\n");
    return 0;
}
