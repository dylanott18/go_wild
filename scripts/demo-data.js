// Generates FAKE sample data into ./demo-data so the UI can be previewed
// without running the scraper. Never publish this as real data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIRPORT_MAP } from '../web/lib/airports.js';
import { addDays, localToday, localToUtcMs, localNow } from '../web/lib/time.js';
import { emptyDay, mergeRouteScan, summarizeDay, minFareByRoute } from '../scraper/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'demo-data');
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const HOME = 'DEN';
const HUBS = ['MCO', 'LAS', 'ATL', 'PHL'];
const NET = {
  DEN: ['LAS', 'MCO', 'ATL', 'PHL', 'PHX', 'SLC', 'LAX', 'SAN', 'SEA', 'ORD', 'DFW', 'AUS', 'MSP', 'CUN', 'BOS', 'MIA', 'TPA', 'BNA', 'SJD', 'OMA', 'BZN'],
  MCO: ['DEN', 'SJU', 'PHL', 'ATL', 'BOS', 'CLE', 'PUJ', 'MBJ', 'LGA', 'ISP', 'BDL', 'STT'],
  LAS: ['DEN', 'LAX', 'SFO', 'SEA', 'PDX', 'ORD', 'ONT', 'BOI', 'RNO'],
  ATL: ['DEN', 'MCO', 'MIA', 'SJU', 'PHL', 'CUN', 'SAV', 'PUJ'],
  PHL: ['DEN', 'MCO', 'ATL', 'SJU', 'CUN', 'PUJ', 'MIA', 'RSW', 'MYR'],
};
const legs = [];
for (const [o, ds] of Object.entries(NET)) for (const d of ds) legs.push([o, d]);
for (const d of NET.DEN) if (!NET[d]?.includes('DEN')) legs.push([d, 'DEN']);

function blockMin(o, d) {
  const a = AIRPORT_MAP[o], b = AIRPORT_MAP[d];
  const km = Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 85);
  return Math.round(40 + km / 13);
}
function flight(o, d, date, depMin, num) {
  const dur = blockMin(o, d);
  const depLocal = `${date}T${String(Math.floor(depMin / 60)).padStart(2, '0')}:${String(depMin % 60).padStart(2, '0')}`;
  const arrMs = localToUtcMs(depLocal, AIRPORT_MAP[o].tz) + dur * 60000;
  return { f: `F9${num}`, o, d, dep: depLocal, arr: localNow(AIRPORT_MAP[d].tz, arrMs), dur };
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, 'days'), { recursive: true });
const now = Math.floor(Date.now() / 1000);
const index = { generatedAt: now - 600, homeAirports: [HOME], hubs: HUBS, extraAirports: [], tiers: [
  { name: 'near', scope: 'home', daysAhead: [0, 1], everyMinutes: 60, lastRun: now - 600 },
  { name: 'hubs', scope: 'hubs', daysAhead: [0, 1], everyMinutes: 180, lastRun: now - 4000 },
  { name: 'ahead', scope: 'home', daysAhead: [2, 3, 4, 5, 6, 7, 8, 9, 10], everyMinutes: 720, lastRun: now - 20000 }],
  lastRun: { at: now - 600, pages: 212, ok: 209, blocked: 0, errors: 3 }, recentRuns: [], dates: {} };
for (let i = 0; i < 8; i++) index.recentRuns.push({ at: now - 600 - i * 3600, pages: 212, ok: 205 + i % 4, blocked: i === 5 ? 2 : 0, errors: 1 });
const history = {};

const today = localToday('America/Denver');
for (let off = -20; off <= 10; off++) {
  const date = addDays(today, off);
  const day = emptyDay(date);
  const byRoute = new Map();
  let n = 100;
  for (const [o, d] of legs) {
    const count = 1 + Math.floor(rnd() * 3);
    const deps = [360 + Math.floor(rnd() * 120), 690 + Math.floor(rnd() * 200), 1050 + Math.floor(rnd() * 180)].slice(0, count);
    const its = deps.map((dm) => {
      const f = flight(o, d, date, dm, n++);
      const gwOpen = off <= 1 ? rnd() < 0.75 : rnd() < 0.35;
      const base = 14.98 + Math.round(rnd() * 6) * 10;
      return { k: `${o}-${d}-${date}-${f.f}`, o, d, dep: f.dep, arr: f.arr, dur: f.dur, st: 0, legs: [[f.f, o, d, f.dep, f.arr]],
        gw: gwOpen ? base : null, gws: gwOpen ? (rnd() < 0.3 ? null : 1 + Math.floor(rnd() * 9)) : null,
        den: 39.99 + Math.round(rnd() * 120), dens: rnd() < 0.5 ? 1 + Math.floor(rnd() * 8) : null, std: 79 + Math.round(rnd() * 200), stds: null };
    });
    byRoute.set(`${o}-${d}`, its);
  }
  // Frontier-sold connections from DEN via hubs (subset), some with GoWild
  for (const hub of HUBS) for (const d of NET[hub]) {
    if (d === HOME || rnd() < 0.5) continue;
    const a = byRoute.get(`${HOME}-${hub}`)?.[0];
    const b = byRoute.get(`${hub}-${d}`)?.find((x) => x.dep > a?.arr);
    if (!a || !b) continue;
    const gw = a.gw != null && b.gw != null && rnd() < 0.5 ? a.gw + 10 : null;
    const k = `${HOME}-${d}-${date}-${a.legs[0][0]}+${b.legs[0][0]}`;
    const list = byRoute.get(`${HOME}-${d}`) ?? [];
    list.push({ k, o: HOME, d, dep: a.dep, arr: b.arr, dur: null, st: 1, legs: [a.legs[0], b.legs[0]], gw, gws: gw ? Math.min(a.gws ?? 9, b.gws ?? 9) : null, den: 99, dens: null, std: 199, stds: null });
    byRoute.set(`${HOME}-${d}`, list);
  }
  for (const [route, its] of byRoute) {
    // simulate a few scans so seat history exists
    for (let s = 3; s >= 0; s--) {
      const ts = now - 600 - s * 3600 - Math.floor(rnd() * 600);
      const snap = its.map((it) => (s === 0 || it.gws == null ? it : { ...it, gws: Math.min(9, it.gws + s) }));
      mergeRouteScan(day, route, snap, ts);
    }
  }
  await fs.writeFile(path.join(OUT, 'days', `${date}.json`), JSON.stringify(day));
  index.dates[date] = summarizeDay(day);
  history[date] = minFareByRoute(day);
}
await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
await fs.writeFile(path.join(OUT, 'history.json'), JSON.stringify(history));
console.log(`Demo data (FAKE) written to ${OUT}`);
