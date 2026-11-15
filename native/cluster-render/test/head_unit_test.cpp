/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the head-unit rule (head_unit.h) on the cases
 * waze-on-cluster's head_unit.js runs too (head_unit_cases.jsonl: a flat
 * JSON object a line, cmdline absent for an unreadable one), and
 * head_unit_refused() reading WOC_CMDLINE.
 *
 *   head_unit_test test/head_unit_cases.jsonl */
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <unistd.h>

#include "../src/head_unit.h"
#include "cluster_render/protocol.h"

static int failures;

static void ok(const std::string &name, bool cond, const std::string &got)
{
    std::printf("%-4s %s%s%s\n", cond ? "ok" : "FAIL", name.c_str(), cond ? "" : ": got ", cond ? "" : got.c_str());
    failures += !cond;
}

int main(int argc, char **argv)
{
    std::ifstream cases(argc > 1 ? argv[1] : "");
    if (!cases) {
        std::printf("FAIL no cases file\n");
        return 1;
    }
    std::string line;
    int n = 0;
    while (std::getline(cases, line)) {
        cr::Json c;
        if (line.empty())
            continue;
        if (!cr::parse_json(line, &c) || !c.count("name") || !c.count("refused")) {
            ok("readable case: " + line, false, "");
            continue;
        }
        const std::string got = cld::head_unit_rule(c.count("cmdline") ? &c["cmdline"] : nullptr);
        ok(c["name"], got == c["refused"], got);
        n++;
    }
    ok("at least 10 cases", n >= 10, std::to_string(n));

    char tmpl[] = "/tmp/crs-head-unit-XXXXXX";
    if (!mkdtemp(tmpl))
        return 1;
    const std::string cmdline = std::string(tmpl) + "/cmdline";
    setenv("WOC_CMDLINE", cmdline.c_str(), 1);
    std::ofstream(cmdline) << "console=ttyS0 hwvariant=HIGH quiet\n";
    const std::string high = cld::head_unit_refused();
    ok("WOC_CMDLINE with HIGH: runs", high.empty(), high);
    std::ofstream(cmdline) << "console=ttyS0 hwvariant=HIGHF quiet\n";
    const std::string highf = cld::head_unit_refused();
    ok("WOC_CMDLINE with HIGH F: runs", highf.empty(), highf);
    std::ofstream(cmdline) << "console=ttyS0 quiet\n";
    const std::string none = cld::head_unit_refused();
    ok("WOC_CMDLINE without hwvariant=: refused", none == "head unit: unknown variant is not supported (no hwvariant= on the kernel command line)", none);
    unlink(cmdline.c_str());
    const std::string missing = cld::head_unit_refused();
    ok("WOC_CMDLINE missing: refused", missing == "head unit: unknown variant is not supported (kernel command line unreadable)", missing);
    rmdir(tmpl);
    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
