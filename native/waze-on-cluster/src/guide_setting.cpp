// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "guide_setting.h"

#include <fcntl.h>
#include <unistd.h>

#include <fstream>

#include "log.h"

namespace woc {

namespace {

const char kKey[] = "hide_bmw_guidance";

/* "0" or "1" as the choice; anything else counts as hidden, with a warning
 * naming where it came from. */
bool parse(const std::string &value, const std::string &from)
{
    if (value == "0" || value == "1")
        return value == "1";
    log_warn("%s: %s must be 0 or 1, not \"%s\": BMW's turn box stays hidden", from.c_str(), kKey, value.c_str());
    return true;
}

}  // namespace

GuideSetting::GuideSetting(const std::string &conf, const std::string &state_path) : path_(state_path)
{
    hide_ = parse(conf, "settings");
    if (access(path_.c_str(), F_OK) != 0)
        return;
    std::ifstream f(path_);
    if (!f) {
        log_warn("%s: cannot read it: BMW's turn box stays hidden", path_.c_str());
        hide_ = true;
        return;
    }
    std::string line, value = "(none)";
    const std::string prefix = std::string(kKey) + " = ";
    while (std::getline(f, line))
        if (line.compare(0, prefix.size(), prefix) == 0)
            value = line.substr(prefix.size());
    hide_ = parse(value, path_);
}

bool GuideSetting::set(const std::string &value)
{
    if (value != "0" && value != "1")
        return false;
    hide_ = value == "1";
    const std::string text = std::string(kKey) + " = " + value + "\n", tmp = path_ + ".tmp";
    const int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    const bool whole = fd >= 0 && write(fd, text.data(), text.size()) == (ssize_t)text.size() && fsync(fd) == 0;
    if (fd >= 0)
        close(fd);
    if (!whole || rename(tmp.c_str(), path_.c_str()) != 0) {
        unlink(tmp.c_str());
        log_warn("guide: cannot write %s; BMW's turn box %s until the service stops", path_.c_str(),
                 hide_ ? "stays hidden" : "shows");
    }
    return true;
}

}  // namespace woc
