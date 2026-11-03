// Time helpers shared by the scraper (Node) and the web app (browser).
// Frontier reports every time as *local* wall-clock time at that airport,
// written here as "YYYY-MM-DDTHH:MM".

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Current (or given) instant as local wall-clock "YYYY-MM-DDTHH:MM" in tz. */
export function localNow(tz, ms = Date.now()) {
  const p = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function localToday(tz, ms = Date.now()) {
  return localNow(tz, ms).slice(0, 10);
}

/** Local wall-clock string in tz -> epoch ms. */
export function localToUtcMs(local, tz) {
  const guess = Date.parse(`${local}:00Z`);
  const off1 = Date.parse(`${localNow(tz, guess)}:00Z`) - guess;
  let ms = guess - off1;
  const off2 = Date.parse(`${localNow(tz, ms)}:00Z`) - ms;
  if (off2 !== off1) ms = guess - off2;
  return ms;
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Minutes from local time a to local time b at the SAME airport. */
export function localMinutesBetween(a, b) {
  return (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000;
}

export function fmtDuration(min) {
  if (min == null || !Number.isFinite(min)) return '';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** "2026-11-04T06:05" -> "6:05a" */
export function fmtClock(local) {
  if (!local) return '';
  let h = Number(local.slice(11, 13));
  const m = local.slice(14, 16);
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
}

export function fmtAgo(epochSec, nowMs = Date.now()) {
  if (!epochSec) return 'never';
  const min = Math.max(0, Math.round((nowMs / 1000 - epochSec) / 60));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
