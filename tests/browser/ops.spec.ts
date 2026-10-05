import { test, expect } from "@playwright/test";

// Operations surface of the compiled server: request ids, body errors, the
// public status document and the client-address probe. No login needed.

test("malformed JSON gets 400 invalid_json with a matching X-Request-Id", async ({
  request,
}) => {
  const response = await request.post("/api/public/ops-check/orders", {
    headers: { "Content-Type": "application/json" },
    data: "{bad",
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error).toBe("invalid_json");
  expect(body.requestId).toBeTruthy();
  expect(response.headers()["x-request-id"]).toBe(body.requestId);
});

test("an oversized body gets 413 payload_too_large from the server's own error handler", async ({
  request,
}) => {
  // server/index.ts parses JSON with a 256 kB limit; this exercises its
  // error handler in the compiled build, not a re-implementation.
  const response = await request.post("/api/public/ops-check/orders", {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ note: "x".repeat(300 * 1024) }),
  });
  expect(response.status()).toBe(413);
  const body = await response.json();
  expect(body.error).toBe("payload_too_large");
  expect(response.headers()["x-request-id"]).toBe(body.requestId);
});

test("a Railway request id is reused end to end", async ({ request }) => {
  const response = await request.get("/api/session", {
    headers: { "X-Railway-Request-Id": "ops-browser-check-0001" },
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["x-request-id"]).toBe("ops-browser-check-0001");
  expect((await response.json()).requestId).toBe("ops-browser-check-0001");
});

test("ops status reports readiness and no secrets", async ({ request }) => {
  const response = await request.get("/api/ops/status");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const status = await response.json();
  expect(Object.keys(status).sort()).toEqual([
    "commit",
    "db",
    "degraded",
    "ok",
    "schema",
    "version",
    "worker",
  ]);
  expect(status).toMatchObject({ ok: true, db: "ok", schema: "ready" });
  expect(Object.keys(status.worker).sort()).toEqual(["lastBeatAt", "status"]);
  expect(["ok", "stale", "unknown"]).toContain(status.worker.status);
  expect(JSON.stringify(status)).not.toMatch(
    /postgres|password|secret|tenant|token/i,
  );
});

test("the client-address probe returns only the requester's address", async ({
  request,
}) => {
  const probe = await (await request.get("/api/ops/diagnostics/ip")).json();
  expect(Object.keys(probe).sort()).toEqual([
    "forwardedHop",
    "ip",
    "peerTrusted",
  ]);
  expect(typeof probe.ip).toBe("string");
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
});
