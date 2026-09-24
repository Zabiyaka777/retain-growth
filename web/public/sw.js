// Web Push service worker: shows a system notification for new inbound
// messages and focuses (or opens) the right thread on click.
//
// No caching/offline strategy here — this worker exists only to receive
// push events while the app tab may be closed, not to make the app an
// installable/offline PWA.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'Retain Growth', body: event.data.text() }
  }

  const title = payload.title || 'Нове повідомлення'
  const options = {
    body: payload.body || '',
    icon: '/vite.svg',
    badge: '/vite.svg',
    tag: payload.threadId ? `thread-${payload.threadId}` : undefined,
    renotify: Boolean(payload.threadId),
    data: {
      threadId: payload.threadId || null,
      url: payload.threadId ? `/dashboard/chats?thread=${payload.threadId}` : '/dashboard/chats',
    },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/dashboard/chats'

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

      for (const client of allClients) {
        const clientUrl = new URL(client.url)
        if (clientUrl.origin === self.location.origin) {
          await client.focus()
          if ('navigate' in client) {
            await client.navigate(targetUrl)
          }
          return
        }
      }

      await self.clients.openWindow(targetUrl)
    })(),
  )
})
