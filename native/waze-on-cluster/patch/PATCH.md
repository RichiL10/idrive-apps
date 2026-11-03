# The carplay patch, byte for byte

Four reversible edits to `/usr/bin/carplay` let waze-on-cluster receive the
CarPlay instrument-cluster map, at the size it displays, on a head unit coded
`KI_KOMBI_VARIANT` 7. `carplay_patch.js` applies, verifies and reverts them;
`patchd.js` runs it for the app and the install hooks, `woc-patch.sh` from a
shell.

## Builds

`carplay_locate.js` finds the four edit sites in each build by its code and
data, as each edit's "Found by" says, so the patch applies to any build in
which every site is found exactly once and passes its checks. A build where a
site is missing, found more than once or fails a check is not patchable; the
reason names what was not found, and `patchd` reports it as a conflict
(`not patchable: <reason>`). File offsets and virtual addresses are converted
through the ELF program headers, and function bounds come from the
`.eh_frame_hdr` search table; without that table no site but the sink is
found. A site a dynamic relocation covers is refused, and every site in a
build with text relocations or relocations the locator cannot read (REL,
RELR): the loader would write over the edit.

`carplay_patch.js probe [<file>]` (`woc-patch.sh probe`) reads a binary and
prints its size, SHA-256, GNU build-id, the carplay version its debug source
paths name, where each site is, how it reads,
and `patchable: yes` or `no` with every reason; it never writes.
`collect-logs.sh` includes its output.

**Proven builds**, listed by build-id in `carplay_patch.js`: the first edit
needs the whole file to be the shipped one, and any other content reads as
modified by something else. Another build counts as pristine when all four
sites read stock, but its first edit needs `apply --unproven`: its sites pass
every check, yet no car has run it patched, and two edits run at every
CarPlay start (below). `patchd` reports such a build without our backup as
the conflict `untested carplay build`, so an install leaves it as it is, and
Enable map applies it with `--unproven`. Once our backup exists, later applies
and installs patch it like a proven build.

**At CarPlay start**, with or without a phone, `ApplicationPrivate::start()`
builds the CarPlay info: it converts the variant (Edit 1), constructs
`ICSafeAreaProvider` from it, reads the IC_HIGH geometry through its getters
(Edit 4) and hands it to `mCarPlay->SetInitialInfoResponse(…)`, whose result
check throws on an error. A build whose Cinemo rejects the geometry, or whose
IC_HIGH start path needs more than a variant-7 car has, fails there at every
start. Edit 3 runs only on the phone's `onSuggestUi` event, Edit 2 only when
the second stream starts.

The offsets and bytes below are those of the build the patch was proven on:

| | |
|---|---|
| package | `carplay 22.28.3+gitr624+993efc1-r0.14` |
| file | `/usr/bin/carplay`, ELF x86-64 PIE, stripped |
| size | 3 484 912 bytes |
| sha256 | `ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50` |
| build-id | `5de62156575d737391ea42254e778a97dbbb51f8` |

In it, file offset equals virtual address in the ranges used here.

## Edit 1 — variant (ungate the second display)

CarPlay maps the raw coding value `KI_KOMBI_VARIANT` through a converter
jump table at `0x2ba4d4` (12 signed int32 offsets from the table base):

| raw | handler | internal value |
|---|---|---|
| 9 `ic_box_high` | `0x239790` | IC_HIGH (0) |
| 10 `ic_box_mid` | `0x2397e0` | IC_MID (1) |
| 0 | `0x2397d0` | NOT_ACTIVE (3) |
| everything else, incl. 7 `high_4_1` | `0x2397c0` | OTHER (2) |

OTHER fails the accessory-feature gate and the `ICSafeAreaProvider`
resolution builder, so the alternate display is never advertised. The patch
copies the IC_HIGH (or IC_MID) slot value into slot 7; only variant 7 is
affected.

| | offset | bytes |
|---|---|---|
| slot 7 original | `0x2ba4f0` | `ec f2 f7 ff` → OTHER |
| → IC_HIGH | `0x2ba4f0` | `bc f2 f7 ff` (slot 9's value) |
| → IC_MID | `0x2ba4f0` | `0c f3 f7 ff` (slot 10's value) |

**Found by** the converter's name and code. The converter is the one function
loading its name string, `bool …codingToInternal(const
…eKI_KOMBI_VARIANT&, …KombiVariant::Values&)`; its switch is the jump
`cmp byte [rdi],n ; ja ; movzx eax,byte [rdi] ; lea rdx,[rip+table] ; movsxd
rax,[rdx+rax*4] ; add rax,rdx ; jmp rax` inside it. A switch of that shape
elsewhere that decodes to the same mapping is another copy of the converter,
which the edit would leave unpatched, and refuses the build. Other switches
share the shape, so each table of at least 11 slots is decoded through its
handlers (`mov dword [rsi],value`); the converter is the
only switch mapping 9 → IC_HIGH, 10 → IC_MID, 0 → NOT_ACTIVE and every other
value to one shared OTHER table value, with slot 7 holding that OTHER value
(stock) or slot 9's or 10's (patched). The stock and patched slot values are
read from the table itself.

The app applies IC_HIGH; IC_MID (`--panel mid`) keeps its stock 1920x720
geometry.

## Edit 2 — sink (where the stream goes)

The second-stream Cinemo sink URL at `0x2a20b0` is, as shipped:

```
avb://media_transport.avb_streaming.15?mime_type=video/H264    (59 bytes + NUL)
```

`mime_type=video/H264` keeps the H.264 undecoded; the stream is RTP (payload
type 96, single NAL units and FU-A; VERIFIED on a car capture). The modes:

- **avb** (what the app applies; an apply without `--sink`): the stock sink,
  which the render joins as an extra receiver.
- **udp**: `--sink udp://127.0.0.1:20557?mime_type=video/H264`. `udp://` and
  `tcp://` map to Cinemo's `NmeVfsSocket`, a stream sink. That the bridge
  accepts it and sends the same RTP is INFERRED, not verified on a car.
- **fifo**: `--capture <fifo>` writes `file://<fifo>?mime_type=video/H264`.
  The projection bridge rejects a `file://` sink on the car
  (`configureProjectionBridge` fails).

A replacement is NUL-padded to 59 bytes; a longer URL is refused. The NUL
run after the slot and the next string are never written. The render listens
on all three sinks.

**Found by** the string after it, `mCarPlay->GetDisplaySource( …`: the slot
is its own NUL-terminated string ending 1 to 16 NULs before that string, and
holds either the stock URL above or a `udp://`, `tcp://` or `file://` URL no
longer than it. Exactly one such slot must exist, loaded by exactly one
rip-relative `lea`, with no `lea` loading a string inside it (a merged string
that a redirect would change). A build whose stock URL
differs is not patchable: the render joins stream 15.

## Edit 3 — self-start

With Edits 1 and 2 CarPlay advertises the display, but the stream never
starts: `AlternateDisplays` waits for NavController to forward a
`requestStream` command (`ProjectedModeGuiding.streamCommandChanged`), and on
this build NavController's `Guidance.requestStream` is an unimplemented stub.
The fix makes CarPlay start the stream itself.

`requestStream()` (`0x181810`) needs no stored config: it calls `ShowUI` and
`ForceKeyframe` through `mCinemoCarPlay` (`[this+0x28]`) with the URL and UUID
from `CarPlayConstantsRepository`, skips when `mStreamStatus` (`[this+0x48]`)
is already 2, and ends with `setStreamStatus(STREAMING)`.

`AlternateDisplays::onSuggestUi()` (`0x1816f0`), once the display is
available and not streaming, calls `setStreamStatus(this, AVAILABLE)` at
`0x18176c` with `this` in `rdi`. The patch retargets that call:

| | offset | bytes |
|---|---|---|
| original | `0x18176c` | `e8 ef fd ff ff` → `call setStreamStatus` (`0x181560`) |
| self-start | `0x18176c` | `e8 9f 00 00 00` → `call requestStream` (`0x181810`) |

Only the rel32 changes. NavController then receives STREAMING where stock
sends AVAILABLE; it is inert either way, and these messages never reach the
phone. Both guards make it one-shot per session. Every mode applies it.

The stream thus starts with the session, before any navigation app draws on
the cluster, and the phone sends a blank picture until one does (on the car
about 100 blank frames in the first 2 s, then a pause). The render keeps the
stock map up until the first non-blank picture (README).

**Found by** name. setStreamStatus, requestStream and onSuggestUi are the
functions that load their own function-name strings (`void
…AlternateDisplays::setStreamStatus(…`, `…::requestStream()`,
`…::onSuggestUi()`) with a rip-relative `lea`, each string from one function
only and within its first 0x60 bytes (the logging prologue; an inlined copy
or a split-off part loads it deeper), the three functions within 64 KiB of
each other. requestStream must also load the `mCinemoCarPlay->ShowUI(` and
`mCinemoCarPlay->ForceKeyframe(` checks, call setStreamStatus, and be called
directly from outside onSuggestUi: a callback that inlined it has another
argument contract. The site is
onSuggestUi's one call to either function, with AVAILABLE stored as its
argument (`mov dword [rsp+…],1`) in the 24 bytes before it. Its stock and
self-start rel32 are computed from the functions' virtual addresses.

**Exception risk.** `ShowUI` and `ForceKeyframe` are each followed by a
result check (`0x18189b`, `0x1818da`) that calls the throw helper `0x250980`
on error, and the call site has only a cleanup handler. An uncaught throw
would kill CarPlay, which reboots the head unit ("Boot recovery"), and could
repeat at every phone connection. Disable map, or boot
recovery (below), restores the stock call path, which has no throw.

### Keyframe cadence

CarPlay forces exactly one keyframe, inside `requestStream` (`0x1818ca`, the
binary's only `ForceKeyframe` reference). On a 90 s car capture the phone
sent SPS, PPS and an IDR only at stream start, twice within the first second,
then non-IDR slices only. A decoder that misses the start never syncs. So
the render runs from boot with its sources listening, starts the decoder at
the stream's first SPS, and decodes whether or not the map is shown. A lost
RTP packet costs only the NAL unit it carried: the decoder decodes through it
and the map shows smudges until the phone codes those areas again (README
"Losses"). `probe.txt` counts `seq_gaps` and its `late-join:` line reads
`RISK` on this stream.

A render that missed the start (it restarted), or whose decoder gave up its
sequence after decode errors in a row, decodes nothing until the next
stream, and nothing on the head unit asks the phone for a keyframe. Its
status says `Stream lost — reconnect CarPlay`; the map returns with the next
CarPlay session, when the phone reconnects.

## Edit 4 — resolution

Stock IC_HIGH advertises a 1920x900 display (234x110 mm), so the phone renders
at that size and the map would be scaled twice. Edit 4 advertises the size
the map is shown at: the cluster's central map area, 1088x480 px at
138x61 mm, the view area the full frame. The decoder then passes the picture
through unscaled.

The IC_HIGH builder in `ICSafeAreaProvider` (`0x20ca30`) fills its object from
four `movabs` immediates; only the 8 immediate bytes after each 2-byte opcode
change:

| field | immediate at | stock | patched (default) |
|---|---|---|---|
| mm (→ `+0x10`) | `0x20ca32` | `ea000000 6e000000` (234x110) | `8a000000 3d000000` (138x61) |
| px (→ `+0x08`, `+0x18`) | `0x20ca54` | `80070000 84030000` (1920x900) | `40040000 e0010000` (1088x480) |
| view x,y (u16) + safe width | `0x20ca66` | `00000000 64020000` | `00000000 f8010000` |
| safe height + safe x,y (u16) | `0x20ca74` | `0e020000 0202c000` | `70010000 1e014800` |

The getters at `0x20ce00`–`0x20cf40` read these fields; the config built from
them (`0x2078f1`) is what `SetVideoParams` and the view-area report carry.
The IC_MID builder (`0x20caa0`) is never written: `--panel mid` advertises
stock 1920x720, and switching high → mid restores the IC_HIGH immediates, so
the binary carries one panel's geometry at a time. `--res WxH` (even, up to
1920x1080) picks another pixel size at the same physical size; `--res stock`
keeps stock. The size is negotiated at phone connection, so it applies from
the next CarPlay session after CarPlay restarts.

**Found by** the `ICSafeAreaProvider(const …KombiVariant::Values&)`
constructor, the function that loads its name string. It calls exactly two
geometry builders, within 64 KiB of it: functions of at most 0x80 bytes
opening with `movabs rdx` (the mm pair) and holding `mov [rdi+0x10],rdx ;
movabs rax ; mov [rdi+8],rax ; mov [rdi+0x18],rax ; movabs rax ; mov
[rdi+0x20],rax ; movabs rax ; mov [rdi+0x28],rax` once. The IC_HIGH builder
is the one called on the true branch of the constructor's one call to its
IC_HIGH check, a small function doing `mov eax,[rdi] ; test eax,eax ; sete
al` (or `cmp dword [rdi],0 ; sete al`); the IC_MID builder, the other one, on
the true branch of its one call to the IC_MID check (`cmp dword [rdi],1 ;
sete al`). The `test al,al` and `je` or `jne` after each call give the
branch. A caller of the constructor then reads the fields the edit writes
through one-field getters: `+0x18` (pixel size), `+0x20`, `+0x22` (view x,
y), `+0x24` (safe width and height), `+0x2c`, `+0x2e` (safe x, y).

This tool's geometry has its 138x61 mm physical size, the view area at (0,0)
and a safe area inside the frame. A stock geometry has another physical size
and a safe area inside the frame; any other geometry is not recognised.
`--res stock` and `--panel mid` write the backup's stock immediates back.

### Safe area

The phone draws the map across the whole view area (Cinemo's `viewAreas`)
and keeps its UI, such as the manoeuvre banner, inside the safe area; a car
capture of the stock geometry shows exactly that. With a full-frame safe area
the banner lands in the top-left corner, under the cluster's gauge mask.

The default safe area is **504x368 at (286, 72)** (x 286–790, y 72–440):

- x: BMW's own IC_MID safe area (504x456 at (708, 153) on the panel) lies
  inside the map area at (422, 134); in map-area coordinates it spans
  x 286–790, between the native speed readout (to x ≈ 170) and consumption
  readout (from x ≈ 800).
- y: the native model badge covers the top of the area to y ≈ 64; at y 72 the
  gauge mask's top-left corner is already lit; 440 is where the mask's lower
  falloff starts.

`--safe WxH+X+Y` writes another (at least 16x16, inside the frame), `--safe
full` the whole frame; `--res` scales the default. `patchd` reports `res` and
`safe`, and the app offers Enable map when either differs from the default.
A high-panel binary with stock geometry reads as partially patched.

## Activation

The running CarPlay keeps its old binary until it next starts. A `systemctl
stop` or `restart` of `carplay.service` power-cycles the head unit: CarPlay
dumps core on SIGTERM. Two more things restart the head unit when CarPlay
ends:

- recmgr, when a service its restart list (read only at boot) does not name
  fails or exits;
- the firmware's `carplay.service` has `OnFailure=mediaddpserver_kill.service`,
  which runs `kill -s SIGQUIT $(pidof mediaddpserver)`. `mediaddpserver`
  dumps core on it, and recmgr and crashhandler, on neither of whose
  `[Whitelist]` it is, request a head-unit restart. Any failed end of a
  CarPlay run does this, a SIGKILL included, whatever recmgr's list says.

So `patchd` restarts CarPlay itself only when both are in effect:

- `carplay` is in both `[Whitelist]` and `[WhitelistExitSuccess]` of
  `/etc/recmgr-restartlist.conf` as recmgr loaded it this boot (the file
  while it is older than the boot, else the deploy tool's copy taken at
  boot; `recmgr_list.js`);
- systemd loaded the tool's drop-in
  `/etc/systemd/system/carplay.service.d/50-waze-on-cluster.conf`
  (`systemctl show carplay.service -p DropInPaths` names it), whose
  `SuccessExitStatus=SIGKILL` makes the kill a successful exit: the unit
  does not fail and `OnFailure=` does not run. The deploy tool writes it at
  install and removes it at removal, each with a `daemon-reload`.

`carplay.service` has no `Restart=`, so `patchd` starts it itself: it
records the running CarPlay's `InvocationID` in
`/dev/shm/waze-on-cluster/carplay-killed` (boot recovery does not count the
end of that run as a crash), SIGKILLs its main PID, waits for systemd to
reap it, runs `systemctl start carplay.service` and waits for `is-active`. No main PID, a
failed start or a unit that stays inactive is an error, never a fallback to
stop or restart.

Otherwise a change is deferred:

- the binary is written (backup, verify, atomic rename) with `/` read-write
  only for the write, and the running binary is kept hard-linked as
  `<target>.woc-running`, so no replaced file stays open and `/` can return
  to read-only;
- `/dev/shm/waze-on-cluster/activation-pending`
  (`{"action":"apply"|"revert","reason":…}`, 0644, readable by the app while
  `patchd` is not running) marks it until the next start;
- `patchd` reports `carplay: deferred` and `pending: apply|revert`; the app
  shows `Patch pending — reboot to activate` or
  `Removal pending — reboot to finish` and a **Restart head unit** button.

A change that puts back the bytes CarPlay is running moves the kept link
back to `<target>`; nothing is pending.

**`reboot`.** `patchd` takes `{"cmd":"reboot"}` only while a change is
pending and no other operation runs, once, and answers with `reboot-reply`.
It runs `systemctl reboot`, never a CarPlay stop or restart.

### The `.woc-running` link

It exists only while a process runs the binary it links and that binary is
not `<target>`'s own file:

| When | What happens to it |
|---|---|
| a change is written while CarPlay runs `<target>` | created; kept while CarPlay runs it |
| a change puts CarPlay's running bytes back | moved back to `<target>` |
| `patchd` restarts CarPlay | removed |
| `patchd` starts, or any later write window | removed once nothing runs it |
| the tool is removed | `deactivate` removes one that holds nothing; a held one goes to the deploy tool (`"removeWhenUnused"`), which removes it once nothing runs it, at the latest at a later start |

It never outlives its process by more than one head-unit start.

### Install-time activation

The deploy tool (`mgu-deploy` 0.7.0 and later) runs `patchd.js activate` as
root after each install and update, and `patchd.js deactivate` before a
removal deletes anything. Both write as above under the shared remount lock
and **never stop, kill or restart CarPlay**, even where recmgr would allow
it. The hook's last stdout line, `{"status":…,"reboot":"patch written; takes
effect at the next head-unit start"}`, makes the deploy tool mark a restart
pending, which the Store shows.

| On disk | `activate` | `deactivate` |
|---|---|---|
| the pristine proven build, no backup of ours | applies Enable map's patch (pending) | nothing |
| a build outside the proven list, no backup of ours | nothing: a conflict (`untested carplay build`) | nothing |
| a patch of ours, any configuration | brings it to Enable map's (pending), or nothing if it is already | reverts our edits (pending), drops our backup |
| the original with our backup (Disable map was used) | nothing: the map stays off | drops our backup |
| a change already pending | nothing (still reports the restart); after a removal's revert, applies again (a build outside the proven list stays reverted: a conflict) | a pending apply is undone (nothing pending); a pending revert becomes the removal's; our backup goes |
| a patch of ours plus another tool's edit elsewhere | updates ours, keeps theirs | reverts ours, keeps theirs, drops our backup |
| a build with an edit site not found or not recognised | nothing: a conflict | with our verified backup of the same build differing from it (`restorable`), writes the backup whole (pending) and drops it; else nothing |
| a proven build modified by something else, or any build with one of our edits and no backup of ours | nothing: a conflict | nothing (the patcher refuses) |
| `carplay.service` starting another program (an `ExecStart` in a unit or drop-in under `/etc` or `/run/systemd/system`) | nothing: a conflict | reverts our patch |

A conflict is not a failure: the hook exits 0 with `conflict` in its result,
`patchd` reports it, and the app shows it with Enable map, which applies only
on request (the patcher still refuses a binary it cannot patch). A hook exits
non-zero only when it changed nothing and could not do its job (`/` would not
remount, the patcher failed), so the deploy tool rolls the install back or
keeps the tool installed. Once the binary is written the hook exits 0, even
if `/` stayed writable (the next boot mounts it read-only).

Removal drops the backup (`carplay_patch.js revert --drop-backup`), so a
later install patches like a fresh one.

**Removal.** The Store removes the app, then the tool. After `deactivate`
the deploy tool stops and removes the tool's units, recmgr entries and
`/var/opt/waze-on-cluster`; the renderer releases the map's slot, and the
capture restores the DLT tracing mode as it stops.

## Reversibility

Before the first edit the patcher writes the backup under a temporary name and
checks it, writes the record of the original (SHA-256, build-id and version)
to `<target>.woc-orig.json` in full by rename, and then renames the backup to
`<target>.woc-orig`: a backup never exists without its record. The
temporary files of an apply cut short go at the next first edit and at a
removal (`revert --drop-backup`). `apply`
re-checks the backup: its recorded SHA-256, a pristine build (above), and the
same build as the target (size, build-id and every site). The stock geometry
`apply` writes back (`--res stock`, `--panel mid`) is the backup's.

`revert` needs no locator to trust the backup: its SHA-256 and GNU build-id
must be the recorded ones (each when recorded). The target is the backup's
build when both have the same build-id and size, or, when either has no
build-id, the same size and at most 200 bytes apart (twice the edits'
bytes). When the locator recognises the target and the backup as the same
build, `revert` restores only the edits' regions, so another tool's change
elsewhere stays, and confirms all four edits read original. Otherwise, over
the backup's build, it writes the whole backup: that undoes a patch any
version of this tool wrote, also one whose sites the locator now refuses.
Over another build (a firmware update) it refuses; `revert --force` writes
the whole backup there too. A backup without a record (an older release's)
is written whole only when the locator reads it as the pristine build or it
has the target's size, `--force` or not. `status` prints `restorable: yes`
when the revert would change the target, else `no` with why. Every write is
an atomic rename.

## Boot recovery

A CarPlay crash reboots the head unit with the patched binary still on
disk: a boot loop with no HMI to turn the map off. A crash (a core dump, or
a watchdog timeout) fails `carplay.service`, so its `OnFailure=` restarts
the head unit ("Activation"), and the core dump goes to crashhandler. Its
`[Whitelist]` is in `/etc/crashhandler-restartlist.conf` (the default of
`Restart/RestartListPath`, which `/etc/crashhandler.ini` does not set), a
list of its own, not recmgr's, and the firmware's has no `carplay`; the
recmgr entry and the drop-in do not prevent it; the drop-in adds SIGKILL
to the exits that count as successful, not a core dump. Boot recovery
restores the original binary after repeated crashes, before CarPlay
starts.

**How the head unit goes down.** recmgr (and crashhandler, for a core dump)
asks the NodeStateManager for a fast shutdown; it runs
`var-opt-ro.service`, which syncs and remounts `/var/opt` read-only, and the
IOC then resets the SoC. systemd stops no service: there is no SIGTERM, no
`ExecStop` and no `shutdown.target`. A switch-off takes the same path. So no
service sees a crash reboot, or a switch-off, as a stop.

**What is recorded.** `/var/opt/waze-on-cluster/boot-recovery.json`, written
whole: a temporary file, fsync'd, renamed over it. A write that fails leaves
the previous state as it was. It holds:

- `fails`: crashes of the patched CarPlay since the last head-unit start in
  which CarPlay ran and did not crash;
- `arm`: this start's record, `{boot, crashes, confirmed, clean}`, kept
  while our backup `<target>.woc-orig` exists;
- `starts`: the CarPlay starts made this boot;
- `ended`: the last CarPlay run whose end was handled.

An `arm` written by 0.7.5 and earlier (`{boot, state}`) is read as the same
record.

`shutdown_mark.sh`, run by a drop-in for `var-opt-ro.service`
(`50-waze-on-cluster.conf`) before `/var/opt` goes read-only, writes
`<boot id> running|failed|stopped` to `/var/opt/waze-on-cluster/shutdown`
from `carplay.service`'s `ActiveState` and `Result`; `failed` is any
`Result` other than `success`. It writes nothing if `systemctl` does not
answer within 3 s, and always exits 0, so it never holds up the remount.
CarPlay is not a NodeStateManager shutdown client and nothing stops it at a
shutdown, so a switch-off records `running`.

**The boot step** (`recovery.js boot`, `waze-on-cluster-boot.service`, a
oneshot wanted by `multi-user.target`, `Before=carplay.service`, which
`late.target` starts after `multi-user.target`). The previous start adds its
`crashes`, or one when its shutdown record says `failed` and none were seen.
With none, it clears the counter if CarPlay ran 60 s continuously, keeps it
if CarPlay was running or stopped at the shutdown, or was stopped by an
orderly shutdown (SIGTERM while the system stops), and otherwise adds one (it
ended with no record, e.g. power lost). Without our backup it clears the
counter and exits; below the threshold (2) it arms this start and exits.
When it cannot save the arm, it restores at once, whatever the count.
Neither reads the 3.5 MB binary, so CarPlay waits about the time Node takes
to start. At the threshold it classifies the binary and restores the
original before CarPlay starts, in seconds. Every command a restore runs is
bounded, so the restore ends within 91 s; CarPlay waits for the step 120 s
at most (`TimeoutStartSec`), and that only when those commands hang. CarPlay
does not require the step: it starts when the step has exited, failed or
timed out. The step exits 0 whatever happens, and it is in recmgr's lists, so
a timeout does not reboot the unit. Its `RequiresMountsFor=/var/opt` adds no
wait to CarPlay: `/var/opt` is mounted from fstab before `local-fs.target`,
which CarPlay is already ordered after.

**The watcher** (`recovery.js`, `waze-on-cluster-recovery.service`, after
the boot step) follows CarPlay by run (systemd's `InvocationID`). While a
run is active it checks every second that its main PID is in `/proc` and
asks systemd every 5 s, or at once when the PID is gone; while CarPlay is
down it asks every 5 s. A run that ended `failed` (a `Result` other than
`success`) is a crash, counted once per run, also when it ended before the
watcher first looked: unless `patchd` killed that run to activate a change
(it records the run's `InvocationID` in
`/dev/shm/waze-on-cluster/carplay-killed`), or the system is stopping. A
run a SIGKILL ended under the drop-in ends `success` (`ExecMainCode=2`,
`ExecMainStatus=9`) and is no crash either; unless `patchd` killed it (it
starts CarPlay itself) or the system is stopping, the watcher starts CarPlay
again, as after a crash below. A run that exited by SIGTERM or with code 0
is left as it is.
The crash is written to `arm` at once, before anything else, since the next
moment can be the reboot. When that write fails, the watcher restores a
restorable patch at once, whatever the count; this boot's crashes and
starts are also kept in memory, so an unwritable state file does not lift
the start limit.

Otherwise the watcher only records the crash, and the boot step restores at
the next start. Where recmgr loaded its `carplay` entry this boot and the
head unit stays up, for a patched binary at `fails` plus this start's crashes ≥
2 the watcher restores the original, then starts CarPlay with `systemctl
start carplay.service`, 5 s, 15 s and 60 s after a crash, at most three
times per head-unit start, only while CarPlay is down, the system is not
stopping and `patchd` does not hold the remount lock. The run it starts is
probed at the next tick. A run active for 60 s marks the start healthy. The
watcher also runs the boot step's logic at its own start, so a start whose
boot step did not run or finish is counted, and a restore it left undone is
retried. A stop waits for a restore in progress.

**Restoring** is the `carplay_patch.js revert` Disable map uses (a
verified backup of the target's own build, above), with `/` read-write only
for the write and read-only again after. CarPlay counts as patched, for the
counter and the restore, when `status` reads `restorable: yes`: whatever the
locator makes of the binary, so a patch any version of this tool wrote is
counted and restored. A stock or firmware-replaced binary is left alone and
the counter cleared. The
watcher keeps the patched binary linked as `<target>.woc-running`, since
CarPlay could start between its check and the rename; the boot step, which
CarPlay waits for, links it only if a process runs it. `patchd` removes a
link nothing runs. A
shared remount lock (`remount_lock.js`) keeps it and `patchd` from remounting
`/` at once; recovery yields to `patchd`. Recovery never stops, kills,
restarts or reboots anything; its only action on a service is the start
above.

**Failed.** A binary with Edit 3 (self-start) is counted as patched even
when `status` reads `restorable: no` (the backup is not a verified original
of its build), so its crashes count and are not taken for a stock binary.
At the threshold such a binary cannot be restored: recovery writes
`failed: {since, boot, fails, why}` to the state, logs an ERROR at every
boot step and crash, schedules no CarPlay start of its own (after a crash or
a SIGKILL), and `patchd` adds `failed` (the reason text) to its status, which
the app shows as its status line. CarPlay is left as it is: writing anything
else over it, or stopping or masking `carplay.service`, could leave the head
unit worse off than a crashing CarPlay, and stopping the render would not
stop the crash (it is in CarPlay's own process). So where a crash restarts
the head unit (`OnFailure=`), only a restore by hand ends the loop. The mark
goes when CarPlay reads stock again, a backup restores it, a boot brings
`fails` below the threshold, or our backup is gone. (Kiro test change,
0.7.10.)

**By hand.** Keep the phone from connecting (unplug it, or turn off its
Wi-Fi and Bluetooth) so CarPlay has no session to crash in, then over SSH run
`sh /var/opt/waze-on-cluster/current/woc-patch.sh revert` and restart the
head unit.

## Tests

`make test` runs them all. The binary tests take `CARPLAY_BIN`, a copy of the
unit's carplay 22.28.3 (the SHA above), and are skipped without it; the
repository carries no BMW binary.

- `locate_test.js`: on synthetic builds written by `synthetic_carplay.js`
  (no BMW bytes), every site found, also at other offsets, addresses and code
  order and in its patched state; a signature found twice refused as
  ambiguous; damaged sites refused with their reason; apply, verify, probe
  and a byte-exact revert on a build outside the proven list. With
  `CARPLAY_BIN`, the sites are the offsets above.
- `mutation_test.js` (`CARPLAY_BIN`): the reference build perturbed in
  memory the way another build could differ (other addresses, a duplicated
  name string or converter, a decoy switch, swapped checks or builders, a
  third builder, a getter reading another field, inlining, a split-off part,
  a second or merged sink string, a relocation over an edit); each is found
  where it really is or refused, never found elsewhere.
- `patch_test.js`: the sites the probe reports, the SHA gate, `--unproven`,
  both panels, the sink inside its slot, the call retarget, region-bounded
  diffs, idempotence, partial patches (an Edit-1-only binary among them), the
  geometry and safe area, byte-exact revert, a binary of the backup's build
  the locator does not recognise restored whole, another build over the backup
  refused unless `--force`, a build outside the proven list, a backup of
  another build refused.
- `undo_test.js` (`CARPLAY_BIN`): builds an older release patched where the
  locator now refuses a site (`carplay_mutations.js`): `status` restorable,
  `revert` writes the original whole without `--force`, also with no
  record; a backup that is not the recorded original, or another build over
  it, refused; `apply` refused. `recovery_test.js`, `patchd_patch_test.js`
  and `patchd_activate_test.js` restore the same builds at the crash
  threshold, by Disable map and by the removal.
- `patchd_patch_test.js`, `patchd_activate_test.js`: `patchd` and both hooks
  on a copy, against a fake `/proc`, `mount`, `systemctl` and recmgr list:
  both activation branches (a restart only with the recmgr entry and the
  drop-in loaded), every row of the install table, the marker, the
  link's lifetime, `/` read-only after every path, and no `systemctl`, `kill`
  or `reboot` from the hooks.
- `recovery_test.js`: the counter across crash loops with orderly and fast
  shutdowns, the boot step's restore before CarPlay starts and its fast
  path, crashes per CarPlay run (before the first look, of a run the
  watcher started, after `patchd`'s kill), a SIGKILL that was not
  `patchd`'s (started again, no crash) and the exits left alone, the
  in-boot crash, restore and start with and without recmgr's entry, a state
  that cannot be saved (the previous one kept, a restorable patch restored
  at once, the start limit kept) and a folder that cannot be synced, a 0.7.5
  arm, what is not a crash, a stop during a restore,
  `shutdown_mark.sh` with a hung `systemctl`, the units' timeouts against
  the restore's bound, the remount lock and a real restore on a copy.
