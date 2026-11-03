// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
// Client for the KOMBI's display-slot manager, de.bmw.infotainment.dcsm.Dcsm2
// (SOME/IP service 0xB05F, instance 1, interface version 1.0), on the head
// unit's libvsomeip3. Protocol and evidence: DCSM.md.
#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <vsomeip/vsomeip.hpp>

namespace dcsm {

constexpr vsomeip::service_t kService = 0xB05F;
constexpr vsomeip::instance_t kInstance = 0x0001;
constexpr vsomeip::major_version_t kMajor = 1;
constexpr vsomeip::eventgroup_t kEventgroup = 1;

constexpr vsomeip::method_t kReqFetchContent = 0x0001;
constexpr vsomeip::method_t kReqMapContent = 0x0002;
constexpr vsomeip::method_t kReqUnfetchContent = 0x0003;
constexpr vsomeip::method_t kReqUnmapContent = 0x0004;
constexpr vsomeip::method_t kHeartbeat = 0x0005;
constexpr vsomeip::method_t kReqSlotStatusUpdate = 0x0006;
constexpr vsomeip::event_t kFetchStatusChange = 0x8007;
constexpr vsomeip::event_t kMapStatusChange = 0x8008;
constexpr vsomeip::event_t kSlotStatusChange = 0x8009;

// The clientID (DcsmClientHandle) this tool sends; HmiMain3D sends 1.
constexpr uint64_t kDefaultClientHandle = 0x00636c7573746572;  // "\0cluster"

// HmiMain3D's heartbeat cadence (4 Hz on the car's trace).
constexpr std::chrono::milliseconds kHeartbeatPeriod{250};
// With HeartbeatMode::kRequest, no reply for this long is reported as
// HeartbeatReport::kSilent. The KOMBI unfetches a client's content after
// about 10 s without a heartbeat or request from it (DCSM.md "Heartbeat").
constexpr std::chrono::milliseconds kHeartbeatSilence{2000};

// How heartbeats travel; the payload is the same either way.
//  - kFireAndForget: REQUEST_NO_RETURN, as HmiMain3D sends them.
//  - kRequest: an ordinary REQUEST. The KOMBI's Dcsm2 stub answers it with an
//    empty E_OK RESPONSE once it has queued the heartbeat for its watchdog,
//    so each reply shows that a heartbeat with this client's handle reached
//    the KOMBI. After a refusal (HeartbeatReport::kRefused) the client sends
//    fire and forget until Dcsm2 next becomes available.
enum class HeartbeatMode { kFireAndForget, kRequest };

struct HeartbeatStats {
    uint32_t sent = 0;          // heartbeat requests since Dcsm2 became available
    uint32_t replies = 0;       // replies to them
    uint32_t badReplies = 0;    // of which E_OK RESPONSEs with a body
    int64_t sinceReplyMs = -1;  // since the last reply; -1: none yet
};

// What the client noticed about heartbeat replies (HeartbeatMode::kRequest).
struct HeartbeatReport {
    enum Event {
        kFirstReply,  // the first empty E_OK reply since Dcsm2 became available
        kResumed,     // a reply after kSilent; stats.sinceReplyMs is the gap
        kBadReply,    // the first E_OK RESPONSE with a body; later ones are
                      // only counted (stats.badReplies)
        kRefused,     // an ERROR, or a RESPONSE whose return code is not E_OK:
                      // the KOMBI did not take the request, so heartbeats
                      // go fire and forget from here on
        kSilent,      // no reply for kHeartbeatSilence, since the last reply
                      // or, with none yet, since the first request
    } event;
    HeartbeatStats stats;
    // The reply's (kSilent: none).
    uint8_t messageType = 0;
    uint8_t returnCode = 0;
    uint32_t length = 0;
};

// HeartbeatMode::kRequest's bookkeeping, at times given in ms, between two
// availabilities of Dcsm2. Not thread-safe; Client serialises it.
class HeartbeatTracker {
public:
    void sent(int64_t nowMs);
    // Heartbeats go again after the caller's gate held some: no silence is
    // reported until kHeartbeatSilence after nowMs.
    void resumed(int64_t nowMs);
    // A reply came; true if *r is to be reported.
    bool reply(int64_t nowMs, uint8_t messageType, uint8_t returnCode, size_t length,
               HeartbeatReport *r);
    // true, once per silence, if no reply came for kHeartbeatSilence.
    bool check(int64_t nowMs, HeartbeatReport *r);
    bool refused() const { return refused_; }
    HeartbeatStats stats(int64_t nowMs) const;

private:
    uint32_t sent_ = 0, replies_ = 0, badReplies_ = 0;
    int64_t firstSentMs_ = -1, lastReplyMs_ = -1;
    int64_t quietFromMs_ = -1;  // the gate last let heartbeats go again
    bool answered_ = false;     // an empty E_OK reply came
    bool silent_ = false;       // kSilent reported, no reply since
    bool badReported_ = false;  // kBadReply reported
    bool refused_ = false;      // kRefused reported
};

// DcsmTypes enums, values from the interface catalogue. Each travels as a
// big-endian UInt32; a value outside the list is passed on as received.
enum EDcsm2Status : uint32_t {
    E_DCSM_OK = 0,
    E_DCSM_HANDLE_UNKNOWN = 1,
    E_DCSM_REQUESTID_UNKNOWN = 2,
    E_DCSM_REQUESTID_INUSE = 3,
    E_DCSM_CONTENTID_UNKNOWN = 4,
    E_DCSM_SLOTID_UNKNOWN = 5,
    E_DCSM_PRIOTOOLOW = 6,
    E_DCSM_CONTENT_ALREADYMAPPED = 7,
    E_DCSM_CLIENT_ALREADYREGISTERED = 8,
};
enum EFetchStatus : uint32_t {
    E_FETCH_STATUS_FAILED = 0,
    E_FETCH_STATUS_FETCHING = 1,
    E_FETCH_STATUS_FETCHED = 2,
    E_FETCH_STATUS_REMOVED = 3,
};
enum EMapStatus2 : uint32_t {
    E_MAP_STATUS_UNMAPPED = 0,
    E_MAP_STATUS_MAPPED_FOREGROUND = 1,
    E_MAP_STATUS_MAPPED_BACKGROUND = 2,
    E_MAP_STATUS_MAPPED_INVISIBLE = 3,
};
enum ESlotStatus : uint32_t {
    E_SLOT_STATUS_DISABLED = 0,
    E_SLOT_STATUS_AVAILABLE = 1,
    E_SLOT_STATUS_OCCUPIED = 2,
};

// The catalogue's name for an EDcsm2Status ("E_DCSM_PRIOTOOLOW"), or
// "UNKNOWN(<n>)".
std::string status_name(uint32_t status);

struct ContentId2 {
    uint64_t sceneId = 0;
    uint32_t elementTag = 0;
};
inline bool operator==(const ContentId2 &a, const ContentId2 &b) {
    return a.sceneId == b.sceneId && a.elementTag == b.elementTag;
}

struct MapStatusTransition {
    uint32_t initial = 0;  // EMapStatus2
    uint32_t final_ = 0;   // EMapStatus2 ("final" in the IDL)
    uint64_t startTime = 0;
    uint64_t endTime = 0;
    uint32_t hint = 0;
};

struct MappingInfo {
    ContentId2 contentId;
    uint32_t contentClass = 0;
    uint32_t mapStatus = 0;  // EMapStatus2
};

struct SlotStatus2 {
    uint64_t slotId = 0;
    uint32_t slotStatus = 0;  // ESlotStatus
    MappingInfo mappingInfo;
};

// CommonAPI SOME/IP encoding of the Dcsm2 payloads: big-endian, no padding,
// no struct length fields, enums as UInt32, SlotStatusList2 with a 4-byte
// byte-length prefix. Decoders return false on a malformed payload.
namespace wire {
std::vector<uint8_t> content_request(uint64_t client, const ContentId2 &c);  // fetch/unfetch/unmap
std::vector<uint8_t> map_request(uint64_t client, const ContentId2 &c, uint32_t contentClass,
                                 uint64_t slotId);
std::vector<uint8_t> heartbeat(uint64_t client, uint32_t counter, uint64_t timestamp);
bool status_reply(const uint8_t *p, size_t n, uint32_t &status);
bool fetch_status_change(const uint8_t *p, size_t n, ContentId2 &c, uint32_t &status);
bool map_status_change(const uint8_t *p, size_t n, ContentId2 &c, MapStatusTransition &t);
bool slot_status_change(const uint8_t *p, size_t n, std::vector<SlotStatus2> &slots);
}  // namespace wire

class Client {
public:
    // app: an initialised vsomeip application. Construct and start() the
    // client before app->start().
    Client(std::shared_ptr<vsomeip::application> app, uint64_t clientHandle = kDefaultClientHandle,
           HeartbeatMode heartbeatMode = HeartbeatMode::kFireAndForget);
    ~Client();
    Client(const Client &) = delete;
    Client &operator=(const Client &) = delete;

    // Callbacks run on vsomeip's dispatch thread. Set them before start().
    std::function<void(bool available)> onAvailability;
    std::function<void(const std::vector<SlotStatus2> &)> onSlots;
    std::function<void(const ContentId2 &, const MapStatusTransition &)> onMapStatus;
    std::function<void(const ContentId2 &, uint32_t fetchStatus)> onFetchStatus;
    // The reply to fetch/map/unmap/unfetch, by method id (kReqFetchContent,
    // ...). ok is false for a SOME/IP error or malformed reply; status is
    // the EDcsm2Status otherwise.
    std::function<void(vsomeip::method_t request, bool ok, uint32_t status)> onReply;
    // A notification that did not decode: one of the three events with a
    // payload its decoder (wire::) refuses, or another event id. p and n are
    // the payload, valid during the call.
    std::function<void(vsomeip::event_t event, const uint8_t *p, size_t n)> onUndecoded;
    // vsomeip's answer to the eventgroup's subscription, per event it names
    // (kFetchStatusChange, kMapStatusChange, kSlotStatusChange, or any other
    // id it reports, ANY_EVENT for the eventgroup as a whole): code 0x00
    // accepted, otherwise refused (0x07 for a SUBSCRIBE_NACK). Each
    // subscription vsomeip makes again, as when Dcsm2 comes back, is
    // answered again.
    std::function<void(vsomeip::event_t event, uint16_t code)> onSubscription;
    // HeartbeatMode::kRequest: the first reply, the first bad reply, a
    // refusal, silences and their end; not every reply. Reports come one at a
    // time and in order, on vsomeip's dispatch thread (kSilent on the
    // heartbeat thread). Heartbeat replies never reach onReply.
    std::function<void(const HeartbeatReport &)> onHeartbeat;
    // Asked on the heartbeat thread before each heartbeat; false: that one
    // is not sent. A caller whose own loop has stalled stops its heartbeats
    // this way, so the KOMBI's watchdog drops its content (DCSM.md
    // "Heartbeat"). Unset: every heartbeat goes. Set it before start().
    std::function<bool()> heartbeatGate;

    // Heartbeat requests and replies since Dcsm2 became available (all zero
    // with HeartbeatMode::kFireAndForget). Any thread.
    HeartbeatStats heartbeatStats() const;

    void start();
    void stop();

    // Requests sent while Dcsm2 is unavailable are dropped by vsomeip; wait
    // for onAvailability(true).
    void fetch(const ContentId2 &c);
    void map(const ContentId2 &c, uint32_t contentClass, uint64_t slotId);
    void unmap(const ContentId2 &c);
    // An unmap sent with another client's handle: the KOMBI unmaps that
    // client's content (DCSM.md "Taking over from the stock HMI").
    void unmapAs(uint64_t clientHandle, const ContentId2 &c);
    void unfetch(const ContentId2 &c);
    // Asks for slotStatusChange; sent automatically on availability.
    void requestSlotStatus();

private:
    void send(vsomeip::method_t method, const std::vector<uint8_t> &payload, bool expectReply);
    void onMessage(const std::shared_ptr<vsomeip::message> &m);
    void onAvailable(bool available);
    void heartbeatLoop();
    void onHeartbeatReply(const std::shared_ptr<vsomeip::message> &m, size_t length);
    void checkHeartbeatSilence();

    std::shared_ptr<vsomeip::application> app_;
    uint64_t clientHandle_;
    HeartbeatMode heartbeatMode_;
    std::atomic<bool> available_{false};
    // Reset when Dcsm2 becomes available, at steady-clock ms.
    HeartbeatTracker hb_;
    mutable std::mutex hbMutex_;    // hb_
    std::mutex hbReportMutex_;      // a tracker decision and its onHeartbeat
    std::atomic<bool> running_{false};
    std::thread heartbeat_;
};

}  // namespace dcsm
