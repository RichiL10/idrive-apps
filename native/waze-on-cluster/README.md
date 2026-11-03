# waze-on-cluster

Shows the CarPlay instrument-cluster map (Waze, Apple Maps or Google Maps)
on the instrument cluster of a BMW with an iDrive 7 head unit (MGU), which
the stock software does not do. It runs as root tools on the head unit and is
driven from the HMI by the companion app
[robertn_waze_cluster](../../apps/robertn_waze_cluster).

CarPlay sends the cluster map only as H.264 video, with no map data, so this
is a video pipeline:

1. **Ungate the second display.** A reversible patch to
   `/usr/bin/carplay` makes `KI_KOMBI_VARIANT` 7 resolve to a supported
   cluster variant, makes CarPlay start the cluster stream itself, and
   advertises the size the map is shown at ([patch/PATCH.md](patch/PATCH.md)).
2. **Capture.** CarPlay sends the stream as RTP to its stock media-bus sink,
   AVB stream `media_transport.avb_streaming.15`; the render joins it as an
   extra receiver, in-process. It also listens on a local UDP port and a FIFO,
   which other sink patches can point at.
3. **Decode.** The receive threads only queue each packet; one decode
   thread depacketises RTP to H.264 Annex B (`src/rtp_h264.*`) and decodes it
   with the unit's Intel Media SDK / VAAPI on `/dev/dri/renderD128` to the
   picture's own Y, U and V planes, through any lost packets ("Losses").
4. **Draw.** Each frame goes to the shared cluster renderer,
   [cluster-render](../cluster-render), as a
   video layer (`src/map_feed.*`). The renderer owns the RAMSES participant,
   the DCSM slots and one upload budget for all its clients.

## Install and remove

Install the app `robertn_waze_cluster` from the catalog of
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps)
through the [mgu Store](https://github.com/robertnisipeanu/mgu-store). The
app requires this tool (0.6.0); this tool requires `cluster-render` 0.3.3 and
`mgu-deploy` 0.7.0, the deploy tool version that runs activate and deactivate
hooks. Requirements resolve across catalog sources.

**Install.** The deploy tool runs `patchd.js activate` as root. On a proven
carplay build, or one Enable map patched before, it writes the patch Enable
map writes, keeps the running binary linked, and never stops,
kills or restarts CarPlay. The Store shows a restart pending; the app shows
`Patch pending — reboot to activate`. One head-unit start runs the patched
CarPlay and starts this tool's services. The hook leaves CarPlay as it is,
and the app says why and offers Enable map, when Disable map was used, when
the patcher cannot find or recognise one of its edit sites in the binary or
something else modified it, when the build is outside the proven list and
Enable map has not patched it, or when `carplay.service` starts another program.
An update brings an older patch of ours up to date.

**Remove.** In the Store, remove the app, then the tool (refused while the
app is installed). `patchd.js deactivate` reverts only our byte regions,
keeps other tools' edits and drops our backup; the deploy tool then removes
this tool's services and files. The renderer and the deploy tool stay. The
next head-unit start runs the original CarPlay. Details: PATCH.md
"Install-time activation".

## Using it

On the app's page, **Enable map** asks the root patch daemon `patchd` to
apply the patch and **Disable map** reverts it, which turns the feature off:
without the patch the phone sends no cluster stream. A change takes effect
when CarPlay next starts. `patchd` restarts CarPlay at once (SIGKILL, then
`systemctl start`) only where both of these keep that from restarting the
head unit (PATCH.md "Activation"); otherwise the app shows **Restart head
unit**, a normal system reboot:

- recmgr loaded `carplay` in both restart lists at this boot. The deploy
  tool writes it into both sections at install and takes it out at removal;
  recmgr reads the list at boot.
- systemd loaded the tool's drop-in
  `/etc/systemd/system/carplay.service.d/50-waze-on-cluster.conf`
  (`SuccessExitStatus=SIGKILL`), which the deploy tool installs and removes
  with the tool. Without it the SIGKILL fails `carplay.service`, whose
  `OnFailure=mediaddpserver_kill.service` sends `mediaddpserver` SIGQUIT;
  `mediaddpserver` dumps core, and recmgr and crashhandler, on neither of
  whose whitelists it is, restart the head unit.

With the drop-in loaded, any SIGKILL of CarPlay is a clean exit, also one
`patchd` did not send (the out-of-memory killer, a shell). `carplay.service`
does not start CarPlay again, so the recovery service does, where recmgr
loaded the entry: 5 s, 15 s and 60 s after it, at most three starts per
head-unit start together with those after a crash. Any other clean exit
stays as it is.

On a fresh install the patched CarPlay first runs at the next head-unit
start, which also loads the recmgr entry.

**When CarPlay crashes.** A crash (a core dump, or a watchdog timeout) fails
`carplay.service`, and the head unit restarts as above; neither the recmgr
entry nor the drop-in prevents it. The recovery service records the crash
at once, and a boot step that runs before CarPlay counts the crashed start
and, at the second crash of the patched CarPlay with no crash-free
head-unit start in between, restores the original binary before CarPlay
starts, so CarPlay comes back without the map until Enable map. Where
recmgr loaded the entry and the head unit stays up, the recovery service
also restores at the second crash and starts CarPlay again, at most three
times per head-unit start, 5 s, 15 s and 60 s after a crash. Details:
PATCH.md "Boot recovery".

To break a loop by hand: keep the phone from connecting (unplug it, or turn
off its Wi-Fi and Bluetooth) so CarPlay has no session to crash in, then over
SSH run `sh /var/opt/waze-on-cluster/current/woc-patch.sh revert` and
restart the head unit.

Set **Instrument cluster > Central display area** to **Map view**: the
cluster shows the stock map, the Waze map replaces it while CarPlay's cluster
stream is live and shows a map, and the stock map is back when the stream
ends or shows no map. **Off** works
too, with an empty centre instead of the stock map. With Route preview or
Assisted Driving View the cluster's own content takes the centre. After
changing the setting, CarPlay may need reconnecting before the map returns:
the change can freeze the phone's cluster stream (below).

Then connect the iPhone to CarPlay. Waze needs its server-side flag 1006 for
the alternate display. The phone sends SPS, PPS and an IDR only at the start
of a stream, so the render service runs from boot, joins the media bus at
once (retrying every second until the AVB bridge is up), and decodes from the
stream's first SPS whether or not the map is shown. The app need not be open.

The map comes up at the stream's first non-blank picture in the native
central-map slot `0x100` (scene `0x010004f0`, 1088x480), under the gauges,
and stays while the stream is live: while carplay holds the phone's
connection for the cluster stream, TCP port 6031 owned by carplay's uid
13002 in `/proc/net/tcp6`, however few frames come (how often a static map
sends a frame depends on the phone: one about every ten seconds, another
about 30 a second).
When that connection ends (the phone unplugged, the session or the stream
ended) the map is taken down at the next check, once a second, and the slot
returns to the cluster's own content; the next stream maps it again. No
frame for `idle_ms` (60 s) takes it down too. Without that connection
(carplay took another port) or if `/proc/net` cannot be read, a frame within
`stall_ms` (6 s) counts as live. That the phone keeps the connection through
a static map and closes it when the stream ends is still to be confirmed on
the car.

CarPlay starts the cluster stream as soon as the phone connects (PATCH.md
Edit 3), before any navigation app draws on the cluster, and the phone sends
a blank picture until one does: on the car about 100 blank frames in the
first 2 s, then nothing; in the field the map came once a route started in
Waze or Google Maps, and stayed after it ended. So the stock map stays until
the first non-blank picture, and the app shows `Waiting for the phone's map
— start navigation`. A picture that stays blank for `blank_ms` (10 s) after
a map gives the slot back to the stock map; the app then shows the same
line, or `Map frozen — reconnect CarPlay` when the blank frames keep coming
fast enough to be a frozen stream (see "A frozen stream" below). The next
non-blank picture takes the slot again. A map always draws something, so a
blank spell shorter than that keeps the map up, and the map never comes and
goes faster than once every `blank_ms`.

While the map is up, a session the cluster ends (the stock map taking the
slot back, a refusal, no answer) is started again after 2, 5, 10, 20, then
every 30 s. The app shows `Starting map…` while the renderer starts, and a
map error only when the renderer stays unreachable for 15 s.

A frozen stream, frames still coming (on the car 15-21 a second) but all the
same blank picture, is frozen after 10 s (`freeze_ms`, at least
`freeze_min_fps` 3 a second): the stock map shows (in Off, an empty centre)
and the app shows `Map frozen — reconnect CarPlay`, not `Waiting for the
phone's map — start navigation`. The map is down while the stream is frozen
or its picture has stayed blank for `blank_ms`, whichever comes first; with
both at 10 s they come together. The map is back with the next non-blank
picture. A stream that has shown no picture yet is frozen only after three
times as long (30 s), frames still coming: a phone starting its stream
sends the same blank picture for a couple of seconds and pauses. A stream
is CarPlay's cluster stream while it is live: its frames are those decoded
while it is live and those decoded at most 2 s before it became live (the
frame that made it live, or a first frame decoded before the connection
was read, which is read once a second). An older frame, such as the last
stream's still on its way after it ended, does not count. Blank: all but
one in a thousand of the sampled luma values within 17 levels. A static map
is never frozen, however many frames the phone sends: some phones send one
about every ten seconds, others keep their full rate.

A render that missed the stream's start decodes nothing until a new stream:
reconnect the phone.

**Losses.** The phone sends a keyframe only at the start of its stream, so
the render decodes through a lost packet:

- The AVB bridge's callback and the UDP reader only copy each packet into a
  queue of 4096 packets or 6 MB (about 4 s of the stream) and return; one
  decode thread depacketises and decodes them in order. Past the queue's
  headroom the oldest packets are dropped, and counted. A slot keeps a
  buffer of at most 2 KB once its packet is out, so large datagrams leave
  no memory behind. The receive threads run at nice -5 (the unit file's
  `LimitNICE`), the decode thread at the service's nice 0. The FIFO reader, a byte stream that holds its
  writer back, decodes on its own thread.
- Every frame is decoded, since each builds on the one before, but only the
  newest gets a picture. While a later frame's first packet (a new RTP
  timestamp) is already queued, the frames decoded meanwhile skip the
  picture: no scaling, packing, level rounding or hand-off. A decode slower
  than the phone's frame rate thus skips pictures instead of falling
  behind; the wait in the queue stays within about one picture's output
  and a few frames' decoding. A decoder slower than the stream even
  without the pictures is logged when every packet has waited over 200 ms
  for 5 s (`waze: the decoder is behind the stream: …`), and again when a
  packet waits under 100 ms (`waze: the decoder caught up with the stream
  after 37 s behind it (packets waited at most 2400 ms)`).
- A sequence gap drops only the NAL unit it cut (an FU-A); every slice after
  it goes to the decoder, which conceals what is missing. The frames are
  shown as decoded: the map can show smudges until the phone codes those
  areas again, and MSDK's per-frame `Corrupted` flags are counted. A decoder
  that has never started still waits for the stream's first SPS. Only
  30 access units in a row that fail to decode give the sequence up; the
  decoder then waits for a keyframe as at the start, until the next
  stream.
- A gap followed by an SPS is a new stream (the phone reconnected or
  CarPlay asked for a new one), logged as `waze: a new stream from avb
  (sequence 40000, expected 17)`, not a loss. Any other gap is a loss,
  logged with the jump, its source and whether the receive queue dropped
  it (`waze: lost 5 packets of the stream from avb (sequence 1240, expected
  1235); decoding through it`), and so are the first corrupted frame after
  it and the first clean one begun after it (`waze: the picture is clean
  again 150 ms after the loss at 12:39:50 (3 corrupted frames)`), at most
  10 such lines a minute.
- Decoding through a loss, the map shows and the status has no reason
  for it; `probe.txt`'s `stream:` line says `lost part of the stream at
  12:39:50; decoding through it` until that clean frame. The status's
  `reason`, which the app shows, is `Stream lost — reconnect CarPlay`
  while the stream arrives with nothing decoded for 2 s (a render started
  mid-stream, or a loss the decoder does not decode through) and while the
  decoder has given up its sequence. The detail, with when that began, is
  in the log (`waze: stream lost: the stream arrives with nothing decoded
  since 12:40:50`) and in `probe.txt`. A status line whose only change is
  the stream's reason is logged at most once every 10 s.

From a shell, `waze-on-cluster -c <conf> run map|panel|hud` (`sail` is an
alias of `map`) sets the target until the service restarts and prints the
status.

## Status and diagnostics

Once a second the render writes, in `/run/waze-on-cluster/` (mode 0644):
`status.json`, the status the app shows (`state` idle, starting, showing,
frozen or error; `page`; `reason`; the shared upload cap as `upload_cap_kb_per_s` and
why as `upload_reason`, also in the app's status event); `probe.txt`, the
sources, the depacketiser (`rtp: packets nals aus seq_gaps lost dropped bad
late streams fu_overflows framing_overflows`),
the receive queue (`queue: N dropped, at most M of 4096 packets waiting, K KB
held`), its backlog (`backlog: the oldest packet waiting N ms, the longest
wait M ms; K frames decoded without a picture to catch up`, with `; the
decoder is behind the stream` while it is), the stream (`stream: whole` or
the detail above), the decoder, the late-join verdict, the noise filter's
tile differences and the renderer's own status. `patchd` answers
`{"cmd":"logs"}` with CarPlay, AVB and DLT marker lines and its own log.

Every line the render logs also goes to
`/var/opt/waze-on-cluster/log/waze-on-cluster.log` (`log_file`) with its UTC
time, so it outlives the journal's few minutes on the unit, restarts and
reboots; past `log_file_kb` (512) the file becomes `waze-on-cluster.log.1`.
The service makes the directory, owned by `hmi_5000`, at each start; the
deploy tool removes it with the rest of `/var/opt/waze-on-cluster`. The log
has the status when its state, reason or target changes, each loss and a
decoder behind the stream (above), and once a minute while frames come, how
many were decoded, how many of those without a picture, changed and flagged
corrupted, whether the last picture was blank, the losses and the packets
they cost, the packets the receive queue dropped, and how long the decoded
packets waited in it:
`waze: 1840 frames decoded in the last minute, 12 without a picture to
catch up, 1 changed, 0 corrupted; the last picture is not blank; 0 losses
(0 packets), 0 dropped by the receive queue, 0 buffers dropped at their
size cap; packets waited 2.4 ms on average, 61 ms at most`.

For a report, run as root on the unit
`sh /var/opt/waze-on-cluster/current/collect-logs.sh`: it writes
`/tmp/woc-logs-<UTC date and time>.tar.gz` and prints its path. The archive
holds both tools' log files (cluster-render's too), the files in
`/run/cluster-render/`, the render's `status.json` and `probe.txt`, boot
recovery's counter and shutdown record, this boot's journal of the render,
`patchd`, the boot step, the recovery service, cluster-render and carplay,
the list of boots, `ls -l` of both tools' folders, their `*.local.conf`, the
date and the uptime.

Sockets: `/dev/shm/waze-on-cluster/ctl.sock` (the render's status and log,
group `tm_oap_app`; a connection also starts the service) and
`/dev/shm/waze-on-cluster/patch.sock` (`patchd`, `root:tm_oap_app`, 0660).
The app's README lists both protocols.

## Map size and upload

**Size.** The map covers the cluster's central map area, the stock map's
1088x480 rect on the 1920x720 panel (138x61 mm). The patch advertises exactly
that, so the phone renders those pixels, the decoder passes them through
unscaled and the texture maps onto the area one to one. In the whole-panel
slot `0x203` the map is centred at (416, 120) with everything around it
transparent. `tex_size` must equal the size the patch advertises.

**Texture.** The planes are packed into one R8 atlas, Y in rows 0–479 and U
and V side by side in rows 480–719 (783,360 B), which the renderer's shader
converts as full-range BT.601. The renderer keeps one persistent buffer and
writes only changed 64x64 tiles in place, one flush per update, so the
cluster never shows a half-written frame. (A new texture per frame held the
map to 3–4 frames a second on the car.)

**Noise filter** (`dirty_threshold` 8, `dirty_settle_ms` 1000). The phone
keeps coding residuals on a still map, mostly within 3 levels. A tile is
written only when it differs from what the cluster holds by more than the
threshold, or after `dirty_settle_ms`; a parked map costs about 1.6 updates a
second.

**Fast motion** (`pan_blocks` 1). An update whose exact write costs more than
261,120 B and more than the budget allows goes as 4x4 colour blocks at a
third of the bytes, slightly softer (38.8 dB mean on a recorded Waze capture;
street names and icons readable). The next update the budget covers, or a
quarter second later, brings the exact picture back. `waze-on-cluster
bench-pack <I420 file>` times the packing on the unit.

**Rate.** `target_fps` (30) is a ceiling on an exact grid; only the newest
frame waits, so the map skips ahead and never shows a backlog, and the
decoder skips the pictures of frames it is behind on ("Losses"). Real Waze
sent up to about 16 frames a second on the car.

**Upload budget.** The budget belongs to cluster-render and is shared by all
its clients: a 5500 KB/s ceiling, stepping down by 500 KB/s to 2000 KB/s on
sustained congestion and recovering slowly. Set it with `upload_kb_per_s` in
`/var/opt/cluster-render/cluster-render.local.conf`. This tool's own
`upload_kb_per_s` and `upload_burst_ms` keys are accepted and ignored with a
warning naming that file. On the car 8000 KB/s made the cluster flash black;
6000 KB/s stayed smooth with packed motion and no failed writes, but the
cluster once removed a shown map after a minute averaging 5774 KB/s, so the
ceiling sits below that. Real Waze
transitions peaked at about 3.2 MB/s. Every head-unit participant shares
the link to the cluster, so an upload that outruns it can drop other contents
too. Details: the cluster-render README.

Settings are in `waze-on-cluster.conf` (documented inline). Overrides go in
`/var/opt/waze-on-cluster/waze-on-cluster.local.conf`, which updates keep.

## The patch

`patch/carplay_patch.js` (Node 8, no dependencies) makes four edits after a
verified full backup. `patch/carplay_locate.js` finds each edit's site in the
build by its code and data and checks it before any write, so the patch
applies to any carplay build in which every site is found exactly once and
passes its cross-checks; a build where one does not is left alone, with the
reason. The install patches only the proven build; another build is a conflict
until Enable map (or `apply --unproven`) patches it once. `carplay_patch.js
probe` (`woc-patch.sh probe`) shows where the sites are in a binary and
whether it is patchable, without writing. The build the patch was proven on,
carplay 22.28.3, also has to match its shipped SHA-256 before the first edit.
Its sites:

| Edit | What it does | Where (carplay 22.28.3) |
|---|---|---|
| variant | jump-table slot for `KI_KOMBI_VARIANT` 7 → IC_HIGH or IC_MID | 4 B at `0x2ba4f0` |
| sink | second-stream sink URL: stock `avb://`, or `udp://…`, `file://…` | ≤ 59 B at `0x2a20b0` |
| selfstart | `onSuggestUi`'s `setStreamStatus(AVAILABLE)` call → `requestStream()` | rel32 at `0x18176c` |
| resolution | IC_HIGH geometry → 1088x480 px at 138x61 mm, safe area 504x368+286+72 | four 8 B immediates at `0x20ca32`–`0x20ca7c` |

`patchd` and the install hook apply `--panel high` with the stock sink.
`woc-patch.sh` is the shell path, for experiments: `status`, `probe`,
`verify`, `revert [--force]`, and `apply high|mid` with `--avb` (the app's
sink), no flag (`udp://127.0.0.1:20557`), `--capture` (FIFO) or `--sink
<url>`, plus `--res WxH|stock`, `--safe WxH+X+Y|full` and `--unproven`. It
remounts `/` read-write only for the write. **Never `systemctl stop` or
`restart` carplay**: CarPlay dumps core on SIGTERM, which power-cycles the
head unit, and so does any other failed CarPlay end; with the drop-in
loaded, a SIGKILL is a clean exit.
`revert` restores any binary of the backup's build
(`/usr/bin/carplay.woc-orig`), and refuses another build (a firmware update)
unless given `--force`.

## Safety

- The patch is the only change to a BMW binary. It is reversible and fully
  backed up, checks every edit site before writing, refuses a build where a
  site is not found or not recognised, is written by atomic rename, and
  takes effect at the next CarPlay start. Its first apply to a proven build
  (PATCH.md) also requires the whole file to be the shipped one; on any
  other build it needs `--unproven` (Enable map passes it, the install does
  not), and once its backup exists only the four sites are checked.
  Removal restores the backup's bytes in our edits' regions, or the whole
  backup over a binary of its build the patcher no longer recognises.
- `patchd` runs as root. It accepts only `apply` (panel `high|mid`, mode
  `avb|udp|fifo`), `revert`, `reboot`, `status`, `logs` and the capture
  commands; no value reaches a shell or a path. It checks `/` is read-only
  again after every write. It applies no patch and restarts nothing on its
  own. `reboot` is honoured only while a change is pending.
- Boot recovery (`recovery.js`, root) changes the binary only through the same
  revert as Disable map, and only when that revert would change it
  (`restorable: yes`: a verified backup of the binary's own build). Its one
  action on a service is `systemctl start carplay.service` after a crash or
  a SIGKILL `patchd` did not send, bounded, where recmgr loaded `carplay`'s
  entry this boot; it never stops,
  kills or restarts anything. Its shutdown record is a drop-in for
  `var-opt-ro.service`, removed with the tool. When a patched CarPlay keeps
  crashing and no backup can restore it, it marks the tool failed (the
  app's status line says so), starts CarPlay no more itself after a crash
  (still after a SIGKILL `patchd` did not send) and logs an ERROR at every
  boot and crash; CarPlay is left as it is, and only a
  restore by hand (PATCH.md, Boot recovery) ends a crash loop the firmware
  turns into head-unit restarts.
- The render restarts after a failure exit at most 30 times in 10 minutes
  (`StartLimitIntervalSec=600`, `StartLimitBurst=30`), then stays failed
  until the next head-unit start.
- The depacketiser and the decoder's framing hold bounded buffers: an FU-A
  NAL unit past 4 MB, a NAL unit or access unit past 8 MB is dropped, the
  stream resynchronises at the next start, and the drop is logged and
  counted in the minute line. A late or duplicate RTP packet (the same
  SSRC, up to 100 sequence numbers behind, timestamp no newer) is dropped
  instead of read as a 65 k gap, however many arrive in a row. A new SSRC,
  or a jump of 3000 or more ahead or more than 100 behind, is a new stream
  or a restarted sequence only once the next packet follows it in
  sequence; an isolated packet (a stray one of an old stream or of a
  second sender) is dropped and counted `stray`.
- No debug arming: the services are normal units whitelisted in recmgr.
- Nothing is mapped on the cluster before the stream's first non-blank
  picture, once its picture has stayed blank for `blank_ms`, or after the
  frames stop. The map never alters the gauges' data.
- The render runs as `hmi_5000` with the groups `video` (the DRM render
  node), `mgu_ufipc` (the AVB bridge's shared memory; the receiver fails
  without it) and `tm_oap_app` (the renderer's socket).

## Diagnostic capture

CarPlay's projection-config markers are on DLT only during a phone
connection. Press **Capture logs**, then reconnect the phone; the window lasts
up to 5 minutes and **Stop capture** ends it early. `patchd` keeps the
markers until it restarts. The capture service is a root service, so it
starts only after a reboot following its install.

`waze-on-cluster-capture.service` sends BMW's DLT control request (service
`0xf13`, as `dlt-control -u -z 1`) over `/run/dlt-files/dlt-ctrl.sock`, waits
for the acknowledgement and checks the TCP 3490 listener through procfs. It
never edits DLT configuration or restarts CarPlay. It refuses unless a DLT
client is registered, the listener is closed and the newest state record in
`/run/logntrace/` says unambiguously whether tracing was OFF or BUFFER. It
records ownership under `/run/woc-dlt-capture` before turning tracing on, and
restores the recorded mode at the deadline, on stop and in `ExecStopPost`
(also after SIGKILL). A failed restore shows as `restore_failed` in the app,
is retried every 5 s and blocks a new capture. DLT is shared ECU-wide:
restoring closes its TCP clients, and no other tracing tool should run during
a capture.

## Verified, and open

Verified on a car with real CarPlay Waze: the alternate display, the AVB
capture (RTP payload type 96, single NAL units and FU-A), the decode, the map
in slot `0x100` under the gauges with normal colours, readable text and
correct transitions. A 10-packet slice of a car capture is the depacketiser's
golden test (`test/data/stream15_start.rtp`).

Open: how the unit's hardware MSDK conceals a lost slice or picture, and
whether it flags those frames `Corrupted` (and propagates the flag to the
frames that reference them); that the phone's SPS is exactly the advertised 1088x480; how packed
motion reads during a long fast pan while driving; whether the alternate
display survives iOS and Waze updates (flag 1006 is server-side). Waze sends
no guidance metadata, so this shows map pixels, not data-driven directions.

**0.7.10 is a Kiro test build** (not published; host tests and the target
build only, never run on a car): the CarPlay binary written by a verified
temporary file and rename only, keeping its owner, mode and extended
attributes; `patchd` waits at most 15 s for the remount lock and then
refuses; an untested CarPlay build is patched only after the user confirms
it in the app; the render exits non-zero after 3 GPU decoder failures in a
row or a `poll()` error, under the start limit above; the bounded buffers
and the late-packet and SSRC rules above; boot recovery's failed mark.
Enable map on a CarPlay build outside the proven list needs the control app
0.4.2 (robertn_waze_cluster), which sends the confirmation; the older app
gets a refusal that says why. Install both together in the test build.

## Building and testing

```sh
make test                         # host tests: NAL, RTP, keyframe wait, the map feed against
                                  # cluster-render, the renderer's kit, patch/patchd/recovery/DLT
make test-x86                     # the C++ tests with the unit's toolchain in Docker (SSE2 paths)
make target                       # build/target/waze-on-cluster in Docker, imports checked
make test-firmware ROOTFS=<dir>   # DLT capture against the unit's own dlt-daemon in Docker
```

`CR` names cluster-render's tree, `../cluster-render` by default. Its tree
also gives the log, the config, the unit's ABI tools and the build image.
The target builds in Ubuntu 18.04 (gcc 7.5, glibc 2.27, the unit's libstdc++ ABI) against
link-only stubs of the unit's libmfx, libva, libva-drm and IAS AVB bridge
(`abi/*.symbols`), with every import checked.

The patch tests run against a copy of the unit's `/usr/bin/carplay`
(carplay 22.28.3, sha256
`ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50`) named by
`CARPLAY_BIN`; without it they are skipped (`SKIP`). The locator's test runs
on synthetic builds without it. The repository carries no BMW binary. `test-firmware` runs the unit's own dlt-daemon, libdlt and
dlt-receive from `ROOTFS`, an extracted root file system of the unit.

## License

GPL-3.0-or-later (`LICENSE`). `abi/include/mfx/` is a subset of the Intel
Media SDK headers under the MIT license (`abi/include/mfx/LICENSE`).
Third-party files keep their own licenses.
