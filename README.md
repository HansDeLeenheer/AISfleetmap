# Fleet AIS map

A live map of a fleet of ships. The map itself is a static page on **GitHub Pages**; the
live positions come from a small **always-on collector** that holds one connection to the free
[aisstream.io](https://aisstream.io) AIS stream and serves a fresh last-known snapshot to every
visitor. No AIS key in the browser, one upstream connection no matter how many people watch.

Built for **The Tall Ships Races Antwerpen 2026**, but it works for any fleet: change the ship
list, deploy the collector with your own key.

Live example: https://hansdeleenheer.github.io/AISfleetmap/

## Architecture

```
aisstream.io ──ws──▶ collector (server/, always-on, 1 instance) ──HTTP /positions.json──▶ browsers
                        key = host env secret                          (page polls every 10s)

GitHub Pages serves the static index.html + ships.json
```

- The collector is the single live source. It keeps each ship's last-known position in memory
  and serves it over HTTPS with CORS open, so the static page can fetch it cross-origin.
- The browser never touches aisstream and never holds the key. It just polls the collector.
  This is required, not just tidy: aisstream's free tier limits concurrent connections per key,
  so a per-browser design breaks as soon as two people open the map.

## Components

| Path | Role |
|---|---|
| `index.html` | Leaflet map. Set `COLLECTOR_URL` near the top to your deployed collector; the page polls `<url>/positions.json` every 10s. |
| `ships.json` | The fleet: name, MMSI, class, length, country, callsign, description, website. The one data file you edit. |
| `server/collector-service.mjs` | The always-on collector. One aisstream connection, in-memory last-known store, serves `/positions.json`, `/health`, `/`, and `/track?mmsi=` (history, if a DB is configured). Optional MongoDB persistence (see below). |
| `server/package.json` | Collector deps (`ws`, and `mongodb` for optional persistence). |
| `.do/app.yaml` | DigitalOcean App Platform spec for the collector. |
| `positions.json`, `collector/` | Legacy static seed + one-shot script. Not part of the live path; only used as a static fallback when `COLLECTOR_URL` is empty. |

## Setup

### 1. Fleet
Fork the repo and edit `ships.json`. Each ship needs at least `name` and `mmsi` (look MMSIs up
on vesselfinder.com / marinetraffic.com, matching on name + country + type).

### 2. Deploy the collector (the live source)
On **DigitalOcean App Platform** (spec: `.do/app.yaml`):

1. DO console → Apps → Create App → your GitHub repo.
2. Set **Source Directory = `/server`** so DO detects the Node web service (not a static site).
   Confirm: Resource type **Web Service**, Run command **`npm start`**, HTTP port **8080**.
3. **Instance count = 1** (critical: one instance = one aisstream connection + one store; more
   than one causes 429s and inconsistent data). Smallest instance size is plenty (~50 MB used).
4. Add the env var **`AISSTREAM_API_KEY`** (your free aisstream key), and tick **Encrypt**.
5. Deploy. You get an HTTPS URL like `https://<app>.ondigitalocean.app`.

The collector runs anywhere Node runs (a Droplet, Fly.io, etc.); App Platform just gives HTTPS
for free. Endpoints: `/positions.json` (snapshot), `/health`, `/` (status).

> On DigitalOcean, turn **off** "Autodeploy on push" for the service. The collector's store is
> in memory, so every redeploy resets it; with autodeploy on, unrelated repo pushes would wipe it.
> Deploy the service manually when you actually change `server/` code (or add MongoDB below).

### Optional: persistence + history (MongoDB)
By default the collector is in-memory: fast, but a restart resets the last-known store and there's
no history. To make it durable and record every position, set one env var:

- **`MONGODB_URI`** (encrypted) → the collector seeds the in-memory store from the DB on startup
  (so a restart comes back full), upserts each ship's last-known into a `positions` collection,
  and appends every fix to a `tracks` collection. `/track?mmsi=<mmsi>` then returns that ship's
  history. Optional `MONGODB_DB` sets the database name (default `aisfleetmap`).

Leave `MONGODB_URI` unset and the collector runs exactly as before, in-memory only. It's fully
opt-in, so forkers who just want a live map need nothing extra. Check the service `/` endpoint:
`"persistence":"mongodb"` vs `"in-memory"` tells you which mode is active.

### 3. Enable GitHub Pages
Repo → Settings → Pages → Deploy from branch `main`, folder `/ (root)`.

### 4. Wire the page to the collector
In `index.html` set `const COLLECTOR_URL = 'https://<your-app>.ondigitalocean.app'` and push.
The map is then live at `https://<user>.github.io/<repo>/`.

## Fallback: no collector
If `COLLECTOR_URL` is empty, the page just loads the static `positions.json` (no live updates),
whatever was last committed to the repo. It's only a placeholder; for a live map, run the collector.

## Local development

```bash
# the page
python3 -m http.server 8777          # open http://localhost:8777

# the collector
cd server && npm install
AISSTREAM_API_KEY=xxxxx node collector-service.mjs   # serves http://localhost:8080/positions.json
```

## Roadmap

- **Position trails** on the map: the history is already recorded in the `tracks` collection when
  `MONGODB_URI` is set and exposed via `/track?mmsi=`; the page just needs to fetch and draw it.
- ETA-to-destination, filter by class.

## Caveats

- Free AIS is terrestrial only: ships far offshore or with AIS switched off do not appear, and
  many traditional sailing vessels only run AIS under way.
- Some small vessels have no AIS transponder at all.
- MMSI matches for common ship names should be sanity-checked against the live map (a wrong match
  shows a vessel in an implausible place).

## Credits

Fleet list and ship descriptions from [tallships.antwerpen.be](https://tallships.antwerpen.be).
Positions from [aisstream.io](https://aisstream.io). Map tiles from Esri Ocean, CARTO Voyager, and
seamarks from [OpenSeaMap](https://openseamap.org).
