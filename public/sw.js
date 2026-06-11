/* Service worker de TEG: recibe los push de turno y los muestra como
 * notificación del sistema (funciona con el teléfono bloqueado). */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* texto plano */ }
  const title = data.title || 'TEG';
  const body = data.body || 'Pasan cosas en tu partida.';
  event.waitUntil((async () => {
    // Si el juego está abierto y a la vista, no hace falta molestar
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.some((w) => w.visibilityState === 'visible' && w.focused);
    if (visible) return;
    await self.registration.showNotification(title, {
      body,
      tag: 'teg-turno',
      icon: 'icon-180.png',
      badge: 'icon-180.png'
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      try { await wins[0].focus(); return; } catch (e) { /* sigue abajo */ }
    }
    await self.clients.openWindow('/');
  })());
});
