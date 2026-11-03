// Route map: Leaflet (loaded on demand from cdnjs) with CARTO basemap tiles.

const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4';
let loading = null;

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${LEAFLET}/leaflet.min.css`;
      document.head.append(css);
      const js = document.createElement('script');
      js.src = `${LEAFLET}/leaflet.min.js`;
      js.onload = () => resolve(window.L);
      js.onerror = () => { loading = null; reject(new Error('Map library failed to load')); };
      document.head.append(js);
    });
  }
  return loading;
}

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

let map = null;
let layer = null;

/**
 * @param {HTMLElement} el
 * @param {{code,lat,lon,city}} center  the selected airport
 * @param {{airport, count, best, seats, popupHtml}[]} points
 * @param {(code:string)=>void} onPick
 */
export async function drawRouteMap(el, center, points, onPick) {
  const L = await loadLeaflet();
  if (map && map.getContainer() !== el) { map.remove(); map = null; }
  if (!map) {
    map = L.map(el, { worldCopyJump: true, zoomSnap: 0.5 });
    const style = isDark() ? 'dark_all' : 'light_all';
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
      maxZoom: 12,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
  }
  layer?.remove();
  layer = L.layerGroup().addTo(map);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0d6e5f';
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#fff';
  const bounds = [[center.lat, center.lon]];
  for (const p of points) {
    const ll = [p.airport.lat, p.airport.lon];
    bounds.push(ll);
    L.polyline([[center.lat, center.lon], ll], { color: accent, weight: 1.5, opacity: 0.35, interactive: false }).addTo(layer);
    const m = L.circleMarker(ll, {
      radius: 5 + Math.min(10, Math.sqrt(p.count) * 2.2), color: surface, weight: 2, fillColor: accent, fillOpacity: 0.9,
    }).addTo(layer);
    m.bindTooltip(`${p.airport.code} · ${p.count} flight${p.count > 1 ? 's' : ''}`, { direction: 'top' });
    m.bindPopup(p.popupHtml);
    m.on('popupopen', (e) => {
      e.popup.getElement()?.querySelector('[data-pick]')?.addEventListener('click', () => onPick(p.airport.code));
    });
  }
  L.circleMarker([center.lat, center.lon], { radius: 9, color: accent, weight: 3, fillColor: surface, fillOpacity: 1 })
    .bindTooltip(center.code, { permanent: true, direction: 'right', className: 'map-origin' }).addTo(layer);
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 7 });
  else map.setView(bounds[0], 5);
  setTimeout(() => map.invalidateSize(), 50);
}

export function destroyMap() {
  map?.remove();
  map = null;
  layer = null;
}
