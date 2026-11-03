// Pure data-merging logic for the scraper's JSON store. No I/O here so it can
// be unit tested; run.js does the reading and writing.
//
// Layout of the data directory (published with the site under /data):
//   index.json          summary per date + scanner health (the app loads this first)
//   days/YYYY-MM-DD.json all itineraries departing that date, with seat/fare history
//   routes.json         nonstop legs seen (learned route network)
//   state.json          scheduler state (tier timestamps, routes with no service)
//   runs.json           last runs (pages, blocks, errors)

const HISTORY_CAP = 200;

export function emptyDay(date) {
  return { date, scans: {}, itins: [] };
}

/** Keep an itinerary in storage? (keeps file sizes sane) */
function worthKeeping(it, hadHistory) {
  return it.st <= 1 || it.gw != null || hadHistory;
}

/**
 * Replace a route's itineraries in a day file with a fresh scan, carrying
 * history forward. Each itinerary gets:
 *   h  [[epochSec, gwFare|null, gwSeats|null], ...] appended on change
 *   fs first-seen epoch, t last-checked epoch
 * GoWild itineraries that vanish from results are kept with gw=null and
 * gone=true so the history shows when they sold out.
 */
export function mergeRouteScan(day, route, fresh, ts) {
  const [o, d] = route.split('-');
  const keep = [];
  const old = new Map();
  for (const it of day.itins) {
    if (it.o === o && it.d === d) old.set(it.k, it);
    else keep.push(it);
  }
  const seen = new Set();
  let changes = 0;
  for (const n of fresh) {
    if (seen.has(n.k)) continue;
    seen.add(n.k);
    const prev = old.get(n.k);
    const h = prev?.h ? prev.h.slice() : [];
    const last = h[h.length - 1];
    if (!last || last[1] !== n.gw || last[2] !== n.gws) {
      if (last || n.gw != null) { h.push([ts, n.gw, n.gws]); changes++; }
    }
    while (h.length > HISTORY_CAP) h.shift();
    if (!worthKeeping(n, h.length > 0)) continue;
    const item = { ...n, t: ts, fs: prev?.fs ?? ts };
    if (h.length) item.h = h;
    keep.push(item);
  }
  for (const [k, prev] of old) {
    if (seen.has(k)) continue;
    const hadGoWild = prev.h?.some((p) => p[1] != null);
    if (!hadGoWild) continue;
    const h = prev.h.slice();
    if (h[h.length - 1][1] !== null) { h.push([ts, null, 0]); changes++; }
    keep.push({ ...prev, gw: null, gws: 0, gone: true, h, t: ts });
  }
  keep.sort((a, b) => (a.dep < b.dep ? -1 : a.dep > b.dep ? 1 : a.k < b.k ? -1 : 1));
  day.itins = keep;
  day.scans[route] = ts;
  return changes;
}

/** Record nonstop legs observed in any itinerary (learned route network). */
export function learnLegs(routes, itins, date) {
  routes.legs ??= {};
  for (const it of itins) {
    for (const leg of it.legs) {
      const key = `${leg[1]}-${leg[2]}`;
      if (!routes.legs[key] || routes.legs[key] < date) routes.legs[key] = date;
    }
  }
}

/** Summaries the app needs before it loads any day file. */
export function summarizeDay(day) {
  const out = {};
  const inn = {};
  const nonstopOut = {};
  let gowild = 0;
  for (const it of day.itins) {
    if (it.gw == null) continue;
    gowild++;
    out[it.o] = (out[it.o] || 0) + 1;
    inn[it.d] = (inn[it.d] || 0) + 1;
    if (it.st === 0) nonstopOut[it.o] = (nonstopOut[it.o] || 0) + 1;
  }
  const times = Object.values(day.scans);
  return {
    scannedAt: times.length ? Math.max(...times) : null,
    oldestScan: times.length ? Math.min(...times) : null,
    routes: times.length,
    itins: day.itins.length,
    gowild,
    out,
    in: inn,
    nonstopOut,
  };
}

export function minFareByRoute(day) {
  // { "DEN-LAS": [minGoWildFare, maxSeats] } for historical pricing charts
  const res = {};
  for (const it of day.itins) {
    if (it.gw == null) continue;
    const key = `${it.o}-${it.d}`;
    const cur = res[key];
    if (!cur) res[key] = [it.gw, it.gws];
    else {
      cur[0] = Math.min(cur[0], it.gw);
      if (it.gws != null) cur[1] = Math.max(cur[1] ?? 0, it.gws);
    }
  }
  return res;
}

/** Should a route be skipped because it repeatedly returned nothing? */
export function isNoService(state, route, nowSec, recheckDays = 7) {
  const ns = state.noService?.[route];
  if (!ns || ns.empty < 3) return false;
  return nowSec - ns.checked < recheckDays * 86400;
}

export function recordRouteResult(state, route, count, nowSec) {
  state.noService ??= {};
  if (count > 0) { delete state.noService[route]; return; }
  const ns = state.noService[route] ?? { empty: 0, checked: 0 };
  ns.empty += 1;
  ns.checked = nowSec;
  state.noService[route] = ns;
}
