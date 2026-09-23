const revision = new URL(self.location.href).searchParams.get("revision") || "unknown";
const CACHE = `green-monkey-shell-${revision.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
const SHELL_ASSETS = [];

async function cacheShell() {
  const response = await fetch("/index.html", { cache: "no-store" });
  if (!response.ok) throw new Error("shell_fetch_failed");
  const html = await response.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  const cache = await caches.open(CACHE);
  await cache.put("/index.html", response.clone());
  await cache.put("/", response);
  await cache.addAll([...new Set([...assets, ...SHELL_ASSETS])]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell());
});

// No skipWaiting or clients.claim: the previous revision continues serving all
// of its clients. Activation occurs only after those clients are gone.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("green-monkey-shell-") && key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api") ||
    event.request.method !== "GET"
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // A controlled page stays on this complete shell revision until the
      // waiting worker activates. Never write a newer HTML shell into old caches.
      const hit = await cache.match(event.request.mode === "navigate" ? "/index.html" : event.request);
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok && url.pathname.startsWith("/assets/"))
        await cache.put(event.request, response.clone());
      return response;
    })(),
  );
});
