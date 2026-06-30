/* ============================================================
   Anfitorio service worker — installability + app-shell offline
   + instant repeat loads.

   SAFETY: /api is NEVER cached. This is a VeriFactu financial product;
   folios, invoices and availability must always come from the network.
   Static assets are content-hashed by Vite, so caching them can never go
   stale across deploys; the HTML document is network-first so a new build
   shows immediately when online.
   ============================================================ */
const CACHE = "anfitorio-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin (CDN, analytics, etc.) → straight to the network.
  if (url.origin !== self.location.origin) return;

  // The API is live-only. Never intercept it.
  if (url.pathname.startsWith("/api")) return;

  // Page navigations: network-first so each deploy is picked up immediately,
  // with the cached shell as the offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put("/", fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match("/");
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // Hashed static assets (JS/CSS/fonts/img): stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            cache.put(req, res.clone());
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })()
  );
});
