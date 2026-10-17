// Service worker de la web app: recibe las notificaciones push y las muestra,
// aunque el panel esté cerrado. Al tocar una notificación, abre el panel.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Monitor de Técnica', {
    body: d.body || '',
    tag: d.tag,
    renotify: !!d.tag,
    icon: '/icono-192.png',
    badge: '/icono-192.png',
    data: { url: '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ventanas => {
    for (const v of ventanas) if ('focus' in v) return v.focus();
    return self.clients.openWindow('/');
  }));
});
