// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The two choices the app's switches keep across a restart, in the state
 * file (state_file), whose lines are `key = 0|1`:
 *   hide_bmw_guidance  whether the map hides BMW's turn-by-turn box on the
 *                      cluster: the map layer's guide_hold (cluster-render's
 *                      PROTOCOL.md). {"cmd":"guide","hide":0|1}
 *   map_shown          whether the map shows on the cluster at all (MapFeed::
 *                      set_shown). {"cmd":"map","shown":0|1}
 * Each starts from its key in the configuration (hide_bmw_guidance, map_shown)
 * and the state file's line for that key replaces it. A key is in the file
 * only once the app changed that key, or when the file already held it; a key
 * the app never set stays out, so its configuration value wins at every start
 * (a state file of 0.8.9 holds hide_bmw_guidance only). A line that is not one
 * of the two keys is dropped at the next write. A value other than 0 or 1 in
 * either counts as the safe one, with a warning: hidden for hide_bmw_guidance,
 * shown for map_shown. A state file that does not read counts as both safe
 * values and holds neither key. Either change writes the file whole, with the
 * keys it holds, to a temporary file that is synced, renamed into place and
 * followed by a sync of the folder; one that cannot be written leaves the
 * choice in effect until the service stops, with a warning. */
#ifndef WOC_STATE_SETTINGS_H
#define WOC_STATE_SETTINGS_H

#include <string>

namespace woc {

class StateSettings {
public:
    /* Syncs the folder (its path) of the state file after the rename; true when
     * it did. Null: the real one, open and fsync. A test passes its own. */
    typedef bool (*DirSync)(const std::string &dir);

    /* hide_conf, shown_conf: the configuration's values; state_path: the app's choices. */
    StateSettings(const std::string &hide_conf, const std::string &shown_conf, const std::string &state_path,
                  DirSync dir_sync = nullptr);
    bool hide() const { return hide_; }
    bool shown() const { return shown_; }
    /* The app's choice, "0" or "1"; false for any other value, nothing
     * changed. */
    bool set_hide(const std::string &value);
    bool set_shown(const std::string &value);

private:
    /* The choices the file holds to it; false when it could not be written. */
    bool save() const;

    std::string path_;
    DirSync dir_sync_;
    bool hide_ = true, shown_ = true;
    /* The state file holds the key (it did, or the app set it). */
    bool has_hide_ = false, has_shown_ = false;
};

}  // namespace woc

#endif
