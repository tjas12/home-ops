const CACHE = "home-ops-v5";
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./push.js",
  "./config.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).pathname.endsWith("/config.js")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json?.() || {};
  } catch {
    data = { body: event.data?.text?.() || "" };
  }
  const title = data.title || "Home Ops";
  const options = {
    body: data.body || data.message || "You have a Home Ops update.",
    icon: data.icon || "./assets/icon.svg",
    badge: data.badge || "./assets/icon.svg",
    data: { ...(data.data || {}), url: data.url || data.data?.url || "./" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "./";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        if ("navigate" in client) await client.navigate(targetUrl);
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
      return undefined;
    })
  );
});
