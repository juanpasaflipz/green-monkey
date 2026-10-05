import "dotenv/config";
import {
  test,
  expect,
  type Browser,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";

const OWNER_PASSWORD = "demo-green-monkey";
const CASHIER = { name: "Dani Demo", pin: "123456" };

/** Local fixture database only (same guard as owner.spec). */
function fixtureAdmin(baseURL: string | undefined) {
  const runtime = new URL(process.env.DATABASE_URL ?? "http://invalid"),
    migration = new URL(process.env.MIGRATION_DATABASE_URL ?? "http://invalid"),
    base = new URL(baseURL ?? "http://invalid");
  if (
    !["localhost", "127.0.0.1"].includes(runtime.hostname) ||
    runtime.hostname !== migration.hostname ||
    runtime.port !== migration.port ||
    runtime.pathname !== migration.pathname ||
    !/^\/green_monkey(_[a-z]+)?_dev$/.test(runtime.pathname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw Error("Access fixtures require the isolated local dev database");
  return postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
}
const tag = () => Math.random().toString(36).slice(2, 7);

async function ownerLogin(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
/** Calls the API as the page's current session. */
async function call<T = any>(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const s = await (await fetch("/api/session")).json();
      const response = await fetch("/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  ) as Promise<{ status: number; body: T }>;
}
async function newCode(owner: Page, deviceName: string) {
  const r = await call<{ code: string }>(owner, "/access/pairing-codes", {
    deviceName,
  });
  expect(r.status).toBe(200);
  return r.body.code;
}
async function pair(page: Page, code: string) {
  await page.goto("/app");
  await page.getByLabel("Código de vinculación").fill(code);
  await page.getByRole("button", { name: "Vincular", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "¿Quién entra?", exact: true }),
  ).toBeVisible();
}
async function pairTerminal(browser: Browser, owner: Page, name: string) {
  const code = await newCode(owner, name);
  const context = await browser.newContext();
  const page = await context.newPage();
  await pair(page, code);
  return { context, page };
}
/** Signs in from the roster (gate or lock screen) with the keypad or a password. */
async function signIn(
  scope: Page | ReturnType<Page["getByRole"]>,
  name: string,
  secret: string,
  password = false,
) {
  await scope.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await enterSecret(scope, name, secret, password);
}
async function enterSecret(
  scope: Page | ReturnType<Page["getByRole"]>,
  name: string,
  secret: string,
  password = false,
  submit = "Entrar",
) {
  if (password) {
    await scope.getByRole("button", { name: "Usar contraseña" }).click();
    await scope.getByLabel("Contraseña o PIN").fill(secret);
  } else {
    await expect(scope.getByLabel(`PIN de ${name}`)).toBeVisible();
    for (const digit of secret)
      await scope.getByRole("button", { name: digit, exact: true }).click();
  }
  await scope.getByRole("button", { name: submit, exact: true }).click();
}
async function sessionOf(page: Page) {
  return page.evaluate(async () => (await fetch("/api/session")).json());
}
/** Offline sales queued in this browser's IndexedDB (green-monkey-v1 / pending). */
async function queuedSales(page: Page) {
  return page.evaluate(
    () =>
      new Promise<
        { id: string; scope: string; status: string; orderOperationId: string }[]
      >((resolve, reject) => {
        const open = indexedDB.open("green-monkey-v1");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result
            .transaction("pending")
            .objectStore("pending")
            .getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            open.result.close();
            resolve(
              request.result.map((r) => ({
                id: r.id,
                scope: r.scope,
                status: r.status,
                orderOperationId: r.body.order.operationId,
              })),
            );
          };
        };
      }),
  );
}
/** The session id in this browser's offline cache (green-monkey-v1 / cache / "session"). */
async function cachedSessionId(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open("green-monkey-v1");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result
            .transaction("cache")
            .objectStore("cache")
            .get("session");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            open.result.close();
            resolve(request.result?.value?.id ?? null);
          };
        };
      }),
  );
}
/** The lock dialog's open state, read from the DOM (it reopens after any close). */
async function lockOpen(page: Page) {
  return page.evaluate(
    () =>
      document.querySelector<HTMLDialogElement>("dialog.lock-screen")?.open ??
      false,
  );
}
/** No horizontal overflow at four widths; axe and evidence at 1440 and 390. */
async function checkLayout(page: Page, evidence: string, include?: string) {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    if (width === 1440 || width === 390) {
      let axe = new AxeBuilder({ page }).withTags([
        "wcag2a",
        "wcag2aa",
        "wcag21aa",
        "wcag22aa",
      ]);
      if (include) axe = axe.include(include);
      const result = await axe.analyze();
      expect(result.violations).toEqual([]);
      const path = `docs/evidence/access-${evidence}-${width}.png`;
      if (include) await page.locator(include).screenshot({ path });
      else await page.screenshot({ path, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("owner pairs a terminal with a code and a new cashier signs in with name and PIN, without any restaurant ID (FOH-2/FIT-3/SEC-4)", async ({
  page,
  browser,
}) => {
  const id = tag();
  const cashier = `Cajera ${id}`;
  await ownerLogin(page);
  // The owner adds a cashier with a PIN from Equipo.
  await page.getByRole("button", { name: "Equipo", exact: true }).click();
  await page.getByRole("button", { name: "Agregar empleado" }).click();
  const add = page.getByRole("dialog", { name: "Agregar empleado" });
  await add.getByLabel("Nombre", { exact: true }).fill(cashier);
  await add.getByLabel("Rol").selectOption({ label: "Cajero" });
  await add.getByLabel("PIN nuevo (6 a 8 dígitos)").fill("481516");
  await add.getByLabel("Confirma el PIN").fill("481516");
  await add.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(
    page.locator(".staff-management").getByRole("status"),
  ).toContainText(`${cashier} se agregó`);
  const row = page.getByRole("row").filter({ hasText: cashier });
  await expect(row).toContainText("Cajero");
  await expect(row).toContainText("Activo");
  await checkLayout(page, "team", ".staff-management");

  // A pairing code from Configuración → Dispositivos.
  await page.getByRole("button", { name: "Configuración", exact: true }).click();
  await page.getByRole("button", { name: "Vincular un dispositivo" }).click();
  const dialog = page.getByRole("dialog", { name: "Vincular un dispositivo" });
  await dialog.getByLabel("Nombre del dispositivo").fill(`Caja ${id}`);
  await dialog.getByRole("button", { name: "Generar código" }).click();
  const code = (await dialog.locator(".pairing-code-value").textContent())!;
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  await expect(dialog.getByRole("timer")).toContainText(/Vence en (9|10):/);
  await expect(dialog).toContainText(
    "elige «Vincular este dispositivo» y escribe el código",
  );
  await page.screenshot({ path: "docs/evidence/access-pairing-code-1440.png" });

  // A fresh browser: no restaurant ID field, only pairing (and demo locally).
  const terminal = await browser.newContext();
  const tablet = await terminal.newPage();
  await tablet.goto("/app");
  await expect(
    tablet.getByRole("heading", { name: "Vincular este dispositivo" }),
  ).toBeVisible();
  await expect(tablet.getByLabel("Sucursal")).toHaveCount(0);
  await expect(tablet.locator('input[name="tenantId"]')).toHaveCount(0);
  await checkLayout(tablet, "gate-unpaired");
  // Lower case, spaces and look-alikes are accepted.
  await tablet
    .getByLabel("Código de vinculación")
    .fill(code.toLowerCase().replace("-", " "));
  await tablet.getByRole("button", { name: "Vincular", exact: true }).click();
  await expect(tablet.getByText(/^Dispositivo vinculado a .+\.$/)).toBeVisible();
  await expect(tablet.getByText(`Dispositivo: Caja ${id}`)).toBeVisible();
  await expect(dialog).toContainText(`Vinculado: Caja ${id}`);
  await checkLayout(tablet, "gate-roster");

  await signIn(tablet, cashier, "481516");
  await expect(tablet.locator(".scope")).toContainText(cashier);
  await expect(tablet.locator(".scope")).toContainText("Cajero");
  const s = await sessionOf(tablet);
  expect(s.role).toBe("cashier");
  expect(s.access.deviceKind).toBe("terminal");
  expect(s.access.deviceName).toBe(`Caja ${id}`);
  // The code is single-use.
  const again = await terminal.request.post("/api/access/pair", {
    data: { code },
  });
  expect(again.status()).toBe(400);
  expect((await again.json()).error).toBe("pairing_code_invalid");
  await terminal.close();
});

test("production gate shows no demo text or prefilled values when demo access is off", async ({
  page,
}) => {
  await page.route("**/api/access/terminal", (route) =>
    route.fulfill({ json: { paired: false, google: false, demo: null } }),
  );
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "Vincular este dispositivo" }),
  ).toBeVisible();
  await expect(page.getByText("Acceso de demostración")).toHaveCount(0);
  await expect(page.getByText(/Entorno de demostración/)).toHaveCount(0);
  await expect(page.getByLabel("Contraseña o PIN")).toHaveCount(0);
  await expect(page.getByLabel("Usuario", { exact: true })).toHaveCount(0);
  await expect(page.locator("input")).toHaveCount(1);
  await expect(page.getByLabel("Código de vinculación")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(
    "10000000-0000-4000-8000-000000000001",
  );
  await page.screenshot({
    path: "docs/evidence/access-gate-production-1440.png",
  });
});

test("a paired terminal hides Google and the server refuses owner account entry (GAP-2)", async ({
  page,
  browser,
}) => {
  const id = tag();
  await ownerLogin(page);
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Terminal ${id}`,
  );
  // Cookies are Secure in production mode, so requests go through the page.
  const server = await tablet.evaluate(async () => {
    const providers = await (await fetch("/api/auth/providers")).json();
    const enter = await fetch("/api/auth/account/enter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "10000000-0000-4000-8000-000000000001" }),
    });
    return { providers, enter: [enter.status, (await enter.json()).error] };
  });
  expect(server.providers).toMatchObject({ google: false, terminal: true });
  expect(server.enter).toEqual([403, "device_is_terminal"]);
  await expect(
    tablet.getByText(
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
    ),
  ).toBeVisible();
  await expect(
    tablet.getByRole("link", { name: "Continuar con Google" }),
  ).toHaveCount(0);
  // Starting Google sign-in on a terminal lands back on the notice.
  await tablet.goto("/api/auth/google/start");
  await expect(tablet).toHaveURL(/\/app\?auth_error=terminal$/);
  await expect(
    tablet.getByText(
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
    ),
  ).toBeVisible();
  // The owner works on the terminal with their own secret, not Google.
  await signIn(tablet, "Alex Demo", OWNER_PASSWORD, true);
  await expect(
    tablet.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await expect(
    tablet.getByRole("button", { name: "Cambiar restaurante" }),
  ).toHaveCount(0);
  await tablet.goto("/app?account=1");
  await expect(
    tablet.getByText(
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
    ),
  ).toBeVisible();
  await context.close();
});

test("idle lock after 3 minutes keeps the cart for the same employee; switch user opens a fresh workspace (SEC-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const id = tag();
  try {
    await ownerLogin(page);
    const code = await newCode(page, `Inactividad ${id}`);
    const context = await browser.newContext();
    const tablet = await context.newPage();
    await tablet.clock.install();
    await pair(tablet, code);
    // The browser suites run with a default auto-lock of 0 (D21); this device
    // sets the 3-minute terminal default explicitly.
    await admin`update devices set idle_lock_seconds=180 where name=${`Inactividad ${id}`}`;
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await tablet.getByRole("button", { name: /Taco de hongos/ }).click();
    const cart = tablet.locator(".cart");
    await expect(cart).toContainText("Taco de hongos");
    await tablet.clock.fastForward("02:00");
    const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
    await expect(lock).toHaveCount(0);
    await tablet.clock.fastForward("01:05");
    await expect(lock).toBeVisible();
    await expect(lock).toContainText(CASHIER.name);
    await checkLayout(tablet, "lock-screen");
    await enterSecret(lock, CASHIER.name, "000000");
    await expect(lock.getByRole("alert")).toContainText("PIN incorrecto.");
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    await expect(cart).toContainText("Taco de hongos");
    // Manual lock, then a quick switch to another employee.
    await tablet.getByRole("button", { name: "Bloquear pantalla" }).click();
    await expect(lock).toBeVisible();
    await lock.getByRole("button", { name: "Cambiar de usuario" }).click();
    await signIn(lock, "Alex Demo", OWNER_PASSWORD, true);
    await expect(tablet.locator(".scope")).toContainText("Alex Demo");
    await tablet.getByRole("button", { name: "Operación", exact: true }).click();
    await tablet.getByRole("button", { name: "Vender", exact: true }).click();
    await expect(tablet.locator(".cart")).not.toContainText("Taco de hongos");
    await context.close();
  } finally {
    await admin.end();
  }
});

test("a lock survives reloads, new tabs and offline restores; Continuar como needs a valid offline window and the PIN is asked again on reconnect (SEC-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !process.env.TEST_PRODUCTION,
    "Offline reload requires the compiled server's service worker",
  );
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Recarga ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await tablet.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const s = await sessionOf(tablet);
    const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
    const pinField = lock.getByLabel(`PIN de ${CASHIER.name}`);
    const continueAs = lock.getByRole("button", {
      name: `Continuar como ${CASHIER.name}`,
    });
    // Manual lock, then a reload: still locked and the PIN is required.
    await tablet.getByRole("button", { name: "Bloquear pantalla" }).click();
    await expect(lock).toBeVisible();
    await tablet.reload();
    await expect(lock).toBeVisible();
    await expect(pinField).toBeVisible();
    // A new tab on the same terminal opens locked as well.
    const other = await context.newPage();
    await other.goto("/app");
    await expect(
      other.getByRole("dialog", { name: "Pantalla bloqueada" }),
    ).toBeVisible();
    await other.close();
    // Offline with an expired offline window there is no way past the lock.
    await admin`update sessions set offline_until=now()-interval '1 minute' where id=${s.id}`;
    await tablet.reload();
    await expect(lock).toBeVisible();
    await context.setOffline(true);
    await expect(lock).toContainText(
      "Sin conexión no se puede verificar el PIN.",
    );
    await expect(continueAs).toHaveCount(0);
    await context.setOffline(false);
    await expect(pinField).toBeVisible();
    // With a valid window, an offline reload restores the cached session locked.
    await admin`update sessions set offline_until=now()+interval '4 hours' where id=${s.id}`;
    await tablet.reload();
    await expect(lock).toBeVisible();
    await context.setOffline(true);
    await tablet.reload();
    await expect(lock).toBeVisible();
    await expect(lock).toContainText(
      `Sin conexión no se puede verificar el PIN. Las ventas se registran a nombre de ${CASHIER.name}.`,
    );
    await tablet.screenshot({
      path: "docs/evidence/access-offline-lock-1440.png",
    });
    await continueAs.click();
    await expect(lock).toBeHidden();
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    // The connection returns: the PIN is required before any online work.
    await context.setOffline(false);
    await expect(lock).toBeVisible();
    await expect(pinField).toBeVisible();
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    // Unlocked with the PIN, a reload opens the workspace directly...
    await tablet.reload();
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await expect(lock).toHaveCount(0);
    // ...unless the device sat idle longer than its auto-lock.
    await admin`update devices set idle_lock_seconds=600 where id=${s.deviceId}`;
    await tablet.reload();
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await expect(lock).toHaveCount(0);
    await tablet.evaluate((id) => {
      localStorage.setItem(
        "gm-activity",
        JSON.stringify({ sessionId: id, at: Date.now() - 11 * 60_000 }),
      );
    }, s.id);
    await tablet.reload();
    await expect(lock).toBeVisible();
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    const after = await sessionOf(tablet);
    expect(after.id).toBe(s.id);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("Escape and a forced close never dismiss a manual or idle lock, the workspace stays unusable, and a manual lock reaches the other tabs (SEC-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const id = tag();
  try {
    await ownerLogin(page);
    const code = await newCode(page, `Escape ${id}`);
    const context = await browser.newContext();
    const tablet = await context.newPage();
    await tablet.clock.install();
    await pair(tablet, code);
    await admin`update devices set idle_lock_seconds=180 where name=${`Escape ${id}`}`;
    // The owner on the terminal, so the workspace has the Equipo navigation.
    await signIn(tablet, "Alex Demo", OWNER_PASSWORD, true);
    await expect(tablet.locator(".scope")).toContainText("Alex Demo");
    const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
    // CSS, not role: behind the lock the workspace is inert.
    const rail = (name: string) =>
      tablet.locator("nav.rail button", { hasText: name });
    /**
     * A keypad tap, then Escape five times (a repeated close request without
     * user activation can no longer be cancelled), then a forced close of the
     * dialog: the lock stays up, everything behind it stays inert, and a click
     * on the navigation reaches nothing.
     */
    const holds = async (blocked: string) => {
      await expect(lock).toBeVisible();
      // The keypad never asks for the tablet's own keyboard (ACC-17).
      await expect(lock.getByLabel("PIN de Alex Demo")).toHaveAttribute(
        "inputmode",
        "none",
      );
      await lock.getByRole("button", { name: "1", exact: true }).click();
      for (let i = 0; i < 5; i++) await tablet.keyboard.press("Escape");
      await expect(lock).toBeVisible();
      expect(await lockOpen(tablet)).toBe(true);
      await tablet.evaluate(() =>
        document.querySelector<HTMLDialogElement>("dialog.lock-screen")!.close(),
      );
      await expect.poll(() => lockOpen(tablet)).toBe(true);
      await expect(lock).toBeVisible();
      expect(
        await tablet.evaluate(() => document.getElementById("root")!.inert),
      ).toBe(true);
      await rail(blocked).click({ force: true });
      await expect(lock).toBeVisible();
    };
    const unlock = async () => {
      await lock.getByRole("button", { name: "Usar contraseña" }).click();
      await expect(lock.getByLabel("Contraseña o PIN")).toHaveAttribute(
        "inputmode",
        "text",
      );
      await lock.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
      await lock.getByRole("button", { name: "Entrar", exact: true }).click();
      await expect(lock).toBeHidden();
      expect(
        await tablet.evaluate(() => document.getElementById("root")!.inert),
      ).toBe(false);
    };

    // A second tab of the same session locks with the first one (ACC-16).
    const second = await context.newPage();
    await second.goto("/app");
    await expect(second.locator(".scope")).toContainText("Alex Demo");
    const secondLock = second.getByRole("dialog", { name: "Pantalla bloqueada" });
    await expect(secondLock).toHaveCount(0);
    await tablet.getByRole("button", { name: "Bloquear pantalla" }).click();
    await expect(secondLock).toBeVisible();

    // Manual lock: the blocked click never reached the workspace.
    await holds("Equipo");
    await unlock();
    await expect(rail("Hoy")).toHaveAttribute("aria-current", "page");
    await expect(rail("Equipo")).not.toHaveAttribute("aria-current", "page");
    await rail("Equipo").click();
    await expect(rail("Equipo")).toHaveAttribute("aria-current", "page");
    await second.close();

    // Idle lock: the same holds.
    await tablet.clock.fastForward("03:05");
    await holds("Configuración");
    await unlock();
    await expect(rail("Equipo")).toHaveAttribute("aria-current", "page");
    await expect(rail("Configuración")).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    await context.close();
  } finally {
    await admin.end();
  }
});

test("a revoked session leaves the offline cache on a cold start, and an ended one comes back offline only behind its lock (FOH-7/SEC-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !process.env.TEST_PRODUCTION,
    "Offline reload requires the compiled server's service worker",
  );
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: first } = await pairTerminal(
      browser,
      page,
      `Revocada ${tag()}`,
    );
    await signIn(first, CASHIER.name, CASHIER.pin);
    await expect(first.locator(".scope")).toContainText(CASHIER.name);
    await first.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const revoked = await sessionOf(first);
    await expect.poll(() => cachedSessionId(first)).toBe(revoked.id);
    // Revoked while no page is open (as deactivation or unpairing does).
    await first.close();
    await admin`update sessions set revoked=true where id=${revoked.id}`;
    const tablet = await context.newPage();
    await tablet.goto("/app");
    const gate = tablet.getByRole("heading", {
      name: "¿Quién entra?",
      exact: true,
    });
    await expect(gate).toBeVisible();
    await expect.poll(() => cachedSessionId(tablet)).toBeNull();
    // Offline, nothing is left to restore: the gate, never the workspace.
    await context.setOffline(true);
    await tablet.reload();
    await expect(
      tablet.getByText(
        "Sin conexión. Para entrar en este dispositivo hace falta conexión",
      ),
    ).toBeVisible();
    await expect(tablet.locator(".scope")).toHaveCount(0);
    await expect(tablet.locator("dialog.lock-screen")).toHaveCount(0);

    // An ended session stays cached, but only behind its lock with the reason.
    await context.setOffline(false);
    await tablet.reload();
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const ended = await sessionOf(tablet);
    await expect.poll(() => cachedSessionId(tablet)).toBe(ended.id);
    await tablet.close();
    await admin`update sessions set ended_at=now(),end_reason='ended_by_manager',
      expires_at=least(expires_at,now()) where id=${ended.id}`;
    const again = await context.newPage();
    await again.goto("/app");
    await expect(
      again.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    expect(await cachedSessionId(again)).toBe(ended.id);
    await context.setOffline(true);
    await again.reload();
    const lock = again.getByRole("dialog", {
      name: "La sesión se cerró en este dispositivo. Ingresa tu PIN para continuar.",
    });
    await expect(lock).toBeVisible();
    await expect(lock).toContainText(
      "Sin conexión no se puede verificar el PIN.",
    );
    await expect(
      lock.getByRole("button", { name: `Continuar como ${CASHIER.name}` }),
    ).toHaveCount(0);
    expect(
      await again.evaluate(() => document.getElementById("root")!.inert),
    ).toBe(true);
    // Back online, the PIN starts a new session.
    await context.setOffline(false);
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    expect((await sessionOf(again)).id).not.toBe(ended.id);
    await context.close();
  } finally {
    await admin.end();
  }
});

/**
 * "Salir" offline over a lock the server imposed: the warning offers no manual
 * lock (which would replace the server's reason), and after "Quedarme" the lock
 * keeps its reason with no "Continuar como" and the workspace stays inert (ACC-18).
 */
async function serverLockHoldsOffline(tablet: Page, lock: ReturnType<Page["getByRole"]>) {
  await expect(lock).toContainText("Sin conexión no se puede verificar el PIN.");
  const continueAs = lock.getByRole("button", {
    name: `Continuar como ${CASHIER.name}`,
  });
  await expect(continueAs).toHaveCount(0);
  await lock.getByRole("button", { name: "Salir", exact: true }).click();
  const leaving = tablet.getByRole("dialog", { name: "Sin conexión", exact: true });
  await expect(leaving).toBeVisible();
  await expect(leaving.getByRole("button", { name: "Quedarme" })).toBeVisible();
  await expect(
    leaving.getByRole("button", { name: "Bloquear pantalla" }),
  ).toHaveCount(0);
  await leaving.getByRole("button", { name: "Quedarme" }).click();
  await expect(leaving).toBeHidden();
  await expect(lock).toBeVisible();
  await expect(continueAs).toHaveCount(0);
  expect(await lockOpen(tablet)).toBe(true);
  expect(
    await tablet.evaluate(() => document.getElementById("root")!.inert),
  ).toBe(true);
  const tables = tablet.locator("nav.rail button", { hasText: "Mesas" });
  await tables.click({ force: true });
  await expect(lock).toBeVisible();
  await expect(tables).not.toHaveAttribute("aria-current", "page");
  // Signing out still works offline and leaves nothing to restore.
  await lock.getByRole("button", { name: "Salir", exact: true }).click();
  await leaving.getByRole("button", { name: "Salir de todos modos" }).click();
  await expect(tablet.locator(".scope")).toHaveCount(0);
  await expect(tablet.locator("dialog.lock-screen")).toHaveCount(0);
}

test("a session the server revoked stays locked offline: Salir offers no manual lock and no Continuar como appears (ACC-18)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Revocada sin red ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const s = await sessionOf(tablet);
    expect(new Date(s.offlineUntil).getTime()).toBeGreaterThan(Date.now());
    // Revoked the way deactivation does it, then the next call meets the 401.
    await admin`update sessions set revoked=true, ended_at=now(),
      end_reason='employee_deactivated', expires_at=least(expires_at,now())
      where id=${s.id}`;
    await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
    const lock = tablet.getByRole("dialog", {
      name: "Un responsable cerró esta sesión o desactivó al empleado.",
    });
    await expect(lock).toBeVisible();
    // The tablet goes offline (airplane mode) with its offline window valid.
    await context.setOffline(true);
    await serverLockHoldsOffline(tablet, lock);
    const [row] = await admin`select revoked from sessions where id=${s.id}`;
    expect(row.revoked).toBe(true);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("an ended session restored offline from the cache keeps its lock through Salir (ACC-18)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    !process.env.TEST_PRODUCTION,
    "Offline reload requires the compiled server's service worker",
  );
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: first } = await pairTerminal(
      browser,
      page,
      `Terminada sin red ${tag()}`,
    );
    await signIn(first, CASHIER.name, CASHIER.pin);
    await expect(first.locator(".scope")).toContainText(CASHIER.name);
    await first.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const ended = await sessionOf(first);
    await expect.poll(() => cachedSessionId(first)).toBe(ended.id);
    await first.close();
    await admin`update sessions set ended_at=now(),end_reason='ended_by_manager',
      expires_at=least(expires_at,now()) where id=${ended.id}`;
    const tablet = await context.newPage();
    await tablet.goto("/app");
    await expect(
      tablet.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await tablet.reload();
    const lock = tablet.getByRole("dialog", {
      name: "La sesión se cerró en este dispositivo. Ingresa tu PIN para continuar.",
    });
    await expect(lock).toBeVisible();
    await serverLockHoldsOffline(tablet, lock);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("a pending PIN confirmation never passes to the next employee after an idle lock and a switch, or a sign-out (ACC-20)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const id = tag();
  const manager = { name: `Gerente ${id}`, pin: "975310" };
  const owner = "Alex Demo";
  try {
    await ownerLogin(page);
    const created = await call(page, "/access/staff", {
      operationId: crypto.randomUUID(),
      name: manager.name,
      role: "manager",
      pin: manager.pin,
    });
    expect(created.status).toBe(200);
    const code = await newCode(page, `Paso cambio ${id}`);
    const context = await browser.newContext();
    const tablet = await context.newPage();
    await tablet.clock.install();
    await pair(tablet, code);
    await admin`update devices set idle_lock_seconds=180 where name=${`Paso cambio ${id}`}`;
    await signIn(tablet, owner, OWNER_PASSWORD, true);
    await expect(tablet.locator(".scope")).toContainText(owner);

    // A paid cash order on this terminal, refundable by either manager.
    const drawer = await call(tablet, "/cash");
    if (!drawer.body || drawer.body.closed_at)
      expect(
        (await call(tablet, "/cash/open", {
          operationId: crypto.randomUUID(),
          opening: 0,
        })).status,
      ).toBe(200);
    const catalog = (await call<any[]>(tablet, "/catalog")).body;
    const product = catalog.find((p) => p.name.es === "Taco de hongos");
    const name = `Cambio ${id}`;
    const order = await call(tablet, "/orders", {
      operationId: crypto.randomUUID(),
      lines: [
        { id: crypto.randomUUID(), productId: product.id, quantity: 1, options: [], note: "" },
      ],
      mode: "takeaway",
      tableId: null,
      name,
      note: "",
      channel: "pos",
    });
    expect(order.status).toBe(200);
    const paid = await call(tablet, `/orders/${order.body.id}/payments`, {
      operationId: crypto.randomUUID(),
      amount: order.body.total,
      tip: 0,
      received: order.body.total,
      method: "cash",
    });
    expect(paid.status).toBe(200);
    const refunds = async () => {
      const [r] = await admin`select count(*)::int as n from refunds r
        join tenders t on t.tenant_id=r.tenant_id and t.id=r.tender_id
        where t.order_id=${order.body.id}`;
      return r.n as number;
    };
    const stepUp = tablet.getByRole("dialog", { name: "Confirma con tu PIN" });
    const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
    /** Starts a refund that needs the PIN, then walks away until the idle lock. */
    const refundThenWalkAway = async (who: string) => {
      const s = await sessionOf(tablet);
      await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${s.id}`;
      await tablet.getByRole("button", { name: "Operación", exact: true }).click();
      await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
      const card = tablet.locator(".order-summary").filter({ hasText: name }).first();
      await card.getByRole("button", { name: "Reembolsar", exact: true }).click();
      const refund = tablet.getByRole("dialog").first();
      await refund.getByLabel("Importe", { exact: true }).fill("10");
      await refund.getByLabel("Explicación").fill("Devolución sin confirmar");
      await refund.getByRole("button", { name: "Guardar", exact: true }).click();
      await expect(stepUp).toContainText(
        `Esta acción necesita que confirmes que eres ${who}.`,
      );
      await tablet.clock.fastForward("03:05");
      await expect(lock).toBeVisible();
      // Never over the lock.
      await expect(stepUp).toHaveCount(0);
    };

    // 1. The owner's refund waits for the PIN; the manager switches in from the idle lock.
    await refundThenWalkAway(owner);
    await lock.getByRole("button", { name: "Cambiar de usuario" }).click();
    await signIn(lock, manager.name, manager.pin);
    await expect(lock).toBeHidden();
    await expect(tablet.locator(".scope")).toContainText(manager.name);
    await expect(stepUp).toHaveCount(0);
    await tablet.getByRole("button", { name: "Operación", exact: true }).click();
    await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
    await expect(stepUp).toHaveCount(0);
    expect(await refunds()).toBe(0);

    // 2. The manager's refund waits for the PIN; Salir from the idle lock, the owner signs in.
    await refundThenWalkAway(manager.name);
    await lock.getByRole("button", { name: "Salir", exact: true }).click();
    await expect(
      tablet.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    await signIn(tablet, owner, OWNER_PASSWORD, true);
    await expect(tablet.locator(".scope")).toContainText(owner);
    await expect(stepUp).toHaveCount(0);
    expect(await refunds()).toBe(0);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("an idle background tab never locks the tab in use; with every tab idle, each one locks (ACC-21)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const id = tag();
  try {
    await ownerLogin(page);
    const code = await newCode(page, `Pestañas ${id}`);
    const context = await browser.newContext();
    const tablet = await context.newPage();
    await tablet.clock.install();
    await pair(tablet, code);
    await admin`update devices set idle_lock_seconds=180 where name=${`Pestañas ${id}`}`;
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    // A second tab of the same session, left alone in the background.
    const background = await context.newPage();
    await background.goto("/app");
    await expect(background.locator(".scope")).toContainText(CASHIER.name);
    const lockOf = (p: Page) =>
      p.getByRole("dialog", { name: "Pantalla bloqueada" });
    // The cashier keeps selling in the first tab for 4 minutes: the background
    // tab's own 3-minute timer comes due, but neither tab locks.
    const product = tablet.locator("button.product", { hasText: "Taco de hongos" });
    for (let minute = 0; minute < 4; minute++) {
      await tablet.clock.fastForward("01:00");
      await product.click();
    }
    await expect(tablet.locator(".cart")).toContainText("Taco de hongos");
    await expect(lockOf(tablet)).toHaveCount(0);
    await expect(lockOf(background)).toHaveCount(0);
    // Idle everywhere: each tab locks by its own timer.
    await tablet.clock.fastForward("03:10");
    await expect(lockOf(tablet)).toBeVisible();
    await tablet.clock.fastForward("00:30");
    await expect(lockOf(background)).toBeVisible();
    await context.close();
  } finally {
    await admin.end();
  }
});

test("an expired session shows the PIN lock with its reason, not a generic error, and Salir works (FOH-7)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Vence ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const s = await sessionOf(tablet);
    await admin`update sessions set expires_at=now()-interval '1 second',
      absolute_expires_at=now()-interval '1 second' where id=${s.id}`;
    await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
    const lock = tablet.getByRole("dialog", {
      name: "Tu sesión terminó. Ingresa tu PIN para continuar.",
    });
    await expect(lock).toBeVisible();
    await expect(tablet.getByText("No se pudo completar la acción.")).toHaveCount(
      0,
    );
    await lock.getByRole("button", { name: "Salir", exact: true }).click();
    await expect(
      tablet.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    // Logout succeeds even without a valid session and keeps the device paired.
    const logout = await context.request.post("/api/logout");
    expect(logout.status()).toBe(200);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("logout with unsent sales warns, and the sales sync when the same employee returns (OFF-7)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Turno ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const first = await sessionOf(tablet);
    await tablet.getByRole("button", { name: "Caja", exact: true }).click();
    await tablet.getByRole("button", { name: "Abrir caja", exact: true }).click();
    await tablet
      .getByRole("dialog")
      .getByRole("button", { name: "Guardar", exact: true })
      .click();
    await expect(tablet.getByText("Caja abierta", { exact: true })).toBeVisible();
    await tablet.getByRole("button", { name: "Vender", exact: true }).click();
    await tablet.getByRole("button", { name: /Taco de hongos/ }).click();
    await context.setOffline(true);
    await tablet.getByRole("button", { name: "Cobrar", exact: true }).click();
    await tablet
      .getByRole("button", {
        name: "Guardar cobro en este dispositivo",
        exact: true,
      })
      .click();
    await expect(tablet.locator(".receipt")).toContainText(
      "Pendiente de sincronizar",
    );
    const queued = (await queuedSales(tablet)).filter(
      (r) => r.scope === `${first.tenantId}:${first.deviceId}:${first.employeeId}`,
    );
    expect(queued).toHaveLength(1);
    const [sale] = queued;
    await tablet.getByRole("button", { name: "Siguiente venta" }).click();
    // Back online, but the sync endpoint is failing.
    await tablet.route("**/api/sync", (route) =>
      route.fulfill({ status: 503, json: { error: "server_unavailable" } }),
    );
    await context.setOffline(false);
    await tablet.getByRole("button", { name: "Salir", exact: true }).click();
    const warning = tablet.getByRole("dialog", { name: "Ventas sin enviar" });
    await expect(warning).toContainText(
      "Hay 1 ventas guardadas en este dispositivo que aún no se envían.",
    );
    await tablet.screenshot({ path: "docs/evidence/access-unsent-logout-1440.png" });
    await warning
      .getByRole("button", { name: "Salir de todos modos", exact: true })
      .click();
    await expect(
      tablet.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    const [ended] =
      await admin`select end_reason,revoked from sessions where id=${first.id}`;
    expect(ended).toEqual({ end_reason: "logout", revoked: false });
    await tablet.unroute("**/api/sync");
    // The same employee returns on the same device: the queued sale syncs.
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(
      tablet.getByRole("button", { name: "Conectado", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // This exact queued sale synced under the cashier, not a reconciliation.
    await expect
      .poll(
        async () =>
          (await admin`select kind from operations where id=${sale.id}`)[0]
            ?.kind ?? null,
        { timeout: 30_000 },
      )
      .toBe("offline_sync");
    const [created] =
      await admin`select o.employee_id,o.channel from operations op
        join orders o on o.tenant_id=op.tenant_id and o.id=(op.result->>'id')::uuid
        where op.id=${sale.orderOperationId}`;
    expect(created).toEqual({
      employee_id: first.employeeId,
      channel: "offline",
    });
    const [recovered] =
      await admin`select count(*)::int as n from offline_recoveries where operation_id=${sale.id}`;
    expect(recovered.n).toBe(0);
    await expect
      .poll(async () => (await queuedSales(tablet)).find((r) => r.id === sale.id)?.status)
      .toBe("synced");
    await context.close();
  } finally {
    await admin.end();
  }
});

test("offline logout signs out locally and completes on reconnect (SEC-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Sin red ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const s = await sessionOf(tablet);
    await context.setOffline(true);
    await tablet.getByRole("button", { name: "Salir", exact: true }).click();
    const offline = tablet.getByRole("dialog", { name: "Sin conexión" });
    await expect(offline).toContainText(
      "Si sales ahora, nadie podrá entrar en este dispositivo hasta que vuelva la conexión.",
    );
    await expect(
      offline.getByRole("button", { name: "Bloquear pantalla" }),
    ).toBeVisible();
    await offline
      .getByRole("button", { name: "Salir de todos modos", exact: true })
      .click();
    await expect(tablet.locator(".scope")).toHaveCount(0);
    // The gate says why nobody can sign in now, not a generic error.
    await expect(
      tablet.getByText(
        "Sin conexión. Para entrar en este dispositivo hace falta conexión; esta pantalla se actualiza sola cuando vuelva.",
      ),
    ).toBeVisible();
    await expect(tablet.getByText("No se pudo completar la acción.")).toHaveCount(
      0,
    );
    expect(
      await tablet.evaluate(() => localStorage.getItem("gm-logout-pending")),
    ).toBe(s.id);
    const [before] = await admin`select ended_at from sessions where id=${s.id}`;
    expect(before.ended_at).toBeNull();
    await context.setOffline(false);
    await expect
      .poll(() =>
        tablet.evaluate(() => localStorage.getItem("gm-logout-pending")),
      )
      .toBeNull();
    const [after] =
      await admin`select end_reason,revoked from sessions where id=${s.id}`;
    expect(after).toEqual({ end_reason: "logout", revoked: false });
    // Back online, the roster appears without pressing anything.
    await expect(
      tablet.getByRole("heading", { name: "¿Quién entra?", exact: true }),
    ).toBeVisible();
    await context.close();
  } finally {
    await admin.end();
  }
});

test("staff: edit role, lock by wrong PINs, unlock, reset PIN, deactivate revokes the open session (SEC-3/SEC-2)", async ({
  page,
  browser,
}) => {
  const id = tag();
  const name = `Mesero ${id}`;
  await ownerLogin(page);
  const created = await call(page, "/access/staff", {
    operationId: crypto.randomUUID(),
    name,
    role: "server",
    pin: "135799",
  });
  expect(created.status).toBe(200);
  await page.getByRole("button", { name: "Equipo", exact: true }).click();
  await page.getByRole("button", { name: `Editar ${name}` }).click();
  let edit = page.getByRole("dialog", { name: `Editar a ${name}` });
  await edit.getByLabel("Rol").selectOption({ label: "Cajero" });
  await edit.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(edit.getByRole("alert")).toHaveCount(0);
  await edit.getByRole("button", { name: "Cerrar" }).click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("Cajero");

  // Five wrong PINs lock the employee on this terminal only.
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Bloqueo ${id}`,
  );
  await tablet.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  for (let i = 0; i < 5; i++) {
    await enterSecret(tablet, name, "000000");
    await expect(tablet.getByRole("alert").first()).toBeVisible();
  }
  await expect(tablet.getByText(/Bloqueado en este dispositivo hasta las/)).toBeVisible();
  await expect(tablet.getByLabel(`PIN de ${name}`)).toBeDisabled();

  await page.reload();
  await page.getByRole("button", { name: "Equipo", exact: true }).click();
  await expect(row).toContainText("Bloqueado");
  await expect(row).toContainText(/Bloqueado en 1 dispositivos hasta las/);
  await page.getByRole("button", { name: `Editar ${name}` }).click();
  edit = page.getByRole("dialog", { name: `Editar a ${name}` });
  await edit.getByRole("button", { name: "Desbloquear" }).click();
  await expect(
    page.locator(".staff-management").getByRole("status"),
  ).toContainText(`${name} se desbloqueó.`);
  await edit.getByRole("button", { name: "Cerrar" }).click();

  await tablet.getByRole("button", { name: "Elegir a otra persona" }).click();
  await tablet.reload();
  await signIn(tablet, name, "135799");
  await expect(tablet.locator(".scope")).toContainText(name);

  // Resetting the PIN ends the open session (not revoked).
  await page.getByRole("button", { name: `Editar ${name}` }).click();
  edit = page.getByRole("dialog", { name: `Editar a ${name}` });
  await edit.getByLabel("PIN nuevo (6 a 8 dígitos)").fill("246802");
  await edit.getByLabel("Confirma el PIN").fill("246802");
  await edit.getByRole("button", { name: "Guardar PIN" }).click();
  await expect(
    page.locator(".staff-management").getByRole("status"),
  ).toContainText(`PIN actualizado. Las sesiones abiertas de ${name} se cerraron.`);
  await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
  const ended = tablet.getByRole("dialog", {
    name: "La sesión se cerró en este dispositivo. Ingresa tu PIN para continuar.",
  });
  await expect(ended).toBeVisible();
  await enterSecret(ended, name, "246802");
  await expect(ended).toBeHidden();

  // Deactivation revokes the open session everywhere.
  await page.getByRole("button", { name: "Desactivar empleado" }).click();
  const confirm = page.getByRole("dialog", { name: "Desactivar empleado" });
  await expect(confirm).toContainText(
    `${name} ya no podrá entrar en ningún dispositivo y se cerrarán sus sesiones abiertas.`,
  );
  await confirm.getByRole("button", { name: "Desactivar empleado" }).click();
  await expect(
    page.locator(".staff-management").getByRole("status"),
  ).toContainText(`${name} se desactivó`);
  await page.screenshot({ path: "docs/evidence/access-staff-edit-1440.png" });
  await edit.getByRole("button", { name: "Cerrar" }).click();
  await expect(row).toContainText("Inactivo");
  await tablet.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(
    tablet.getByRole("dialog", {
      name: "Un responsable cerró esta sesión o desactivó al empleado.",
    }),
  ).toBeVisible();
  await context.close();
});

test("devices: rename, end session, unpair shows the pairing screen on that terminal (SEC-5)", async ({
  page,
  browser,
}) => {
  const id = tag();
  await ownerLogin(page);
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Barra ${id}`,
  );
  await signIn(tablet, CASHIER.name, CASHIER.pin);
  await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
  await page.getByRole("button", { name: "Configuración", exact: true }).click();
  const device = page.locator(".device-row").filter({ hasText: `Barra ${id}` });
  // The code's creator is shown, so a fired manager's terminals can be reviewed (ACC-R6-2).
  await expect(device).toContainText("Terminal compartida · Vinculado por Alex Demo");
  await expect(device).toContainText(`En uso por ${CASHIER.name}`);
  await expect(
    page.locator(".device-row").filter({ hasText: "Este dispositivo" }),
  ).toHaveCount(1);
  await checkLayout(page, "devices", ".device-management");

  await device.getByRole("button", { name: `Editar · Barra ${id}` }).click();
  const edit = page.getByRole("dialog", { name: `Editar «Barra ${id}»` });
  await edit.getByLabel("Nombre del dispositivo").fill(`Barra norte ${id}`);
  await edit.getByLabel("Bloqueo automático").selectOption({ label: "5 min" });
  await edit.getByRole("button", { name: "Guardar cambios" }).click();
  const renamed = page
    .locator(".device-row")
    .filter({ hasText: `Barra norte ${id}` });
  await expect(renamed).toBeVisible();

  await renamed
    .getByRole("button", { name: `Cerrar sesión · Barra norte ${id}` })
    .click();
  await expect(
    page.locator(".device-management").getByRole("status"),
  ).toContainText(`Se cerró la sesión en «Barra norte ${id}».`);
  await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
  const ended = tablet.getByRole("dialog", {
    name: "La sesión se cerró en este dispositivo. Ingresa tu PIN para continuar.",
  });
  await expect(ended).toBeVisible();
  await enterSecret(ended, CASHIER.name, CASHIER.pin);
  await expect(ended).toBeHidden();
  const s = await sessionOf(tablet);
  expect(s.access.idleLockSeconds).toBe(300);
  expect(s.access.deviceName).toBe(`Barra norte ${id}`);

  await renamed
    .getByRole("button", { name: `Desvincular · Barra norte ${id}` })
    .click();
  const revoke = page.getByRole("dialog", { name: "Desvincular" });
  await expect(revoke).toContainText(
    `«Barra norte ${id}» dejará de funcionar de inmediato y se cerrarán sus sesiones.`,
  );
  await revoke.getByRole("button", { name: "Desvincular", exact: true }).click();
  await expect(
    page.locator(".device-management").getByRole("status"),
  ).toContainText(`«Barra norte ${id}» se desvinculó.`);
  await tablet.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(
    tablet.getByText(
      "Este dispositivo fue desvinculado o su vinculación venció. Pide un código nuevo a un responsable.",
    ),
  ).toBeVisible();
  await expect(
    tablet.getByRole("heading", { name: "Vincular este dispositivo" }),
  ).toBeVisible();
  await context.close();
});

test("step-up: a refund on a terminal after the window asks for the PIN and records exactly one refund (SEC-6)", async ({
  page,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const name = `Paso ${tag()}`;
  try {
    await ownerLogin(page);
    const s = await sessionOf(page);
    expect(s.access.deviceKind).toBe("terminal");
    const drawer = await call(page, "/cash");
    if (!drawer.body || drawer.body.closed_at)
      expect(
        (await call(page, "/cash/open", {
          operationId: crypto.randomUUID(),
          opening: 0,
        })).status,
      ).toBe(200);
    const catalog = (await call<any[]>(page, "/catalog")).body;
    const product = catalog.find((p) => p.name.es === "Taco de hongos");
    const order = await call(page, "/orders", {
      operationId: crypto.randomUUID(),
      lines: [
        { id: crypto.randomUUID(), productId: product.id, quantity: 1, options: [], note: "" },
      ],
      mode: "takeaway",
      tableId: null,
      name,
      note: "",
      channel: "pos",
    });
    expect(order.status).toBe(200);
    const paid = await call(page, `/orders/${order.body.id}/payments`, {
      operationId: crypto.randomUUID(),
      amount: order.body.total,
      tip: 0,
      received: order.body.total,
      method: "cash",
    });
    expect(paid.status).toBe(200);
    await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${s.id}`;
    await page.getByRole("button", { name: "Operación", exact: true }).click();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const card = page.locator(".order-summary").filter({ hasText: name }).first();
    await card.getByRole("button", { name: "Reembolsar", exact: true }).click();
    const refund = page.getByRole("dialog").first();
    await refund.getByLabel("Importe", { exact: true }).fill("10");
    await refund.getByLabel("Explicación").fill("Devolución con confirmación");
    await refund.getByRole("button", { name: "Guardar", exact: true }).click();
    const stepUp = page.getByRole("dialog", { name: "Confirma con tu PIN" });
    await expect(stepUp).toContainText(
      "Esta acción necesita que confirmes que eres Alex Demo.",
    );
    await page.screenshot({ path: "docs/evidence/access-step-up-1440.png" });
    await enterSecret(stepUp, "Alex Demo", OWNER_PASSWORD, true, "Confirmar");
    await expect(stepUp).toBeHidden();
    await expect(card).toContainText("Reembolsado");
    const [refunds] =
      await admin`select count(*)::int as n from refunds r join tenders t on t.tenant_id=r.tenant_id and t.id=r.tender_id
        where t.order_id=${order.body.id}`;
    expect(refunds.n).toBe(1);
  } finally {
    await admin.end();
  }
});

test("expiry banner appears 30 minutes before the absolute cap and Renovar keeps the cart", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Renovar ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const s = await sessionOf(tablet);
    await admin`update sessions set absolute_expires_at=now()+interval '20 minutes',
      expires_at=least(expires_at,now()+interval '20 minutes') where id=${s.id}`;
    await tablet.reload();
    await tablet.getByRole("button", { name: /Taco de hongos/ }).click();
    await expect(tablet.locator(".cart")).toContainText("Taco de hongos");
    const banner = tablet.locator(".expiry-banner");
    await expect(banner).toContainText(
      `La sesión de ${CASHIER.name} termina a las`,
    );
    await tablet.screenshot({ path: "docs/evidence/access-expiry-banner-1440.png" });
    await banner.getByRole("button", { name: "Renovar ahora" }).click();
    const lock = tablet.getByRole("dialog", {
      name: `Renueva la sesión de ${CASHIER.name}`,
    });
    await enterSecret(lock, CASHIER.name, CASHIER.pin);
    await expect(lock).toBeHidden();
    await expect(banner).toHaveCount(0);
    await expect(tablet.locator(".cart")).toContainText("Taco de hongos");
    const renewed = await sessionOf(tablet);
    expect(renewed.id).not.toBe(s.id);
    expect(
      new Date(renewed.access.absoluteExpiresAt).getTime() - Date.now(),
    ).toBeGreaterThan(15 * 3600_000);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("an unlock made elsewhere re-enables the lock screen's keypad by itself, and Comprobar de nuevo asks at once (ACC-FLOOR-3)", async ({
  page,
  browser,
}) => {
  await ownerLogin(page);
  const code = await newCode(page, `Desbloqueo remoto ${tag()}`);
  const context = await browser.newContext();
  const tablet = await context.newPage();
  await tablet.clock.install();
  await pair(tablet, code);
  await signIn(tablet, CASHIER.name, CASHIER.pin);
  await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
  const s = await sessionOf(tablet);
  const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
  const pinField = lock.getByLabel(`PIN de ${CASHIER.name}`);
  const lockOut = async () => {
    await tablet.getByRole("button", { name: "Bloquear pantalla" }).click();
    await expect(lock).toBeVisible();
    for (let i = 0; i < 5; i++) {
      await enterSecret(lock, CASHIER.name, "000000");
      await expect(lock.getByRole("alert")).toBeVisible();
    }
    await expect(pinField).toBeDisabled();
    await expect(
      lock.getByText(/Bloqueado en este dispositivo hasta las/),
    ).toBeVisible();
  };
  const unlockElsewhere = async () =>
    expect(
      (
        await call(page, `/access/staff/${s.employeeId}/unlock`, {
          operationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
  // 1. No input on the tablet: the next roster refresh re-enables the keypad.
  await lockOut();
  await unlockElsewhere();
  await tablet.clock.fastForward("00:21");
  await expect(pinField).toBeEnabled();
  await enterSecret(lock, CASHIER.name, CASHIER.pin);
  await expect(lock).toBeHidden();
  // 2. "Comprobar de nuevo" asks right away.
  await lockOut();
  await unlockElsewhere();
  await lock.getByRole("button", { name: "Comprobar de nuevo" }).click();
  await expect(pinField).toBeEnabled();
  await enterSecret(lock, CASHIER.name, CASHIER.pin);
  await expect(lock).toBeHidden();
  expect((await sessionOf(tablet)).id).toBe(s.id);
  await context.close();
});

test("a renewal can be put off, and an unreachable server shows the offline lock with Continuar como until it answers again (ACC-FLOOR-6)", async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    await ownerLogin(page);
    const { context, page: tablet } = await pairTerminal(
      browser,
      page,
      `Renovar luego ${tag()}`,
    );
    await signIn(tablet, CASHIER.name, CASHIER.pin);
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    const s = await sessionOf(tablet);
    await admin`update sessions set absolute_expires_at=now()+interval '20 minutes',
      expires_at=least(expires_at,now()+interval '20 minutes') where id=${s.id}`;
    await tablet.reload();
    await tablet.getByRole("button", { name: /Taco de hongos/ }).click();
    const cart = tablet.locator(".cart");
    await expect(cart).toContainText("Taco de hongos");
    const banner = tablet.locator(".expiry-banner");
    const renew = tablet.getByRole("dialog", {
      name: `Renueva la sesión de ${CASHIER.name}`,
    });
    // "Ahora no": the session is still valid, so the prompt simply closes.
    await banner.getByRole("button", { name: "Renovar ahora" }).click();
    await expect(renew).toBeVisible();
    await renew.getByRole("button", { name: "Ahora no" }).click();
    await expect(renew).toBeHidden();
    await expect(banner).toBeVisible();
    await expect(cart).toContainText("Taco de hongos");
    expect((await sessionOf(tablet)).id).toBe(s.id);
    // A put-off renewal is not remembered by a reload.
    await tablet.reload();
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    await expect(renew).toHaveCount(0);
    // The device reports a connection but the server cannot be reached.
    await banner.getByRole("button", { name: "Renovar ahora" }).click();
    await expect(renew).toBeVisible();
    // Every server call fails, offline's /api/offline/ping heartbeat included
    // (since offline 026 it decides reachability, not /api/health).
    await tablet.route("**/api/**", (r) => r.abort("internetdisconnected"));
    await enterSecret(renew, CASHIER.name, CASHIER.pin);
    await expect(renew).toContainText(
      `Sin conexión no se puede verificar el PIN. Las ventas se registran a nombre de ${CASHIER.name}.`,
    );
    await expect(renew.getByText("No se pudo completar la acción.")).toHaveCount(0);
    await renew
      .getByRole("button", { name: `Continuar como ${CASHIER.name}` })
      .click();
    await expect(renew).toBeHidden();
    await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
    // The server answers again: the renewal prompt comes back by itself.
    await tablet.unroute("**/api/**");
    await expect(renew).toBeVisible({ timeout: 20_000 });
    await enterSecret(renew, CASHIER.name, CASHIER.pin);
    await expect(renew).toBeHidden();
    await expect(banner).toHaveCount(0);
    expect((await sessionOf(tablet)).id).not.toBe(s.id);
    await context.close();
  } finally {
    await admin.end();
  }
});

test("a soft unlock that began with the server unreachable never works online: the first call once it answers brings the lock back, unsent (ACC-R-2)", async ({
  page,
  browser,
}) => {
  await ownerLogin(page);
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Sin internet ${tag()}`,
  );
  await signIn(tablet, CASHIER.name, CASHIER.pin);
  await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
  const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
  await tablet.getByRole("button", { name: "Bloquear pantalla" }).click();
  await expect(lock).toBeVisible();
  // The router is up but the internet is down: navigator.onLine stays true.
  // Every server call fails, offline's /api/offline/ping heartbeat included
  // (since offline 026 it decides reachability, not /api/health).
  await tablet.route("**/api/**", (r) => r.abort("internetdisconnected"));
  await enterSecret(lock, CASHIER.name, CASHIER.pin);
  await expect(lock).toContainText(
    `Sin conexión no se puede verificar el PIN. Las ventas se registran a nombre de ${CASHIER.name}.`,
  );
  await lock
    .getByRole("button", { name: `Continuar como ${CASHIER.name}` })
    .click();
  await expect(lock).toBeHidden();
  const sent: string[] = [];
  tablet.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/orders")
      sent.push(request.method());
  });
  // The internet comes back before the background probe notices.
  await tablet.unroute("**/api/**");
  // Opening Órdenes is online work: it is refused unsent and the lock returns.
  // (If a background call re-locked first, the lock blocks the click.)
  await tablet
    .getByRole("button", { name: "Órdenes", exact: true })
    .click({ timeout: 5_000 })
    .catch(() => {});
  await expect(lock).toBeVisible({ timeout: 5_000 });
  await expect(
    lock.getByLabel(`PIN de ${CASHIER.name}`),
  ).toBeVisible();
  expect(sent).toEqual([]);
  await enterSecret(lock, CASHIER.name, CASHIER.pin);
  await expect(lock).toBeHidden();
  await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
  await context.close();
});

test("a dialog opened after the lock stays below it, inert, until the PIN unlocks (ACC-FLOOR-9)", async ({
  page,
  browser,
}) => {
  await ownerLogin(page);
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Encima ${tag()}`,
  );
  await signIn(tablet, CASHIER.name, CASHIER.pin);
  await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
  await tablet.getByRole("button", { name: "Bloquear pantalla" }).click();
  const lock = tablet.getByRole("dialog", { name: "Pantalla bloqueada" });
  await expect(lock).toBeVisible();
  // A request that resolves late opens a dialog (a receipt) after the lock.
  await tablet.evaluate(() => {
    const late = document.createElement("dialog");
    late.id = "late-dialog";
    late.innerHTML = "<p>Recibo</p><button>Imprimir</button>";
    document.body.append(late);
    late.showModal();
  });
  const state = () =>
    tablet.evaluate(() => {
      const late = document.getElementById("late-dialog") as HTMLDialogElement;
      const r = late.getBoundingClientRect();
      const top = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return {
        inert: late.inert,
        lockOnTop: Boolean(top?.closest("dialog.lock-screen")),
      };
    });
  await expect.poll(state).toEqual({ inert: true, lockOnTop: true });
  await enterSecret(lock, CASHIER.name, CASHIER.pin);
  await expect(lock).toBeHidden();
  expect((await state()).inert).toBe(false);
  await context.close();
});

test("unpairing a device whose drawer opened after the list loaded asks for the drawer confirmation in place (ACC-FLOOR-11/ACC-FLOOR-7)", async ({
  page,
  browser,
}) => {
  const id = tag();
  await ownerLogin(page);
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Caja tarde ${id}`,
  );
  await signIn(tablet, CASHIER.name, CASHIER.pin);
  await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
  await page.getByRole("button", { name: "Configuración", exact: true }).click();
  const device = page
    .locator(".device-row")
    .filter({ hasText: `Caja tarde ${id}` });
  await expect(device).toBeVisible();
  // The cashier opens a drawer after the manager loaded the list.
  expect(
    (
      await call(tablet, "/cash/open", {
        operationId: crypto.randomUUID(),
        opening: 0,
      })
    ).status,
  ).toBe(200);
  await device
    .getByRole("button", { name: `Desvincular · Caja tarde ${id}` })
    .click();
  const revoke = page.getByRole("dialog", { name: "Desvincular" });
  await expect(revoke.getByRole("checkbox")).toHaveCount(0);
  const confirm = revoke.getByRole("button", { name: "Desvincular", exact: true });
  await confirm.click();
  await expect(revoke.getByRole("alert")).toContainText(
    "Este dispositivo tiene una caja abierta. Lee el aviso y confírmalo para desvincularlo.",
  );
  // The notice says honestly what happens to the drawer.
  await expect(revoke).toContainText(
    "por ahora ningún dispositivo puede cerrarla: cuenta el efectivo, guarda el conteo y pide a soporte que la cierre.",
  );
  await expect(confirm).toBeDisabled();
  await revoke
    .getByRole("checkbox", {
      name: "Entiendo que la caja queda abierta y que soporte la cerrará con mi conteo.",
    })
    .check();
  await confirm.click();
  await expect(
    page.locator(".device-management").getByRole("status"),
  ).toContainText(`«Caja tarde ${id}» se desvinculó.`);
  await context.close();
});

test("the void approval explains a manager list that failed to load and Reintentar fills it (ACC-FLOOR-10)", async ({
  page,
  browser,
}) => {
  const name = `Sin lista ${tag()}`;
  await ownerLogin(page);
  const catalog = (await call<any[]>(page, "/catalog")).body;
  const product = catalog.find((p) => p.name.es === "Taco de hongos");
  const order = await call(page, "/orders", {
    operationId: crypto.randomUUID(),
    lines: [
      { id: crypto.randomUUID(), productId: product.id, quantity: 2, options: [], note: "" },
    ],
    mode: "takeaway",
    tableId: null,
    name,
    note: "",
    channel: "pos",
  });
  expect(order.status).toBe(200);
  const { context, page: tablet } = await pairTerminal(
    browser,
    page,
    `Anular ${tag()}`,
  );
  await signIn(tablet, CASHIER.name, CASHIER.pin);
  await expect(tablet.locator(".scope")).toContainText(CASHIER.name);
  await tablet.route("**/api/access/approvers", (r) =>
    r.abort("internetdisconnected"),
  );
  await tablet.getByRole("button", { name: "Órdenes", exact: true }).click();
  await tablet
    .locator(".order-summary")
    .filter({ hasText: name })
    .getByRole("button", { name: "Anular", exact: true })
    .click();
  const dialog = tablet.getByRole("dialog", { name: "Anular productos" });
  const approval = dialog.locator(".manager-approval");
  await expect(approval.getByRole("alert")).toContainText(
    "No se pudo cargar la lista de gerentes.",
  );
  await tablet.unroute("**/api/access/approvers");
  await approval.getByRole("button", { name: "Reintentar" }).click();
  await expect(approval.getByRole("alert")).toHaveCount(0);
  await expect(approval.getByLabel("Gerente que autoriza")).toContainText(
    "Alex Demo",
  );
  await context.close();
});

test("a session ended while the PIN confirmation is open shows its lock instead of a looping PIN error (ACC-FLOOR-12)", async ({
  page,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const name = `Confirmación ${tag()}`;
  try {
    await ownerLogin(page);
    const s = await sessionOf(page);
    const drawer = await call(page, "/cash");
    if (!drawer.body || drawer.body.closed_at)
      expect(
        (await call(page, "/cash/open", {
          operationId: crypto.randomUUID(),
          opening: 0,
        })).status,
      ).toBe(200);
    const catalog = (await call<any[]>(page, "/catalog")).body;
    const product = catalog.find((p) => p.name.es === "Taco de hongos");
    const order = await call(page, "/orders", {
      operationId: crypto.randomUUID(),
      lines: [
        { id: crypto.randomUUID(), productId: product.id, quantity: 1, options: [], note: "" },
      ],
      mode: "takeaway",
      tableId: null,
      name,
      note: "",
      channel: "pos",
    });
    expect(order.status).toBe(200);
    const paid = await call(page, `/orders/${order.body.id}/payments`, {
      operationId: crypto.randomUUID(),
      amount: order.body.total,
      tip: 0,
      received: order.body.total,
      method: "cash",
    });
    expect(paid.status).toBe(200);
    await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${s.id}`;
    await page.getByRole("button", { name: "Operación", exact: true }).click();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const card = page.locator(".order-summary").filter({ hasText: name }).first();
    await card.getByRole("button", { name: "Reembolsar", exact: true }).click();
    const refund = page.getByRole("dialog").first();
    await refund.getByLabel("Importe", { exact: true }).fill("10");
    await refund.getByLabel("Explicación").fill("Devolución interrumpida");
    await refund.getByRole("button", { name: "Guardar", exact: true }).click();
    const stepUp = page.getByRole("dialog", { name: "Confirma con tu PIN" });
    await expect(stepUp).toBeVisible();
    // A manager closes this session from another device meanwhile.
    await admin`update sessions set ended_at=now(),end_reason='ended_by_manager',expires_at=now() where id=${s.id}`;
    await enterSecret(stepUp, "Alex Demo", OWNER_PASSWORD, true, "Confirmar");
    await expect(stepUp).toBeHidden();
    await expect(
      page.getByRole("dialog", {
        name: "La sesión se cerró en este dispositivo. Ingresa tu PIN para continuar.",
      }),
    ).toBeVisible();
    const [refunds] =
      await admin`select count(*)::int as n from refunds r join tenders t on t.tenant_id=r.tenant_id and t.id=r.tender_id
        where t.order_id=${order.body.id}`;
    expect(refunds.n).toBe(0);
  } finally {
    await admin.end();
  }
});
