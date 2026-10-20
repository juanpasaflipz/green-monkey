import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cardClaims } from "../server/loyalty/engagement";
import {
  engagementSettings,
  loyaltyMessage,
  SCAN_CODE,
} from "../shared/loyalty-engagement";
import {
  googleObject,
  type WalletSnapshot,
} from "../server/loyalty-worker/wallet";
import {
  signAppleBundle,
  passArchive,
} from "../server/loyalty-worker/apple-bundle";
const exec = promisify(execFile);
describe("loyalty engagement boundaries", () => {
  it("refuses unsafe review links and out-of-range incentives", () => {
    for (const reviewUrl of [
      "javascript:alert(1)",
      "http://example.com",
      "https://user:password@example.com",
    ])
      expect(engagementSettings.safeParse({ reviewUrl }).success).toBe(false);
    for (const referralBonus of [0, 21, 1.5])
      expect(engagementSettings.safeParse({ referralBonus }).success).toBe(
        false,
      );
    expect(engagementSettings.parse({}).smsEnabled).toBe(false);
  });
  it("requires exact card credentials; scan identifiers are not portal credentials", () => {
    const tenant = randomUUID(),
      member = randomUUID(),
      token = `${tenant}.${member}.${"a".repeat(43)}`;
    expect(cardClaims(token)).toEqual({ tenantId: tenant, memberId: member });
    for (const bad of [
      "",
      token + ".x",
      token.slice(0, -1),
      `${"-".repeat(36)}.${member}.${"a".repeat(43)}`,
      "gm-club:" + "a".repeat(32),
    ])
      expect(() => cardClaims(bad)).toThrow();
    expect(SCAN_CODE.test(token)).toBe(false);
  });
  it("wallet objects contain balances and scan ids, not contact information", () => {
    const snapshot: WalletSnapshot = {
      tenantId: randomUUID(),
      memberId: randomUUID(),
      restaurant: "Synthetic Cafe",
      program: "Club",
      stamps: 3,
      required: 10,
      rewards: 1,
      reward: "Free item",
      scan: "a".repeat(32),
      referral: null,
      generation: "hash",
      active: false,
    };
    const object = googleObject(snapshot, "123");
    expect(object.state).toBe("INACTIVE");
    expect(googleObject({...snapshot,scan:"b".repeat(32)},"123").id).not.toBe(object.id);
    expect(object.barcode.value).toBe("gm-club:" + "a".repeat(32));
    expect(JSON.stringify(object)).not.toMatch(/phone|email|generation/);
  });
  it("messages explain current progress and include opt-out instructions", () => {
    const text = loyaltyMessage("reminder", {
      restaurant: "Synthetic Cafe",
      stamps: 2,
      required: 10,
      rewards: 1,
      reviewUrl: "",
    });
    expect(text).toContain("2/10");
    expect(text).toContain("STOP");
  });
  it("refuses archive traversal", () =>
    expect(() => passArchive({ "../key.pem": Buffer.from("x") })).toThrow());
  it("produces a ZIP with a detached signature that OpenSSL independently verifies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gm-pass-test-"));
    try {
      await exec("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=Synthetic Wallet Test",
      ]);
      const cert = await readFile(join(dir, "cert.pem")),
        key = await readFile(join(dir, "key.pem"));
      const files = {
        "pass.json": Buffer.from(
          JSON.stringify({ formatVersion: 1, description: "Synthetic" }),
        ),
      };
      const bundle = await signAppleBundle(files, { cert, key, wwdr: cert });
      await writeFile(join(dir, "card.pkpass"), bundle);
      await exec("unzip", ["-t", join(dir, "card.pkpass")]);
      await exec("unzip", [
        "-o",
        join(dir, "card.pkpass"),
        "-d",
        join(dir, "pass"),
      ]);
      const result = await exec("openssl", [
        "smime",
        "-verify",
        "-inform",
        "DER",
        "-in",
        join(dir, "pass/signature"),
        "-content",
        join(dir, "pass/manifest.json"),
        "-noverify",
      ]);
      expect(JSON.parse(result.stdout)["pass.json"]).toMatch(/^[a-f0-9]{40}$/);
      expect(await readFile(join(dir, "pass/pass.json"), "utf8")).toBe(
        files["pass.json"].toString(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});
