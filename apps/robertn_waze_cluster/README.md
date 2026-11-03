# robertn_waze_cluster

The HMI app for [waze-on-cluster](../../native/waze-on-cluster), which shows
the CarPlay cluster map (Waze, Apple Maps or Google Maps) on the instrument
cluster of an iDrive 7 (MGU) head unit. Everything is done from the HMI; no
shell is needed.

Install it from the catalog of
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps)
through the [mgu Store](https://github.com/robertnisipeanu/mgu-store). It requires
waze-on-cluster 0.6.0, which brings the cluster renderer and writes the
CarPlay patch as it installs; one head-unit start activates it. After that
the map is on the cluster whenever CarPlay streams it, whether or not this
app is open.

Set **Instrument cluster > Central display area** to **Map view**: the Waze
map replaces the stock map while CarPlay's cluster stream shows a map, and
the stock map is back when the stream ends or shows none. Until a navigation
app draws on the cluster (in Waze or Google Maps, once a route starts), the
stock map stays and the page shows `Waiting for the phone's map — start
navigation`. **Off** works too, with an empty centre
instead of the stock map. With Route preview or Assisted Driving View the
cluster's own content takes the centre. After changing the setting, CarPlay
may need reconnecting before the map returns: the change can freeze the
phone's cluster stream, and the page then shows `Map frozen — reconnect
CarPlay` while the stock map (in Off, an empty centre) shows.

To remove, remove the app in the Store, then the Waze tool, which reverts
the patch.

## The page

One `LT_State_Wide` page:

| Row | What it does |
|---|---|
| status | the patch and map state: `Patch pending — reboot to activate`, `Removal pending — reboot to finish`, `Original — enable the map`, `Not patched — <reason>`, `Applying patch…`, `Patched — waiting for CarPlay`, `Waiting for the phone's map — start navigation`, `Stream lost — reconnect CarPlay`, `Starting map…`, `Showing: Waze map — 16 frames/s …`, `Map frozen — reconnect CarPlay`, `Map error: …`, `Patch service unavailable (reboot may be needed)`, `Map patch failed: CarPlay keeps crashing and cannot be restored automatically. Unplug the phone and restore CarPlay by hand` |
| setup | `Set Instrument cluster > Central display area to Map view`, always shown |
| Enable map | applies the patch; shown while it is off, unknown or out of date and no change is pending |
| Disable map | reverts the patch, which turns the map off; shown while patched and no change is pending |
| Restart head unit | a normal system reboot; shown only while a written change waits for the next head-unit start |
| Capture logs (5 min) / Stop capture | a bounded DLT capture for diagnostics; start it, then reconnect CarPlay |
| 30 rows | both tools' log lines, newest first, tagged `map:` / `patch:` |

`Starting map…` shows while the cluster renderer starts; a map error shows
only when the renderer stays unreachable for 15 s. Before the patch daemon
runs (right after the install), the pending patch is read from
`/dev/shm/waze-on-cluster/activation-pending`.

## The sockets

Unix stream sockets, newline-delimited JSON, group `tm_oap_app`. The app
holds them while its page is visible and retries each once a second; the
tools keep running when it closes them.

- **Render** `/dev/shm/waze-on-cluster/ctl.sock`, read-only:
  `{"ev":"status","state","target","page","reason","upload_cap_kb_per_s","upload_reason"}`
  (`state` idle, starting, showing, frozen or error), `{"ev":"log","line"}`.
- **Patch daemon** `/dev/shm/waze-on-cluster/patch.sock` (root). The app sends
  `{"cmd":"apply","panel":"high","mode":"avb"}`, `{"cmd":"revert"}`,
  `{"cmd":"reboot"}`, `{"cmd":"capture-start"|"capture-stop"}`. The daemon sends
  `{"ev":"status","state","panel","mode","res","safe","carplay","reason","pending","conflict"}`
  (`state` original, patched, unknown, busy or error; `carplay: "deferred"`
  while a change waits for the next start; `unproven: true` for a CarPlay
  build outside the proven list, which Enable map patches only after the
  user confirms, sending `"unproven":true`; `failed`, the reason, while boot
  recovery has marked the patch failed), `{"ev":"capture",…}`,
  `{"ev":"reboot-reply","ok","reason"}` and `{"ev":"log","line"}`.

A patch with another sink, panel, size (not `1088x480`) or safe area (not
`504x368+286+72`) shows `Patched — Enable map to update the patch`.

## Build and test

```sh
node tools/test_control.js           # the socket client against fake sockets
node tools/test_page.js              # the page against a fake SDK and HMI
node tools/build.js                  # robertn_waze_cluster@0.4.2.src.tgz
node tools/build.js --sdk <donor>    # also robertn_waze_cluster@0.4.2.tgz
```

The app ships as a source package (`mgu-app.json`; `"build": "unit"` in the
catalog). The repository carries no oap-sdk, which is BMW's: the head unit's
deploy tool links the app against the unit's own oap-sdk and takes the
package's entry point from the unit's own packages. To build the OAP tgz
locally, pass a donor bundle with `--sdk` (or `MGU_SDK_DONOR`), for example
the one `mgu-deploy.sh sdk-donor` takes from the unit. The tests need no
donor.

`node tools/fakes.js <render.sock> <patch.sock>` runs both fakes by hand;
Enter starts or stops a fake CarPlay stream.

| Path | |
|---|---|
| `src/robertn_waze_cluster.js` | the app |
| `src/waze_cluster_control.js` | both socket clients and the status logic |
| `tools/` | build, fakes, tests, icon |
| `robertn_waze_cluster@0.4.2/` | the package tree (manifest, RHMI UI, config) |

## License

GPL-3.0-or-later (`LICENSE`). Third-party files keep their own licenses.
