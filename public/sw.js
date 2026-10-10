/* Learnza service worker.
   Goal: the apps open instantly and still show their shell with no signal. Deliberately
   conservative about what it keeps:
     - /api, /socket.io, /uploads and anything cross-origin are NEVER cached or touched, so
       data, sign-in state and payments are always live;
     - pages and scripts are served from the saved copy at once and refreshed in the background (a deploy shows up on the next visit). */
const CACHE = 'learnza-shell-v2';
const PAGES = ['/app', '/schools'];
const SHELL = ['/app', '/schools', '/style.css', '/auth.css', '/ui.css', '/extras.js', '/app.js', '/schools.js', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|socket\.io|uploads|admin|health|version\.json)/.test(url.pathname)) return;
  const isAsset = /\.(js|css|svg|png|jpe?g|webp|gif|ico|webmanifest|woff2?)$/i.test(url.pathname);
  const isShellPage = req.mode === 'navigate' && PAGES.includes(url.pathname);
  if (!isAsset && !isShellPage) return;   // anything else (a public page, a download) goes straight to the network

  // Stale-while-revalidate: show the saved copy at once, fetch a fresh one for the next visit. (Waiting for the
  // network first made every file cost a full round trip, which is slow on a long connection.)
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
    if (hit) { event.waitUntil(fresh); return hit; }
    const res = await fresh;
    return res || (req.mode === 'navigate' ? (await cache.match(url.pathname.startsWith('/schools') ? '/schools' : '/app')) || Response.error() : Response.error());
  }));
});
