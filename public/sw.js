// sw.js
// Service worker : ne met rien en cache (ce site est un chat en temps reel,
// mieux vaut toujours passer par le reseau). Sa presence + un gestionnaire
// "fetch" permet l'installation en tant qu'appli, et il affiche aussi les
// notifications push (messages / appels) quand le site est ferme.

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

// Notification push recue (envoyee par le serveur quand tu es hors ligne).
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'robotbotchat', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'robotbotchat';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag,
    renotify: !!payload.tag,
    requireInteraction: !!payload.requireInteraction,
    vibrate: [200, 100, 200],
    data: payload.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clic sur une notification : on remet l'appli au premier plan (ou on
// l'ouvre) et on lui dit quelle discussion afficher.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const client = clientList.find((c) => 'focus' in c);
      if (client) {
        client.postMessage({ type: 'notification-click', data });
        return client.focus();
      }
      return self.clients.openWindow('/');
    })
  );
});
