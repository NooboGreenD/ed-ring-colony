self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'ED Ring Colony', {
      body: data.body ?? '',
      icon: data.icon ?? '/icon-192.png',
      badge: data.badge ?? '/badge-72.png',
      tag: data.tag ?? 'default',
      data: { url: data.url ?? '/' },
      requireInteraction: data.requireInteraction ?? false,
      // Вибрация для мобильных (паттерн: короткая, пауза, короткая)
      vibrate: data.vibrate ?? [200, 100, 200],
      // Действия на уведомлении (Android)
      actions: data.actions ?? [],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Если вкладка уже открыта — фокусируемся на ней
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      // Иначе открываем новую
      return clients.openWindow(url);
    })
  );
});

// Установка — кэшируем основные ресурсы
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
