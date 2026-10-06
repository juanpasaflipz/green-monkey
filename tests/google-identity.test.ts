import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import {
  googleConfig,
  googleIdentityService,
  verifyGoogleIdentity,
  type GoogleAttempt,
  type GoogleAttemptStore,
} from "../server/google-identity.js";

const now = 1_800_000_000_000;
const config = {
  clientId: "fixture-client",
  clientSecret: "fictional-secret",
  redirectUri: "https://staging.example/api/auth/google/callback",
};
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "fixture" }],
  });
});
async function token(overrides: JWTPayload = {}) {
  return new SignJWT({
    iss: "https://accounts.google.com",
    sub: "stable-subject",
    aud: config.clientId,
    iat: now / 1000,
    exp: now / 1000 + 300,
    nonce: "nonce",
    email: "owner@example.com",
    email_verified: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign(pair.privateKey);
}
// Test-only atomic store. Production requires durable persistence.
function memoryStore(): GoogleAttemptStore {
  const attempts = new Map<string, GoogleAttempt>();
  return {
    async create(attempt) {
      attempts.set(attempt.stateHash, attempt);
    },
    async consume(state, browser, time) {
      const attempt = attempts.get(state);
      if (
        !attempt ||
        attempt.browserHash !== browser ||
        attempt.expiresAt <= time
      )
        return null;
      attempts.delete(state);
      return attempt;
    },
  };
}
describe("Google identity verification", () => {
  it("normalizes the issuer and keeps subject separate from email", async () => {
    const identity = await verifyGoogleIdentity(
      await token({ iss: "accounts.google.com" }),
      config.clientId,
      "nonce",
      keys,
      now,
    );
    expect(identity).toEqual({
      issuer: "https://accounts.google.com",
      subject: "stable-subject",
      email: "owner@example.com",
      name: null,
    });
  });
  it.each([
    { iss: "https://attacker.example" },
    { aud: "other-client" },
    { exp: now / 1000 - 60 },
    { iat: now / 1000 + 60 },
    { nonce: "wrong" },
    { email_verified: false },
    { sub: "" },
    { azp: "other-client" },
    { aud: [config.clientId, "other-client"] },
  ])("rejects invalid claims %j", async (claims) => {
    await expect(
      verifyGoogleIdentity(
        await token(claims),
        config.clientId,
        "nonce",
        keys,
        now,
      ),
    ).rejects.toThrow("google_identity_invalid");
  });
  it("rejects a signature made with another private key", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ sub: "stable-subject" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .sign(other.privateKey);
    await expect(
      verifyGoogleIdentity(forged, config.clientId, "nonce", keys, now),
    ).rejects.toThrow("google_identity_invalid");
  });
});
describe("Google authorization exchange", () => {
  it("binds the attempt to the browser, uses PKCE, and accepts only one simultaneous callback", async () => {
    let nonce = "";
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = init!.body as URLSearchParams;
      expect(body.get("code_verifier")).toHaveLength(43);
      expect(body.get("client_secret")).toBe(config.clientSecret);
      expect(init!.redirect).toBe("error");
      return Response.json({ id_token: await token({ nonce }) });
    });
    const service = googleIdentityService(config, memoryStore(), {
      fetch: request,
      keys,
      now: () => now,
    });
    const flow = await service.begin();
    const url = new URL(flow.url);
    nonce = url.searchParams.get("nonce")!;
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
    const input = {
      state: url.searchParams.get("state")!,
      browserToken: flow.browserToken,
      code: "fixture-code",
    };
    await expect(
      service.complete({ ...input, browserToken: "x".repeat(43) }),
    ).rejects.toThrow("google_login_invalid");
    expect(request).not.toHaveBeenCalled();
    const results = await Promise.allSettled([
      service.complete(input),
      service.complete(input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not retry an uncertain code exchange or expose its error", async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw Error("provider response with fictional-secret");
    });
    const service = googleIdentityService(config, memoryStore(), {
      fetch: request,
      keys,
      now: () => now,
    });
    const flow = await service.begin();
    const input = {
      state: new URL(flow.url).searchParams.get("state")!,
      browserToken: flow.browserToken,
      code: "code",
    };
    await expect(service.complete(input)).rejects.toThrow(
      /^google_exchange_failed$/,
    );
    await expect(service.complete(input)).rejects.toThrow(
      "google_login_invalid",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("expires attempts before any provider request", async () => {
    let time = now;
    const request = vi.fn<typeof fetch>();
    const service = googleIdentityService(config, memoryStore(), {
      fetch: request,
      now: () => time,
    });
    const flow = await service.begin();
    time += 600_000;
    await expect(
      service.complete({
        state: new URL(flow.url).searchParams.get("state")!,
        browserToken: flow.browserToken,
        code: "code",
      }),
    ).rejects.toThrow("google_login_invalid");
    expect(request).not.toHaveBeenCalled();
  });
});
describe("Google configuration", () => {
  const env = {
    GOOGLE_CLIENT_ID: config.clientId,
    GOOGLE_CLIENT_SECRET: config.clientSecret,
    GOOGLE_REDIRECT_URI: config.redirectUri,
    APP_URL: "https://staging.example",
    NODE_ENV: "production",
  };
  it("disables absent credentials and rejects incomplete configuration", () => {
    expect(googleConfig({})).toBeNull();
    expect(() => googleConfig({ GOOGLE_CLIENT_ID: "only-id" })).toThrow(
      "google_config_incomplete",
    );
    expect(googleConfig(env)).toEqual(config);
  });
  it.each([
    "https://attacker.example/api/auth/google/callback",
    "https://staging.example/api/auth/google/callback?next=evil",
    "http://staging.example/api/auth/google/callback",
  ])("rejects unsafe callbacks %s", (redirect) => {
    expect(() =>
      googleConfig({ ...env, GOOGLE_REDIRECT_URI: redirect }),
    ).toThrow("google_redirect_invalid");
  });
});
