// Peh service worker — enables Android "Share → Peh" (Web Share Target) for images.
// When the user shares an image to the installed Peh PWA, Android POSTs it to ./share-target;
// we stash the file in a cache and redirect the app to ?shared=1, which picks it up and hands
// it to Peh. This SW does NOT cache app assets (the ikbi server is always local) — it exists
// only to intercept the share POST, which a static server can't handle.
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async function () {
      try {
        var form = await event.request.formData();
        var file = form.get('image');
        if (file) {
          var cache = await caches.open('peh-shared');
          await cache.put('shared-image', new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } }));
        }
      } catch (e) {
        /* fall through to the redirect; the app just won't find an image */
      }
      return Response.redirect('./?shared=1', 303);
    })());
  }
});
