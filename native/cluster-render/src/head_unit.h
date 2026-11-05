/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Whether this head unit refuses the services that touch the car's media,
 * GPU or cluster (cluster-render, waze-on-cluster's capture), by the
 * bootloader's hwvariant= on the kernel command line: the rule of
 * waze-on-cluster's patch/head_unit.js, which its patchers and patchd
 * follow; both run the cases in test/head_unit_cases.jsonl. WOC_CMDLINE
 * points it elsewhere for tests. */
#ifndef CLD_HEAD_UNIT_H
#define CLD_HEAD_UNIT_H

#include <string>

namespace cld {

/* Why our services must stay inert on this head unit; "" where they run. */
std::string head_unit_refused();

/* The rule on the command line's text; null: unreadable. */
std::string head_unit_rule(const std::string *cmdline);

}  // namespace cld

#endif
