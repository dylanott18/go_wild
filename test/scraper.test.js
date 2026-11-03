import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlightData, extractItineraries, frontierUrl, decodeEntities, looksBlocked } from '../scraper/frontier.js';
import { mergeRouteScan, emptyDay, summarizeDay, learnLegs, isNoService, recordRouteResult } from '../scraper/store.js';
import { AIRPORT_MAP } from '../web/lib/airports.js';

const rawFlight = (over = {}) => ({
  legs: [{ departureStation: 'DEN', arrivalStation: 'LAS', departureDate: '2026-11-05T06:00:00', arrivalDate: '2026-11-05T07:05:00', flightNumber: 1245, carrierCode: 'F9' }],
  duration: '2 hrs 05 min', stopCount: 0,
  standardFare: 129.99, discountDenFare: 89.99, goWildFare: 15.98,
  isGoWildFareEnabled: true, goWildFareKey: 'abc', goWildFareSeatsRemaining: '3',
  standardFareSeatsRemaining: null, discountDenFareSeatsRemaining: '4',
  ...over,
});

function encode(obj) {
  // Mimic Frontier: JSON, with otpData holding an unescaped nested JSON string, entity-encoded.
  const json = JSON.stringify(obj).replace('"otpData":"X"', '"otpData":"[{"a":1},{"b":"2"}]"');
  return json.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

test('frontierUrl formats the date the way the booking page expects', () => {
  assert.equal(frontierUrl('DEN', 'LAS', '2026-12-01'),
    'https://booking.flyfrontier.com/Flight/InternalSelect?o1=DEN&d1=LAS&dd1=Dec%2001%2C%202026&ADT=1&mon=true&promo=');
});

test('decodeEntities handles named and numeric entities once', () => {
  assert.equal(decodeEntities('&quot;a&amp;quot;&#39;&#x41;'), '"a&quot;\'A');
});

test('parses entity-encoded FlightData with a broken otpData field', () => {
  const encoded = encode({ otpData: 'X', journeys: [{ isReturnTrip: false, flights: [rawFlight()] }] });
  const data = parseFlightData(encoded);
  const [it] = extractItineraries(data, '2026-11-05', AIRPORT_MAP);
  assert.equal(it.k, 'DEN-LAS-2026-11-05-F91245');
  assert.equal(it.dep, '2026-11-05T06:00');
  assert.equal(it.arr, '2026-11-05T07:05');
  assert.equal(it.dur, 125);
  assert.equal(it.gw, 15.98);
  assert.equal(it.gws, 3);
  assert.equal(it.den, 89.99);
  assert.equal(it.dens, 4);
  assert.equal(it.st, 0);
});

test('no GoWild when fare is -1, disabled, or key is empty', () => {
  const flights = [rawFlight({ goWildFare: -1 }), rawFlight({ isGoWildFareEnabled: false }), rawFlight({ goWildFareKey: '' })];
  const its = extractItineraries({ journeys: [{ flights }] }, '2026-11-05', AIRPORT_MAP);
  assert.deepEqual(its.map((i) => i.gw), [null, null, null]);
  assert.deepEqual(its.map((i) => i.gws), [null, null, null]);
});

test('computes duration from time zones when not provided', () => {
  const its = extractItineraries({ journeys: [{ flights: [rawFlight({ duration: undefined })] }] }, '2026-11-05', AIRPORT_MAP);
  assert.equal(its[0].dur, 125); // DEN is UTC-7, LAS UTC-8 in November
});

test('skips return journeys and reads multi-leg itineraries', () => {
  const conn = rawFlight({
    legs: [
      { departureStation: 'DEN', arrivalStation: 'MCO', departureDate: '2026-11-05T08:00:00', arrivalDate: '2026-11-05T13:30:00', flightNumber: 10 },
      { departureStation: 'MCO', arrivalStation: 'SJU', departureDate: '2026-11-05T15:00:00', arrivalDate: '2026-11-05T18:50:00', flightNumber: 20 },
    ], stopCount: 1,
  });
  const its = extractItineraries({ journeys: [{ flights: [conn] }, { isReturnTrip: true, flights: [rawFlight()] }] }, '2026-11-05', AIRPORT_MAP);
  assert.equal(its.length, 1);
  assert.equal(its[0].k, 'DEN-SJU-2026-11-05-F910+F920');
  assert.equal(its[0].st, 1);
});

test('blocked page detection', () => {
  assert.ok(looksBlocked('<div id="px-captcha"></div>', 200));
  assert.ok(looksBlocked('', 403));
  assert.ok(!looksBlocked('<html>ok</html>', 200));
});

const it = (k, gw, gws, extra = {}) => ({ k, o: 'DEN', d: 'LAS', dep: '2026-11-05T06:00', arr: '2026-11-05T07:05', st: 0, legs: [['F91', 'DEN', 'LAS', '', '']], gw, gws, ...extra });

test('merge records seat history and sell-outs', () => {
  const day = emptyDay('2026-11-05');
  mergeRouteScan(day, 'DEN-LAS', [it('a', 15, 5)], 100);
  mergeRouteScan(day, 'DEN-LAS', [it('a', 15, 5)], 200); // unchanged -> no new point
  mergeRouteScan(day, 'DEN-LAS', [it('a', 15, 2)], 300);
  assert.deepEqual(day.itins[0].h, [[100, 15, 5], [300, 15, 2]]);
  assert.equal(day.itins[0].fs, 100);
  assert.equal(day.itins[0].t, 300);
  mergeRouteScan(day, 'DEN-LAS', [], 400); // vanished -> kept as sold out
  assert.equal(day.itins[0].gone, true);
  assert.equal(day.itins[0].gw, null);
  assert.deepEqual(day.itins[0].h.at(-1), [400, null, 0]);
  assert.equal(day.scans['DEN-LAS'], 400);
});

test('merge leaves other routes alone and summarizes', () => {
  const day = emptyDay('2026-11-05');
  mergeRouteScan(day, 'DEN-LAS', [it('a', 15, 5)], 100);
  mergeRouteScan(day, 'LAS-DEN', [it('b', 20, null, { o: 'LAS', d: 'DEN' })], 100);
  mergeRouteScan(day, 'DEN-LAS', [it('c', null, null)], 200);
  assert.deepEqual(day.itins.map((i) => i.k).sort(), ['a', 'b', 'c']);
  const s = summarizeDay(day);
  assert.equal(s.gowild, 1); // a is gone now, b remains
  assert.equal(s.out.LAS, 1);
});

test('route network + no-service tracking', () => {
  const routes = {};
  learnLegs(routes, [{ legs: [['F91', 'DEN', 'MCO'], ['F92', 'MCO', 'SJU']] }], '2026-11-05');
  assert.deepEqual(Object.keys(routes.legs).sort(), ['DEN-MCO', 'MCO-SJU']);
  const state = {};
  for (let i = 0; i < 3; i++) recordRouteResult(state, 'DEN-XNA', 0, 1000);
  assert.ok(isNoService(state, 'DEN-XNA', 2000));
  assert.ok(!isNoService(state, 'DEN-XNA', 1000 + 8 * 86400));
  recordRouteResult(state, 'DEN-XNA', 4, 3000);
  assert.ok(!isNoService(state, 'DEN-XNA', 3000));
});
