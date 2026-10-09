// Generalized vault (payments spec §9.1, §12.1): the CFDI instance keeps its derivation, so a
// ciphertext sealed before the generalization still opens; the payments instance binds its own
// typ and purposes; neither area opens the other's ciphertexts; sealUpload (web) round-trips with
// the worker's openUpload. Pure: no database, no network.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  openSecret as cfdiOpenSecret,
  openUploadBox,
  parseCredentialKeyring,
  sealSecret as cfdiSealSecret,
  uploadKeyPair as cfdiUploadKeyPair,
  VaultError,
} from "../server/cfdi/vault";
import { paymentsVault, PAYMENTS_UPLOAD_TYP } from "../server/vault/vault";
import { sealUpload } from "../server/vault/seal-upload";

const entry = (kid: string, fill: number) =>
  `${kid}:${Buffer.alloc(32, fill).toString("base64url")}`;
const ring = (...entries: string[]) =>
  parseCredentialKeyring(entries.join(","));
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VaultError) return e.code;
    throw e;
  }
  throw new Error("expected a VaultError");
}

// Sealed with server/cfdi/vault.ts as it was before the generalization (track/payments 63d33f8),
// keyring "fixture-1" = 32 bytes of 0x07. These must keep opening.
const FIXTURE = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  secretId: "22222222-2222-4222-8222-222222222222",
  uploadId: "33333333-3333-4333-8333-333333333333",
  secret:
    "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoiZml4dHVyZS0xIiwidHlwIjoiZ20tY2ZkaS1zZWNyZXQiLCJ0aWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJwdXIiOiJvcmdfbGl2ZV9rZXkiLCJyaWQiOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIifQ..1VUI5OduoIUT0PTx.1cHukFtQGujQJ0W7jWNLxb-0p6NG.ZQS_xhdF0wR6Dh4VvLN7Yg",
  box: "eyJhbGciOiJFQ0RILUVTIiwiZW5jIjoiQTI1NkdDTSIsImtpZCI6ImZpeHR1cmUtMSIsInR5cCI6ImdtLWNmZGktY3NkIiwidGlkIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwicHVyIjoiY3NkX3VwbG9hZCIsInJpZCI6IjMzMzMzMzMzLTMzMzMtNDMzMy04MzMzLTMzMzMzMzMzMzMzMyIsImVwayI6eyJ4IjoiRTkwbWJiUXY3WlNjTW5GWWZDUGtHdDk5a1VJZW5Bd0JFa3F2VkJmNHZ6SSIsImNydiI6IlgyNTUxOSIsImt0eSI6Ik9LUCJ9fQ..m6_w_5bFio01fz8X.uRzALjj82SIdBKBd-mbwxpS963zMKlJCcSXg-9BHvo-JILngfbd-fKTqcA.kR5VrCRw_NS-0GEIXhs9og",
  uploadX: "CDlDfMG06MjG_8pl8Mae0hWqp3hIx2zuQ1TR4klKpB4",
};
const fixtureRing = () => ring(entry("fixture-1", 7));

describe("vault: CFDI vectors unchanged by the generalization", () => {
  it("a pre-generalization organization key opens with the same keyring", async () => {
    expect(
      await cfdiOpenSecret(fixtureRing(), FIXTURE.secret, {
        tenantId: FIXTURE.tenantId,
        purpose: "org_live_key",
        id: FIXTURE.secretId,
      }),
    ).toBe("sk_live_fixture_value");
  });

  it("a pre-generalization CSD upload box opens, and the published upload key is the same", async () => {
    const r = fixtureRing();
    expect(cfdiUploadKeyPair(r).publicJwk.x).toBe(FIXTURE.uploadX);
    const bundle = await openUploadBox(r, FIXTURE.box, {
      tenantId: FIXTURE.tenantId,
      id: FIXTURE.uploadId,
    });
    expect(Buffer.from(bundle.cer).toString()).toBe("cer");
    expect(Buffer.from(bundle.key).toString()).toBe("key");
    expect(bundle.password).toBe("pw");
  });

  it("the CFDI error codes keep their cfdi_vault_ prefix", async () => {
    expect(
      await code(
        cfdiOpenSecret(ring(entry("other", 9)), FIXTURE.secret, {
          tenantId: FIXTURE.tenantId,
          purpose: "org_live_key",
          id: FIXTURE.secretId,
        }),
      ),
    ).toBe("cfdi_vault_unknown_kid");
  });
});

describe("vault: payments instance", () => {
  const tenantId = randomUUID();
  it("round-trips provider credentials bound to tenant, purpose and row", async () => {
    const r = ring(entry("2026-10", 1));
    const b = { tenantId, purpose: "mp_credentials" as const, id: randomUUID() };
    const { jwe, kid } = await paymentsVault.sealSecret(r, '{"accessToken":"x"}', b);
    expect(kid).toBe("2026-10");
    expect(jwe).not.toContain("accessToken");
    expect(await paymentsVault.openSecret(r, jwe, b)).toBe('{"accessToken":"x"}');
    expect(
      await code(paymentsVault.openSecret(r, jwe, { ...b, purpose: "clip_credentials" })),
    ).toBe("payments_vault_binding");
    expect(
      await code(paymentsVault.openSecret(r, jwe, { ...b, tenantId: randomUUID() })),
    ).toBe("payments_vault_binding");
  });

  it("derives keys of its own: a payments ciphertext never opens as CFDI and vice versa", async () => {
    const r = ring(entry("k1", 3));
    const id = randomUUID();
    const pay = await paymentsVault.sealSecret(r, "secret", {
      tenantId,
      purpose: "mp_credentials",
      id,
    });
    // Same tenant and row, the CFDI typ: the binding (typ) refuses it before any key is tried.
    expect(
      await code(
        cfdiOpenSecret(r, pay.jwe, { tenantId, purpose: "org_test_key", id }),
      ),
    ).toBe("cfdi_vault_binding");
    const cfdi = await cfdiSealSecret(r, "secret", {
      tenantId,
      purpose: "org_test_key",
      id,
    });
    expect(
      await code(
        paymentsVault.openSecret(r, cfdi.jwe, {
          tenantId,
          purpose: "org_test_key" as never,
          id,
        }),
      ),
    ).toBe("payments_vault_binding");
    // The upload key pairs differ for the same keyring entry (salt and info).
    expect(paymentsVault.uploadKeyPair(r).publicJwk.x).not.toBe(
      cfdiUploadKeyPair(r).publicJwk.x,
    );
  });

  it("the web's sealUpload opens in the worker with the published key; a box for another row or area is refused", async () => {
    const r = ring(entry("k2", 5));
    const pub = { kid: "k2", jwk: paymentsVault.uploadKeyPair(r).publicJwk };
    const id = randomUUID();
    const box = await sealUpload(pub, '{"provider":"clip"}', {
      typ: PAYMENTS_UPLOAD_TYP,
      tenantId,
      purpose: "credentials_upload",
      id,
    });
    expect(
      Buffer.from(await paymentsVault.openUpload(r, box, { tenantId, id })).toString(),
    ).toBe('{"provider":"clip"}');
    expect(
      await code(paymentsVault.openUpload(r, box, { tenantId, id: randomUUID() })),
    ).toBe("payments_vault_binding");
    const cfdiTyped = await sealUpload(pub, "{}", {
      typ: "gm-cfdi-csd",
      tenantId,
      purpose: "credentials_upload",
      id,
    });
    expect(
      await code(paymentsVault.openUpload(r, cfdiTyped, { tenantId, id })),
    ).toBe("payments_vault_binding");
  });

  it("rotation: a secret sealed under an old kid opens while that kid is listed and is re-sealed under the active one", async () => {
    const old = ring(entry("old", 1));
    const b = { tenantId, purpose: "clip_credentials" as const, id: randomUUID() };
    const sealed = await paymentsVault.sealSecret(old, "v", b);
    const rotated = ring(entry("new", 2), entry("old", 1));
    expect(paymentsVault.kidOf(sealed.jwe)).toBe("old");
    const plain = await paymentsVault.openSecret(rotated, sealed.jwe, b);
    const resealed = await paymentsVault.sealSecret(rotated, plain, b);
    expect(resealed.kid).toBe("new");
    expect(
      await paymentsVault.openSecret(ring(entry("new", 2)), resealed.jwe, b),
    ).toBe("v");
    expect(
      await code(paymentsVault.openSecret(ring(entry("new", 2)), sealed.jwe, b)),
    ).toBe("payments_vault_unknown_kid");
  });
});
