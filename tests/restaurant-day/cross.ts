/**
 * Cross-restaurant checks (specs/acceptance.md §8, X1): the two restaurants
 * cannot see or change each other's data through the UI or the API. The only
 * mutating calls here are negative probes, and every one must fail.
 */
import { expect } from "@playwright/test";
import { connect, tenant } from "../../server/db.js";
import { RESTAURANT_A, RESTAURANT_B } from "./scenario.js";
import {
  allowing,
  readApi,
  run,
  typePin,
  type Device,
  type Devices,
} from "./ui.js";
import type { RunState } from "./env.js";

/** A JSON call from the device's own page with its CSRF token (negative probes only). */
async function probe(
  d: Device,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  account = false,
) {
  return d.page.evaluate(
    async ({ method, path, body, headers, account }) => {
      const source = await (
        await fetch(account ? "/api/auth/account" : "/api/session")
      )
        .json()
        .catch(() => ({}));
      const r = await fetch(path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-csrf-token": source?.csrf ?? "",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { method, path, body, headers, account },
  );
}

export async function crossRestaurant(dev: Devices, state: RunState) {
  const ownerA = await dev("ownerA");
  const ownerB = await dev("ownerB");
  const caja = await dev("cajaA");
  const A = state.tenantA!;
  const B = state.tenantB!;
  // Read-only lookups as the runtime role under RLS (F3).
  const sql = connect(process.env.RD_RUNTIME_DATABASE_URL!);
  const b1 = await tenant(
    sql,
    B,
    async (tx) =>
      (await tx`select id from orders where number=1`)[0]!.id as string,
  );
  const karla = await tenant(
    sql,
    B,
    async (tx) =>
      (await tx`select id from employees where name=${"Karla Medina"}`)[0]!
        .id as string,
  );
  const karlaSessions = async () =>
    tenant(
      sql,
      B,
      async (tx) =>
        (
          await tx`select count(*)::int as n from sessions where employee_id=${karla}`
        )[0]!.n as number,
    );
  const before = await karlaSessions();

  // X1.1: an owner cannot enter the other restaurant.
  run.step = "X1.1";
  await allowing(
    [{ method: "POST", url: /\/api\/auth\/account\/enter$/, status: 403 }],
    async () => {
      expect(
        (
          await probe(
            ownerA,
            "POST",
            "/api/auth/account/enter",
            { tenantId: B },
            {},
            true,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await probe(
            ownerB,
            "POST",
            "/api/auth/account/enter",
            { tenantId: A },
            {},
            true,
          )
        ).status,
      ).toBe(403);
    },
  );
  for (const [owner, mine, other] of [
    [ownerA, RESTAURANT_A.name, RESTAURANT_B.name],
    [ownerB, RESTAURANT_B.name, RESTAURANT_A.name],
  ] as const) {
    const account = await readApi(owner, "/api/auth/account");
    const text = JSON.stringify(account.body);
    expect(text).toContain(mine);
    expect(text).not.toContain(other);
  }

  // X1.2: Diego, signed in on Caja 1, reads and writes nothing of B.
  run.step = "X1.2";
  const diego = RESTAURANT_A.staff.find((p) => p.key === "diego")!;
  await caja.page
    .getByRole("button", { name: new RegExp(`^${diego.name}`) })
    .click();
  await typePin(caja, caja.page, diego.name, diego.pin);
  await expect(
    caja.page.getByRole("heading", { name: "Vender", level: 1 }),
  ).toBeVisible();
  await allowing(
    [
      { method: "GET", url: /\/api\/orders\/[^/]+$/, status: 404 },
      { method: "GET", url: /\/api\/catalog$/, status: 409 },
      { method: "GET", url: /\/api\/fiscal\/tickets$/, status: 403 },
      { method: "POST", url: /\/api\/orders\/[^/]+\/payments$/, status: 404 },
    ],
    async () => {
      const order = await readApi(caja, `/api/orders/${b1}`);
      expect(order.status).toBe(404);
      expect((order.body as { error: string }).error).toBe("not_found");
      const search = await readApi<{ items: unknown[] }>(
        caja,
        "/api/service/orders?q=Jacaranda",
      );
      expect(search.body.items).toEqual([]);
      const folio = await readApi<{ rows?: unknown[] }>(
        caja,
        `/api/fiscal/tickets?from=${state.businessDateB}&to=${state.businessDateB}&folio=J-000001`,
      );
      expect(
        folio.status === 403 || (folio.body.rows ?? []).length === 0,
        JSON.stringify(folio),
      ).toBe(true);
      const switched = await probe(caja, "GET", "/api/catalog", undefined, {
        "x-tenant-id": B,
      });
      expect(switched.status).toBe(409);
      expect((switched.body as { error: string }).error).toBe(
        "session_changed",
      );
      const pay = await probe(caja, "POST", `/api/orders/${b1}/payments`, {
        operationId: crypto.randomUUID(),
        method: "cash",
        amount: 100,
        tip: 0,
        received: 100,
      });
      expect(pay.status).toBe(404);
    },
  );

  // X1.3: Caja 1's roster has none of B's staff, and B's PIN opens nothing here.
  run.step = "X1.3";
  await caja.page.getByRole("button", { name: "Salir", exact: true }).click();
  await expect(
    caja.page.getByRole("heading", { name: "¿Quién entra?" }),
  ).toBeVisible();
  for (const person of RESTAURANT_B.staff)
    await expect(
      caja.page
        .locator(".roster .roster-person")
        .filter({ hasText: person.name }),
    ).toHaveCount(0);
  await allowing(
    [{ method: "POST", url: /\/api\/access\/pin$/, status: 401 }],
    async () => {
      const pin = await probe(caja, "POST", "/api/access/pin", {
        employeeId: karla,
        secret: "846350",
      });
      expect(pin.status).toBe(401);
      expect(["employee_unavailable", "invalid_pin"]).toContain(
        (pin.body as { error: string }).error,
      );
    },
  );
  expect(await karlaSessions()).toBe(before);

  // X1.4: a code is bound to the restaurant that issued it and is single use.
  run.step = "X1.4";
  {
    const op = ownerA.page;
    await op
      .getByRole("navigation", { name: "Operación" })
      .getByRole("button", { name: "Configuración" })
      .click();
    const devices = op.getByRole("region", { name: "Dispositivos" });
    await devices
      .getByRole("button", { name: "Vincular un dispositivo", exact: true })
      .click();
    const dialog = op.getByRole("dialog", { name: "Vincular un dispositivo" });
    await dialog.getByLabel(/^Nombre del dispositivo/).fill("Tableta temporal");
    await dialog
      .getByRole("button", { name: "Generar código", exact: true })
      .click();
    const code = (
      await dialog.locator(".pairing-code-value").innerText()
    ).trim();
    const fresh = await dev("probe");
    await fresh.page.goto("/app");
    await fresh.page.getByLabel("Código de vinculación").fill(code);
    await fresh.page
      .getByRole("button", { name: "Vincular", exact: true })
      .click();
    await expect(
      fresh.page
        .getByRole("status")
        .filter({ hasText: `Dispositivo vinculado a ${RESTAURANT_A.name}.` }),
    ).toBeVisible();
    const roster = fresh.page.locator(".roster .roster-person");
    for (const person of RESTAURANT_B.staff)
      await expect(roster.filter({ hasText: person.name })).toHaveCount(0);
    await expect(roster.filter({ hasText: "Marisol Vega" })).toHaveCount(1);
    const second = await dev("probe2");
    await second.page.goto("/app");
    await allowing(
      [{ method: "POST", url: /\/api\/access\/pair$/, status: 400 }],
      async () => {
        await second.page.getByLabel("Código de vinculación").fill(code);
        await second.page
          .getByRole("button", { name: "Vincular", exact: true })
          .click();
        await expect(
          second.page
            .getByRole("alert")
            .filter({
              hasText: "El código no es válido o ya venció. Pide uno nuevo.",
            }),
        ).toBeVisible();
      },
    );
    await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
    await devices
      .getByRole("button", {
        name: "Desvincular · Tableta temporal",
        exact: true,
      })
      .click();
    await op
      .getByRole("dialog", { name: "Desvincular" })
      .getByRole("button", { name: "Desvincular", exact: true })
      .click();
    await expect(op.getByRole("dialog", { name: "Desvincular" })).toHaveCount(
      0,
    );
  }

  // X1.5: both series start at 1.
  run.step = "X1.5";
  for (const [owner, folio] of [
    [ownerA, "A-000001"],
    [ownerB, "J-000001"],
  ] as const) {
    const r = await readApi<{ rows: Array<{ folio?: string }> }>(
      owner,
      `/api/fiscal/tickets?folio=${folio}`,
    );
    expect(r.body.rows).toHaveLength(1);
  }

  // X1.7: neither kitchen ever rendered the other restaurant's text.
  run.step = "X1.7";
  const seenA = [...run.seenKds.A].join("\n");
  const seenB = [...run.seenKds.B].join("\n");
  for (const s of [
    "Jacaranda",
    "Cumpleaños: vela en el flan",
    "ALERGIA: mariscos",
    "Los fuertes juntos",
    "Arrachera",
  ])
    expect(seenA, `A's kitchen showed "${s}"`).not.toContain(s);
  for (const s of [
    "Nopal Azul",
    "ALERGIA: cacahuate",
    "Bien dorados",
    "Taco al pastor",
  ])
    expect(seenB, `B's kitchen showed "${s}"`).not.toContain(s);
  expect(seenA.length).toBeGreaterThan(0);
  expect(seenB.length).toBeGreaterThan(0);
  await sql.end();
}
