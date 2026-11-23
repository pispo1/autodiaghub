const cacheName = 'autodiaghub-shell-v15';
const assetPaths = [
  'index.html', 'style.css', 'app.mjs', 'ble.mjs', 'obd.mjs', 'modes.mjs', 'history.mjs',
  'psa.mjs', 'psa-view.mjs', 'psa/catalog.json', 'psa/NOTICE.txt', 'psa/LICENSE.txt',
];
const scope = new URL(self.registration.scope);
const assets = new Set(assetPaths.map((path) => new URL(path, scope).href));
const index = new URL('index.html', scope).href;

async function cacheAppFiles() {
  const cache = await caches.open(cacheName);
  await cache.addAll([...assets].map((asset) => new Request(asset, { cache: 'reload' })));
}

self.addEventListener('install', (event) => event.waitUntil(cacheAppFiles()));

self.addEventListener('message', (event) => {
  if (event.data === 'activate-update') event.waitUntil(self.skipWaiting());
  if (event.data === 'refresh-files' && event.ports[0]) {
    const port = event.ports[0];
    event.waitUntil(cacheAppFiles().then(
      () => port.postMessage({ ok: true }),
      () => port.postMessage({ ok: false }),
    ));
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) =>
      key.startsWith('autodiaghub-shell-') && key !== cacheName).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const address = url.href === scope.href ? index : url.href;
  if (!assets.has(address)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return await cache.match(address) || fetch(event.request);
  })());
});
