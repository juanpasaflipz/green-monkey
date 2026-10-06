import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tsx = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
const script = resolve("scripts/pairing-code.ts");
const tenant = "10000000-0000-4000-8000-000000000001";

/** Runs the CLI from an empty directory (no .env) with exactly these variables. */
function run(url: string, confirm: string) {
  const dir = mkdtempSync(join(tmpdir(), "gm-pairing-cli-"));
  try {
    return spawnSync(
      process.execPath,
      [
        "--import",
        tsx,
        script,
        "--tenant",
        tenant,
        "--name",
        "Caja 1",
        "--confirm-target",
        confirm,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          MIGRATION_DATABASE_URL: url,
          JWT_SECRET: "synthetic-pairing-cli-test-secret-0123456789",
        },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pairing CLI (access A4)", () => {
  it("refuses a non-loopback target before connecting, even with a matching --confirm-target", () => {
    for (const [url, identity] of [
      [
        "postgresql://gm_migrator:pw@ep-x.us-east-1.aws.neon.tech/green_monkey_staging",
        "ep-x.us-east-1.aws.neon.tech:5432/green_monkey_staging",
      ],
      // A routable address that would hang if the CLI tried to connect.
      [
        "postgresql://gm_migrator:pw@10.255.255.1:5432/x",
        "10.255.255.1:5432/x",
      ],
    ]) {
      const started = Date.now();
      const r = run(url, identity);
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain(
        "pairing CLI is limited to local and CI databases",
      );
      expect(r.stderr).not.toMatch(
        /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|CONNECT_TIMEOUT/,
      );
      expect(r.stdout).toBe("");
      expect(Date.now() - started).toBeLessThan(20_000);
    }
  });

  it("still requires --confirm-target to name the target first", () => {
    const r = run(
      "postgresql://gm_migrator:pw@ep-x.us-east-1.aws.neon.tech/green_monkey_staging",
      "wrong",
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--confirm-target must equal");
  });

  it("lets a loopback target through to the database step", () => {
    // Port 1 on loopback refuses the connection: the CLI got past the guard.
    const r = run(
      "postgresql://gm_migrator:pw@127.0.0.1:1/green_monkey_dev",
      "127.0.0.1:1/green_monkey_dev",
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("limited to local and CI databases");
    expect(r.stderr).toMatch(/ECONNREFUSED|connect/i);
  });
});
