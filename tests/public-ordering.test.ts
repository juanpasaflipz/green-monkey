import { describe, expect, it, vi } from "vitest";
import {
  canonicalRequest,
  dinerRejectReason,
  effectiveHoldState,
  holdActions,
  holdLabel,
  linkPath,
  PUBLIC_TOKEN,
  publicOrderInput,
  roundProgress,
  settingsInput,
} from "../shared/public-ordering";
import {
  linkHash,
  linkRef,
  newPublicToken,
  statusHash,
} from "../server/public-tokens";
import { publicKey, scopeKey } from "../server/public-limits";
import {
  publicOrderingEnabled,
  publicOrderingGate,
} from "../server/compat/public-account";
import { parseDinerLocation } from "../src/features/public/dinerRoute";
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

  it("the interim flag (compat S1) follows account's contract", () => {
    expect(publicOrderingEnabled({})).toBe(true);
    expect(publicOrderingEnabled({ APP_ENV: "production" })).toBe(false);
    expect(
      publicOrderingEnabled({
        APP_ENV: "production",
        PUBLIC_ORDERING_ENABLED: "true",
      }),
    ).toBe(true);
    expect(publicOrderingEnabled({ PUBLIC_ORDERING_ENABLED: " false " })).toBe(
      false,
    );
    expect(() =>
      publicOrderingEnabled({ PUBLIC_ORDERING_ENABLED: "yes" }),
    ).toThrow("public_ordering_flag_invalid");
    let status = 0,
      body: unknown = null,
      passed = false;
    const res = {
      status(n: number) {
        status = n;
        return this;
      },
      json(b: unknown) {
        body = b;
      },
    };
    publicOrderingGate({ PUBLIC_ORDERING_ENABLED: "false" })(
      {} as never,
      res as never,
      () => (passed = true),
    );
    expect([status, body, passed]).toEqual([
      404,
      { error: "public_ordering_disabled" },
      false,
    ]);
    publicOrderingGate({})({} as never, res as never, () => (passed = true));
    expect(passed).toBe(true);
  });
});
