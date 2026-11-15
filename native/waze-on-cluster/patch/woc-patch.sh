#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
# woc-patch.sh — run the reversible carplay patch on the unit with / remounted
# read-write, then read-only again on any exit: the patch by hand, for
# experiments. Run it deliberately, with the car parked and on stable power.
#
#   woc-patch.sh status
#   woc-patch.sh probe [<file>]                 # where the edit sites are, read-only
#   woc-patch.sh apply  high|mid                # all edits + udp:// stream sink (default)
#   woc-patch.sh apply  high|mid --capture      # all edits + file:// FIFO sink
#   woc-patch.sh apply  high|mid --sink <url>   # all edits + an explicit sink url
#   woc-patch.sh apply  high|mid --avb          # all edits, stock avb:// sink (the app's mode)
#   woc-patch.sh apply  high --res <WxH|stock>  # the display size advertised to the phone
#                                               # (default 1088x480; goes with any sink form)
#   woc-patch.sh apply  high --safe <WxH+X+Y|full>  # the safe area the phone keeps its
#                                               # guidance UI in (default 504x368+286+72)
#   woc-patch.sh apply  high|mid --unproven     # also the first patch of a build outside
#                                               # the proven list, and a patch on a car
#                                               # not coded KI_KOMBI_VARIANT 7 (PATCH.md)
#   woc-patch.sh revert
#   woc-patch.sh verify
#
# After apply/revert, carplay must start again to load the new binary. This
# script does NOT stop or start carplay (recmgr and MainApp timing are the
# unit's to manage); it prints how. The running carplay keeps the old binary
# until then, so nothing changes mid-session.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PATCHER="$HERE/carplay_patch.js"
TARGET=${WOC_CARPLAY:-/usr/bin/carplay}
NODE=$(command -v node || echo /usr/bin/node)
MOUNT=$(command -v mount || echo /bin/mount)

[ -f "$PATCHER" ] || { echo "error: $PATCHER not found" >&2; exit 2; }

# How a written binary takes effect: carplay must start again. A systemd stop or
# restart of carplay.service power-cycles the head unit, and so does any carplay
# death unless recmgr loaded "carplay" in both [Whitelist] and
# [WhitelistExitSuccess] of /etc/recmgr-restartlist.conf at this boot.
activation() {
    echo "It takes effect at the next head-unit start. Only if recmgr loaded carplay"
    echo "in both restart lists at this boot, it can start now (car parked):"
    echo '    pid=$(systemctl show carplay.service -p MainPID --value)'
    echo '    [ "$pid" -gt 0 ] && kill -9 "$pid" && systemctl start carplay.service'
    echo "Never systemctl stop/restart carplay.service."
}

cmd=${1:-}; [ $# -gt 0 ] && shift || true

case "$cmd" in
  status)  exec "$NODE" "$PATCHER" status --target "$TARGET" ;;
  verify)  exec "$NODE" "$PATCHER" verify --target "$TARGET" ;;
  probe)   exec "$NODE" "$PATCHER" probe "${1:-$TARGET}" ;;
  apply)
    panel=${1:-}; [ $# -gt 0 ] && shift || true
    usage='usage: woc-patch.sh apply high|mid [--capture | --sink <url> | --avb] [--res <WxH|stock>] [--safe <WxH+X+Y|full>] [--unproven]'
    [ "$panel" = high ] || [ "$panel" = mid ] || { echo "$usage" >&2; exit 2; }
    # Default sink: the udp:// stream the projection bridge accepts. --capture
    # uses the file:// FIFO; --sink <url> an explicit url; --avb leaves the stock
    # sink. --res picks the advertised display size and --safe its safe area
    # (the patcher validates both).
    # Every form applies every edit. An unknown argument is an error, not a
    # silent default.
    # (The app drives patchd for the no-SSH path; this is the manual tool.)
    capture="--sink udp://127.0.0.1:20557?mime_type=video/H264"
    res=
    safe=
    unproven=
    while [ $# -gt 0 ]; do
      case "$1" in
        --avb) capture= ;;
        --capture) capture="--capture /run/waze-on-cluster/alt.h264" ;;
        --sink) [ -n "${2:-}" ] || { echo "$usage" >&2; exit 2; }; capture="--sink $2"; shift ;;
        --res) [ -n "${2:-}" ] || { echo "$usage" >&2; exit 2; }; res="--res $2"; shift ;;
        --safe) [ -n "${2:-}" ] || { echo "$usage" >&2; exit 2; }; safe="--safe $2"; shift ;;
        --unproven) unproven=--unproven ;;
        *) echo "$usage" >&2; exit 2 ;;
      esac
      shift
    done
    # Remount / read-write only for the write window; restore read-only on exit.
    trap 'sync; "$MOUNT" -o remount,ro / 2>/dev/null || true' EXIT INT TERM HUP
    "$MOUNT" -o remount,rw /
    # shellcheck disable=SC2086
    "$NODE" "$PATCHER" apply --panel "$panel" $capture $res $safe $unproven --target "$TARGET" --yes
    echo
    echo "Patched. $(activation)"
    echo "Revert any time with: woc-patch.sh revert"
    ;;
  revert)
    # Pass through extra flags (e.g. --force to restore over another carplay
    # build; the patcher refuses that without it).
    trap 'sync; "$MOUNT" -o remount,ro / 2>/dev/null || true' EXIT INT TERM HUP
    "$MOUNT" -o remount,rw /
    "$NODE" "$PATCHER" revert --target "$TARGET" --yes "$@"
    echo
    echo "Reverted. $(activation)"
    ;;
  *)
    echo "usage: woc-patch.sh status|probe [<file>]|apply high|mid [--capture|--sink <url>|--avb] [--res <WxH|stock>] [--safe <WxH+X+Y|full>] [--unproven]|revert|verify" >&2
    exit 2 ;;
esac
