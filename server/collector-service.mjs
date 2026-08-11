#!/usr/bin/env node
// Always-on collector: holds ONE aisstream connection, keeps the fleet's last-known
// positions in memory, and serves them to every visitor. Global snapshot, no key in
// the frontend, one upstream connection regardless of how many people watch.
//
// Optional persistence: set MONGODB_URI to store last-known + full position history in
// MongoDB and seed the in-memory store on startup (so a restart comes back full). Without
// it, the collector runs in-memory only (no history, store resets on restart).
//
// Optional second source: set VESSELAPI_KEY to let the collector fall back to VesselAPI's
// REST last-known when aisstream goes dark. It is metered per ship, so how and how often it
// is called lives in ../defaults.json (sources.vesselapi.pollingMode), not in here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.AISSTREAM_API_KEY;
const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI;                 // optional
const DB_NAME = process.env.MONGODB_DB || 'aisfleetmap';

// Repo JSON (ships.json, defaults.json): prefer the local copy, else the published one.
async function loadJson(name) {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../' + name), 'utf8')); }
  catch {
    try { return await (await fetch(`https://hansdeleenheer.github.io/AISfleetmap/${name}`)).json(); }
    catch { return null; }
  }
}

// Settings live in ../defaults.json. These are the fallbacks, so a missing or partial file
// still boots; anything defaults.json names wins. Keys starting with _ are comments.
const DEFAULTS = {
  sources: {
    aisstream: { enabled: true, bbox: [[[40.0, -15.0], [71.0, 31.0]]], idleLadderMinutes: [3, 5, 10, 15], watchdogSeconds: 30 },
    vesselapi: { enabled: true, pollingMode: 'fallback', intervalHours: 48, starvedMinutes: 60, satelliteFallback: false, activeOnly: true, monthlyCallBudget: 150, requestSpacingMs: 250 },
  },
  history: { minSogKnots: 0.2, minDistanceM: 30, maxGapMinutes: 15 },
};
function merge(base, over) {
  const out = { ...base };
  for (const k in over) {
    if (k.startsWith('_')) continue;
    const v = over[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k]) ? merge(base[k], v) : v;
  }
  return out;
}
const CFG = merge(DEFAULTS, (await loadJson('defaults.json')) || {});
const AIS = CFG.sources.aisstream;
const BBOX = AIS.bbox;                                       // Biscay -> Norway/Baltic
// The key is only required if we actually intend to stream; a fork can run on VesselAPI alone.
if (AIS.enabled && !KEY) {
  console.error('Missing AISSTREAM_API_KEY (or set sources.aisstream.enabled=false in defaults.json)');
  process.exit(1);
}

const fleet = await loadJson('ships.json');
if (!fleet) { console.error('Cannot load ships.json (local or published)'); process.exit(1); }
const mmsis = fleet.ships.map(s => String(s.mmsi)).filter(Boolean);   // ALL ships are tracked
const nameByMMSI = Object.fromEntries(fleet.ships.map(s => [String(s.mmsi), s.name]));
// Ships with active:false are still tracked + recorded, but not served in /positions.json
// (e.g. a ship no longer coming, so it can't drag the map to a far-away position).
const activeSet = new Set(fleet.ships.filter(s => s.active !== false).map(s => String(s.mmsi)));

const store = { generatedAt: null, positions: {} };

// ---- optional MongoDB persistence ----
let positionsCol = null, tracksCol = null, metaCol = null;
if (MONGODB_URI) {
  try {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    positionsCol = db.collection('positions');   // last-known, _id = mmsi
    tracksCol = db.collection('tracks');         // full history, one doc per fix
    metaCol = db.collection('meta');             // counters that must survive a restart
    await tracksCol.createIndex({ mmsi: 1, t: 1 });
    // Seed the in-memory store from stored last-known so a restart comes back full.
    const docs = await positionsCol.find({}).toArray();
    for (const d of docs) {
      if (!nameByMMSI[d._id]) continue;
      store.positions[d._id] = {
        mmsi: d._id, name: d.name, lat: d.lat, lon: d.lon, sog: d.sog, cog: d.cog, hdg: d.hdg,
        t: d.t instanceof Date ? d.t.toISOString() : d.t,
      };
    }
    store.generatedAt = new Date().toISOString();
    console.log(`MongoDB connected (${DB_NAME}); seeded ${Object.keys(store.positions).length} last-known, history enabled`);
  } catch (e) {
    console.error('MONGODB_URI set but connection failed; continuing in-memory only:', e.message);
    positionsCol = tracksCol = metaCol = null;
  }
} else {
  console.log('No MONGODB_URI; running in-memory only (no persistence/history)');
}

// History thinning. A berthed ship keeps transmitting every 3 min, so most of `tracks` is
// GPS jitter of a metre or two. These gates drop only that. Every gate fails OPEN (store),
// and distance is measured from the last STORED fix, so slow drift accumulates and is
// sampled rather than lost.
// Deliberately no course gate: COG is GPS-derived, so at zero speed it swings wildly while
// the ship sits still, and gating on it keeps ~all of the jitter it was meant to drop.
const KEEP_SOG = CFG.history.minSogKnots;        // any credible way-on: store every fix
const KEEP_DIST_M = CFG.history.minDistanceM;    // displacement since last stored fix
const KEEP_MAX_GAP = CFG.history.maxGapMinutes * 60e3; // heartbeat, so a stationary ship still has history
const lastStored = {};     // mmsi -> last fix written to `tracks`

function metres(aLat, aLon, bLat, bLon) {
  const k = 111320;
  return Math.hypot((aLat - bLat) * k, (aLon - bLon) * k * Math.cos(aLat * Math.PI / 180));
}

// True unless this fix is indistinguishable from the last one we stored.
function worthStoring(p, t) {
  const prev = lastStored[p.mmsi];
  if (!prev) return true;
  if (p.sog == null || p.sog >= KEEP_SOG) return true;
  if (!(t > prev.t) || t - prev.t >= KEEP_MAX_GAP) return true;
  if (metres(p.lat, p.lon, prev.lat, prev.lon) >= KEEP_DIST_M) return true;
  return false;
}

function persist(p) {
  if (!positionsCol) return;
  const t = new Date(p.t);
  positionsCol.updateOne(
    { _id: p.mmsi },
    { $set: { name: p.name, lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog, hdg: p.hdg, t, updatedAt: new Date() } },
    { upsert: true },
  ).catch(e => console.error('positions upsert:', e.message));
  if (!worthStoring(p, t)) return;
  lastStored[p.mmsi] = { lat: p.lat, lon: p.lon, t };
  tracksCol.insertOne(
    { mmsi: p.mmsi, name: p.name, lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog, hdg: p.hdg, t },
  ).catch(e => console.error('tracks insert:', e.message));
}

// ---- aisstream ----
// Idle thresholds, escalated per consecutive starved probe. Only the first applies while
// data is flowing; any inbound message resets to 3 min.
const IDLE_LADDER = CFG.sources.aisstream.idleLadderMinutes.map(m => m * 60e3);
let ws, lastMsg = Date.now(), lastProbe = Date.now(), starve = 0, backoff = 3000;
function connect() {
  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.on('open', () => {
    lastProbe = Date.now();
    ws.send(JSON.stringify({
      APIKey: KEY, BoundingBoxes: BBOX, FiltersShipMMSI: mmsis,
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData'],
    }));
    console.log(`aisstream connected, tracking ${mmsis.length} ships`);
  });
  ws.on('message', (raw) => {
    lastMsg = Date.now();
    if (starve) { console.log(`stream recovered after ${starve} starved probes`); starve = 0; }
    backoff = 3000;
    let d; try { d = JSON.parse(raw.toString()); } catch { return; }
    if (d.error) { console.error('aisstream error:', d.error); return; }
    const md = d.MetaData || {};
    const mmsi = String(md.MMSI || md.MMSI_String || '');
    if (!nameByMMSI[mmsi]) return;
    const p = store.positions[mmsi] || { mmsi, name: nameByMMSI[mmsi] };
    if (md.latitude != null) { p.lat = md.latitude; p.lon = md.longitude; }
    const msg = d.Message || {};
    const pr = msg.PositionReport || msg.StandardClassBPositionReport || msg.ExtendedClassBPositionReport;
    if (pr) {
      if (pr.Latitude != null) { p.lat = pr.Latitude; p.lon = pr.Longitude; }
      if (pr.Sog != null && pr.Sog < 102.3) p.sog = pr.Sog;
      if (pr.Cog != null && pr.Cog < 360) p.cog = pr.Cog;
      if (pr.TrueHeading != null && pr.TrueHeading < 360) p.hdg = pr.TrueHeading;
    }
    if (p.lat == null) return;
    p.t = (md.time_utc ? new Date(md.time_utc) : new Date()).toISOString();
    p.src = 'aisstream';
    store.positions[mmsi] = p;
    store.generatedAt = new Date().toISOString();
    persist(p);
  });
  ws.on('close', () => { console.log(`aisstream closed, reconnecting in ${backoff}ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); });
  ws.on('error', (e) => { console.error('aisstream ws error:', e.message); try { ws.close(); } catch {} });
}
if (AIS.enabled) connect();
else console.log('aisstream disabled in defaults.json; running on the secondary source only');

// Watchdog: force a reconnect when the stream goes quiet. Measures idle from the last
// message OR the last probe, whichever is more recent, so a silent stream is re-probed on
// the ladder interval instead of once per tick (aisstream outages run for days).
setInterval(() => {
  if (!AIS.enabled) return;
  const now = Date.now();
  const idle = Math.min(now - lastMsg, now - lastProbe);
  const limit = IDLE_LADDER[Math.min(starve, IDLE_LADDER.length - 1)];
  if (idle > limit) {
    starve++; lastProbe = now;
    console.log(`stream idle ${Math.round(idle / 1000)}s, forcing reconnect (starved probes: ${starve})`);
    try { ws.close(); } catch {}
  }
}, CFG.sources.aisstream.watchdogSeconds * 1000);

// ---- VesselAPI: secondary feed ----
// REST and ONE CALL PER SHIP, metered against a monthly budget, so it exists to survive an
// aisstream outage rather than to run beside it. pollingMode in defaults.json decides:
//   fallback  sweep only once aisstream has been silent for starvedMinutes (default)
//   parallel  sweep every intervalHours regardless of aisstream
//   off       never call it
// A sweep is skipped, never truncated silently: if the budget cannot cover the whole fleet
// it takes what it can afford and rotates the starting point, so successive part-sweeps
// cover different ships instead of the same prefix forever.
const VAPI = CFG.sources.vesselapi;
const VAPI_KEY = process.env.VESSELAPI_KEY;
let vapiUsage = { month: null, calls: 0 };
let vapiCursor = 0, vapiSweeping = false, vapiLastSweep = null, vapiLastResult = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const monthKey = () => new Date().toISOString().slice(0, 7);

// Spend has to survive a restart, or a redeploy loop would re-spend the budget each boot.
async function loadUsage() {
  vapiUsage = { month: monthKey(), calls: 0 };
  if (!metaCol) return;
  const d = await metaCol.findOne({ _id: 'vesselapi-usage' }).catch(() => null);
  if (d && d.month === vapiUsage.month) vapiUsage.calls = d.calls || 0;
}
function saveUsage() {
  if (!metaCol) return;
  metaCol.updateOne({ _id: 'vesselapi-usage' },
    { $set: { month: vapiUsage.month, calls: vapiUsage.calls, updatedAt: new Date() } }, { upsert: true },
  ).catch(e => console.error('vesselapi usage save:', e.message));
}

// Merge one fix, but never let it overwrite something fresher we already hold.
function applyVapiFix(mmsi, v) {
  const t = new Date(v.timestamp || v.processed_timestamp);
  if (isNaN(t.getTime()) || v.latitude == null) return false;
  const cur = store.positions[mmsi];
  if (cur && cur.t && new Date(cur.t) >= t) return false;
  const p = cur || { mmsi, name: nameByMMSI[mmsi] };
  p.lat = v.latitude; p.lon = v.longitude;
  if (v.sog != null && v.sog < 102.3) p.sog = v.sog;
  if (v.cog != null && v.cog < 360) p.cog = v.cog;
  if (v.heading != null && v.heading < 360) p.hdg = v.heading;   // absent on this endpoint
  p.t = t.toISOString();
  p.src = 'vesselapi';
  store.positions[mmsi] = p;
  store.generatedAt = new Date().toISOString();
  persist(p);
  return true;
}

async function vapiSweep(reason) {
  if (vapiSweeping) return;
  if (!VAPI_KEY) { console.log('vesselapi: sweep due but VESSELAPI_KEY is not set'); return; }
  if (vapiUsage.month !== monthKey()) vapiUsage = { month: monthKey(), calls: 0 };

  const targets = VAPI.activeOnly ? mmsis.filter(m => activeSet.has(m)) : mmsis;
  const left = VAPI.monthlyCallBudget - vapiUsage.calls;
  if (left <= 0) {
    console.log(`vesselapi: monthly budget spent (${vapiUsage.calls}/${VAPI.monthlyCallBudget}), skipping sweep`);
    return;
  }
  const n = Math.min(targets.length, left);
  const batch = targets.slice(vapiCursor).concat(targets.slice(0, vapiCursor)).slice(0, n);
  vapiCursor = (vapiCursor + n) % targets.length;

  vapiSweeping = true; vapiLastSweep = Date.now();
  console.log(`vesselapi: sweeping ${n}/${targets.length} ships (${reason}); budget left ${left}`);
  let got = 0, updated = 0, missing = 0, failed = 0, aborted = null;
  for (const mmsi of batch) {
    try {
      const u = new URL(`https://api.vesselapi.com/v1/vessel/${mmsi}/position`);
      u.searchParams.set('filter.idType', 'mmsi');
      if (VAPI.satelliteFallback) u.searchParams.set('filter.sat', 'true');
      const r = await fetch(u, { headers: { Authorization: `Bearer ${VAPI_KEY}` } });
      vapiUsage.calls++;
      if (r.status === 429) { aborted = 'rate limited or quota exhausted'; break; }
      // 404 means this MMSI has no position on file (wrong number, or never seen). That is a
      // fleet-data fact, not a broken call, and mixing the two hides an API-wide failure.
      if (r.status === 404) { missing++; continue; }
      if (!r.ok) { failed++; continue; }
      const v = (await r.json()).vesselPosition;
      if (!v || v.suspected_glitch) continue;
      got++;
      if (applyVapiFix(mmsi, v)) updated++;
    } catch { failed++; }
    if (VAPI.requestSpacingMs) await sleep(VAPI.requestSpacingMs);
  }
  saveUsage();
  vapiSweeping = false;
  vapiLastResult = { at: new Date().toISOString(), reason, asked: batch.length, got, updated, missing, failed, aborted };
  console.log(`vesselapi: ${got} fixes, ${updated} newer than held, ${missing} no-position, ${failed} failed${aborted ? `, aborted (${aborted})` : ''}; ${vapiUsage.calls}/${VAPI.monthlyCallBudget} used this month`);
}

await loadUsage();
if (VAPI.enabled && VAPI.pollingMode !== 'off') {
  console.log(`vesselapi: mode=${VAPI.pollingMode} every ${VAPI.intervalHours}h, budget ${vapiUsage.calls}/${VAPI.monthlyCallBudget} used in ${vapiUsage.month}, satellite=${!!VAPI.satelliteFallback}, key=${VAPI_KEY ? 'set' : 'MISSING'}`);
}
setInterval(() => {
  if (!VAPI.enabled || VAPI.pollingMode === 'off') return;
  const now = Date.now();
  if (vapiLastSweep && now - vapiLastSweep < VAPI.intervalHours * 3600e3) return;
  if (VAPI.pollingMode === 'parallel') { vapiSweep('parallel mode'); return; }
  // fallback mode: lastMsg only advances on an inbound frame, so this is real silence.
  // It also starts at boot time, which is what stops a redeploy from spending the budget.
  const silent = now - lastMsg;
  if (silent < VAPI.starvedMinutes * 60e3) return;
  vapiSweep(`aisstream silent ${Math.round(silent / 60e3)} min`);
}, 60e3);

// ---- HTTP ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = (req.url || '/').split('?')[0];
  if (url === '/positions.json' || url === '/positions') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const positions = {};
    for (const m in store.positions) if (activeSet.has(m)) positions[m] = store.positions[m];
    res.end(JSON.stringify({ generatedAt: store.generatedAt, positions }));
  } else if (url === '/track') {
    // History for one ship (requires MONGODB_URI). Usage: /track?mmsi=211205920&days=5
    // Sorted NEWEST-first in Mongo then reversed, so the row cap trims old history rather
    // than the recent end. `days` counts back from the ship's own latest stored fix, not
    // from now, so the window still resolves while the upstream feed is down.
    const q = new URL(req.url, 'http://x').searchParams;
    const mmsi = q.get('mmsi');
    const days = Math.min(Math.max(parseFloat(q.get('days')) || 0, 0), 90);
    const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 5000, 1), 20000);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (!tracksCol || !mmsi) { res.end(JSON.stringify({ mmsi: mmsi || null, track: [] })); return; }
    tracksCol.find({ mmsi }).sort({ t: -1 }).limit(limit).project({ _id: 0, lat: 1, lon: 1, t: 1 }).toArray()
      .then(rows => {
        let track = rows.reverse();
        if (days && track.length) {
          const cutoff = new Date(track[track.length - 1].t).getTime() - days * 86400e3;
          track = track.filter(r => new Date(r.t).getTime() >= cutoff);
        }
        res.end(JSON.stringify({ mmsi, track }));
      })
      .catch(e => { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); });
  } else if (url === '/health') {
    res.end('ok');
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      service: 'aisfleetmap-collector', tracking: mmsis.length, active: activeSet.size,
      located: Object.keys(store.positions).length,
      served: Object.keys(store.positions).filter(m => activeSet.has(m)).length,
      generatedAt: store.generatedAt, persistence: positionsCol ? 'mongodb' : 'in-memory',
      vesselapi: {
        mode: VAPI.enabled ? VAPI.pollingMode : 'disabled',
        key: VAPI_KEY ? 'set' : 'missing',
        intervalHours: VAPI.intervalHours,
        satellite: !!VAPI.satelliteFallback,
        used: vapiUsage.calls, budget: VAPI.monthlyCallBudget, month: vapiUsage.month,
        lastSweep: vapiLastResult,
      },
    }));
  }
});
server.listen(PORT, () => console.log('collector listening on', PORT));
