import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDayTrips, findHiddenConnections, seatLevel } from '../web/lib/planner.js';
import { localToUtcMs, localNow, addDays } from '../web/lib/time.js';

const f = (o, d, dep, arr, num, gw = 10, gws = 4, st = 0, legs) => ({
  k: `${o}-${d}-${dep.slice(0, 10)}-${num}`, o, d, dep, arr, st, gw, gws,
  legs: legs ?? [[num, o, d, dep, arr]],
});

test('day trips pair morning out with evening back and keep the longest stay', () => {
  const itins = [
    f('DEN', 'LAS', '2026-11-05T06:00', '2026-11-05T07:05', 'F91'),
    f('DEN', 'LAS', '2026-11-05T09:00', '2026-11-05T10:05', 'F93'),
    f('LAS', 'DEN', '2026-11-05T19:00', '2026-11-05T21:50', 'F92'),
    f('LAS', 'DEN', '2026-11-05T09:30', '2026-11-05T12:20', 'F94'), // too early
    f('DEN', 'MCO', '2026-11-05T06:00', '2026-11-05T11:40', 'F95'),
    f('MCO', 'DEN', '2026-11-05T13:00', '2026-11-05T15:00', 'F96'), // < 4h on ground
  ];
  const trips = findDayTrips(itins, 'DEN');
  assert.equal(trips.length, 1);
  assert.equal(trips[0].dest, 'LAS');
  assert.equal(trips[0].out.legs[0][0], 'F91');
  assert.equal(trips[0].groundMin, 715);
  assert.equal(trips[0].options, 2);
});

test('day trips respect GoWild-only', () => {
  const itins = [
    f('DEN', 'LAS', '2026-11-05T06:00', '2026-11-05T07:05', 'F91'),
    f('LAS', 'DEN', '2026-11-05T19:00', '2026-11-05T21:50', 'F92', null, null),
  ];
  assert.equal(findDayTrips(itins, 'DEN').length, 0);
  assert.equal(findDayTrips(itins, 'DEN', { goWildOnly: false }).length, 1);
});

test('hidden connections build two-ticket trips and skip ones Frontier sells', () => {
  const itins = [
    f('DEN', 'MCO', '2026-11-05T06:00', '2026-11-05T11:40', 'F91', 20, 3),
    f('MCO', 'SJU', '2026-11-05T13:30', '2026-11-05T17:20', 'F92', 25, 6),
    f('MCO', 'PHL', '2026-11-05T12:00', '2026-11-05T14:30', 'F93'), // 20 min layover: too tight
    f('MCO', 'BOS', '2026-11-05T14:00', '2026-11-05T17:00', 'F94'),
    // Frontier sells DEN-BOS via F91+F94 with GoWild -> not hidden
    f('DEN', 'BOS', '2026-11-05T06:00', '2026-11-05T17:00', 'F91+F94', 30, 2, 1, [['F91', 'DEN', 'MCO'], ['F94', 'MCO', 'BOS']]),
  ];
  const res = findHiddenConnections(itins, { origin: 'DEN' });
  assert.equal(res.length, 1);
  assert.equal(res[0].d, 'SJU');
  assert.equal(res[0].via, 'MCO');
  assert.equal(res[0].layoverMin, 110);
  assert.equal(res[0].minSeats, 3);
  assert.equal(res[0].total, 45);
  assert.equal(findHiddenConnections(itins, { origin: 'DEN', includeSold: true }).length, 2);
  assert.equal(findHiddenConnections(itins, { destination: 'SJU' }).length, 1);
});

test('seat levels carry a label', () => {
  assert.deepEqual(seatLevel({ gw: 10, gws: 1 }), { level: 'critical', label: '1 left' });
  assert.deepEqual(seatLevel({ gw: 10, gws: null }), { level: 'good', label: 'Available' });
  assert.equal(seatLevel({ gw: null, gone: true }).label, 'Sold out');
});

test('time zone helpers round-trip', () => {
  const ms = localToUtcMs('2026-11-05T06:00', 'America/Denver');
  assert.equal(new Date(ms).toISOString(), '2026-11-05T13:00:00.000Z');
  assert.equal(localNow('America/Denver', ms), '2026-11-05T06:00');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

import { layovers, isOvernight, matchesWatch } from '../web/lib/planner.js';
import { buildAlerts } from '../scraper/alerts.js';
import { mergeRouteScan, emptyDay } from '../scraper/store.js';

const conn = (a, b) => ({ o: 'DEN', d: 'LAS', st: 1, legs: [['F91', 'DEN', 'IAH', '2026-11-03T17:17', a], ['F92', 'IAH', 'LAS', b, '2026-11-04T09:00']] });

test('overnight detection (from real Frontier itineraries)', () => {
  assert.ok(isOvernight(conn('2026-11-03T20:48', '2026-11-04T06:00'))); // sleep at IAH
  assert.ok(isOvernight(conn('2026-11-04T00:43', '2026-11-04T11:30'))); // land after midnight, leave late morning
  assert.ok(!isOvernight(conn('2026-11-03T23:30', '2026-11-04T00:30'))); // tight red-eye connection
  assert.ok(!isOvernight(conn('2026-11-03T12:00', '2026-11-03T14:00')));
  assert.equal(layovers(conn('2026-11-03T12:00', '2026-11-03T14:00'))[0].min, 120);
});

test('alert events: opened / low / soldout, none on first scan', () => {
  const it = (gw, gws) => ({ k: 'a', o: 'DEN', d: 'LAS', dep: '2026-11-05T06:00', arr: '2026-11-05T07:00', st: 0, legs: [['F91', 'DEN', 'LAS', '2026-11-05T06:00', '2026-11-05T07:00']], gw, gws });
  const day = emptyDay('2026-11-05');
  assert.deepEqual(mergeRouteScan(day, 'DEN-LAS', [it(null, null)], 1), []);
  assert.deepEqual(mergeRouteScan(day, 'DEN-LAS', [it(15, 6)], 2).map((e) => e.type), ['opened']);
  assert.deepEqual(mergeRouteScan(day, 'DEN-LAS', [it(15, 5)], 3).map((e) => e.type), []);
  assert.deepEqual(mergeRouteScan(day, 'DEN-LAS', [it(15, 2)], 4).map((e) => e.type), ['low']);
  assert.deepEqual(mergeRouteScan(day, 'DEN-LAS', [it(null, null)], 5).map((e) => e.type), ['soldout']);
  const fresh = emptyDay('2026-11-05');
  assert.deepEqual(mergeRouteScan(fresh, 'DEN-LAS', [it(15, 6)], 1), []); // first-ever scan: no flood
});

test('watch rules and alert messages', () => {
  const it = { o: 'DEN', d: 'LAS', st: 0, dep: '2026-11-05T06:00', legs: [['F91', 'DEN', 'LAS', '2026-11-05T06:00', '2026-11-05T07:00']], gw: 15.41, gws: 3 };
  assert.ok(matchesWatch({ from: 'DEN', to: '*' }, it, '2026-11-05'));
  assert.ok(!matchesWatch({ from: 'DEN', to: 'MCO' }, it, '2026-11-05'));
  assert.ok(!matchesWatch({ from: 'DEN', maxFare: 10 }, it, '2026-11-05'));
  assert.ok(!matchesWatch({ from: 'DEN', dates: ['2026-11-06'] }, it, '2026-11-05'));
  const [a] = buildAlerts([{ type: 'opened', it, date: '2026-11-05' }, { type: 'soldout', it, date: '2026-11-05' }], [{ name: 'Vegas', from: 'DEN', to: 'LAS' }]);
  assert.equal(a.title, 'Vegas');
  assert.equal(a.message, 'GoWild open: DEN→LAS 11-05 6:00a $15.41 · 3 left');
  assert.equal(a.priority, 4);
});
