const CACHE = "buam-v77";
const SHARE_CACHE = "buam-share-cache";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./buam-weather.js",
  "./buam-voice.js",
  "./buam-fx.js",
  "./buam-money.js",
  "./bgm.mp3",
  "./fonts/ByteBounce.ttf",
  "./games/index.html",
  "./games/breach-runner.html",
  "./games/neon-arena.html"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith(handleShareTarget(e.request));
    return;
  }
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const file = formData.get("receipt");
    if (file) {
      const cache = await caches.open(SHARE_CACHE);
      const key = new URL("shared-receipt", self.registration.scope).toString();
      await cache.put(
        key,
        new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } })
      );
    }
  } catch (err) {
    // no-op: page falls back to manual scan when nothing was stored
  }
  return Response.redirect(new URL("?shared-receipt=1", self.registration.scope).toString(), 303);
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
