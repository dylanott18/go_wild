// Offline shell + network-first data so the app opens instantly on a phone
// but always shows the freshest scan when online.
const SHELL = 'gowild-shell-v3';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'lib/airports.js', 'lib/time.js', 'lib/planner.js', 'lib/links.js', 'lib/charts.js', 'lib/weather.js', 'lib/map.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== 'gowild-data').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first for everything (data changes hourly, code on each deploy); cache as fallback.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(url.pathname.includes('/data/') ? 'gowild-data' : SHELL).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request)),
  );
});
