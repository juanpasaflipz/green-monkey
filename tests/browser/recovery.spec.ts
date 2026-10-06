import { test, expect, request as playwrightRequest } from "@playwright/test";

async function login(page: any) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
}

test("manager reconciles offline cash and resolves kitchen and stock follow-ups", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !process.env.TEST_PRODUCTION,
    "Offline recovery requires the compiled same-origin server",
  );
  await login(page);
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  const open = page.getByRole("button", { name: "Abrir caja", exact: true });
  await expect(
    open.or(page.getByText("Caja abierta", { exact: true })),
  ).toBeVisible();
  if (await open.isVisible()) {
    await open.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Guardar", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  const { session, product } = await page.evaluate(async () => {
    const currentSession = await (await fetch("/api/session")).json();
    const catalog = await (await fetch("/api/catalog")).json();
    return {
      session: currentSession,
      product: catalog.find((item: any) => item.name.es === "Taco de hongos"),
    };
  });
  expect(product).toBeTruthy();
  const cookies = await context.cookies();
  let api = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: {
      cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
    },
  });
  let currentCsrf = session.csrf;
  let catalogChanged = false;
  try {
    await context.setOffline(true);
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Guardar cobro en este dispositivo",
        exact: true,
      })
      .click();
    await expect(page.locator(".receipt")).toContainText(
      "Pendiente de sincronizar",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cerrar", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const pending = await page.evaluate(
      () =>
        new Promise<any[]>((resolve, reject) => {
          const request = indexedDB.open("green-monkey-v1");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction(
              "pending",
              "readonly",
            );
            const all = transaction.objectStore("pending").getAll();
            all.onerror = () => reject(all.error);
            all.onsuccess = () => resolve(all.result);
          };
        }),
    );
    expect(
      pending.some(
        (row) =>
          row.status === "pending" && row.body.tenantId === session.tenantId,
      ),
      JSON.stringify(
        pending.map((row) => ({
          status: row.status,
          formatVersion: row.body?.formatVersion,
          tenantMatches: row.body?.tenantId === session.tenantId,
        })),
      ),
    ).toBe(true);
    const changed = await api.post("/api/catalog/save", {
      headers: { "x-csrf-token": session.csrf },
      data: {
        operationId: crypto.randomUUID(),
        id: product.id,
        name: product.name,
        category: product.category,
        price: product.price,
        available: false,
        station: product.station,
        expectedVersion: product.version,
        cost: product.cost,
        recipe: product.recipe,
      },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    catalogChanged = true;
    await context.setOffline(false);
    const cash = await (await api.get("/api/cash")).json();
    const closeReason = `Recovery history fixture ${crypto.randomUUID()}`;
    const closed = await api.post("/api/cash/close", {
      headers: { "x-csrf-token": session.csrf },
      data: {
        operationId: crypto.randomUUID(),
        counted: cash.expected,
        reason: closeReason,
      },
    });
    expect(closed.ok(), await closed.text()).toBe(true);
    await page.getByRole("button", { name: "Salir", exact: true }).click();
    await context.clearCookies();
    await login(page);
    const replacement = await page.evaluate(async () =>
      (await fetch("/api/session")).json(),
    );
    expect(replacement.tenantId).toBe(session.tenantId);
    expect(replacement.deviceId).not.toBe(session.deviceId);
    expect(replacement.id).not.toBe(session.id);
    currentCsrf = replacement.csrf;
    await api.dispose();
    const replacementCookies = await context.cookies();
    api = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: {
        cookie: replacementCookies
          .map(({ name, value }) => `${name}=${value}`)
          .join("; "),
      },
    });
    await page.getByRole("button", { name: /Conectado/ }).click();
    await expect(
      page.getByRole("button", { name: "Revisar efectivo", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Revisar efectivo", exact: true })
      .click();
    const reconciliation = page
      .locator("form.panel")
      .filter({ hasText: "Conciliar efectivo ya recibido" });
    const recoveryReason = `Efectivo y recibo físico verificados ${crypto.randomUUID()}`;
    await reconciliation
      .getByLabel("Motivo de conciliación")
      .fill(recoveryReason);
    await reconciliation.getByRole("checkbox").check();
    await reconciliation
      .getByRole("button", { name: "Registrar efectivo verificado" })
      .click();
    const recovery = page
      .locator("article.panel")
      .filter({ hasText: recoveryReason });
    await expect(recovery).toContainText("Cocina · pendiente");
    await expect(recovery).toContainText("Inventario · pendiente");
    for (const kind of ["Cocina", "Inventario"]) {
      await recovery
        .locator(".row", { hasText: `${kind} · pendiente` })
        .getByRole("button", { name: "Registrar revisión" })
        .click();
      const form = page.locator("form.panel").filter({
        hasText: kind === "Cocina" ? "Revisar cocina" : "Revisar inventario",
      });
      await form
        .getByLabel("Evidencia y motivo")
        .fill(`Verificado ${kind.toLowerCase()} contra la bitácora física`);
      await form.getByRole("button", { name: "Guardar revisión" }).click();
      await expect(recovery).toContainText(`${kind} · revisado`);
    }
    const report = await (await api.get("/api/report")).json();
    expect(report.unallocatedRecoveryCount).toBeGreaterThan(0);
    expect(report.costCoverage).toBeLessThan(1);
    await page.getByRole("button", { name: "Operación", exact: true }).click();
    await page.getByRole("button", { name: "Caja", exact: true }).click();
    await page.getByText("Historial de cajas", { exact: true }).click();
    const history = page
      .locator("article.panel")
      .filter({ hasText: closeReason });
    await expect(history).toContainText("Esperado al cerrar");
    await expect(history).toContainText("Recuperaciones posteriores");
    await history.getByRole("button", { name: "Ver movimientos" }).click();
    await expect(history).toContainText("Efectivo recuperado");
    await page.screenshot({ path: "docs/evidence/recovery-history-1440.png" });
    for (const [width, height] of [
      [1024, 768],
      [768, 1024],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const cases = await (await api.get("/api/sync/recoveries")).json();
    const recoveredCase = cases.find(
      (item: any) => item.reason === recoveryReason,
    );
    const recoveredOrder = await (
      await api.get(`/api/orders/${recoveredCase.order_id}`)
    ).json();
    expect(recoveredOrder.itemSplitAvailable).toBe(false);
    expect(recoveredOrder.paymentUnits).toEqual([]);
    await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Guardar", exact: true })
      .click();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const recoveredCard = page
      .locator(".order-summary")
      .filter({ hasText: new RegExp(`#${recoveredOrder.number} ·`) });
    await recoveredCard
      .getByRole("button", { name: "Reembolsar", exact: true })
      .click();
    // discounts (028): a recovery order has no item allocations, so the
    // dialog opens on "Por importe"; amount refunds have no stock
    // disposition, a reason is required and the result stays until "Listo".
    const refund = page.getByRole("dialog");
    await refund.getByLabel("Importe", { exact: true }).fill("1.00");
    await refund
      .getByLabel("Motivo del reembolso")
      .selectOption({ label: "Otro (explica en la nota)" });
    await refund
      .getByLabel("Explicación")
      .fill("Reembolso del efectivo recuperado verificado");
    await refund
      .getByRole("button", { name: "Reembolsar $1.00", exact: true })
      .click();
    await refund.getByRole("button", { name: "Listo", exact: true }).click();
    await expect(recoveredCard).toContainText("Reembolsado");
    const refunded = await (
      await api.get(`/api/orders/${recoveredOrder.id}`)
    ).json();
    expect(refunded.refunded).toBe(100);
    expect(refunded.tenders).toHaveLength(1);
  } finally {
    await context.setOffline(false).catch(() => {});
    if (catalogChanged) {
      const restored = await api.post("/api/catalog/save", {
        headers: { "x-csrf-token": currentCsrf },
        data: {
          operationId: crypto.randomUUID(),
          id: product.id,
          name: product.name,
          category: product.category,
          price: product.price,
          available: product.available,
          station: product.station,
          expectedVersion: product.version + 1,
          cost: product.cost,
          recipe: product.recipe,
        },
      });
      expect(restored.ok(), await restored.text()).toBe(true);
    }
    await api.dispose();
  }
});

test("backup restore is tenant-bound, atomic, repeatable and preserves original currency", async ({
  page,
}) => {
  await login(page);
  const session = await page.evaluate(async () =>
    (await fetch("/api/session")).json(),
  );
  await page.getByRole("button", { name: /Conectado/ }).click();
  const upload = page.getByLabel("Restaurar copia de pendientes");
  const makeSale = (currency: string, exponent: number) => {
    const id = crypto.randomUUID(),
      deviceId = crypto.randomUUID();
    return {
      id,
      scope: `${session.tenantId}:${deviceId}:${session.employeeId}`,
      body: {
        formatVersion: 2,
        operationId: id,
        order: {
          operationId: crypto.randomUUID(),
          lines: [
            {
              id: crypto.randomUUID(),
              productId: crypto.randomUUID(),
              quantity: 1,
              options: [],
              note: "",
            },
          ],
          mode: "takeaway",
          tableId: null,
          name: "Backup fixture",
          note: "",
          channel: "pos",
        },
        expectedTotal: 1234,
        received: 1234,
        tip: 0,
        recordedAt: new Date().toISOString(),
        sessionId: crypto.randomUUID(),
        cashSessionId: crypto.randomUUID(),
        tenantId: session.tenantId,
        employeeId: session.employeeId,
        deviceId,
        leaseVersion: 1,
        currency,
        currencyExponent: exponent,
        configurationVersion: 1,
      },
    };
  };
  const sales = [makeSale("JPY", 0), makeSale("KWD", 3)];
  const attempt = {
    formatVersion: 1,
    tenantId: session.tenantId,
    employeeId: session.employeeId,
    deviceId: sales[0].body.deviceId,
    sessionId: crypto.randomUUID(),
    cashSessionId: crypto.randomUUID(),
    orderId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    payload: {
      operationId: crypto.randomUUID(),
      amount: 100,
      tip: 0,
      received: 100,
      method: "cash",
      externalConfirmed: false,
      reference: "",
    },
  };
  const backup = {
    format: "green-monkey-recovery-v2",
    tenantId: session.tenantId,
    exportedAt: new Date().toISOString(),
    sales,
    paymentAttempts: [attempt],
  };
  const send = async (value: unknown) =>
    upload.setInputFiles({
      name: "recovery.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        typeof value === "string" ? value : JSON.stringify(value),
      ),
    });
  const records = () =>
    page.evaluate(
      () =>
        new Promise<any[]>((resolve, reject) => {
          const request = indexedDB.open("green-monkey-v1");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction("pending", "readonly"),
              all = tx.objectStore("pending").getAll();
            all.onsuccess = () => resolve(all.result);
            tx.oncomplete = () => db.close();
          };
        }),
    );
  await send("{broken");
  await expect(page.getByRole("alert")).toBeVisible();
  await send({ ...backup, tenantId: crypto.randomUUID() });
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await records()).toHaveLength(0);
  await send(backup);
  for (const sale of sales) {
    const panel = page
      .locator("article.panel")
      .filter({ hasText: sale.id.slice(0, 8) });
    await expect(panel).toBeVisible();
    const amount = new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: sale.body.currency,
    }).format(1234 / 10 ** sale.body.currencyExponent);
    await expect(panel.getByRole("heading")).toContainText(amount);
  }
  // Property ordering differs from both the original file and the normalized schema.
  await send({
    ...backup,
    sales: sales.map((sale) => ({
      ...sale,
      body: Object.fromEntries(Object.entries(sale.body).reverse()),
    })),
  });
  await expect(page.getByRole("alert")).not.toBeVisible();
  expect(await records()).toHaveLength(2);
  const newSale = makeSale("MXN", 2);
  await send({
    ...backup,
    sales: [
      newSale,
      { ...sales[0], body: { ...sales[0].body, expectedTotal: 1233 } },
    ],
  });
  await expect(page.getByRole("alert")).toBeVisible();
  const retained = await records();
  expect(retained).toHaveLength(2);
  expect(
    retained.find((row) => row.id === sales[0].id).body.expectedTotal,
  ).toBe(1234);
  expect(retained.some((row) => row.id === newSale.id)).toBe(false);
  await send({
    ...backup,
    sales: [newSale],
    paymentAttempts: [
      { ...attempt, payload: { ...attempt.payload, amount: 99 } },
    ],
  });
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await records()).toHaveLength(2);
  await expect(
    page.getByRole("heading", { name: /Pago por confirmar/ }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Descargar pendientes", exact: true })
    .click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  // Backup v3 (offline spec §2.7): records of every format, attempts by key.
  expect(exported.format).toBe("green-monkey-recovery-v3");
  expect(exported.paymentAttempts).toEqual([
    {
      key: `${attempt.tenantId}:${attempt.deviceId}:${attempt.employeeId}:payment`,
      attempt,
    },
  ]);
  expect(exported.records).toHaveLength(2);
  await expect(
    page.getByText(/ventas no sincronizadas no se pueden recuperar/),
  ).toBeVisible();
  // Replacement-device records remain visible to a manager after a fresh page load.
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: /Conectado/ }).click();
  await expect(
    page.locator("article.panel").filter({ hasText: sales[0].id.slice(0, 8) }),
  ).toBeVisible();
});

async function seedQueue(page: any) {
  return page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const id = crypto.randomUUID();
    const row = {
      id,
      scope: `${s.tenantId}:${s.deviceId}:${s.employeeId}`,
      status: "pending",
      attempts: 0,
      nextAt: 0,
      body: {
        operationId: id,
        order: {
          operationId: crypto.randomUUID(),
          lines: [
            {
              id: crypto.randomUUID(),
              productId: crypto.randomUUID(),
              quantity: 1,
              options: [],
              note: "",
            },
          ],
          mode: "takeaway",
          tableId: null,
          name: "Transport fixture",
          note: "",
          channel: "pos",
        },
        expectedTotal: 100,
        received: 100,
        tip: 0,
        recordedAt: new Date().toISOString(),
        sessionId: s.id,
        cashSessionId: crypto.randomUUID(),
      },
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("green-monkey-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("pending", "readwrite");
        tx.objectStore("pending").put(row);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    return id;
  });
}

async function queuedRow(page: any, id: string) {
  return page.evaluate(
    (key: string) =>
      new Promise<any>((resolve, reject) => {
        const request = indexedDB.open("green-monkey-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("pending", "readonly"),
            row = tx.objectStore("pending").get(key);
          row.onsuccess = () => resolve(row.result);
          tx.oncomplete = () => db.close();
        };
      }),
    id,
  );
}

test("two tabs serialize sync and recover an interrupted lock holder", async ({
  page,
  context,
}) => {
  await login(page);
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route("**/api/offline/sync", async (route) => {
    calls++;
    if (calls === 1) {
      await blocked;
      await route.abort().catch(() => {});
    } else
      await route.fulfill({ json: { id: "mock-committed-result", paid: 100 } });
  });
  const id = await seedQueue(page);
  await page.reload();
  await expect.poll(() => calls).toBe(1);
  const second = await context.newPage();
  await second.goto("/app");
  await expect(
    second.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  expect(calls).toBe(1);
  await page.close();
  release();
  await second.reload();
  await expect
    .poll(async () => (await queuedRow(second, id))?.status)
    .toBe("synced");
  expect(calls).toBe(2);
  expect((await queuedRow(second, id)).result.paid).toBe(100);
});

test("selling retains an old-session payment for review without charging the current drawer", async ({
  page,
}) => {
  await login(page);
  let directPayments = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/orders\/[^/]+\/payments$/.test(request.url())
    )
      directPayments++;
  });
  const evidence = await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const products = await (await fetch("/api/catalog")).json();
    const p = products.find((p: any) => p.available && !p.groups.length);
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        lines: [
          {
            id: crypto.randomUUID(),
            productId: p.id,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
        tableId: null,
        name: "Old session recovery fixture",
        note: "",
        channel: "pos",
      }),
    });
    if (!response.ok) throw Error("Fixture order failed");
    const order = await response.json();
    const key = `${s.tenantId}:${s.deviceId}:${s.employeeId}:payment`;
    const attempt = {
      formatVersion: 1,
      tenantId: s.tenantId,
      employeeId: s.employeeId,
      deviceId: s.deviceId,
      sessionId: crypto.randomUUID(),
      cashSessionId: crypto.randomUUID(),
      orderId: order.id,
      createdAt: new Date().toISOString(),
      payload: {
        operationId: crypto.randomUUID(),
        amount: order.total,
        tip: 0,
        received: order.total,
        method: "cash",
        externalConfirmed: false,
        reference: "",
      },
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("green-monkey-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("cache", "readwrite");
        tx.objectStore("cache").put({ id: key, value: attempt });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    return { orderId: order.id, key };
  });
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("no cobres otra vez");
  expect(directPayments).toBe(0);
  const order = await page.evaluate(
    async (id) => (await fetch(`/api/orders/${id}`)).json(),
    evidence.orderId,
  );
  expect(order.paid).toBe(0);
  await page.getByRole("button", { name: /Conectado/ }).click();
  await expect(
    page.getByRole("heading", { name: /Pago por confirmar/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Consultar estado", exact: true })
    .click();
  await expect(
    page.getByText(/Requiere revisión; no cobres otra vez/),
  ).toBeVisible();
});
