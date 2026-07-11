#!/usr/bin/env node
// Always-on collector: holds ONE aisstream connection, keeps the fleet's last-known
// positions in memory, and serves them to every visitor. Global snapshot, no key in
// the frontend, one upstream connection regardless of how many people watch.
//
// Optional persistence: set MONGODB_URI to store last-known + full position history in
// MongoDB and seed the in-memory store on startup (so a restart comes back full). Without
// it, the collector runs in-memory only (no history, store resets on restart).
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
const BBOX = [[[40.0, -15.0], [71.0, 31.0]]];                // Biscay -> Norway/Baltic
if (!KEY) { console.error('Missing AISSTREAM_API_KEY'); process.exit(1); }

// Fleet MMSIs: prefer the repo's ships.json (../ships.json), else fetch the public copy.
let fleet;
try {
  fleet = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../ships.json'), 'utf8'));
} catch {
  const r = await fetch('https://hansdeleenheer.github.io/AISfleetmap/ships.json');
  fleet = await r.json();
}
const mmsis = fleet.ships.map(s => String(s.mmsi)).filter(Boolean);   // ALL ships are tracked
const nameByMMSI = Object.fromEntries(fleet.ships.map(s => [String(s.mmsi), s.name]));
// Ships with active:false are still tracked + recorded, but not served in /positions.json
// (e.g. a ship no longer coming, so it can't drag the map to a far-away position).
const activeSet = new Set(fleet.ships.filter(s => s.active !== false).map(s => String(s.mmsi)));

const store = { generatedAt: null, positions: {} };

// ---- optional MongoDB persistence ----
let positionsCol = null, tracksCol = null;
if (MONGODB_URI) {
  try {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    positionsCol = db.collection('positions');   // last-known, _id = mmsi
    tracksCol = db.collection('tracks');         // full history, one doc per fix
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
    positionsCol = tracksCol = null;
  }
} else {
  console.log('No MONGODB_URI; running in-memory only (no persistence/history)');
}

function persist(p) {
  if (!positionsCol) return;
  const t = new Date(p.t);
  positionsCol.updateOne(
    { _id: p.mmsi },
    { $set: { name: p.name, lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog, hdg: p.hdg, t, updatedAt: new Date() } },
    { upsert: true },
  ).catch(e => console.error('positions upsert:', e.message));
  tracksCol.insertOne(
    { mmsi: p.mmsi, name: p.name, lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog, hdg: p.hdg, t },
  ).catch(e => console.error('tracks insert:', e.message));
}

// ---- aisstream ----
let ws, lastMsg = Date.now(), backoff = 3000;
function connect() {
  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.on('open', () => {
    backoff = 3000;
    ws.send(JSON.stringify({
      APIKey: KEY, BoundingBoxes: BBOX, FiltersShipMMSI: mmsis,
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData'],
    }));
    console.log(`aisstream connected, tracking ${mmsis.length} ships`);
  });
  ws.on('message', (raw) => {
    lastMsg = Date.now();
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
    store.positions[mmsi] = p;
    store.generatedAt = new Date().toISOString();
    persist(p);
  });
  ws.on('close', () => { console.log(`aisstream closed, reconnecting in ${backoff}ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); });
  ws.on('error', (e) => { console.error('aisstream ws error:', e.message); try { ws.close(); } catch {} });
}
connect();

// Watchdog: if the stream goes quiet for 3 min, force a reconnect.
setInterval(() => {
  if (Date.now() - lastMsg > 180000) { console.log('stream idle, forcing reconnect'); try { ws.close(); } catch {} }
}, 60000);

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
    // History for one ship (requires MONGODB_URI). Usage: /track?mmsi=211205920
    const mmsi = new URL(req.url, 'http://x').searchParams.get('mmsi');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (!tracksCol || !mmsi) { res.end(JSON.stringify({ mmsi: mmsi || null, track: [] })); return; }
    tracksCol.find({ mmsi }).sort({ t: 1 }).limit(5000).project({ _id: 0, lat: 1, lon: 1, t: 1 }).toArray()
      .then(track => res.end(JSON.stringify({ mmsi, track })))
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
    }));
  }
});
server.listen(PORT, () => console.log('collector listening on', PORT));
