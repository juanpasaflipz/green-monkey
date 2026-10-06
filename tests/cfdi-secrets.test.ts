// cfdi (030) unit tests 17-19, 21 and 25 (spec §7.1): the credential vault, the sealed CSD upload
// box, CSD inspection, configuration through loadConfig and provider-key redaction. Pure: no
// database, no network.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../server/config-rules";
import { cfdiWebConfig, cfdiWorkerConfig } from "../server/cfdi/config";
import {
  inspectCsd,
  keyUsageBits,
  satSerial,
  sealCsdUpload,
} from "../server/cfdi/csd";
import {
  openSecret,
  openUploadBox,
  parseCredentialKeyring,
  sealSecret,
  uploadKeyPair,
  VaultError,
} from "../server/cfdi/vault";
import { redact } from "../server/logging";
import {
  TEST_CSD,
  TEST_CSD_PASSWORD,
  TEST_CSD_RFC,
  TEST_CSD_SERIAL,
} from "./fixtures/cfdi/test-csd";

/** Synthetic keyring entries built at runtime (no key material is committed). */
const entry = (kid: string, fill: number, bytes = 32) =>
  `${kid}:${Buffer.alloc(bytes, fill).toString("base64url")}`;
const ring = (...entries: string[]) =>
  parseCredentialKeyring(entries.join(","));
const bytes = (b64: string) => Buffer.from(b64, "base64");
const tenantId = randomUUID();
const otherTenant = randomUUID();

async function vaultError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VaultError) return e.code;
    throw e;
  }
  throw new Error("expected a VaultError");
}

describe("17. vault: sealSecret / openSecret", () => {
  it("round-trips an organization key bound to its tenant, purpose and row", async () => {
    const r = ring(entry("2026-10", 1));
    const b = { tenantId, purpose: "org_test_key" as const, id: randomUUID() };
    const { jwe, kid } = await sealSecret(r, "sk_test_abc123", b);
    expect(kid).toBe("2026-10");
    expect(jwe.split(".")).toHaveLength(5);
    expect(jwe).not.toContain("sk_test_abc123");
    expect(await openSecret(r, jwe, b)).toBe("sk_test_abc123");
  });

  it("refuses another tenant, purpose or row (cfdi_vault_binding)", async () => {
    const r = ring(entry("2026-10", 1));
    const b = { tenantId, purpose: "org_live_key" as const, id: randomUUID() };
    const { jwe } = await sealSecret(r, "sk_live_abc123", b);
    for (const other of [
      { ...b, tenantId: otherTenant },
      { ...b, purpose: "org_test_key" as const },
      { ...b, id: randomUUID() },
    ])
      expect(await vaultError(openSecret(r, jwe, other))).toBe(
        "cfdi_vault_binding",
      );
    // A tampered protected header fails authentication.
    const [, ...rest] = jwe.split(".");
    const forged =
      Buffer.from(
        JSON.stringify({
          alg: "dir",
          enc: "A256GCM",
          kid: "2026-10",
          typ: "gm-cfdi-secret",
          tid: otherTenant,
          pur: b.purpose,
          rid: b.id,
        }),
      ).toString("base64url") +
      "." +
      rest.join(".");
    expect(
      await vaultError(openSecret(r, forged, { ...b, tenantId: otherTenant })),
    ).toBe("cfdi_vault_binding");
  });

  it("an older kid still opens after rotation; an unknown kid is refused", async () => {
    const old = ring(entry("2026-09", 2));
    const b = { tenantId, purpose: "org_test_key" as const, id: randomUUID() };
    const { jwe } = await sealSecret(old, "sk_test_rotated", b);
    const rotated = ring(entry("2026-10", 3), entry("2026-09", 2));
    expect(rotated.active).toBe("2026-10");
    expect(await openSecret(rotated, jwe, b)).toBe("sk_test_rotated");
    const resealed = await sealSecret(rotated, "sk_test_rotated", b);
    expect(resealed.kid).toBe("2026-10");
    expect(
      await vaultError(openSecret(ring(entry("2026-11", 4)), jwe, b)),
    ).toBe("cfdi_vault_unknown_kid");
  });

  it("rejects a malformed CREDENTIAL_ENCRYPTION_KEY", () => {
    for (const bad of [
      "",
      "nokid",
      ":" + Buffer.alloc(32, 1).toString("base64url"),
      "Bad_Kid:" + Buffer.alloc(32, 1).toString("base64url"),
      entry("short", 1, 16),
      entry("a", 1) + "," + entry("a", 2),
      "a:not base64 at all!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    ])
      expect(() => parseCredentialKeyring(bad), bad).toThrow(
        "invalid_credential_encryption_key",
      );
  });
});

describe("18. upload box: web seals to the published X25519 key, worker opens it", () => {
  it("round-trips the CSD files and password; another tenant's or row's box is refused", async () => {
    const r = ring(entry("2026-10", 5));
    const { publicJwk } = uploadKeyPair(r);
    expect(publicJwk).toMatchObject({ kty: "OKP", crv: "X25519" });
    expect(Object.keys(publicJwk).sort()).toEqual(["crv", "kty", "x"]);
    const id = randomUUID();
    const bundle = {
      cer: bytes(TEST_CSD.cer),
      key: bytes(TEST_CSD.key),
      password: TEST_CSD_PASSWORD,
    };
    const jwe = await sealCsdUpload(
      { kid: "2026-10", jwk: publicJwk },
      bundle,
      { tenantId, id },
    );
    expect(jwe).not.toContain(TEST_CSD_PASSWORD);
    const opened = await openUploadBox(r, jwe, { tenantId, id });
    expect(Buffer.from(opened.cer).equals(bundle.cer)).toBe(true);
    expect(Buffer.from(opened.key).equals(bundle.key)).toBe(true);
    expect(opened.password).toBe(TEST_CSD_PASSWORD);
    expect(
      await vaultError(openUploadBox(r, jwe, { tenantId: otherTenant, id })),
    ).toBe("cfdi_vault_binding");
    expect(
      await vaultError(openUploadBox(r, jwe, { tenantId, id: randomUUID() })),
    ).toBe("cfdi_vault_binding");
    // Another worker keyring cannot open it either.
    expect(
      await vaultError(
        openUploadBox(ring(entry("2026-10", 6)), jwe, { tenantId, id }),
      ),
    ).toBe("cfdi_vault_binding");
  });

  it("the public key is stable per kid and differs across kids", () => {
    const r = ring(entry("a", 7), entry("b", 8));
    expect(uploadKeyPair(r, "a").publicJwk).toEqual(
      uploadKeyPair(r, "a").publicJwk,
    );
    expect(uploadKeyPair(r, "a").publicJwk.x).not.toBe(
      uploadKeyPair(r, "b").publicJwk.x,
    );
  });
});

describe("19. inspectCsd", () => {
  const now = new Date("2026-10-05T18:00:00Z");
  const files = (
    o: Partial<{ cer: string; key: string; password: string }> = {},
  ) => ({
    cer: bytes(o.cer ?? TEST_CSD.cer),
    key: bytes(o.key ?? TEST_CSD.key),
    password: o.password ?? TEST_CSD_PASSWORD,
  });
  const code = (f: ReturnType<typeof files>, at = now) => {
    try {
      inspectCsd(f, at);
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "ok";
  };

  it("reads the RFC (OID 2.5.4.45), the SAT serial and the validity, and checks the password and key pair", () => {
    expect(inspectCsd(files(), now)).toEqual({
      rfc: TEST_CSD_RFC,
      serial: TEST_CSD_SERIAL,
      validFrom: "2024-01-01T00:00:00.000Z",
      validUntil: "2034-12-31T23:59:59.000Z",
      looksLikeFiel: false,
      passwordChecked: true,
    });
    expect(inspectCsd(files({ cer: TEST_CSD.otherRfcCer }), now).rfc).toBe(
      "URE180429TM6",
    );
  });

  it("flags an e.firma (encipherment key usage), a wrong password, a mismatched key, expiry and garbage", () => {
    expect(code(files({ cer: TEST_CSD.fielCer }))).toBe("cfdi_csd_is_fiel");
    expect(code(files({ password: "wrong-password" }))).toBe(
      "cfdi_csd_password",
    );
    expect(code(files({ key: TEST_CSD.otherKey }))).toBe(
      "cfdi_csd_key_mismatch",
    );
    expect(code(files({ cer: TEST_CSD.expiredCer }))).toBe("cfdi_csd_expired");
    expect(code(files(), new Date("2023-06-01T00:00:00Z"))).toBe(
      "cfdi_csd_not_yet_valid",
    );
    expect(
      code(files({ cer: Buffer.from("not a cert").toString("base64") })),
    ).toBe("cfdi_csd_invalid");
    expect(
      code(files({ key: Buffer.from("not a key").toString("base64") })),
    ).not.toBe("ok");
  });

  it("reads keyUsage bits from the DER and decodes SAT serials", () => {
    expect(keyUsageBits(bytes(TEST_CSD.cer))).toBe(0xc000);
    expect(keyUsageBits(bytes(TEST_CSD.fielCer))).toBe(0xf000);
    expect(keyUsageBits(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(satSerial("3330303031303030303030353030303033343136")).toBe(
      "30001000000500003416",
    );
    expect(satSerial("0a1b")).toBe("0A1B");
  });
});

describe("21. configuration (server/cfdi/config.ts through loadConfig)", () => {
  const worker = { PROCESS_KIND: "worker" };
  const deployedWorker = {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_URL: "https://staging.example.com",
    PROCESS_KIND: "worker",
    WORKER_DATABASE_URL:
      "postgresql://gm_staging_worker:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_staging",
  };
  const webEnv = {
    DATABASE_URL: "postgresql://gm_app:pw@127.0.0.1:5432/green_monkey_dev",
    JWT_SECRET: "x".repeat(40),
  };
  const fails = (env: NodeJS.ProcessEnv, kind: "web" | "worker") => {
    try {
      loadConfig(env, kind);
    } catch (e) {
      if (e instanceof ConfigError) return e.code;
      throw e;
    }
    return "ok";
  };
  const key = entry("2026-10", 9);

  it("the worker refuses a malformed User key, test key or keyring, and a User key without a keyring", () => {
    expect(fails({ ...worker, FACTURAPI_API_KEY: "sk_test_x" }, "worker")).toBe(
      "invalid_facturapi_api_key",
    );
    expect(
      fails({ ...worker, FACTURAPI_TEST_KEY: "sk_user_x" }, "worker"),
    ).toBe("invalid_facturapi_test_key");
    expect(fails({ ...worker, FACTURAPI_API_KEY: "sk_user_x" }, "worker")).toBe(
      "missing_credential_encryption_key",
    );
    expect(
      fails(
        {
          ...worker,
          FACTURAPI_API_KEY: "sk_user_x",
          CREDENTIAL_ENCRYPTION_KEY: "k:short",
        },
        "worker",
      ),
    ).toBe("invalid_credential_encryption_key");
    expect(
      fails(
        {
          ...worker,
          FACTURAPI_API_KEY: "sk_user_x",
          CREDENTIAL_ENCRYPTION_KEY: key,
        },
        "worker",
      ),
    ).toBe("ok");
  });

  it("CFDI_LIVE_ENABLED only in production with a User key; the shared sandbox never in production", () => {
    expect(
      fails(
        {
          ...worker,
          FACTURAPI_API_KEY: "sk_user_x",
          CREDENTIAL_ENCRYPTION_KEY: key,
          CFDI_LIVE_ENABLED: "true",
        },
        "worker",
      ),
    ).toBe("cfdi_live_not_allowed");
    const production = { ...deployedWorker, APP_ENV: "production" };
    expect(
      fails({ ...production, FACTURAPI_TEST_KEY: "sk_test_x" }, "worker"),
    ).toBe("cfdi_shared_sandbox_not_allowed");
    expect(
      fails(
        {
          ...production,
          FACTURAPI_API_KEY: "sk_user_x",
          CREDENTIAL_ENCRYPTION_KEY: key,
          CFDI_LIVE_ENABLED: "true",
        },
        "worker",
      ),
    ).toBe("ok");
    expect(
      cfdiWorkerConfig(
        {
          FACTURAPI_API_KEY: "sk_user_x",
          CREDENTIAL_ENCRYPTION_KEY: key,
          CFDI_LIVE_ENABLED: "true",
          WORKER_DATABASE_URL: deployedWorker.WORKER_DATABASE_URL,
        },
        "production",
      ),
    ).toMatchObject({ provider: "organizations", liveEnabled: true });
  });

  it("FACTURAPI_BASE_URL only in development/test and only on a loopback host", () => {
    expect(
      fails(
        {
          ...worker,
          FACTURAPI_TEST_KEY: "sk_test_x",
          FACTURAPI_BASE_URL: "http://127.0.0.1:4799/v2",
        },
        "worker",
      ),
    ).toBe("ok");
    expect(
      fails(
        {
          ...worker,
          FACTURAPI_TEST_KEY: "sk_test_x",
          FACTURAPI_BASE_URL: "https://evil.example.com/v2",
        },
        "worker",
      ),
    ).toBe("cfdi_base_url_not_allowed");
    expect(
      fails(
        {
          ...deployedWorker,
          FACTURAPI_TEST_KEY: "sk_test_x",
          FACTURAPI_BASE_URL: "http://127.0.0.1:4799/v2",
        },
        "worker",
      ),
    ).toBe("cfdi_base_url_not_allowed");
  });

  it("a deployed worker refuses Facturapi keys without WORKER_DATABASE_URL; a local worker is exempt", () => {
    const { WORKER_DATABASE_URL: _omit, ...noLogin } = deployedWorker;
    void _omit;
    expect(
      fails({ ...noLogin, FACTURAPI_TEST_KEY: "sk_test_x" }, "worker"),
    ).toBe("cfdi_worker_database_required");
    expect(
      fails({ ...worker, FACTURAPI_TEST_KEY: "sk_test_x" }, "worker"),
    ).toBe("ok");
  });

  it("the grace minutes are bounded; the provider follows the keys", () => {
    expect(
      fails({ ...worker, CFDI_GLOBAL_GRACE_MINUTES: "601" }, "worker"),
    ).toBe("invalid_cfdi_global_grace_minutes");
    expect(cfdiWorkerConfig({}, "development")).toMatchObject({
      provider: "disabled",
      graceMinutes: 60,
    });
    expect(
      cfdiWorkerConfig(
        {
          FACTURAPI_TEST_KEY: "sk_test_x",
          WORKER_DATABASE_URL: deployedWorker.WORKER_DATABASE_URL,
        },
        "staging",
      ),
    ).toMatchObject({ provider: "sandbox_shared" });
  });

  it("the deployed web refuses FACTURAPI_BASE_URL and an out-of-range link expiry", () => {
    const deployedWeb = {
      ...webEnv,
      APP_ENV: "staging",
      NODE_ENV: "production",
      APP_URL: "https://staging.example.com",
      SIGNING_KEYS: entry("k1", 7),
    };
    expect(fails(deployedWeb, "web")).toBe("ok");
    expect(
      fails(
        { ...deployedWeb, FACTURAPI_BASE_URL: "http://127.0.0.1:4799/v2" },
        "web",
      ),
    ).toBe("cfdi_base_url_not_allowed");
    expect(
      fails({ ...webEnv, CFDI_INVOICE_LINK_EXPIRY_HOURS: "169" }, "web"),
    ).toBe("invalid_cfdi_invoice_link_expiry_hours");
    expect(cfdiWebConfig({}, "development")).toEqual({ linkExpiryHours: 72 });
    expect(
      cfdiWebConfig({ CFDI_INVOICE_LINK_EXPIRY_HOURS: "24" }, "production"),
    ).toEqual({ linkExpiryHours: 24 });
  });
});

describe("25. redaction", () => {
  it("redact() masks sk_user_, sk_test_ and sk_live_ values in strings, error messages and nested attributes", () => {
    const out = redact({
      message: "Facturapi refused sk_user_abcDEF123 and sk_live_zzz9",
      nested: { deeper: ["key sk_test_qwerty0 here"] },
      error: new Error("bad key sk_user_secretvalue"),
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/sk_(user|test|live)_[A-Za-z0-9]/);
    expect(text).toContain("[redacted]");
  });
});

describe("credential key generator (CFDI-SECRETS-5)", () => {
  it("two keys generated the same day have different kids, which the keyring accepts together", () => {
    const run = () =>
      execFileSync(process.execPath, [
        "scripts/cfdi-generate-credential-key.mjs",
      ])
        .toString()
        .trim();
    const a = run();
    const b = run();
    expect(a.split(":")[0]).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    expect(a.split(":")[0]).not.toBe(b.split(":")[0]);
    expect(parseCredentialKeyring(`${b},${a}`).kids).toEqual([
      b.split(":")[0],
      a.split(":")[0],
    ]);
  });
});
