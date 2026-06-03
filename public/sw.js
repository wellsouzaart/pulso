// Pulso Service Worker — Push + Cache

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// ── Push Notification ─────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Pulso', body: 'Nova mensagem', url: '/' };
  try { data = e.data.json(); } catch {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg',
      tag: 'pulso-notification',
      renotify: true,
      data: { url: data.url || '/' },
      actions: [
        { action: 'open', title: 'Abrir Pulso' },
        { action: 'dismiss', title: 'Dispensar' }
      ]
    })
  );
});

// ── Notification Click ────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
