/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "refused.h"

#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <fstream>
#include <vector>

#include "cluster_render/protocol.h"
#include "log.h"

#ifndef CR_VERSION
#define CR_VERSION ""
#endif

namespace crs {

namespace {

volatile sig_atomic_t g_stop;
void on_stop(int) { g_stop = 1; }

const size_t kMaxClients = 32;

struct Client {
    int fd;
    std::string in;
};

/* systemd's socket (fd 3, LISTEN_PID = us), else path made here. */
int listen_socket(const cld::Config &cfg, bool *own)
{
    const char *pid = getenv("LISTEN_PID"), *fds = getenv("LISTEN_FDS");
    if (pid && fds && atoi(pid) == (int)getpid() && atoi(fds) >= 1)
        return 3;
    const std::string path = cfg.str("socket_path");
    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    if (path.size() >= sizeof addr.sun_path)
        return -1;
    std::strcpy(addr.sun_path, path.c_str());
    unlink(path.c_str());
    const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0 || bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0 || listen(fd, 8) < 0) {
        log_error("socket %s: %s", path.c_str(), strerror(errno));
        if (fd >= 0)
            close(fd);
        return -1;
    }
    chmod(path.c_str(), (mode_t)std::strtoul(cfg.str("socket_mode").c_str(), nullptr, 8));
    *own = true;
    return fd;
}

/* Answers each whole JSON message in c.in; false when c is to be dropped. */
bool answer(Client &c, const std::string &reason)
{
    size_t used = 0, len = 0;
    uint8_t type = 0;
    const char *body = nullptr;
    bool bad = false;
    while (cr::next_message(c.in.data(), c.in.size(), &used, &type, &body, &len, &bad)) {
        cr::Json j;
        if (type == cr::kJson && cr::parse_json(std::string(body, len), &j) && !j["op"].empty()) {
            const std::string ev = j["op"] == "status"
                ? cr::json_object({{"ev", cr::json_quote("status")}, {"text", cr::json_quote(reason + "\n")}})
                : cr::json_object({{"ev", cr::json_quote("error")}, {"op", cr::json_quote(j["op"])},
                                   {"reason", cr::json_quote(reason)}});
            const std::string m = cr::encode(cr::kJson, ev);
            if (send(c.fd, m.data(), m.size(), MSG_DONTWAIT) != (ssize_t)m.size())
                return false;
        }
        c.in.erase(0, used);
    }
    return !bad;
}

}  // namespace

int serve_refused(const cld::Config &cfg, const std::string &why)
{
    if (cfg.has("log_file"))
        cld::log_to_file(cfg.str("log_file"), cld::log_file_cap(cfg.num("log_file_kb")), "cluster-render", CR_VERSION);
    const std::string reason = "not supported on this car (" + why + ")";
    log_warn("%s: nothing is drawn on the cluster or the HUD; the service stays idle", why.c_str());
    if (cfg.has("status_path"))
        std::ofstream(cfg.str("status_path")) << reason << "\n";

    struct sigaction sa;
    std::memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_stop;
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

    bool own = false;
    const int lfd = listen_socket(cfg, &own);
    if (lfd < 0)
        return 1;
    std::vector<Client> clients;
    while (!g_stop) {
        std::vector<pollfd> p{{lfd, POLLIN, 0}};
        for (const Client &c : clients)
            p.push_back(pollfd{c.fd, POLLIN, 0});
        if (poll(p.data(), p.size(), 1000) < 0 && errno != EINTR)
            break;
        for (size_t i = clients.size(); i-- > 0;) {
            if (!p[i + 1].revents)
                continue;
            char buf[65536];
            const ssize_t n = read(clients[i].fd, buf, sizeof buf);
            if (n > 0)
                clients[i].in.append(buf, (size_t)n);
            if (n <= 0 || !answer(clients[i], reason)) {
                close(clients[i].fd);
                clients.erase(clients.begin() + (long)i);
            }
        }
        if (p[0].revents & POLLIN) {
            const int fd = accept(lfd, nullptr, nullptr);
            if (fd >= 0 && clients.size() < kMaxClients)
                clients.push_back(Client{fd, std::string()});
            else if (fd >= 0)
                close(fd);
        }
    }
    for (const Client &c : clients)
        close(c.fd);
    close(lfd);
    if (own)
        unlink(cfg.str("socket_path").c_str());
    log_info("stopped");
    return 0;
}

}  // namespace crs
