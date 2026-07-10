# Fleet AIS map

A zero-backend live map of a fleet of ships, hosted on **GitHub Pages**. A scheduled
GitHub Action collects each ship's latest AIS position from the free
[aisstream.io](https://aisstream.io) stream and writes it to `positions.json`; the static
page loads that file and draws the fleet. No server, no database, no key in the frontend.

Originally built for **The Tall Ships Races Antwerpen 2026**, but it works for any fleet:
change the ship list and plug in your own key.

## How it works

```
aisstream.io  ──stream──▶  GitHub Action (collect.mjs)  ──writes──▶  positions.json
                              key = repo Secret                            │
                                                                     GitHub Pages
                                                                           │
                                                        index.html loads ships.json + positions.json
```

- **`ships.json`** — your fleet (name, MMSI, class, country). The one file you edit.
- **`positions.json`** — generated. Last-known position per ship, updated by the Action.
- **`collector/collect.mjs`** — connects to aisstream for ~90s, merges new fixes, writes the JSON.
- **`.github/workflows/collect.yml`** — runs the collector every ~10 min and commits the result.
- **`index.html`** — self-contained Leaflet map, loads the two JSON files, refreshes each minute.

The key lives **only** in the Action (a GitHub Secret). It is never committed and never sent
to the browser. Positions are public AIS data, so publishing `positions.json` is fine.

## Setup (your own deployment)

1. **Fork / copy** this repo.
2. **Edit `ships.json`** with your fleet. Each ship needs at least `name` and `mmsi`
   (find MMSI on vesselfinder.com or marinetraffic.com).
3. **Get a free key** at [aisstream.io](https://aisstream.io) → create an API key.
4. **Add it as a Secret**: repo → Settings → Secrets and variables → Actions →
   New repository secret → name `AISSTREAM_API_KEY`, paste the key.
5. **Enable Pages**: repo → Settings → Pages → Source = "Deploy from a branch",
   branch `main`, folder `/ (root)`.
6. **Enable the Action**: it runs on a schedule; you can also trigger it once manually
   under the Actions tab → "Collect AIS positions" → Run workflow, to populate
   `positions.json` immediately.

Your map is then live at `https://<user>.github.io/<repo>/`.

> Scheduled Actions run at most every ~10 minutes and GitHub can delay them under load,
> so positions refresh on that cadence, not in real time.

## Live map: always-on collector (recommended)

The GitHub Action seed only refreshes on a schedule (and GitHub throttles short crons hard).
For a genuinely live, global map, run the small always-on collector in `server/`. It holds a
single aisstream connection for everyone, keeps each ship's last-known position in memory, and
serves it over HTTP. The page then reads from it, no key in the browser, one upstream
connection no matter how many people watch (aisstream's free tier limits concurrent
connections per key, so per-browser streaming does not scale).

Deploy on DigitalOcean App Platform (spec in `.do/app.yaml`):

1. DO console → Apps → Create App → this GitHub repo → it picks up `.do/app.yaml`
   (or `doctl apps create --spec .do/app.yaml`).
2. Add the secret `AISSTREAM_API_KEY` (Settings → collector → Environment Variables).
3. Deploy. You get an HTTPS URL like `https://aisfleetmap-collector-xxxx.ondigitalocean.app`.
4. Put that URL in `index.html` → `const COLLECTOR_URL = '...'` and push. The page then
   polls `<url>/positions.json` every 10s for the global live snapshot.

Endpoints: `/positions.json` (snapshot), `/health`, `/` (status). Runs anywhere Node runs
(a Droplet, Fly.io, etc.); App Platform just gives HTTPS for free.

Local run: `cd server && npm install && AISSTREAM_API_KEY=xxxxx node collector-service.mjs`

## Per-browser live (fallback)

When `COLLECTOR_URL` is empty, the page falls back to a per-browser aisstream connection
using the key embedded in `index.html` (or one a visitor pastes into the "Live meevolgen"
panel, which stays in their browser). Fine for a single viewer; use the collector for real use.

## Local development

```bash
# serve the page
python3 -m http.server 8777      # then open http://localhost:8777

# run the collector once against your key
cd collector && npm install
AISSTREAM_API_KEY=xxxxx node collect.mjs
```

## Caveats

- Free AIS is **terrestrial only** — ships far offshore or with AIS switched off won't appear.
- Some small traditional vessels have no AIS transponder at all.
- MMSI matches for common ship names should be sanity-checked against the live map
  (a wrong match shows a vessel in an implausible place).

## Credits

Fleet list scraped from [tallships.antwerpen.be](https://tallships.antwerpen.be).
Positions from [aisstream.io](https://aisstream.io). Map tiles © OpenStreetMap, © CARTO.
