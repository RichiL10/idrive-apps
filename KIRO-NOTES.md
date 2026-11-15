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
| Map on the cluster (0.8.10, Unreleased) | `map_shown = 1` (waze-on-cluster.conf) | `map_shown = 0`, or the app's Show map checkbox (no restart) |
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

## 0.8.10, Unreleased: Show map (lane O)

Built on this base, not ported: upstream's "Show on: Off" (idrive-apps PR #112, app 0.6.6) sits on the 0.9.0 machinery
for where the map shows (cluster and HUD feeds, `map.state.conf`, per-profile settings), which this build does not have.
Only the user feature is here: a switch that takes the map off the cluster and back with no CarPlay reconnect, patch
change or head-unit restart.

- Service: `{"cmd":"map","shown":0|1}`, `map_shown` in the conf and in the status; `MapFeed::set_shown` hides the layer
  as when the stream is not live (slots released, stock map and BMW's turn box back, guide hold released, nothing sent)
  while decoding and stream tracking go on; the newest frame goes before the layer is visible again.
  Files: `src/map_feed.*`, `src/main.cpp`, `src/state_settings.*` (replaces `guide_setting.*`; one state file, both keys
  written whole by temp file, fsync and rename; a bad or unreadable value is the safe one: map shown, turn box hidden).
- App: the Show map checkbox (`wocMapShown`, id 31), greyed without `map_shown` in the status or with no patch in effect;
  the map row reads `Cluster map: Off` while it is off. One new word, `Show map`, in all 32 locales.
- Tests: `test/map_feed_test.cpp` (`map_switch`), `test/state_settings_test.cpp`, app `test_control.js`, `test_page.js`,
  `test_i18n.js`.
- Not verified on a car or head unit. Across a service restart the choice is read from the state file; across a renderer
  restart the layer is made again hidden.

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


## Review of the guard (fix4-p), G2-1..G2-4 and the second reviewer's A, B, C

- G2-1 (`recovery.js`): a boot step that gives up (`abandonRestore`) cancels its write window. `remount(true)` never starts after that, the outstanding `mount -o remount,rw` child (`rwChild`) is killed and awaited before `remount,ro` is tried, and its callback is swallowed (no write, no release). A lock that arrives late (`takeLock`) is released at once. At the hard deadline, an `rwChild` that could not be stopped keeps the guard and the lock and the step exits 1 (the old code set the guard and then cleared it again because `/proc/mounts` still said ro). `WOC_TEST_NO_KILL` (only with `WOC_TEST`) stands for a mount no signal reaches.
- G2-2: `recovery.js boot aapd` with `aa_enabled=0` skips everything of aapd's but runs the generic `leave()`/`settleRo()` before it exits; an unknown service exits 1.
- G2-3: a due `_startAt` is no longer starved by a standing guard (the heal retry runs beside it, `_roBusy`). `_startDue` uses the lock the guard already keeps (`own`) and does not release a lock while a guard stands and `/` is not ro. (The patchd retry timer added for this was removed again in fix5-p, R3-1: see Known limits.)
- G2-4: before a replacement, patchd (`patchWith`) aborts when an unneeded old `.woc-running` cannot be removed; recovery aborts (`restoreTarget`) when the link it wants cannot be removed/made or is not the target's inode. Both finish through the normal path (`/` verified ro, lock released).
- A (`remount_lock.js healRo`): a lock `healRo` took is kept (marker rewritten with this pid) when `remount,ro` does not take. B: `breakable()` never breaks the lock of a live holder that owns the standing guard (`guardOwnerPid`, this process or the marker's pid). C (`patchd.js readState`): empty/unparsable status sets `unreadable`; a plain apply is refused before the remount.

### Known limits of the guard

- A `mount` child stuck in the kernel (uninterruptible) cannot be killed or reaped: the boot step then exits 1 with the guard and the lock kept, but the mount may still land later. Nothing in user space closes that; the guard (marker plus held lock) is what blocks the writers afterwards. Not tested on a car.
- When an older, still-running inode occupies `.woc-running` (a deferred change), both writers still decide from one `inUse(target)` sample (the patchd and recovery code for a link a process runs). Requiring `sameInode(running, target)` there would block undo of a deferred change, so a process that starts the target between the sample and the rename is not covered.
- The breaking of a live holder's lock after `HUNG_MS` still applies to a hung holder without a guard; a guard held by a hung process is never broken, and only that process (or a reboot, `/dev/shm` is cleared) frees it.
- A recovery restore whose link cannot be made now stays deferred (counter kept) instead of restoring without the link, even when nothing runs the target.
- R3-1 (fix5-p): patchd does not retry a failed `remount,ro` by itself. The timer (`WOC_RO_RETRY_MS`) could run a second heal beside an operation's heal; the older callback's release (by pid only) deleted the newer lock of the same patchd. So a guard patchd keeps stays until the next change through patchd (`acquireOp`/`roHeal`, under the lock), a status read once `/` is read-only again (`roStanding`), the recovery watcher once patchd is gone, a manual `mount -o remount,ro /`, or a reboot (the files are on tmpfs).
- R3-3 (fix5-p, not fixed): while a LIVE patchd owns the guard and the lock (its last `remount,ro` failed), the recovery watcher cannot take that lock, so a CarPlay start that is due after a crash waits (`_startAt` stays due, retried every tick). This needs a `remount,ro` that keeps failing and a CarPlay crash in the same window, so it is rare. It clears when a patchd change heals the guard, when `/` becomes read-only again (the next patchd status read or watcher tick sees it), or at a reboot; it can last until then. Service start is not a root write, but the lock is the only fence there is, and a second fence would add a state.
- R3-2 (fix5-p, `remount_lock.js`): the lock records the holder's start time (field 22 of `/proc/<pid>/stat`, read once at acquire) after the pid and time. `holderGone` treats an owner whose pid runs but whose start time differs, or cannot be read (any pid but this process's), as dead, so a recycled pid no longer keeps a dead guard owner's lock; `breakable` and `healRo` then break it. The guard marker carries no start time of its own: the owner exemption only applies to a lock whose pid equals the marker's, and that lock carries it. A lock without the start time (older format, or unreadable at acquire) is judged by the pid alone, as before. Test: `remount_lock_test.js` (a fake `/proc` through `WOC_LOCK_PROC`).
- R3-4 (fix5-p, `patchd.js readState`): the plain-apply precheck reads a FRESH status (`readState(cb, true)` waits for a read in flight and reads again, never the cache of an earlier or initial read) and accepts it only for `known: NO` or `known: yes` with an explicit `proven: yes|no`; output cut after `known: yes` is unreadable and the apply is refused before the remount. Other readers of `readState` are unchanged. The tests use `WOC_TEST_PATCHER` (only with `WOC_TEST`), a fake patcher whose status is cut and, in a second case, slow.



## 0.8.10, lane T: CarPlay's patch only on a variant-7 car, and a first patch on trial

Ported from upstream 5ea43f4 and 500d75d (waze-on-cluster 0.9.6), adapted to S1..S10. Nothing ran on a car.

What it does:
- `carplay_patch.js` reads the cluster coding (`aapd_patch.js readCoding`, the same reader Android Auto uses; only `/dev/shm/rawcodingdata` is read, never aapd or aapd.conf). `status` prints `coding:`. `apply` on a coding that is not KI_KOMBI_VARIANT 7, or cannot be read, is refused without `--unproven`. `revert` never looks at the coding.
- `patchd.js` reports such a car as upstream's Android Auto does ("not supported on this car (KI_KOMBI_VARIANT n)", "cluster coding unreadable") and sets `unproven: true`. S3 stays: a plain apply is refused before anything is remounted ("needs your confirmation"); only `{"unproven": true}` goes through. `patchd.js activate` (the install, and HIGH F's one re-apply) writes nothing on such a car and reports the conflict.
- The first patch of a proven build is recorded `proven: false, trial: true`. Boot recovery restores it after ONE failed start. When carplay has run the target's own file for 60 s in a clean boot, the watcher records it proven (one write window, `/` read-only again after). A patch recorded proven without trial (an earlier release's, or the watcher's) stays proven across applies; its revert records `healthy: true`, so the next apply of that build is proven at once.
- On a car coded otherwise than 7, an install puts the record of an earlier release's patch that has not started yet on trial (carplay's bytes are not touched). "Not started" means: its apply is pending, or a process runs a file kept under any of the running names lane H added (`.woc-running`, `.1`, `.2`; `heldNames` in `patchd.js`).

What differs from upstream:
- S3: upstream's Patch button applies a non-7 car after `--unproven` from the app; ours is the same, but a plain apply is also refused in patchd before the remount, and the status carries `unproven`, so the app's confirm step (S10) asks. When the build is unproven AND the coding is not 7, one confirmation covers both and the refusal text names both (`BOTH_REASON`).
- S4/S6/S1/S2: the watcher's proven-write takes the remount lock without waiting (`takeLock(0)`, S2), never writes the target (S1 untouched), never looks at aapd (S6, tested by a file-access spy), and a patch marked failed (S4) is never proven.
- `WOC_TEST_PROVEN_BUILD` (only with `WOC_TEST=1`) lists a synthetic build as proven, so `patchd_trial_test.js` runs without firmware. Added to the Makefile test list.
- No app change in this lane: the app's confirm step already keys on the status field `unproven`.

Record state, failed starts needed, action (`THRESHOLD`, `recovery.js`):

| patch record | failed starts or crashes before the restore | action |
|---|---|---|
| `trial: true` (first patch of a proven build on a variant-7 car, or a proven build patched while the coding cannot be read) | 1 | restored; a clean 60 s run records it proven |
| `proven: true`, no trial (ran healthy, or an earlier release's) | 2 | restored |
| `proven: false` (build outside the proven list, or a car not coded 7) | 1 | restored; never becomes proven |
| a patch of the backup's build the record does not describe | 2 | restored |
| no usable backup and crashing (any of the above) | the same count | persistent failed mark (S4), binary left as it is |
| a boot with a failed start or crash before the healthy run | none | a trial stays a trial |

## 0.8.10, crash evidence for a head unit that restarts in a loop (upstream issue #122)

Ported from upstream d67ea05, dcd61a7, 3f6047e, 5de507e (waze-on-cluster 0.9.8, 0.9.9), adapted to our tree.

- `journal_keep.js`: the timer starts the keeper 10 s after boot; in the boot's first 120 s of uptime each append is
  `fdatasync`ed through a read-only descriptor. Tests: `journal_keep_test.js` (sync order, preload that fakes the uptime),
  `units_test.js` (OnBootSec 5..15).
- `patch/logs_extra.js` (new, in `component.json`): `report` (patch records, aapd recovery state, coding variant, deploy
  tool versions, kept restart records), `snapshot` (root: restart records, `recmgr_stats.db` through `sqlite3 mode=ro`,
  core-dump names), `scrub`. `waze-on-cluster-logs-fw.service` runs `snapshot` before the logs service
  (`ExecStartPre=-`, failure ignored). `tools/collect-logs.sh` runs `aapd_patch.js status`, `report`, copies the snapshot,
  and scrubs the whole archive last. Tests: new `collect_logs_test.js` (in the Makefile).
- `recovery.js`: `keepRestartRecords` in the carplay boot step, in its own function, called before `startBoot` and
  wrapped in try/catch. Tests in `recovery_test.js`. `aapd_patch.js` now exports `readCoding` (one word).
- Tightened against upstream: records and sources opened with `O_NOFOLLOW|O_NONBLOCK` and checked on the descriptor;
  the temporary file is created with `wx`; the boot id used in a file name must be `[0-9A-Za-z-]+`; only files named like
  the boot step's are archived from `restart-records/`; a BMW/MINI maker code VIN is replaced inside a longer run;
  `state.json` is parsed up to 1 MiB (output stays whitelisted); the core-dump walk stops at 5000 entries; every file
  of the archive, not only the new ones, passes the VIN scrub before packing, and no archive is written if that fails.
- Not ported: anything needing mgu-deploy `runsInSafeMode` (upstream #126). Upstream marks the boot, aa-boot and recovery
  units with it; ours are not marked, so in safe mode the boot step probably does not run and no restart record is kept (not tested). The wifi.txt part of upstream's
  collect-logs.sh is another feature and is not here.
- Not verified on a car: that the firmware's `sqlite3` accepts the `file:...?mode=ro` form and reads the database while
  recmgr has it open in WAL mode; the table and column names (`Crash`, `Appl`, `CrashKey`, `AppID`) are upstream's.

## 0.8.10, lane H: every running file keeps a name (port of upstream waze-on-cluster 0.9.2, dd89d64 and a89bbf0)

Ported to our `patchd.js` / `remount_lock.js` (patch side only), with S1..S10 untouched:

- `remount_lock.js` gains `runs(st)` (a process runs an inode when its `exe` is it or `/proc/<pid>/maps` maps it); `inUse` uses it. Acquire, break and guard rules are unchanged (S2).
- `patchd.js`: `heldNames` (`.woc-running`, `.1`, `.2`), `holdTarget`, `settleHeld`, `staleHeld`, `sameStatAt`, `wroteAny`, `runsStale`. A change links the file it replaces under `.1` when `.woc-running` already names another running file, and the file it wrote under a free extra name while the running file is put back; afterwards each running file keeps a name, the rest go. `dropUnusedRunning` and the removal's `removeWhenUnused` cover all three names.
- A patcher that fails after writing leaves the change waiting only when a process runs a stale file (binary other than the one on disk; for aapd also a start that read aapd.conf before it changed). With no name free for the written file the running file is not put back over it.
- Tests: `patch/test/patchd_names_test.js` (new, 31 checks, no firmware needed): the three failure cases, the put-back cases, restart path, removal hand-over, Android Auto with `aa_enabled = 1`, `runs` with maps, CarPlay without a backup; crash-restart cases also in `patchd_patch_test.js` (needs CARPLAY_BIN, skipped here).

Differences from upstream, on purpose:

- Our `patchWith` keeps the order restart first, put-back only when no restart is allowed (upstream puts back first). The put-back logic therefore applies in that branch only. Upstream's `extraRun` (the `extra` hash kept in the pending marker) is an earlier upstream change we do not have; a waiting change's extra files are compared with their state at the start of this change, as in our base.
- When the file a change replaces cannot be named (`.1` and `.2` hold running files) nothing is written and `/` stays read-only; upstream goes on. This follows the F5 rule: no write without a verified name.
- `holdTarget` checks that the new name is the target's inode.
- "Undo only what is ours" (dd89d64 in `aapd_patch.js`, `aapd_conf.js`, `carplay_patch.js`) limits upstream's rebuild of a proven file without a backup, which our base does not have (`stockOriginal` came with upstream 0.9.1). Without a backup our revert writes nothing, so the rule already holds; a test shows it for CarPlay. Not ported: the rebuild itself, the `aapd_test.js` / `undo_test.js` hunks that exercise it.
- `recovery.js`: upstream 0.9.2 changes it only for aapd's stock hashes (aapd locator of 0.9.1); not ported. Recovery's own `.woc-running` handling is unchanged and does not use `.1` / `.2`.
- Not run: nothing on a car, no firmware test (`patchd_patch_test.js`, `aapd_test.js`, `undo_test.js` skip without the binaries).
