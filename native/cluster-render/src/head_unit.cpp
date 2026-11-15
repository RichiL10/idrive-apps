/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "head_unit.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <vector>

namespace cld {

namespace {

std::string unknown(const std::string &why) { return "head unit: unknown variant is not supported (" + why + ")"; }

}  // namespace

std::string head_unit_rule(const std::string *cmd)
{
    if (!cmd)
        return unknown("kernel command line unreadable");
    std::vector<std::string> values;
    std::istringstream in(*cmd);
    for (std::string word; in >> word;) {
        if (word.compare(0, 10, "hwvariant=") != 0)
            continue;
        std::string v = word.substr(10);
        if (!v.empty() && v.front() == '"')
            v.erase(0, 1);
        if (!v.empty() && v.back() == '"')
            v.pop_back();
        for (char &c : v)
            c = (char)std::toupper((unsigned char)c);
        values.push_back(v);
    }
    if (std::all_of(values.begin(), values.end(), [](const std::string &v) { return v.empty(); }))
        return unknown("no hwvariant= on the kernel command line");
    for (const std::string &v : values)
        if (v != values[0])
            return unknown("the kernel command line says hwvariant=" + values[0] + " and hwvariant=" + v);
    return "";
}

std::string head_unit_refused()
{
    const char *path = std::getenv("WOC_CMDLINE");
    std::ifstream f(path && *path ? path : "/proc/cmdline", std::ios::binary);
    if (!f)
        return head_unit_rule(nullptr);
    std::stringstream ss;
    ss << f.rdbuf();
    const std::string cmd = ss.str();
    return head_unit_rule(&cmd);
}

}  // namespace cld
