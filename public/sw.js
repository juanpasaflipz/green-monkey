const revision = new URL(self.location.href).searchParams.get("revision") || "unknown";
const CACHE = `green-monkey-shell-${revision.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

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
  await cache.addAll([...new Set(assets)]);
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
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(event.request);
        return hit ?? (await cache.match("/index.html"));
      }),
  );
});
