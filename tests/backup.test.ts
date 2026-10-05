import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_CA_FILE,
  monthPrefixes,
  pgDumpCommand,
  uploadPrefixes,
} from "../scripts/ops/backup.js";

const neon = new URL(
  "postgresql://gm_backup:secret@ep-quiet-sun-a1b2c3.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
);
const dsnOf = (argv: string[]) =>
  new URL(argv.find((a) => a.startsWith("--dbname="))!.slice(9));

describe("backup pg_dump command (OPS-R5 regression)", () => {
  it("a native pg_dump verifies the server against the system trust store", () => {
    const { dump, version } = pgDumpCommand({
      url: neon,
      snapshot: "00000003-0000001B-1",
      pgDump: "/usr/lib/postgresql/18/bin/pg_dump",
    });
    expect(dump[0]).toBe("/usr/lib/postgresql/18/bin/pg_dump");
    expect(version).toEqual([
      "/usr/lib/postgresql/18/bin/pg_dump",
      "--version",
    ]);
    const dsn = dsnOf(dump);
    expect(dsn.searchParams.get("sslmode")).toBe("verify-full");
    expect(dsn.searchParams.get("sslrootcert")).toBe("system");
    // Credentials travel in PGPASSWORD; the URL's own parameters are dropped.
    expect(dsn.password).toBe("");
    expect(dsn.searchParams.has("channel_binding")).toBe(false);
    expect(dump).toContain("--snapshot=00000003-0000001B-1");
    expect(dump).toContain("--enable-row-security");
  });

  it("the postgres:18 container gets the host CA bundle mounted and named as sslrootcert", () => {
    const { dump } = pgDumpCommand({ url: neon, snapshot: "s" });
    const mount = dump[dump.indexOf("-v") + 1];
    expect(dump.indexOf("-v")).toBeGreaterThan(-1);
    expect(dump.indexOf("-v")).toBeLessThan(dump.indexOf("postgres:18"));
    const [host, container, mode] = mount.split(":");
    expect(host).toBe(DEFAULT_CA_FILE);
    expect(mode).toBe("ro");
    const dsn = dsnOf(dump);
    expect(dsn.searchParams.get("sslmode")).toBe("verify-full");
    // Never "system": the image purges ca-certificates.
    expect(dsn.searchParams.get("sslrootcert")).toBe(container);
    const custom = pgDumpCommand({
      url: neon,
      snapshot: "s",
      caFile: "/opt/ca.pem",
    }).dump;
    expect(custom[custom.indexOf("-v") + 1]).toBe(
      `/opt/ca.pem:${container}:ro`,
    );
  });

  it("loopback rehearsals need no TLS and no mount", () => {
    const local = new URL(
      "postgresql://gm_backup:x@127.0.0.1:5432/green_monkey_test",
    );
    for (const pgDump of [undefined, "pg_dump"]) {
      const { dump } = pgDumpCommand({ url: local, snapshot: "s", pgDump });
      expect(dump).not.toContain("-v");
      expect(dsnOf(dump).searchParams.has("sslmode")).toBe(false);
    }
  });

  it("the backup workflow uses the runner's PostgreSQL 18 client", () => {
    const workflow = readFileSync(".github/workflows/backup.yml", "utf8");
    expect(workflow).toContain(
      "apt-get install -y -qq age postgresql-client-18",
    );
    expect(workflow).toContain(
      "BACKUP_PG_DUMP: /usr/lib/postgresql/18/bin/pg_dump",
    );
  });
});

describe("monthly long-term copy (OPS-R13 regression)", () => {
  const second = new Date("2026-11-02T09:30:00Z");
  const { daily, monthly } = monthPrefixes("production", second);

  it("uses UTC year and month prefixes", () => {
    expect(daily).toBe("daily/production/2026/11");
    expect(monthly).toBe("monthly/production/2026/11");
    expect(monthPrefixes("staging", new Date("2026-12-31T23:59:59Z"))).toEqual({
      daily: "daily/staging/2026/12",
      monthly: "monthly/staging/2026/12",
    });
  });

  it("the first successful backup of the month writes it, whatever the day", () => {
    // The backup on the 1st failed: nothing under monthly/ yet.
    expect(uploadPrefixes("production", second, [])).toEqual({
      daily,
      monthly,
    });
  });

  it("a complete copy (manifest present) is not written again", () => {
    expect(
      uploadPrefixes("production", second, [
        `${monthly}/gm-production-20261102T093000Z.dump.age`,
        `${monthly}/gm-production-20261102T093000Z.dump.age.manifest.json`,
      ]),
    ).toEqual({ daily, monthly: null });
  });

  it("a dump left without its manifest by a failed run does not count", () => {
    expect(
      uploadPrefixes("production", second, [
        `${monthly}/gm-production-20261101T093000Z.dump.age`,
      ]),
    ).toEqual({ daily, monthly });
    // Keys from another month or environment never count.
    expect(
      uploadPrefixes("production", second, [
        "monthly/production/2026/10/gm-production-20261001T093000Z.dump.age.manifest.json",
        "monthly/staging/2026/11/gm-staging-20261101T100000Z.dump.age.manifest.json",
      ]),
    ).toEqual({ daily, monthly });
  });
});
