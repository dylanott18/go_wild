// Trip-building logic used by the web app. Pure functions over itinerary
// arrays (see scraper/frontier.js for the itinerary shape) so they are tested
// in Node too.

import { localMinutesBetween } from './time.js';

export const hasGoWild = (it) => it.gw != null;

/**
 * Same-day round trips ("no hotel"). Outbound H->X and return X->H on the
 * same date, with at least minGroundMin at the destination.
 * Returns one best option per destination (most time on the ground), plus
 * how many valid combinations exist.
 */
export function findDayTrips(itins, home, {
  goWildOnly = true, minGroundMin = 4 * 60, nonstopOnly = false,
  latestReturnArrival = '23:59', earliestDeparture = '00:00', now = null,
} = {}) {
  const ok = (it) => (!goWildOnly || hasGoWild(it)) && (!nonstopOnly || it.st === 0) && !it.gone;
  const outs = itins.filter((it) => it.o === home && ok(it)
    && it.dep.slice(11) >= earliestDeparture && (!now || it.dep > now));
  const backs = itins.filter((it) => it.d === home && ok(it));
  const backsByOrigin = new Map();
  for (const b of backs) {
    if (!backsByOrigin.has(b.o)) backsByOrigin.set(b.o, []);
    backsByOrigin.get(b.o).push(b);
  }
  const best = new Map();
  for (const out of outs) {
    const date = out.dep.slice(0, 10);
    if (out.arr.slice(0, 10) !== date) continue;
    for (const back of backsByOrigin.get(out.d) ?? []) {
      if (back.dep.slice(0, 10) !== date) continue;
      if (back.arr.slice(0, 10) !== date || back.arr.slice(11) > latestReturnArrival) continue;
      const ground = localMinutesBetween(out.arr, back.dep);
      if (ground < minGroundMin) continue;
      const cur = best.get(out.d);
      const option = { dest: out.d, out, back, groundMin: ground };
      if (!cur) best.set(out.d, { ...option, options: 1 });
      else {
        cur.options++;
        if (ground > cur.groundMin) Object.assign(cur, option);
      }
    }
  }
  return [...best.values()].sort((a, b) => b.groundMin - a.groundMin);
}

/**
 * Self-built two-ticket connections A -> M -> B from nonstop legs, where
 * Frontier does not sell that exact pair of flights as one ticket with
 * GoWild seats. Pass origin, destination or both (null = any).
 */
export function findHiddenConnections(itins, {
  origin = null, destination = null, minLayoverMin = 90, maxLayoverMin = 6 * 60,
  goWildOnly = true, includeSold = false, now = null,
} = {}) {
  const legs = itins.filter((it) => it.st === 0 && !it.gone && (!goWildOnly || hasGoWild(it)));
  // Flights sold as one GoWild ticket, keyed by flight-number chain.
  const sold = new Set(itins.filter((it) => it.st > 0 && hasGoWild(it)).map((it) => `${it.o}-${it.d}|${it.legs.map((l) => l[0]).join('+')}`));
  const byOrigin = new Map();
  for (const l of legs) {
    if (!byOrigin.has(l.o)) byOrigin.set(l.o, []);
    byOrigin.get(l.o).push(l);
  }
  const results = [];
  for (const first of legs) {
    if (origin && first.o !== origin) continue;
    if (now && first.dep <= now) continue;
    for (const second of byOrigin.get(first.d) ?? []) {
      if (second.d === first.o) continue;
      if (destination && second.d !== destination) continue;
      const layover = localMinutesBetween(first.arr, second.dep);
      if (layover < minLayoverMin || layover > maxLayoverMin) continue;
      const chain = `${first.o}-${second.d}|${first.legs[0][0]}+${second.legs[0][0]}`;
      const soldTogether = sold.has(chain);
      if (soldTogether && !includeSold) continue;
      const seatsOf = (it) => (it.gws == null ? Infinity : it.gws);
      const minSeats = Math.min(seatsOf(first), seatsOf(second));
      results.push({
        o: first.o, via: first.d, d: second.d, first, second, layoverMin: layover, soldTogether,
        dep: first.dep, arr: second.arr,
        total: (first.gw ?? 0) + (second.gw ?? 0),
        minSeats: minSeats === Infinity ? null : minSeats,
      });
    }
  }
  results.sort((a, b) => (a.arr < b.arr ? -1 : 1));
  return results;
}

/** Seat badge level: used for colour + label (never colour alone). */
export function seatLevel(it) {
  if (it.gw == null) return { level: 'none', label: it.gone ? 'Sold out' : 'No GoWild' };
  if (it.gws == null) return { level: 'good', label: 'Available' };
  if (it.gws <= 2) return { level: 'critical', label: `${it.gws} left` };
  if (it.gws <= 5) return { level: 'warning', label: `${it.gws} left` };
  return { level: 'good', label: `${it.gws} left` };
}

/** Connections inside one itinerary: [{at, min, overnight}] */
export function layovers(it) {
  const res = [];
  for (let i = 1; i < it.legs.length; i++) {
    const arr = it.legs[i - 1][4];
    const dep = it.legs[i][3];
    if (!arr || !dep) continue;
    const min = localMinutesBetween(arr, dep);
    // Overnight = the next flight leaves on a later calendar day, or a long
    // gap that spans 1am–5am (a night spent in the airport).
    const overnight = dep.slice(0, 10) > arr.slice(0, 10) ? min > 180 || dep.slice(11) >= '05:00'
      : min >= 360 && arr.slice(11) < '05:00';
    res.push({ at: it.legs[i][1], min, overnight });
  }
  return res;
}

export const isOvernight = (it) => layovers(it).some((l) => l.overnight);

/**
 * Does an itinerary match an alert watch rule from config.json?
 * rule: { from, to ("*" = anywhere), nonstopOnly, maxFare, dates: [..] }
 */
export function matchesWatch(rule, it, date) {
  if (rule.from && rule.from !== '*' && rule.from !== it.o) return false;
  if (rule.to && rule.to !== '*' && rule.to !== it.d) return false;
  if (rule.nonstopOnly && it.st !== 0) return false;
  if (rule.noOvernight !== false && isOvernight(it)) return false;
  if (rule.maxFare != null && (it.gw == null || it.gw > rule.maxFare)) return false;
  if (rule.dates?.length && !rule.dates.includes(date)) return false;
  return true;
}
