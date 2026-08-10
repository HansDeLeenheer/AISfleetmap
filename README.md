# Fleet AIS map

A live map of a fleet of ships. The map is a static page on **GitHub Pages**; live positions come
from a small **always-on collector** that holds one connection to the free
[aisstream.io](https://aisstream.io) AIS stream and serves a fresh last-known snapshot to every
visitor. No AIS key in the browser, one upstream connection no matter how many people watch.
Optional MongoDB persistence adds durable last-known and full position history.

Built for **The Tall Ships Races Antwerpen 2026**, but it works for any fleet: edit the ship list,
deploy the collector with your own key.

- Map: https://waarzijndetallships.be (also https://hansdeleenheer.github.io/AISfleetmap/)
- Collector: https://aisfleetmap-9hnpn.ondigitalocean.app

## Architecture

```
aisstream.io ──ws──▶ collector (server/, always-on, 1 instance) ──HTTP /positions.json──▶ browsers
                       key in host env (+ optional MONGODB_URI)      page polls every 10s
                                    │
                              MongoDB (optional): last-known + full history; seeds on startup

GitHub Pages serves the static index.html + ships.json (custom domain optional)
```

- The collector is the single live source. It holds one aisstream WebSocket, keeps each ship's
  last-known position in memory, and serves it over HTTPS with CORS open so the static page can
  fetch it cross-origin.
- The browser never touches aisstream and never holds the key; it just polls the collector. This
  is required, not just tidy: aisstream's free tier limits concurrent connections per key, so a
  per-browser design 429s as soon as two people open the map. One shared collector avoids that.
- With `MONGODB_URI` set, the collector persists to Mongo and seeds its memory from it on startup,
  so a restart comes back full and history accrues. Without it, the collector is in-memory only.

## Repository layout

| Path | Role |
|---|---|
| `index.html` | Self-contained Leaflet map. Set `COLLECTOR_URL` near the top of the script. Polls `<url>/positions.json` every 10s, draws markers, auto-fits to the fleet until the user interacts, click-to-zoom, mobile bottom-sheet. Nautical basemap (Esri Ocean < z13, CARTO Voyager >= z13) + OpenSeaMap seamarks, km/nautical scale bar, and the route view below. |
| `ships.json` | The fleet (source of truth). See data model below. The one data file you normally edit. |
| `server/collector-service.mjs` | The always-on collector. One aisstream connection, in-memory store, optional Mongo. Serves `/positions.json`, `/track?mmsi=`, `/health`, `/`. |
| `server/package.json` | Collector deps: `ws`, and `mongodb` (used only when `MONGODB_URI` is set). |
| `.do/app.yaml` | DigitalOcean App Platform spec for the collector. |
| `CNAME` | GitHub Pages custom domain. |
| `positions.json` | Empty placeholder; only fetched as a static fallback when `COLLECTOR_URL` is empty. Not part of the live path. |

## Data model

**`ships.json`** — `{ source, event, ships: [...] }`. Each ship:

| Field | Notes |
|---|---|
| `name` | Display name. |
| `mmsi` | 9-digit AIS id (string). The join key everywhere. Required. |
| `klasse`, `lengte`, `land` | Class (A-D), length band, country (drives the flag emoji in the page). |
| `callsign`, `imo` | Optional, shown in the popup. |
| `description`, `website` | Optional, shown in the popup (`website` opens in a new tab). |
| `active` | Optional, default `true`. `false` = still tracked and recorded, but excluded from `/positions.json` and from the page list/map (see gotchas). |

**Collector snapshot** (`GET /positions.json`): `{ generatedAt, positions: { <mmsi>: { mmsi, name, lat, lon, sog, cog, hdg, t } } }`. `t` is the AIS fix time (ISO). Only `active` ships are included.

**MongoDB** (when enabled), db `aisfleetmap` (override with `MONGODB_DB`):
- `positions`: last-known per ship, `_id = mmsi`, `{ name, lat, lon, sog, cog, hdg, t, updatedAt }`.
- `tracks`: position history, `{ mmsi, name, lat, lon, sog, cog, hdg, t }`, indexed `{ mmsi, t }`.
  Thinned on write: a fix is skipped only when the ship is under 0.2 kn **and** within 30 m of the
  last *stored* fix **and** less than 15 min since it. Distance is measured from the last stored
  fix, so slow drift accumulates and is sampled rather than lost, and every gate fails open. Cuts
  volume ~32% on real data (a berthed ship transmits every 3 min and jitters by ~2 m). The
  `positions` upsert is never skipped, so last-known and departure detection are unaffected.

## Collector HTTP endpoints

- `GET /positions.json` — snapshot of active ships (what the page polls). CORS `*`, no-store.
- `GET /track?mmsi=<mmsi>[&days=N][&limit=N]` — that ship's recorded history (needs Mongo; empty
  otherwise), oldest-first. `days` counts back from the ship's **own newest stored fix**, not from
  now, so the window still resolves while the upstream feed is down. `limit` defaults to 5000
  (max 20000) and trims the **old** end: the query sorts newest-first and reverses.
- `GET /health` — `ok`.
- `GET /` — status: `{ service, tracking, active, located, served, generatedAt, persistence }`.
  `persistence` is `"mongodb"` or `"in-memory"`; `tracking` = all ships, `served` = active ships with a fix.

## Route view

The header checkbox draws each ship's last 5 days as a tail in her class colour; every popup has
the same checkbox for one ship on its own, and the header box goes indeterminate when only some are
shown. Needs Mongo (it reads `/track`).

Tails distinguish what was **tracked** from what is **inferred**, which matters more than it sounds:
the free feed delivers only ~8% of an underway ship's transmissions, so consecutive fixes are often
hours and hundreds of km apart, and a naive polyline draws confident routes straight over land.

- A leg longer than **5 km** between consecutive fixes is drawn as a 1px hairline; tracked stretches
  are 3.5px. On real data that is ~59% of total line length.
- The split is on **distance, not elapsed time**. A time threshold cuts the line wherever delivery
  stuttered, shattering a continuously-followed leg into visual dashes (1129 breaks vs 118 for the
  same data), and it lets a fast ship cover any distance under the limit. Distance bounds the worst
  falsely-solid leg at the threshold itself and leaves a ship sitting in port unbroken.
- A tail is suppressed entirely when the history ends more than 6h before the ship's last-known
  position, which means the history is truncated and the tail would be drawn nowhere near her.

## Setup

### 1. Fleet
Edit `ships.json`. Each ship needs at least `name` and `mmsi` (look MMSIs up on vesselfinder.com /
marinetraffic.com, matching on name + country + type). Set `"active": false` to hide a ship from
the map without losing tracking (a ship no longer attending, so it can't drag the map to a far-away
position when it powers on its AIS).

### 2. Deploy the collector (the live source)
On **DigitalOcean App Platform** (spec: `.do/app.yaml`):

1. DO console → Apps → Create App → your GitHub repo.
2. **Source Directory = `/server`** so DO detects the Node web service (not a static site).
   Confirm: Resource type **Web Service**, Run command **`npm start`**, HTTP port **8080**.
3. **Instance count = 1** (critical, see gotchas). Smallest instance size is plenty (~50 MB used).
4. Add env var **`AISSTREAM_API_KEY`** (free key from aisstream.io), tick **Encrypt**.
5. **Turn off "Autodeploy on push"** (see gotchas). You deploy manually when `server/` changes.
6. Deploy. You get an HTTPS URL like `https://<app>.ondigitalocean.app`. Runs anywhere Node runs;
   App Platform just provides HTTPS for free.

### 3. Optional: persistence + history (MongoDB)
Set `MONGODB_URI` to make the collector durable and record history. Fully opt-in; leave it unset and
the collector runs in-memory exactly as before (forks that just want a live map need nothing).

1. **Allowlist the collector on the DB first.** A managed DB (e.g. Atlas) blocks unknown IPs. The
   collector's *outbound* IP is the App Platform **egress** IP, which is **not** the app's ingress
   IP shown in Settings, and not your laptop's (so Compass working proves nothing). Add `0.0.0.0/0`
   to the DB network-access list (the DB still requires credentials; AIS data is public), or enable
   a Dedicated Egress IP on the DO app and allowlist that. A wrong allowlist shows as
   `SSL alert number 80` in the logs (Atlas rejects non-allowlisted IPs at the TLS handshake).
2. Add env var `MONGODB_URI` (encrypted) to the `collector` component. Optionally `MONGODB_DB`.
3. **Redeploy** the collector (it connects to Mongo once, at startup).
4. Verify in Runtime Logs: `MongoDB connected (aisfleetmap); seeded N last-known, history enabled`,
   and `GET /` shows `"persistence":"mongodb"`. Collections are created automatically on first write.

If the DB is unreachable the collector logs `connection failed; continuing in-memory only` and keeps
serving the map (it never goes down over a DB problem).

### 4. GitHub Pages
Repo → Settings → Pages → Deploy from branch `main`, folder `/ (root)`.

### 5. Wire the page to the collector
In `index.html` set `const COLLECTOR_URL = 'https://<your-app>.ondigitalocean.app'` and push.
Live at `https://<user>.github.io/<repo>/`.

### 6. Custom domain (optional)
1. DNS at your registrar: apex `@` → four A records `185.199.108.153`, `.109.153`, `.110.153`,
   `.111.153`; `www` → CNAME `<user>.github.io`. If the registrar had domain **forwarding** on,
   turn it OFF (it frames the site and breaks the mobile viewport).
2. Repo → Settings → Pages → set the Custom domain (this commits `CNAME` and triggers the TLS cert;
   doing it in the UI is more reliable than the CNAME file alone). Wait for the cert, then tick
   **Enforce HTTPS**.

Pages routes a custom domain by the requested hostname, so it always lands on this repo regardless
of other Pages sites on the account.

## Local development

```bash
# the page (uses the deployed collector via COLLECTOR_URL, or positions.json if empty)
python3 -m http.server 8777          # open http://localhost:8777

# the collector
cd server && npm install
AISSTREAM_API_KEY=xxxxx node collector-service.mjs         # in-memory
AISSTREAM_API_KEY=xxxxx MONGODB_URI=mongodb+srv://... node collector-service.mjs   # with persistence
# serves http://localhost:8080/positions.json
```

Note: only one connection per aisstream key at a time, so a local collector run will fight the
deployed one for the key (429). Use a separate key for local work, or stop the deployed one.

## Engineering notes (hard-won gotchas)

- **aisstream sends binary WebSocket frames.** Decode before `JSON.parse`: browser uses
  `TextDecoder` on the `ArrayBuffer` (`ws.binaryType='arraybuffer'`), Node uses `raw.toString()`.
  If you skip this, every message silently fails to parse and nothing appears.
- **aisstream free tier limits concurrent connections per key** (429). Hence one shared collector,
  **instance count must be 1**, and no per-browser streaming. Two instances = two connections =
  429 + inconsistent stores.
- **The collector's store is in memory.** Any restart resets it (refills from the stream in 1-2 min,
  or instantly from Mongo if configured). So turn OFF DO "Autodeploy on push", otherwise every repo
  push redeploys and wipes it. Deploy `server/` changes manually.
- **On DO App Platform the collector is a Web Service from `/server`**, not a static site. If you
  point DO at the repo root it detects the `index.html` and offers a static site, which is wrong.
- **DB IP allowlist uses the DO egress IP, not the ingress IP** (see MongoDB setup). `SSL alert 80`
  in the logs means the IP is not allowlisted.
- **The collector connects to Mongo once at startup.** After fixing the URI or allowlist, redeploy;
  it will not retry the initial connection on its own.
- **There is no GitHub Action.** An earlier scheduled Action committed `positions.json` every 1-3
  hours; because DO auto-deploys on push, each commit restarted the collector and wiped its store.
  It was removed. Positions come only from the collector now.
- **The idle watchdog must back off.** It forces a reconnect when the stream goes quiet, but `lastMsg`
  only advances on an inbound message, so during a real outage the condition stays true and it
  reconnects on *every tick*. That was ~7200 reconnects over one 5-day aisstream outage, which is
  exactly the retry-storm that gets an IP rate-limited. It now escalates 3m → 5m → 10m → 15m per
  consecutive starved probe and snaps back to 3m on the first message, so live behaviour is unchanged.
- **Expect ~8% of an underway ship's AIS transmissions, not all of them.** Measured over 91k stored
  fixes: median 123s between delivered fixes while underway (transponders send every 2-10s), ~300s
  while moored (they send every 180s). Roughly half of all ship-time has no fix at all. This is
  upstream, not something to debug locally: verify by checking that the fleet-wide message rate never
  hits zero (it is per-ship reception that is patchy), and that positions fall inside `BBOX`.
- **Do not `bindPopup()` on every refresh.** Leaflet's `setContent` re-runs `_adjustPan`, so
  rewriting an identical popup every 10s nudges the map under an open popup. Bind once with options,
  then push content only when it actually changed.
- **Open a popup on `moveend`, not straight after `fitBounds`.** Leaflet animates a short pan but
  jumps a long one; opening immediately makes the popup's autoPan measure a half-finished view and
  `panBy` over it, which interrupts the animation and parks the map off-centre. Only nearby targets
  are affected, so it looks intermittent. A fallback timeout is needed because `moveend` never fires
  when the view does not change (re-clicking the ship you are already on).

## Roadmap

- ETA-to-destination, filter by class.
- Per-gap tooltips on route tails (currently merged into one layer per ship for performance:
  ~2000 separate SVG paths across the fleet makes panning stutter).

## Caveats

- Free AIS is terrestrial only: ships far offshore or with AIS off do not appear, and many
  traditional sailing vessels only run AIS under way.
- Some small vessels have no AIS transponder at all.
- MMSI matches for common ship names should be sanity-checked against the live map (a wrong match
  shows a vessel in an implausible place).

## Credits

Fleet list and ship descriptions from [tallships.antwerpen.be](https://tallships.antwerpen.be).
Positions from [aisstream.io](https://aisstream.io). Map tiles from Esri Ocean, CARTO Voyager, and
seamarks from [OpenSeaMap](https://openseamap.org).
