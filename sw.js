const CACHE = "home-ops-v6";
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./push.js",
  "./config.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  ...Array.from({ length: 10 }, (_, i) => `./app.bundle.${String(i + 1).padStart(3, "0")}.b64`),
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("home-ops-") && key !== CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  // Cache static code, never authenticated Supabase responses.
  if (requestUrl.origin !== self.location.origin && requestUrl.hostname !== "cdn.jsdelivr.net") return;
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
      .catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : Response.error())))
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
    tag: data.notificationId,
    data: { ...(data.data || {}), sourceId: data.sourceId, notificationId: data.notificationId, userId: data.userId, url: data.url || data.data?.url || "./" },
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    updateBadge(data.unreadCount),
    clients.matchAll({ type: "window" }).then((windows) => windows.forEach((client) => client.postMessage({ type: "HOME_OPS_PUSH" }))),
  ]));
});

async function updateBadge(count) {
  if (!Number.isInteger(count) || count < 0) return;
  try {
    if (count && self.registration.setAppBadge) await self.registration.setAppBadge(count);
    else if (!count && self.registration.clearAppBadge) await self.registration.clearAppBadge();
  } catch {}
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "HOME_OPS_BADGE") event.waitUntil(updateBadge(event.data.count));
  if (event.data?.type === "HOME_OPS_COMPLETED" || event.data?.type === "HOME_OPS_CLOSE_NOTIFICATION") event.waitUntil(
    self.registration.getNotifications().then((notifications) => notifications.forEach((notification) => {
      if (notification.data?.userId === event.data.userId && ((event.data.id && event.data.id === notification.data?.notificationId) || (event.data.sourceId && event.data.sourceId === notification.data?.sourceId))) notification.close();
    }))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification?.data?.url || "./", self.registration.scope);
  if (target.origin !== self.location.origin) return;
  if (event.notification.data?.notificationId) {
    target.searchParams.set("notification", event.notification.data.notificationId);
    target.searchParams.set("notificationUser", event.notification.data.userId);
  }
  const targetUrl = target.href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        client.postMessage({ type: "HOME_OPS_NOTIFICATION_READ", id: event.notification.data?.notificationId, userId: event.notification.data?.userId });
        if ("navigate" in client) await client.navigate(targetUrl);
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
      return undefined;
    })
  );
});
