import { buildAirports } from './lib/airports.js';
import { localNow, localToday, addDays, fmtDuration, fmtClock, fmtAgo, localMinutesBetween } from './lib/time.js';
import { findDayTrips, findHiddenConnections, seatLevel, layovers, isOvernight } from './lib/planner.js';
import { forecasts, chip as wxChip, describe as wxDescribe, isRough } from './lib/weather.js';
import { drawRouteMap, destroyMap } from './lib/map.js';
import { frontierUrl } from './lib/links.js';
import { lineChart, sparkline } from './lib/charts.js';

// ---------------------------------------------------------------- utilities
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => (v == null ? '—' : `$${v.toFixed(2)}`);
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateObj = (d) => new Date(`${d}T12:00:00Z`);
const fmtDate = (d) => { const x = dateObj(d); return `${DOW[x.getUTCDay()]} ${MON[x.getUTCMonth()]} ${x.getUTCDate()}`; };
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------- state
let AIRPORTS = buildAirports();
let AP = Object.fromEntries(AIRPORTS.map((a) => [a.code, a]));
const DEFAULT_FILTERS = { gw: true, nonstop: false, hideDeparted: true, noOvernight: false, minSeats: 0, window: 'any', sort: 'dep', q: '', ground: 4, minLay: 90, maxLay: 360, hiddenDir: 'from' };
const S = {
  index: null,
  days: new Map(),
  history: null,
  origin: store.get('gw.origin', null),
  mode: 'from',
  date: null,
  f: { ...DEFAULT_FILTERS, ...store.get('gw.filters', {}) },
  expanded: new Set(),
  track: store.get('gw.track', []),
  view: store.get('gw.view', 'list'),
  ret: null,
  mapGroups: null,
};

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('o') && AP[p.get('o')]) S.origin = p.get('o');
  if (p.get('m')) S.mode = p.get('m');
  if (p.get('d') && /^\d{4}-\d{2}-\d{2}$/.test(p.get('d'))) S.date = p.get('d');
  if (p.get('r') && /^\d{4}-\d{2}-\d{2}$/.test(p.get('r'))) S.ret = p.get('r');
  return p;
}
function writeHash() {
  const p = new URLSearchParams({ o: S.origin, m: S.mode, d: S.date, ...(S.mode === 'round' ? { r: S.ret } : {}) });
  history.replaceState(null, '', `#${p}`);
  store.set('gw.origin', S.origin);
  store.set('gw.filters', S.f);
}

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
function loadDay(date) {
  if (!S.days.has(date)) {
    S.days.set(date, S.index?.dates?.[date]
      ? getJSON(`data/days/${date}.json`).catch(() => null)
      : Promise.resolve(null));
  }
  return S.days.get(date);
}
async function loadHistory() {
  if (!S.history) S.history = getJSON('data/history.json').catch(() => ({}));
  return S.history;
}

const tzOf = (code) => AP[code]?.tz ?? 'America/Denver';
const today = () => localToday(tzOf(S.origin));
const isDeparted = (it) => it.dep <= localNow(tzOf(it.o));
const isHome = (code) => (S.index?.homeAirports ?? []).includes(code);
const pinnedKey = (k, date) => S.track.some((t) => t.k === k && t.date === date);
const isBlackout = (d) => (S.index?.blackoutDates ?? []).includes(d);
const passOk = (it) => !S.f.noOvernight || !isOvernight(it);

// ---------------------------------------------------------------- header
function renderOriginSelect() {
  const sel = $('#origin');
  const homes = S.index?.homeAirports ?? [];
  const opt = (a) => `<option value="${a.code}">${a.code} · ${esc(a.city)}</option>`;
  sel.innerHTML = (homes.length ? `<optgroup label="Fully scanned">${homes.map((c) => AP[c]).filter(Boolean).map(opt).join('')}</optgroup>` : '')
    + `<optgroup label="All airports">${AIRPORTS.filter((a) => !homes.includes(a.code)).map(opt).join('')}</optgroup>`;
  sel.value = S.origin;
  sel.onchange = () => { S.origin = sel.value; S.expanded.clear(); render(); };
}

function renderStatus() {
  const btn = $('#status');
  const idx = S.index;
  if (!idx) { btn.innerHTML = '<span class="dot none"></span><span>No data yet</span>'; return; }
  const run = idx.lastRun;
  const age = (Date.now() / 1000 - (idx.generatedAt ?? 0)) / 60;
  let level = 'good';
  let text = `Updated ${fmtAgo(idx.generatedAt)}`;
  if (run && run.pages && run.blocked >= run.ok) { level = 'critical'; text = 'Scanner blocked'; }
  else if (age > 180) level = 'warning';
  btn.innerHTML = `<span class="dot ${level}"></span><span>${text}</span>`;
}

function renderTabs() {
  for (const t of document.querySelectorAll('.tab')) {
    t.setAttribute('aria-selected', String(t.dataset.mode === S.mode));
    t.onclick = () => { S.mode = t.dataset.mode; S.expanded.clear(); render(); };
  }
  $('#track-count').textContent = S.track.length ? String(S.track.length) : '';
}

function countFor(date) {
  const d = S.index?.dates?.[date];
  if (!d) return null;
  if (S.mode === 'to') return d.in?.[S.origin] ?? 0;
  if (S.mode === 'hidden') return d.nonstopOut?.[S.origin] ?? 0;
  return d.out?.[S.origin] ?? 0;
}

function renderDates() {
  const box = $('#dates');
  if (S.mode === 'track') { box.innerHTML = ''; return; }
  const start = today();
  // Far-off date chosen (e.g. from the calendar): centre the strip on it.
  const first = S.date > addDays(start, 13) || S.date < start ? addDays(S.date, -3) : start;
  const days = Array.from({ length: 14 }, (_, i) => addDays(first, i));
  box.innerHTML = days.map((d) => {
    const c = countFor(d);
    const x = dateObj(d);
    return `<button class="date-chip${c == null ? ' unscanned' : ''}${isBlackout(d) ? ' blackout' : ''}" data-date="${d}" aria-pressed="${d === S.date}" title="${fmtDate(d)}">
      <div class="dow">${d === start ? 'Today' : DOW[x.getUTCDay()]}</div><div class="dnum">${x.getUTCDate()}</div>
      <div class="dcount">${isBlackout(d) ? 'blackout' : c == null ? 'not scanned' : `${c} GW`}</div></button>`;
  }).join('') + '<button class="date-chip cal" id="open-cal" title="Full calendar"><span style="font-size:18px">▦</span>Calendar</button>';
  box.onclick = (e) => {
    const b = e.target.closest('.date-chip');
    if (!b) return;
    if (b.id === 'open-cal') return openCalendar();
    S.date = b.dataset.date;
    render();
  };
  box.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function renderFilters() {
  const f = S.f;
  const box = $('#filters');
  const tog = (key, label) => `<button class="toggle" data-tog="${key}" aria-pressed="${!!f[key]}">${label}</button>`;
  const sel = (key, label, opts) => `<label class="muted" style="font-size:13px">${label} <select data-sel="${key}">${opts.map(([v, t]) => `<option value="${v}"${String(f[key]) === String(v) ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  let html = '';
  if (S.mode === 'from' || S.mode === 'to') {
    html = `<span class="seg"><button class="toggle" data-view="list" aria-pressed="${S.view !== 'map'}">List</button><button class="toggle" data-view="map" aria-pressed="${S.view === 'map'}">Map</button></span>`
      + tog('gw', 'GoWild only') + tog('nonstop', 'Nonstop only') + tog('noOvernight', 'No overnight layovers') + tog('hideDeparted', 'Hide departed')
      + sel('minSeats', 'Seats', [[0, 'Any'], [1, '1+'], [2, '2+'], [4, '4+'], [6, '6+']])
      + sel('window', 'Departs', [['any', 'Any time'], ['morning', 'Before noon'], ['afternoon', '12–5pm'], ['evening', 'After 5pm']])
      + sel('sort', 'Sort', [['dep', 'Departure'], ['price', 'GoWild price'], ['seats', 'Most seats'], ['dur', 'Shortest'], ['code', 'Airport A–Z']])
      + `<input type="search" data-q placeholder="${S.mode === 'from' ? 'Destination' : 'Origin'} code or city" value="${esc(f.q)}">`;
  } else if (S.mode === 'round') {
    const opts = Array.from({ length: 28 }, (_, i) => addDays(S.date, i + 1)).map((d) => {
      const tag = isBlackout(d) ? ' · blackout' : S.index?.dates?.[d] ? '' : ' · not scanned';
      return `<option value="${d}"${d === S.ret ? ' selected' : ''}>${fmtDate(d)}${tag}</option>`;
    }).join('');
    html = `<label class="muted" style="font-size:13px">Return <select data-ret>${opts}</select></label>`
      + tog('gw', 'GoWild both ways') + tog('nonstop', 'Nonstop only') + tog('noOvernight', 'No overnight layovers')
      + `<input type="search" data-q placeholder="Destination code or city" value="${esc(f.q)}">`;
  } else if (S.mode === 'trips') {
    html = tog('gw', 'GoWild both ways') + tog('nonstop', 'Nonstop only')
      + sel('ground', 'At least', [[2, '2h there'], [4, '4h there'], [6, '6h there'], [8, '8h there'], [10, '10h there']])
      + `<input type="search" data-q placeholder="Destination code or city" value="${esc(f.q)}">`;
  } else if (S.mode === 'hidden') {
    html = sel('hiddenDir', 'Direction', [['from', `From ${S.origin}`], ['to', `Into ${S.origin}`]])
      + sel('minLay', 'Min layover', [[60, '1h'], [90, '1h 30m'], [120, '2h'], [180, '3h']])
      + sel('maxLay', 'Max layover', [[240, '4h'], [360, '6h'], [600, '10h'], [900, '15h']])
      + tog('hideDeparted', 'Hide departed')
      + `<input type="search" data-q placeholder="${f.hiddenDir === 'from' ? 'Destination' : 'Origin'} code or city" value="${esc(f.q)}">`;
  }
  box.innerHTML = html;
  box.onclick = (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { S.view = v.dataset.view; store.set('gw.view', S.view); render(); return; }
    const b = e.target.closest('[data-tog]');
    if (!b) return;
    f[b.dataset.tog] = !f[b.dataset.tog];
    render();
  };
  box.onchange = (e) => {
    if (e.target.matches('[data-ret]')) { S.ret = e.target.value; render(); return; }
    const s = e.target.closest('[data-sel]');
    if (!s) return;
    const v = s.value;
    f[s.dataset.sel] = /^\d+$/.test(v) ? Number(v) : v;
    render();
  };
  const q = box.querySelector('[data-q]');
  if (q) {
    q.oninput = () => { f.q = q.value; clearTimeout(renderFilters.t); renderFilters.t = setTimeout(() => renderResults(), 150); };
  }
}

// ---------------------------------------------------------------- notices
function renderNotices(day) {
  const n = [];
  const idx = S.index;
  const run = idx?.lastRun;
  if (run && run.pages && run.blocked >= run.ok) {
    n.push(`<div class="notice bad"><b>The last scan was blocked by Frontier's bot protection</b> (${run.blocked} of ${run.pages} pages). The data below may be stale. See the README for running the scanner from your own computer.</div>`);
  }
  if (S.mode !== 'track') {
    if ((S.mode === 'from' || S.mode === 'to' || S.mode === 'trips') && idx && !isHome(S.origin)) {
      n.push(`<div class="notice warn"><b>${esc(S.origin)} isn't a fully scanned airport.</b> You'll only see flights that other scans happened to pick up. To scan it on every run, add it to <span class="mono">homeAirports</span> in <span class="mono">config.json</span>.</div>`);
    }
    const dateAhead = Math.round((Date.parse(S.date) - Date.parse(today())) / 864e5);
    if (isBlackout(S.date)) {
      n.push(`<div class="notice warn"><b>${fmtDate(S.date)} is a GoWild blackout date.</b> Frontier doesn't sell pass fares on this date. You can still see the schedule and regular fares${S.f.gw ? ' <button class="toggle" data-show-schedule>Show schedule</button>' : ''}.</div>`);
    } else if (day && dateAhead > 1 && !countFor(S.date)) {
      const hz = S.index.gowildHorizon;
      n.push(`<div class="notice"><b>No GoWild seats out of ${esc(S.origin)} on this date yet.</b> Domestic GoWild seats usually open the day before departure, and international ones 10 days before. ${hz ? `The furthest-out GoWild seats the scanner has seen are ${hz.days} day${hz.days === 1 ? '' : 's'} ahead. ` : ''}For planning, you can still see which flights operate and their regular fares${S.f.gw ? ' <button class="toggle" data-show-schedule>Show schedule</button>' : ''}. Pin flights to Trackr, and set an alert to hear when seats open.</div>`);
    }
    if (S.mode === 'round' && isBlackout(S.ret)) {
      n.push(`<div class="notice warn"><b>Your return date, ${fmtDate(S.ret)}, is a GoWild blackout date.</b></div>`);
    }
    if (!day) {
      n.push(`<div class="notice">${fmtDate(S.date)} hasn't been scanned yet. Near-term dates refresh every hour and later dates about twice a day (see <span class="mono">config.json</span>).</div>`);
    } else if (S.mode === 'hidden') {
      n.push(`<div class="notice"><b>Hidden connections</b> are two separate GoWild tickets through a connecting airport that Frontier won't sell as one trip. Second legs come from these connecting airports: <span class="mono">${esc([...(idx.homeAirports ?? []), ...(idx.hubs ?? [])].join(' · '))}</span>. If your first flight is late, Frontier won't rebook you onto the second one, so leave a buffer and fly with a personal item only.</div>`);
    }
  }
  $('#notices').innerHTML = n.join('');
}

// ---------------------------------------------------------------- rows
function matchQ(code) {
  const q = S.f.q.trim().toLowerCase();
  if (!q) return true;
  const a = AP[code];
  return code.toLowerCase().includes(q) || (a && `${a.city} ${a.region}`.toLowerCase().includes(q));
}
function inWindow(dep) {
  const h = Number(dep.slice(11, 13));
  switch (S.f.window) {
    case 'morning': return h < 12;
    case 'afternoon': return h >= 12 && h < 17;
    case 'evening': return h >= 17;
    default: return true;
  }
}
const seatsRank = (it) => (it.gw == null ? -1 : it.gws ?? 99);

function flightRow(it, date, { compact = false } = {}) {
  const lvl = seatLevel(it);
  const via = it.st === 0 ? 'Nonstop' : `${it.st} stop${it.st > 1 ? 's' : ''} · via ${it.legs.slice(0, -1).map((l) => l[2]).join(', ')}`;
  const night = layovers(it).find((l) => l.overnight);
  const nightTag = night ? `<span class="tag-night" title="You'd spend the night at ${esc(night.at)}">☾ Overnight in ${esc(night.at)} · ${fmtDuration(night.min)}</span>` : '';
  const nums = it.legs.map((l) => l[0].replace(/^F9/, 'F9 ')).join(' + ');
  const nextDay = it.arr.slice(0, 10) !== it.dep.slice(0, 10) ? '<sup>+1</sup>' : '';
  const pinned = pinnedKey(it.k, date);
  const departed = isDeparted(it);
  const den = it.den != null ? `Den ${money(it.den)}${it.dens != null ? ` · ${it.dens} left` : ''}` : (it.std != null ? `Std ${money(it.std)}` : '');
  return `<div class="flight${departed ? ' departed' : ''}" data-k="${esc(it.k)}" data-date="${date}">
    <div class="times"><b>${fmtClock(it.dep)} → ${fmtClock(it.arr)}${nextDay}</b>
      <div class="sub">${compact ? '' : `<span class="mono">${esc(it.o)}→${esc(it.d)}</span> · `}${fmtDuration(it.dur)} · ${esc(via)}</div>${nightTag}
      <div class="sub mono">${esc(nums)}${departed ? ' · departed' : ''}</div></div>
    <div class="seatcol"><span class="badge ${lvl.level}"><span class="dot ${lvl.level}"></span>${lvl.label}</span>
      ${den ? `<span class="sub">${den}</span>` : ''}${sparkline(it.h)}</div>
    <div class="fare"><b>${it.gw != null ? money(it.gw) : '—'}</b><div class="sub">GoWild · ${fmtAgo(it.t)}</div></div>
    <div class="actions"><button type="button" data-pin class="${pinned ? 'pinned' : ''}" aria-label="${pinned ? 'Unpin' : 'Pin to Trackr'}">${pinned ? '★' : '☆'}</button>
      <a href="${frontierUrl(it.o, it.d, date)}" target="_blank" rel="noopener" data-book>Book ↗</a></div>
  </div>`;
}

function emptyState(title, body) {
  return `<div class="empty"><h2>${title}</h2><p>${body}</p></div>`;
}

// ---------------------------------------------------------------- views
function viewEverywhere(day) {
  const f = S.f;
  const dir = S.mode;
  const other = (it) => (dir === 'from' ? it.d : it.o);
  let list = day.itins.filter((it) => (dir === 'from' ? it.o === S.origin : it.d === S.origin)
    && (!f.gw || it.gw != null) && (!f.nonstop || it.st === 0)
    && (!f.minSeats || (it.gw != null && (it.gws == null || it.gws >= f.minSeats)))
    && (!f.noOvernight || !isOvernight(it))
    && (!f.hideDeparted || !isDeparted(it)) && inWindow(it.dep) && matchQ(other(it)));
  if (!list.length) {
    return emptyState('No matching flights', f.gw ? 'No GoWild seats match these filters on this date. Try another date or loosen the filters.' : 'Nothing matches these filters.');
  }
  const sorter = {
    dep: (a, b) => (a.dep < b.dep ? -1 : 1),
    price: (a, b) => (a.gw ?? 1e9) - (b.gw ?? 1e9) || (a.dep < b.dep ? -1 : 1),
    seats: (a, b) => seatsRank(b) - seatsRank(a),
    dur: (a, b) => (a.dur ?? 1e9) - (b.dur ?? 1e9),
    code: (a, b) => (a.dep < b.dep ? -1 : 1),
  }[f.sort] ?? ((a, b) => (a.dep < b.dep ? -1 : 1));
  const groups = new Map();
  for (const it of list) {
    const k = other(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const arr = [...groups.entries()].map(([code, its]) => ({ code, its: its.sort(sorter) }));
  const gsort = {
    dep: (a, b) => (a.its[0].dep < b.its[0].dep ? -1 : 1),
    price: (a, b) => Math.min(...a.its.map((i) => i.gw ?? 1e9)) - Math.min(...b.its.map((i) => i.gw ?? 1e9)),
    seats: (a, b) => Math.max(...b.its.map(seatsRank)) - Math.max(...a.its.map(seatsRank)),
    dur: (a, b) => Math.min(...a.its.map((i) => i.dur ?? 1e9)) - Math.min(...b.its.map((i) => i.dur ?? 1e9)),
    code: (a, b) => a.code.localeCompare(b.code),
  }[f.sort];
  arr.sort(gsort);
  const gwCount = list.filter((i) => i.gw != null).length;
  const head = `<div class="summary">${arr.length} ${dir === 'from' ? 'destinations' : 'origins'} · ${list.length} flights${f.gw ? '' : ` (${gwCount} with GoWild)`} · ${fmtDate(S.date)} · checked ${fmtAgo(S.index.dates[S.date]?.scannedAt)}</div>`;
  if (S.view === 'map') {
    S.mapGroups = arr;
    return `${head}<div id="map" class="map" role="region" aria-label="Route map"></div><p class="muted" style="font-size:12px">Dot size = number of flights. Tap a dot for details, or switch to List to see every flight.</p>`;
  }
  return head + arr.map(({ code, its }) => {
    const a = AP[code];
    const gwIts = its.filter((i) => i.gw != null);
    const best = gwIts.length ? Math.min(...gwIts.map((i) => i.gw)) : null;
    const seats = gwIts.some((i) => i.gws == null) ? 'Available' : gwIts.length ? `up to ${Math.max(...gwIts.map((i) => i.gws))} seats` : '';
    const nonstops = its.filter((i) => i.st === 0).length;
    const open = S.expanded.has(code);
    const shown = open ? its : its.slice(0, 3);
    const route = dir === 'from' ? `${S.origin}-${code}` : `${code}-${S.origin}`;
    return `<section class="group" data-group="${code}">
      <div class="group-head"><span class="code">${esc(code)}</span><span class="city">${esc(a ? `${a.city}, ${a.region}` : '')}${a?.intl ? ' · International' : ''}</span><span data-wx="${code}"></span>
        <span class="stats"><span>${its.length} flight${its.length > 1 ? 's' : ''}${nonstops ? ` · ${nonstops} nonstop` : ''}${best != null ? ` · from <b>${money(best)}</b>` : ''}${seats ? ` · ${seats}` : ''}</span>
        <button class="icon-btn" type="button" data-history="${route}" title="Fare history for ${route}" style="min-height:28px;padding:2px 8px;font-size:12px">History</button></span></div>
      <div class="group-body">${shown.map((it) => flightRow(it, S.date)).join('')}</div>
      ${its.length > 3 ? `<button class="more-btn" data-more="${code}">${open ? 'Show fewer' : `Show all ${its.length} flights`}</button>` : ''}
    </section>`;
  }).join('');
}

function viewRound(day, back) {
  const f = S.f;
  const ok = (it) => (!f.gw || it.gw != null) && (!f.nonstop || it.st === 0) && passOk(it) && !it.gone;
  const outs = day.itins.filter((it) => it.o === S.origin && ok(it) && !isDeparted(it) && matchQ(it.d));
  const backs = (back?.itins ?? []).filter((it) => it.d === S.origin && ok(it));
  const byDest = new Map();
  for (const it of outs) {
    if (!byDest.has(it.d)) byDest.set(it.d, { out: [], back: [] });
    byDest.get(it.d).out.push(it);
  }
  for (const it of backs) byDest.get(it.o)?.back.push(it);
  const both = [...byDest.entries()].filter(([, v]) => v.back.length);
  const oneWay = [...byDest.entries()].filter(([, v]) => !v.back.length);
  const nights = Math.round((Date.parse(S.ret) - Date.parse(S.date)) / 864e5);
  const head = `<div class="summary">${fmtDate(S.date)} → ${fmtDate(S.ret)} (${nights} night${nights > 1 ? 's' : ''}) · ${both.length} round trip${both.length === 1 ? '' : 's'}${f.gw ? ' with GoWild both ways' : ''} · ${oneWay.length} one-way only</div>`;
  if (!outs.length) return head + emptyState('No outbound flights', f.gw ? `No GoWild seats out of ${esc(S.origin)} on ${fmtDate(S.date)} match these filters.` : 'Nothing matches these filters.');
  const minFare = (list) => (list.some((i) => i.gw != null) ? Math.min(...list.filter((i) => i.gw != null).map((i) => i.gw)) : null);
  both.sort((a, b) => (minFare(a[1].out) ?? 1e9) + (minFare(a[1].back) ?? 1e9) - (minFare(b[1].out) ?? 1e9) - (minFare(b[1].back) ?? 1e9));
  const byDep = (a, b) => (a.dep < b.dep ? -1 : 1);
  let html = head + both.map(([code, v]) => {
    const a = AP[code];
    const open = S.expanded.has(`r:${code}`);
    const o = v.out.sort(byDep);
    const r = v.back.sort(byDep);
    const fo = minFare(o);
    const fr = minFare(r);
    return `<section class="group trip"><div class="group-head"><span class="code">${esc(S.origin)} ⇄ ${esc(code)}</span><span class="city">${esc(a ? `${a.city}, ${a.region}` : '')}</span><span data-wx="${code}"></span>
      <span class="stats"><span>${o.length} out · ${r.length} back${fo != null && fr != null ? ` · from <b>${money(fo + fr)}</b> round trip` : ''}</span></span></div>
      <div class="group-body"><div class="leg-label">Out · ${fmtDate(S.date)}</div>${(open ? o : o.slice(0, 2)).map((it) => flightRow(it, S.date)).join('')}
      <div class="leg-label">Back · ${fmtDate(S.ret)}</div>${(open ? r : r.slice(0, 2)).map((it) => flightRow(it, S.ret)).join('')}</div>
      ${o.length > 2 || r.length > 2 ? `<button class="more-btn" data-more="r:${code}">${open ? 'Show fewer' : `Show all ${o.length + r.length} flights`}</button>` : ''}</section>`;
  }).join('');
  if (oneWay.length) {
    html += `<section class="group"><div class="group-head"><span class="city"><b>One-way only</b> · ${back ? `no matching return to ${esc(S.origin)} on ${fmtDate(S.ret)}` : `${fmtDate(S.ret)} hasn't been scanned yet`}</span></div>
      <div class="group-body" style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px">${oneWay.sort((x, y) => x[0].localeCompare(y[0])).map(([code, v]) => `<button class="toggle" data-oneway="${code}" title="${esc(AP[code]?.city ?? code)}">${esc(code)} <span class="muted">${v.out.length}</span></button>`).join('')}</div></section>`;
  }
  return html;
}

function viewTrips(day) {
  const now = S.date === today() ? localNow(tzOf(S.origin)) : null;
  let trips = findDayTrips(day.itins, S.origin, { goWildOnly: S.f.gw, minGroundMin: S.f.ground * 60, nonstopOnly: S.f.nonstop, now });
  trips = trips.filter((t) => matchQ(t.dest));
  if (!trips.length) {
    return emptyState('No same-day round trips', `Nothing gets you out of ${esc(S.origin)} and back on ${fmtDate(S.date)} with ${S.f.ground}+ hours there${S.f.gw ? ' and GoWild seats both ways' : ''}. Return flights only show up for fully scanned airports.`);
  }
  return `<div class="summary">${trips.length} day trips from ${esc(S.origin)} · ${fmtDate(S.date)} · out and back the same day, no hotel</div>`
    + trips.map((t) => {
      const a = AP[t.dest];
      const total = (t.out.gw ?? 0) + (t.back.gw ?? 0);
      return `<section class="group trip"><div class="group-head"><span class="code">${esc(t.dest)}</span><span class="city">${esc(a ? `${a.city}, ${a.region}` : '')}</span><span data-wx="${t.dest}"></span>
        <span class="stats"><span><b>${fmtDuration(t.groundMin)}</b> there${t.options > 1 ? ` · ${t.options} combos` : ''}${S.f.gw ? ` · ${money(total)} total` : ''}</span></span></div>
        <div class="group-body"><div class="leg-label">Outbound</div>${flightRow(t.out, S.date, { compact: true })}
        <div class="between">${fmtDuration(t.groundMin)} in ${esc(a?.city ?? t.dest)} (land ${fmtClock(t.out.arr)}, leave ${fmtClock(t.back.dep)})</div>
        <div class="leg-label">Return</div>${flightRow(t.back, S.date, { compact: true })}</div></section>`;
    }).join('');
}

function viewHidden(day) {
  const f = S.f;
  const dir = f.hiddenDir;
  let res = findHiddenConnections(day.itins, {
    origin: dir === 'from' ? S.origin : null,
    destination: dir === 'to' ? S.origin : null,
    minLayoverMin: f.minLay, maxLayoverMin: f.maxLay,
  });
  res = res.filter((r) => (!f.hideDeparted || !isDeparted(r.first)) && matchQ(dir === 'from' ? r.d : r.o));
  if (!res.length) {
    return emptyState('No hidden connections found', 'No two-ticket GoWild combos fit these layover limits on this date. Try a wider layover window or another date.');
  }
  const groups = new Map();
  for (const r of res) {
    const k = dir === 'from' ? r.d : r.o;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const directs = new Set(day.itins.filter((it) => it.gw != null && (dir === 'from' ? it.o === S.origin : it.d === S.origin)).map((it) => (dir === 'from' ? it.d : it.o)));
  const arr = [...groups.entries()].sort((a, b) => (directs.has(a[0]) - directs.has(b[0])) || a[0].localeCompare(b[0]));
  return `<div class="summary">${res.length} combos to ${arr.length} airports · ${fmtDate(S.date)} · airports with no GoWild seats on a single ticket are listed first</div>`
    + arr.map(([code, list]) => {
      const a = AP[code];
      const open = S.expanded.has(`h:${code}`);
      const shown = open ? list : list.slice(0, 2);
      return `<section class="group"><div class="group-head"><span class="code">${esc(code)}</span><span class="city">${esc(a ? `${a.city}, ${a.region}` : '')}</span><span data-wx="${code}"></span>
        <span class="stats"><span>${directs.has(code) ? 'also on a single GoWild ticket' : '<b>only possible this way</b>'} · via ${[...new Set(list.map((r) => r.via))].join(', ')}</span></span></div>
        <div class="group-body">${shown.map((r) => `<div class="trip"><div class="leg-label">Ticket 1 · ${esc(r.o)}→${esc(r.via)}</div>${flightRow(r.first, S.date)}
          <div class="between">Layover <b>${fmtDuration(r.layoverMin)}</b> in ${esc(AP[r.via]?.city ?? r.via)} · ${money(r.total)} total${r.minSeats != null ? ` · ${r.minSeats} seat${r.minSeats === 1 ? "" : "s"} on the tighter leg` : ''} · book separately</div>
          <div class="leg-label">Ticket 2 · ${esc(r.via)}→${esc(r.d)}</div>${flightRow(r.second, S.date)}</div>`).join('<hr style="border:0;border-top:2px solid var(--border);margin:0">')}</div>
        ${list.length > 2 ? `<button class="more-btn" data-more="h:${code}">${open ? 'Show fewer' : `Show all ${list.length} combos`}</button>` : ''}</section>`;
    }).join('');
}

async function viewTrack() {
  if (!S.track.length) {
    return emptyState('Trackr is empty', 'Press and hold any flight, or tap ☆, to pin it here. Pinned flights show their latest GoWild seats every time you open the app.');
  }
  const byDate = new Map();
  for (const t of S.track) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }
  const dates = [...byDate.keys()].sort();
  const parts = [`<div class="filters"><button class="toggle" id="track-share">Share Trackr link</button><button class="toggle" id="track-clean">Remove past flights</button></div>`];
  for (const date of dates) {
    const day = await loadDay(date);
    const rows = byDate.get(date).map((t) => {
      const it = day?.itins.find((i) => i.k === t.k);
      if (it) return flightRow(it, date);
      return `<div class="flight" data-k="${esc(t.k)}" data-date="${date}"><div class="times"><b>${esc(t.o)} → ${esc(t.d)}</b><div class="sub">${esc(t.k.split('-').slice(5).join('-'))}</div></div>
        <div class="seatcol"><span class="badge none"><span class="dot none"></span>${day ? 'Not in latest scan' : 'Not scanned yet'}</span></div><div class="fare"></div>
        <div class="actions"><button type="button" data-pin class="pinned" aria-label="Unpin">★</button><a href="${frontierUrl(t.o, t.d, date)}" target="_blank" rel="noopener" data-book>Book ↗</a></div></div>`;
    });
    parts.push(`<section class="group"><div class="group-head"><span class="code" style="font-family:var(--font);font-size:16px">${fmtDate(date)}</span>${date < localToday('America/Denver') ? '<span class="muted">past</span>' : ''}</div><div class="group-body">${rows.join('')}</div></section>`);
  }
  return parts.join('');
}

// ---------------------------------------------------------------- render
let renderSeq = 0;
async function renderResults() {
  const seq = ++renderSeq;
  const box = $('#results');
  if (!S.index) {
    box.innerHTML = emptyState('No flight data yet', 'The scanner hasn\'t published anything yet. On GitHub, open Actions → "Scan Frontier & deploy" → Run workflow, then check back in about 20 minutes.');
    $('#notices').innerHTML = '';
    return;
  }
  if (S.mode === 'track') {
    renderNotices(true);
    const html = await viewTrack();
    if (seq === renderSeq) box.innerHTML = html;
    bindTrackButtons();
    return;
  }
  box.innerHTML = '<div class="empty muted">Loading…</div>';
  const day = await loadDay(S.date);
  if (seq !== renderSeq) return;
  renderNotices(day);
  if (!day) { box.innerHTML = ''; return; }
  S.mapGroups = null;
  if (S.mode === 'round') {
    const back = await loadDay(S.ret);
    if (seq !== renderSeq) return;
    box.innerHTML = viewRound(day, back);
  } else {
    box.innerHTML = S.mode === 'trips' ? viewTrips(day) : S.mode === 'hidden' ? viewHidden(day) : viewEverywhere(day);
  }
  afterRender(seq);
}

async function fillWeather(seq) {
  const slots = [...document.querySelectorAll('[data-wx]')];
  const codes = [...new Set(slots.map((n) => n.dataset.wx))].filter((c) => AP[c]);
  if (!codes.length) return;
  const wx = await forecasts(codes.map((c) => AP[c]));
  if (seq !== renderSeq) return;
  for (const n of slots) n.innerHTML = wxChip(wx.get(n.dataset.wx)?.days?.[S.date]);
}

async function afterRender(seq) {
  const el = $('#map');
  if (el && S.mapGroups) {
    const dir = S.mode;
    const points = S.mapGroups.filter((g) => AP[g.code]).map(({ code, its }) => {
      const gw = its.filter((i) => i.gw != null);
      const best = gw.length ? Math.min(...gw.map((i) => i.gw)) : null;
      const a = AP[code];
      return {
        airport: a,
        count: its.length,
        popupHtml: `<div class="map-pop"><b>${esc(code)}</b> ${esc(a.city)}, ${esc(a.region)}<br>${its.length} flight${its.length > 1 ? 's' : ''} ${dir === 'from' ? 'there' : 'to ' + esc(S.origin)} · ${its.filter((i) => i.st === 0).length} nonstop${best != null ? `<br>GoWild from <b>${money(best)}</b>` : ''}<br>First: ${fmtClock(its[0].dep)} · ${seatLevel(its[0]).label}<br><button type="button" data-pick>See flights</button></div>`,
      };
    });
    try {
      await drawRouteMap(el, AP[S.origin], points, (code) => { S.view = 'list'; store.set('gw.view', 'list'); S.f.q = code; render(); });
    } catch (e) {
      el.innerHTML = `<div class="empty">Couldn't load the map (${esc(e.message)}). Switch to List.</div>`;
    }
  } else {
    destroyMap();
  }
  fillWeather(seq).catch(() => {});
}

function render() {
  if (!S.origin || !AP[S.origin]) S.origin = S.index?.homeAirports?.[0] ?? 'DEN';
  if (!S.date) S.date = today();
  if (!['from', 'to', 'round', 'trips', 'hidden', 'track'].includes(S.mode)) S.mode = 'from';
  if (!S.ret || S.ret <= S.date) S.ret = addDays(S.date, 3);
  writeHash();
  $('#origin').value = S.origin;
  renderStatus();
  renderTabs();
  renderDates();
  renderFilters();
  renderResults();
}

// ---------------------------------------------------------------- Trackr
function saveTrack() { store.set('gw.track', S.track); $('#track-count').textContent = S.track.length ? String(S.track.length) : ''; }
async function togglePin(k, date) {
  const i = S.track.findIndex((t) => t.k === k && t.date === date);
  if (i >= 0) { S.track.splice(i, 1); toast('Removed from Trackr'); }
  else {
    const [o, d] = k.split('-');
    S.track.push({ k, date, o, d });
    toast('Pinned to Trackr');
  }
  saveTrack();
  renderResults();
}
function bindTrackButtons() {
  $('#track-share')?.addEventListener('click', async () => {
    const code = btoa(JSON.stringify(S.track.map((t) => [t.k, t.date])));
    const url = `${location.origin}${location.pathname}#m=track&track=${encodeURIComponent(code)}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link', url); }
  });
  $('#track-clean')?.addEventListener('click', () => {
    const cut = localToday('America/Denver');
    S.track = S.track.filter((t) => t.date >= cut);
    saveTrack();
    renderResults();
  });
}
function importTrackFromHash(p) {
  const code = p.get('track');
  if (!code) return;
  try {
    const list = JSON.parse(atob(decodeURIComponent(code)));
    let added = 0;
    for (const [k, date] of list) {
      if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || pinnedKey(k, date)) continue;
      const [o, d] = k.split('-');
      S.track.push({ k, date, o, d });
      added++;
    }
    saveTrack();
    if (added) setTimeout(() => toast(`Added ${added} shared flight${added > 1 ? 's' : ''} to Trackr`), 300);
  } catch { /* ignore malformed */ }
}

// ---------------------------------------------------------------- interactions
function findItin(k, date) {
  return loadDay(date).then((day) => day?.itins.find((i) => i.k === k) ?? null);
}

let pressTimer = null;
let suppressClick = false;
const results = $('#results');
results.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.flight');
  if (!row || e.target.closest('a,button')) return;
  suppressClick = false;
  pressTimer = setTimeout(() => {
    suppressClick = true;
    navigator.vibrate?.(15);
    togglePin(row.dataset.k, row.dataset.date);
  }, 550);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) {
  results.addEventListener(ev, (e) => {
    if (ev === 'pointermove' && Math.abs(e.movementX) + Math.abs(e.movementY) < 4) return;
    clearTimeout(pressTimer);
  });
}
results.addEventListener('contextmenu', (e) => { if (e.target.closest('.flight')) e.preventDefault(); });
results.addEventListener('click', (e) => {
  const pin = e.target.closest('[data-pin]');
  if (pin) { const row = pin.closest('.flight'); togglePin(row.dataset.k, row.dataset.date); return; }
  const more = e.target.closest('[data-more]');
  if (more) { const k = more.dataset.more; S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k); renderResults(); return; }
  const ow = e.target.closest('[data-oneway]');
  if (ow) { S.mode = 'from'; S.f.q = ow.dataset.oneway; render(); return; }
  const hist = e.target.closest('[data-history]');
  if (hist) { e.stopPropagation(); openRouteHistory(hist.dataset.history); return; }
  if (e.target.closest('a')) return;
  const head = e.target.closest('.group-head');
  if (head && head.parentElement.dataset.group) { const k = head.parentElement.dataset.group; S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k); renderResults(); return; }
  const row = e.target.closest('.flight');
  if (row && !suppressClick) openFlight(row.dataset.k, row.dataset.date);
  suppressClick = false;
});

$('#notices').addEventListener('click', (e) => {
  if (e.target.closest('[data-show-schedule]')) { S.f.gw = false; render(); }
});

// ---------------------------------------------------------------- modals
const modal = $('#modal');
$('#modal-close').onclick = () => modal.close();
modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });
function openModal(title, nodeOrHtml) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = '';
  if (typeof nodeOrHtml === 'string') body.innerHTML = nodeOrHtml; else body.append(nodeOrHtml);
  if (!modal.open) modal.showModal();
}
const fmtTs = (ms) => { const d = new Date(ms); return `${MON[d.getMonth()]} ${d.getDate()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; };

async function openFlight(k, date) {
  const it = await findItin(k, date);
  if (!it) return;
  const frag = document.createElement('div');
  const lvl = seatLevel(it);
  frag.innerHTML = `<div class="kv">
      <div><div class="k">GoWild</div><div class="v">${it.gw != null ? money(it.gw) : '—'}</div></div>
      <div><div class="k">GoWild seats</div><div class="v"><span class="badge ${lvl.level}"><span class="dot ${lvl.level}"></span>${lvl.label}</span></div></div>
      <div><div class="k">Discount Den</div><div class="v">${money(it.den)}${it.dens != null ? ` <span class="muted" style="font-size:12px">${it.dens} left</span>` : ''}</div></div>
      <div><div class="k">Standard</div><div class="v">${money(it.std)}${it.stds != null ? ` <span class="muted" style="font-size:12px">${it.stds} left</span>` : ''}</div></div>
      <div><div class="k">Duration</div><div class="v">${fmtDuration(it.dur)}</div></div>
      <div><div class="k">Last checked</div><div class="v" style="font-size:14px">${fmtAgo(it.t)}</div></div>
    </div>
    <h4>Flights</h4>
    <table><thead><tr><th>Flight</th><th>From</th><th>To</th><th>Departs</th><th>Arrives</th></tr></thead><tbody>
      ${it.legs.map((l, i) => {
        const lay = i > 0 ? localMinutesBetween(it.legs[i - 1][4], l[3]) : null;
        return `${lay != null ? `<tr><td colspan="5" class="muted">Connection ${fmtDuration(lay)} in ${esc(l[1])}</td></tr>` : ''}<tr><td class="mono">${esc(l[0])}</td><td>${esc(l[1])}</td><td>${esc(l[2])}</td><td>${fmtClock(l[3])}</td><td>${fmtClock(l[4])}</td></tr>`;
      }).join('')}
    </tbody></table>
    <p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><a class="toggle" href="${frontierUrl(it.o, it.d, date)}" target="_blank" rel="noopener">Book on Frontier ↗</a>
      <button class="toggle" type="button" id="m-pin">${pinnedKey(k, date) ? '★ Pinned' : '☆ Pin to Trackr'}</button>
      <button class="toggle" type="button" id="m-hist">Route fare history</button>
      <button class="toggle" type="button" id="m-alert">Get alerts</button></p>
    <h4>Weather in ${esc(AP[it.d]?.city ?? it.d)}</h4><div id="m-wx" class="wx-strip muted">Loading forecast…</div>
    <h4>GoWild seats left over time</h4><div id="m-seats"></div>
    <h4>GoWild fare over time</h4><div id="m-fare"></div>
    <p class="muted" style="font-size:12px">First seen ${it.fs ? fmtTs(it.fs * 1000) : '—'} · ${it.h?.length ?? 0} recorded changes. A gap means Frontier showed GoWild seats without a count; 0 means sold out.</p>`;
  const h = it.h ?? [];
  const pts = [...h.map((p) => ({ x: p[0] * 1000, seats: p[1] == null ? 0 : p[2], fare: p[1] }))];
  if (pts.length && (it.t ?? 0) * 1000 > pts.at(-1).x + 60000) pts.push({ x: (it.t ?? h.at(-1)[0]) * 1000, seats: pts.at(-1).seats, fare: pts.at(-1).fare });
  $('#m-seats', frag).append(lineChart(pts.map((p) => ({ x: p.x, y: p.seats })), { title: 'GoWild seats left over time', xFmt: fmtTs, yFmt: (v) => String(Math.round(v)), step: true, integer: true }));
  $('#m-fare', frag).append(lineChart(pts.map((p) => ({ x: p.x, y: p.fare })), { title: 'GoWild fare over time', xFmt: fmtTs, yFmt: (v) => `$${v.toFixed(0)}`, step: true }));
  openModal(`${it.o} → ${it.d} · ${fmtDate(date)}`, frag);
  $('#m-pin').onclick = () => { togglePin(k, date); $('#m-pin').textContent = pinnedKey(k, date) ? '★ Pinned' : '☆ Pin to Trackr'; };
  $('#m-hist').onclick = () => openRouteHistory(`${it.o}-${it.d}`);
  $('#m-alert').onclick = () => openAlertHelp(it, date);
  forecasts([AP[it.d]].filter(Boolean)).then((wx) => {
    const box = $('#m-wx');
    if (!box) return;
    const days = Object.entries(wx.get(it.d)?.days ?? {}).filter(([d]) => d >= date).slice(0, 10);
    box.classList.remove('muted');
    box.innerHTML = days.length ? days.map(([d, w]) => {
      const { icon, label } = wxDescribe(w.code);
      return `<div class="wx-day${isRough(w) ? ' rough' : ''}${d === date ? ' sel' : ''}" title="${label}${w.pop != null ? ` · ${w.pop}% precip` : ''}"><div class="muted">${d === date ? 'Trip' : fmtDate(d).slice(0, 3)}</div><div class="wx-icon">${icon}</div><div>${Math.round(w.hi)}°</div><div class="muted">${Math.round(w.lo)}°</div>${w.pop != null ? `<div class="muted">${w.pop}%</div>` : ''}</div>`;
    }).join('') : '<span class="muted">Forecast unavailable for this date.</span>';
  });
}

async function openRouteHistory(route) {
  const hist = await loadHistory();
  const dates = Object.keys(hist).sort();
  const pts = dates.map((d) => ({ x: dateObj(d).getTime(), y: hist[d]?.[route]?.[0] ?? null, label: fmtDate(d) }));
  const node = document.createElement('div');
  const vals = pts.filter((p) => p.y != null).map((p) => p.y);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  node.innerHTML = `<div class="kv"><div><div class="k">Days with GoWild</div><div class="v">${vals.length} / ${dates.length}</div></div>
    <div><div class="k">Cheapest</div><div class="v">${vals.length ? money(Math.min(...vals)) : '—'}</div></div>
    <div><div class="k">Average</div><div class="v">${avg != null ? money(avg) : '—'}</div></div>
    <div><div class="k">Highest</div><div class="v">${vals.length ? money(Math.max(...vals)) : '—'}</div></div></div>
    <h4>Lowest GoWild fare by departure date</h4><div id="rh"></div>
    <p class="muted" style="font-size:12px">Each point is the lowest GoWild fare seen for a flight departing that day. Gaps are days with no GoWild seats, or days that weren't scanned.</p>`;
  $('#rh', node).append(lineChart(pts, { title: `Lowest GoWild fare by date, ${route}`, xFmt: (x) => { const d = new Date(x); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; }, yFmt: (v) => `$${v.toFixed(0)}` }));
  openModal(`Fare history · ${route.replace('-', ' → ')}`, node);
}

function openAlertHelp(it, date) {
  const rule = { name: `${it.o} to ${it.d} ${date.slice(5)}`, from: it.o, to: it.d, dates: [date], ...(it.st === 0 ? { nonstopOnly: true } : {}), notify: ['opened', 'low', 'soldout'] };
  const json = JSON.stringify(rule);
  openModal('Phone alerts for this route', `<p>The scanner can send a push notification to your phone when GoWild seats <b>open</b>, drop to <b>2 or fewer</b>, or <b>sell out</b> on this route.</p>
    <ol>
      <li>Install the free <b>ntfy</b> app (iOS / Android) and subscribe to a hard-to-guess topic name, e.g. <span class="mono">gowild-${Math.random().toString(36).slice(2, 10)}</span>.</li>
      <li>In GitHub, open the repo → Settings → Secrets and variables → Actions → New repository secret: name <span class="mono">NTFY_TOPIC</span>, value = your topic. (One-time.)</li>
      <li>Add this rule to the <span class="mono">"alerts"</span> list in <span class="mono">config.json</span>:</li>
    </ol>
    <pre class="code" id="alert-json">${esc(json)}</pre>
    <p><button class="toggle" type="button" id="copy-alert">Copy rule</button></p>
    <p class="muted" style="font-size:12px">Friends can subscribe to the same topic to get the same alerts. Remove "dates" to watch every scanned date; use "to": "*" for anywhere.</p>`);
  $('#copy-alert').onclick = async () => { try { await navigator.clipboard.writeText(json); toast('Rule copied'); } catch { prompt('Copy this rule', json); } };
}

function openCalendar() {
  const start = today().slice(0, 7);
  const [y0, m0] = start.split('-').map(Number);
  const counts = Object.keys(S.index?.dates ?? {}).map((d) => countFor(d) ?? 0);
  const max = Math.max(1, ...counts);
  let html = `<div class="cal-legend">Fewer <i style="background:color-mix(in srgb, var(--accent) 15%, var(--surface-2))"></i><i style="background:color-mix(in srgb, var(--accent) 55%, var(--surface-2))"></i><i style="background:var(--accent)"></i> more GoWild flights ${S.mode === 'to' ? `into ${S.origin}` : `from ${S.origin}`} · faded = not scanned · ✕ = GoWild blackout</div><div class="months">`;
  for (let i = -1; i < 12; i++) {
    const dt = new Date(Date.UTC(y0, m0 - 1 + i, 1));
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const monthHasData = Object.keys(S.index?.dates ?? {}).some((d) => d.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`));
    if (i === -1 && !monthHasData) continue;
    html += `<div class="month"><h5>${MON[m]} ${y}</h5><div class="grid">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('')}`;
    html += '<span></span>'.repeat(dt.getUTCDay());
    for (let d = 1; d <= daysIn; d++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const c = countFor(ds);
      const pct = c ? 15 + Math.round((c / max) * 85) : 0;
      const style = c ? `background:color-mix(in srgb, var(--accent) ${pct}%, var(--surface-2));color:${pct > 55 ? 'var(--accent-ink)' : 'var(--text)'}` : '';
      const bo = isBlackout(ds);
      html += `<button class="cal-day${ds === S.date ? ' sel' : ''}${bo ? ' blackout' : ''}" data-cal="${ds}" ${c == null ? 'disabled' : ''} style="${style}" title="${fmtDate(ds)}${bo ? ' · GoWild blackout' : ''}${c == null ? ' · not scanned' : ` · ${c} GoWild flights`}">${d}${c ? `<small>${c}</small>` : bo ? '<small>✕</small>' : ''}</button>`;
    }
    html += '</div></div>';
  }
  html += '</div><p class="muted" style="font-size:12px">Domestic GoWild seats open the day before departure (international: 10 days). The scanner checks today through the next 10 days often, plus the planning range in config.json (schedules and regular fares) every few days, and keeps 60 days of history.</p>';
  openModal('Calendar', html);
  $('#modal-body').onclick = (e) => {
    const b = e.target.closest('[data-cal]');
    if (!b) return;
    S.date = b.dataset.cal;
    modal.close();
    $('#modal-body').onclick = null;
    render();
  };
}

function openStatus() {
  const idx = S.index;
  if (!idx) return openModal('Scanner', '<p>No scans have been published yet.</p>');
  const run = idx.lastRun ?? {};
  const html = `<div class="kv">
      <div><div class="k">Last update</div><div class="v" style="font-size:14px">${fmtAgo(idx.generatedAt)}</div></div>
      <div><div class="k">Pages last run</div><div class="v">${run.pages ?? 0}</div></div>
      <div><div class="k">Blocked</div><div class="v">${run.blocked ?? 0}</div></div>
      <div><div class="k">Errors</div><div class="v">${run.errors ?? 0}</div></div>
      <div><div class="k">GoWild seen up to</div><div class="v" style="font-size:14px">${idx.gowildHorizon ? `${idx.gowildHorizon.days} days ahead` : '—'}</div></div></div>
    <h4>Coverage</h4><p>Fully scanned (to and from every airport): <b class="mono">${esc((idx.homeAirports ?? []).join(', ') || 'none')}</b><br>
      Connecting airports scanned for hidden connections: <b class="mono">${esc((idx.hubs ?? []).join(', ') || 'none')}</b></p>
    <table><thead><tr><th>Tier</th><th>Days ahead</th><th>Every</th><th>Last run</th></tr></thead><tbody>
      ${(idx.tiers ?? []).map((t) => `<tr><td>${esc(t.name)}</td><td>${esc((t.daysAhead ?? []).join(', '))}</td><td>${Math.round(t.everyMinutes / 60 * 10) / 10}h</td><td>${fmtAgo(t.lastRun)}</td></tr>`).join('')}</tbody></table>
    <h4>Recent runs</h4><table><thead><tr><th>When</th><th>Pages</th><th>OK</th><th>Blocked</th><th>Errors</th></tr></thead><tbody>
      ${(idx.recentRuns ?? []).map((r) => `<tr><td>${fmtAgo(r.at)}</td><td>${r.pages}</td><td>${r.ok}</td><td>${r.blocked}</td><td>${r.errors}${r.aborted ? ' (stopped early)' : ''}</td></tr>`).join('')}</tbody></table>
    <h4>Phone alerts</h4>${(idx.alerts ?? []).length ? `<ul>${idx.alerts.map((a) => `<li>${esc(a.name ?? `${a.from} to ${a.to}`)} <span class="muted">(${esc((a.notify ?? ['opened', 'low']).join(', '))})</span></li>`).join('')}</ul>` : '<p class="muted">No alert rules yet.</p>'}
    <p class="muted" style="font-size:12px">Alerts arrive through the ntfy app once the <span class="mono">NTFY_TOPIC</span> secret is set. Open any flight and tap "Get alerts" for a ready-made rule.</p>
    <p class="muted" style="font-size:12px">To change airports or how often scans run, edit <span class="mono">config.json</span> in the repo.</p>`;
  openModal('Scanner status', html);
}
$('#status').onclick = openStatus;

// ---------------------------------------------------------------- theme + boot
const themes = ['auto', 'dark', 'light'];
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  $('#theme').title = `Theme: ${t}`;
}
let theme = store.get('gw.theme', 'auto');
applyTheme(theme);
$('#theme').onclick = () => { theme = themes[(themes.indexOf(theme) + 1) % themes.length]; store.set('gw.theme', theme); applyTheme(theme); toast(`Theme: ${theme}`); };

window.addEventListener('hashchange', () => { readHash(); render(); });

async function boot() {
  try { S.index = await getJSON('data/index.json'); } catch { S.index = null; }
  if (S.index?.extraAirports?.length) {
    AIRPORTS = buildAirports(S.index.extraAirports);
    AP = Object.fromEntries(AIRPORTS.map((a) => [a.code, a]));
  }
  const p = readHash();
  importTrackFromHash(p);
  if (!S.origin) S.origin = S.index?.homeAirports?.[0] ?? 'DEN';
  renderOriginSelect();
  render();
  // Refresh data in the background every 5 minutes while the app is open.
  setInterval(async () => {
    try {
      const idx = await getJSON('data/index.json');
      if (idx.generatedAt !== S.index?.generatedAt) {
        S.index = idx; S.days.clear(); S.history = null;
        render();
        toast('New seat data loaded');
      }
    } catch { /* offline */ }
  }, 5 * 60 * 1000);
}
boot();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
