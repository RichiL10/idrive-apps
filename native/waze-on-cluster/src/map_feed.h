// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* MapFeed: the decoded map as a video layer of the shared cluster renderer
 * (cluster-render, its PROTOCOL.md), and what the Waze app is told about it.
 *
 * One video layer, class content and contending with the stock map, on the
 * target the map goes to: `map` (the native central-map slot 0x100, whose
 * 1088x480 scene the map fills) unless a control start chose another; on a
 * whole-panel or HUD target it is the centred map area (map_geometry.h).
 * The renderer draws every frame the way waze-on-cluster always has (one
 * persistent R8 atlas written in changed tiles, packed fast motion, the
 * frame clock, newest frame only) within the budget all its clients share,
 * and maps the slot from the first frame the visible layer has. The layer
 * is visible while CarPlay's cluster stream is live, not frozen and shows a
 * picture (set_stream, freeze_watch.h): hidden, the renderer lets the slot
 * go and the stock map comes back. stall_ms, which releases the slot once
 * the frames stop that long, is only a backstop, since how often a static
 * map sends a frame depends on the phone (one about every ten seconds,
 * another about 30 a second).
 *
 * Only what the renderer needs goes: a frame whose picture is the last one
 * again goes as a repeat (the client's), and nothing goes while the layer
 * is hidden or the renderer is not reachable. The newest frame not sent is
 * held, and goes with the next frame or repeat; when the layer shows again
 * it goes (or a repeat of the last one sent) before the layer is made
 * visible, so the renderer never draws an older picture first. A new
 * layer (another target) starts from a copy of the old one's newest.
 *
 * The app's status line follows the stream, the layer and its target: idle
 * until the first frame or while the stream is not live, idle with kWaiting
 * while the stream's picture is blank, frozen while the stream is, starting
 * while the slot is asked for or held by the stock map and while the
 * renderer starts, showing with the frames handed over a second, error when
 * the renderer refused the layer or stays unreachable. Showing, and idle
 * while the stream is live, carry the stream's own reason (stream_health.h:
 * the stream lost) when it has one, in place of kWaiting. */
#ifndef WOC_MAP_FEED_H
#define WOC_MAP_FEED_H

#include <stdint.h>
#include <string>
#include <vector>

#include "cluster_render/client.h"
#include "freeze_watch.h"
#include "map_rect.h"

namespace woc {

struct FeedConfig {
    std::string socket = "/dev/shm/cluster-render/render.sock";
    std::string target = "map";
    cr::VideoOptions video;   /* w and h are the decoded frame's */
    MapRect rect;             /* where in the target; unset: the map area */
    bool guide_hold = true;   /* the layer's guide_hold: BMW's turn box hidden while the map shows */
};

/* The status the Waze app shows (its render socket's "status" event), with
 * the shared upload cap and why it is what it is, for the diagnostics. */
struct FeedStatus {
    std::string state = "idle";   /* idle, starting, showing, frozen, error */
    std::string target;
    std::string page;
    std::string reason;
    bool stream_reason = false;   /* the reason is the stream's (MapFeed::status) */
    unsigned upload_cap_kb = 0;   /* 0 until the renderer reports it */
    std::string upload_reason;
    bool guide_hold = true;
    bool guide_disabled = false;   /* cluster-render's guard keeps the turn box's hold off */
};

/* Whether a status is worth a log line: its state, reason or target differs
 * from the last one logged. The page (the frame rate, the bytes captured)
 * and the upload cap change every second and do not count. A change of the
 * reason alone to or from the stream's waits until kStreamMs after the last
 * such line, so a flaky link's losses, which have lines of their own, do not
 * fill the log; a change of state or target is logged at once. Called
 * with every status, so a change that waited is logged when due. */
class StatusLog {
public:
    static const int64_t kStreamMs = 10000;
    bool due(const FeedStatus &s, int64_t now_ms);

private:
    std::string state_, reason_;
    bool stream_ = false, logged_ = false;
    int64_t stream_ms_ = 0;
};

class MapFeed {
public:
    /* The reason while the stream is live and its picture blank. */
    static const char *const kWaiting;

    explicit MapFeed(const FeedConfig &cfg);

    /* Where the map goes from now on: a renderer target, or "sail" for the
     * native central-map slot. False for a name the renderer has not got
     * (known once connected). */
    bool set_target(const std::string &name);
    /* The layer's guide_hold from now on. */
    void set_guide_hold(bool hold);

    int fd() const { return client_.fd(); }
    bool wants_write() const { return client_.wants_write(); }
    void poll(int64_t now_ms);

    /* The newest decoded frame (the whole atlas), taken without a copy;
     * replaces one not yet sent. *atlas comes back as a buffer to fill next
     * (its size and contents undefined). */
    void offer(std::vector<uint8_t> *atlas, uint64_t id, int64_t now_ms);
    /* The newest decoded frame, whose picture is the last one offered
     * again. */
    void repeat(uint64_t id, int64_t now_ms);

    /* Whether CarPlay's cluster stream is live, whether it is frozen and
     * what it has to show: the layer is visible only while it is live, not
     * frozen and shows a picture. */
    void set_stream(bool live, bool frozen, Picture picture);

    /* The status for the app, with decode the capture and decode part of
     * the line and stream why the picture is not whole (empty: it is). */
    FeedStatus status(const std::string &decode, const std::string &stream = std::string()) const;
    /* The renderer's own status text (targets, layers, the upload cap),
     * asked for again once the last request is answered. */
    void request_report();
    const std::string &report() const { return report_; }

private:
    void make_layer();
    void count_second(int64_t now_ms);
    /* The layer is visible or about to be, on a connection. */
    bool sending() const;
    /* The newest picture to the layer: the held frame, else a repeat. */
    void send_newest();
    /* Makes the layer visible once the newest frame has gone. */
    void show_when_sent();

    FeedConfig cfg_;
    cr::Client client_;
    uint32_t layer_ = 0;
    cr::LayerOptions lo_;   /* the layer's options as last sent */
    bool show_due_ = false;   /* visible once the frame waiting has gone */
    std::vector<uint8_t> held_;   /* the newest frame, while held_new_ */
    bool held_new_ = false;       /* held_ is newer than anything the client has */
    uint64_t id_ = 0;             /* the newest frame's */
    bool live_ = false, frozen_ = false;
    Picture picture_ = Picture::None;
    const char *stream_line_ = nullptr;   /* the stream's state as last logged */
    std::string layer_state_ = "stalled", layer_reason_;
    std::string target_state_, holder_;
    unsigned cap_kb_ = 0, max_kb_ = 0;
    std::string budget_reason_, refused_, report_;
    bool connected_ = false, status_asked_ = false;
    /* Unreachable this long (it starts with the first client): an error. */
    static const int64_t kUnreachableMs = 15000;
    int64_t down_since_ms_ = -1;
    bool down_long_ = false;
    int64_t second_ms_ = 0;
    int frames_ = 0, rate_ = 0;
};

}  // namespace woc

#endif
