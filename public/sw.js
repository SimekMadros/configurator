const RUNTIME_CACHE = "runtime-assets-v2";
const RUNTIME_CACHE_PREFIX = "runtime-assets-";
const RUNTIME_ASSET_PATHS = ["images/", "models/", "textures/", "thumbs/"];

function getScopePathname() {
  const scopePath = new URL(self.registration.scope).pathname;
  return scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
}

function shouldCache(url) {
  const scopePath = getScopePathname();
  if (!url.pathname.startsWith(scopePath)) return false;

  const relativePath = url.pathname.slice(scopePath.length);
  return RUNTIME_ASSET_PATHS.some((prefix) => relativePath.startsWith(prefix));
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(RUNTIME_CACHE_PREFIX) && name !== RUNTIME_CACHE)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!shouldCache(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);

    try {
      const res = await fetch(event.request);
      if (res && res.ok) {
        cache.put(event.request, res.clone());
      }
      return res;
    } catch (error) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      throw error;
    }
  })());
});
