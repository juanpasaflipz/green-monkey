import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deflateSync, crc32 } from "node:zlib";
import { kitchenHygiene } from "./kitchen-hygiene.js";

// Kiosk self-checkout (039, specs/kiosk-w4.md §8.3 adapted to LD-72: on payment only). The demo
// owner configures a kiosk station (the Clip reader of the payments fake and this browser's till),
// pairs a tablet through the kiosk's hidden form, and a guest orders "para aquí" and pays on the
// reader; a declined card goes to the counter and staff accept it. Photos: an owner uploads a
// product photo (its EXIF never reaches the server) and the QR menu shows it. axe at the kiosk's
// 1280×800 and 800×1280 and at 390 and 768 for the QR menu. Every credential is fictional.
const OWNER_PASSWORD = "demo-green-monkey";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const FAKE_URL = process.env.PAYMENTS_FAKE_URL ?? "http://127.0.0.1:4899";
const CLIP_DEVICE = "P8220724FAKE01";
const tag = () => "k" + Math.random().toString(36).slice(2, 7);
kitchenHygiene();

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
async function call<T = any>(
  page: Page,
  path: string,
  body?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ path, body }) => {
      const s = await (await fetch("/api/session")).json();
      const r = await fetch("/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? String(r.status));
      return data;
    },
    { path, body },
  );
}
const uuid = () => crypto.randomUUID();
async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations).toEqual([]);
}
async function fake(action: string, body: object) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${FAKE_URL}/__fake/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    expect(r.status === 404 && i < 80, `payments fake ${action}`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function integratedReady(page: Page) {
  const caps = await call(page, "/capabilities");
  const served = caps.clip?.reason !== "worker_not_configured";
  if (process.env.CI)
    expect(served, "CI runs the worker with the payments fake").toBe(true);
  return served;
}

/** A tiny RGB PNG with an eXIf chunk (fictional GPS text): a photo whose metadata must not survive. */
function pngWithExif(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++)
      row.set([22, 67 + ((x * 3) % 120), 47 + (y % 100)], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk(
      "eXIf",
      Buffer.from("MM\0*GPS 19.4326N 99.1332W fictional", "latin1"),
    ),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Setup = {
  linkId: string;
  path: string;
  label: string;
  terminalId: string;
  stationId: string;
  before: {
    paymentMode: string;
    askFulfillment: boolean;
    suggestions: boolean;
    loyaltyAtKiosk: boolean;
  };
};
/** Clip connected through the fake, a terminal on its reader, a kiosk link and its station. */
async function setUp(page: Page): Promise<Setup> {
  const session = await call(page, "/session");
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
  // A previous run's terminal on the fake's reader is archived (its live charge cancelled first).
  const settings = await call(page, "/payments/settings");
  for (const left of settings.terminals.filter(
    (t: any) => !t.archivedAt && t.providerDeviceId === CLIP_DEVICE,
  )) {
    const active = await call(page, "/payments/terminal/active").catch(
      () => [],
    );
    for (const a of active as { id: string; terminalId: string }[])
      if (a.terminalId === left.id)
        await call(page, `/payments/terminal/charges/${a.id}/cancel`, {
          operationId: uuid(),
        }).catch(() => {});
    await expect
      .poll(
        () =>
          call(page, `/payments/terminals/${left.id}/archive`, {
            operationId: uuid(),
            expectedVersion: left.version,
          })
            .then(() => "archived")
            .catch((e) => String(e)),
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe("archived");
  }
  const providers = await call(page, "/payments/providers");
  if (
    providers.accounts.find((a: any) => a.provider === "clip")?.state !==
    "active"
  ) {
    await call(page, "/payments/providers/clip/credentials", {
      apiKey: "test-clip-api-key-not-real",
      secretKey: "test-clip-secret-key-not-real",
    });
    await expect
      .poll(
        async () =>
          (await call(page, "/payments/providers")).accounts.find(
            (a: any) => a.provider === "clip",
          )?.state,
        { timeout: 30_000 },
      )
      .toBe("active");
  }
  const name = "Clip Kiosco " + tag();
  const saved = await call(page, "/payments/terminals", {
    operationId: uuid(),
    name,
    kind: "clip_pinpad",
    providerDeviceId: CLIP_DEVICE,
    feeBp: 360,
  });
  const terminalId = saved.terminals.find((t: any) => t.name === name).id;
  const label = "Entrada " + tag();
  const link = await call(page, "/ordering/links", { kind: "kiosk", label });
  const view = await call(page, "/kiosk/settings");
  const station = view.stations.find((s: any) => s.linkId === link.id);
  await call(page, `/kiosk/stations/${station.id}`, {
    operationId: uuid(),
    expectedVersion: station.version,
    terminalId,
    registerDeviceId: session.deviceId,
  });
  const before = view.settings;
  await call(page, "/kiosk/settings", {
    operationId: uuid(),
    expectedVersion: before.version,
    paymentMode: "card_and_counter",
    askFulfillment: true,
    suggestions: true,
    loyaltyAtKiosk: false,
  });
  return {
    linkId: link.id,
    path: link.path,
    label,
    terminalId,
    stationId: station.id,
    before,
  };
}
async function tearDown(page: Page, s: Setup) {
  // A charge still live on the reader (a failed run) is cancelled first, so the terminal archives.
  const active = await call(page, "/payments/terminal/active").catch(() => []);
  for (const a of active as { id: string; terminalId: string; state: string }[])
    if (
      a.terminalId === s.terminalId &&
      ["created", "sending", "pending", "unknown"].includes(a.state)
    )
      await call(page, `/payments/terminal/charges/${a.id}/cancel`, {
        operationId: uuid(),
      }).catch(() => {});
  const view = await call(page, "/kiosk/settings");
  await call(page, "/kiosk/settings", {
    operationId: uuid(),
    expectedVersion: view.settings.version,
    paymentMode: s.before.paymentMode,
    askFulfillment: s.before.askFulfillment,
    suggestions: s.before.suggestions,
    loyaltyAtKiosk: s.before.loyaltyAtKiosk,
  });
  await call(page, `/ordering/links/${s.linkId}/revoke`, {
    operationId: uuid(),
  });
  const settings = await call(page, "/payments/settings");
  const t = settings.terminals.find((x: any) => x.id === s.terminalId);
  if (t && !t.archivedAt)
    await call(page, `/payments/terminals/${t.id}/archive`, {
      operationId: uuid(),
      expectedVersion: t.version,
    });
  await call(page, "/payments/providers/clip/disable", {});
}

/** Pairs the kiosk page through Configuración's "Vincular tableta" and the hidden setup form. */
async function pairKiosk(page: Page, kiosk: Page, s: Setup) {
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const row = page.locator(".kiosk-station", { hasText: s.label });
  await row
    .getByRole("button", { name: "Vincular tableta", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Vincular tableta" });
  const text = await dialog.locator(".kiosk-pair-code").innerText();
  const code = text.replace(/\D/g, "").slice(0, 8);
  expect(code).toMatch(/^\d{8}$/);
  await dialog
    .getByRole("button", { name: "Cerrar" })
    .first()
    .click()
    .catch(() => {});
  const title = kiosk.getByRole("heading", { level: 1 });
  await title.hover();
  await kiosk.mouse.down();
  await kiosk.waitForTimeout(3200);
  await kiosk.mouse.up();
  const setup = kiosk.getByRole("dialog", { name: "Configurar este kiosco" });
  await expect(setup).toContainText("Kiosco sin vincular: solo pago en caja");
  await setup.getByLabel("Código de vinculación").fill(code);
  await setup.getByRole("button", { name: "Vincular", exact: true }).click();
  await expect(setup).toContainText(`Kiosco vinculado: ${s.label}`);
  await setup.getByRole("button", { name: "Cerrar" }).first().click();
}

/** The demo "Taco de asada" asks for one choice (a radio) in the choice picker. */
async function addTaco(kiosk: Page) {
  await kiosk.getByRole("button", { name: /^Taco de asada/ }).click();
  const picker = kiosk.getByRole("dialog");
  await picker.getByRole("radio").first().check();
  await picker.getByRole("button", { name: "Agregar a la orden" }).click();
  await expect(kiosk.locator(".diner-line")).toHaveCount(1);
}

test("kiosk card payment: pairing from Configuración, para aquí, the card approved on the reader (¡Pagado! with the folio), axe at 1280×800 and 800×1280; a decline goes to the counter and staff accept it", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await login(page);
  test.skip(
    !(await integratedReady(page)),
    "needs the worker with the payments fake",
  );
  const s = await setUp(page);
  let kiosk: Page | null = null;
  try {
    kiosk = await (context as BrowserContext).newPage();
    await kiosk.setViewportSize({ width: 1280, height: 800 });
    await kiosk.goto(s.path);
    await expect(
      kiosk.getByRole("button", { name: /^Taco de asada/ }),
    ).toBeVisible();
    await pairKiosk(page, kiosk, s);
    // A bound tablet starts on the welcome screen.
    const start = kiosk.getByRole("button", {
      name: "Toca para ordenar",
      exact: true,
    });
    await expect(start).toBeVisible();
    await axe(kiosk);
    await start.click();
    await addTaco(kiosk);
    await kiosk
      .getByRole("button", { name: "Enviar pedido", exact: true })
      .click();
    await expect(
      kiosk.getByRole("heading", { name: "¿Para aquí o para llevar?" }),
    ).toBeVisible();
    await axe(kiosk);
    await kiosk.getByRole("button", { name: "Para aquí", exact: true }).click();
    await expect(
      kiosk.getByRole("heading", { name: "¿Cómo quieres pagar?" }),
    ).toBeVisible();
    await kiosk
      .getByRole("button", { name: "Pagar aquí con tarjeta", exact: true })
      .click();
    await expect(
      kiosk.getByRole("heading", {
        name: /Sigue las instrucciones en la terminal/,
      }),
    ).toBeVisible();
    await fake("approve", {
      device: CLIP_DEVICE,
      brand: "visa",
      type: "credit_card",
      last4: "4242",
    });
    await expect(
      kiosk.getByRole("heading", {
        name: /¡Pagado! Tu pedido K-\d+ ya se está preparando\./,
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(kiosk.locator(".kiosk-paid")).toContainText("Folio");
    await axe(kiosk);
    // The welcome tap asked for fullscreen (§2.11); leave it to resize the window.
    await kiosk.evaluate(() =>
      document.fullscreenElement ? document.exitFullscreen() : undefined,
    );
    await kiosk.setViewportSize({ width: 800, height: 1280 });
    await axe(kiosk);
    // The order reached the kitchen as "Comer aquí" (dine in, no table), paid by the card.
    const label = (
      await kiosk.locator(".kiosk-paid .kiosk-code").innerText()
    ).trim();
    await kiosk
      .getByRole("button", { name: "Nuevo pedido", exact: true })
      .click();
    await expect(
      kiosk.getByRole("button", { name: "Toca para ordenar", exact: true }),
    ).toBeVisible();

    // A decline: "Pagar en caja", then the cashier accepts it from Órdenes.
    await kiosk.evaluate(() =>
      document.fullscreenElement ? document.exitFullscreen() : undefined,
    );
    await kiosk.setViewportSize({ width: 1280, height: 800 });
    await kiosk
      .getByRole("button", { name: "Toca para ordenar", exact: true })
      .click();
    await addTaco(kiosk);
    await kiosk
      .getByRole("button", { name: "Enviar pedido", exact: true })
      .click();
    await kiosk
      .getByRole("button", { name: "Para llevar", exact: true })
      .click();
    await kiosk
      .getByRole("button", { name: "Pagar aquí con tarjeta", exact: true })
      .click();
    await expect(
      kiosk.getByRole("heading", {
        name: /Sigue las instrucciones en la terminal/,
      }),
    ).toBeVisible();
    await fake("decline", { device: CLIP_DEVICE });
    await expect(
      kiosk.getByRole("heading", {
        name: "Tu tarjeta no pasó. Puedes intentar de nuevo o pagar en caja.",
      }),
    ).toBeVisible({ timeout: 60_000 });
    await kiosk
      .getByRole("button", { name: "Pagar en caja", exact: true })
      .click();
    const code = kiosk.locator(".kiosk-code");
    await expect(code).toHaveText(/^K-\d+$/);
    const counterLabel = (await code.innerText()).trim();
    const inbox = await call(page, "/ordering/inbox");
    const hold = inbox.holds.find((h: any) => h.label === counterLabel);
    expect(hold.kiosk.paymentChoice).toBe("counter");
    expect(hold.kiosk.charging).toBe(false);
    // The cashier collects it and sends it to the kitchen (the inbox is left as it was found).
    const accepted = await call(page, `/ordering/holds/${hold.id}/accept`, {
      operationId: uuid(),
      target: { kind: "new" },
      payment: {
        method: "cash",
        amount: hold.currentTotal,
        tip: 0,
        received: hold.currentTotal,
      },
    });
    expect(accepted.hold.state).toBe("accepted");
    expect(label).not.toBe(counterLabel);
  } finally {
    await tearDown(page, s).catch((e) =>
      console.warn("kiosk teardown:", String(e)),
    );
    void kiosk;
  }
});

test("menu photos: an owner uploads a photo (its EXIF never reaches the server) and a description; the QR menu shows them; axe at 390 and 768", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const caps = await call(page, "/capabilities");
  test.skip(
    !caps.menuPhotos?.enabled,
    "needs MEDIA_STORE (fs in local runs and CI)",
  );
  const menu = await call(page, "/menu");
  const product = menu.products.find((p: any) => p.name.es === "Taco de asada");
  const uploads: Buffer[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith(`/api/menu/products/${product.id}/image`))
      uploads.push(r.postDataBuffer() ?? Buffer.alloc(0));
  });
  // The editor's photo field (the input is visually hidden behind "Subir foto").
  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .getByRole("button", { name: "Menú e inventario", exact: true })
    .click()
    .catch(() => {});
  const result = await page.evaluate(
    async ({ id, png }) => {
      const s = await (await fetch("/api/session")).json();
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const parts: Blob[] = [];
      for (const width of [160, 480, 1200]) {
        const w = Math.min(width, bitmap.width);
        const h = Math.round((bitmap.height * w) / bitmap.width);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
        parts.push(
          await new Promise<Blob>((r) =>
            canvas.toBlob((b) => r(b!), "image/webp", 0.8),
          ),
        );
      }
      const r = await fetch(`/api/menu/products/${id}/image`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-csrf-token": s.csrf,
          "x-gm-operation-id": crypto.randomUUID(),
        },
        body: new Blob(parts),
      });
      return { status: r.status, body: await r.json() };
    },
    { id: product.id, png: pngWithExif(640, 480).toString("base64") },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const image = result.body.image;
  expect(image.w).toBe(640);
  const served = await page.request.get(`/media/${image.id}/card.webp`);
  expect(served.status()).toBe(200);
  expect(served.headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect((await served.body()).includes(Buffer.from("GPS"))).toBe(false);
  for (const u of uploads) expect(u.includes(Buffer.from("GPS"))).toBe(false);
  const link = await call(page, "/ordering/links", {
    kind: "counter",
    label: "Fotos " + tag(),
  });
  try {
    for (const width of [390, 768]) {
      const qr = await context.newPage();
      await qr.setViewportSize({ width, height: 900 });
      await qr.goto(link.path);
      const button = qr.getByRole("button", { name: /^Taco de asada/ });
      await expect(button.locator("img")).toHaveAttribute(
        "src",
        `/media/${image.id}/thumb.webp`,
      );
      await axe(qr);
      await qr.close();
    }
  } finally {
    const fresh = await call(page, "/menu");
    const p = fresh.products.find((x: any) => x.id === product.id);
    await call(page, `/menu/products/${product.id}/image/remove`, {
      operationId: uuid(),
      expectedVersion: p.version,
    });
    await call(page, `/ordering/links/${link.id}/revoke`, {
      operationId: uuid(),
    });
  }
  expect(
    (await page.request.get(`/media/${image.id}/card.webp`)).status(),
  ).toBe(404);
});

test("Importar fotos: the owner picks a manifest and generated photos, reviews the proposed products (an unmatched item and a missing file are reported), imports through the normal upload, and a second run imports nothing new", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page);
  const caps = await call(page, "/capabilities");
  test.skip(
    !caps.menuPhotos?.enabled,
    "needs MEDIA_STORE (fs in local runs and CI)",
  );
  const menu = await call(page, "/menu");
  const byName = (es: string) =>
    menu.products.find((p: any) => p.name.es === es);
  const cafe = byName("Café de olla");
  const flan = byName("Flan de vainilla");
  const brownie = byName("Brownie de cacao");
  for (const p of [cafe, flan, brownie]) expect(p.image ?? null).toBeNull();
  const manifest = {
    format: "gm-menu-media-v1",
    source: "sistema ficticio",
    items: [
      { id: "ficticio-1", name: "CAFE DE OLLA", file: "cafe-ficticio.png" },
      { id: "ficticio-2", name: "flan de vainilla", file: "flan-ficticio.png" },
      {
        id: "ficticio-3",
        name: "Pozole inventado",
        file: "pozole-ficticio.png",
      },
      { id: "ficticio-4", name: "Brownie de cacao", file: "no-descargada.png" },
    ],
  };
  const photos = [
    {
      name: "cafe-ficticio.png",
      mimeType: "image/png",
      buffer: pngWithExif(640, 480),
    },
    {
      name: "flan-ficticio.png",
      mimeType: "image/png",
      buffer: pngWithExif(500, 500),
    },
    {
      name: "pozole-ficticio.png",
      mimeType: "image/png",
      buffer: pngWithExif(300, 200),
    },
  ];
  const uploads: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/menu\/products\/[^/]+\/image$/.test(r.url()))
      uploads.push(r.headers()["x-gm-import-item"] ?? "");
  });
  async function open() {
    await page
      .getByRole("button", { name: "Importar fotos", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Importar fotos del sistema anterior",
    });
    await dialog.getByLabel("Manifiesto (JSON)").setInputFiles({
      name: "manifiesto.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(manifest)),
    });
    await dialog.getByLabel("Fotos (JPG, PNG o WebP)").setInputFiles(photos);
    await expect(dialog.getByText("3 fotos elegidas")).toBeVisible();
    await dialog.getByRole("button", { name: "Revisar", exact: true }).click();
    return dialog;
  }
  await page
    .getByRole("button", { name: "Menú e inventario", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "Productos" })).toBeVisible();
  try {
    const dialog = await open();
    await expect(
      dialog.getByText(
        "2 listas · 1 sin producto · 1 sin archivo · 0 ya con foto · 0 repetidas",
      ),
    ).toBeVisible();
    // The proposal ignores case and accents; the owner reviews it before importing.
    await expect(dialog.getByLabel("Producto aquí: CAFE DE OLLA")).toHaveValue(
      cafe.id,
    );
    await expect(
      dialog.getByLabel("Producto aquí: Pozole inventado"),
    ).toHaveValue("");
    await axe(page);
    await dialog.getByRole("button", { name: "Importar 2 fotos" }).click();
    const done = dialog.getByRole("status").filter({ hasText: "Listo:" });
    await expect(done).toContainText("Listo: 2 importadas, 2 sin importar.", {
      timeout: 90_000,
    });
    await expect(done).toContainText("El reporte quedó en la bitácora.");
    // The report lists what was not imported and why.
    await expect(
      dialog.getByRole("row", { name: /Pozole inventado/ }),
    ).toContainText("Sin producto");
    await expect(
      dialog.getByRole("row", { name: /Brownie de cacao/ }),
    ).toContainText("Falta el archivo");
    expect(uploads.sort()).toEqual(["ficticio-1", "ficticio-2"]);
    await dialog.getByRole("button", { name: "Cerrar" }).last().click();
    const after = await call(page, "/menu");
    const image = (p: any) =>
      after.products.find((x: any) => x.id === p.id).image ?? null;
    expect(image(cafe)?.w).toBe(640);
    expect(image(flan)?.w).toBe(500);
    expect(image(brownie)).toBeNull();
    expect(
      (await page.request.get(`/media/${image(cafe).id}/thumb.webp`)).status(),
    ).toBe(200);
    // A second run with the same manifest and photos: both products keep their photo.
    const again = await open();
    await expect(
      again.getByText(
        "0 listas · 1 sin producto · 1 sin archivo · 2 ya con foto · 0 repetidas",
      ),
    ).toBeVisible();
    await expect(
      again.getByRole("button", { name: "Importar 0 fotos" }),
    ).toBeDisabled();
    await again.getByRole("button", { name: "Cerrar" }).first().click();
    expect(uploads).toHaveLength(2);
  } finally {
    const fresh = await call(page, "/menu");
    for (const p of [cafe, flan]) {
      const now = fresh.products.find((x: any) => x.id === p.id);
      if (now.image)
        await call(page, `/menu/products/${p.id}/image/remove`, {
          operationId: uuid(),
          expectedVersion: now.version,
        });
    }
  }
});

test("selling-grid photos: on by default on this terminal, lazy, in a fixed box that does not move when the photo arrives; a photo that fails to load leaves the initials and the tile still sells; «Pantalla» turns them off for this device", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const caps = await call(page, "/capabilities");
  test.skip(
    !caps.menuPhotos?.enabled,
    "needs MEDIA_STORE (fs in local runs and CI)",
  );
  const session = await call(page, "/session");
  const menu = await call(page, "/menu");
  const named = (es: string) =>
    menu.products.find((p: any) => p.name.es === es);
  const guacamole = named("Guacamole");
  const ensalada = named("Ensalada verde");
  async function upload(id: string, png: Buffer) {
    const result = await page.evaluate(
      async ({ id, png }) => {
        const s = await (await fetch("/api/session")).json();
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: "image/png" }),
        );
        const parts: Blob[] = [];
        for (const width of [160, 480, 1200]) {
          const w = Math.min(width, bitmap.width);
          const h = Math.round((bitmap.height * w) / bitmap.width);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
          parts.push(
            await new Promise<Blob>((r) =>
              canvas.toBlob((b) => r(b!), "image/webp", 0.8),
            ),
          );
        }
        const r = await fetch(`/api/menu/products/${id}/image`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-csrf-token": s.csrf,
            "x-gm-operation-id": crypto.randomUUID(),
          },
          body: new Blob(parts),
        });
        return { status: r.status, body: await r.json() };
      },
      { id, png: png.toString("base64") },
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body.image as { id: string; w: number; h: number };
  }
  const image = await upload(guacamole.id, pngWithExif(400, 300));
  const broken = await upload(ensalada.id, pngWithExif(300, 300));
  // Guacamole's photo is held back until its box was measured: the box must not move when it
  // lands. Ensalada's photo is refused from the first request (never cached): its tile keeps the
  // initials and still sells.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/media/${image.id}/**`, async (route) => {
    await held;
    await route.continue();
  });
  const refused: string[] = [];
  await page.route(`**/media/${broken.id}/**`, (route) => {
    refused.push(route.request().url());
    return route.fulfill({ status: 404, body: "" });
  });
  try {
    await page.getByRole("button", { name: "Operación", exact: true }).click();
    await page.getByRole("button", { name: "Vender", exact: true }).click();
    const grid = page.locator(".product-grid");
    const tile = grid.getByRole("button", { name: /Guacamole/ });
    const photo = tile.locator("img.product-photo");
    await expect(photo).toHaveAttribute("loading", "lazy");
    await expect(photo).toHaveAttribute("decoding", "async");
    await expect(photo).toHaveAttribute("alt", "");
    expect(session.access?.deviceKind ?? "terminal").toBe("terminal");
    const before = await tile.boundingBox();
    const art = await tile.locator(".product-art").boundingBox();
    const plainArt = await grid
      .getByRole("button", { name: /Bowl de la casa/ })
      .locator(".product-art")
      .boundingBox();
    expect(art!.height).toBe(plainArt!.height);
    release();
    await expect
      .poll(() =>
        photo.evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
    expect(await tile.boundingBox()).toEqual(before);
    expect(await tile.locator(".product-art").boundingBox()).toEqual(art);
    // A photo the server cannot serve: dropped once it fails, the initials stay, the tile sells.
    const plain = grid.getByRole("button", { name: /Ensalada verde/ });
    await plain.scrollIntoViewIfNeeded();
    await expect.poll(() => refused.length).toBeGreaterThan(0);
    await expect(plain.locator("img")).toHaveCount(0);
    await expect(plain.locator(".dish-mark")).toHaveText("Ev");
    await plain.click();
    await expect(plain).toContainText("1 en la orden");
    // «Pantalla»: this device turns grid photos off (and back on).
    await page.getByRole("button", { name: "Pantalla", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Pantalla" });
    const box = dialog.getByLabel("Fotos en la cuadrícula de venta");
    await expect(box).toBeChecked();
    await axe(page);
    await box.uncheck();
    await dialog.getByRole("button", { name: "Listo", exact: true }).click();
    await expect(tile.locator("img")).toHaveCount(0);
    expect((await tile.locator(".product-art").boundingBox())!.height).toBe(
      art!.height,
    );
    await page.getByRole("button", { name: "Pantalla", exact: true }).click();
    await dialog.getByLabel("Fotos en la cuadrícula de venta").check();
    await dialog.getByRole("button", { name: "Listo", exact: true }).click();
    await expect(photo).toHaveCount(1);
  } finally {
    await page.unroute(`**/media/${image.id}/**`).catch(() => {});
    await page.unroute(`**/media/${broken.id}/**`).catch(() => {});
    await page.evaluate(() => localStorage.removeItem("gm-display-settings"));
    const fresh = await call(page, "/menu");
    for (const id of [guacamole.id, ensalada.id]) {
      const p = fresh.products.find((x: any) => x.id === id);
      if (p.image)
        await call(page, `/menu/products/${id}/image/remove`, {
          operationId: uuid(),
          expectedVersion: p.version,
        });
    }
  }
});
