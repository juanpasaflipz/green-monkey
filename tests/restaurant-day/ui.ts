/**
 * Restaurant-day helpers (specs/acceptance.md §2 ui.ts): devices, the tap
 * counter, parseMxn, checkpoint() (G3 + G4 scanners, axe and overflow at three
 * sizes, screenshots), print capture, the PIN-rate ledger, the step-up and idle
 * oracles, and the run artifacts (§13.3).
 */
import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EDGE_HEADERS, OUT } from "./env.js";

// ------------------------------------------------------------------ money

/** §5.3: "$1,234.50", "−$45.00", "-$20.00" → centavos; anything else fails. */
export function parseMxn(text: string): number {
  const t = text.replace(/\u00a0|\u202f/g, " ").trim();
  const m = /^([−-])?\s*\$\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(t);
  if (!m) throw Error(`parseMxn: not an amount: ${JSON.stringify(text)}`);
  const value = Number(m[2]!.replace(/,/g, "")) * 100 + Number(m[3]);
  return m[1] ? -value : value;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ----------------------------------------------------------------- devices

export type DeviceName =
  | "ownerA"
  | "cajaA"
  | "cocinaA"
  | "respaldoA"
  | "ownerB"
  | "cajaB"
  | "sofiaB"
  | "tomasB"
  | "cocinaB"
  | "probe"
  | "probe2";

type Spec = { width: number; height: number; tz: string; skew?: number; clock?: "install" };
export const DEVICE_SPECS: Record<DeviceName, Spec> = {
  ownerA: { width: 1440, height: 900, tz: "America/Mexico_City" },
  cajaA: { width: 1024, height: 768, tz: "America/Mexico_City", skew: 180_000, clock: "install" },
  cocinaA: { width: 1024, height: 768, tz: "America/Mexico_City", clock: "install" },
  respaldoA: { width: 1024, height: 768, tz: "America/Mexico_City" },
  ownerB: { width: 1440, height: 900, tz: "America/Tijuana" },
  cajaB: { width: 1024, height: 768, tz: "America/Tijuana" },
  sofiaB: { width: 390, height: 844, tz: "America/Tijuana" },
  tomasB: { width: 390, height: 844, tz: "America/Tijuana" },
  cocinaB: { width: 768, height: 1024, tz: "America/Tijuana" },
  probe: { width: 1024, height: 768, tz: "America/Mexico_City" },
  probe2: { width: 1024, height: 768, tz: "America/Mexico_City" },
};

/** The device context, created on first use (one per physical device, §3.4). */
export type Devices = (name: DeviceName) => Promise<Device>;

export type ResponseEntry = { at: number; method: string; url: string; status: number; injected: boolean; requestId?: string };
export type Device = {
  name: DeviceName;
  context: BrowserContext;
  page: Page;
  skew: number;
  spec: Spec;
  /** G4 records */
  responses: ResponseEntry[];
  /** aborted/failed requests while an outage route is active are expected */
  outage: boolean;
  injected: WeakSet<Request>;
  lastInputAt: number;
  /** requests in flight (advance() lets them finish before each step) */
  pending: number;
  inFlight?: Map<Request, number>;
};

export const run = {
  violations: [] as string[],
  /** step-scoped allowed refusals: method, url pattern, status */
  allowed: [] as Array<{ method: string; url: RegExp; status: number }>,
  step: "setup",
  pinLedger: [] as number[],
  lastAuthAt: {} as Record<string, number>,
  stepUpDialogs: 0,
  taps: 0,
  timing: [] as Array<Record<string, unknown>>,
  actual: [] as Array<{ step: string; what: string; expected: unknown; actual: unknown }>,
  prints: 0,
  seenKds: { A: new Set<string>(), B: new Set<string>() },
  /** RD_SOFT findings so far */
  soft: 0,
  /** CFDI branch of this run (§3.3): N without a Facturapi test key, K with one */
  branch: "N" as "N" | "K",
};

/** Boot refusals every signed-out or unpaired device makes (§4.4). */
const BOOT_REFUSALS = [
  { method: "GET", url: /\/api\/session$/, status: 401 },
  { method: "GET", url: /\/api\/auth\/account$/, status: 401 },
];

export function violation(text: string) {
  run.violations.push(`[${run.step}] ${text}`);
}

export async function newDevice(
  browser: Browser,
  name: DeviceName,
  baseURL: string,
  storageState?: string,
): Promise<Device> {
  const spec = DEVICE_SPECS[name];
  const context = await browser.newContext({
    baseURL,
    viewport: { width: spec.width, height: spec.height },
    locale: "es-MX",
    timezoneId: spec.tz,
    permissions: ["clipboard-read", "clipboard-write"],
    extraHTTPHeaders: EDGE_HEADERS,
    ...(storageState ? { storageState } : {}),
  });
  await context.addInitScript(() => {
    (window as any).__gmPrints = [];
    window.print = () => {
      const root = document.getElementById("print-root");
      (window as any).__gmPrints.push({
        at: Date.now(),
        text: root?.innerText ?? "",
        html: root?.innerHTML ?? "",
      });
    };
  });
  const device: Device = {
    name,
    context,
    page: undefined as unknown as Page,
    skew: spec.skew ?? 0,
    spec,
    responses: [],
    outage: false,
    injected: new WeakSet(),
    lastInputAt: Date.now(),
    pending: 0,
  };
  if (spec.clock === "install") await context.clock.install({ time: Date.now() + device.skew });
  const page = await context.newPage();
  device.page = page;
  page.on("pageerror", (e) => violation(`${name} pageerror: ${e.message}`));
  // API calls in flight (advance() lets them finish before each clock step).
  const inFlight = new Map<Request, number>();
  const api = (req: Request) =>
    ["fetch", "xhr"].includes(req.resourceType()) && new URL(req.url()).pathname.startsWith("/api/");
  page.on("request", (req) => {
    if (api(req)) inFlight.set(req, Date.now());
    device.pending = inFlight.size;
  });
  const settled = (req: Request) => {
    inFlight.delete(req);
    device.pending = inFlight.size;
  };
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  device.inFlight = inFlight;
  page.on("response", async (response) => {
    const request = response.request();
    const entry: ResponseEntry = {
      at: Date.now(),
      method: request.method(),
      url: response.url(),
      status: response.status(),
      injected: device.injected.has(request),
    };
    device.responses.push(entry);
    if (!new URL(entry.url).pathname.startsWith("/api/")) return;
    if (entry.status === 429) violation(`${name} 429 ${entry.method} ${entry.url}`);
    if (entry.status >= 500 && !entry.injected)
      violation(`${name} ${entry.status} ${entry.method} ${entry.url}`);
    if (entry.status >= 400 && !entry.injected) {
      const type = response.headers()["content-type"] ?? "";
      if (type.includes("json")) {
        const body = await response.json().catch(() => null);
        if (!body?.requestId)
          violation(`${name} ${entry.status} without requestId ${entry.method} ${entry.url}`);
        entry.requestId = body?.requestId;
      }
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const url = message.location().url ?? "";
    const status = /status of (\d{3})/.exec(text)?.[1];
    if (/net::ERR_|Failed to fetch|NetworkError/.test(text) && device.outage) return;
    if (status) {
      const s = Number(status);
      const seen = [...device.responses].reverse().find((r) => r.url === url && r.status === s);
      if (seen?.injected) return;
      const allowed = [...BOOT_REFUSALS, ...run.allowed].some(
        (a) => a.status === s && a.url.test(new URL(url).pathname) && (!seen || seen.method === a.method),
      );
      if (allowed && seen) return;
    }
    violation(`${name} console.error: ${text} @ ${url}`);
  });
  return device;
}

/** Runs `fn` with deliberate refusals allowed (G4 per-step allowlist). */
export async function allowing<T>(
  entries: Array<{ method: string; url: RegExp; status: number }>,
  fn: () => Promise<T>,
): Promise<T> {
  run.allowed.push(...entries);
  try {
    return await fn();
  } finally {
    // Chromium logs the console line right after the response: let it arrive.
    await new Promise((r) => setTimeout(r, 300));
    for (const e of entries) run.allowed.splice(run.allowed.indexOf(e), 1);
  }
}

export function assertNoViolations() {
  const v = run.violations.splice(0);
  findings(v, "G4 runtime violations");
}

// ------------------------------------------------------- findings and waivers

/**
 * Local triage only (RD_SOFT=1): checkpoint findings (G3, G4, axe, overflow)
 * are collected in soft-findings.txt instead of stopping the chain, so one run
 * lists every screen's problems. It is never a pass: the suite fails at the
 * end while any soft finding exists, and CI refuses the switch.
 */
export const SOFT = process.env.RD_SOFT === "1";
if (SOFT && process.env.CI)
  throw Error("RD_SOFT is a local triage mode; CI never sets it");

export function findings(problems: unknown[], what: string) {
  if (!problems.length) return;
  if (SOFT) {
    for (const p of problems)
      appendFileSync(
        resolve(OUT, "soft-findings.txt"),
        `[${run.step}] ${what}: ${typeof p === "string" ? p : JSON.stringify(p)}\n`,
      );
    run.soft += problems.length;
    return;
  }
  expect(problems, what).toEqual([]);
}

/** §13.5: never waivable (money, folio, tenant isolation, offline exactly-once). */
export const NEVER_WAIVE = new Set([
  "MON-1",
  "MON-3",
  "MON-4",
  "FIT-6",
  "FIT-8",
  "OFF-1",
  "OFF-4",
  "OFF-6",
  "OFF-8",
  "CORE-09",
]);

export function waivedIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const ids = (env.RD_WAIVE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const forbidden = ids.filter((id) => NEVER_WAIVE.has(id));
  if (forbidden.length)
    throw Error(`RD_WAIVE: ${forbidden.join(", ")} may never be waived (§13.5)`);
  return ids;
}

/**
 * §13.5: a gated assertion. It always runs; when one of its finding IDs is
 * waived (RD_WAIVE) a failure is recorded as a "waived" annotation with the
 * actual value instead of failing the gate.
 */
export async function guard<T>(ids: string[], fn: () => Promise<T>): Promise<T | undefined> {
  const waived = waivedIds().filter((id) => ids.includes(id));
  if (!waived.length) return fn();
  try {
    return await fn();
  } catch (error) {
    const description = `${waived.join(",")} at ${run.step}: ${(error as Error).message.split("\n")[0]}`;
    test.info().annotations.push({ type: "waived", description });
    appendFileSync(resolve(OUT, "waivers.txt"), waived.join("\n") + "\n");
    return undefined;
  }
}

// --------------------------------------------------------------- G3 scanner

const DENY: RegExp[] = [
  /\b(demo|demostraci[oó]n|ficticio|ficticia|fictional|fixture|placeholder|lorem|ipsum|sample|dummy|sandbox)\b/i,
  /Entorno de prueba|Documentos en borrador|Documento no vigente|Dato pendiente de publicar/,
  /no configurado en este entorno|aún no está configurado en este entorno/,
  /test environment|\(test\)|No real payments|Billing test/i,
  /Casa del Bosque|Jardín Sur|Caja demo|Grupo demo|Alex Demo|Dani Demo|Cocina Demo/,
  /Taco de asada|Taco de hongos|Combo del bosque|Bowl de la casa|Quesadilla de flor|Brownie de cacao|Flan de vainilla|Agua de jamaica|Limonada natural|Tortilla preparada/,
  /10000000-0000-4000-8000-00000000000[0-9]/,
  /demo-green-monkey/,
];
const SPANISH: Array<[string, RegExp]> = [
  ["snake_case code", /\b[a-z]{2,}(?:_[a-z0-9]{2,})+\b/],
  ["untranslated key", /\b(?:access|service|menu|offline|fiscal|discounts|reports|cfdi|account|ops)[A-Z][A-Za-z]+\b/],
  ["template slot", /\{[a-zA-Z]+\}/],
  ["broken value", /\b(undefined|null|NaN)\b|\[object Object\]|Invalid Date/],
  [
    "raw enum",
    /\b(cash|external|dine_in|takeaway|iva16|iva8|iva0|exempt|settled|released|voided|synced|offline_review|recovery_pending|facturapi|provider_not_configured|sandbox_shared|test_mode|live_enabled|cfdi_unavailable)\b/,
  ],
  [
    "English word",
    /\b(Save|Cancel|Close|Submit|Loading|Settings|Orders|Kitchen|Tables|Payment|Refund|Sign in|Sign out|Back|Next|Delete|Edit|Retry|Reload|Error)\b/,
  ],
  ["European money", /\d{1,3}(\.\d{3})+,\d{2}/],
  ["ISO date", /\b\d{4}-\d{2}-\d{2}\b/],
  // ACC-PR-5: times are 24-hour; es-MX's default cycle prints "4:53 p.m.".
  ["12-hour time", /\d\s?[ap]\.\s?m\./i],
];
export const BRANCH_K_ALLOWED = [
  "Entorno de prueba compartido: las facturas usan la organización de prueba de la plataforma y no tienen validez fiscal.",
  "Modo prueba: la factura no tiene validez fiscal.",
  "(modo prueba)",
  "Modo prueba",
  "Organización de prueba",
];
const GENERIC_ERROR = "No se pudo completar la acción.";

export async function scanText(page: Page, id: string, branch: "N" | "K" = run.branch) {
  const found = await page.evaluate(() => {
    const parts: string[] = [document.body.innerText, document.title];
    for (const el of Array.from(document.querySelectorAll("[aria-label],[title],[placeholder],[alt]")))
      for (const a of ["aria-label", "title", "placeholder", "alt"]) {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      }
    for (const o of Array.from(document.querySelectorAll("option"))) parts.push(o.textContent ?? "");
    const quick = Array.from(
      document.querySelectorAll('[role="group"][aria-label="Efectivo recibido rápido"] button'),
    ).map((b) => (b.textContent ?? "").trim());
    const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map(
      (e) => (e as HTMLElement).innerText,
    );
    return { text: parts.join("\n"), lang: document.documentElement.lang, quick, alerts };
  });
  let text = found.text;
  if (branch === "K") for (const s of BRANCH_K_ALLOWED) text = text.split(s).join(" ");
  const problems: string[] = [];
  if (found.lang !== "es") problems.push(`<html lang="${found.lang}">`);
  for (const re of DENY) {
    const m = re.exec(text);
    if (m) problems.push(`denylisted "${m[0]}"`);
  }
  for (const [what, re] of SPANISH) {
    const m = re.exec(text);
    if (m) problems.push(`${what} "${m[0]}" in …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`);
  }
  for (const m of text.matchAll(/\$[\d,]*(?:\.\d+)?/g)) {
    const token = m[0];
    if (/^\$\d{1,3}(,\d{3})*\.\d{2}$/.test(token)) continue;
    if (/^\$\d+$/.test(token) && found.quick.includes(token)) continue;
    problems.push(`money format "${token}"`);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g))
    if (m[1]!.length !== 2 || m[2]!.length !== 2) problems.push(`date format "${m[0]}"`);
  for (const a of found.alerts)
    if (a.includes(GENERIC_ERROR)) problems.push(`generic error alert "${a}"`);
  findings(problems, `G3 ${id}`);
}

// ------------------------------------------------------------ G2 checkpoint

const SIZES: Array<[number, number]> = [
  [1024, 768],
  [768, 1024],
  [390, 844],
];

export async function checkpoint(
  d: Device,
  id: string,
  opts: { axe?: boolean; branch?: "N" | "K"; sizes?: Array<[number, number]>; settle?: Locator } = {},
) {
  const page = d.page;
  await scanText(page, id, opts.branch);
  assertNoViolations();
  if (opts.axe !== false)
    for (const [width, height] of opts.sizes ?? SIZES) {
      await page.setViewportSize({ width, height });
      if (opts.settle) await expect(opts.settle).toBeVisible();
      const fits = await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), {
          message: `${id} @${width}x${height}: horizontal scroll`,
        })
        .toBe(true)
        .then(() => true)
        .catch((error) => {
          if (!SOFT) throw error;
          return false;
        });
      if (!fits)
        findings(
          [`horizontal scroll: ${JSON.stringify(await overflowing(page))}`],
          `${id} @${width}x${height}`,
        );
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      writeFileSync(resolve(OUT, "axe", `${id}-${width}x${height}.json`), JSON.stringify(r.violations, null, 2));
      findings(
        r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) })),
        `${id} @${width}x${height}`,
      );
      await page.screenshot({ path: resolve(OUT, "screens", `${id}-${width}x${height}.png`), fullPage: true });
    }
  await page.setViewportSize({ width: d.spec.width, height: d.spec.height });
  if (opts.settle) await expect(opts.settle).toBeVisible();
}

/** Triage: the innermost elements that stick out past the viewport's right edge. */
export function overflowing(page: Page) {
  return page.evaluate(() => {
    const wide = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter(
      (e) => e.getBoundingClientRect().right > innerWidth + 0.5 && e.getClientRects().length,
    );
    return wide
      .filter((e) => !wide.some((o) => o !== e && e.contains(o)))
      .slice(0, 6)
      .map((e) => {
        const r = e.getBoundingClientRect();
        const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).join(".") : "";
        return `${e.tagName.toLowerCase()}${cls ? "." + cls : ""} [${Math.round(r.left)}-${Math.round(r.right)}] ${(e.innerText ?? "").slice(0, 40)}`;
      });
  });
}

// --------------------------------------------------------------- tap budget

/** §11.1: counts the activation and fails if the target needs scrolling. */
export async function tap(d: Device, target: Locator) {
  // The no-scroll rule is the tablet budget of Caja 1 (§11, FOH-10); phones and
  // the other tablets may scroll to reach a control, as people do.
  if (d.name === "cajaA") await expect(target).toBeInViewport();
  run.taps++;
  d.lastInputAt = Date.now();
  await target.click();
}

/**
 * An action outside the selling flow's tap budget (voids, discounts, refunds,
 * kitchen, setup): counted and timed like a tap, but the browser may scroll
 * a long dialog to reach it, as a person would.
 */
export async function press(d: Device, target: Locator) {
  run.taps++;
  d.lastInputAt = Date.now();
  await target.click();
}

export async function fill(d: Device, target: Locator, value: string) {
  run.taps++;
  d.lastInputAt = Date.now();
  await target.fill(value);
}

// ------------------------------------------------------------ device time

/**
 * Advances a device clock in 3 s steps (§3.5.3). One big jump would turn the
 * requests in flight into 60 s latency samples and mark the connection slow
 * ("Conexión lenta" counts two samples over 4 s); each step stays under that.
 * The app's idle time grows by the same amount (§3.5.5).
 */
export async function advance(d: Device, ms: number) {
  for (let done = 0; done < ms; done += 3_000) {
    // A request in flight across a jump would read as seconds of latency.
    // Only short calls matter; a call open for seconds (GET /api/auth/account on a
    // terminal never reports finished) is not waited for.
    const young = () => [...(d.inFlight ?? new Map()).values()].filter((at) => Date.now() - at < 2_000).length;
    await expect
      .poll(young, { intervals: [25], timeout: 5_000 })
      .toBe(0)
      .catch(() =>
        logLine(
          "advance.log",
          `${d.name}: still in flight at a clock step: ${[...(d.inFlight ?? new Map()).keys()].map((r) => r.method() + " " + new URL(r.url()).pathname).join(", ")}`,
        ),
      );
    await d.context.clock.runFor(Math.min(3_000, ms - done));
  }
  d.lastInputAt -= ms;
}

// ------------------------------------------------------------ prints (§3.4)

export type Print = { at: number; text: string; html: string };
export async function prints(page: Page): Promise<Print[]> {
  return page.evaluate(() => (window as any).__gmPrints as Print[]);
}
/** Waits for print number `count` (1-based) and returns it, saved to prints/. */
export async function nextPrint(page: Page, before: number, label: string): Promise<Print> {
  // Printing waits two animation frames; under CPU load allow more than one expect timeout.
  await expect.poll(async () => (await prints(page)).length, { message: `print ${label}`, timeout: 20_000 }).toBeGreaterThan(before);
  const all = await prints(page);
  const p = all[all.length - 1]!;
  run.prints++;
  writeFileSync(resolve(OUT, "prints", `${String(run.prints).padStart(3, "0")}-${label}.txt`), p.text);
  return p;
}

// ------------------------------------------------------------- PIN ledger

export function notePin() {
  run.pinLedger.push(Date.now());
  const now = Date.now();
  const window = run.pinLedger.filter((t) => now - t < 60_000).length;
  expect(window, "§3.8: at most 20 PIN submissions per 60 s").toBeLessThanOrEqual(20);
}

/** Types a PIN on the keypad of `scope` and submits with `submit`. */
export async function typePin(
  d: Device,
  scope: Page | Locator,
  name: string,
  pin: string,
  submit = "Entrar",
) {
  const input = scope.getByLabel(`PIN de ${name}`, { exact: true });
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "password");
  for (const digit of pin) await scope.getByRole("button", { name: digit, exact: true }).click();
  d.lastInputAt = Date.now();
  notePin();
  await scope.getByRole("button", { name: submit, exact: true }).click();
}

// ------------------------------------------------------------ in-page reads

/**
 * A read through the device's own browser (its Secure session cookies reach
 * http://127.0.0.1 only from the page; Playwright's request client drops them).
 * Reads only: mutations always go through the UI (§3.6).
 */
export async function readApi<T = any>(d: Device, path: string): Promise<{ status: number; body: T }> {
  return d.page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const body: unknown = await r.json().catch(() => null);
    return { status: r.status, body };
  }, path) as Promise<{ status: number; body: T }>;
}

// ---------------------------------------------------------------- artifacts

export function record(what: string, expected: unknown, actual: unknown) {
  run.actual.push({ step: run.step, what, expected, actual });
}

export function writeArtifacts() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "actual.json"), JSON.stringify(run.actual, null, 2));
  writeFileSync(resolve(OUT, "timing.json"), JSON.stringify(run.timing, null, 2));
}

export function logLine(file: string, line: string) {
  appendFileSync(resolve(OUT, file), line + "\n");
}

/** G4: the worker and server log lines written since the last check. */
const logOffsets: Record<string, number> = {};
export function assertLogs() {
  const read = (f: string) => {
    let lines: string[];
    try {
      lines = readFileSync(resolve(OUT, f), "utf8").split("\n");
    } catch {
      return [];
    }
    // The last element is the partial line after the final newline.
    const complete = lines.slice(0, -1);
    const fresh = complete.slice(logOffsets[f] ?? 0);
    logOffsets[f] = complete.length;
    return fresh.filter(Boolean);
  };
  const problems: string[] = [];
  for (const line of read("worker.log")) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.level === "error") problems.push(`worker error: ${line}`);
    if (entry.message === "alert" && !["web_down", "web_recovered"].includes(String(entry.key)))
      problems.push(`worker alert: ${line}`);
  }
  for (const line of read("server.log")) {
    if (/"internal_error"|legal_documents_unpublished|legal_unpublished_signup_ignored/.test(line))
      problems.push(`server: ${line}`);
  }
  findings(problems, "G4 logs");
}
