/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The service on a head unit that refuses it (head_unit.h): no Dcsm2,
 * vsomeip, RAMSES or renderer, nor the service of the unit's generation.
 * It stays up until stopped, holding only its socket, so neither the socket
 * nor Restart= starts it again, and tells every client why: a status
 * request gets a status event, any other message an error event, both with
 * "not supported on this car (<why>)". The status file says the same. */
#ifndef CRS_REFUSED_H
#define CRS_REFUSED_H

#include <string>

#include "config.h"

namespace crs {

/* 0 once stopped (SIGTERM, SIGINT); 1 when the socket cannot be had. */
int serve_refused(const cld::Config &cfg, const std::string &why);

}  // namespace crs

#endif
