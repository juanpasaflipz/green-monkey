/**
 * A13 (specs/acceptance.md §6.10): a ten-minute internet outage with Wi-Fi up
 * (the edge answers HTML 502, then requests fail), four offline sales on a
 * tablet whose clock runs 3 minutes fast, a lost sync response, exactly-once
 * sync and the kitchen's offline review lane.
 */
import { expect, type Locator, type Route } from "@playwright/test";
import { mxn } from "./oracle.js";
import { RESTAURANT_A } from "./scenario.js";
import {
  FIGURES,
  addLine,
  assertCart,
  details,
  kdsChecks,
  kdsLines,
  progressTicket,
  squash,
  type Restaurant,
} from "./selling.js";
import {
  idleOracle,
  orderA,
  orderCard,
  staffA,
  toOrders,
  toSell,
  toCash,
  setIdleLock,
} from "./service-a.js";
import {
  advance,
  checkpoint,
  fill,
  nextPrint,
  press,
  prints,
  readApi,
  run,
  tap,
  typePin,
  type Device,
  type Devices,
} from "./ui.js";
import type { RunState } from "./env.js";

const r: Restaurant = RESTAURANT_A;
const EDGE_502 = "<html><body>Application failed to respond</body></html>";

/** The connection pill in the top bar. */
export const pill = (d: Device) =>
  d.page.locator(".top-actions button.connection");

/** runFor on a device clock; the app's idle time grows by the same amount (§3.5.5). */
async function runFor(d: Device, ms: number) {
  await advance(d, ms);
}

/** Real time passing, for every device at once (the test process's own timer). */
async function realWait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-syncs a device clock to real time plus its skew (§3.5.3). */
async function resync(d: Device) {
  await d.context.clock.setSystemTime(Date.now() + d.skew);
}

/** A13.1: the edge proxy answers for a dead upstream. */
async function edge502(d: Device) {
  d.outage = true;
  await d.context.route("**/api/**", (route: Route) => {
    d.injected.add(route.request());
    return route.fulfill({
      status: 502,
      contentType: "text/html",
      body: EDGE_502,
    });
  });
}
/** A13.3: then nothing answers at all. */
async function disconnected(d: Device) {
  await d.context.unrouteAll({ behavior: "ignoreErrors" });
  await d.context.route("**/api/**", (route: Route) => {
    d.injected.add(route.request());
    return route.abort("internetdisconnected");
  });
}
async function reconnect(d: Device) {
  await d.context.unrouteAll({ behavior: "ignoreErrors" });
  d.outage = false;
}

/** An offline sale (A19–A22): returns its provisional number. */
async function offlineSale(
  caja: Device,
  id: string,
  n: number,
  state: RunState,
) {
  const page = caja.page;
  const o = orderA(id);
  await toSell(caja);
  for (const [i, line] of o.lines.entries()) await addLine(caja, r, line, i);
  await details(caja, o.callName);
  const f = FIGURES[id]!;
  await assertCart(caja, r, o.lines, f.total);
  await expect(
    page.getByRole("button", { name: "Enviar (sin conexión)", exact: true }),
  ).toBeVisible();
  await tap(caja, page.getByRole("button", { name: "Cobrar", exact: true }));
  const dialog = page.getByRole("dialog", { name: /^Cobrar/ });
  await expect(
    dialog.getByRole("button", { name: /dividir por productos/i }),
  ).toBeDisabled();
  const p = o.payment!;
  if (p.tip)
    await fill(
      caja,
      dialog.getByLabel("Propina", { exact: true }),
      String(p.tip / 100),
    );
  let save: Locator;
  if (p.method === "cash") {
    await expect(
      dialog.getByText(
        "Sin conexión: el cobro se guarda en este dispositivo. Cocina no recibe la orden por la red; imprime o canta la comanda.",
        { exact: true },
      ),
    ).toBeVisible();
    if (p.bill) {
      await tap(
        caja,
        dialog
          .getByRole("group", { name: "Efectivo recibido rápido" })
          .getByRole("button", { name: new RegExp(`^\\$${p.bill}(\\.00)?$`) }),
      );
      await expect(
        dialog.locator(".row.between", { hasText: "Cambio" }).locator("strong"),
      ).toHaveText(mxn(p.bill * 100 - f.total - (p.tip ?? 0)));
    }
    save = dialog.getByRole("button", {
      name: "Guardar cobro en este dispositivo",
    });
  } else {
    const terminal = dialog
      .getByRole("group", { name: "Método de pago" })
      .getByRole("button", { name: "Tarjeta", exact: true });
    await expect(terminal).toBeEnabled();
    await tap(caja, terminal);
    await expect(
      dialog.getByText(
        "Confirma que la terminal aprobó el cobro y escribe su referencia. No se verifica con el banco.",
        { exact: true },
      ),
    ).toBeVisible();
    await fill(
      caja,
      dialog.getByLabel("Referencia de aprobación", { exact: true }),
      p.ref!,
    );
    await tap(
      caja,
      dialog.getByRole("checkbox", {
        name: "Confirmo que la terminal aprobó este pago",
      }),
    );
    save = dialog.getByRole("button", { name: "Guardar cobro con terminal" });
  }
  const before = (await prints(page)).length;
  await tap(caja, save);
  state.realSoldAt[id] = Date.now();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Número provisional");
  const label = (await receipt.innerText()).match(
    /Número provisional ([A-Z][A-Z0-9]?-\d{2})/,
  )?.[1];
  expect(label, `${id}: provisional number`).toMatch(/^[A-Y][1-9]?-\d{2}$/);
  const [pfx, seq] = label!.split("-");
  state.offlinePrefix ??= pfx;
  expect(pfx).toBe(state.offlinePrefix);
  expect(seq).toBe(String(n).padStart(2, "0"));
  await expect(receipt).toContainText(
    "El número definitivo se asigna al sincronizar.",
  );
  await expect(receipt).toContainText(
    "Folio pendiente: se asigna al sincronizar.",
  );
  expect((await receipt.innerText()).toLowerCase()).not.toContain(
    "folio fiscal",
  );
  // "Al guardar sin conexión" = "Imprimir comanda": the comanda prints right after the save.
  const comanda = squash((await nextPrint(page, before, `comanda-${id}`)).text);
  for (const s of [
    "COMANDA · SIN CONEXIÓN",
    "Cocina",
    label!,
    "Número provisional. Se sincroniza al volver la conexión.",
  ])
    expect(comanda, `${id} comanda: ${s}`).toContain(squash(s));
  for (const l of kdsLines(r, o.lines).filter((x) => x.station === "Cocina")) {
    expect(comanda).toContain(squash(`${l.qty} × ${l.name}`));
    for (const opt of l.options) expect(comanda).toContain(squash(opt));
    if (l.note) expect(comanda).toContain(squash(l.note));
  }
  await tap(
    caja,
    page.getByRole("button", { name: "Siguiente venta", exact: true }),
  );
  await expect(receipt).toHaveCount(0);
  return label!;
}

export async function serviceA3(dev: Devices, state: RunState) {
  const caja = await dev("cajaA");
  const cocina = await dev("cocinaA");
  const page = caja.page;
  const diego = staffA("diego");
  const hugo = staffA("hugo");
  // Precondition: online, queue empty, offline saves print the comanda.
  run.step = "A13.0";
  await idleOracle(caja, diego);
  await expect(pill(caja)).toHaveAccessibleName("Conectado");
  await press(caja, pill(caja));
  await page
    .getByLabel(/^Al guardar sin conexión/)
    .selectOption({ label: "Imprimir comanda" });
  await toSell(caja);

  // A13.1 / A13.2: HTML 502 from the edge, navigator.onLine stays true.
  run.step = "A13.1";
  await edge502(caja);
  await edge502(cocina);
  run.step = "A13.2";
  // These 65 s pass in real time, not with runFor: the app's corrected clock
  // follows the monotonic clock from its last contact with the server (OFF-R24),
  // and a fake-clock jump would leave it ahead of the server for good. The four
  // sales right after must carry their true instants (D7: recorded_at = the
  // device clock minus its 3 minutes, sold_at within 10 s of the real sale).
  await realWait(30_000);
  await press(caja, page.getByRole("textbox", { name: "Buscar producto…" }));
  await realWait(35_000);
  const tResync = Date.now();
  for (const d of [caja, cocina])
    await expect(pill(d)).toHaveAccessibleName(/^Sin conexión/, {
      timeout: 15_000,
    });
  const banner = page.locator(".connection-banner");
  await expect(banner).toContainText(
    "Sin conexión con el servidor. Las ventas se guardan en este dispositivo y se envían al volver la conexión.",
  );
  const until = (await banner.innerText()).match(
    /Puedes vender sin conexión hasta las (\d{1,2}):(\d{2})\./,
  );
  expect(until, "A13.2 window line").not.toBeNull();
  const nowMx = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }),
  );
  const minutesNow = nowMx.getHours() * 60 + nowMx.getMinutes();
  const minutesUntil =
    (Number(until![1]) * 60 + Number(until![2]) - minutesNow + 1440) % 1440;
  expect(
    minutesUntil,
    "OFF-3: the offline window renews to at least 3 h 30 min",
  ).toBeGreaterThanOrEqual(210);
  await expect(cocina.page.locator(".connection-banner")).toContainText(
    "Sin conexión: esta pantalla no recibe pedidos nuevos. Pide las comandas impresas o en voz al mostrador.",
  );
  for (const d of [caja, cocina])
    await expect(
      d.page
        .getByRole("alert")
        .filter({ hasText: "No se pudo completar la acción." }),
    ).toHaveCount(0);

  // A13.3: the requests stop being answered at all.
  run.step = "A13.3";
  await disconnected(caja);
  await disconnected(cocina);

  // A13.4–A13.7: four offline sales.
  const labels: Record<string, string> = {};
  let n = 0;
  for (const id of ["A19", "A20", "A21", "A22"]) {
    run.step = `A13.${4 + n}`;
    labels[id] = await offlineSale(caja, id, ++n, state);
  }

  // A13.8: online-only actions are disabled with a reason, and nothing is sent.
  run.step = "A13.8";
  const attempts: string[] = [];
  const watch = (req: import("@playwright/test").Request) => {
    if (
      req.method() === "POST" &&
      /\/(discounts|refunds|voids|cash\/close)\b/.test(req.url())
    )
      attempts.push(req.url());
  };
  page.on("request", watch);
  await addLine(caja, r, orderA("A24").lines[1]!, 0);
  const discount = page
    .locator("aside.cart")
    .getByRole("button", { name: "Descuento", exact: true });
  await expect(discount).toBeDisabled();
  await expect(
    page
      .locator("aside.cart")
      .getByText("Los descuentos requieren conexión.", { exact: true }),
  ).toBeVisible();
  await press(
    caja,
    page
      .locator("aside.cart")
      .getByRole("button", {
        name: "Cantidad − Tortillas de maíz 1 kg",
        exact: true,
      }),
  );
  await toCash(caja);
  await expect(
    page.getByRole("button", { name: "Cerrar caja", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Cerrar caja y registrar retiros requieren conexión.", {
      exact: true,
    }),
  ).toBeVisible();
  // A cashier under blind close never sees "Corte X" (expected cash is hidden; reports 029).
  await expect(
    page.getByRole("button", { name: "Corte X", exact: true }),
  ).toHaveCount(0);
  // Built: Órdenes reads its list from the server, so offline it offers no check
  // at all, and with it no "Reembolsar" or "Anular" (spec: disabled with a reason).
  await press(
    caja,
    page
      .getByRole("navigation", { name: "Operación" })
      .getByRole("button", { name: "Órdenes", exact: true }),
  );
  await expect(page.locator(".orders-view")).toBeVisible();
  await expect(
    page
      .locator(".orders-view button:enabled")
      .filter({ hasText: /^(Reembolsar|Anular|Descuento)$/ }),
  ).toHaveCount(0);
  page.off("request", watch);
  expect(attempts, "A13.8: no online-only command leaves the device").toEqual(
    [],
  );

  // A13.9: the device list, the pill and the Sync view.
  run.step = "A13.9";
  await toSell(caja);
  await expect(pill(caja)).toHaveAccessibleName(
    "Sin conexión · 4 por sincronizar",
  );
  await expect(pill(caja).locator(".connection-count")).toBeVisible();
  await press(
    caja,
    banner.getByRole("button", { name: "Comandas (4)", exact: true }),
  );
  const list = page.getByRole("dialog", { name: "Comandas sin conexión" });
  // One comanda per station: A22's drink prints for the bar.
  await expect(list.locator("article.offline-ticket")).toHaveCount(5);
  await expect(
    list.locator("article.offline-ticket").filter({ hasText: "Pendiente" }),
  ).toHaveCount(5);
  for (const label of Object.values(labels))
    await expect(list).toContainText(label);
  await expect(
    list.getByRole("button", { name: "Reimprimir", exact: true }).first(),
  ).toBeVisible();
  await press(caja, list.getByRole("button", { name: "Cerrar", exact: true }));
  await press(caja, pill(caja));
  const rows = page
    .locator("article.panel")
    .filter({ has: page.locator("h3", { hasText: /^Venta · / }) });
  await expect(rows).toHaveCount(4);
  for (const id of ["A19", "A20", "A21", "A22"]) {
    const row = rows.filter({ hasText: labels[id]! });
    await expect(row.locator("h3")).toContainText(`Venta · ${labels[id]} · `);
    await expect(row.locator("h3")).toContainText(mxn(FIGURES[id]!.total));
    await expect(row.locator(".offline-row-status")).toHaveText("Pendiente");
  }
  await expect(
    page
      .getByText(
        "La hora de este dispositivo difiere 3 min de la del servidor. Activa la hora automática.",
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Requiere revisión")).toHaveCount(0);
  await checkpoint(caja, "A13-offline");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pill(caja).locator(".connection-count")).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  await toSell(caja);

  // A13.10: the rest of the ten minutes, compressed; the idle lock's offline branch.
  run.step = "A13.10";
  const lock = page.locator("dialog.lock-screen");
  let simulated = 65_000 + (Date.now() - tResync);
  let lockSeen = false;
  while (simulated < 600_000) {
    await runFor(caja, 60_000);
    await runFor(cocina, 60_000);
    simulated += 60_000;
    await expect(pill(caja)).toHaveAccessibleName(
      "Sin conexión · 4 por sincronizar",
    );
    await expect(page.getByText("Requiere revisión")).toHaveCount(0);
    await expect(banner).toBeVisible();
    if (!lockSeen) {
      await expect(
        lock.getByRole("heading", { name: "Pantalla bloqueada" }),
      ).toBeVisible();
      await expect(lock.getByRole("status")).toHaveText(
        `Sin conexión no se puede verificar el PIN. Las ventas se registran a nombre de ${diego.name}.`,
      );
      await expect(
        lock.getByRole("button", {
          name: `Continuar como ${diego.name}`,
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        lock.getByRole("button", { name: "Cambiar de usuario", exact: true }),
      ).toBeDisabled();
      await expect(
        lock.getByText("Cambiar de usuario requiere conexión.", {
          exact: true,
        }),
      ).toBeVisible();
      await checkpoint(caja, "A13-lock-offline", { settle: lock });
      lockSeen = true;
    }
  }
  await press(
    caja,
    lock.getByRole("button", {
      name: `Continuar como ${diego.name}`,
      exact: true,
    }),
  );
  await expect(lock).toHaveCount(0);

  // A13.11: reconnect; the first sync's response is lost after the server commits.
  run.step = "A13.11";
  await resync(caja);
  await resync(cocina);
  await reconnect(caja);
  await reconnect(cocina);
  let lost = false;
  await caja.context.route("**/api/offline/sync", async (route) => {
    if (route.request().method() !== "POST" || lost) return route.fallback();
    lost = true;
    caja.injected.add(route.request());
    caja.outage = true;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await runFor(caja, 35_000);
  await runFor(cocina, 35_000);
  await resync(caja);
  await resync(cocina);

  // A13.12: synced exactly once, even after a forced retry.
  run.step = "A13.12";
  await expect(pill(caja)).toHaveAccessibleName("Conectado", {
    timeout: 30_000,
  });
  caja.outage = false;
  expect(lost, "A13.11: the first sync response was lost").toBe(true);
  // Built (ACC-18): "Continuar como" is a soft unlock; when the server answers
  // again the lock comes back and asks for Diego's PIN.
  await expect(
    lock.getByRole("heading", { name: "Pantalla bloqueada" }),
  ).toBeVisible();
  await typePin(caja, lock, diego.name, diego.pin);
  await expect(lock).toHaveCount(0);
  run.lastAuthAt[`${diego.name}@${caja.name}`] = Date.now();
  await press(caja, pill(caja));
  const numbers: Record<string, number> = {
    A19: 19,
    A20: 20,
    A21: 21,
    A22: 22,
  };
  for (const id of Object.keys(numbers)) {
    const row = rows.filter({ hasText: labels[id]! });
    await expect(row).toContainText("Registrado en el servidor", {
      timeout: 30_000,
    });
    await expect(row).toContainText(`${labels[id]} → #${numbers[id]}`);
  }
  await press(
    caja,
    page.getByRole("button", {
      name: "Reintentar sincronización",
      exact: true,
    }),
  );
  await expect(rows).toHaveCount(4);
  await toOrders(caja);
  await press(
    caja,
    page.getByRole("button", { name: "Hoy y abiertas", exact: true }),
  );
  for (const nr of Object.values(numbers)) {
    await expect(orderCard(page, nr)).toHaveCount(1);
    await expect(orderCard(page, nr).locator(".eyebrow")).toContainText(
      "Venta sin conexión",
    );
  }
  await caja.context.unrouteAll({ behavior: "ignoreErrors" });

  // A13.13: the kitchen reviews the offline sales before any reaches the live display.
  run.step = "A13.13";
  const k = cocina.page;
  const lane = k
    .locator("section")
    .filter({ has: k.locator("#offline-review-title") });
  // One card per station round: A22's drink is a second (bar) card, so 4 sales make 5 cards.
  const stationRounds = ["A19", "A20", "A21", "A22"].reduce(
    (n, id) =>
      n + new Set(kdsLines(r, orderA(id).lines).map((l) => l.station)).size,
    0,
  );
  // The lane polls every 30 s while empty; the A13.11 re-sync moved the kitchen
  // clock back by the compressed 35 s, so its next poll can be up to 65 s away.
  await expect(lane.locator("#offline-review-title")).toHaveText(
    `Ventas sin conexión por revisar (${stationRounds})`,
    {
      timeout: 90_000,
    },
  );
  await expect(lane.locator("article.offline-review-card")).toHaveCount(
    stationRounds,
  );
  await expect(lane).toContainText(
    "Se vendieron sin conexión. Confirma si cocina ya las preparó para no repetirlas.",
  );
  const cards = lane.locator("article.offline-review-card");
  for (const id of Object.keys(numbers)) {
    const card = cards
      .filter({ hasText: `${labels[id]} → #${numbers[id]}` })
      .first();
    await expect(card).toContainText("Comanda impresa en caja");
    const sold = (await card.innerText()).match(
      /Vendida (\d{2}):(\d{2}) · sincronizada \d{2}:\d{2}/,
    );
    expect(sold, `${id}: sold and synced times`).not.toBeNull();
    const realMx = new Date(
      new Date(state.realSoldAt[id]!).toLocaleString("en-US", {
        timeZone: "America/Mexico_City",
      }),
    );
    const shown = Number(sold![1]) * 60 + Number(sold![2]);
    const real = realMx.getHours() * 60 + realMx.getMinutes();
    expect(
      Math.abs(((shown - real + 1440 + 720) % 1440) - 720),
      `${id}: OFF-8 sold time is the server-corrected time`,
    ).toBeLessThanOrEqual(1);
  }
  for (const nr of Object.values(numbers))
    await expect(
      k
        .locator("article.kitchen-ticket")
        .filter({
          has: k.locator("h2", { hasText: new RegExp(`^#${nr}(\\s|$)`) }),
        }),
    ).toHaveCount(0);
  await checkpoint(cocina, "A13-review", { settle: lane });
  for (const id of ["A19", "A20", "A22"])
    for (const card of await cards
      .filter({ hasText: `${labels[id]} → #${numbers[id]}` })
      .all())
      await press(
        cocina,
        card.getByRole("button", { name: "Ya se preparó", exact: true }),
      );
  await press(
    cocina,
    cards
      .filter({ hasText: `${labels.A21} → #21` })
      .getByRole("button", { name: "Preparar ahora", exact: true }),
  );
  await expect(cards).toHaveCount(0, { timeout: 15_000 });
  const a21 = orderA("A21");
  const tickets = await kdsChecks(cocina, {
    number: 21,
    callName: a21.callName,
    lines: kdsLines(r, a21.lines),
    tenant: "A",
  });
  // "Preparar ahora" is the kitchen's acknowledgement: the ticket arrives as "Cocina recibió".
  for (const t of Object.values(tickets)) {
    await expect(t).toContainText("Cocina recibió");
    await expect(t.locator(".ticket-badges")).toContainText(
      "Venta sin conexión",
    );
    await progressTicket(cocina, t, "seen");
  }

  // A13.14: the reprint carries the folio assigned at sync.
  run.step = "A13.14";
  await idleOracle(caja, diego);
  await toOrders(caja);
  await press(
    caja,
    orderCard(page, 19).getByRole("button", { name: "Detalle", exact: true }),
  );
  const detail = page.getByRole("dialog", { name: "Orden #19" });
  const before = (await prints(page)).length;
  await press(
    caja,
    detail.getByRole("button", { name: "Reimprimir recibo", exact: true }),
  );
  const reprint = squash((await nextPrint(page, before, "reprint-A19")).text);
  expect(reprint).toContain("REIMPRESIÓN");
  expect(reprint).toContain(squash(`Folio: ${FIGURES.A19!.folio}`));
  await press(
    caja,
    detail.getByRole("button", { name: "Cerrar", exact: true }),
  );
  void hugo;
  void readApi;
  setIdleLock(true);
}
