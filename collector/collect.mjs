#!/usr/bin/env node
// Collects current AIS positions for the fleet in ships.json from aisstream.io
// and merges them into ../positions.json (last-known-wins). Runs for a fixed
// window then exits. Key comes from env AISSTREAM_API_KEY (a GitHub Secret in CI).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY = process.env.AISSTREAM_API_KEY;
const WINDOW_S = Number(process.env.COLLECT_SECONDS || 90);
// Bounding box: Bay of Biscay -> Norway/Baltic, covers every origin port.
const BBOX = [[[40.0, -15.0], [71.0, 31.0]]];

if (!KEY) { console.error('Missing AISSTREAM_API_KEY'); process.exit(1); }

const fleet = JSON.parse(fs.readFileSync(path.join(ROOT, 'ships.json'), 'utf8'));
const mmsis = fleet.ships.map(s => String(s.mmsi)).filter(Boolean);
const nameByMMSI = Object.fromEntries(fleet.ships.map(s => [String(s.mmsi), s.name]));

const posPath = path.join(ROOT, 'positions.json');
let store = { generatedAt: null, positions: {} };
try { store = JSON.parse(fs.readFileSync(posPath, 'utf8')); } catch { /* first run */ }
if (!store.positions) store.positions = {};

let received = 0;
const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

const finish = () => {
  try { ws.close(); } catch {}
  store.generatedAt = new Date().toISOString();
  fs.writeFileSync(posPath, JSON.stringify(store, null, 2) + '\n');
  const known = Object.keys(store.positions).length;
  console.log(`Done. ${received} live updates this run; ${known}/${mmsis.length} ships with a known position.`);
  process.exit(0);
};

ws.on('open', () => {
  ws.send(JSON.stringify({
    APIKey: KEY,
    BoundingBoxes: BBOX,
    FiltersShipMMSI: mmsis,
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData'],
  }));
  console.log(`Subscribed, collecting for ${WINDOW_S}s...`);
  setTimeout(finish, WINDOW_S * 1000);
});

ws.on('message', (raw) => {
  let d; try { d = JSON.parse(raw.toString()); } catch { return; }
  if (d.error) { console.error('aisstream error:', d.error); return; }
  const md = d.MetaData || {};
  const mmsi = String(md.MMSI || md.MMSI_String || '');
  if (!nameByMMSI[mmsi]) return;
  const prev = store.positions[mmsi] || {};
  const p = { ...prev, mmsi, name: nameByMMSI[mmsi] };
  if (md.latitude != null && md.longitude != null) { p.lat = md.latitude; p.lon = md.longitude; }
  const msg = d.Message || {};
  const pr = msg.PositionReport || msg.StandardClassBPositionReport || msg.ExtendedClassBPositionReport;
  if (pr) {
    if (pr.Latitude != null) { p.lat = pr.Latitude; p.lon = pr.Longitude; }
    if (pr.Sog != null && pr.Sog < 102.3) p.sog = pr.Sog;
    if (pr.Cog != null && pr.Cog < 360) p.cog = pr.Cog;
    if (pr.TrueHeading != null && pr.TrueHeading < 360) p.hdg = pr.TrueHeading;
  }
  if (p.lat == null) return; // static-only message with no position yet
  p.t = (md.time_utc ? new Date(md.time_utc) : new Date()).toISOString();
  store.positions[mmsi] = p;
  received++;
});

ws.on('error', (e) => { console.error('WebSocket error:', e.message); finish(); });
// Safety net if the socket never opens.
setTimeout(finish, (WINDOW_S + 20) * 1000);
