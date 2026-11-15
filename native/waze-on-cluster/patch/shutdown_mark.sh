#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
# shutdown_mark.sh — run by var-opt-ro.service (drop-in
# 50-waze-on-cluster.conf) at each NSM shutdown of the head unit, before
# /var/opt goes read-only. recmgr's or crashhandler's restart after a crash
# and a switch-off are both an NSM shutdown that stops no service, so for
# boot recovery (recovery.js) it writes "<boot id> running|failed|stopped"
# for carplay.service to <state dir>/shutdown and for aapd.service to
# <state dir>/shutdown-aapd, followed by " crash" when recmgr or
# crashhandler asked for this restart (their restartInfo.xml, which each
# deletes at its start, is there and was written in this boot: not before
# /proc/stat's btime, not after now), " ran" when systemd started the
# service in this boot (ExecMainStartTimestampMonotonic above 0), and
# " up <s>", the boot's uptime.
# failed is a Result
# other than success, except a SIGKILL of aapd (Result signal, ExecMainCode
# 2, status 9; an oom-kill stays failed), which its watcher takes for no
# crash either: aapd.service has no SuccessExitStatus=SIGKILL, as
# carplay.service's drop-in gives carplay. It writes nothing for a service
# whose state cannot be read within WAIT seconds, and always exits 0, so it
# never holds up the remount.
DIR=${WOC_STATE_DIR:-/var/opt/waze-on-cluster}
BOOT_ID=${WOC_BOOT_ID:-/proc/sys/kernel/random/boot_id}
SYSTEMCTL=${WOC_SYSTEMCTL:-systemctl}
WAIT=${WOC_MARK_WAIT:-3}
SIN=${WOC_SIN_DIR:-/var/opt/public/sin}
UPTIME=${WOC_UPTIME:-/proc/uptime}
PROC_STAT=${WOC_PROC_STAT:-/proc/stat}

[ -d "$DIR" ] || exit 0
boot=$(cat "$BOOT_ID" 2>/dev/null) || exit 0

up=$(cut -d. -f1 "$UPTIME" 2>/dev/null)
case "$up" in ''|*[!0-9]*) up=0 ;; esac
now=$(date +%s)
since=$(sed -n 's/^btime //p' "$PROC_STAT" 2>/dev/null)
case "$since" in ''|*[!0-9]*) since=$((now - up)) ;; esac
crash=
for f in "$SIN/recmgr/restartInfo.xml" "$SIN/crashhandler/restartInfo.xml"; do
  # seconds, with a second of slack each way (busybox's stat -c, BSD's -f)
  t=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null) || continue
  [ "$t" -ge $((since - 1)) ] && [ "$t" -le $((now + 1)) ] && crash=" crash"
done

# mark <unit> <file> [sigkill-is-stopped]
mark() {
  # The unit has no timeout(1) on its path: systemctl runs in the background
  # and is killed after WAIT seconds.
  out="$DIR/$2.show"
  "$SYSTEMCTL" show "$1" -p ActiveState -p Result -p ExecMainCode -p ExecMainStatus -p ExecMainStartTimestampMonotonic > "$out" 2>/dev/null &
  pid=$!
  ( sleep "$WAIT"; kill "$pid" 2>/dev/null ) &
  guard=$!
  wait "$pid"
  status=$?
  kill "$guard" 2>/dev/null
  [ "$status" -eq 0 ] || { rm -f "$out"; return; }
  show=$(cat "$out")
  rm -f "$out"
  case "$show" in
    *Result=success*)
      case "$show" in
        *ActiveState=active*|*ActiveState=activating*|*ActiveState=reloading*) state=running ;;
        *) state=stopped ;;
      esac ;;
    *Result=*)
      state=failed
      if [ -n "$3" ] && printf '%s\n' "$show" | grep -qx 'Result=signal' && printf '%s\n' "$show" | grep -qx 'ExecMainCode=2' &&
         printf '%s\n' "$show" | grep -qx 'ExecMainStatus=9'; then
        state=stopped
      fi ;;
    *) return ;;
  esac
  # Renamed whole into place; var-opt-ro.service syncs /var/opt next.
  ran=
  case "$show" in *ExecMainStartTimestampMonotonic=[1-9]*) ran=" ran" ;; esac
  printf '%s %s%s%s up %s\n' "$boot" "$state" "$crash" "$ran" "$up" > "$DIR/$2.tmp" && mv -f "$DIR/$2.tmp" "$DIR/$2"
}

mark carplay.service shutdown
mark aapd.service shutdown-aapd sigkill
exit 0
