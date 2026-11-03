/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "dcsm2_link.h"

#include <fcntl.h>
#include <unistd.h>

#include "dcsm/dcsm_client.h"
#include "log.h"

namespace crs {

Dcsm2Link::Dcsm2Link()
{
    if (pipe2(wake_, O_NONBLOCK | O_CLOEXEC) < 0)
        wake_[0] = wake_[1] = -1;
}

Dcsm2Link::~Dcsm2Link()
{
    stop();
    if (wake_[0] >= 0) close(wake_[0]);
    if (wake_[1] >= 0) close(wake_[1]);
}

void Dcsm2Link::push(Event e)
{
    {
        std::lock_guard<std::mutex> lock(mutex_);
        events_.push_back(std::move(e));
    }
    char c = 0;
    ssize_t n = write(wake_[1], &c, 1);
    (void)n;
}

bool Dcsm2Link::start(const Options &o, std::string *err)
{
    if (wake_[0] < 0) {
        *err = "pipe failed";
        return false;
    }
    /* No VSOMEIP_CONFIGURATION: the unit's /etc/vsomeip, routed by vsomeipd,
     * as HmiMain3D does (DCSM.md "Running as uid 5000 next to HmiMain3D"). */
    app_ = vsomeip::runtime::get()->create_application(o.app_name);
    if (!app_ || !app_->init()) {
        *err = "vsomeip application did not initialise";
        return false;
    }
    const uint64_t handle = o.client_handle ? o.client_handle : dcsm::kDefaultClientHandle;
    heartbeat_replies_ = o.heartbeat_replies;
    client_.reset(new dcsm::Client(app_, handle,
                                   heartbeat_replies_ ? dcsm::HeartbeatMode::kRequest
                                                      : dcsm::HeartbeatMode::kFireAndForget));
    log_info("dcsm: vsomeip application %s, clientID 0x%llx, heartbeats %s", o.app_name.c_str(),
             (unsigned long long)handle, heartbeat_replies_ ? "as requests, replies checked" : "fire and forget");

    client_->onAvailability = [this](bool up) {
        Event e(Event::Availability);
        e.up = up;
        push(e);
    };
    client_->onSlots = [this](const std::vector<dcsm::SlotStatus2> &slots) {
        Event e(Event::Slots);
        for (const auto &s : slots) {
            SlotInfo i;
            i.slot = s.slotId;
            i.status = s.slotStatus;
            i.content = s.mappingInfo.contentId.sceneId;
            i.klass = s.mappingInfo.contentClass;
            i.map_status = s.mappingInfo.mapStatus;
            e.slots.push_back(i);
        }
        push(e);
    };
    client_->onReply = [this](vsomeip::method_t method, bool ok, uint32_t status) {
        Event e(Event::Reply);
        e.method = method;
        e.ok = ok;
        e.status = status;
        e.text = dcsm::status_name(status);
        push(e);
    };
    client_->onFetchStatus = [this](const dcsm::ContentId2 &c, uint32_t status) {
        if (status == dcsm::E_FETCH_STATUS_REMOVED && heartbeat_replies_) {
            dcsm::HeartbeatStats s = client_->heartbeatStats();
            log_info("dcsm: heartbeats at removal of 0x%llx: %u sent, %u replies (%u with a body), last reply %lld "
                     "ms ago",
                     (unsigned long long)c.sceneId, s.sent, s.replies, s.badReplies, (long long)s.sinceReplyMs);
        }
        Event e(Event::Fetch);
        e.scene = c.sceneId;
        e.status = status;
        push(e);
    };
    client_->onMapStatus = [this](const dcsm::ContentId2 &c, const dcsm::MapStatusTransition &t) {
        Event e(Event::Map);
        e.scene = c.sceneId;
        e.initial = t.initial;
        e.status = t.final_;
        push(e);
    };
    /* The start of the payload is enough to tell a layout apart. */
    client_->onUndecoded = [this](vsomeip::event_t event, const uint8_t *p, size_t n) {
        Event e(Event::Undecoded);
        e.method = event;
        e.status = (uint32_t)n;
        e.text = hex_bytes(p, n, 64);
        push(e);
    };
    client_->onSubscription = [this](vsomeip::event_t event, uint16_t code) {
        Event e(Event::Subscription);
        e.method = event;
        e.status = code;
        push(e);
    };
    /* The KOMBI drops a client's content about 10 s after its last heartbeat
     * or request (DCSM.md "Heartbeat"). Logged: the first reply, the first
     * bad reply, a refusal, every silence and its end. */
    client_->onHeartbeat = [this](const dcsm::HeartbeatReport &r) {
        const dcsm::HeartbeatStats &s = r.stats;
        /* A silence after replies is the link stalling; a KOMBI that never
         * answers heartbeat requests says nothing about the link. */
        if ((r.event == dcsm::HeartbeatReport::kSilent && s.replies > 0) ||
            r.event == dcsm::HeartbeatReport::kResumed) {
            Event e(Event::Heartbeat);
            e.up = r.event == dcsm::HeartbeatReport::kSilent;   /* silent */
            push(e);
        }
        switch (r.event) {
        case dcsm::HeartbeatReport::kFirstReply:
            log_info("dcsm: heartbeat reply: the KOMBI answers our heartbeats (%u sent, %u replies)", s.sent,
                     s.replies);
            break;
        case dcsm::HeartbeatReport::kResumed:
            log_info("dcsm: heartbeat replies resumed after %lld ms without (%u sent, %u replies)",
                     (long long)s.sinceReplyMs, s.sent, s.replies);
            break;
        case dcsm::HeartbeatReport::kBadReply:
            log_error("dcsm: heartbeat reply is an E_OK response with %u bytes, not empty (%u sent, %u replies); "
                      "further ones are counted, not logged",
                      r.length, s.sent, s.replies);
            break;
        case dcsm::HeartbeatReport::kRefused:
            log_error("dcsm: the KOMBI refused a heartbeat request: type 0x%02x, return code 0x%02x (%u sent, "
                      "%u replies); heartbeats go fire and forget until Dcsm2 is next available",
                      r.messageType, r.returnCode, s.sent, s.replies);
            break;
        case dcsm::HeartbeatReport::kSilent:
            if (s.replies == 0)
                log_error("dcsm: no heartbeat reply yet (%u sent)", s.sent);
            else
                log_error("dcsm: no heartbeat reply for %lld ms (%u sent, %u replies)", (long long)s.sinceReplyMs,
                          s.sent, s.replies);
            break;
        }
    };

    /* A render loop stalled for Liveness::kStallMs stops the heartbeats, so
     * the KOMBI's watchdog drops a frozen map within about 10 s; they go
     * again once the loop moves. Logged at each change. */
    client_->heartbeatGate = [this] {
        const int64_t now = cld::now_ms();
        const bool alive = liveness_.alive(now);
        if (!alive && !stalled_)
            log_error("dcsm: render loop stalled for %lld ms: heartbeats stopped, so the KOMBI drops our content",
                      (long long)liveness_.since(now));
        else if (alive && stalled_)
            log_info("dcsm: render loop moving again: heartbeats resumed");
        stalled_ = !alive;
        return alive;
    };

    log_info("dcsm: waiting for Dcsm2");
    client_->start();
    loop_ = std::thread([this] { app_->start(); });
    return true;
}

void Dcsm2Link::stop()
{
    if (!client_)
        return;
    client_->stop();
    app_->stop();
    if (loop_.joinable())
        loop_.join();
    client_.reset();
    app_.reset();
}

void Dcsm2Link::drain(Dcsm2Port *port, int64_t now_ms)
{
    char buf[64];
    while (read(wake_[0], buf, sizeof buf) > 0) {
    }
    std::deque<Event> events;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        events.swap(events_);
    }
    for (const Event &e : events) {
        switch (e.kind) {
        case Event::Availability: port->on_availability(e.up, now_ms); break;
        case Event::Reply: port->on_reply(e.method, e.ok, e.status, e.text, now_ms); break;
        case Event::Fetch: port->on_fetch_status(e.scene, e.status, now_ms); break;
        case Event::Map: port->on_map_status(e.scene, e.initial, e.status, now_ms); break;
        case Event::Slots: port->on_slots(e.slots, now_ms); break;
        case Event::Heartbeat: port->on_heartbeat(e.up, now_ms); break;
        case Event::Undecoded: port->on_undecoded(e.method, e.status, e.text, now_ms); break;
        case Event::Subscription: port->on_subscription(e.method, (uint16_t)e.status, now_ms); break;
        }
    }
}

void Dcsm2Link::fetch(uint64_t scene) { client_->fetch({scene, 0}); }
void Dcsm2Link::map(uint64_t scene, uint32_t cls, uint64_t slot) { client_->map({scene, 0}, cls, slot); }
void Dcsm2Link::unmap(uint64_t scene) { client_->unmap({scene, 0}); }
void Dcsm2Link::unmap_as(uint64_t client_handle, uint64_t scene) { client_->unmapAs(client_handle, {scene, 0}); }
void Dcsm2Link::unfetch(uint64_t scene) { client_->unfetch({scene, 0}); }
void Dcsm2Link::slots() { client_->requestSlotStatus(); }

}  // namespace crs
