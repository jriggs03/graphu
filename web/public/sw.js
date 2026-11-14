self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Graphu offline</title><h1>Graphu is offline</h1><p>Reconnect to open your graph and review sources.</p><a href="/">Try again</a></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )))
})
