// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* DeviceGuard (device_guard.h) on the real decoder against the fake MSDK
 * (fake_msdk.h): the fatal flag the main loop polls to arm its exit watchdog
 * is published before the session is torn down, even when MFXClose blocks;
 * a decoder that cannot even start on a lost device (MFXInit, MFXInitEx,
 * SetHandle) counts as a failure, three in a row are fatal, a decoded frame
 * starts the count over, and a start that fails for another reason does not
 * count on its own. */
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include "decoder_msdk.h"
#include "device_guard.h"
#include "fake_msdk.h"
#include "mfx/mfxdefs.h"

using fake_msdk::access_unit;
using woc::Decoder;
using woc::DeviceGuard;
using woc::VideoFrame;

static int failures = 0;

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

/* body in a child process: the GPU copy fallback is the process's. */
static void isolated(const char *what, const std::function<void()> &body)
{
    fflush(stderr);
    const pid_t pid = fork();
    if (pid == 0) {
        failures = 0;
        body();
        fflush(stderr);
        _exit(failures ? 1 : 0);
    }
    int status = 0;
    if (pid < 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

/* The exit function the watchdog calls in these tests, instead of _exit. */
static std::atomic<int> g_exits{0}, g_exit_code{-1};
static void test_exit(int code)
{
    g_exit_code = code;
    g_exits++;
}

static bool wait_exit(int ms)
{
    for (int i = 0; i < ms / 10 && g_exits == 0; i++)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    return g_exits > 0;
}

static void any_fault(const char *call, int status, int after = 0, int times = 0)
{
    fake_msdk::any_fault.call = call;
    fake_msdk::any_fault.status = status;
    fake_msdk::any_fault.after = after;
    fake_msdk::any_fault.times = times;
}

static void clear_faults()
{
    fake_msdk::any_fault = fake_msdk::AnyFault();
    fake_msdk::gpu_fault = fake_msdk::GpuFault();
    fake_msdk::on_close = nullptr;
}

/* What the producer does with one decoder start: init, then the guard. */
static bool start(Decoder *d, DeviceGuard *g, bool gpu_copy = false, std::string *why = nullptr)
{
    std::string err;
    const uint64_t mark = g->reported();
    const bool ok = d->init("/dev/null", 1088, 480, 0, gpu_copy, &err);
    if (!ok)
        g->init_failed(mark, err);
    if (why)
        *why = err;
    return ok;
}

/* What it does with one feed: the access unit starts a sequence, whose first
 * decode fails with a device status when `any_fault` says so. */
static bool feed_one(Decoder *d, int *frames = nullptr)
{
    const std::string au = access_unit("1088x480", true, 7);
    std::string err;
    return d->feed((const uint8_t *)au.data(), au.size(), [frames](const VideoFrame &) {
        if (frames)
            ++*frames;
    }, &err, true);
}

int main()
{
    /* The fatal flag is up before MFXClose returns: the third device failure
     * is published from inside the decoder, ahead of the close that blocks. */
    {
        clear_faults();
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        any_fault("DecodeFrameAsync", MFX_ERR_GPU_HANG);
        for (int i = 0; i < 2; i++) {
            expect(start(&d, &g), "decoder starts");
            feed_one(&d);
            expect(d.device_failures() == 1, "a device failure is counted");
            d.shutdown();
            expect(!g.fatal() && g.in_a_row() == (uint64_t)i + 1, "not fatal before the third");
        }

        std::mutex m;
        std::condition_variable cv;
        bool in_close = false, release = false, fatal_in_close = false;
        fake_msdk::on_close = [&] {
            std::unique_lock<std::mutex> lock(m);
            fatal_in_close = g.fatal();
            in_close = true;
            cv.notify_all();
            cv.wait_for(lock, std::chrono::seconds(20), [&] { return release; });
        };
        expect(start(&d, &g), "decoder starts the third time");
        std::thread feeder([&] { feed_one(&d); });
        bool blocked = false, fatal_while_blocked = false;
        {
            std::unique_lock<std::mutex> lock(m);
            blocked = cv.wait_for(lock, std::chrono::seconds(10), [&] { return in_close; });
        }
        /* feed() is still inside MFXClose here, as on a hung GPU */
        fatal_while_blocked = g.fatal();
        {
            std::lock_guard<std::mutex> lock(m);
            release = true;
        }
        cv.notify_all();
        feeder.join();
        expect(blocked, "the close was reached");
        expect(fatal_in_close, "fatal was published before MFXClose was called");
        expect(fatal_while_blocked, "fatal is readable while MFXClose is blocked");
        expect(g.in_a_row() == 3, "three in a row");
        d.shutdown();
        clear_faults();
    }

    /* Review N1: the exit watchdog is armed by the fatal publication itself.
     * Nothing polls fatal() here (a main loop blocked elsewhere), MFXClose
     * never returns, and the watchdog still fires, once, with its code. The
     * exit function and the grace period are the test's. In a child process:
     * the watchdog is one-shot per process. */
    isolated("the third device failure arms the exit watchdog while MFXClose hangs", [] {
        clear_faults();
        g_exits = 0;
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        g.set_exit_watchdog(150, 1, test_exit);
        any_fault("DecodeFrameAsync", MFX_ERR_GPU_HANG);
        for (int i = 0; i < 2; i++) {
            expect(start(&d, &g), "decoder starts");
            feed_one(&d);
            d.shutdown();
        }
        expect(!g.fatal() && !wait_exit(400), "two failures: not fatal, the watchdog is not armed");

        std::mutex m;
        std::condition_variable cv;
        bool release = false;
        fake_msdk::on_close = [&] {
            std::unique_lock<std::mutex> lock(m);
            cv.wait_for(lock, std::chrono::seconds(20), [&] { return release; });
        };
        expect(start(&d, &g), "decoder starts the third time");
        std::thread feeder([&] { feed_one(&d); });   /* stuck in MFXClose */
        const bool fired = wait_exit(5000);
        expect(fired, "the watchdog fired while MFXClose was still blocked");
        expect(g.fatal(), "the failure is published");
        expect(g_exit_code == 1, "with exit code 1");
        {
            std::lock_guard<std::mutex> lock(m);
            release = true;
        }
        cv.notify_all();
        feeder.join();
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        expect(g_exits == 1, "and only once");
        d.shutdown();
        clear_faults();
    });
    isolated("a start that fails on a lost device three times in a row arms it too", [] {
        clear_faults();
        g_exits = 0;
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        g.set_exit_watchdog(100, 1, test_exit);
        any_fault("MFXInit", MFX_ERR_DEVICE_LOST);
        start(&d, &g);
        start(&d, &g);
        expect(!wait_exit(300), "two: not armed");
        start(&d, &g);
        expect(g.fatal() && wait_exit(5000) && g_exit_code == 1, "the third arms it");
        clear_faults();
    });
    isolated("a guard with no watchdog set never arms one", [] {
        clear_faults();
        g_exits = 0;
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        any_fault("MFXInit", MFX_ERR_DEVICE_LOST);
        for (int i = 0; i < 3; i++)
            start(&d, &g);
        expect(g.fatal() && !wait_exit(300), "fatal, and nothing armed from the guard");
        clear_faults();
    });

    /* A slow close after one failure changes nothing about the count. */
    {
        clear_faults();
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        bool seen = false;
        fake_msdk::on_close = [&] {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            seen = true;
        };
        any_fault("DecodeFrameAsync", MFX_ERR_DEVICE_LOST, 0, 1);
        expect(start(&d, &g), "decoder starts");
        feed_one(&d);
        expect(seen && !g.fatal() && g.in_a_row() == 1, "one failure counted, not fatal");
        clear_faults();
    }

    /* MFXInit, MFXInitEx and SetHandle failing with a device status three
     * starts in a row: fatal, with no earlier device failure needed. */
    for (const char *call : {"MFXInit", "SetHandle"}) {
        for (const int status : {MFX_ERR_GPU_HANG, MFX_ERR_DEVICE_LOST, MFX_ERR_DEVICE_FAILED}) {
            clear_faults();
            Decoder d;
            DeviceGuard g;
            g.attach(&d);
            any_fault(call, status);
            std::string why;
            expect(!start(&d, &g, false, &why), "a start on a lost device fails");
            expect(!g.fatal() && g.in_a_row() == 1, "one failure counted");
            expect(!start(&d, &g) && !g.fatal() && g.in_a_row() == 2, "two counted");
            expect(!start(&d, &g) && g.fatal() && g.in_a_row() == 3, "the third is fatal");
            clear_faults();
        }
    }
    isolated("GPU copy and a lost device", [] {
        /* with GPU copy: MFXInitEx falls back to a session without, which is
         * the one that decides; the failure counts once per start */
        clear_faults();
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        fake_msdk::gpu_fault.call = "MFXInitEx";
        fake_msdk::gpu_fault.status = MFX_ERR_DEVICE_LOST;
        any_fault("MFXInit", MFX_ERR_DEVICE_LOST);
        expect(!start(&d, &g, true) && g.in_a_row() == 1, "counted once for a start with GPU copy");
        expect(!start(&d, &g, true) && !start(&d, &g, true) && g.fatal(), "three starts are fatal");
    });
    isolated("GPU copy alone failing", [] {
        /* a device status that only fails the GPU copy session is no failure */
        clear_faults();
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        fake_msdk::gpu_fault.call = "MFXInitEx";
        fake_msdk::gpu_fault.status = MFX_ERR_DEVICE_LOST;
        expect(start(&d, &g, true), "the session without GPU copy starts");
        expect(g.in_a_row() == 0 && !g.fatal(), "nothing counted");
    });

    /* Another status: bad parameters and the like are not a device failure. */
    for (const char *call : {"MFXInit", "SetHandle"}) {
        clear_faults();
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        any_fault(call, MFX_ERR_UNSUPPORTED);
        for (int i = 0; i < 6; i++)
            start(&d, &g);
        expect(!g.fatal() && g.in_a_row() == 0, "a non-device init error is not counted");
        clear_faults();
    }
    {
        /* nor is a decoder that is refused its parameters */
        clear_faults();
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        std::string err;
        for (int i = 0; i < 6; i++) {
            const uint64_t mark = g.reported();
            if (!d.init("/dev/null", 1087, 480, 0, false, &err))
                g.init_failed(mark, err);
        }
        expect(!g.fatal() && g.in_a_row() == 0, "odd output size: not counted");
    }

    /* A decoded frame starts the count over. */
    {
        clear_faults();
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        any_fault("MFXInit", MFX_ERR_DEVICE_LOST, 0, 2);
        start(&d, &g);
        start(&d, &g);
        expect(g.in_a_row() == 2 && !g.fatal(), "two counted");
        int frames = 0;
        expect(start(&d, &g), "then the device works");
        feed_one(&d, &frames);
        expect(frames == 1, "a frame decodes");
        g.frame();   /* the producer's on_frame */
        expect(g.in_a_row() == 0, "the count starts over");
        any_fault("MFXInit", MFX_ERR_DEVICE_LOST, 0, 2);
        d.shutdown();
        start(&d, &g);
        start(&d, &g);
        expect(g.in_a_row() == 2 && !g.fatal(), "two more after the frame are not fatal");
        clear_faults();
    }

    /* After a device failure, a start that fails for another reason is one
     * more failure in a row (the device is likely gone). */
    {
        clear_faults();
        Decoder d;
        DeviceGuard g;
        g.attach(&d);
        any_fault("DecodeFrameAsync", MFX_ERR_GPU_HANG, 0, 1);
        expect(start(&d, &g), "decoder starts");
        feed_one(&d);
        d.shutdown();
        expect(g.in_a_row() == 1, "one device failure");
        any_fault("MFXInit", MFX_ERR_UNSUPPORTED);
        start(&d, &g);
        expect(g.in_a_row() == 2 && !g.fatal(), "a start failing after it counts");
        start(&d, &g);
        expect(g.fatal(), "and the third is fatal");
        clear_faults();
    }

    if (failures) {
        fprintf(stderr, "device_guard_test: %d failures\n", failures);
        return 1;
    }
    printf("device_guard_test: all passed\n");
    return 0;
}
