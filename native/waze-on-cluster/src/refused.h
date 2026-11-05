// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The service on a head unit that refuses it (cluster-render's
 * head_unit.h): no AVB join, no UDP or FIFO source, no VA-API or MSDK, no
 * cluster renderer connection. It stays up until stopped, holding only its
 * control socket, so neither the socket nor Restart= starts it again, and
 * gives each owner one status, which status.json holds too: state
 * "unsupported", the reason in the app's words ("Unavailable", what an
 * older app shows as is) and the why in "refused". */
#ifndef WOC_REFUSED_H
#define WOC_REFUSED_H

#include <string>

#include "config.h"

namespace woc {

/* The status line it gives. */
std::string refused_status(const std::string &why);

/* 0 once stopped (SIGTERM, SIGINT); 1 when the control socket cannot be had. */
int serve_refused(const cld::Config &cfg, const std::string &why);

}  // namespace woc

#endif
