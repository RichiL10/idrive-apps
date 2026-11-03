/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Dcsm2 on the unit's vsomeip (../dcsm/dcsm_client.h): sends
 * Dcsm2Port's requests, runs the heartbeat, and queues what vsomeip's
 * thread receives for the render thread, which hands it to the port in the
 * order it came (drain). The identity is the one proven on the car
 * (README.md "Identity and packaging"): uid hmi_5000, the unit's own
 * /etc/vsomeip, vsomeip application "cluster-demo", clientID "\0cluster". */
#ifndef CRS_DCSM2_LINK_H
#define CRS_DCSM2_LINK_H

#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "dcsm2_port.h"
#include "liveness.h"

namespace dcsm { class Client; }
namespace vsomeip_v3 { class application; }

namespace crs {

class Dcsm2Link : public Dcsm2Wire {
public:
    struct Options {
        std::string app_name = "cluster-demo";
        uint64_t client_handle = 0;      /* 0: dcsm::kDefaultClientHandle */
        bool heartbeat_replies = true;   /* heartbeats as requests, replies checked */
    };

    Dcsm2Link();
    ~Dcsm2Link() override;

    bool start(const Options &o, std::string *err);
    void stop();

    /* The render loop made progress: called once per iteration. With no call
     * for Liveness::kStallMs the heartbeats stop (liveness.h), so the
     * KOMBI's watchdog takes a frozen map off the cluster; they go again
     * with the next call. */
    void beat(int64_t now_ms) { liveness_.beat(now_ms); }

    /* Readable when something is queued; then drain() on the render thread. */
    int fd() const { return wake_[0]; }
    void drain(Dcsm2Port *port, int64_t now_ms);

    void fetch(uint64_t scene) override;
    void map(uint64_t scene, uint32_t content_class, uint64_t slot) override;
    void unmap(uint64_t scene) override;
    void unmap_as(uint64_t client_handle, uint64_t scene) override;
    void unfetch(uint64_t scene) override;
    void slots() override;

private:
    struct Event {
        enum Kind { Availability, Reply, Fetch, Map, Slots, Heartbeat, Undecoded, Subscription } kind;
        explicit Event(Kind k) : kind(k) {}
        bool up = false, ok = false;
        uint16_t method = 0;                /* Undecoded, Subscription: the event id */
        uint32_t status = 0, initial = 0;   /* Undecoded: the length; Subscription: the code */
        std::string text;
        uint64_t scene = 0;
        std::vector<SlotInfo> slots;
    };
    void push(Event e);

    std::shared_ptr<vsomeip_v3::application> app_;
    std::unique_ptr<dcsm::Client> client_;
    std::thread loop_;
    bool heartbeat_replies_ = true;
    Liveness liveness_;
    bool stalled_ = false;   /* heartbeats held for a stalled loop (heartbeat thread) */
    int wake_[2] = {-1, -1};
    std::mutex mutex_;
    std::deque<Event> events_;
};

}  // namespace crs

#endif
