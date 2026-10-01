/* Service worker — caches the entire app shell so BuddyBoard opens with
   zero network. Data sync is handled by Firestore itself (not cached
   here). Bump CACHE (matches BUILD in app.js) when files change. */
const CACHE = 'buddyboard-2.0.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './firebase-config.js',
  './db.js',
  './cloud.js',
  './app.js',
  './vendor/firebase-app-compat.js',
  './vendor/firebase-auth-compat.js',
  './vendor/firebase-firestore-compat.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for the app's own files only; everything else (Firebase
// sign-in and database traffic) goes straight to the network.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});
