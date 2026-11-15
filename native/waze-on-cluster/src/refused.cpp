// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "refused.h"

#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <poll.h>

#include "control.h"
#include "log.h"

#ifndef WOC_VERSION
#define WOC_VERSION ""
#endif

namespace woc {

namespace {

volatile sig_atomic_t g_stop;
void on_stop(int) { g_stop = 1; }

/* Commands are not taken; each new owner is due the status. */
struct Owner : Control::Handler {
    bool due = false;
    void on_command(const std::map<std::string, std::string> &) override {}
    void on_owner_connected() override { due = true; }
    void on_owner_gone() override {}
};

}  // namespace

std::string refused_status(const std::string &why)
{
    return "{\"ev\":\"status\",\"state\":\"unsupported\",\"target\":\"\",\"page\":\"\",\"reason\":\"Unavailable\","
           "\"refused\":" + json_escape("not supported on this car (" + why + ")") + ",\"guide_disabled\":1}";
}

int serve_refused(const cld::Config &cfg, const std::string &why)
{
    if (cfg.has("log_file"))
        cld::log_to_file(cfg.str("log_file"), cld::log_file_cap(cfg.num("log_file_kb")), "waze-on-cluster", WOC_VERSION);
    log_warn("%s: no capture, no decode, nothing sent to the cluster renderer; the service stays idle", why.c_str());
    const std::string status = refused_status(why);
    write_sibling_file(cfg.str("fifo_path"), "status.json", status);

    struct sigaction sa;
    std::memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_stop;
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

    Owner owner;
    Control control(&owner);
    std::string err;
    if (!control.listen(cfg.str("socket_path"), (unsigned)std::strtoul(cfg.str("socket_mode").c_str(), nullptr, 8),
                        cfg.str("socket_group"), &err)) {
        log_error("%s", err.c_str());
        return 1;
    }
    while (!g_stop) {
        struct pollfd p[2] = {{control.listen_fd(), POLLIN, 0}, {control.owner_fd(), POLLIN, 0}};
        if (poll(p, 2, 1000) < 0 && errno != EINTR)
            break;
        if (control.owner_fd() >= 0 && (p[1].revents & (POLLIN | POLLHUP | POLLERR)))
            control.on_owner_readable();
        if (p[0].revents & POLLIN)
            control.on_listen_readable();
        if (owner.due && control.owner_fd() >= 0) {
            control.send(status);
            owner.due = false;
        }
    }
    log_info("stopped");
    return 0;
}

}  // namespace woc
