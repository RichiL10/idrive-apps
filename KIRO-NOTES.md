# KIRO-NOTES: Kiro test build on upstream 0.8.8 (branch kiro/up088)

TEST BUILD. Nothing in this branch has ever run on a car. It is checked locally in Docker only.
The release tooling accepts plain X.Y.Z versions only, so the test-build nature is recorded here and in
the commit messages, not in the version numbers.

## What is upstream, what is Kiro

Upstream: [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) at commit 0eabce5
(waze-on-cluster 0.8.8, cluster-render 0.3.11, robertn_waze_cluster 0.5.7). Everything not listed below is
upstream code: GPU copy with fallback, per-picture crop, changed-frame upload, evidence-based boot
recovery, boot-id markers, guide hold / hide BMW turn box, i18n, capture ordering. The HUD feature of
upstream 0.9.0 is NOT included.

Kiro: the ten safeguards S1..S10 below, re-applied from an earlier fork build (kiro/stability,
waze-on-cluster 0.7.10) onto the new upstream code, with their tests. Versions: waze-on-cluster 0.8.9,
cluster-render 0.3.12, robertn_waze_cluster 0.5.8. Target car: BMW G20 330i xDrive, iDrive 7, CarPlay only,
no HUD, no Android Auto.

## Defaults and one-line off switches

Overrides go in `/var/opt/waze-on-cluster/waze-on-cluster.local.conf` and
`/var/opt/cluster-render/cluster-render.local.conf`.

| Feature | Default | Off switch / change |
|---|---|---|
| GPU frame copy (upstream) | `gpu_copy = 1` (waze-on-cluster.conf:89) | `gpu_copy = 0` |
| Guide hold (upstream) | `guide_hold = 1` (cluster-render.conf:185) | `guide_hold = 0` |
| Hide the BMW turn box (upstream) | `hide_bmw_guidance = 1` (waze-on-cluster.conf:114) | `hide_bmw_guidance = 0` |
| Android Auto (Kiro S6) | OFF, `aa_enabled = 0` (documented at waze-on-cluster.conf:170) | `aa_enabled = 1` turns it ON (also enable the `waze-on-cluster-aa-boot` unit) |
| iDrive 7 upload ceiling (Kiro S9c) | `upload_kb_per_s = 4500` (cluster-render.conf:261; upstream 5500) | `upload_kb_per_s = 5500` restores upstream (shared with iDrive 8) |
| DCSM liveness gate (Kiro S9a) | `dcsm_liveness_ms = 3000` (iDrive 7 only) | `dcsm_liveness_ms = 0`; otherwise 1000..9000 |
| Take-over allowlist (Kiro S9d) | `map_take_over_contents = 0x01000300` | empty list = take-over off |
| Unproven-build confirmation (S3/S10) | always required | no switch (on purpose) |
| Render restart cap (S5) | 30 starts per 600 s | edit the unit |
| Target / panel | `target = map`, panel mode never on by default | unchanged from upstream |

## S1..S10 status (file:line)

All ten are implemented and committed. "Tests" names the main test files; counts are in the table below.

| ID | What | Where | Tests |
|---|---|---|---|
| S1 | Atomic CarPlay write: one `wx+` descriptor, owner/mode/xattrs kept, SHA-256 read-back, rename, dir fsync, stale temp cleanup, REFUSE on rename failure (no in-place fallback). Compatible with upstream PR #52 mode repair | `native/waze-on-cluster/patch/carplay_patch.js:582` (`writeInPlace`) | `patch/test/atomic_write_test.js` |
| S2 | Remount lock broken only when holder pid is gone, or alive but older than HUNG_MS 10 min, or no pid and older than STALE_MS 120 s. patchd waits 15 s then refuses ("try again in two minutes"); recovery never waits | `patch/remount_lock.js:34-58`; `patch/patchd.js:185,1234` | recovery tests, `patch/test/*` |
| S3 | `--unproven` only for a request with `"unproven": true`; a plain apply on an unproven build is refused with a status asking for confirmation | `patch/patchd.js:599,1321` | `patch/test/patchd_unproven_test.js` |
| S4 | Persistent recovery "failed" mark when patched, no usable backup and CarPlay keeps crashing; no more starts after crashes; status shows it; clears when the binary is stock; a foreign SIGKILL still restarts CarPlay (bounded); atomic state file | `patch/recovery.js:69,616,715-790` | recovery tests in `patch/test` |
| S5 | `StartLimitIntervalSec=600`, `StartLimitBurst=30`, `Restart=on-failure` | `systemd/waze-on-cluster.service:32` | `patch/test/units_test.js` now asserts both numbers, that they sit in `[Unit]` (systemd 237 ignores them under `[Service]`) and `Restart=on-failure`; the same for `cluster-render.service` (review F4, N5) |
| S6 | Android Auto OFF by default; aapd, aapd.conf and AA backups/markers never read for writing or written with `aa_enabled = 0`; patchd, recovery, install/remove all respect it; app greys the AA section | `patch/aa_enabled.js:70`; `patch/patchd.js:149,1307`; `patch/recovery.js:85`; conf `waze-on-cluster.conf:170-175` | `patch/test/patchd_aa_off_test.js`, recovery tests, upstream AA tests with AA on |
| S7 | RTP/NAL hardening: SSRC probation, late/duplicate drop (kMisorder 100), far jumps held (kMaxDropout 3000), idle reset 1000 ms from ARRIVAL time, FU-A cap 4 MiB, buffer caps with resync, counters in stream health | `src/rtp_h264.h:69-79`; `src/rtp_h264.cpp:91,97,157,184`; `src/stream_health.*`; `src/video_producer.cpp` | `test/rtp_h264_test.cpp`, `nal_reader`, `stream_health_test.cpp` |
| S8 | Decoder device watch: GPU hang / device lost closes the session and waits for the next SPS; 3 consecutive device failures exit non-zero; poll() error in main exits 1 | `src/device_watch.h`; `src/decoder_msdk.cpp:256,882`; `src/video_producer.cpp:331`; `src/main.cpp:233-253` | device_watch tests, fake-MSDK cases in `test/decoder_test.cpp` |
| S9a | DCSM heartbeats stop after 3 s without loop progress (ID7 only; ID8 untouched), `resumed()` | `native/cluster-render/src/liveness.h`; `dcsm2_link.cpp:177`; `unit_idrive7.cpp:123-129` | cluster-render tests |
| S9b | poll()/loop error exits non-zero | `unit_idrive7.cpp:58-136`; `unit_idrive8.cpp:195-253` | cluster-render tests |
| S9c | iDrive 7 `upload_kb_per_s` 4500 | `cluster-render.conf:261`; README note | conf/README tests |
| S9d | `<target>_take_over_contents` allowlist, validation (leading +/-, ERANGE, ids outside 0x0100xxxx, ids in scene_ids_allowed) | `src/holds.cpp:129-147`; `src/main.cpp:59,158` | cluster-render holds tests; waze `map_feed_test` lists its contents |
| S10 | App: confirm step before Enable map on an unproven build (first press warns, press under 1000 ms later ignored, only the confirming press sends `unproven:true`, clears on timeout/close/status change); texts for failed and lock busy; AA section Off when `aa_enabled = 0` | `apps/robertn_waze_cluster/src/waze_cluster_control.js:339-392,455,470,667` | `apps/robertn_waze_cluster/tools/test_control.js` |

Not re-applied on purpose: the fork's opt-in `map_take_over_remap` (upstream removed that state machine and
it was never enabled). Reconciled with upstream's `guide_take_over` list; guide hold is untouched.

Upstream behaviour kept: `aapd_patch.js` still has upstream's own `writeInPlace` (line 203). It is only reached
with `aa_enabled = 1`, which is off for this car; S1 covers CarPlay only, as specified.

## Tests (run with the runner in `tools/run-suite.ps1` of the scratch folder, Docker)

See the table at the end of this file (filled from the final run on the final commit).

Suites: waze-host, cr-host, app, cr-x86 and waze-x86 (gcc 7.5, -Werror), cr-target and waze-target (head-unit
binaries with import checks), release-check (reproducible build of the three components).
Tests that need real firmware (`test-firmware`, `test-ramses`, CARPLAY_BIN/AAPD_BIN) are skipped or not run:
the 6 skips in waze-host are the same as in the upstream baseline.

## Review remediation (after the two reviews of this build)

Fixed, each with a test: lock breaking is serialised (`remount_lock.js` `<lock>.break` guard, re-read under it);
a plain apply on an unproven build is refused in patchd BEFORE the remount; `WOC_AA_ENABLED` is a test device and is
honoured only with `WOC_TEST=1`; the failed mark in `status` has a patchd test; StartLimit values are asserted;
a getfattr that fails is a WARNING (extended attributes, such as a file capability, are preserved only where
getfattr works on the unit); a hung or lost device in a VPP run with GPU copy is counted at once (only
`MFX_ERR_DEVICE_FAILED` stays ambiguous there); late / stray / new-stream / idle-reset counts reach the log and
the minute line; the arrival time for the RTP idle reset is `arrival_ms()` (own header, tested); `cluster-render.service`
has the same restart cap; the render exits through a watchdog 8 s after a fatal device failure even if MFXClose hangs.

Left as they are, on purpose:
- `recmgr` / `crashNames` in `component.json` still list `aapd` and the aa-boot unit. They are the names the deploy
  tool puts on the head unit's restart and crash-handler lists; the deploy tool was not read or run here, and
  `release/test/release_test.js` pins `mgu-deploy` 0.7.11 for them. With Android Auto off this only means a crash of
  the stock aapd is handled as the tool's lists say, not that aapd is touched. Not verified on a head unit.
- If the render hits the start limit (30 failed starts in 10 minutes), systemd probably also fails
  `waze-on-cluster.socket` / `cluster-render.socket`, so the map stays down until `systemctl reset-failed` or the
  next head-unit start. A guess about systemd 237, not run.
- Setting `aa_enabled` back to 0 while aapd is patched leaves it patched and unguarded: revert the Android Auto
  patch first (note in the conf). Not relevant to this car, where Android Auto was never patched.
- No test drives `VideoProducer::decode -> DeviceWatch -> device_fatal_ -> main exit 1` as one chain (it needs the
  whole producer with its sockets); the pieces are tested (DeviceWatch, decoder fake MSDK, the watchdog). That
  `feed_datagram` passes `arrival_ms(now, waited_us)` is checked by reading, the arithmetic by test.
- A new SSRC whose first two packets arrive swapped counts as stray (as in the fork and RFC 3550); unlikely on a local link.

## Review fix-p: `/` read-only before the lock goes (F-P1..F-P3)

- patchd links the running binary as `.woc-running` before EVERY replacement while a process runs it (also when it
  restarts the service after), and writes nothing when that link cannot be made and checked; recovery's restore does the
  same. A failed restart therefore cannot leave an unlinked running inode that keeps `/` writable.
- A write window that ends with `/` not verified read-only (all remount,ro tries failed, or the boot step's hard
  deadline with an ineffective remount,ro) keeps the remount lock and sets `<lock>.ro-failed` (patch/remount_lock.js).
  patchd reports it as an error, writers are refused, the boot step exits 1 (journal), the watcher retries every 5 s.
  How to clear it: `mount -o remount,ro /`, then any change, a status read, a boot step or a watcher tick clears the
  marker; a head-unit start clears it too (tmpfs). A dead holder's lock does not outlive the process, the marker does.
- Not on a car: the unit's `ExecStart=-` makes the boot step's exit 1 informational; CarPlay still starts after it.

## NOT verified

- Nothing ran on a car, on a head unit, with a real phone, a real cluster or real MSDK hardware. The decoder
  device-failure path is tested against the fake MSDK only.
- No test against the real carplay 22.28.3 binary (no firmware in the repo); the proven-build tests skip.
- The 4500 KB/s ceiling is a conservative value derived from earlier on-car observations (5774 KB/s made the
  KOMBI remove the map, 8000 flashed it black); 4500 itself is untested on the car.
- Take-over allowlist, liveness gate and the confirm step have no on-car evidence.
- The app was tested with the repo's fakes, not on the HMI.
- Release signing/publishing was not done and must not be done from this branch (local only).


## Test results on this branch (final run, Docker, runner `tools/run-suite.ps1`)

Counts are the runner's indicators (cases plus C++ programs); upstream baseline is commit 0eabce5, nothing edited.
Every suite exits 0 with 0 failures. No count is below the baseline.

| suite | baseline | this branch | skipped | difference |
|---|---|---|---|---|
| waze-host | 651 | 793 | 6 (same as baseline: need real firmware) | +112: S1..S4, S6 node tests, S7/S8 C++ programs and cases |
| waze-x86 (gcc 7.5, -Werror) | 381 | 401 | 0 | +20: S7/S8 C++ test programs and cases |
| waze-target | 1 | 1 | 0 | binary builds, import checks OK |
| cr-host | 899 | 948 | 0 | +48: liveness gate, take-over allowlist, 4500 ceiling cases |
| cr-x86 (gcc 7.5, -Werror) | 872 | 921 | 0 | +48, same cases as cr-host |
| cr-target | 3 | 3 | 0 | 3 binaries, import checks OK |
| app | 64 | 73 | 0 | +9: S10 confirm step, failed / busy texts, AA off |
| release-check | 3 | 3 | 0 | cluster-render@0.3.12, waze-on-cluster@0.8.9, robertn_waze_cluster@0.5.8 reproducible |

Final verification: all eight suites were re-run in full on the final commit (clean worktree, `docker ps` empty
afterwards) and gave exactly the numbers above. Logs are in the scratch `tools\logs\wt-int-*` files.

Review findings and how each ended (F = first review, N = second review):

| finding | resolution |
|---|---|
| F1 `recmgr` / `crashNames` list aapd | not changed, deploy tool not read; documented under "Left as they are" |
| F2 two waiters could both break one lock | fixed (`<lock>.break` guard, re-read under it), test |
| F3 failed mark in `status` untested | patchd test added |
| F4 StartLimit untested | values asserted in tests |
| F5 unproven apply refused too late | refused before the remount, test |
| F6 getfattr failure silent | WARNING in the log |
| F7 `WOC_AA_ENABLED` override usable outside tests | honoured only with `WOC_TEST=1` |
| F8 `aa_enabled` back to 0 while aapd patched | conf note: revert the Android Auto patch first |
| F9 socket behaviour at the start limit | note in the unit comments; a guess, not run |
| N1 VPP hung or lost device not counted with GPU copy | counted at once, test |
| N2 RTP counters not in the log | late / stray / streams / idle_resets in log and minute line |
| N3 arrival time for the idle reset | `arrival_ms()` helper, arithmetic tested |
| N4 no test of the decode -> DeviceWatch -> exit chain | NOT done, pieces tested separately |
| N5 cluster-render.service without restart cap | StartLimit added, test |
| N6 exit could hang in MFXClose | exit watchdog 8 s after a fatal device failure |

Not verified in addition: that `feed_datagram` itself passes the arrival time (checked by reading only); systemd 237
behaviour at the start limit (guess).

One upstream test row was changed on purpose (app `test_control.js`: "another change to / is running" now expects
the Busy text); `map_feed_test` and the cluster-render take-over fixtures now list their stock contents because
take-over is allowlist-based (S9d). No upstream test was removed or weakened.


## Third review (fix2-n), all four findings fixed with tests

| finding | resolution |
|---|---|
| F-N1 exit watchdog armed only by the main loop | `DeviceGuard::set_exit_watchdog` arms the one-shot watchdog from the fatal publication itself (8 s, `VideoProducer` constructor); the main loop's call is then a no-op. Test with a blocking MFXClose and no polling loop, injected exit function |
| F-N2 hang / lost device in GPU-copy setup treated as a copy fallback | `MFX_ERR_GPU_HANG` and `MFX_ERR_DEVICE_LOST` in SetHandle, the two QueryIOSurf, DECODE_Init and VPP_Init are announced (counted, watchdog) before any close and do not fall back; `MFX_ERR_DEVICE_FAILED` still falls back, not counted. Two existing fallback tests now use `MFX_ERR_DEVICE_FAILED` |
| F-N3 idrive8 connect-retry poll: errors ignored, error revents exited 0 | `connect_wait.h` (pure function, `connect_wait_test`): EINTR/timeout retry, POLLIN stop (0), other errors and POLLERR/POLLHUP/POLLNVAL exit 1 |
| F-N4 same-SSRC sequence restart left the access unit open | restart branch ends the access unit and forgets the timestamp, like the SSRC switch |

Not covered: `MFXInitEx` failing with a hang / lost device in a GPU-copy session still falls back to a session without GPU copy (no session exists then to close; the fallback session decides). Nothing ran on a car.


## Review of the guard (fix3-p), F1..F5

- F3 (76975d9): the guard no longer depends on its marker file; a writer verifies `/` read-only under the lock before it remounts read-write.
- F1: the recovery boot step exits 0 only when `rootIsReadOnly()` (`/proc/mounts`) says so (`roSettled`, `settleRo` in `recovery.js`). `/` read-write with no guard: it takes the remount lock (waits up to the boot bound), puts `/` back, else sets the guard, keeps the lock and exits 1. Another process in its write window: the step waits, exits 1 if still held. `healRo` also removes the lock a dead writer left with the guard. Tests: three `F1:` cases in `recovery_test.js`.
- F2: `Recovery.tick` retries the guard when one stands in memory or on disk (`roStanding()`), so a freshly started watcher keeps retrying an imported guard. Test `F2:` (only a file on disk).
- F4: `patchd.js oneShot` stops before the Android Auto step when the CarPlay step left the guard (no remount, no write; a removal exits 1, an install 0). Test `F4` in `patchd_ro_test.js` (aa_enabled=1).
- F5: `patchWith` always makes and verifies the `.woc-running` link before the patcher; it removes it after the write when no process uses the old inode (`needed`). If it cannot be linked nothing is written. Test `F5` in `patchd_ro_test.js`.
- Not verified: on a car. The F5 test shows no write when the link fails; it does not race a process start. The F4 test uses an absent aapd, so it shows the AA step is skipped (status and mount calls), not an AA write being blocked.
