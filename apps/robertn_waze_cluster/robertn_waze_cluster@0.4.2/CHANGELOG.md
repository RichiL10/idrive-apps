# Changelog

## 0.4.2

Kiro test changes, not published and not yet run on a car. Enable map on a
CarPlay build outside the patcher's proven list first asks to confirm, and
only the confirmed press patches it. When boot recovery has marked the map
patch failed (CarPlay keeps crashing while patched and no backup can
restore it), the status line says so: "Map patch failed: CarPlay keeps
crashing and cannot be restored automatically. Unplug the phone and restore
CarPlay by hand", from waze-on-cluster 0.7.10 on. waze-on-cluster 0.7.10
needs this version to enable the map on a build outside the proven list
(an older app gets a refusal), so install the two together. A confirming
press less than a second after the first (a doubled event) is ignored.

## 0.4.1

While CarPlay's stream is live but shows no map, the status says why, from
waze-on-cluster 0.7.2 on: "Stream lost — reconnect CarPlay", or "Stream
lost — restarting CarPlay" where the tool restarts CarPlay itself.

## 0.4.0

The page says to set Instrument cluster > Central display area to Map view:
the Waze map replaces the stock map while CarPlay streams it, and the stock
map is back when the stream ends or freezes. A frozen stream shows "Map
frozen — reconnect CarPlay". Requires waze-on-cluster 0.6.0.

## 0.3.1

The page says to set Instrument cluster > Central display area to Off: with
Map view, Route preview or Assisted Driving View there, the cluster shows its
own content in the centre instead of the map.

## 0.3.0

Installing the app from the Store installs the Waze tool and the cluster
renderer too. The tool writes the CarPlay patch as it installs, without
restarting CarPlay; until the next head-unit start the app shows "Patch
pending — reboot to activate". Enable map appears only when the patch is
off, unknown or out of date, Disable map only when it is on. When the install
leaves CarPlay unpatched (an unknown CarPlay build, or another tool starting
CarPlay), the app says why and offers Enable map. The Store can remove the
app and then the Waze tool, which restores CarPlay.

## 0.2.11

When a patch change waits for the next head-unit start, the app says so and
offers a Restart head unit button. A boot recovery service restores the
original CarPlay binary after repeated failed starts with the patch.

## 0.2.10

The map appears on the cluster by itself when CarPlay streams it and goes
away when the stream stops; there is no Show or Stop button. Disable map
turns the feature off.

## 0.2.9

Enable map sets the area where the phone places its guidance, so Waze's
next-turn banner stays visible between the gauges. Units patched with a
full-frame area are prompted to update.

## 0.2.8

The map is drawn in the cluster's native map area (1088x480), under the
gauges. Units patched at another size are prompted to Enable map again.

## 0.2.7

Enable map applies a single patch configuration, including the size the
phone renders the map at. Units on another panel setting are prompted to
update.

## 0.2.6

Enable map uses a single capture path; the capture mode row is removed.
Capture logs has its own button.

## 0.2.5

The status line reads "Patch state unknown — enable the map" until the patch
daemon reports, so the page opens cleanly.

## 0.2.4

After Enable map, the cluster stream starts with the CarPlay session. A patch
waiting for the next head-unit start reads "Patch pending — …".

## 0.2.3

The diagnostic capture window is up to 5 minutes.

## 0.2.2

Capture mode offers a UDP stream sink.

## 0.2.1

Capture logs: a bounded DLT capture, with its status and an early stop.

## 0.2.0

A capture mode choice for Enable map.

## 0.1.0

First release: a page to apply and revert the CarPlay patch, show and stop
the map on the cluster, and read both tools' logs.
