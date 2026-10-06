import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { supportProvisionTarget } from "../scripts/support-provision-target";

const run = promisify(execFile);
const owner = (database: string, host = "ep-owner.neon.tech") =>
  `postgresql://neondb_owner:secret@${host}/${database}?sslmode=require`;

describe("support operator provisioning targets (LD-32 OPS-1, LD-34 Q19)", () => {
  it("accepts the databases ops provisioning creates when the target repeats them", () => {
    // scripts/ops/provision-neon.sh names them green_monkey_<env>.
    for (const env of ["production", "staging", "test", "pilot2"])
      expect(
        supportProvisionTarget(
          owner(`green_monkey_${env}`),
          `ep-owner.neon.tech:5432/green_monkey_${env}`,
        ),
      ).toEqual({
        target: `ep-owner.neon.tech:5432/green_monkey_${env}`,
        database: `green_monkey_${env}`,
      });
  });

  it("accepts the local and acceptance databases", () => {
    for (const db of [
      "green_monkey_dev",
      "green_monkey_acceptance_dev",
      "green_monkey_account_dev",
    ])
      expect(
        supportProvisionTarget(
          `postgresql://gm_provisioner:x@127.0.0.1:55439/${db}`,
          `127.0.0.1:55439/${db}`,
        ).database,
      ).toBe(db);
  });

  it("refuses a missing or mismatched target and any other database name", () => {
    const url = owner("green_monkey_production");
    for (const expected of [
      undefined,
      "",
      "ep-owner.neon.tech:5432/green_monkey_staging",
      "ep-other.neon.tech:5432/green_monkey_production",
      "ep-owner.neon.tech:5433/green_monkey_production",
    ])
      expect(() => supportProvisionTarget(url, expected), expected).toThrow(
        "explicit_support_provision_target_required",
      );
    for (const db of [
      "postgres",
      "neondb",
      "green_monkey",
      "green_monkey_",
      "green_monkey_Production",
      "green_monkey_prod-1",
      "other_green_monkey_dev",
      "green_monkey_production_copy_x_y",
    ])
      expect(
        () =>
          supportProvisionTarget(
            `postgresql://u:p@db.local:5432/${db}`,
            `db.local:5432/${db}`,
          ),
        db,
      ).toThrow("explicit_support_provision_target_required");
  });

  it("the script accepts the production database ops creates (it then fails only on the connection)", async () => {
    const env = {
      ...process.env,
      PROVISION_DATABASE_URL:
        "postgresql://neondb_owner:x@127.0.0.1:9/green_monkey_production",
      SUPPORT_PROVISION_TARGET: "127.0.0.1:9/green_monkey_production",
      DOTENV_CONFIG_PATH: "/dev/null",
    };
    const failure = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/provision-support-operator.ts",
        "--name",
        "ana",
      ],
      { env, timeout: 30_000 },
    ).catch((e: { stderr: string }) => e);
    expect("stderr" in failure ? failure.stderr : "").not.toContain(
      "explicit_support_provision_target_required",
    );
    const refused = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/provision-support-operator.ts",
        "--name",
        "ana",
      ],
      {
        env: {
          ...env,
          SUPPORT_PROVISION_TARGET: "127.0.0.1:9/green_monkey_staging",
        },
        timeout: 30_000,
      },
    ).catch((e: { stderr: string }) => e);
    expect("stderr" in refused ? refused.stderr : "").toContain(
      "explicit_support_provision_target_required",
    );
  }, 60_000);
});
