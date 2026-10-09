/* Learnza service worker.
   Goal: the apps open instantly and still show their shell with no signal. Deliberately
   conservative about what it keeps:
     - /api, /socket.io, /uploads and anything cross-origin are NEVER cached or touched, so
       data, sign-in state and payments are always live;
     - pages and scripts are network-first (a deploy shows up immediately) and fall back to the
       last copy only when the network fails. */
const CACHE = 'learnza-shell-v1';
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

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match(url.pathname.startsWith('/schools') ? '/schools' : '/app') : Response.error())))
  );
});
