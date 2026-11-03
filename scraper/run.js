#!/usr/bin/env node
// Scheduler + crawler. Each invocation (e.g. a GitHub Actions cron run):
//   1. works out which tiers in config.json are due,
//   2. builds a prioritised list of (origin, destination, date) pages,
//   3. loads them through FrontierClient at low concurrency with jitter,
//   4. merges results into the JSON store and rewrites the index.
//
// Usage:
//   node scraper/run.js                 run whatever tiers are due
//   node scraper/run.js --tier=near     force a tier (comma list, or "all")
//   node scraper/run.js --route=DEN-LAS --date=2026-11-05   one-off check
//   node scraper/run.js --dry-run       print the plan, don't touch Frontier
//   node scraper/run.js --max-pages=20  cap pages this run
//   node scraper/run.js --headed        show the browser (local debugging)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAirports } from '../web/lib/airports.js';
import { addDays, localToday } from '../web/lib/time.js';
import { FrontierClient } from './frontier.js';
import { buildAlerts, sendAlerts } from './alerts.js';
import {
  emptyDay, mergeRouteScan, learnLegs, summarizeDay, minFareByRoute,
  isNoService, recordRouteResult,
} from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const config = await readJSON(path.join(ROOT, 'config.json'), {});
const airports = buildAirports(config.extraAirports);
const airportMap = Object.fromEntries(airports.map((a) => [a.code, a]));
const codes = airports.map((a) => a.code);
const home = (config.homeAirports ?? []).filter((c) => airportMap[c]);
const hubs = (config.hubs ?? []).filter((c) => airportMap[c]);

const state = await readJSON(path.join(DATA, 'state.json'), { tiers: {}, noService: {} });
const routes = await readJSON(path.join(DATA, 'routes.json'), { legs: {} });
const nowMs = Date.now();
const nowSec = Math.floor(nowMs / 1000);

// ---------- plan ----------
function dueTiers() {
  const tiers = config.tiers ?? [];
  if (args.tier) {
    const want = String(args.tier).split(',');
    return tiers.filter((t) => want.includes('all') || want.includes(t.name));
  }
  return tiers;
}

function knownNonstopsFrom(code) {
  return Object.keys(routes.legs).filter((k) => k.startsWith(`${code}-`)).map((k) => k.slice(4));
}
function knownNonstopsTo(code) {
  return Object.keys(routes.legs).filter((k) => k.endsWith(`-${code}`)).map((k) => k.slice(0, 3));
}

async function buildPlan(tiers) {
  const tasks = new Map();
  const add = (o, d, offset, tierIdx, maxAgeMin) => {
    if (o === d || !airportMap[o] || !airportMap[d]) return;
    const date = addDays(localToday(airportMap[o].tz, nowMs), offset);
    const key = `${o}-${d}|${date}`;
    const prio = offset * 10 + tierIdx;
    const cur = tasks.get(key);
    if (!cur || cur.prio > prio) tasks.set(key, { o, d, date, prio, maxAgeMin, tier: tiers[tierIdx].name });
  };
  tiers.forEach((tier, tierIdx) => {
    for (const offset of tier.daysAhead ?? [0]) {
      if (tier.scope === 'home') {
        for (const h of home) {
          for (const x of codes) { add(h, x, offset, tierIdx, tier.everyMinutes); add(x, h, offset, tierIdx, tier.everyMinutes); }
        }
      } else if (tier.scope === 'hubs') {
        for (const hub of hubs) {
          for (const x of knownNonstopsFrom(hub)) add(hub, x, offset, tierIdx, tier.everyMinutes);
          if (config.hubDirections === 'both') for (const x of knownNonstopsTo(hub)) add(x, hub, offset, tierIdx, tier.everyMinutes);
        }
      } else if (tier.scope === 'routes') {
        for (const r of tier.routes ?? []) { const [o, d] = r.split('-'); add(o, d, offset, tierIdx, tier.everyMinutes); }
      }
    }
  });
  // Only pages whose last scan is older than their tier's interval are due
  // (5 min slack so an hourly tier lines up with the 30-minute cron).
  const lastScan = {};
  for (const date of new Set([...tasks.values()].map((t) => t.date))) {
    lastScan[date] = (await readJSON(path.join(DATA, 'days', `${date}.json`), emptyDay(date))).scans;
  }
  let list = [...tasks.values()].filter((t) => !isNoService(state, `${t.o}-${t.d}`, nowSec)).map((t) => {
    const last = lastScan[t.date]?.[`${t.o}-${t.d}`] ?? 0;
    return { ...t, overdue: (nowSec - last) / 60 / t.maxAgeMin };
  }).filter((t) => t.overdue >= 1 - 5 / t.maxAgeMin);
  // Nearest dates first; within a date, the most overdue first, with a little
  // shuffle so we never walk one airport's routes in order.
  list.sort((a, b) => a.prio - b.prio || (b.overdue + Math.random() * 0.2) - (a.overdue + Math.random() * 0.2));
  return list;
}

let tiers = dueTiers();
let plan;
if (args.route) {
  const [o, d] = String(args.route).toUpperCase().split('-');
  const dates = args.date ? String(args.date).split(',') : [localToday(airportMap[o]?.tz ?? 'America/Denver', nowMs)];
  plan = dates.map((date) => ({ o, d, date, prio: 0 }));
  tiers = [];
} else {
  plan = await buildPlan(tiers);
}
const maxPages = Number(args['max-pages'] ?? config.maxPagesPerRun ?? 500);
const planned = plan.length;
plan = plan.slice(0, maxPages);

log(`Tiers: ${tiers.map((t) => t.name).join(', ') || (args.route ? 'manual route' : 'none')}`);
log(`Pages planned: ${planned}${planned > plan.length ? ` (capped to ${plan.length})` : ''}`);
if (hubs.length && tiers.some((t) => t.scope === 'hubs') && !Object.keys(routes.legs).length) {
  log('Hub tier has no learned route network yet; it will fill in after the first home scan.');
}

if (args['dry-run']) {
  for (const t of plan.slice(0, 40)) console.log(`  ${t.date} ${t.o}->${t.d}`);
  if (plan.length > 40) console.log(`  ...and ${plan.length - 40} more`);
  process.exit(0);
}
if (!plan.length) {
  log('Nothing due. Exiting.');
  await writeIndex([]);
  process.exit(0);
}

// ---------- crawl ----------
const days = new Map();
async function getDay(date) {
  if (!days.has(date)) days.set(date, await readJSON(path.join(DATA, 'days', `${date}.json`), emptyDay(date)));
  return days.get(date);
}

const alertEvents = [];
const stats = { at: nowSec, planned, pages: 0, ok: 0, empty: 0, blocked: 0, errors: 0, changes: 0, aborted: false, tiers: tiers.map((t) => t.name), sampleErrors: [] };
const deadline = nowMs + (config.maxMinutes ?? 45) * 60000;
const abortAfter = config.abortAfterConsecutiveBlocks ?? 6;
let consecutiveBlocks = 0;
let abort = false;

const client = new FrontierClient({ headless: !args.headed, airportMap });
await client.open();

let cursor = 0;
async function worker(id) {
  await sleep(id * 1500);
  while (!abort && cursor < plan.length) {
    if (Date.now() > deadline) { log('Time budget reached.'); abort = true; break; }
    const t = plan[cursor++];
    const route = `${t.o}-${t.d}`;
    const res = await client.search(t.o, t.d, t.date);
    stats.pages++;
    if (res.status === 'ok') {
      consecutiveBlocks = 0;
      stats.ok++;
      const ts = Math.floor(Date.now() / 1000);
      const day = await getDay(t.date);
      const evs = mergeRouteScan(day, route, res.itineraries, ts);
      stats.changes += evs.length;
      for (const ev of evs) alertEvents.push({ ...ev, date: t.date });
      learnLegs(routes, res.itineraries, t.date);
      recordRouteResult(state, route, res.itineraries.length, ts);
      if (!res.itineraries.length) stats.empty++;
      const gw = res.itineraries.filter((i) => i.gw != null);
      if (gw.length) log(`${t.date} ${route}: ${res.itineraries.length} itins, ${gw.length} GoWild`);
    } else if (res.status === 'blocked') {
      stats.blocked++;
      consecutiveBlocks++;
      log(`${t.date} ${route}: BLOCKED (${consecutiveBlocks} in a row)`);
      if (consecutiveBlocks >= abortAfter) { log('Too many blocks; stopping this run to stay polite.'); abort = true; stats.aborted = true; break; }
      await sleep(15000 + Math.random() * 15000);
    } else {
      stats.errors++;
      if (stats.sampleErrors.length < 5) stats.sampleErrors.push(`${route} ${t.date}: ${res.error}`);
      log(`${t.date} ${route}: error ${res.error}`);
    }
    if (stats.pages % 25 === 0) log(`Progress ${stats.pages}/${plan.length}`);
    await sleep(900 + Math.random() * 2200);
  }
}

try {
  await Promise.all(Array.from({ length: Math.max(1, config.concurrency ?? 2) }, (_, i) => worker(i)));
} finally {
  await client.close();
}

// ---------- persist ----------
for (const [date, day] of days) await writeJSON(path.join(DATA, 'days', `${date}.json`), day);
await writeJSON(path.join(DATA, 'routes.json'), routes);

state.tiers ??= {};
for (const name of new Set(plan.slice(0, stats.pages).map((t) => t.tier).filter(Boolean))) state.tiers[name] = nowSec;
state.lastRun = stats;
await writeJSON(path.join(DATA, 'state.json'), state);

const runs = await readJSON(path.join(DATA, 'runs.json'), []);
runs.unshift(stats);
await writeJSON(path.join(DATA, 'runs.json'), runs.slice(0, 60));

await writeIndex(runs);

const alerts = buildAlerts(alertEvents, config.alerts ?? []);
if (alerts.length) {
  if (process.env.NTFY_TOPIC) {
    const sent = await sendAlerts(alerts, { topic: process.env.NTFY_TOPIC, server: process.env.NTFY_SERVER, siteUrl: process.env.SITE_URL });
    log(`Sent ${sent} alert notification(s).`);
  } else {
    log(`${alerts.length} alert(s) matched, but the NTFY_TOPIC secret isn't set:`);
    for (const a of alerts) console.log(`  [${a.title}] ${a.message.split('\n').join(' | ')}`);
  }
}
log(`Done: ${stats.ok} ok (${stats.empty} empty), ${stats.blocked} blocked, ${stats.errors} errors, ${stats.changes} seat/fare changes.`);
if (stats.ok === 0 && stats.pages > 0) process.exitCode = 1;

// ---------- index ----------
async function writeIndex(runsList) {
  const dir = path.join(DATA, 'days');
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const cutoff = addDays(localToday('America/Denver', nowMs), -(config.retentionDays ?? 60));
  const dates = {};
  const history = await readJSON(path.join(DATA, 'history.json'), {});
  for (const f of files) {
    const date = f.slice(0, 10);
    if (date < cutoff) { await fs.unlink(path.join(dir, f)); delete history[date]; continue; }
    const day = days.get(date) ?? await readJSON(path.join(dir, f), emptyDay(date));
    dates[date] = summarizeDay(day);
    if (days.has(date) || !history[date]) history[date] = minFareByRoute(day);
  }
  for (const d of Object.keys(history)) if (!dates[d]) delete history[d];
  await writeJSON(path.join(DATA, 'history.json'), history);
  const runs = runsList.length ? runsList : await readJSON(path.join(DATA, 'runs.json'), []);
  await writeJSON(path.join(DATA, 'index.json'), {
    generatedAt: Math.floor(Date.now() / 1000),
    homeAirports: home,
    hubs,
    extraAirports: config.extraAirports ?? [],
    alerts: (config.alerts ?? []).map((a) => ({ name: a.name, from: a.from, to: a.to, notify: a.notify })),
    tiers: (config.tiers ?? []).map((t) => ({ name: t.name, scope: t.scope, daysAhead: t.daysAhead, everyMinutes: t.everyMinutes, lastRun: state.tiers?.[t.name] ?? null })),
    lastRun: runs[0] ?? null,
    recentRuns: runs.slice(0, 12).map((r) => ({ at: r.at, pages: r.pages, ok: r.ok, blocked: r.blocked, errors: r.errors, aborted: r.aborted })),
    dates,
  });
}
