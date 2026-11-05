// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "map_feed.h"

#include <cstdio>
#include <cstdlib>
#include <sstream>

#include "log.h"
#include "map_geometry.h"

namespace woc {

const char *const MapFeed::kWaiting = "Waiting for the phone's map";

namespace {

/* The size of a target in the renderer's hello ("map:1088x480,panel:..."). */
bool target_size(const std::string &targets, const std::string &name, uint32_t *w, uint32_t *h)
{
    std::stringstream ss(targets);
    std::string t;
    while (std::getline(ss, t, ',')) {
        const size_t colon = t.find(':');
        if (colon == std::string::npos || t.compare(0, colon, name) != 0 || colon != name.size())
            continue;
        return std::sscanf(t.c_str() + colon + 1, "%ux%u", w, h) == 2;
    }
    return false;
}

}  // namespace

MapFeed::MapFeed(const FeedConfig &cfg) : cfg_(cfg), client_("waze-on-cluster", cfg.socket)
{
    client_.on_ready = [this] {
        connected_ = true;
        /* The layer is made again on this connection, so only a refusal on it
         * counts, and no status request is outstanding on it. */
        refused_.clear();
        status_asked_ = false;
        log_info("render: connected to the cluster renderer (%s; %s)", client_.backend.c_str(), client_.targets.c_str());
        if (!layer_)
            make_layer();
    };
    client_.on_layer = [this](uint32_t ref, const std::string &state, const std::string &reason) {
        if (ref != layer_)
            return;
        if (state != layer_state_ || reason != layer_reason_)
            log_info("render: map %s%s%s", state.c_str(), reason.empty() ? "" : " - ", reason.c_str());
        layer_state_ = state;
        layer_reason_ = reason;
    };
    client_.on_target = [this](const std::string &t, const std::string &state, const std::string &holder,
                               const std::string &) {
        if (t != cfg_.target)
            return;
        target_state_ = state;
        holder_ = holder;
    };
    client_.on_budget = [this](unsigned cap, unsigned max, const std::string &reason) {
        cap_kb_ = cap;
        max_kb_ = max;
        budget_reason_ = reason;
    };
    client_.on_error = [this](const std::string &op, uint32_t, const std::string &reason) {
        log_error("render: %s refused: %s", op.c_str(), reason.c_str());
        if (op == "layer") {
            refused_ = reason;
        }
    };
    client_.on_status = [this](const std::string &text) {
        report_ = text;
        status_asked_ = false;
    };
}

void MapFeed::make_layer()
{
    uint32_t tw = 0, th = 0;
    if (!target_size(client_.targets, cfg_.target, &tw, &th)) {
        refused_ = "the cluster renderer has no target " + cfg_.target;
        log_error("render: %s", refused_.c_str());
        return;
    }
    /* The map area: all of the map slot's scene, the centred 1088x480 of a
     * whole-panel one, a fitted centre on the HUD. */
    crk::QuadRect q = crk::map_quad(tw, th, cfg_.video.w, cfg_.video.h);
    if (cfg_.rect.set() && cfg_.rect.fits(tw, th))
        q = crk::QuadRect{cfg_.rect.x, cfg_.rect.y, cfg_.rect.w, cfg_.rect.h};
    else if (cfg_.rect.set())
        log_warn("render: map_rect %u,%u,%u,%u is outside %s (%ux%u); the map area instead", cfg_.rect.x,
                 cfg_.rect.y, cfg_.rect.w, cfg_.rect.h, cfg_.target.c_str(), tw, th);
    lo_ = cr::LayerOptions();
    lo_.target = cfg_.target;
    lo_.klass = "content";
    lo_.contend = true;   /* the map takes the slot back from the stock map */
    lo_.guide_hold = cfg_.guide_hold;
    lo_.x = (int)q.x;
    lo_.y = (int)q.y;
    lo_.w = q.w;
    lo_.h = q.h;
    lo_.visible = live_ && !frozen_ && picture_ == Picture::Shown;
    show_due_ = false;
    refused_.clear();
    layer_state_ = "stalled";
    layer_reason_.clear();
    target_state_.clear();
    holder_.clear();
    layer_ = client_.video(lo_, cfg_.video);
    log_info("render: map layer on %s (%ux%u), quad %ux%u at %u,%u", cfg_.target.c_str(), tw, th, q.w, q.h, q.x, q.y);
}

bool MapFeed::set_target(const std::string &name)
{
    const std::string t = name == "sail" ? "map" : name;
    uint32_t w, h;
    if (client_.connected() && !target_size(client_.targets, t, &w, &h))
        return false;
    if (t == cfg_.target && layer_)
        return true;
    if (layer_ && !held_new_)
        held_new_ = client_.latest(layer_, &held_);
    if (layer_)
        client_.drop(layer_);
    layer_ = 0;
    cfg_.target = t;
    if (client_.connected())
        make_layer();
    return true;
}

void MapFeed::set_guide_hold(bool hold)
{
    cfg_.guide_hold = hold;
    if (layer_ && lo_.guide_hold != hold) {
        lo_.guide_hold = hold;
        client_.set(layer_, lo_);
    }
}

void MapFeed::poll(int64_t now_ms)
{
    client_.poll(now_ms);
    if (connected_ && !client_.connected()) {
        connected_ = false;
        log_warn("render: the cluster renderer went away; reconnecting");
    }
    if (client_.connected()) {
        down_since_ms_ = -1;
    } else if (down_since_ms_ < 0) {
        down_since_ms_ = now_ms;
    } else if (!down_long_ && now_ms - down_since_ms_ >= kUnreachableMs) {
        down_long_ = true;
    }
    if (client_.connected() && down_long_) {
        down_long_ = false;
    }
    show_when_sent();
    count_second(now_ms);
}

void MapFeed::count_second(int64_t now_ms)
{
    if (now_ms - second_ms_ < 1000)
        return;
    const int rate = second_ms_ ? (int)((int64_t)frames_ * 1000 / (now_ms - second_ms_)) : 0;
    rate_ = rate;
    frames_ = 0;
    second_ms_ = now_ms;
}

bool MapFeed::sending() const
{
    return layer_ && client_.connected() && (lo_.visible || show_due_);
}

/* Counted as the frames the client would send, whether or not they go. */
void MapFeed::offer(std::vector<uint8_t> *atlas, uint64_t id, int64_t now_ms)
{
    id_ = id;
    if (layer_ && client_.connected())
        frames_++;
    held_new_ = !sending() || !client_.frame(layer_, atlas, id);
    if (held_new_)
        held_.swap(*atlas);
    count_second(now_ms);
}

void MapFeed::repeat(uint64_t id, int64_t now_ms)
{
    id_ = id;
    if (layer_ && client_.connected())
        frames_++;
    if (sending())
        send_newest();
    count_second(now_ms);
}

void MapFeed::send_newest()
{
    if (held_new_)
        held_new_ = !client_.frame(layer_, &held_, id_);
    else
        client_.repeat(layer_, id_);
}

void MapFeed::show_when_sent()
{
    if (!show_due_ || !layer_ || client_.frame_waiting(layer_))
        return;
    show_due_ = false;
    lo_.visible = true;
    client_.set(layer_, lo_);
}

void MapFeed::set_stream(bool live, bool frozen, Picture picture)
{
    if (live == live_ && frozen == frozen_ && picture == picture_)
        return;
    const char *line = !live                       ? "is not live"
                       : frozen                    ? "froze"
                       : picture == Picture::None  ? "is live, no frame yet"
                       : picture == Picture::Blank ? "is live, its picture blank"
                                                   : "is live, with a picture";
    if (line != stream_line_)   /* frames after the stream ends change only the verdicts */
        log_info("render: CarPlay's cluster stream %s", line);
    stream_line_ = line;
    live_ = live;
    frozen_ = frozen;
    picture_ = picture;
    const bool visible = live && !frozen && picture == Picture::Shown;
    if (!layer_ || (lo_.visible || show_due_) == visible)
        return;
    show_due_ = visible;
    if (visible) {
        if (client_.connected())
            send_newest();
        show_when_sent();
    } else if (lo_.visible) {
        lo_.visible = false;
        client_.set(layer_, lo_);
    }
}

void MapFeed::request_report()
{
    if (client_.connected() && !status_asked_) {
        client_.request_status();
        status_asked_ = true;
    }
}

bool StatusLog::due(const FeedStatus &s, int64_t now_ms)
{
    const std::string state = s.state + '\n' + s.target;
    if (logged_ && state == state_) {
        if (s.reason == reason_)
            return false;
        if (s.stream_reason || stream_) {
            if (now_ms - stream_ms_ < kStreamMs)
                return false;
            stream_ms_ = now_ms;
        }
    }
    state_ = state;
    reason_ = s.reason;
    stream_ = s.stream_reason;
    logged_ = true;
    return true;
}

FeedStatus MapFeed::status(const std::string &decode, const std::string &stream) const
{
    FeedStatus s;
    s.target = cfg_.target;
    s.upload_cap_kb = cap_kb_;
    s.upload_reason = budget_reason_;
    s.guide_hold = cfg_.guide_hold;
    auto g = client_.guide_disabled.find(cfg_.target);
    s.guide_disabled = client_.connected() && g != client_.guide_disabled.end() && g->second;
    char cap[96] = "";
    if (cap_kb_ && cap_kb_ < max_kb_)
        std::snprintf(cap, sizeof cap, ", upload cap %u KB/s", cap_kb_);
    if (!refused_.empty()) {
        s.state = "error";
        s.reason = refused_;
        s.page = decode;
    } else if (!client_.connected()) {
        s.state = down_long_ ? "error" : "starting";
        s.reason = down_long_ ? "cluster renderer not reachable" : "waiting for the cluster renderer";
        s.page = decode;
    } else if (frozen_ && live_) {
        s.state = "frozen";
        s.reason = "the phone's cluster stream froze";
        s.page = decode;
    } else if (!live_) {
        s.state = "idle";
        s.page = decode;
    } else if (picture_ != Picture::Shown) {
        s.state = "idle";   /* the layer hidden: the stock map shows */
        s.page = decode;
        s.reason = stream;
        s.stream_reason = !stream.empty();
        if (stream.empty() && picture_ == Picture::Blank)
            s.reason = kWaiting;
    } else if (layer_state_ == "shown") {
        s.state = "showing";
        char p[400];
        std::snprintf(p, sizeof p, "Waze map — %d frames/s (%s%s)", rate_, decode.c_str(), cap);
        s.page = p;
        s.reason = stream;
        s.stream_reason = !stream.empty();
    } else if (layer_state_ == "waiting" || layer_state_ == "suspended") {
        s.state = "starting";
        s.page = decode;
        if (layer_state_ == "suspended")
            s.reason = "under an alert on the cluster";
        else if (holder_ == "stock")
            s.reason = "the stock map holds the slot";
        else if (holder_ == "foreign")
            s.reason = "another app holds the slot";
        else
            s.reason = layer_reason_;
    } else if (layer_state_ == "error") {
        s.state = "error";
        s.reason = layer_reason_;
        s.page = decode;
    } else {
        s.state = "idle";   /* stalled: no frames yet, or none for idle_ms */
        s.page = decode;
        s.reason = stream;
        s.stream_reason = !stream.empty();
    }
    return s;
}

}  // namespace woc
