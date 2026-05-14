const RUNTIME_CACHE = "runtime-assets-v1";

function shouldCache(url) {
  return (
    url.pathname.startsWith("/models/") ||
    url.pathname.startsWith("/textures/") ||
    url.pathname.startsWith("/thumbs/")
  );
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // jen stejny server a jen naše assety
  if (url.origin !== self.location.origin) return;
  if (!shouldCache(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);

    // 1) zkus cache
    const cached = await cache.match(event.request);
    if (cached) return cached;

    // 2) jinak stáhni a ulož do cache
    const res = await fetch(event.request);
    if (res && res.ok) {
      cache.put(event.request, res.clone());
    }
    return res;
  })());
});
