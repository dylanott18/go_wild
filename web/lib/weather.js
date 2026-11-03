// 16-day forecasts from Open-Meteo (free, no key, CORS-enabled). Many
// airports are fetched in one batched request and cached for an hour.

const WMO = [
  [[0], '☀️', 'Clear'],
  [[1], '🌤️', 'Mostly clear'],
  [[2], '⛅', 'Partly cloudy'],
  [[3], '☁️', 'Cloudy'],
  [[45, 48], '🌫️', 'Fog'],
  [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'],
  [[61, 63, 80, 81], '🌧️', 'Rain'],
  [[65, 66, 67, 82], '🌧️', 'Heavy rain'],
  [[71, 73, 77, 85], '🌨️', 'Snow'],
  [[75, 86], '❄️', 'Heavy snow'],
  [[95], '⛈️', 'Thunderstorms'],
  [[96, 99], '⛈️', 'Severe storms'],
];

export function describe(code) {
  for (const [codes, icon, label] of WMO) if (codes.includes(code)) return { icon, label };
  return { icon: '·', label: 'Unknown' };
}

/** Weather worth warning about before a spontaneous trip. */
export function isRough(day) {
  return [65, 66, 67, 75, 82, 86, 95, 96, 99].includes(day.code) || (day.pop ?? 0) >= 85;
}

const TTL = 60 * 60 * 1000;
const mem = new Map();
function cacheGet(code) {
  if (mem.has(code)) return mem.get(code);
  try {
    const v = JSON.parse(sessionStorage.getItem(`gw.wx.${code}`) ?? 'null');
    if (v && Date.now() - v.at < TTL) { mem.set(code, v); return v; }
  } catch { /* storage unavailable */ }
  return null;
}
function cacheSet(code, v) {
  mem.set(code, v);
  try { sessionStorage.setItem(`gw.wx.${code}`, JSON.stringify(v)); } catch { /* ignore */ }
}

let inflight = null;
/**
 * @param {{code,lat,lon}[]} airports
 * @returns {Promise<Map<string, {at:number, days:Record<string,{code,hi,lo,pop}>}>>}
 */
export async function forecasts(airports) {
  if (inflight) await inflight.catch(() => {});
  const out = new Map();
  const need = [];
  for (const a of airports) {
    const c = cacheGet(a.code);
    if (c) out.set(a.code, c); else need.push(a);
  }
  if (!need.length) return out;
  inflight = (async () => {
    for (let i = 0; i < need.length; i += 50) {
      const chunk = need.slice(i, i + 50);
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${chunk.map((a) => a.lat).join(',')}&longitude=${chunk.map((a) => a.lon).join(',')}`
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
        + '&temperature_unit=fahrenheit&timezone=auto&forecast_days=16';
      const r = await fetch(url);
      if (!r.ok) throw new Error(`weather ${r.status}`);
      let body = await r.json();
      if (!Array.isArray(body)) body = [body];
      body.forEach((loc, j) => {
        const d = loc.daily ?? {};
        const days = {};
        (d.time ?? []).forEach((t, k) => {
          days[t] = { code: d.weather_code?.[k], hi: d.temperature_2m_max?.[k], lo: d.temperature_2m_min?.[k], pop: d.precipitation_probability_max?.[k] };
        });
        const v = { at: Date.now(), days };
        cacheSet(chunk[j].code, v);
        out.set(chunk[j].code, v);
      });
    }
  })();
  try { await inflight; } catch { /* offline or blocked: no weather */ } finally { inflight = null; }
  return out;
}

export function chip(day) {
  if (!day || day.code == null) return '';
  const { icon, label } = describe(day.code);
  const rough = isRough(day);
  const temps = day.hi != null ? `${Math.round(day.hi)}°/${Math.round(day.lo)}°` : '';
  return `<span class="wx${rough ? ' rough' : ''}" title="${label}${day.pop != null ? ` · ${day.pop}% chance of precipitation` : ''}">${icon} ${temps}${rough ? ` · ${label}` : ''}</span>`;
}
