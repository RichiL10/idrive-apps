/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "dcsm_client.h"

#include <time.h>

#include <chrono>
#include <set>

namespace dcsm {

namespace {

void put32(std::vector<uint8_t> &b, uint32_t v) {
    for (int s = 24; s >= 0; s -= 8) b.push_back(uint8_t(v >> s));
}
void put64(std::vector<uint8_t> &b, uint64_t v) {
    for (int s = 56; s >= 0; s -= 8) b.push_back(uint8_t(v >> s));
}

// Big-endian reader; bad turns true on the first read past the end.
struct Reader {
    const uint8_t *p;
    size_t n;
    bool bad = false;
    uint64_t take(size_t width) {
        if (bad || n < width) {
            bad = true;
            return 0;
        }
        uint64_t v = 0;
        for (size_t i = 0; i < width; i++) v = (v << 8) | p[i];
        p += width;
        n -= width;
        return v;
    }
    uint32_t u32() { return uint32_t(take(4)); }
    uint64_t u64() { return take(8); }
    ContentId2 content() {
        ContentId2 c;
        c.sceneId = u64();
        c.elementTag = u32();
        return c;
    }
    bool done() const { return !bad && n == 0; }
};

uint64_t monotonic_ns() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return uint64_t(ts.tv_sec) * 1000000000u + uint64_t(ts.tv_nsec);
}

int64_t steady_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

}  // namespace

std::string status_name(uint32_t status) {
    static const char *const names[] = {
        "E_DCSM_OK", "E_DCSM_HANDLE_UNKNOWN", "E_DCSM_REQUESTID_UNKNOWN", "E_DCSM_REQUESTID_INUSE",
        "E_DCSM_CONTENTID_UNKNOWN", "E_DCSM_SLOTID_UNKNOWN", "E_DCSM_PRIOTOOLOW",
        "E_DCSM_CONTENT_ALREADYMAPPED", "E_DCSM_CLIENT_ALREADYREGISTERED"};
    if (status < sizeof names / sizeof names[0]) return names[status];
    return "UNKNOWN(" + std::to_string(status) + ")";
}

namespace wire {

std::vector<uint8_t> content_request(uint64_t client, const ContentId2 &c) {
    std::vector<uint8_t> b;
    put64(b, client);
    put64(b, c.sceneId);
    put32(b, c.elementTag);
    return b;
}

std::vector<uint8_t> map_request(uint64_t client, const ContentId2 &c, uint32_t contentClass,
                                 uint64_t slotId) {
    std::vector<uint8_t> b = content_request(client, c);
    put32(b, contentClass);
    put64(b, slotId);
    return b;
}

std::vector<uint8_t> heartbeat(uint64_t client, uint32_t counter, uint64_t timestamp) {
    std::vector<uint8_t> b;
    put64(b, client);
    put32(b, counter);
    put64(b, timestamp);
    return b;
}

bool status_reply(const uint8_t *p, size_t n, uint32_t &status) {
    Reader r{p, n};
    status = r.u32();
    return r.done();
}

bool fetch_status_change(const uint8_t *p, size_t n, ContentId2 &c, uint32_t &status) {
    Reader r{p, n};
    c = r.content();
    status = r.u32();
    return r.done();
}

bool map_status_change(const uint8_t *p, size_t n, ContentId2 &c, MapStatusTransition &t) {
    Reader r{p, n};
    c = r.content();
    t.initial = r.u32();
    t.final_ = r.u32();
    t.startTime = r.u64();
    t.endTime = r.u64();
    t.hint = r.u32();
    return r.done();
}

bool slot_status_change(const uint8_t *p, size_t n, std::vector<SlotStatus2> &slots) {
    const size_t kSlotSize = 32;  // slotId u64, slotStatus u32, MappingInfo (8+4+4+4)
    Reader r{p, n};
    uint32_t bytes = r.u32();
    if (r.bad || bytes != r.n || bytes % kSlotSize != 0 || bytes / kSlotSize > 1024) return false;
    slots.clear();
    while (r.n > 0) {
        SlotStatus2 s;
        s.slotId = r.u64();
        s.slotStatus = r.u32();
        s.mappingInfo.contentId = r.content();
        s.mappingInfo.contentClass = r.u32();
        s.mappingInfo.mapStatus = r.u32();
        slots.push_back(s);
    }
    return r.done();
}

}  // namespace wire

Client::Client(std::shared_ptr<vsomeip::application> app, uint64_t clientHandle,
               HeartbeatMode heartbeatMode)
    : app_(std::move(app)), clientHandle_(clientHandle), heartbeatMode_(heartbeatMode) {}

Client::~Client() { stop(); }

void Client::start() {
    if (running_.exchange(true)) return;
    app_->register_message_handler(
        kService, kInstance, vsomeip::ANY_METHOD,
        [this](const std::shared_ptr<vsomeip::message> &m) { onMessage(m); });
    app_->register_availability_handler(
        kService, kInstance,
        [this](vsomeip::service_t, vsomeip::instance_t, bool a) { onAvailable(a); }, kMajor,
        vsomeip::ANY_MINOR);
    for (vsomeip::event_t e : {kFetchStatusChange, kMapStatusChange, kSlotStatusChange}) {
        app_->request_event(kService, kInstance, e, std::set<vsomeip::eventgroup_t>{kEventgroup},
                            vsomeip::event_type_e::ET_EVENT,
                            vsomeip::reliability_type_e::RT_RELIABLE);
    }
    // Selective: refusals are reported too, not only acceptances.
    for (vsomeip::event_t e :
         {kFetchStatusChange, kMapStatusChange, kSlotStatusChange, vsomeip::ANY_EVENT}) {
        app_->register_subscription_status_handler(
            kService, kInstance, kEventgroup, e,
            [this](vsomeip::service_t, vsomeip::instance_t, vsomeip::eventgroup_t,
                   vsomeip::event_t event, uint16_t code) {
                if (onSubscription) onSubscription(event, code);
            },
            true);
    }
    app_->request_service(kService, kInstance, kMajor, vsomeip::ANY_MINOR);
    app_->subscribe(kService, kInstance, kEventgroup, kMajor);
    heartbeat_ = std::thread([this] { heartbeatLoop(); });
}

void Client::stop() {
    if (!running_.exchange(false)) return;
    heartbeat_.join();
    app_->unsubscribe(kService, kInstance, kEventgroup);
    for (vsomeip::event_t e :
         {kFetchStatusChange, kMapStatusChange, kSlotStatusChange, vsomeip::ANY_EVENT})
        app_->unregister_subscription_status_handler(kService, kInstance, kEventgroup, e);
    app_->release_service(kService, kInstance);
    app_->unregister_availability_handler(kService, kInstance, kMajor, vsomeip::ANY_MINOR);
    app_->unregister_message_handler(kService, kInstance, vsomeip::ANY_METHOD);
}

void Client::fetch(const ContentId2 &c) {
    send(kReqFetchContent, wire::content_request(clientHandle_, c), true);
}

void Client::map(const ContentId2 &c, uint32_t contentClass, uint64_t slotId) {
    send(kReqMapContent, wire::map_request(clientHandle_, c, contentClass, slotId), true);
}

void Client::unmap(const ContentId2 &c) {
    send(kReqUnmapContent, wire::content_request(clientHandle_, c), true);
}

void Client::unmapAs(uint64_t clientHandle, const ContentId2 &c) {
    send(kReqUnmapContent, wire::content_request(clientHandle, c), true);
}

void Client::unfetch(const ContentId2 &c) {
    send(kReqUnfetchContent, wire::content_request(clientHandle_, c), true);
}

void Client::requestSlotStatus() { send(kReqSlotStatusUpdate, {}, false); }

void Client::send(vsomeip::method_t method, const std::vector<uint8_t> &payload,
                  bool expectReply) {
    auto rt = vsomeip::runtime::get();
    std::shared_ptr<vsomeip::message> m = rt->create_request(true);
    m->set_service(kService);
    m->set_instance(kInstance);
    m->set_method(method);
    m->set_interface_version(kMajor);
    if (!expectReply) m->set_message_type(vsomeip::message_type_e::MT_REQUEST_NO_RETURN);
    std::shared_ptr<vsomeip::payload> body = rt->create_payload();
    body->set_data(payload);
    m->set_payload(body);
    app_->send(m);
}

void Client::onAvailable(bool available) {
    if (available_.load() == available) return;
    if (available) {
        std::lock_guard<std::mutex> l(hbMutex_);
        hb_ = HeartbeatTracker();
    }
    available_ = available;
    if (onAvailability) onAvailability(available);
    if (available) requestSlotStatus();
}

void Client::onMessage(const std::shared_ptr<vsomeip::message> &m) {
    std::shared_ptr<vsomeip::payload> body = m->get_payload();
    const uint8_t *p = body ? body->get_data() : nullptr;
    size_t n = body ? body->get_length() : 0;
    ContentId2 c;

    switch (m->get_message_type()) {
    case vsomeip::message_type_e::MT_NOTIFICATION: {
        bool decoded = false;
        if (m->get_method() == kSlotStatusChange) {
            std::vector<SlotStatus2> slots;
            decoded = wire::slot_status_change(p, n, slots);
            if (decoded && onSlots) onSlots(slots);
        } else if (m->get_method() == kMapStatusChange) {
            MapStatusTransition t;
            decoded = wire::map_status_change(p, n, c, t);
            if (decoded && onMapStatus) onMapStatus(c, t);
        } else if (m->get_method() == kFetchStatusChange) {
            uint32_t s;
            decoded = wire::fetch_status_change(p, n, c, s);
            if (decoded && onFetchStatus) onFetchStatus(c, s);
        }
        if (!decoded && onUndecoded) onUndecoded(m->get_method(), p, n);
        break;
    }
    case vsomeip::message_type_e::MT_RESPONSE:
    case vsomeip::message_type_e::MT_ERROR: {
        if (m->get_method() == kHeartbeat) {
            onHeartbeatReply(m, n);
            break;
        }
        uint32_t status = 0;
        bool ok = m->get_message_type() == vsomeip::message_type_e::MT_RESPONSE &&
                  m->get_return_code() == vsomeip::return_code_e::E_OK &&
                  wire::status_reply(p, n, status);
        if (onReply) onReply(m->get_method(), ok, status);
        break;
    }
    default:
        break;
    }
}

// Sends heartbeat(clientID, counter, CLOCK_MONOTONIC ns) while Dcsm2 is
// available and heartbeatGate (when set) allows, the counter counting up
// from 0, as HmiMain3D does.
void Client::heartbeatLoop() {
    uint32_t counter = 0;
    bool held = false;   // the gate held the last heartbeat
    while (running_) {
        const bool allowed = available_ && (!heartbeatGate || heartbeatGate());
        if (available_ && !allowed) held = true;
        if (allowed) {
            bool request = false;
            if (heartbeatMode_ == HeartbeatMode::kRequest) {
                std::lock_guard<std::mutex> l(hbMutex_);
                // After a held stretch the last reply is old for want of
                // heartbeats, not of answers: no silence before one is due.
                if (held) hb_.resumed(steady_ms());
                request = !hb_.refused();
                if (request) hb_.sent(steady_ms());
            }
            held = false;
            send(kHeartbeat, wire::heartbeat(clientHandle_, counter++, monotonic_ns()), request);
            if (request) checkHeartbeatSilence();
        }
        std::this_thread::sleep_for(kHeartbeatPeriod);
    }
}

HeartbeatStats Client::heartbeatStats() const {
    std::lock_guard<std::mutex> l(hbMutex_);
    return hb_.stats(steady_ms());
}

void Client::onHeartbeatReply(const std::shared_ptr<vsomeip::message> &m, size_t length) {
    std::lock_guard<std::mutex> report(hbReportMutex_);
    HeartbeatReport r;
    bool tell;
    {
        std::lock_guard<std::mutex> l(hbMutex_);
        tell = hb_.reply(steady_ms(), uint8_t(m->get_message_type()), uint8_t(m->get_return_code()),
                         length, &r);
    }
    if (tell && onHeartbeat) onHeartbeat(r);
}

void Client::checkHeartbeatSilence() {
    std::lock_guard<std::mutex> report(hbReportMutex_);
    HeartbeatReport r;
    bool tell;
    {
        std::lock_guard<std::mutex> l(hbMutex_);
        tell = hb_.check(steady_ms(), &r);
    }
    if (tell && onHeartbeat) onHeartbeat(r);
}

// HeartbeatTracker is in heartbeat_tracker.cpp (host-tested without vsomeip).

}  // namespace dcsm
