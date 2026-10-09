import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { transformServiceWorker } from "../vite/sw-shell-plugin";

type Key = string | { url: string };
const path = (key: Key) =>
  new URL(typeof key === "string" ? key : key.url, "https://pos.test").pathname;

function fakeCaches(log: string[]) {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (key: Key) => store.get(path(key))?.clone(),
      put: async (key: Key, response: Response) => {
        log.push(`${name}:${path(key)}`);
        store.set(path(key), response);
      },
    };
  };
  return {
    stores,
    api: {
      open,
      has: async (name: string) => stores.has(name),
      delete: async (name: string) => stores.delete(name),
      keys: async () => [...stores.keys()],
      match: async (key: Key) => {
        for (const store of stores.values()) {
          const hit = store.get(path(key));
          if (hit) return hit.clone();
        }
        return undefined;
      },
    },
  };
}

function loadWorker({
  buildId = "build-new",
  location = "https://pos.test/sw.js",
  html = `<html><head><meta name="gm-build" content="${buildId}"><script src="/assets/index-a.js"></script><link href="/assets/index-a.css"></head></html>`,
  assets = ["/assets/index-a.js", "/assets/index-a.css", "/assets/lazy-b.js"],
  failing = [] as string[],
} = {}) {
  const log: string[] = [];
  const caches = fakeCaches(log);
  const handlers: Record<string, (event: any) => void> = {};
  const network: string[] = [];
  const fetch = vi.fn(async (input: Key) => {
    const p = path(input);
    network.push(p);
    if (failing.includes(p)) return new Response("nope", { status: 500 });
    if (p === "/index.html" || p === "/")
      return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(`asset ${p}`);
  });
  const self = {
    location: new URL(location),
    skipWaiting: vi.fn(),
    addEventListener: (type: string, fn: (event: any) => void) => {
      handlers[type] = fn;
    },
  };
  const source = transformServiceWorker(
    readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    { buildId, assets },
  );
  vm.runInNewContext(source, {
    self,
    caches: caches.api,
    fetch,
    URL,
    Response,
    Promise,
    Error,
    Set,
    console,
  });
  const install = async () => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.install!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    return done;
  };
  const request = (
    url: string,
    init: { method?: string; mode?: string } = {},
  ) => {
    let response: Promise<Response> | null = null;
    handlers.fetch!({
      request: {
        url: new URL(url, "https://pos.test").href,
        method: init.method ?? "GET",
        mode: init.mode ?? "cors",
      },
      respondWith: (p: Promise<Response>) => (response = p),
    });
    return response as Promise<Response> | null;
  };
  return { caches, log, network, handlers, self, install, request, fetch };
}

describe("service worker shell", () => {
  it("cache name comes from baked BUILD_ID, not the registration query", async () => {
    // Regression OFF-10: an old page registering /sw.js?revision=OLD received
    // the new script, which then wrote into the old revision's cache.
    const worker = loadWorker({
      buildId: "build-new",
      location: "https://pos.test/sw.js?revision=build-old",
    });
    await worker.install();
    expect([...worker.caches.stores.keys()]).toEqual([
      "green-monkey-shell-build-new",
    ]);
  });

  it("install writes /index.html only after all assets are cached", async () => {
    const worker = loadWorker();
    await worker.install();
    const writes = worker.log.map((entry) => entry.split(":")[1]);
    expect(writes.slice(-2)).toEqual(["/index.html", "/"]);
    expect(new Set(writes.slice(0, -2))).toEqual(
      new Set([
        "/assets/index-a.js",
        "/assets/index-a.css",
        "/assets/lazy-b.js",
      ]),
    );
  });

  it("failed asset install deletes the new cache and leaves the old cache untouched", async () => {
    const worker = loadWorker({ failing: ["/assets/lazy-b.js"] });
    const old = await worker.caches.api.open("green-monkey-shell-build-old");
    await old.put("/index.html", new Response("old shell"));
    await old.put("/assets/old.js", new Response("old asset"));
    await expect(worker.install()).rejects.toThrow("shell_asset_failed");
    expect([...worker.caches.stores.keys()]).toEqual([
      "green-monkey-shell-build-old",
    ]);
    const oldStore = worker.caches.stores.get("green-monkey-shell-build-old")!;
    expect([...oldStore.keys()].sort()).toEqual([
      "/assets/old.js",
      "/index.html",
    ]);
    expect(await oldStore.get("/index.html")!.clone().text()).toBe("old shell");
  });

  it("an HTML fallback page is never cached as a hashed asset", async () => {
    const worker = loadWorker({ html: undefined });
    const html =
      '<html><head><meta name="gm-build" content="build-new"></head></html>';
    worker.fetch.mockImplementation(async (input: Key) => {
      const p = path(input);
      return p.startsWith("/assets/lazy")
        ? new Response("<html>spa fallback</html>", {
            headers: { "content-type": "text/html" },
          })
        : new Response(p === "/index.html" ? html : `asset ${p}`, {
            headers: {
              "content-type":
                p === "/index.html" ? "text/html" : "text/javascript",
            },
          });
    });
    await expect(worker.install()).rejects.toThrow("shell_asset_failed");
    expect(worker.caches.stores.size).toBe(0);
    const response = await worker.request("/assets/lazy-c.js")!;
    expect(await response.text()).toBe("<html>spa fallback</html>");
    expect(
      worker.caches.stores
        .get("green-monkey-shell-build-new")
        ?.has("/assets/lazy-c.js") ?? false,
    ).toBe(false);
  });

  it("HTML with a different gm-build meta aborts install", async () => {
    const worker = loadWorker({
      html: `<html><head><meta name="gm-build" content="someone-else"></head></html>`,
    });
    await expect(worker.install()).rejects.toThrow("shell_revision_mismatch");
    expect(worker.caches.stores.size).toBe(0);
    expect(worker.network).toEqual(["/index.html"]);
  });

  it("navigation served from own cache; asset served from any revision cache", async () => {
    const worker = loadWorker();
    await worker.install();
    const other = await worker.caches.api.open("green-monkey-shell-build-old");
    await other.put("/index.html", new Response("old shell"));
    await other.put("/assets/only-old.js", new Response("old asset"));
    worker.network.length = 0;
    const page = await worker.request("/app", { mode: "navigate" })!;
    expect(await page.text()).toContain('content="build-new"');
    const asset = await worker.request("/assets/only-old.js")!;
    expect(await asset.text()).toBe("old asset");
    expect(worker.network).toEqual([]);
    const fresh = await worker.request("/assets/new-c.js")!;
    expect(await fresh.text()).toBe("asset /assets/new-c.js");
    expect(
      worker.caches.stores
        .get("green-monkey-shell-build-new")!
        .has("/assets/new-c.js"),
    ).toBe(true);
  });

  it("SKIP_WAITING message calls skipWaiting", () => {
    const worker = loadWorker();
    worker.handlers.message!({ data: { type: "OTHER" } });
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
    worker.handlers.message!({ data: { type: "SKIP_WAITING" } });
    expect(worker.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("/api and non-GET are never intercepted", () => {
    const worker = loadWorker();
    expect(worker.request("/api/offline/ping")).toBeNull();
    expect(worker.request("/api/session", { mode: "navigate" })).toBeNull();
    expect(worker.request("/app", { method: "POST" })).toBeNull();
    expect(worker.request("https://cdn.example/x.js")).toBeNull();
  });

  it("R32 (Wave 4): navigations to the diner and customer pages (/kiosk, /qr, /f, /factura, /club) go to the network, never the cached staff shell", async () => {
    const worker = loadWorker();
    await worker.install();
    for (const p of ["/club", "/club/", "/kiosk", "/qr/", "/f", "/factura/abc"]) {
      worker.network.length = 0;
      const r = worker.request(p, { mode: "navigate" });
      expect(r, p).not.toBeNull();
      await (await r!).text();
      expect(worker.network, p).toEqual([p]);
    }
    // The staff app and look-alike paths still get the cached shell.
    for (const p of ["/app", "/clubhouse", "/qrcode"]) {
      worker.network.length = 0;
      const page = await worker.request(p, { mode: "navigate" })!;
      expect(await page.text()).toContain('content="build-new"');
      expect(worker.network, p).toEqual([]);
    }
  });

  it("activation removes other shell revisions only", async () => {
    const worker = loadWorker();
    await worker.install();
    await worker.caches.api.open("green-monkey-shell-build-old");
    await worker.caches.api.open("unrelated-cache");
    let done: Promise<unknown> = Promise.resolve();
    worker.handlers.activate!({
      waitUntil: (p: Promise<unknown>) => (done = p),
    });
    await done;
    expect([...worker.caches.stores.keys()].sort()).toEqual([
      "green-monkey-shell-build-new",
      "unrelated-cache",
    ]);
  });

  it("refuses a source without placeholders", () => {
    expect(() =>
      transformServiceWorker("self.x = 1;", { buildId: "b", assets: [] }),
    ).toThrow();
  });
});
