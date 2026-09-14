import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { connect, checkRole } from "../server/db.js";
import { signInGoogleOwner } from "../server/owner-accounts.js";

// Explicit synthetic identities test deployed HTTP authorization, not Google.
// Fixtures are retained for audit; no provider payments or outbound jobs run.
const origin = process.env.STAGING_URL;
const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (
  origin !== "https://green-monkey-staging.up.railway.app" ||
  origin !== process.env.STAGING_ORIGIN_ALLOWLIST ||
  url.pathname !== "/green_monkey_staging" ||
  `${url.hostname}:${url.port || "5432"}${url.pathname}` !==
    process.env.QUALIFICATION_DATABASE_ALLOWLIST
)
  throw Error("Explicit staging qualification target required");
const sql = connect(process.env.DATABASE_URL!);
const run = randomUUID();
const checks: string[] = [];
const tenantIds: string[] = [];
try {
  await checkRole(sql);
  function client(accountCookie: string) {
    const cookies = new Map([["gm_account", accountCookie]]);
    return async (
      path: string,
      body?: unknown,
      csrf?: string,
      expected = 200,
    ) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          Origin: origin!,
          "Content-Type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, expected, path);
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";", 1)[0],
          split = pair.indexOf("=");
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
        if (expected === 200 && path.endsWith("/enter")) {
          assert.match(value, /HttpOnly/i);
          assert.match(value, /Secure/i);
        }
      }
      return response.json();
    };
  }
  const clients = [];
  for (const label of ["A", "B"]) {
    const cookie = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject: `qualification-${run}-${label}`,
      email: "synthetic-qualification@example.com",
      name: `Qualification fixture ${label}`,
    });
    const api = client(cookie);
    const account = await api("/api/auth/account");
    assert.deepEqual(account.restaurants, []);
    const input = {
      restaurantName: `Qualification ${label} ${run.slice(0, 8)}`,
      currency: "MXN",
      timezone: "America/Mexico_City",
      cutoff: 240,
      openingDays: [1, 2, 3, 4, 5, 6, 7],
    };
    await api("/api/auth/account/signup", input, "wrong-csrf", 403);
    const created = await api("/api/auth/account/signup", input, account.csrf);
    const repeated = await api("/api/auth/account/signup", input, account.csrf);
    assert.equal(repeated.tenantId, created.tenantId);
    assert.equal(repeated.created, false);
    tenantIds.push(created.tenantId);
    await api(
      "/api/auth/account/enter",
      { tenantId: created.tenantId },
      account.csrf,
    );
    const session = await api("/api/session");
    assert.equal(session.tenantId, created.tenantId);
    assert.deepEqual(await api("/api/catalog"), []);
    clients.push({ api, account, session });
  }
  assert.notEqual(tenantIds[0], tenantIds[1]);
  checks.push(
    "equal-email identities have separate restaurants",
    "signup CSRF rejected",
    "signup retry is idempotent",
    "Secure HttpOnly POS cookies",
    "empty isolated catalogs",
  );
  const [a, b] = clients;
  await b.api(
    "/api/auth/account/enter",
    { tenantId: tenantIds[0] },
    b.account.csrf,
    403,
  );
  const aAccount = await a.api("/api/auth/account");
  assert.deepEqual(
    aAccount.restaurants.map((r: { id: string }) => r.id),
    [tenantIds[0]],
  );
  const productId = randomUUID();
  await a.api(
    "/api/catalog/save",
    {
      operationId: randomUUID(),
      id: productId,
      name: { es: "Producto ficticio A", en: "Fictional product A" },
      category: { es: "Prueba", en: "Test" },
      price: 1000,
      available: true,
      station: "kitchen",
      expectedVersion: 0,
      cost: null,
      recipe: [],
    },
    a.session.csrf,
  );
  assert.equal((await a.api("/api/catalog")).length, 1);
  assert.equal((await b.api("/api/catalog")).length, 0);
  const order = {
    operationId: randomUUID(),
    lines: [
      { id: randomUUID(), productId, quantity: 1, options: [], note: "" },
    ],
    mode: "takeaway",
    name: "Qualification unpaid fixture",
    note: "",
    channel: "pos",
  };
  const accepted = await a.api("/api/orders", order, a.session.csrf);
  await b.api(`/api/orders/${accepted.id}`, undefined, undefined, 404);
  await b.api(
    "/api/orders",
    { ...order, operationId: randomUUID() },
    b.session.csrf,
    400,
  );
  assert.equal((await b.api("/api/orders")).length, 0);
  checks.push(
    "cross-owner restaurant entry rejected",
    "membership list isolated",
    "catalog writes isolated",
    "guessed order read denied",
    "foreign product rejected",
    "order lists isolated",
  );
  await a.api("/api/auth/account/logout", {}, a.account.csrf);
  await a.api("/api/session", undefined, undefined, 401);
  assert.equal((await b.api("/api/session")).tenantId, tenantIds[1]);
  checks.push(
    "owner logout revokes inherited POS session",
    "other tenant session unaffected",
  );
  const evidence = {
    at: new Date().toISOString(),
    origin,
    run,
    identity: "synthetic fixture; not a Google OAuth proof",
    tenantIds,
    orderId: accepted.id,
    checks,
    fixturesRetained: true,
    chargesCreated: false,
  };
  await mkdir("docs/evidence/staging", { recursive: true });
  await writeFile(
    "docs/evidence/staging/tenant-isolation.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    `PASS ${checks.length} deployed tenant/owner checks; synthetic fixture identities`,
  );
} finally {
  await sql.end();
}
