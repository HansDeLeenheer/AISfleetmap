#!/usr/bin/env node
// Always-on collector: holds ONE aisstream connection, keeps the fleet's last-known
// positions in memory, and serves them to every visitor. Global snapshot, no key in
// the frontend, one upstream connection regardless of how many people watch.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.AISSTREAM_API_KEY;
const PORT = process.env.PORT || 8080;
const BBOX = [[[40.0, -15.0], [71.0, 31.0]]]; // Biscay -> Norway/Baltic
if (!KEY) { console.error('Missing AISSTREAM_API_KEY'); process.exit(1); }

// Fleet MMSIs from the repo's ships.json (../ships.json relative to this file).
const fleet = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../ships.json'), 'utf8'));
const mmsis = fleet.ships.map(s => String(s.mmsi)).filter(Boolean);
const nameByMMSI = Object.fromEntries(fleet.ships.map(s => [String(s.mmsi), s.name]));

const store = { generatedAt: null, positions: {} };
let ws, lastMsg = Date.now(), backoff = 3000;

function connect() {
  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.on('open', () => {
    backoff = 3000; // reset after a good connection
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
  });
  ws.on('close', () => { console.log(`aisstream closed, reconnecting in ${backoff}ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); });
  ws.on('error', (e) => { console.error('aisstream ws error:', e.message); try { ws.close(); } catch {} });
}
connect();

// Watchdog: if the stream goes quiet for 3 min, force a reconnect.
setInterval(() => {
  if (Date.now() - lastMsg > 180000) { console.log('stream idle, forcing reconnect'); try { ws.close(); } catch {} }
}, 60000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = (req.url || '/').split('?')[0];
  if (url === '/positions.json' || url === '/positions') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(store));
  } else if (url === '/health') {
    res.end('ok');
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      service: 'aisfleetmap-collector', tracking: mmsis.length,
      located: Object.keys(store.positions).length, generatedAt: store.generatedAt,
    }));
  }
});
server.listen(PORT, () => console.log('collector listening on', PORT));
