import { createHmac, hkdfSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FALLBACK_KID,
  KeyringError,
  keyring,
  parseSigningKeys,
  resetKeyring,
  signToken,
  verifyToken,
} from "../server/keyring.js";
import { isProductionEnv } from "../server/production.js";
import { assertDemoAccessAllowed } from "../server/access.js";
import { sign, verify } from "../server/auth.js";

// Keys are built at runtime from synthetic bytes; no key material is committed.
const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
const entry = (kid: string, fill: number) => `${kid}:${secret(fill)}`;
const JWT = "synthetic-keyring-test-jwt-secret-0123456789abcdef";
const ENV = [
  "SIGNING_KEYS",
  "JWT_SECRET",
  "APP_ENV",
  "RAILWAY_ENVIRONMENT_NAME",
] as const;
const saved: Partial<Record<(typeof ENV)[number], string>> = {};

/** Sets exactly these variables (the others unset) and resets the keyring. */
function env(vars: Partial<Record<(typeof ENV)[number], string>>) {
  for (const name of ENV) {
    if (vars[name] === undefined) delete process.env[name];
    else process.env[name] = vars[name];
  }
  resetKeyring();
}
/** The pre-2.0 sign(): "<body>.<HMAC-SHA256(JWT_SECRET, body)>". */
function legacy(data: unknown, jwt = JWT) {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${body}.${createHmac("sha256", jwt).update(body).digest("base64url")}`;
}
/** A signature character that decodes to the same bytes (unused low bits). */
function sameBytesVariant(token: string) {
  const sig = token.split(".").at(-1)!;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const c = [...alphabet].find(
    (ch) =>
      ch !== sig.slice(-1) &&
      Buffer.from(sig.slice(0, -1) + ch, "base64url").equals(
        Buffer.from(sig, "base64url"),
      ),
  )!;
  expect(c, "the last character has unused bits").toBeTruthy();
  return token.slice(0, -1) + c;
}

beforeEach(() => {
  for (const name of ENV) saved[name] = process.env[name];
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetKeyring();
});

describe("keyring (OPS-10)", () => {
  it("parseSigningKeys accepts 1-5 unique kids with >= 32-byte base64url secrets", () => {
    expect(
      parseSigningKeys(` ${entry("k1", 1)} , ${entry("k-2", 2)} `).map(
        (k) => k.kid,
      ),
    ).toEqual(["k1", "k-2"]);
    for (const bad of [
      "",
      ",",
      `k1:${Buffer.alloc(31, 1).toString("base64url")}`,
      `K1:${secret(1)}`,
      `k_1:${secret(1)}`,
      `${"k".repeat(33)}:${secret(1)}`,
      `${entry("k1", 1)},${entry("k1", 2)}`,
      entry(FALLBACK_KID, 1),
      [1, 2, 3, 4, 5, 6].map((n) => entry(`k${n}`, n)).join(","),
      `k1:${secret(1)}=`,
      `k1:${secret(1).slice(0, 20)}+/${secret(1).slice(20)}`,
      `:${secret(1)}`,
      secret(1),
    ])
      expect(() => parseSigningKeys(bad), bad).toThrow(KeyringError);
  });

  it("sign writes v2.<first kid>.… and verify accepts every listed kid", () => {
    env({ SIGNING_KEYS: `${entry("k1", 1)},${entry("k2", 2)}` });
    const token = signToken("sign", { a: 1 });
    expect(token.split(".")).toHaveLength(4);
    expect(token.startsWith("v2.k1.")).toBe(true);
    expect(verifyToken("sign", token, { legacy: true })).toEqual({ a: 1 });
    env({ SIGNING_KEYS: `${entry("k2", 2)},${entry("k1", 1)}` });
    const second = signToken("sign", { b: 2 });
    expect(second.startsWith("v2.k2.")).toBe(true);
    expect(verifyToken("sign", token, { legacy: false })).toEqual({ a: 1 });
    expect(verifyToken("sign", second, { legacy: false })).toEqual({ b: 2 });
    // auth.ts keeps its API: sign()/verify() over the keyring.
    expect(verify(sign({ c: 3 }))).toEqual({ c: 3 });
    expect(() => verify("x")).toThrow(
      expect.objectContaining({ code: "unauthorized", status: 401 }),
    );
  });

  it("verify rejects an unlisted kid, a tampered body, kid or signature, malformed JSON, the wrong number of parts and more than 8192 characters", () => {
    env({ SIGNING_KEYS: entry("k1", 1) });
    const token = signToken("sign", { role: "cashier" });
    const [, kid, body, sig] = token.split(".");
    const mac = (b: string) =>
      createHmac("sha256", Buffer.alloc(32, 1)).update(b).digest("base64url");
    const tamperedBody = Buffer.from('{"role":"owner"}').toString("base64url");
    for (const bad of [
      `v2.k9.${body}.${sig}`,
      `v2.${kid}.${tamperedBody}.${sig}`,
      `v2.k2.${body}.${sig}`,
      `v2.${kid}.${body}.${sig.slice(0, -2)}AA`,
      `v3.${kid}.${body}.${sig}`,
      // A MAC under the raw secret instead of the HKDF per-use key.
      `v2.${kid}.${body}.${mac(`v2.${kid}.${body}`)}`,
      `v2.${kid}.${body}`,
      `v2.${kid}.${body}.${sig}.x`,
      `${body}.${sig}`,
      "",
      "v2...",
      token + "A".repeat(8193 - token.length),
    ])
      expect(verifyToken("sign", bad, { legacy: true }), bad).toBeNull();
    // The documented format: HMAC-SHA256 under HKDF(secret, salt, info = use).
    const perUse = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.alloc(32, 1),
        "green-monkey/token/v2",
        "sign",
        32,
      ),
    );
    const mint = (b: string) =>
      `v2.k1.${b}.${createHmac("sha256", perUse).update(`v2.k1.${b}`).digest("base64url")}`;
    const ok = Buffer.from('{"ok":1}').toString("base64url");
    expect(verifyToken("sign", mint(ok), { legacy: true })).toEqual({ ok: 1 });
    // A correctly signed body that is not JSON.
    const notJson = Buffer.from("{not json").toString("base64url");
    expect(verifyToken("sign", mint(notJson), { legacy: true })).toBeNull();
    expect(verifyToken("sign", 42 as unknown as string, { legacy: true })).toBe(
      null,
    );
  });

  it("legacy body.sig and v2.jwt.* verify only while JWT_SECRET is set (OPS-10 regression)", () => {
    env({ JWT_SECRET: JWT });
    const fallback = signToken("sign", { d: 1 });
    expect(fallback.startsWith(`v2.${FALLBACK_KID}.`)).toBe(true);
    expect(verifyToken("sign", legacy({ d: 0 }), { legacy: true })).toEqual({
      d: 0,
    });
    expect(verifyToken("sign", legacy({ d: 0 }), { legacy: false })).toBeNull();
    expect(
      verifyToken("sign", legacy({ d: 0 }, JWT + "-other"), { legacy: true }),
    ).toBeNull();
    env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: JWT });
    expect(verifyToken("sign", legacy({ d: 0 }), { legacy: true })).toEqual({
      d: 0,
    });
    expect(verifyToken("sign", fallback, { legacy: true })).toEqual({ d: 1 });
    env({ SIGNING_KEYS: entry("k1", 1) });
    expect(verifyToken("sign", legacy({ d: 0 }), { legacy: true })).toBeNull();
    expect(verifyToken("sign", fallback, { legacy: true })).toBeNull();
    env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: "too-short" });
    expect(verifyToken("sign", fallback, { legacy: true })).toBeNull();
  });

  it("without SIGNING_KEYS the keyring signs with kid jwt; adding SIGNING_KEYS later keeps those tokens valid while JWT_SECRET is set", () => {
    env({ JWT_SECRET: JWT });
    expect(keyring().map((k) => k.kid)).toEqual([FALLBACK_KID]);
    const before = sign({ device: "d1" });
    expect(before.split(".").slice(0, 2)).toEqual(["v2", FALLBACK_KID]);
    env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: JWT });
    expect(keyring().map((k) => k.kid)).toEqual(["k1"]);
    expect(verify(before)).toEqual({ device: "d1" });
    expect(sign({ device: "d1" }).startsWith("v2.k1.")).toBe(true);
    env({});
    expect(() => keyring()).toThrow(KeyringError);
    expect(() => sign({})).toThrow(/signing_keys_required/);
  });

  it("a token for one use never verifies for another (HKDF info separation)", () => {
    env({ SIGNING_KEYS: entry("k1", 1) });
    const signed = signToken("sign", { x: 1 });
    const sealed = signToken("seal:cfdi-portal", { x: 1 });
    expect(signed).not.toBe(sealed);
    expect(signed.split(".")[2]).toBe(sealed.split(".")[2]);
    expect(verifyToken("seal:cfdi-portal", signed, { legacy: false })).toBe(
      null,
    );
    expect(verifyToken("sign", sealed, { legacy: true })).toBeNull();
    expect(
      verifyToken("seal:cfdi-portal-file", sealed, { legacy: false }),
    ).toBeNull();
    expect(verifyToken("seal:cfdi-portal", sealed, { legacy: false })).toEqual({
      x: 1,
    });
  });

  it("two-step rotation: '<current>,<new>' signs with current and verifies new; '<new>,<current>' signs with new and verifies both; '<new>' alone rejects current", () => {
    const current = entry("kcur", 1);
    const next = entry("knew", 2);
    env({ SIGNING_KEYS: current });
    const old = sign({ s: "old" });
    env({ SIGNING_KEYS: `${current},${next}` });
    const step1 = sign({ s: "step1" });
    expect(step1.startsWith("v2.kcur.")).toBe(true);
    expect(verify(old)).toEqual({ s: "old" });
    env({ SIGNING_KEYS: next });
    const fromNew = sign({ s: "new" });
    env({ SIGNING_KEYS: `${current},${next}` });
    expect(verify(fromNew), "an instance still on step 1 verifies new").toEqual(
      { s: "new" },
    );
    env({ SIGNING_KEYS: `${next},${current}` });
    expect(sign({}).startsWith("v2.knew.")).toBe(true);
    expect(verify(old)).toEqual({ s: "old" });
    expect(verify(fromNew)).toEqual({ s: "new" });
    env({ SIGNING_KEYS: next });
    expect(() => verify(old)).toThrow(/unauthorized/);
    expect(verify(fromNew)).toEqual({ s: "new" });
  });

  it("one spelling per token (P-22, MENU-R3): extra parts, trailing '=', '!' or space, a padded body and an unused-bits variant are refused; the exact string verifies", () => {
    for (const vars of [
      { SIGNING_KEYS: entry("k1", 1) },
      { JWT_SECRET: JWT, legacyToken: true },
    ]) {
      const { legacyToken, ...rest } = vars as Record<string, unknown>;
      env(rest as Record<string, string>);
      const data = { link: "qr", n: 7 };
      const token = legacyToken ? legacy(data) : signToken("sign", data);
      expect(verifyToken("sign", token, { legacy: true })).toEqual(data);
      const parts = token.split(".");
      const body = parts.at(-2)!;
      const spellings = [
        token + ".1",
        token + "=",
        token + "!",
        token + " ",
        " " + token,
        [...parts.slice(0, -2), body + "=", parts.at(-1)!].join("."),
        [...parts.slice(0, -2), body + "==", parts.at(-1)!].join("."),
        sameBytesVariant(token),
      ];
      for (const s of spellings)
        expect(verifyToken("sign", s, { legacy: true }), s).toBeNull();
    }
  });

  it("with SIGNING_KEYS set, v2.jwt.* verifies for 'sign' only while JWT_SECRET is set and never for a 'seal:*' use (P-23)", () => {
    env({ JWT_SECRET: JWT });
    const signed = signToken("sign", { a: 1 });
    const sealed = signToken("seal:cfdi-portal-file", { a: 1 });
    expect(sealed.startsWith(`v2.${FALLBACK_KID}.`)).toBe(true);
    // Without SIGNING_KEYS the fallback kid is the ring: every use works.
    expect(
      verifyToken("seal:cfdi-portal-file", sealed, { legacy: false }),
    ).toEqual({ a: 1 });
    env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: JWT });
    expect(verifyToken("sign", signed, { legacy: true })).toEqual({ a: 1 });
    expect(
      verifyToken("seal:cfdi-portal-file", sealed, { legacy: false }),
    ).toBeNull();
    expect(
      verifyToken("seal:cfdi-portal-file", sealed, { legacy: true }),
    ).toBeNull();
  });

  it("production refuses legacy body.sig and v2.jwt.* tokens even while JWT_SECRET is set; staging accepts both for sign (LD-8 D5)", () => {
    env({ JWT_SECRET: JWT });
    const fallback = signToken("sign", { f: 1 });
    const old = legacy({ f: 0 });
    for (const production of [
      { APP_ENV: "production" },
      { APP_ENV: " Production " },
      { RAILWAY_ENVIRONMENT_NAME: "Production" },
      { APP_ENV: "staging", RAILWAY_ENVIRONMENT_NAME: "production" },
    ]) {
      env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: JWT, ...production });
      expect(isProductionEnv(), JSON.stringify(production)).toBe(true);
      expect(verifyToken("sign", old, { legacy: true })).toBeNull();
      expect(verifyToken("sign", fallback, { legacy: true })).toBeNull();
      expect(() => verify(old)).toThrow(/unauthorized/);
      // v2 tokens of listed kids are unaffected.
      expect(verify(sign({ ok: true }))).toEqual({ ok: true });
    }
    for (const staging of [
      { APP_ENV: "staging" },
      { RAILWAY_ENVIRONMENT_NAME: "staging" },
      {},
    ]) {
      env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: JWT, ...staging });
      expect(isProductionEnv()).toBe(false);
      expect(verifyToken("sign", old, { legacy: true })).toEqual({ f: 0 });
      expect(verifyToken("sign", fallback, { legacy: true })).toEqual({
        f: 1,
      });
    }
    // Production never falls back to a JWT_SECRET-derived ring.
    env({ JWT_SECRET: JWT, APP_ENV: "production" });
    expect(() => keyring()).toThrow(/signing_keys_required/);
  });

  it("access's demo-access refusal shares the production predicate (LD-14 OQ-7)", () => {
    const tenant = "10000000-0000-4000-8000-000000000001";
    for (const production of [
      { APP_ENV: "production" },
      { RAILWAY_ENVIRONMENT_NAME: "PRODUCTION" },
    ]) {
      expect(isProductionEnv(production)).toBe(true);
      expect(() =>
        assertDemoAccessAllowed({ ...production, DEMO_TENANT_ID: tenant }),
      ).toThrow(/production/);
    }
    expect(isProductionEnv({ APP_ENV: "staging" })).toBe(false);
    expect(() =>
      assertDemoAccessAllowed({ APP_ENV: "staging", DEMO_TENANT_ID: tenant }),
    ).not.toThrow();
  });
});
