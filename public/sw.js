// sw.js
// Service worker minimal : ne met rien en cache (ce site est un chat en
// temps reel, mieux vaut toujours passer par le reseau) mais sa seule
// presence + un gestionnaire "fetch" est ce qui permet a Chrome/Android
// de proposer "Installer l'application" sur ce site.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Laisse passer toutes les requetes normalement, sans mise en cache.
  event.respondWith(fetch(event.request));
});
