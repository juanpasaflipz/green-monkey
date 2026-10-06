import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * tsconfig.server.json covers scripts/*.ts only, so the user-run ops and load
 * scripts (backup, restore verification, rehearsal, rotation, load test) were
 * never type-checked (OPS-R14). scripts/ops/tsconfig.json extends the server
 * options without emitting; `npm test` runs it here, locally and in CI.
 */
describe("ops and load scripts type-check", () => {
  it("tsc -p scripts/ops/tsconfig.json reports no errors", () => {
    const tsc = resolve("node_modules/typescript/bin/tsc");
    let output: string;
    try {
      output = execFileSync(
        process.execPath,
        [tsc, "-p", "scripts/ops/tsconfig.json", "--pretty", "false"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? error);
    }
    expect(output.trim()).toBe("");
    const files = execFileSync(
      process.execPath,
      [tsc, "-p", "scripts/ops/tsconfig.json", "--listFilesOnly"],
      { encoding: "utf8" },
    );
    for (const script of [
      "scripts/ops/backup.ts",
      "scripts/ops/restore-verify.ts",
      "scripts/ops/rehearse-neon-restore.ts",
      "scripts/ops/rotate-db-login.ts",
      "scripts/load/run-load.ts",
      "scripts/load/seed-load.ts",
    ])
      expect(files, script).toContain(resolve(script));
  }, 120_000);
});
