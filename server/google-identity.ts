import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

const issuer = "https://accounts.google.com";
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 5000 },
);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const opaque = () => randomBytes(32).toString("base64url");

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};
export function googleConfig(env: NodeJS.ProcessEnv): GoogleConfig | null {
  const values = [
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  ];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) throw Error("google_config_incomplete");
  const redirect = new URL(env.GOOGLE_REDIRECT_URI!);
  const app = new URL(env.APP_URL!);
  const local =
    env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  if (
    (redirect.protocol !== "https:" &&
      !(local && redirect.protocol === "http:")) ||
    redirect.origin !== app.origin ||
    redirect.pathname !== "/api/auth/google/callback" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  )
    throw Error("google_redirect_invalid");
  return {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    redirectUri: redirect.href,
  };
}

export type GoogleAttempt = {
  stateHash: string;
  browserHash: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
};
/** Implement with a durable atomic consume, never an in-memory production map.
 * A matching unexpired attempt is consumed BEFORE contacting Google. A timeout
 * requires a new login; it must not replay the authorization code.
 */
export interface GoogleAttemptStore {
  create(attempt: GoogleAttempt): Promise<void>;
  consume(
    stateHash: string,
    browserHash: string,
    now: number,
  ): Promise<GoogleAttempt | null>;
}
export type VerifiedGoogleIdentity = {
  issuer: typeof issuer;
  subject: string;
  email: string;
  name: string | null;
};

export async function verifyGoogleIdentity(
  token: string,
  clientId: string,
  nonce: string,
  keys: JWTVerifyGetKey = googleKeys,
  now = Date.now(),
): Promise<VerifiedGoogleIdentity> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: [issuer, "accounts.google.com"],
      audience: clientId,
      requiredClaims: ["sub", "iat", "exp", "nonce"],
      currentDate: new Date(now),
      clockTolerance: 5,
      maxTokenAge: "10m",
    });
    if (
      payload.nonce !== nonce ||
      !nonce ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId)
    )
      throw Error();
    const claims = z
      .object({
        sub: z.string().min(1).max(255),
        email: z.email().max(320),
        email_verified: z.literal(true),
        name: z.string().max(200).optional(),
      })
      .parse(payload);
    // Canonical issuer + subject is the key. Email is display/contact data only.
    return {
      issuer,
      subject: claims.sub,
      email: claims.email,
      name: claims.name ?? null,
    };
  } catch {
    throw Error("google_identity_invalid");
  }
}

export function googleIdentityService(
  config: GoogleConfig,
  store: GoogleAttemptStore,
  dependencies: {
    fetch?: typeof fetch;
    keys?: JWTVerifyGetKey;
    now?: () => number;
  } = {},
) {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  return {
    async begin() {
      const state = opaque(),
        browserToken = opaque(),
        verifier = opaque(),
        nonce = opaque();
      await store.create({
        stateHash: digest(state),
        browserHash: digest(browserToken),
        nonce,
        verifier,
        expiresAt: now() + 600_000,
      });
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: digest(verifier),
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      // Route must set browserToken in a Secure HttpOnly SameSite=Lax cookie,
      // scoped to the callback, with a 10-minute lifetime. Never return it as JSON.
      return { url: url.href, browserToken };
    },
    async complete(input: {
      state: string;
      browserToken: string;
      code: string;
    }) {
      const parsed = z
        .object({
          state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          browserToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          code: z.string().min(1).max(4096),
        })
        .safeParse(input);
      if (!parsed.success) throw Error("google_login_invalid");
      const attempt = await store.consume(
        digest(input.state),
        digest(input.browserToken),
        now(),
      );
      if (!attempt || attempt.expiresAt <= now())
        throw Error("google_login_invalid");
      let token: string;
      try {
        const response = await request("https://oauth2.googleapis.com/token", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: input.code,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.redirectUri,
            grant_type: "authorization_code",
            code_verifier: attempt.verifier,
          }),
        });
        if (!response.ok) throw Error();
        token = z
          .object({ id_token: z.string().max(16_384) })
          .parse(await response.json()).id_token;
      } catch {
        // Provider responses may contain credentials; never propagate raw errors.
        throw Error("google_exchange_failed");
      }
      return verifyGoogleIdentity(
        token,
        config.clientId,
        attempt.nonce,
        dependencies.keys,
        now(),
      );
    },
  };
}
