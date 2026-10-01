/* BuddyBoard moved from /v2/ to the main address. This replacement
   service worker removes the old offline copy and sends open v2 windows
   to the new address. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('buddyboard2-')).map(k => caches.delete(k)));
    await self.registration.unregister();
    const wins = await self.clients.matchAll({ type: 'window' });
    wins.forEach(c => c.navigate(new URL('../', self.registration.scope).href));
  })());
});
