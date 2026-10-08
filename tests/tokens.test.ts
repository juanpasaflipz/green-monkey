import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_KID, resetKeyring, signToken } from "../server/keyring.js";
import { MAX_SEAL_SECONDS, seal, unseal } from "../server/tokens.js";
import { sign, verify } from "../server/auth.js";

// Keys are built at runtime from synthetic bytes; no key material is committed.
const entry = (kid: string, fill: number) =>
  `${kid}:${Buffer.alloc(32, fill).toString("base64url")}`;
const JWT = "synthetic-tokens-test-jwt-secret-0123456789abcdef";
const ENV = [
  "SIGNING_KEYS",
  "JWT_SECRET",
  "APP_ENV",
  "RAILWAY_ENVIRONMENT_NAME",
] as const;
const saved: Partial<Record<(typeof ENV)[number], string>> = {};

function env(vars: Partial<Record<(typeof ENV)[number], string>>) {
  for (const name of ENV) {
    if (vars[name] === undefined) delete process.env[name];
    else process.env[name] = vars[name];
  }
  resetKeyring();
}
const unauthorized = expect.objectContaining({
  code: "unauthorized",
  status: 401,
});

beforeEach(() => {
  for (const name of ENV) saved[name] = process.env[name];
  env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: JWT });
});
afterEach(() => {
  vi.useRealTimers();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetKeyring();
});

describe("sealed tokens (contract C-6)", () => {
  it("seal/unseal round-trips the payload", () => {
    const payload = { tenantId: "t1", ticket: "A-1", amounts: [1, 2.5] };
    const token = seal("cfdi-portal", payload, { ttlSeconds: 3600 });
    expect(token.startsWith("v2.k1.")).toBe(true);
    expect(unseal("cfdi-portal", token)).toEqual(payload);
    expect(
      unseal<string>(
        "cfdi-portal",
        seal("cfdi-portal", "x", { ttlSeconds: 1 }),
      ),
    ).toBe("x");
    // seal is not deterministic: it embeds the expiry.
    vi.useFakeTimers({ now: Date.now() + 5000 });
    expect(seal("cfdi-portal", payload, { ttlSeconds: 3600 })).not.toBe(token);
  });

  it("unseal rejects another purpose, an expired token (fake clock), a legacy token and a sign() token", () => {
    const start = Date.UTC(2026, 9, 5, 12, 0, 0);
    vi.useFakeTimers({ now: start });
    const token = seal("cfdi-portal", { a: 1 }, { ttlSeconds: 60 });
    expect(() => unseal("cfdi-portal-file", token)).toThrow(unauthorized);
    expect(() => unseal("other-purpose", token)).toThrow(unauthorized);
    vi.setSystemTime(start + 59_000);
    expect(unseal("cfdi-portal", token)).toEqual({ a: 1 });
    vi.setSystemTime(start + 60_000);
    expect(() => unseal("cfdi-portal", token), "exp is exclusive").toThrow(
      unauthorized,
    );
    vi.setSystemTime(start);
    // The pre-2.0 two-part format under JWT_SECRET, even with a sealed-looking body.
    const body = Buffer.from(
      JSON.stringify({ p: "cfdi-portal", exp: 4102444800, d: { a: 1 } }),
    ).toString("base64url");
    const legacy = `${body}.${createHmac("sha256", JWT).update(body).digest("base64url")}`;
    expect(verify(legacy), "a valid legacy cookie format").toMatchObject({
      p: "cfdi-portal",
    });
    expect(() => unseal("cfdi-portal", legacy)).toThrow(unauthorized);
    // A sign() token carrying the sealed shape is still a different use.
    const signed = sign({ p: "cfdi-portal", exp: 4102444800, d: { a: 1 } });
    expect(() => unseal("cfdi-portal", signed)).toThrow(unauthorized);
    // A body under the right use but with another purpose, or no expiry, is refused.
    const foreign = signToken("seal:cfdi-portal", {
      p: "cfdi-portal-file",
      exp: 4102444800,
      d: 1,
    });
    expect(() => unseal("cfdi-portal", foreign)).toThrow(unauthorized);
    for (const exp of [undefined, "4102444800", 4102444800.5, null])
      expect(
        () =>
          unseal(
            "cfdi-portal",
            signToken("seal:cfdi-portal", { p: "cfdi-portal", exp, d: 1 }),
          ),
        String(exp),
      ).toThrow(unauthorized);
    for (const bad of ["", "x", "v2.k1.a.b", token + ".1", token + "="])
      expect(() => unseal("cfdi-portal", bad), bad).toThrow(unauthorized);
    // An invalid purpose never reaches the keyring.
    expect(() => unseal("Bad Purpose", token)).toThrow(unauthorized);
  });

  it("verify rejects a sealed token", () => {
    const token = seal("cfdi-portal", { a: 1 }, { ttlSeconds: 60 });
    expect(() => verify(token)).toThrow(unauthorized);
  });

  it("seal refuses a bad purpose and a ttl outside 1..2678400", () => {
    expect(MAX_SEAL_SECONDS).toBe(2_678_400);
    for (const purpose of [
      "",
      "a",
      "Cfdi-portal",
      "1cfdi",
      "cfdi_portal",
      "cfdi portal",
      "c" + "x".repeat(41),
    ])
      expect(
        () => seal(purpose, {}, { ttlSeconds: 60 }),
        JSON.stringify(purpose),
      ).toThrow(/invalid seal purpose/);
    expect(seal("ab", {}, { ttlSeconds: 1 })).toMatch(/^v2\./);
    expect(seal("c" + "x".repeat(40), {}, { ttlSeconds: 1 })).toMatch(/^v2\./);
    for (const ttlSeconds of [0, -1, 1.5, NaN, MAX_SEAL_SECONDS + 1])
      expect(
        () => seal("cfdi-portal", {}, { ttlSeconds }),
        String(ttlSeconds),
      ).toThrow(/ttlSeconds/);
    expect(seal("cfdi-portal", {}, { ttlSeconds: MAX_SEAL_SECONDS })).toMatch(
      /^v2\./,
    );
  });

  it("a sealed token is signed, not encrypted: its payload decodes without any key (PLATFORM-KEYS-2)", () => {
    // Opaque ids only (server/tokens.ts header): whoever holds a printed QR code or a
    // URL can read this.
    const payload = { tid: "10000000-0000-4000-8000-000000000001", did: "d-1" };
    const token = seal("cfdi-portal-file", payload, { ttlSeconds: 900 });
    const [version, kid, body, mac] = token.split(".");
    expect([version, kid]).toEqual(["v2", "k1"]);
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    expect(decoded).toEqual({
      p: "cfdi-portal-file",
      exp: expect.any(Number),
      d: payload,
    });
    // Nothing secret-looking survives in the clear either way: the payload is the
    // only content, and the MAC is the only key-dependent part.
    env({ SIGNING_KEYS: entry("k1", 2), JWT_SECRET: JWT });
    const other = seal("cfdi-portal-file", payload, { ttlSeconds: 900 });
    expect(
      JSON.parse(Buffer.from(other.split(".")[2], "base64url").toString()).d,
    ).toEqual(payload);
    expect(other.split(".")[3]).not.toBe(mac);
  });

  it("cfdi-portal and cfdi-portal-file tokens cannot be swapped", () => {
    const portal = seal("cfdi-portal", { id: "doc" }, { ttlSeconds: 3600 });
    const file = seal("cfdi-portal-file", { id: "doc" }, { ttlSeconds: 900 });
    expect(unseal("cfdi-portal", portal)).toEqual({ id: "doc" });
    expect(unseal("cfdi-portal-file", file)).toEqual({ id: "doc" });
    expect(() => unseal("cfdi-portal-file", portal)).toThrow(unauthorized);
    expect(() => unseal("cfdi-portal", file)).toThrow(unauthorized);
  });

  it("with SIGNING_KEYS set, a cfdi-portal-file token minted under the JWT_SECRET-derived fallback kid is refused (a leaked JWT_SECRET mints no sealed token, P-23); without SIGNING_KEYS, seal and unseal use the fallback kid", () => {
    env({ JWT_SECRET: JWT });
    const minted = seal(
      "cfdi-portal-file",
      { id: "any-tenant" },
      { ttlSeconds: 900 },
    );
    expect(minted.startsWith(`v2.${FALLBACK_KID}.`)).toBe(true);
    expect(unseal("cfdi-portal-file", minted)).toEqual({ id: "any-tenant" });
    env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: JWT });
    expect(() => unseal("cfdi-portal-file", minted)).toThrow(unauthorized);
    // The same forgery for sign() stays legacy-acceptable outside production only.
    env({ JWT_SECRET: JWT });
    const cookie = sign({ device: "d1" });
    env({ SIGNING_KEYS: entry("k1", 1), JWT_SECRET: JWT });
    expect(verify(cookie)).toEqual({ device: "d1" });
    env({
      SIGNING_KEYS: entry("k1", 1),
      JWT_SECRET: JWT,
      APP_ENV: "production",
    });
    expect(() => verify(cookie)).toThrow(unauthorized);
    expect(() => unseal("cfdi-portal-file", minted)).toThrow(unauthorized);
  });
});
