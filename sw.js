/* Service worker — keeps a copy of the app so BuddyBoard also opens with
   no network. Online it always loads the newest version from the server
   (and refreshes the copy); offline it falls back to the copy. Data sync
   goes to Supabase directly and is never cached here.
   CACHE matches BUILD in app.js. */
const CACHE = 'buddyboard-2.10.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './supabase-config.js',
  './db.js',
  './cloud.js',
  './xlsx.js',
  './app.js',
  './vendor/supabase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's own HTTP cache, so the copy is
  // guaranteed to be this version's files and never an older leftover.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first for the app's own files (so an update shows up on the next
// open), falling back to the stored copy when offline. Everything else
// (Supabase sign-in and data) goes straight to the network.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // A very slow connection counts as offline after 6 s.
      const res = await Promise.race([
        fetch(req, { cache: 'no-cache' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
      ]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true })
        || (req.mode === 'navigate' && await cache.match('./index.html'));
      if (hit) return hit;
      throw err;
    }
  })());
});
