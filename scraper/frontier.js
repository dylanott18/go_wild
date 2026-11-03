// Frontier booking-page client.
//
// Frontier has no public API. Its booking results page
//   https://booking.flyfrontier.com/Flight/InternalSelect?o1=DEN&d1=LAS&dd1=Nov%2005,%202026&ADT=1&mon=true&promo=
// embeds every itinerary for that origin/destination/date as an HTML-entity
// encoded JSON string assigned to `window.FlightData`. The page sits behind a
// JavaScript bot check, so plain HTTP requests are rejected; we drive a real
// headless Chromium with Playwright and read the variable after load.
//
// Parsing is kept separate from the browser so it can be unit tested.

import { localToUtcMs } from '../web/lib/time.js';

import { frontierUrl } from '../web/lib/links.js';

export { frontierUrl };

const NAMED = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// `otpData` holds a JSON array serialised as a string whose inner quotes are
// not escaped once entities are decoded, which breaks JSON.parse. We don't use
// it, so remove it.
function stripOtpEncoded(s) {
  return s.replace(/&quot;otpData&quot;\s*:\s*&quot;[\s\S]*?\]&quot;/g, '&quot;otpData&quot;:null');
}
function stripOtpDecoded(s) {
  return s.replace(/"otpData"\s*:\s*"\[[\s\S]*?\]"(?=\s*[,}])/g, '"otpData":null');
}

export function parseFlightData(raw, depth = 0) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new Error('FlightData missing');
  const s = raw.trim();
  const attempts = [s, decodeEntities(s), decodeEntities(stripOtpEncoded(s)), stripOtpDecoded(decodeEntities(s))];
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (typeof v === 'string' && depth < 2) return parseFlightData(v, depth + 1);
      if (v && typeof v === 'object') return v;
    } catch { /* try next */ }
  }
  throw new Error('Could not parse FlightData JSON');
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function seats(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function localTime(v) {
  if (!v) return '';
  return String(v).replace(' ', 'T').slice(0, 16);
}
function parseDuration(s) {
  if (!s) return null;
  const str = String(s);
  let m = str.match(/(\d+)\s*h(?:rs?|ours?)?\s*(?:(\d+)\s*m)?/i);
  if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
  m = str.match(/^(\d+):(\d{2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = str.match(/^(\d+)\s*m/i);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Normalise one raw Frontier itinerary into our compact shape:
 *   k    unique key  ORG-DST-YYYY-MM-DD-F9123+F9456
 *   o,d  origin / final destination
 *   dep,arr local times "YYYY-MM-DDTHH:MM"
 *   dur  minutes, st stops
 *   legs [[flightNo, from, to, dep, arr], ...]
 *   gw   GoWild all-in price (null = no GoWild seats)
 *   gws  GoWild seats remaining as reported (null = not reported)
 *   den/dens  Discount Den fare & seats, std/stds standard fare & seats
 */
export function normalizeItinerary(raw, date, airportMap = {}) {
  const rawLegs = raw.legs ?? raw.segments ?? [];
  const legs = rawLegs.map((l) => [
    `${l.carrierCode ?? 'F9'}${l.flightNumber ?? ''}`.trim(),
    l.departureStation ?? l.origin ?? '',
    l.arrivalStation ?? l.destination ?? '',
    localTime(l.departureDate ?? l.departureTime ?? l.std),
    localTime(l.arrivalDate ?? l.arrivalTime ?? l.sta),
  ]);
  if (!legs.length) return null;
  const first = legs[0];
  const last = legs[legs.length - 1];
  const o = first[1];
  const d = last[2];

  const gwRaw = num(raw.goWildFare);
  const enabled = raw.isGoWildFareEnabled;
  const hasKey = raw.goWildFareKey === undefined || raw.goWildFareKey === null || raw.goWildFareKey !== '';
  const isGoWild = gwRaw != null && gwRaw > 0 && enabled !== false && hasKey;

  let dur = parseDuration(raw.duration ?? raw.durationFormatted);
  if (dur == null && airportMap[o] && airportMap[d] && first[3] && last[4]) {
    dur = Math.round((localToUtcMs(last[4], airportMap[d].tz) - localToUtcMs(first[3], airportMap[o].tz)) / 60000);
  }

  const it = {
    k: `${o}-${d}-${date}-${legs.map((l) => l[0]).join('+')}`,
    o, d,
    dep: first[3],
    arr: last[4],
    dur,
    st: num(raw.stopCount) ?? (typeof raw.stops === 'number' ? raw.stops : legs.length - 1),
    legs,
    gw: isGoWild ? gwRaw : null,
    gws: isGoWild ? seats(raw.goWildFareSeatsRemaining) : null,
    den: num(raw.discountDenFare) > 0 ? num(raw.discountDenFare) : null,
    dens: seats(raw.discountDenFareSeatsRemaining),
    std: num(raw.standardFare) > 0 ? num(raw.standardFare) : null,
    stds: seats(raw.standardFareSeatsRemaining),
  };
  return it;
}

export function extractItineraries(data, date, airportMap = {}) {
  const journeys = data?.journeys ?? data?.Journeys ?? [];
  const out = [];
  for (const j of journeys) {
    if (j?.isReturnTrip) continue;
    for (const f of j?.flights ?? []) {
      const it = normalizeItinerary(f, date, airportMap);
      if (it) out.push(it);
    }
  }
  return out;
}

export function looksBlocked(html, status) {
  if (status === 403 || status === 429) return true;
  return /px-captcha|_pxCaptcha|Access to this page has been denied|Press &amp; Hold|Press & Hold|perimeterx/i.test(html || '');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class FrontierClient {
  constructor({ headless = true, airportMap = {} } = {}) {
    this.headless = headless;
    this.airportMap = airportMap;
  }

  async open() {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: this.headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.context = await this.browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      timezoneId: 'America/Denver',
      viewport: { width: 1366, height: 900 },
    });
    // Save bandwidth: we only need the HTML and scripts.
    await this.context.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });
    // Warm up cookies the way a person would arrive.
    try {
      const p = await this.context.newPage();
      await p.goto('https://www.flyfrontier.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(1500);
      await p.close();
    } catch { /* not fatal */ }
  }

  async close() {
    await this.browser?.close();
  }

  /** @returns {Promise<{status:'ok'|'blocked'|'error', itineraries?:object[], error?:string}>} */
  async search(origin, dest, date) {
    const page = await this.context.newPage();
    try {
      const resp = await page.goto(frontierUrl(origin, dest, date), { waitUntil: 'domcontentloaded', timeout: 45000 });
      const status = resp?.status() ?? 0;
      try {
        await page.waitForFunction(
          () => typeof window.FlightData !== 'undefined' || !!document.querySelector('#px-captcha'),
          null, { timeout: 20000 },
        );
      } catch { /* fall through to HTML inspection */ }
      let raw = await page.evaluate(() => (typeof window.FlightData === 'undefined' ? null : window.FlightData));
      if (raw == null) {
        const html = await page.content();
        const m = html.match(/FlightData\s*=\s*'([\s\S]*?)'\s*;/) || html.match(/FlightData\s*=\s*"([\s\S]*?)"\s*;/);
        if (m) raw = m[1];
        else if (looksBlocked(html, status)) return { status: 'blocked' };
        else return { status: 'error', error: `FlightData not found (HTTP ${status})` };
      }
      const data = parseFlightData(raw);
      return { status: 'ok', itineraries: extractItineraries(data, date, this.airportMap) };
    } catch (e) {
      return { status: 'error', error: String(e?.message || e).slice(0, 200) };
    } finally {
      await page.close().catch(() => {});
    }
  }
}
