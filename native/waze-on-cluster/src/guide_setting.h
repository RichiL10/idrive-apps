// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Whether the map hides BMW's turn-by-turn box on the cluster: the map
 * layer's guide_hold (cluster-render's PROTOCOL.md). hide_bmw_guidance in
 * the configuration, unless the app's choice is saved in the state file,
 * which the app's switch writes ({"cmd":"guide","hide":0|1} on the control
 * socket). A value other than 0 or 1 in either, or a state file that does
 * not read, counts as 1 (hidden), with a warning. The state file is written
 * whole and renamed into place; one that cannot be written leaves the
 * choice in effect until the service stops, with a warning. */
#ifndef WOC_GUIDE_SETTING_H
#define WOC_GUIDE_SETTING_H

#include <string>

namespace woc {

class GuideSetting {
public:
    /* conf: hide_bmw_guidance's value; state_path: the app's choice. */
    GuideSetting(const std::string &conf, const std::string &state_path);
    bool hide() const { return hide_; }
    /* The app's choice, "0" or "1"; false for any other value, nothing
     * changed. */
    bool set(const std::string &value);

private:
    std::string path_;
    bool hide_ = true;
};

}  // namespace woc

#endif
