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
