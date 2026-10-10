import { describe, expect, it } from "vitest";
import { branchBackupUrl } from "../scripts/ops/branch-url.js";

const source = new URL(
  "postgresql://gm_production_backup:source-pw-not-real@ep-source.us-east-1.aws.neon.tech/green_monkey_production?sslmode=verify-full",
);

describe("branchBackupUrl (restore drill's point-in-time branch)", () => {
  it("takes the branch's host and its own password for the backup role", () => {
    const url = branchBackupUrl(
      source,
      "postgresql://gm_production_backup:branch-pw-not-real@ep-branch.us-east-1.aws.neon.tech/green_monkey_production?sslmode=require&channel_binding=require\n",
    );
    expect(url.hostname).toBe("ep-branch.us-east-1.aws.neon.tech");
    expect(url.password).toBe("branch-pw-not-real");
    expect(url.username).toBe("gm_production_backup");
    expect(url.pathname).toBe("/green_monkey_production");
    // The source's TLS parameters are kept (verify-full), not neonctl's sslmode=require.
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.has("channel_binding")).toBe(false);
  });
  it("refuses a connection string for another role", () => {
    expect(() =>
      branchBackupUrl(
        source,
        "postgresql://neondb_owner:x-not-real@ep-branch.us-east-1.aws.neon.tech/green_monkey_production",
      ),
    ).toThrow(/another role/);
  });
  it("refuses a connection string without a password", () => {
    expect(() =>
      branchBackupUrl(
        source,
        "postgresql://gm_production_backup@ep-branch.us-east-1.aws.neon.tech/green_monkey_production",
      ),
    ).toThrow(/no host or password/);
  });
});
