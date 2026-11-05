// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "control.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <grp.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "log.h"

namespace woc {

static const size_t MAX_LINE = 4096;

static void skip_ws(const std::string &s, size_t *i)
{
    while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r'))
        (*i)++;
}

static bool parse_string(const std::string &s, size_t *i, std::string *out)
{
    if (*i >= s.size() || s[*i] != '"')
        return false;
    (*i)++;
    out->clear();
    while (*i < s.size()) {
        char c = s[(*i)++];
        if (c == '"')
            return true;
        if (c == '\\') {
            if (*i >= s.size())
                return false;
            char e = s[(*i)++];
            switch (e) {
            case '"': case '\\': case '/': out->push_back(e); break;
            case 'n': out->push_back('\n'); break;
            case 't': out->push_back('\t'); break;
            default: return false;   /* \uXXXX and the rest: not in the protocol */
            }
        } else {
            out->push_back(c);
        }
    }
    return false;
}

bool parse_flat_json(const std::string &s, std::map<std::string, std::string> *out)
{
    size_t i = 0;
    out->clear();
    skip_ws(s, &i);
    if (i >= s.size() || s[i++] != '{')
        return false;
    skip_ws(s, &i);
    if (i < s.size() && s[i] == '}')
        return true;
    for (;;) {
        std::string key, value;
        skip_ws(s, &i);
        if (!parse_string(s, &i, &key))
            return false;
        skip_ws(s, &i);
        if (i >= s.size() || s[i++] != ':')
            return false;
        skip_ws(s, &i);
        if (i < s.size() && s[i] == '"') {
            if (!parse_string(s, &i, &value))
                return false;
        } else {
            size_t start = i;
            while (i < s.size() && s[i] != ',' && s[i] != '}' && s[i] != ' ')
                i++;
            value = s.substr(start, i - start);
            if (value.empty())
                return false;
        }
        (*out)[key] = value;
        skip_ws(s, &i);
        if (i >= s.size())
            return false;
        if (s[i] == ',') { i++; continue; }
        if (s[i] == '}') { i++; break; }
        return false;
    }
    skip_ws(s, &i);
    return i == s.size();
}

std::string json_escape(const std::string &s)
{
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(c); }
        else if (c == '\n') o += "\\n";
        else if ((unsigned char)c < 0x20) o.push_back(' ');
        else o.push_back(c);
    }
    return o + "\"";
}

Control::~Control()
{
    if (owner_fd_ >= 0)
        close(owner_fd_);
    if (listen_fd_ >= 0)
        close(listen_fd_);
    if (own_path_)
        unlink(path_.c_str());
}

bool Control::listen(const std::string &path, unsigned mode, const std::string &group, std::string *err)
{
    /* systemd socket activation: fd 3, LISTEN_PID = us. */
    const char *pid = getenv("LISTEN_PID");
    const char *fds = getenv("LISTEN_FDS");
    if (pid && fds && atoi(pid) == (int)getpid() && atoi(fds) >= 1) {
        listen_fd_ = 3;
        fcntl(listen_fd_, F_SETFD, FD_CLOEXEC);
        log_info("control: socket from systemd");
        return true;
    }

    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    if (path.size() >= sizeof addr.sun_path) {
        *err = "socket path too long";
        return false;
    }
    std::strcpy(addr.sun_path, path.c_str());
    std::string dir = path.substr(0, path.rfind('/'));
    if (!dir.empty())
        mkdir(dir.c_str(), 0755);
    unlink(path.c_str());

    listen_fd_ = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listen_fd_ < 0 || bind(listen_fd_, (struct sockaddr *)&addr, sizeof addr) < 0 ||
        ::listen(listen_fd_, 4) < 0) {
        *err = std::string("socket ") + path + ": " + strerror(errno);
        return false;
    }
    own_path_ = true;
    path_ = path;
    if (!group.empty()) {
        struct group *g = getgrnam(group.c_str());
        if (!g || chown(path.c_str(), (uid_t)-1, g->gr_gid) < 0)
            log_warn("control: cannot give %s to group %s", path.c_str(), group.c_str());
    }
    chmod(path.c_str(), mode);
    log_info("control: listening on %s", path.c_str());
    return true;
}

void Control::on_listen_readable()
{
    int fd = accept4(listen_fd_, nullptr, nullptr, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (fd < 0)
        return;
    if (owner_fd_ >= 0) {
        static const char busy[] = "{\"ev\":\"status\",\"state\":\"error\",\"target\":null,\"page\":null,"
                                   "\"reason\":\"busy\"}\n";
        ssize_t n = ::send(fd, busy, sizeof busy - 1, MSG_NOSIGNAL);
        (void)n;
        close(fd);
        log_info("control: second connection refused (busy)");
        return;
    }
    owner_fd_ = fd;
    inbuf_.clear();
    log_info("control: owner connected");
    handler_->on_owner_connected();
}

void Control::drop_owner()
{
    if (owner_fd_ < 0)
        return;
    close(owner_fd_);
    owner_fd_ = -1;
    inbuf_.clear();
    log_info("control: owner disconnected");
    handler_->on_owner_gone();
}

void Control::on_owner_readable()
{
    char buf[1024];
    ssize_t n = read(owner_fd_, buf, sizeof buf);
    if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
        drop_owner();
        return;
    }
    if (n < 0)
        return;
    inbuf_.append(buf, (size_t)n);
    size_t nl;
    while (owner_fd_ >= 0 && (nl = inbuf_.find('\n')) != std::string::npos) {
        std::string line = inbuf_.substr(0, nl);
        inbuf_.erase(0, nl + 1);
        std::map<std::string, std::string> msg;
        if (!parse_flat_json(line, &msg) || !msg.count("cmd")) {
            log_warn("control: bad message, dropping owner");
            drop_owner();
            return;
        }
        handler_->on_command(msg);
    }
    if (inbuf_.size() > MAX_LINE) {
        log_warn("control: line too long, dropping owner");
        drop_owner();
    }
}

void Control::send(const std::string &json_line)
{
    if (owner_fd_ < 0)
        return;
    std::string out = json_line + "\n";
    ssize_t n = ::send(owner_fd_, out.data(), out.size(), MSG_NOSIGNAL);
    /* The owner reads promptly; one that lets its socket fill is dropped. */
    if (n != (ssize_t)out.size())
        drop_owner();
}

void write_sibling_file(const std::string &fifo_path, const char *name, const std::string &content)
{
    std::string::size_type slash = fifo_path.find_last_of('/');
    if (slash == std::string::npos)
        return;
    std::string path = fifo_path.substr(0, slash) + "/" + name;
    std::string tmp = path + ".tmp";
    int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0)
        return;
    std::string line = content + "\n";
    ssize_t n = write(fd, line.data(), line.size());
    close(fd);
    if (n == (ssize_t)line.size())
        rename(tmp.c_str(), path.c_str());
    else
        unlink(tmp.c_str());
}

}  // namespace woc
