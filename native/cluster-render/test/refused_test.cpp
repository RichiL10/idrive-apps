/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the launcher built for the host (argv[1]) on a head unit
 * that refuses it (refused.h), and on HIGH and HIGH F; a fake
 * cluster-render-idrive7 beside it records whether the generation's
 * service starts.
 *
 *   refused_test build/host/cluster-render   (from cluster-render's folder) */
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include "cluster_render/protocol.h"

static int failures;

static void ok(const char *name, bool cond, const std::string &detail = "")
{
    std::printf("%-4s %s%s%s\n", cond ? "ok" : "FAIL", name, cond || detail.empty() ? "" : ": ", cond ? "" : detail.c_str());
    if (!cond)
        failures++;
}

static std::string slurp(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static std::string dir, launcher, sock, status_file, marker;

/* The launcher on a unit whose kernel command line is cmdline. */
static pid_t run(const char *cmdline)
{
    std::ofstream(dir + "/cmdline") << cmdline;
    unlink(marker.c_str());
    unlink(status_file.c_str());
    const pid_t pid = fork();
    if (pid == 0) {
        setenv("WOC_CMDLINE", (dir + "/cmdline").c_str(), 1);
        const std::string s1 = "socket_path=" + sock, s2 = "status_path=" + status_file;
        execl(launcher.c_str(), launcher.c_str(), "-s", "generation=7", "-s", "log_file=", "-s", "local_conf=", "-s",
              s1.c_str(), "-s", s2.c_str(), (char *)nullptr);
        _exit(127);
    }
    return pid;
}

/* The event a JSON message gets, or "" when none comes. */
static std::string ask(const std::string &json)
{
    const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof addr.sun_path, "%s", sock.c_str());
    for (int i = 0; i < 100 && connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0; i++)
        usleep(20000);
    struct timeval tv = {3, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    const std::string m = cr::encode(cr::kJson, json);
    std::string in, out;
    if (write(fd, m.data(), m.size()) == (ssize_t)m.size()) {
        char buf[4096];
        for (ssize_t n; out.empty() && (n = read(fd, buf, sizeof buf)) > 0;) {
            in.append(buf, (size_t)n);
            size_t used = 0, len = 0;
            uint8_t type = 0;
            const char *body = nullptr;
            bool bad = false;
            if (cr::next_message(in.data(), in.size(), &used, &type, &body, &len, &bad))
                out.assign(body, len);
        }
    }
    close(fd);
    return out;
}

/* The child's exit status within ms, or -1 while it runs. */
static int exited(pid_t pid, int ms)
{
    int st = 0;
    for (int t = 0; t <= ms; t += 20) {
        if (waitpid(pid, &st, WNOHANG) == pid)
            return WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
        usleep(20000);
    }
    return -1;
}

int main(int argc, char **argv)
{
    char tmpl[] = "/tmp/crs-refused-XXXXXX";
    if (argc < 2 || !mkdtemp(tmpl))
        return 1;
    dir = tmpl;
    launcher = argv[1];
    sock = dir + "/render.sock";
    status_file = dir + "/status.txt";
    marker = dir + "/started";
    /* The service the launcher would start, beside it. */
    const std::string fake = launcher.substr(0, launcher.rfind('/') + 1) + "cluster-render-idrive7";
    std::ofstream(fake) << "#!/bin/sh\ntouch '" << marker << "'\n";
    chmod(fake.c_str(), 0755);
    const bool proc = access("/proc/self/exe", F_OK) == 0;

    pid_t pid = run("console=ttyS0 quiet\n");
    const std::string st = ask("{\"op\":\"status\"}");
    const std::string hello = ask("{\"op\":\"hello\",\"app\":\"test\",\"proto\":1}");
    cr::Json j;
    ok("no hwvariant=: a status request is told not supported",
       cr::parse_json(st, &j) && j["ev"] == "status" &&
           j["text"] == "not supported on this car (head unit: unknown variant is not supported (no hwvariant= on the kernel command line))\n", st);
    ok("no hwvariant=: hello gets an error, not supported",
       cr::parse_json(hello, &j) && j["ev"] == "error" && j["op"] == "hello" &&
           j["reason"] == "not supported on this car (head unit: unknown variant is not supported (no hwvariant= on the kernel command line))", hello);
    ok("no hwvariant=: the status file says so",
       slurp(status_file) == "not supported on this car (head unit: unknown variant is not supported (no hwvariant= on the kernel command line))\n", slurp(status_file));
    ok("no hwvariant=: still up after its clients", exited(pid, 1000) == -1);
    ok("no hwvariant=: the generation's service never started", access(marker.c_str(), F_OK) != 0);
    kill(pid, SIGTERM);
    ok("no hwvariant=: a SIGTERM ends it with 0", exited(pid, 3000) == 0);
    ok("no hwvariant=: its socket is gone", access(sock.c_str(), F_OK) != 0);

    for (const char *unit : {"HIGH", "HIGHF"}) {
        pid = run(("console=ttyS0 hwvariant=" + std::string(unit) + " quiet\n").c_str());
        const int code = exited(pid, 3000);
        if (code < 0)
            kill(pid, SIGKILL), waitpid(pid, nullptr, 0);
        ok((std::string(unit) + ": goes on to start the generation's service").c_str(), code >= 0 &&
           access(status_file.c_str(), F_OK) != 0 && (!proc || access(marker.c_str(), F_OK) == 0), "exit " + std::to_string(code));
    }

    const std::string unit = slurp("systemd/cluster-render.service");
    ok("cluster-render.service restarts on failure only", unit.find("\nRestart=on-failure\n") != std::string::npos);
    {
        // Review N5: the restart cap sits in [Unit] (systemd 237 ignores these keys under [Service]).
        const std::size_t svc = unit.find("\n[Service]");
        const std::size_t lim = unit.find("\nStartLimitIntervalSec=600\n");
        const std::size_t bur = unit.find("\nStartLimitBurst=30\n");
        ok("cluster-render.service caps restarts: StartLimitIntervalSec=600 and StartLimitBurst=30 in [Unit]",
           svc != std::string::npos && lim != std::string::npos && bur != std::string::npos && lim < svc && bur < svc);
    }

    unlink(fake.c_str());
    if (std::system(("rm -rf '" + dir + "'").c_str()) != 0)
        std::printf("     could not remove %s\n", dir.c_str());
    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
