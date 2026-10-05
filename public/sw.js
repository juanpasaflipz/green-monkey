// The build id is baked in at build time (vite/sw-shell-plugin.ts). The worker
// never derives its revision from the registration URL, so an update can never
// write a newer HTML shell into the cache an older revision is serving (OFF-10).
const BUILD_ID = "__GM_BUILD_ID__";
const CACHE = `green-monkey-shell-${BUILD_ID.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
const SHELL_ASSETS = [];

// The SPA fallback answers unknown paths with index.html; an HTML body is
// never a valid hashed asset.
function isAsset(response) {
  return (
    response.ok &&
    !(response.headers.get("content-type") || "").includes("text/html")
  );
}

function buildOf(html) {
  const tag = html.match(/<meta[^>]*name="gm-build"[^>]*>/);
  const content = tag && tag[0].match(/content="([^"]*)"/);
  return content ? content[1] : null;
}

async function cacheShell() {
  const cache = await caches.open(CACHE);
  // HTML is written last, so a cache holding /index.html is a complete revision.
  if (await cache.match("/index.html")) return;
  try {
    const response = await fetch("/index.html", { cache: "no-store" });
    if (!response.ok) throw new Error("shell_fetch_failed");
    const html = await response.clone().text();
    if (buildOf(html) !== BUILD_ID) throw new Error("shell_revision_mismatch");
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
      (match) => match[1],
    );
    const results = await Promise.allSettled(
      [...new Set([...assets, ...SHELL_ASSETS])].map(async (url) => {
        const asset = await fetch(url, { cache: "no-store" });
        if (!isAsset(asset)) throw new Error("shell_asset_failed");
        await cache.put(url, asset);
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    await cache.put("/index.html", response.clone());
    await cache.put("/", response);
  } catch (error) {
    // Never leave a partial revision behind; other revisions are untouched.
    if (!(await cache.match("/index.html"))) await caches.delete(CACHE);
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell());
});

// No automatic skipWaiting or clients.claim: the previous revision keeps serving
// its clients until every tab closes, or until staff apply the update from the
// update prompt when nothing is unsynced (SKIP_WAITING below).
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data === "SKIP_WAITING" || (data && data.type === "SKIP_WAITING"))
    self.skipWaiting();
});

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
      if (event.request.mode === "navigate") {
        // Navigations always use this worker's own complete revision.
        const shell = await (await caches.open(CACHE)).match("/index.html");
        return shell || fetch(event.request);
      }
      if (url.pathname.startsWith("/assets/")) {
        // Hashed names are content-unique, so any revision's copy is correct.
        const hit = await caches.match(event.request);
        if (hit) return hit;
        const response = await fetch(event.request);
        if (isAsset(response))
          await (await caches.open(CACHE)).put(event.request, response.clone());
        return response;
      }
      const hit = await (await caches.open(CACHE)).match(event.request);
      return hit || fetch(event.request);
    })(),
  );
});
