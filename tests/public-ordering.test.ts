import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/domain";
import {
  acceptInput,
  canonicalRequest,
  dinerRejectReason,
  effectiveHoldState,
  holdActions,
  holdExpiryGraceSeconds,
  holdLabel,
  HOLD_EXPIRY_GRACE_SECONDS,
  linkPath,
  PAID_ACCEPT_GRACE_SECONDS,
  PUBLIC_TOKEN,
  publicOrderInput,
  roundProgress,
  settingsInput,
  type InboxHold,
} from "../shared/public-ordering";
import {
  linkHash,
  linkRef,
  newPublicToken,
  statusHash,
} from "../server/public-tokens";
import { publicKey, scopeKey } from "../server/public-limits";
import { parseDinerLocation } from "../src/features/public/dinerRoute";
import { HoldCard } from "../src/features/public/HoldCard";
import { currentBusinessDate } from "../src/labels";
import { PublicInboxBanner } from "../src/features/public/PublicInboxBanner";
import { KioskDone } from "../src/features/public/KioskDone";
import { DinerStatus } from "../src/features/public/DinerStatus";
import {
  PrivacyNoticeWarning,
  RESTAURANT_PRIVACY_EVENT,
  RESTAURANT_PRIVACY_FIELD,
} from "../src/features/public/PrivacyNoticeWarning";
import { moneyFormatter as menuMoney } from "../src/features/menu/format";

// Receipt.tsx (service's staff money formatter) imports the offline store.
vi.mock("../src/offline", async () => ({
  db: (await import("./offline-fake-db")).fakeDb,
}));

const id = () => crypto.randomUUID();
const token = () => newPublicToken();
const order = (over: Record<string, unknown> = {}) => ({
  operationId: id(),
  statusKey: token(),
  lines: [{ id: id(), productId: id(), quantity: 1, options: [] }],
  expectedTotal: 4500,
  ...over,
});

describe("public ordering tokens and schemas (032)", () => {
  it("the diner's expiry grace is 5 minutes only for a pay-first hold; an accept-policy hold keeps 60 s (PUB-R3-L1)", () => {
    expect(PAID_ACCEPT_GRACE_SECONDS).toBe(300);
    expect(HOLD_EXPIRY_GRACE_SECONDS).toBe(60);
    expect(holdExpiryGraceSeconds("pay_first")).toBe(300);
    expect(holdExpiryGraceSeconds("accept")).toBe(60);
    // The status read uses the same helper for both policies.
    const diner = readFileSync("server/public-diner.ts", "utf8");
    expect(diner).toContain(
      'case when h.policy=\'pay_first\' then ${holdExpiryGraceSeconds("pay_first")}::int else ${holdExpiryGraceSeconds("accept")}::int end',
    );
  });

  it("1. tokens are 22-character base64url and unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = newPublicToken();
      expect(t).toMatch(PUBLIC_TOKEN);
      seen.add(t);
    }
    expect(seen.size).toBe(1000);
  });

  it("2. link and status hashes are domain-separated; legacy signed tokens are not well formed", () => {
    const t = token();
    expect(linkHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(statusHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(linkHash(t)).not.toBe(statusHash(t));
    expect(linkRef(linkHash(t))).toMatch(/^[0-9A-F]{4}$/);
    for (const legacy of [
      "v2.k1.eyJwdXJwb3NlIjoib3JkZXJpbmcifQ.c2ln",
      "eyJwdXJwb3NlIjoib3JkZXJpbmcifQ.c2lnbmF0dXJl",
      t + "=",
      t.slice(1),
      t + "A",
      t.slice(0, -1) + "!",
    ])
      expect(PUBLIC_TOKEN.test(legacy), legacy).toBe(false);
  });

  it("3. the order schema rejects big, open-price and noted lines and trims name and note", () => {
    const bad = [
      order({
        lines: [{ id: id(), productId: id(), quantity: 21, options: [] }],
      }),
      order({
        lines: Array.from({ length: 41 }, () => ({
          id: id(),
          productId: id(),
          quantity: 1,
          options: [],
        })),
      }),
      order({
        lines: [
          {
            id: id(),
            productId: id(),
            quantity: 1,
            options: [],
            openAmount: 1,
          },
        ],
      }),
      order({
        lines: [
          { id: id(), productId: id(), quantity: 1, options: [], note: "x" },
        ],
      }),
      order({ name: "x".repeat(41) }),
      order({ note: "x".repeat(201) }),
      order({ statusKey: "short" }),
      order({ channel: "qr" }),
    ];
    for (const body of bad)
      expect(publicOrderInput.safeParse(body).success).toBe(false);
    const ok = publicOrderInput.parse(
      order({ name: "  Ana  ", note: " sin cebolla " }),
    );
    expect(ok.name).toBe("Ana");
    expect(ok.note).toBe("sin cebolla");
  });

  it("3b. name and note refuse C0/C1 controls, DEL and bidi overrides; the note keeps line feeds and tabs (PUBLIC-SECURITY-1)", () => {
    for (const c of ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085"]) {
      expect(
        publicOrderInput.safeParse(order({ name: `A${c}B` })).success,
      ).toBe(false);
      expect(
        publicOrderInput.safeParse(order({ note: `A${c}B` })).success,
      ).toBe(false);
    }
    for (const c of [
      "\u202a",
      "\u202b",
      "\u202c",
      "\u202d",
      "\u202e",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ]) {
      expect(
        publicOrderInput.safeParse(order({ name: `Q${c}3` })).success,
      ).toBe(false);
      expect(
        publicOrderInput.safeParse(order({ note: `Q${c}3` })).success,
      ).toBe(false);
    }
    expect(
      publicOrderInput.safeParse(order({ name: "Ana\nLópez" })).success,
    ).toBe(false);
    expect(
      publicOrderInput.safeParse(order({ note: "sin\rsal" })).success,
    ).toBe(false);
    const note = publicOrderInput.parse(
      order({ name: "José Ñúñez", note: "sin cebolla\n\tsalsa aparte" }),
    );
    expect([note.name, note.note]).toEqual([
      "José Ñúñez",
      "sin cebolla\n\tsalsa aparte",
    ]);
  });

  it("4. canonicalRequest is stable across key order", () => {
    const p = publicOrderInput.parse(order({ name: "Ana" }));
    const shuffled = Object.fromEntries(Object.entries(p).reverse());
    shuffled.lines = p.lines.map(
      (l) => Object.fromEntries(Object.entries(l).reverse()) as typeof l,
    );
    expect(canonicalRequest(shuffled as typeof p)).toBe(canonicalRequest(p));
    expect(canonicalRequest({ ...p, name: "Bea" })).not.toBe(
      canonicalRequest(p),
    );
  });

  it("5. hold labels", () => {
    expect(holdLabel("qr", 14)).toBe("Q-14");
    expect(holdLabel("kiosk", 3)).toBe("K-3");
  });

  it("6. a pending hold past its expiry reads as expired", () => {
    const now = Date.parse("2026-10-05T20:00:00Z");
    const past = "2026-10-05T19:59:59Z",
      future = "2026-10-05T20:10:00Z";
    expect(effectiveHoldState({ state: "pending", expiresAt: past }, now)).toBe(
      "expired",
    );
    expect(
      effectiveHoldState({ state: "pending", expiresAt: future }, now),
    ).toBe("pending");
    for (const state of ["accepted", "rejected", "cancelled"])
      expect(effectiveHoldState({ state, expiresAt: past }, now)).toBe(state);
  });

  it("7. round progress", () => {
    expect(roundProgress([])).toBe("preparing");
    expect(roundProgress(["active", "ready"])).toBe("preparing");
    expect(roundProgress(["ready", "completed"])).toBe("ready");
    expect(roundProgress(["completed"])).toBe("served");
    expect(roundProgress(["offline_review"])).toBe("preparing");
  });

  it("8. hold actions per policy, role and total", () => {
    expect(holdActions("accept", "cashier", 1000)).toEqual({
      accept: true,
      payAndSend: true,
      override: false,
    });
    expect(holdActions("pay_first", "cashier", 1000)).toEqual({
      accept: false,
      payAndSend: true,
      override: false,
    });
    expect(holdActions("pay_first", "manager", 1000).override).toBe(true);
    expect(holdActions("pay_first", "owner", 1000).override).toBe(true);
    expect(holdActions("pay_first", "manager", 0)).toEqual({
      accept: true,
      payAndSend: false,
      override: false,
    });
  });

  it("8b. a scoped limiter key uses the header only when it is a well-formed token", () => {
    const a = token(),
      b = token();
    expect(publicKey("198.51.100.7", a)).not.toBe(publicKey("198.51.100.7", b));
    const dash = publicKey("198.51.100.7", "");
    expect(dash).toBe("198.51.100.7:-");
    for (const v of [
      "",
      "eyJwdXJwb3NlIjoib3JkZXJpbmcifQ.c2lnbmF0dXJl",
      a + "A",
      a.slice(0, -1) + "=",
    ])
      expect(publicKey("198.51.100.7", v)).toBe(dash);
    expect(scopeKey(a)).toHaveLength(22);
    expect(scopeKey(a)).not.toBe(a);
    // IPv6 clients group per /56; the unscoped key is the network alone.
    expect(publicKey("2001:db8:0:100::1")).toBe(publicKey("2001:db8:0:1ff::2"));
    expect(publicKey("2001:db8:0:100::1")).not.toBe(
      publicKey("2001:db8:0:200::1"),
    );
  });

  it("9. the diner never learns about an abuse rejection", () => {
    expect(dinerRejectReason("abuse")).toBe("other");
    expect(dinerRejectReason("duplicate")).toBe("duplicate");
    expect(dinerRejectReason(null)).toBe(null);
  });

  it("10. link paths keep the token in the fragment", () => {
    const t = token();
    expect(linkPath("kiosk", t)).toBe("/kiosk#" + t);
    expect(linkPath("table", t)).toBe("/qr#" + t);
    expect(linkPath("counter", t)).toBe("/qr#" + t);
  });

  it("11. es-MX money on diner and staff views", async () => {
    const { moneyFormatter: staffMoney } =
      await import("../src/features/Receipt");
    expect(menuMoney("es", "MXN")(123450)).toBe("$1,234.50");
    expect(menuMoney("en", "MXN")(123450)).toBe("MX$1,234.50");
    expect(staffMoney("MXN", "es")(123450)).toBe("$1,234.50");
    expect(staffMoney("MXN", "en")(123450)).toBe("MX$1,234.50");
  });

  it("12. diner locations: fragment tokens, legacy paths and bad formats", () => {
    const t = token();
    expect(parseDinerLocation({ pathname: "/qr", hash: "#" + t })).toEqual({
      channel: "qr",
      token: t,
      legacy: false,
    });
    expect(parseDinerLocation({ pathname: "/kiosk/", hash: "#" + t })).toEqual({
      channel: "kiosk",
      token: t,
      legacy: false,
    });
    expect(parseDinerLocation({ pathname: "/qr/", hash: "" }).token).toBe(null);
    expect(
      parseDinerLocation({ pathname: "/qr/eyJhbGciOi.fake.sig", hash: "" }),
    ).toEqual({ channel: "qr", token: null, legacy: true });
    expect(
      parseDinerLocation({ pathname: "/kiosk/v2.k1.x.y", hash: "#" + t })
        .legacy,
    ).toBe(true);
    expect(parseDinerLocation({ pathname: "/kiosk", hash: "#x" }).token).toBe(
      null,
    );
  });

  it("13. settings schema: hold minutes from the list, maximum within MXN 100-100,000", () => {
    const base = {
      operationId: id(),
      expectedVersion: 0,
      tablePolicy: "accept",
      counterPolicy: "pay_first",
      holdMinutes: 30,
      maxOrderTotal: 1_000_000,
    };
    expect(settingsInput.safeParse(base).success).toBe(true);
    expect(settingsInput.safeParse({ ...base, holdMinutes: 25 }).success).toBe(
      false,
    );
    expect(
      settingsInput.safeParse({ ...base, maxOrderTotal: 9_999 }).success,
    ).toBe(false);
    expect(
      settingsInput.safeParse({ ...base, maxOrderTotal: 10_000_001 }).success,
    ).toBe(false);
  });

  it("15. a table hold offers the target check only with an action that uses it", () => {
    const hold = (policy: "accept" | "pay_first"): InboxHold => ({
      id: id(),
      label: "Q-7",
      kind: "table",
      channel: "qr",
      tableId: id(),
      tableName: "Mesa 4",
      linkLabel: "",
      linkRevoked: null,
      name: "",
      note: "",
      policy,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      lines: [
        {
          id: id(),
          quantity: 1,
          name: { es: "Taco", en: "Taco" },
          optionNames: [],
          unitPrice: 4500,
          total: 4500,
          issue: null,
          currentTotal: 4500,
        },
      ],
      quotedTotal: 4500,
      currentTotal: 4500,
      openChecks: [
        {
          id: id(),
          number: 142,
          version: 1,
          checkState: "open",
          total: 9000,
          paid: 0,
          waiterName: "Ana",
        },
      ],
    });
    const html = (policy: "accept" | "pay_first", role: string) =>
      renderToStaticMarkup(
        createElement(HoldCard, {
          hold: hold(policy),
          session: { role, restaurant: { currency: "MXN" } } as Session,
          locale: "es",
          online: true,
          busy: false,
          error: "",
          nowMs: Date.now(),
          forceNew: false,
          onAccept: () => {},
          onPay: () => {},
          onReject: () => {},
        }),
      );
    // Pay-first for a cashier: only "Cobrar y enviar a cocina", which always
    // opens a new check, so no "Enviar a" select suggests Cuenta #142.
    const cashier = html("pay_first", "cashier");
    expect(cashier).toContain("Cobrar y enviar a cocina");
    expect(cashier).not.toContain("<select");
    expect(cashier).not.toContain("Enviar a<");
    // A manager's exception and the accept policy do use the target.
    for (const [policy, role] of [
      ["pay_first", "manager"],
      ["accept", "cashier"],
    ] as const) {
      const markup = html(policy, role);
      expect(markup).toContain("<select");
      expect(markup).toContain("Cuenta #142");
    }
  });

  it("15b. the target select names an open check from another business day with its date, as Órdenes does (LD-29, POL-R2-2)", () => {
    const restaurant = {
      currency: "MXN",
      timezone: "America/Mexico_City",
      cutoff: 240,
    };
    const today = currentBusinessDate(restaurant);
    const check = (number: number, businessDate: string) => ({
      id: id(),
      number,
      businessDate,
      version: 1,
      checkState: "open" as const,
      total: 9000,
      paid: 0,
      waiterName: "Ana",
    });
    const hold: InboxHold = {
      id: id(),
      label: "Q-9",
      kind: "table",
      channel: "qr",
      tableId: id(),
      tableName: "Mesa 4",
      linkLabel: "",
      linkRevoked: null,
      name: "",
      note: "",
      policy: "accept",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      lines: [
        {
          id: id(),
          quantity: 1,
          name: { es: "Taco", en: "Taco" },
          optionNames: [],
          unitPrice: 4500,
          total: 4500,
          issue: null,
          currentTotal: 4500,
        },
      ],
      quotedTotal: 4500,
      currentTotal: 4500,
      openChecks: [check(10, "2026-01-05"), check(11, today)],
    };
    const markup = (locale: "es" | "en") =>
      renderToStaticMarkup(
        createElement(HoldCard, {
          hold,
          session: { role: "cashier", restaurant } as Session,
          locale,
          online: true,
          busy: false,
          error: "",
          nowMs: Date.now(),
          forceNew: false,
          onAccept: () => {},
          onPay: () => {},
          onReject: () => {},
        }),
      );
    expect(markup("es")).toContain("Cuenta #10 · 5 ene de Mesa 4 (Ana)");
    expect(markup("es")).toContain("Cuenta #11 de Mesa 4 (Ana)");
    expect(markup("en")).toContain("#10 · Jan 5");
  });

  it("17. the accept carries the total staff saw and an abuse acknowledgement; the yes/no price flag is gone (MONEY-1, ABUSE-1)", () => {
    const base = { operationId: id(), target: { kind: "new" } };
    const parsed = acceptInput.parse(base);
    expect([parsed.acknowledgedTotal, parsed.abuseAcknowledged]).toEqual([
      null,
      false,
    ]);
    expect(
      acceptInput.parse({ ...base, acknowledgedTotal: 6500 }).acknowledgedTotal,
    ).toBe(6500);
    for (const bad of [
      { ...base, priceChangeAcknowledged: true },
      { ...base, acknowledgedTotal: -1 },
      { ...base, acknowledgedTotal: 45.5 },
    ])
      expect(acceptInput.safeParse(bad).success).toBe(false);
  });

  it("18. a hold from a code deactivated as abuse is flagged and cannot be accepted unticked (ABUSE-1)", () => {
    const hold: InboxHold = {
      id: id(),
      label: "Q-8",
      kind: "counter",
      channel: "qr",
      tableId: null,
      tableName: null,
      linkLabel: "Ventanilla",
      linkRevoked: "abuse",
      name: "",
      note: "",
      policy: "accept",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      lines: [
        {
          id: id(),
          quantity: 1,
          name: { es: "Taco", en: "Taco" },
          optionNames: [],
          unitPrice: 4500,
          total: 4500,
          issue: null,
          currentTotal: 4500,
        },
      ],
      quotedTotal: 4500,
      currentTotal: 4500,
      openChecks: [],
    };
    const markup = renderToStaticMarkup(
      createElement(HoldCard, {
        hold,
        session: {
          role: "cashier",
          restaurant: { currency: "MXN" },
        } as Session,
        locale: "es",
        online: true,
        busy: false,
        error: "",
        nowMs: Date.now(),
        forceNew: false,
        onAccept: () => {},
        onPay: () => {},
        onReject: () => {},
      }),
    );
    expect(markup).toContain(
      "Código desactivado por abuso: verifica con el cliente antes de aceptar.",
    );
    expect(markup).toContain(
      "Lo verifiqué con el cliente; aceptar de todos modos.",
    );
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>Aceptar y enviar a cocina<\/button>/,
    );
    expect(markup).toContain("hace un momento");
  });

  it("19. the kiosk code is a plain heading and the status keeps one live region from loading on (UX-6)", () => {
    const done = renderToStaticMarkup(
      createElement(KioskDone, {
        hold: {
          restaurant: { name: "R", currency: "MXN", timezone: "UTC" },
          label: "K-6",
          state: "pending",
          kind: "kiosk",
          policy: "pay_first",
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          lines: [],
          total: 5500,
          priceChanged: false,
          rejectReason: null,
          order: null,
        },
        locale: "es",
        currency: "MXN",
        onReset: () => {},
      }),
    );
    expect(done).toContain('<h2 class="kiosk-code">K-6</h2>');
    expect(done).not.toContain('role="status"');
    const loading = renderToStaticMarkup(
      createElement(DinerStatus, {
        token: token(),
        locale: "es",
        menu: null,
        statusKey: token(),
        holds: [],
        onSelect: () => {},
        onForget: () => {},
        onNewOrder: () => {},
        onRestore: () => {},
      }),
    );
    expect(loading).toContain(
      '<div class="diner-status-head" role="status"><p>Cargando',
    );
    expect(loading).toContain('tabindex="-1"');
  });

  it("16. the shell banner's live region is mounted while empty (LD-P8)", () => {
    const banner = (count: number) =>
      renderToStaticMarkup(
        createElement(PublicInboxBanner, {
          count,
          locale: "es",
          onView: () => {},
        }),
      );
    // Text inserted together with its live region is not announced, so the
    // region is there, empty, before the first pending order arrives.
    expect(banner(0)).toBe(
      '<div class="public-banner-live" aria-live="polite"></div>',
    );
    const one = banner(1);
    expect(one).toMatch(/^<div class="public-banner-live" aria-live="polite">/);
    expect(one).toContain("1 pedido en línea por confirmar");
    expect(one).not.toContain('role="status"');
  });

  it("14. every live-hold query bounds created_at to the 2-hour hold window", () => {
    // Expired holds stay 'pending' forever (no sweeper, no DELETE), so a
    // live-hold predicate without the created_at bound scans all history.
    const files = [
      "server/public-holds.ts",
      "server/public-diner.ts",
      "server/public-links.ts",
      "server/checks.ts",
      "server/floor.ts",
    ];
    let live = 0;
    for (const file of files)
      for (const chunk of readFileSync(file, "utf8").split("`")) {
        const sql = chunk.replace(/\s+/g, "");
        if (
          !sql.includes("expires_at>now()") ||
          !(
            sql.includes("public_order_holds") ||
            sql.includes("state='pending'")
          )
        )
          continue;
        live++;
        expect(sql, `${file}: ${chunk.trim()}`).toMatch(
          /created_at>now\(\)-interval'(2hours|150minutes)'/,
        );
      }
    // summary, inbox and its expired count, submit's caps, links, occupancy, floor
    expect(live).toBe(8);
  });
});

describe("restaurant privacy notice warning (PUBLIC-SECURITY-4, LD-41)", () => {
  const warning =
    "Tu restaurante aún no tiene un aviso de privacidad. Los clientes pueden escribir su nombre al pedir: agrega el enlace a tu aviso antes de imprimir o compartir códigos.";
  it("the warning says what to do and offers the way to the privacy panel when there is one", () => {
    const html = renderToStaticMarkup(
      createElement(PrivacyNoticeWarning, { locale: "es", onOpen: () => {} }),
    );
    expect(html).toContain(warning);
    expect(html).toContain('role="note"');
    expect(html).toContain("Agregar aviso de privacidad");
    expect(
      renderToStaticMarkup(
        createElement(PrivacyNoticeWarning, { locale: "es" }),
      ),
    ).not.toContain("Agregar aviso de privacidad");
    expect(
      renderToStaticMarkup(
        createElement(PrivacyNoticeWarning, { locale: "en" }),
      ),
    ).toContain("Your restaurant has no privacy notice yet.");
  });
  it("the settings panel and both table QR dialogs render it; account's privacy panel fires the event and carries the field id", () => {
    const read = (path: string) => readFileSync(path, "utf8");
    for (const file of [
      "src/features/public/PublicOrderingSettings.tsx",
      "src/features/public/TableQrDialog.tsx",
      "src/features/public/TableQrBulkDialog.tsx",
    ])
      expect(read(file), file).toMatch(
        /privacyMissing && \(\s*<PrivacyNoticeWarning/,
      );
    const panel = read("src/features/AccountPrivacy.tsx");
    expect(panel).toContain(`new Event("${RESTAURANT_PRIVACY_EVENT}")`);
    expect(panel).toContain(`id="${RESTAURANT_PRIVACY_FIELD}"`);
  });
});

// B3 merge gate (LD-P2, public-rebase §3.3): account (031) is merged, so no
// public compat shim or shim import may come back, the diner and staff routers
// use account's real kill switch and privacy URL, and the base keys the old
// link generator used stay deleted. Pure: reads files only.
describe("public ordering merge gate (B3)", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? name === "node_modules"
          ? []
          : files(path)
        : /\.(ts|tsx)$/.test(name)
          ? [path]
          : [];
    });

  it("no public compat shim or shim import remains", () => {
    for (const dir of ["server/compat", "src/compat"])
      if (existsSync(dir))
        expect(
          readdirSync(dir).filter((f) => f.startsWith("public-")),
          dir,
        ).toEqual([]);
    const importers = [...files("server"), ...files("src"), ...files("tests")]
      .filter((f) => f !== join("tests", "public-ordering.test.ts"))
      .filter((f) => /compat\/public-/.test(read(f)));
    expect(importers).toEqual([]);
  });

  it("the routers use account's publicOrderingGate, publicOrderingEnabled and restaurantPrivacyUrl", () => {
    expect(read("server/public-ordering.ts")).toContain(
      'import { publicOrderingGate } from "./account-settings.js";',
    );
    expect(read("server/routes/public-ordering.ts")).toContain(
      'import { publicOrderingEnabled } from "../account-settings.js";',
    );
    expect(read("server/public-diner.ts")).toContain(
      'import { restaurantPrivacyUrl } from "./account-settings.js";',
    );
  });

  it("Configuración keeps the settings golden order with PublicOrderingSettings after AccountPrivacy (LD-P7)", () => {
    const ops = read("src/features/Operations.tsx");
    const order = [
      "<RestaurantSettings ",
      "<FiscalSettings ",
      "<CfdiSettings ",
      "<MoneyControlsSettings ",
      "<AccountPrivacy ",
      "<PublicOrderingSettings",
      "<FreeSelection ",
      "<DeviceManagement ",
      "<PlanSettings",
    ].map((tag) => {
      const at = ops.indexOf(tag);
      expect(at, tag).toBeGreaterThan(-1);
      expect(ops.indexOf(tag, at + 1), `${tag} once`).toBe(-1);
      return at;
    });
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("the deleted base keys of the old link generator stay deleted", () => {
    const users = [...files("src"), ...files("shared")].filter((f) =>
      /\b(payAtCounter|orderingLinks|createLink)\b/.test(read(f)),
    );
    expect(users).toEqual([]);
  });
});
