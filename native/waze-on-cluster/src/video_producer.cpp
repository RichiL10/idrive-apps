// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "video_producer.h"

#include <cstdio>
#include <fcntl.h>
#include <time.h>
#include <unistd.h>

#include "log.h"
#include "yuv_atlas.h"

namespace woc {

using crk::atlas_height;

namespace {

int64_t now_us()
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

int64_t wall_ms()
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

enum Source { kAvb = 1, kUdp = 2 };
const char *source_name(int s) { return s == kAvb ? "avb" : "udp"; }

}  // namespace

VideoProducer::VideoProducer(const VideoConfig &cfg)
    : cfg_(cfg), atlas_bytes_((size_t)cfg.tex_width * atlas_height(cfg.tex_height)),
      change_(cfg.tex_width, cfg.tex_height), freeze_(cfg.freeze)
{
    rtp_sink_ = [this](const uint8_t *d, size_t n, bool end_of_au) { on_nal(d, n, end_of_au); };
    rtp_.on_gap = [this](const RtpH264::Gap &g) { gaps_.gap(g, packet_->source, packet_->dropped); };
    if (pipe2(ready_, O_NONBLOCK | O_CLOEXEC) < 0)
        ready_[0] = ready_[1] = -1;
    decode_thread_ = std::thread(&VideoProducer::decode_loop, this);
    /* The sources listen, and decode (the warm decoder, header), for the
     * whole service lifetime: the stream starts when the phone connects, and
     * its only keyframes are at that start. Which source carries packets is
     * the patch's capture mode; the render listens on all of them. */
    join_avb();
    if (cfg_.udp_port != 0) {
        std::string uerr;
        char line[160];
        if (udp_source_.start(cfg_.udp_port, [this](const uint8_t *d, size_t n) { receive(d, n, kUdp); }, &uerr)) {
            udp_up_ = true;
            std::snprintf(line, sizeof line, "udp: listening on 127.0.0.1:%u", (unsigned)cfg_.udp_port);
        } else {
            std::snprintf(line, sizeof line, "udp: bind 127.0.0.1:%u FAILED: %.100s", (unsigned)cfg_.udp_port, uerr.c_str());
            log_warn("udp: %s (udp:// capture mode unavailable; fifo still works)", uerr.c_str());
        }
        udp_status_ = line;
    } else {
        udp_status_ = "udp: disabled (udp_port=0)";
    }
    open_fifo();
}

VideoProducer::~VideoProducer()
{
    if (avb_up_) { avb_source_.stop(); avb_up_ = false; }
    if (udp_up_) { udp_source_.stop(); udp_up_ = false; }
    queue_.close();
    decode_thread_.join();
    if (fifo_up_) { source_.stop(); fifo_up_ = false; }
    std::lock_guard<std::mutex> lock(decode_mutex_);
    if (decoder_up_) { decoder_.shutdown(); decoder_up_ = false; }
    for (int fd : ready_)
        if (fd >= 0)
            close(fd);
}

void VideoProducer::join_avb()
{
    if (cfg_.avb_stream.empty()) {
        avb_status_ = "avb: disabled (avb_stream empty)";
        return;
    }
    std::string aerr;
    char line[256];
    if (avb_source_.start(cfg_.avb_stream, [this](const uint8_t *d, size_t n) { receive(d, n, kAvb); }, &aerr)) {
        avb_up_ = true;
        std::snprintf(line, sizeof line, "avb: joined %.200s", cfg_.avb_stream.c_str());
    } else {
        std::snprintf(line, sizeof line, "avb: join %.120s FAILED: %.80s", cfg_.avb_stream.c_str(), aerr.c_str());
        if (avb_status_ != line)
            log_warn("avb: %s (retrying every second; udp/fifo still work)", aerr.c_str());
    }
    avb_status_ = line;
}

void VideoProducer::open_fifo()
{
    if (cfg_.fifo_path.empty()) {
        fifo_status_ = "fifo: disabled (fifo_path empty)";
        return;
    }
    std::string ferr;
    char line[256];
    if (source_.start(cfg_.fifo_path, cfg_.carplay_group, [this](const uint8_t *d, size_t n) { feed_fifo(d, n); },
                      &ferr)) {
        fifo_up_ = true;
        std::snprintf(line, sizeof line, "fifo: reading %.200s", cfg_.fifo_path.c_str());
    } else {
        std::snprintf(line, sizeof line, "fifo: open %.120s FAILED: %.100s", cfg_.fifo_path.c_str(), ferr.c_str());
        if (fifo_status_ != line)
            log_warn("fifo: %s (retrying every second; avb/udp still work)", ferr.c_str());
    }
    fifo_status_ = line;
}

void VideoProducer::retry_sources(int64_t now_ms)
{
    if (now_ms < source_retry_ms_)
        return;
    source_retry_ms_ = now_ms + 1000;
    if (!avb_up_ && !cfg_.avb_stream.empty())
        join_avb();
    if (!fifo_up_ && !cfg_.fifo_path.empty())
        open_fifo();
}

/* Source states, the depacketiser and decoder state, then the framing once
 * a packet arrives — so the car test can see we are listening even before
 * (or without) any bytes. */
std::string VideoProducer::probe_report() const
{
    std::string r = avb_status_ + "\n" + udp_status_ + "\n" + fifo_status_ + "\n";
    char wait[96] = "";
    if (const int64_t w = keyframe_wait_ms(cld::now_ms()))
        std::snprintf(wait, sizeof wait, "; the stream arrives with no keyframe and nothing decoded for %lld s",
                      (long long)(w / 1000));
    crk::Spread pack, vpp;
    {
        std::lock_guard<std::mutex> lock(decode_mutex_);
        pack = decoder_.pack_us();
        vpp = decoder_.vpp_us();
        const RtpH264::Stats &st = rtp_.stats();
        char line[640];
        std::snprintf(line, sizeof line,
                      "rtp: packets=%llu nals=%llu aus=%llu seq_gaps=%llu lost=%llu dropped=%llu bad=%llu late=%llu "
                      "streams=%llu stray=%llu fu_overflows=%llu framing_overflows=%llu idle_resets=%llu\n"
                      "queue: %llu dropped, at most %zu of %zu packets waiting, %zu KB held\n"
                      "decoder: %s (%llu frames decoded)%s\n",
                      (unsigned long long)st.packets, (unsigned long long)st.nals, (unsigned long long)st.aus,
                      (unsigned long long)st.gaps, (unsigned long long)st.lost, (unsigned long long)st.dropped,
                      (unsigned long long)st.bad, (unsigned long long)st.late, (unsigned long long)st.streams,
                      (unsigned long long)st.stray, (unsigned long long)st.overflows,
                      (unsigned long long)decoder_.buffer_overflows(), (unsigned long long)st.idle_resets,
                      (unsigned long long)queue_.overflows(), queue_.high_water(),
                      kQueuePackets, queue_.held_bytes() / 1024,
                      !decoder_up_ ? "waiting for the stream's first SPS" : decoding_ ? "up" : "waiting for a keyframe",
                      (unsigned long long)decoded_total_.load(), wait);
        r += line;
    }
    {
        std::lock_guard<std::mutex> lock(frame_mutex_);
        char line[512];
        std::snprintf(line, sizeof line,
                      "vpp: %lld us a picture (max %lld) waiting for VPP, the copy to system memory included, "
                      "and for its decode unless src_crop's check waited for it\n"
                      "packing: %u bits a level, %lld us a picture (max %lld) to compare with the last and pack; "
                      "%llu pictures the same as the last, not packed\n"
                      "backlog: the oldest packet waiting %lld ms, the longest wait %lld ms; %llu frames decoded "
                      "without a picture to catch up%s\n",
                      (long long)vpp.mean(), (long long)vpp.max, cfg_.tex_level_bits, (long long)pack.mean(),
                      (long long)pack.max,
                      (unsigned long long)same_total_,
                      (long long)(queue_.oldest_wait_us() / 1000), (long long)(backlog_.max_wait_us() / 1000),
                      (unsigned long long)backlog_.skipped_total(),
                      backlog_.behind(cld::now_ms()) ? "; the decoder is behind the stream" : "");
        r += line;
    }
    return r + probe_.report();
}

void VideoProducer::receive(const uint8_t *data, size_t len, int source)
{
    /* A frame's packets share their RTP timestamp. */
    bool frame_start = false;
    if (len >= 12 && (data[0] & 0xc0) == 0x80) {
        const int64_t ts = (int64_t)data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7];
        frame_start = ts != rtp_ts_[source];
        rtp_ts_[source] = ts;
    }
    queue_.push(data, len, source, frame_start);
}

void VideoProducer::decode_loop()
{
    PacketQueue::Packet p;
    while (!queue_.closed())
        if (queue_.pop(&p, 500))
            feed_datagram(p);
}

void VideoProducer::feed_datagram(const PacketQueue::Packet &p)
{
    {
        std::lock_guard<std::mutex> lock(frame_mutex_);
        const std::string line = backlog_.packet(cld::now_ms(), p.waited_us);
        if (!line.empty())
            log_warn("%s", line.c_str());
    }
    const uint8_t *data = p.data.data();
    const size_t len = p.data.size();
    /* RTP v2 starts 10xxxxxx; Annex-B starts with a zero byte. */
    if (len >= 12 && (data[0] & 0xc0) == 0x80) {
        probe_.record_rtp(data, len);
        std::lock_guard<std::mutex> lock(decode_mutex_);
        packet_ = &p;
        const uint64_t before = rtp_.stats().overflows;
        /* When it arrived, not when it was taken off the queue: a decoder
         * running behind is not silence on the wire. */
        rtp_.arrival(cld::now_ms() - (int64_t)(p.waited_us / 1000), rtp_sink_);
        rtp_.push(data, len, rtp_sink_);
        packet_ = nullptr;
        if (const uint64_t n = rtp_.stats().overflows - before) {
            std::lock_guard<std::mutex> flock(frame_mutex_);
            const std::string line = health_.overflow(cld::now_ms(), "RTP fragment buffer (FU-A)", (uint32_t)n);
            if (!line.empty())
                log_warn("%s", line.c_str());
        }
        return;
    }
    feed_fifo(data, len);
}

void VideoProducer::feed_fifo(const uint8_t *data, size_t len)
{
    probe_.record(data, len);
    std::lock_guard<std::mutex> lock(decode_mutex_);
    if (!decoder_up_) {
        /* Raw Annex-B arrives in arbitrary chunks, so the decoder comes up at
         * the first bytes and drops what precedes the SPS itself. A failed
         * start is retried with later bytes, at most once a second. */
        const int64_t now = cld::now_ms();
        if (now < raw_retry_ms_)
            return;
        std::string err;
        if (!start_decoder(&err)) {
            raw_retry_ms_ = now + 1000;
            log_warn("waze: decoder start failed: %s", err.c_str());
            return;
        }
        log_info("waze: stream started, decoder up");
    }
    decode(data, len, false);
}

void VideoProducer::on_nal(const uint8_t *data, size_t len, bool end_of_au)
{
    if (len > 0) {
        probe_.nal(data[4]);
        const GapSettler::Outcome o = gaps_.nal(data[4] & 0x1f);
        if (o != GapSettler::None) {
            const RtpH264::Gap &g = gaps_.settled();
            const char *src = source_name(gaps_.source());
            std::lock_guard<std::mutex> lock(frame_mutex_);
            const std::string line = o == GapSettler::NewStream
                                         ? health_.new_stream(cld::now_ms(), src, g.expected, g.got)
                                         : health_.loss(cld::now_ms(), wall_ms(), src, g.expected, g.got, g.lost,
                                                        gaps_.dropped());
            if (!line.empty())
                log_warn("%s", line.c_str());
        }
    } else {
        gaps_.au_end();   /* decode() below delivers its frame */
    }
    if (!decoder_up_) {
        /* The stream starts at its SPS; nothing before it decodes. A failed
         * start is retried at the next SPS. */
        if (len == 0 || (data[4] & 0x1f) != 7)
            return;
        std::string err;
        if (!start_decoder(&err)) {
            log_warn("waze: decoder start failed: %s", err.c_str());
            return;
        }
        log_info("waze: stream started, decoder up");
    }
    decode(data, len, end_of_au);
}

bool VideoProducer::start_decoder(std::string *err)
{
    if (!decoder_.init(cfg_.drm_device.c_str(), cfg_.tex_width, cfg_.tex_height, cfg_.tex_level_bits, cfg_.gpu_copy, err,
                       cfg_.src_crop)) {
        std::lock_guard<std::mutex> flock(frame_mutex_);
        last_err_ = *err;
        decode_errs_++;
        return false;
    }
    decoder_up_ = true;
    return true;
}

void VideoProducer::decode(const uint8_t *data, size_t len, bool end_of_au)
{
    std::string derr;
    const uint64_t overflows_before = decoder_.buffer_overflows();
    const bool ok = decoder_.feed(data, len, [this](const VideoFrame &f) { on_frame(f); }, &derr, end_of_au,
                                  !(packet_ && packet_->later_frame));
    if (const uint64_t n = decoder_.buffer_overflows() - overflows_before) {
        std::lock_guard<std::mutex> flock(frame_mutex_);
        const std::string line = health_.overflow(cld::now_ms(), "decoder's NAL/access unit buffer", (uint32_t)n);
        if (!line.empty())
            log_warn("%s", line.c_str());
    }
    const bool decoding = decoder_.decoding();
    if (ok && decoding == decoding_)
        return;
    std::lock_guard<std::mutex> flock(frame_mutex_);
    if (!ok) {
        last_err_ = derr;
        decode_errs_++;
    }
    if (decoding != decoding_) {
        const std::string line = health_.waiting(cld::now_ms(), wall_ms(), !decoding);
        if (!decoding)
            log_warn("waze: the decoder gave up its sequence (%s)", derr.c_str());
        else if (!line.empty())
            log_info("%s", line.c_str());
    }
    decoding_ = decoding;
}

void VideoProducer::on_frame(const VideoFrame &f)
{
    if (!f.atlas && !f.same) {
        std::lock_guard<std::mutex> lock(frame_mutex_);
        const std::string line = health_.frame(cld::now_ms(), f.corrupted, gaps_.after_loss());
        if (!line.empty())
            log_info("%s", line.c_str());
        backlog_.skipped();
        if (f.w == cfg_.tex_width && f.h == cfg_.tex_height)
            last_frame_ms_ = now_us() / 1000;
        decoded_total_++;
        return;
    }
    /* the atlas starts with the luma plane; the same picture again has not
     * changed and is as blank as it was */
    const bool sized = f.w == cfg_.tex_width && f.h == cfg_.tex_height;
    const bool changed = sized && f.atlas && change_.changed(f.atlas->data());
    std::lock_guard<std::mutex> lock(frame_mutex_);
    const std::string line = health_.frame(cld::now_ms(), f.corrupted, gaps_.after_loss());
    if (!line.empty())
        log_info("%s", line.c_str());
    if (sized) {
        const int64_t now = now_us() / 1000;
        freeze_.frame(now, changed, change_.blank());
        tally_.frame(now, changed, change_.blank());
        last_frame_ms_ = now;
    }
    if (!back_dirty_ && !repeat_ && ready_[1] >= 0) {
        const char b = 1;
        ssize_t w = write(ready_[1], &b, 1);
        (void)w;
    }
    if (f.atlas) {
        /* The decoder's buffer becomes the newest frame and the replaced one
         * goes back to the decoder. */
        back_.swap(*f.atlas);
        back_w_ = f.w;
        back_h_ = f.h;
        back_dirty_ = true;
        repeat_ = false;
    } else {
        same_total_++;
        repeat_ = !back_dirty_;   /* a frame still to be taken is this picture */
    }
    back_id_ = decoded_total_.fetch_add(1) + 1;
}

bool VideoProducer::take(std::vector<uint8_t> *frame, uint64_t *id, bool *same)
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    *same = !back_dirty_;
    if (back_dirty_ && back_w_ == cfg_.tex_width && back_h_ == cfg_.tex_height)
        frame->swap(back_);
    else if (!repeat_)
        return false;
    *id = back_id_;
    back_dirty_ = repeat_ = false;
    char drain[8];
    while (ready_[0] >= 0 && read(ready_[0], drain, sizeof drain) > 0) {
    }
    return true;
}

void VideoProducer::set_live(bool on, int64_t now_ms)
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    freeze_.live(on, now_ms);
}

bool VideoProducer::frozen(int64_t now_ms) const
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    return freeze_.frozen(now_ms);
}

Picture VideoProducer::picture(int64_t now_ms) const
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    return freeze_.picture(now_ms);
}

uint32_t VideoProducer::decode_errors(std::string *last) const
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    *last = last_err_;
    return decode_errs_;
}

bool VideoProducer::minute(int64_t now_ms, FrameTally::Minute *m, StreamHealth::Minute *s, Backlog::Minute *b,
                           uint64_t *overflows)
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    if (!tally_.take(now_ms, m))
        return false;
    *s = health_.take_minute();
    *b = backlog_.take_minute();
    const uint64_t o = queue_.overflows();
    *overflows = o - overflows_seen_;
    overflows_seen_ = o;
    return true;
}

std::string VideoProducer::stream_reason() const
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    return health_.reason();
}

std::string VideoProducer::stream_detail() const
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    return health_.detail();
}

bool VideoProducer::stream_lost() const
{
    std::lock_guard<std::mutex> lock(frame_mutex_);
    return health_.lost();
}

void VideoProducer::track_keyframe_wait(int64_t now_ms)
{
    keyframe_wait_.sample(now_ms, source_.bytes() + udp_source_.packets() + avb_source_.packets(),
                          decoded_total_.load(), probe_.keyframes());
    std::lock_guard<std::mutex> lock(frame_mutex_);
    health_.keyframe_wait(wall_ms(), keyframe_wait_.wait_ms(now_ms));
}

/* "123 B" / "45 KB" / "6.7 MB", for the status line. */
static void human_bytes(uint64_t n, char *out, size_t cap)
{
    if (n < 1024) std::snprintf(out, cap, "%llu B", (unsigned long long)n);
    else if (n < 1024 * 1024) std::snprintf(out, cap, "%llu KB", (unsigned long long)(n / 1024));
    else std::snprintf(out, cap, "%.1f MB", (double)n / (1024.0 * 1024.0));
}

std::string VideoProducer::decode_status() const
{
    /* The capture and decode side of the status line: the bytes captured
     * (from whichever sink the patch points at), frames decoded and the last
     * decode error; while nothing decodes, the framing probe's read of the
     * wire says whether the capture, the framing or the decoder is at fault. */
    const uint64_t total = source_.bytes() + udp_source_.bytes() + avb_source_.bytes();
    const bool receiving = source_.bytes() > 0 || udp_source_.packets() > 0 || avb_source_.packets() > 0;
    char bytes[24];
    human_bytes(total, bytes, sizeof bytes);
    char errbuf[128] = "";
    {
        std::lock_guard<std::mutex> lock(frame_mutex_);
        if (!last_err_.empty())
            std::snprintf(errbuf, sizeof errbuf, " [%u decode err, last: %.70s]", decode_errs_, last_err_.c_str());
    }
    char s[320];
    if (decoded_total_.load() > 0)
        std::snprintf(s, sizeof s, "%s, %llu frames%s", bytes, (unsigned long long)decoded_total_.load(), errbuf);
    else if (receiving)
        std::snprintf(s, sizeof s, "receiving, not decoding (%s) — %.160s%s", bytes, probe_.summary().c_str(), errbuf);
    else
        std::snprintf(s, sizeof s, "waiting for CarPlay (%s)", bytes);
    return s;
}

}  // namespace woc
