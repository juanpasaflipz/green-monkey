import { afterEach, expect, it, vi } from "vitest";
import { BrowserbaseDriver } from "../server/delivery-worker/browserbase.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("disabled workers do not claim delivery jobs; enabling registers them", async () => {
  vi.stubEnv("DELIVERY_BROWSER_ENABLED", "0");
  vi.resetModules();
  await import("../server/delivery-worker/register.js");
  const disabled = await import("../server/jobs/worker-registry.js");
  expect(disabled.workerHandlers().has("delivery_browser")).toBe(false);
  vi.stubEnv("DELIVERY_BROWSER_ENABLED", "1");
  vi.resetModules();
  await import("../server/delivery-worker/register.js");
  const enabled = await import("../server/jobs/worker-registry.js");
  expect(enabled.workerHandlers().has("delivery_browser")).toBe(true);
});
it("waits for remote session closure before deleting its context", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "RUNNING" })))
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "RUNNING" })))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "COMPLETED" })),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const driver = new BrowserbaseDriver("synthetic-key", "synthetic-project");
  const signal = AbortSignal.timeout(5000);
  await driver.release("synthetic-session", signal);
  await driver.deleteContext("synthetic-context", signal);
  expect(fetcher.mock.calls.map((c) => c[1].method)).toEqual([
    "GET",
    "POST",
    "GET",
    "GET",
    "DELETE",
  ]);
});
it("a retry skips release of a session that already finished", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ status: "COMPLETED" })));
  vi.stubGlobal("fetch", fetcher);
  const driver = new BrowserbaseDriver("synthetic-key", "synthetic-project");
  await driver.release("synthetic-session", new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].method).toBe("GET");
});
