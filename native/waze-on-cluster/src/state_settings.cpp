// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "state_settings.h"

#include <fcntl.h>
#include <unistd.h>

#include <fstream>

#include "log.h"

namespace woc {

namespace {

const char kHide[] = "hide_bmw_guidance", kShown[] = "map_shown";

/* "0" or "1" as the choice; anything else counts as 1, the safe value of both
 * keys, with a warning naming where it came from and what stays. */
bool parse(const std::string &value, const std::string &from, const char *key, const char *stays)
{
    if (value == "0" || value == "1")
        return value == "1";
    log_warn("%s: %s must be 0 or 1, not \"%s\": %s", from.c_str(), key, value.c_str(), stays);
    return true;
}

bool parse_hide(const std::string &value, const std::string &from)
{
    return parse(value, from, kHide, "BMW's turn box stays hidden");
}

bool parse_shown(const std::string &value, const std::string &from)
{
    return parse(value, from, kShown, "the map shows");
}

}  // namespace

StateSettings::StateSettings(const std::string &hide_conf, const std::string &shown_conf,
                             const std::string &state_path)
    : path_(state_path)
{
    hide_ = parse_hide(hide_conf, "settings");
    shown_ = parse_shown(shown_conf, "settings");
    if (access(path_.c_str(), F_OK) != 0)
        return;
    std::ifstream f(path_);
    if (!f) {
        log_warn("%s: cannot read it: BMW's turn box stays hidden, the map shows", path_.c_str());
        hide_ = shown_ = true;
        return;
    }
    std::string line, hide = "(none)", shown;
    bool has_shown = false;
    const std::string hide_prefix = std::string(kHide) + " = ", shown_prefix = std::string(kShown) + " = ";
    while (std::getline(f, line)) {
        if (line.compare(0, hide_prefix.size(), hide_prefix) == 0)
            hide = line.substr(hide_prefix.size());
        else if (line.compare(0, shown_prefix.size(), shown_prefix) == 0) {
            shown = line.substr(shown_prefix.size());
            has_shown = true;
        }
    }
    hide_ = parse_hide(hide, path_);
    if (has_shown)
        shown_ = parse_shown(shown, path_);
}

bool StateSettings::save() const
{
    const std::string text = std::string(kHide) + " = " + (hide_ ? "1" : "0") + "\n" + kShown + " = " +
                             (shown_ ? "1" : "0") + "\n",
                      tmp = path_ + ".tmp";
    const int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    const bool whole = fd >= 0 && write(fd, text.data(), text.size()) == (ssize_t)text.size() && fsync(fd) == 0;
    if (fd >= 0)
        close(fd);
    if (!whole || rename(tmp.c_str(), path_.c_str()) != 0) {
        unlink(tmp.c_str());
        return false;
    }
    return true;
}

bool StateSettings::set_hide(const std::string &value)
{
    if (value != "0" && value != "1")
        return false;
    hide_ = value == "1";
    if (!save())
        log_warn("guide: cannot write %s; BMW's turn box %s until the service stops", path_.c_str(),
                 hide_ ? "stays hidden" : "shows");
    return true;
}

bool StateSettings::set_shown(const std::string &value)
{
    if (value != "0" && value != "1")
        return false;
    shown_ = value == "1";
    if (!save())
        log_warn("map: cannot write %s; the map %s until the service stops", path_.c_str(),
                 shown_ ? "shows" : "stays off");
    return true;
}

}  // namespace woc
