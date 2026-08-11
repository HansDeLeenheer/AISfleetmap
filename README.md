# Fleet AIS map

A live map of a fleet of ships. The map is a static page on **GitHub Pages**; live positions come
from a small **always-on collector** that holds one connection to the free
[aisstream.io](https://aisstream.io) AIS stream and serves a fresh last-known snapshot to every
visitor. No AIS key in the browser, one upstream connection no matter how many people watch.
Optional MongoDB persistence adds durable last-known and full position history, and an optional
second AIS source keeps the map alive when the primary stream goes down.

Built for **The Tall Ships Races Antwerpen 2026**, but it works for any fleet: edit the ship list,
set your keys, deploy the collector.

**To fork this for your own fleet you edit two data files and nothing else.** `ships.json` is your
fleet, `defaults.json` is every tunable the collector has. Both are plain JSON with no build step.

- Map: https://waarzijndetallships.be (also https://hansdeleenheer.github.io/AISfleetmap/)
- Collector: https://aisfleetmap-9hnpn.ondigitalocean.app

## Architecture

```text
aisstream.io ──ws push──▶ collector (server/, always-on, 1 instance) ──/positions.json──▶ browsers
   free, global, primary      keys in host env, settings in defaults.json    page polls every 10s
                                    ▲          │
VesselAPI ──REST pull────────────────┘          ▼
   metered, secondary                    MongoDB (optional): last-known + full history,
   only while aisstream is silent        call budget; seeds the store on startup

GitHub Pages serves the static index.html + ships.json + defaults.json (custom domain optional)
```

- The collector is the single live source. It holds one aisstream WebSocket, keeps each ship's
  last-known position in memory, and serves it over HTTPS with CORS open so the static page can
  fetch it cross-origin.
- The browser never touches aisstream and never holds the key; it just polls the collector. This
  is required, not just tidy: aisstream's free tier limits concurrent connections per key, so a
  per-browser design 429s as soon as two people open the map. One shared collector avoids that.
- With `MONGODB_URI` set, the collector persists to Mongo and seeds its memory from it on startup,
  so a restart comes back full and history accrues. Without it, the collector is in-memory only.
- Sources are pluggable and merge into one store. A fix is only accepted if it is **newer** than the
  one already held, so a slow secondary can never overwrite fresher live data. Each served position
  carries `src` naming the source it came from.

## Choosing an AIS source

This is the first real decision in building a fleet map, and the landscape is narrower than it
looks. Prices and tiers below were checked in August 2026; verify before relying on them.

**aisstream.io is the only free, global, real-time position stream we could find.** That is why it
is the primary source here. Everything else is regional, needs hardware, or is paid.

| Source | Free? | Coverage | Catch |
|---|---|---|---|
| [aisstream.io](https://aisstream.io) | Yes | Global | WebSocket push, no per-message cost. Single point of failure: multi-day outages have happened repeatedly. |
| [AISHub](https://www.aishub.net/) | Yes | Global | **Requires you to run your own AIS receiver.** "Applications without an operational AIS station and feed will not be approved" (≥10 vessels avg/7d, ≥90% uptime). Free and global if you can meet that. |
| [BarentsWatch / Kystverket](https://developer.barentswatch.no/docs/AIS/live-ais-api/) | Yes | Norwegian EEZ + Svalbard only | Open government data, free, registration only. |
| [Fintraffic Digitraffic](https://www.digitraffic.fi/en/marine-traffic/ais/) | Yes, no key | Finnish waters / Baltic only | MQTT over WSS. The only other real streaming API. |
| [Danish Maritime Authority](https://www.dma.dk/safety-at-sea/navigational-information/ais-data) | Historical only | Danish waters | Live feed is paid. |
| [VesselAPI](https://vesselapi.com/) | 150 calls/month | Global, terrestrial | REST, **one call per ship**. Used here as the secondary. Satellite coverage is a paid add-on. |
| [Data Docked](https://datadocked.com/pricing), [Datalastic](https://datalastic.com/pricing/) | Trial only | Global | From about €39 and €99/month. |
| [MyShipTracking](https://api.myshiptracking.com/), [VT Explorer](https://api.vtexplorer.com/docs/) | No | Global | Billed **per vessel per call**, which scales badly for a fleet polled on a timer. |

Two structural traps when costing a metered API for a fleet:

- **Per-vessel billing kills you.** 34 ships polled every 5 minutes is ~294k billable units/month on
  a per-vessel plan, versus ~8.6k on a per-call plan. Check which model you are on before anything else.
- **Area/bbox endpoints rarely help a scattered fleet.** They cap the box (VesselAPI: 4° span, 4h
  window) and return every vessel inside it, so in the North Sea you paginate through thousands of
  irrelevant ships to find your 34.

Running your own receiver (RTL-SDR ~$25, or a [dAISy](https://www.tindie.com/products/astuder/daisy-ais-receiver/)
plus antenna under $100, ~20-40 nmi range) is the cheapest path to independence and the entry ticket
to AISHub, but it only sees your own horizon. It complements a global feed rather than replacing one.

## Repository layout

| Path | Role |
|---|---|
| `index.html` | Self-contained Leaflet map. Set `COLLECTOR_URL` near the top of the script. Polls `<url>/positions.json` every 10s, draws markers, auto-fits to the fleet until the user interacts, click-to-zoom, mobile bottom-sheet. Nautical basemap (Esri Ocean < z13, CARTO Voyager >= z13) + OpenSeaMap seamarks, km/nautical scale bar, and the route view below. |
| `ships.json` | The fleet (source of truth). See data model below. One of the two files you normally edit. |
| `defaults.json` | Every collector tunable: which sources are on, how the fallback polls, the history thinning gates. See configuration below. The other file you normally edit. |
| `server/collector-service.mjs` | The always-on collector. Sources (aisstream ws, VesselAPI REST), in-memory store, optional Mongo. Serves `/positions.json`, `/track?mmsi=`, `/health`, `/`. |
| `server/package.json` | Collector deps: `ws`, and `mongodb` (used only when `MONGODB_URI` is set). |
| `.do/app.yaml` | DigitalOcean App Platform spec for the collector. |
| `CNAME` | GitHub Pages custom domain. |
| `positions.json` | Empty placeholder; only fetched as a static fallback when `COLLECTOR_URL` is empty. Not part of the live path. |

## Configuration

### `defaults.json` (the collector)

Read **once at startup**, so any change needs a collector redeploy. Every key is optional: what you
leave out falls back to the built-in default in `collector-service.mjs`, so a partial file is valid
and a typo cannot brick the collector. Keys starting with `_` are comments and are ignored.

| Key | Default | What it does |
|---|---|---|
| `sources.aisstream.enabled` | `true` | `false` runs the collector with no stream at all (and then `AISSTREAM_API_KEY` is not required). |
| `sources.aisstream.bbox` | Biscay to Norway/Baltic | `[[[minLat,minLon],[maxLat,maxLon]]]`. Must contain your fleet or you get nothing. |
| `sources.aisstream.idleLadderMinutes` | `[3,5,10,15]` | Silence before the watchdog forces a reconnect, escalating per consecutive starved probe. See gotchas. |
| `sources.aisstream.watchdogSeconds` | `30` | How often the watchdog checks. |
| `sources.vesselapi.enabled` | `true` | Master switch for the secondary source. |
| `sources.vesselapi.pollingMode` | `"fallback"` | `fallback` = only while aisstream is silent. `parallel` = always, on its own interval, alongside aisstream. `off` = never call it. |
| `sources.vesselapi.intervalHours` | `48` | Minimum gap between sweeps. |
| `sources.vesselapi.starvedMinutes` | `60` | `fallback` mode only: how long aisstream must be silent before a sweep. |
| `sources.vesselapi.satelliteFallback` | `false` | Adds `filter.sat` so offshore ships resolve. Costs extra credits on the provider. |
| `sources.vesselapi.activeOnly` | `true` | Skip `active:false` ships, so a hidden ship costs no quota. |
| `sources.vesselapi.monthlyCallBudget` | `150` | Hard ceiling per calendar month. Match it to your plan. |
| `sources.vesselapi.requestSpacingMs` | `250` | Pause between calls, to stay clear of concurrency limits. |
| `history.minSogKnots` | `0.2` | History thinning: above this speed every fix is stored. |
| `history.minDistanceM` | `30` | Store if the ship moved this far since the last stored fix. |
| `history.maxGapMinutes` | `15` | Store regardless after this long, so a berthed ship still has a heartbeat. |

**Budget arithmetic matters more than the interval.** The secondary costs one call per ship per
sweep, so a full sweep of N ships is N calls. With 34 ships and a 150-call budget that is 4 full
sweeps a month, which at 48-hourly covers the first 6 days of an outage and then a partial sweep
around day 8. Widening the interval does not save money; shrinking the fleet or raising the budget
does. If the budget cannot cover a whole sweep the collector takes what it can afford and rotates
the starting point, so successive part-sweeps cover different ships instead of the same prefix.

### `index.html` (the page)

| Constant | Line | What it does |
|---|---|---|
| `COLLECTOR_URL` | ~100 | Your collector's HTTPS URL. Empty falls back to the static `positions.json`. **The one line you must change.** |
| `CLSCOL`, `FLAG` | ~103 | Class colours and country flag emoji. |
| `DETAIL_FROM` | ~130 | Zoom at which the basemap switches to the detailed chart. |
| `ROUTE_DAYS` | ~326 | How many days of tail the route view draws. |
| `ROUTE_GAP_KM` | ~327 | Longer straight-line jump than this is drawn as inferred hairline. |
| `ROUTE_STALE_MS` | ~328 | History ending this far behind last-known suppresses the tail entirely. |

## Data model

**`ships.json`**: `{ source, event, capturedAt, note, ships: [...] }`. Each ship:

| Field | Notes |
|---|---|
| `name` | Display name. |
| `mmsi` | 9-digit AIS id (string). The join key everywhere. Required. |
| `klasse`, `lengte`, `land` | Class (A-D), length band, country (drives the flag emoji in the page). |
| `callsign`, `imo` | Optional, shown in the popup. |
| `description`, `website` | Optional, shown in the popup (`website` opens in a new tab). |
| `confidence` | Optional, documentation only. How sure you are the MMSI is really this ship. Nothing reads it; it marks which rows still need checking against the live map. |
| `active` | Optional, default `true`. `false` = still tracked and recorded, but excluded from `/positions.json` and from the page list/map (see gotchas). |

**Collector snapshot** (`GET /positions.json`): `{ generatedAt, positions: { <mmsi>: { mmsi, name, lat, lon, sog, cog, hdg, t, src } } }`. `t` is the AIS fix time (ISO), `src` is the source that produced it (`"aisstream"` or `"vesselapi"`). Only `active` ships are included.

**MongoDB** (when enabled), db `aisfleetmap` (override with `MONGODB_DB`):
- `positions`: last-known per ship, `_id = mmsi`, `{ name, lat, lon, sog, cog, hdg, t, updatedAt }`.
- `tracks`: position history, `{ mmsi, name, lat, lon, sog, cog, hdg, t }`, indexed `{ mmsi, t }`.
  Thinned on write: a fix is skipped only when the ship is under 0.2 kn **and** within 30 m of the
  last *stored* fix **and** less than 15 min since it. Distance is measured from the last stored
  fix, so slow drift accumulates and is sampled rather than lost, and every gate fails open. Cuts
  volume ~32% on real data (a berthed ship transmits every 3 min and jitters by ~2 m). The
  `positions` upsert is never skipped, so last-known and departure detection are unaffected.
- `meta`: small counters that must survive a restart. Currently `_id: "vesselapi-usage"`,
  `{ month, calls, updatedAt }`, the secondary source's spend for the current calendar month.
  Without Mongo this counter is in-memory, so a restart loop could overspend the budget.

## Collector HTTP endpoints

- `GET /positions.json`: snapshot of active ships (what the page polls). CORS `*`, no-store.
- `GET /track?mmsi=<mmsi>[&days=N][&limit=N]`: that ship's recorded history (needs Mongo; empty
  otherwise), oldest-first. `days` counts back from the ship's **own newest stored fix**, not from
  now, so the window still resolves while the upstream feed is down. `limit` defaults to 5000
  (max 20000) and trims the **old** end: the query sorts newest-first and reverses.
- `GET /health`: `ok`.
- `GET /`: status: `{ service, tracking, active, located, served, generatedAt, persistence, vesselapi }`.
  `persistence` is `"mongodb"` or `"in-memory"`; `tracking` = all ships, `served` = active ships with a fix.
  `vesselapi` reports `{ mode, key, intervalHours, satellite, used, budget, month, lastSweep }`, where
  `lastSweep` is `{ at, reason, asked, got, updated, missing, failed, aborted }`. `missing` counts ships
  the provider has no position for (HTTP 404, usually a wrong MMSI); `failed` counts calls that broke.
  They are separated deliberately, so a fleet-data problem cannot be mistaken for a provider outage.

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
4. Add env var **`AISSTREAM_API_KEY`** (free key from aisstream.io), tick **Encrypt**. This is the
   only required key; `VESSELAPI_KEY` and `MONGODB_URI` below are both optional.
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

### 4. Optional: second AIS source (outage insurance)
aisstream has gone dark for days at a time. With a secondary configured, the map keeps serving
last-known instead of freezing at whatever it held when the stream died.

1. Get a key at [dashboard.vesselapi.com](https://dashboard.vesselapi.com/). The free tier is 150
   calls/month with no card. Pick the longest expiry the dashboard offers: this key is only
   exercised during an outage, so a silent expiry would kill it exactly when it is needed.
2. Add env var `VESSELAPI_KEY` (encrypted) to the collector.
3. Set `sources.vesselapi` in `defaults.json` (see configuration above). Size
   `monthlyCallBudget` to your plan, remembering one call per ship per sweep.
4. **Redeploy**, then check `GET /` shows `vesselapi.key: "set"` and your chosen `mode`.

Nothing happens until aisstream actually goes silent for `starvedMinutes`, so in normal operation
this costs nothing. Leave `VESSELAPI_KEY` unset and the whole thing is inert.

### 5. GitHub Pages
Repo → Settings → Pages → Deploy from branch `main`, folder `/ (root)`.

### 6. Wire the page to the collector
In `index.html` set `const COLLECTOR_URL = 'https://<your-app>.ondigitalocean.app'` and push.
Live at `https://<user>.github.io/<repo>/`.

### 7. Custom domain (optional)
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
AISSTREAM_API_KEY=xxxxx VESSELAPI_KEY=yyyyy node collector-service.mjs             # with the secondary
# serves http://localhost:8080/positions.json
```

The collector reads `../ships.json` and `../defaults.json` relative to its own file, so it works
from any working directory. To try a config without touching the repo copy, copy `ships.json`,
`defaults.json` and `server/` into a scratch directory and run it from there.

Testing the secondary against a real key spends real quota. Set `monthlyCallBudget` to a handful and
`starvedMinutes` low in the scratch copy, and you exercise the whole path for a few calls instead of
one per ship.

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
- **One AIS source is a single point of failure, and free ones do fail for days.** aisstream went
  fully dark on 2026-08-05 and was still down six days later (service-wide, many independent
  reporters). Mongo persistence is what kept the map showing anything at all, and it is why the
  secondary source exists. If you run this for an event with a date, assume the feed will be down
  at some point and decide in advance what the map should show when it is.
- **A metered source needs a persisted budget counter.** The spend has to live in the database, not
  in memory: App Platform restarts on every deploy, and an in-memory counter would let a redeploy
  loop re-spend the monthly quota from zero each boot. For the same reason the starvation clock
  starts at boot, so a restart never triggers an immediate sweep.
- **Never let a slow source overwrite a fast one.** The merge only accepts a fix that is strictly
  newer than the one already held. Without that rule, enabling `parallel` mode would let a
  48-hour-old REST answer clobber a live position that arrived seconds ago.
- **On a paginated REST API, a wide time window is a trap.** Results come back newest-first and each
  page is billed, so asking for 24 hours of a 34-ship fleet burned 6 calls to walk 300 rows that all
  fell inside the same 5 minutes. Short windows sampled repeatedly, or a purpose-built latest-position
  endpoint, cost a fraction of that. Check whether your provider bills per call or per vessel first.
- **Distinguish "no data for this ship" from "the call failed".** A 404 usually means the MMSI is
  wrong; a 500 means the provider is sick. Bucketing them together hides an outage behind what looks
  like bad fleet data, and vice versa. This is how a wrong MMSI in `ships.json` gets noticed.
- **`node --check` only parses.** It will not catch a runtime `TypeError`, and one such bug in a map
  control blanked the entire page while the syntax check passed. Run the collector for real against a
  scratch config, and exercise `index.html` in jsdom. jsdom needs `fetch` and `matchMedia` polyfills,
  and the `clientWidth`/`clientHeight` stub must be scoped to `id === 'map'` or the popup reports a
  phantom height and autoPan skews every measurement. Measure map positions with
  `latLngToContainerPoint`, never with DOM `left`/`top`.

## Roadmap

- ETA-to-destination, filter by class.
- Per-gap tooltips on route tails (currently merged into one layer per ship for performance:
  ~2000 separate SVG paths across the fleet makes panning stutter).

## Caveats

- Free AIS is terrestrial only: ships far offshore or with AIS off do not appear, and many
  traditional sailing vessels only run AIS under way. Satellite coverage is a paid add-on on every
  provider we looked at.
- Some small vessels have no AIS transponder at all.
- MMSI matches for common ship names should be sanity-checked against the live map (a wrong match
  shows a vessel in an implausible place). A second source helps here: an MMSI that returns a
  position from one provider and a 404 from another is worth re-checking, and a provider that
  returns `vessel_name` confirms a match for free.
- The secondary is REST last-known, not a stream. While it is carrying the map, positions are as
  old as the sweep interval, not live. It keeps the map truthful and current-ish during an outage;
  it does not replace a stream.

## Credits

Fleet list and ship descriptions from [tallships.antwerpen.be](https://tallships.antwerpen.be).
Positions from [aisstream.io](https://aisstream.io), with [VesselAPI](https://vesselapi.com) as the
optional secondary. Map tiles from Esri Ocean, CARTO Voyager, and seamarks from
[OpenSeaMap](https://openseamap.org).
