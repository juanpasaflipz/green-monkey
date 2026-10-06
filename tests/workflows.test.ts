import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inRetentionWindow } from "../server/ops/retention.js";
import { forbiddenCredentials } from "../server/config-rules.js";

/**
 * CI/CD workflow rules that the local suites cannot exercise end to end.
 * The files are checked as text (no YAML dependency in this wave); where a
 * rule is shell logic, the marked block is extracted and executed.
 */
const read = (path: string) => readFileSync(path, "utf8");
const deploy = read(".github/workflows/deploy.yml");
const action = read(".github/actions/deploy/action.yml");
const backup = read(".github/workflows/backup.yml");
const uptime = read(".github/workflows/uptime.yml");
const retention = read(".github/workflows/retention.yml");
const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The `- name:` / `- uses:` step blocks of a workflow or composite action. */
function steps(text: string) {
  return text
    .split(/\n(?=\s*- (?:name|uses|run|id):)/)
    .filter((block) => /^\s*- (?:name|uses|run|id):/.test(block));
}

/** The lines between `# >>> name` and `# <<< name`, de-indented. */
function marked(text: string, name: string) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(`# >>> ${name}`));
  const end = lines.findIndex((l) => l.includes(`# <<< ${name}`));
  expect(start, `${name} start marker`).toBeGreaterThan(-1);
  expect(end, `${name} end marker`).toBeGreaterThan(start);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(
    ...body.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length),
  );
  return body.map((l) => l.slice(indent)).join("\n");
}

describe("deploy: a rollback never re-applies an older Railway IaC (OPS-R4 regression)", () => {
  it("the IaC install, plan and apply steps run only when sync-config is true", () => {
    const iac = steps(action).filter((s) =>
      /config (plan|apply)|railway@\$RAILWAY_IAC_VERSION/.test(s),
    );
    expect(iac.length).toBe(2);
    for (const step of iac)
      expect(step).toMatch(/\n\s*if: inputs\.sync-config == 'true'\n/);
    // Never forced through a destructive plan.
    const commands = action
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(commands).not.toContain("--confirm-destructive");
    // The deploy itself (stamp, upload, smoke) is unconditional.
    const upload = steps(action).find((s) => s.includes("up --ci"))!;
    expect(upload).not.toMatch(/\n\s*if:/);
  });

  it("production passes the guard's decision; staging always syncs (head of main)", () => {
    const [, staging, production] = deploy.split(
      /\n {2}(?=staging:|production:)/,
    );
    expect(staging).not.toContain("sync-config");
    expect(production).toContain(
      "sync-config: ${{ steps.guard.outputs.sync_config }}",
    );
    expect(production).toMatch(/- name: Guard\n\s+id: guard\n/);
    expect(deploy).toMatch(
      /railway_config:[\s\S]*options: \[auto, apply, skip\]/,
    );
  });

  it("auto syncs only the head of main; apply and skip override; anything else fails", () => {
    const decision = marked(deploy, "iac-sync-decision");
    const dir = mkdtempSync(join(tmpdir(), "gm-iac-sync-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@example.invalid",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@example.invalid",
          },
        }).trim();
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "old");
      const old = git("rev-parse", "HEAD");
      git("commit", "-q", "--allow-empty", "-m", "head");
      const head = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", head);
      const script = join(dir, "decision.sh");
      writeFileSync(script, `set -euo pipefail\n${decision}\n`);
      const decide = (sha: string, mode?: string) => {
        const output = join(dir, "output");
        writeFileSync(output, "");
        try {
          execFileSync("bash", [script], {
            cwd: dir,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              SHA: sha,
              RAILWAY_CONFIG: mode ?? "",
              GITHUB_OUTPUT: output,
            },
          });
        } catch {
          return "error";
        }
        return read(output).trim();
      };
      expect(decide(head)).toBe("sync_config=true");
      expect(decide(head, "auto")).toBe("sync_config=true");
      expect(decide(old, "auto")).toBe("sync_config=false");
      expect(decide(old, "apply")).toBe("sync_config=true");
      expect(decide(head, "skip")).toBe("sync_config=false");
      expect(decide(head, "always")).toBe("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrations, grants and retention run in GitHub Actions as gm_migrator (Wave 2.0 (l), DB-1)", () => {
  it("the deploy action's migrate step comes before every step that runs a railway command", () => {
    const all = steps(action);
    const migrate = all.findIndex((s) =>
      s.includes("node build/scripts/migrate.js --grants --retention"),
    );
    expect(migrate).toBeGreaterThan(-1);
    const build = all.findIndex((s) => s.includes("npm run build"));
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(migrate);
    const railway = all
      .map((s, i) => [s, i] as const)
      .filter(([s]) => /railway(\/cli)?@|railway@|@railway\/cli/.test(s));
    expect(railway.length).toBeGreaterThanOrEqual(3);
    for (const [, i] of railway) expect(i).toBeGreaterThan(migrate);
    // The migrate step is unconditional and fails before Railway without its inputs.
    const step = all[migrate];
    expect(step).not.toMatch(/\n\s*if:/);
    expect(step).toContain(
      'echo "::error::environment secret MIGRATION_DATABASE_URL is not set"; exit 1;',
    );
    expect(step).toContain(
      "MIGRATION_DATABASE_URL: ${{ inputs.migration-database-url }}",
    );
    for (const input of [
      "migration-database-url",
      "pg-app-user",
      "app-env",
      "alert-webhook-url",
      "alert-webhook-kind",
    ])
      expect(action).toMatch(new RegExp(`\\n  ${input}:\\n`));
    // No step uploads before the migrate step, and nothing preDeploys.
    expect(action).not.toMatch(/preDeploy/i);
  });

  it("the migrate step's guard refuses a missing secret, PG_APP_USER or app-env before running migrate.js", () => {
    const step = steps(action).find((s) =>
      s.includes("node build/scripts/migrate.js"),
    )!;
    const body = step
      .split("run: |\n")[1]
      .split("\n")
      .map((l) => l.replace(/^ {8}/, ""))
      .join("\n")
      .replace(
        "node build/scripts/migrate.js --grants --retention",
        "echo MIGRATED",
      );
    const run = (env: Record<string, string>) => {
      try {
        return execFileSync("bash", ["-c", `set -euo pipefail\n${body}`], {
          env: { PATH: process.env.PATH ?? "", ...env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const e = error as { stdout: string; status: number };
        return `exit ${e.status}: ${e.stdout}`;
      }
    };
    const ok = {
      MIGRATION_DATABASE_URL: "postgresql://m@h/d",
      PG_APP_USER: "gm_staging_app",
      APP_ENV: "staging",
    };
    expect(run(ok).trim()).toBe("MIGRATED");
    expect(run({ ...ok, APP_ENV: "production" }).trim()).toBe("MIGRATED");
    expect(run({ ...ok, MIGRATION_DATABASE_URL: "" })).toContain(
      "environment secret MIGRATION_DATABASE_URL is not set",
    );
    expect(run({ ...ok, PG_APP_USER: "" })).toContain(
      "environment variable PG_APP_USER is not set",
    );
    expect(run({ ...ok, PG_APP_USER: "x; drop" })).toContain("exit 1");
    expect(run({ ...ok, APP_ENV: "development" })).toContain(
      "app-env must be staging or production",
    );
  });

  it("deploy.yml passes migration-database-url only from secrets.MIGRATION_DATABASE_URL, in both jobs, with app-env staging and production", () => {
    const [, staging, production] = deploy.split(
      /\n {2}(?=staging:|production:)/,
    );
    for (const [job, appEnv] of [
      [staging, "staging"],
      [production, "production"],
    ] as const) {
      const call = job.slice(job.indexOf("uses: ./.github/actions/deploy"));
      expect(call).toContain(
        "migration-database-url: ${{ secrets.MIGRATION_DATABASE_URL }}",
      );
      expect(call).toContain("pg-app-user: ${{ vars.PG_APP_USER }}");
      expect(call).toContain(`app-env: ${appEnv}\n`);
      expect(call).toContain(
        "alert-webhook-url: ${{ secrets.ALERT_WEBHOOK_URL }}",
      );
      expect(call).toContain(
        "alert-webhook-kind: ${{ vars.ALERT_WEBHOOK_KIND || 'ntfy' }}",
      );
    }
    expect(deploy.match(/migration-database-url:/g)).toHaveLength(2);
    expect(
      deploy.match(
        /migration-database-url: \$\{\{ secrets\.MIGRATION_DATABASE_URL \}\}/g,
      ),
    ).toHaveLength(2);
    // Only the deploy and retention workflows read the schema-owner secret (R6).
    for (const file of readdirSync(".github/workflows")) {
      const text = read(`.github/workflows/${file}`);
      if (file === "deploy.yml" || file === "retention.yml")
        expect(text, file).toContain("secrets.MIGRATION_DATABASE_URL");
      else expect(text, file).not.toContain("secrets.MIGRATION_DATABASE_URL");
    }
  });

  it("retention.yml runs scripts/migrate.ts --retention-only with pinned actions and the environment secret, and its crons fall inside RETENTION_WINDOW and at least 90 minutes after backup.yml's production cron", () => {
    const pass = steps(retention).find((s) => s.includes("--retention-only"))!;
    expect(pass).toContain(
      "npx --no-install tsx scripts/migrate.ts --retention-only",
    );
    expect(pass).toContain(
      "MIGRATION_DATABASE_URL: ${{ secrets.MIGRATION_DATABASE_URL }}",
    );
    expect(pass).toContain("APP_ENV: ${{ env.RETENTION_ENV }}");
    expect(retention).toMatch(/\n {4}environment: \$\{\{ /);
    expect(retention).toContain("timeout-minutes: 50");
    const envExpression =
      "github.event_name == 'workflow_dispatch' && inputs.environment || (github.event.schedule == '15 11 * * *' && 'production' || 'staging')";
    expect(retention).toContain(`run-name: Retention \${{ ${envExpression} }}`);
    expect(retention).toContain(`environment: \${{ ${envExpression} }}`);
    expect(retention).toContain(`RETENTION_ENV: \${{ ${envExpression} }}`);
    // The pins are exactly backup.yml's (one release, one commit).
    const pins = (text: string) =>
      [...text.matchAll(/uses:\s*(\S+@[0-9a-f]{40} # v[\d.]+)/g)].map(
        (m) => m[1],
      );
    expect(pins(retention)).toEqual(pins(backup));
    const crons = (text: string) =>
      [...text.matchAll(/cron: "([^"]+)"/g)].map((m) => m[1]);
    const utcMinutes = (cron: string) => {
      const [minute, hour] = cron.split(" ").map(Number);
      return hour * 60 + minute;
    };
    expect(crons(retention)).toEqual(["15 11 * * *", "45 11 * * *"]);
    const backupProduction = utcMinutes(crons(backup)[0]);
    expect(crons(backup)[0]).toBe("30 9 * * *");
    for (const cron of crons(retention)) {
      const minutes = utcMinutes(cron);
      expect(cron.split(" ").slice(2).join(" "), cron).toBe("* * *");
      expect(minutes % 60, `${cron} is off the top of the hour`).not.toBe(0);
      expect(minutes - backupProduction, cron).toBeGreaterThanOrEqual(90);
      for (const day of ["2026-01-15", "2026-07-15", "2026-10-05"]) {
        const at = Date.parse(
          `${day}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`,
        );
        expect(inRetentionWindow(at), `${cron} on ${day}`).toBe(true);
        // A whole 10-pass run (about 11 minutes) still starts inside the window.
        expect(inRetentionWindow(at + 11 * 60_000), `${cron} + 11 min`).toBe(
          true,
        );
      }
    }
  });

  it("retention.yml retries exit 75 at most twice, 5 minutes apart, and passes 0 and 1 through", () => {
    const pass = steps(retention).find((s) => s.includes("--retention-only"))!;
    const body = pass
      .split("run: |\n")[1]
      .split("\n")
      .map((l) => l.replace(/^ {10}/, ""))
      .join("\n");
    const dir = mkdtempSync(join(tmpdir(), "gm-retention-yml-"));
    try {
      // Stubs: npx exits with the next scripted code; sleep records its argument.
      writeFileSync(
        join(dir, "npx"),
        '#!/usr/bin/env bash\necho "npx $*" >> "$CALLS"\nn=$(wc -l < "$CALLS")\ncode=$(sed -n "${n}p" "$CODES")\nexit "${code:-0}"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, "sleep"),
        '#!/usr/bin/env bash\necho "sleep $*" >> "$SLEEPS"\n',
        { mode: 0o755 },
      );
      const run = (codes: number[]) => {
        const calls = join(dir, `calls-${codes.join("-")}`);
        const sleeps = join(dir, `sleeps-${codes.join("-")}`);
        const codesFile = join(dir, `codes-${codes.join("-")}`);
        writeFileSync(calls, "");
        writeFileSync(sleeps, "");
        writeFileSync(codesFile, codes.join("\n") + "\n");
        let status = 0;
        let out: string;
        try {
          out = execFileSync("bash", ["-e", "-c", body], {
            env: {
              PATH: `${dir}:${process.env.PATH ?? ""}`,
              MIGRATION_DATABASE_URL: "postgresql://m@h/d",
              CALLS: calls,
              SLEEPS: sleeps,
              CODES: codesFile,
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          const e = error as { status: number; stdout: string };
          status = e.status;
          out = e.stdout;
        }
        return {
          status,
          out,
          calls: read(calls).trim().split("\n").filter(Boolean),
          sleeps: read(sleeps).trim().split("\n").filter(Boolean),
        };
      };
      expect(run([0])).toMatchObject({ status: 0, sleeps: [] });
      expect(run([0]).calls).toEqual([
        "npx --no-install tsx scripts/migrate.ts --retention-only",
      ]);
      expect(run([1])).toMatchObject({ status: 1, sleeps: [] });
      const retried = run([75, 0]);
      expect(retried).toMatchObject({ status: 0, sleeps: ["sleep 300"] });
      expect(retried.calls).toHaveLength(2);
      expect(run([75, 75, 1])).toMatchObject({
        status: 1,
        sleeps: ["sleep 300", "sleep 300"],
      });
      const red = run([75, 75, 75, 0]);
      expect(red.status).toBe(75);
      expect(red.calls).toHaveLength(3);
      expect(red.sleeps).toEqual(["sleep 300", "sleep 300"]);
      expect(red.out).toContain("::error::retention skipped three times");
      // A missing secret fails before any attempt.
      const env = { PATH: `${dir}:${process.env.PATH ?? ""}` };
      let missing = "";
      try {
        execFileSync("bash", ["-e", "-c", body], {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        missing = (error as { stdout: string }).stdout;
      }
      expect(missing).toContain(
        "::error::environment secret MIGRATION_DATABASE_URL is not set",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("railway.ts: no preDeploy; the worker declares no MIGRATION_DATABASE_URL, PG_APP_USER, SIGNING_KEYS or JWT_SECRET; the web declares no WORKER_DATABASE_URL, FACTURAPI_*, CREDENTIAL_ENCRYPTION_KEY or CFDI_LIVE_ENABLED; DEMO_TENANT_ID only inside the non-production spread; every registered name is present", () => {
    // Code only: comments may name what is deliberately absent.
    const code = read(".railway/railway.ts")
      .split("\n")
      .map((l) => l.replace(/\s*\/\/.*$/, ""))
      .join("\n");
    const section = (from: string, to: string) => {
      const start = code.indexOf(from);
      const end = code.indexOf(to, start + from.length);
      expect(start, from).toBeGreaterThan(-1);
      expect(end, to).toBeGreaterThan(start);
      return code.slice(start, end);
    };
    const common = section("const common = {", "};");
    const web = section('const web = service("web"', "const worker");
    const worker = section(
      'const worker = service("worker"',
      "return project(",
    );
    const names = (text: string) =>
      new Set([...text.matchAll(/\b([A-Z][A-Z0-9_]+):/g)].map((m) => m[1]));
    const commonNames = names(common);
    const webNames = new Set([...commonNames, ...names(web)]);
    const workerNames = new Set([...commonNames, ...names(worker)]);
    expect(code).not.toMatch(/preDeploy/);
    expect(web).toContain("...common");
    expect(worker).toContain("...common");
    for (const name of [
      "MIGRATION_DATABASE_URL",
      "PG_APP_USER",
      "SIGNING_KEYS",
      "JWT_SECRET",
      ...forbiddenCredentials.worker,
    ])
      expect(workerNames.has(name), `worker declares ${name}`).toBe(false);
    for (const name of [
      "WORKER_DATABASE_URL",
      "FACTURAPI_API_KEY",
      "FACTURAPI_TEST_KEY",
      "CREDENTIAL_ENCRYPTION_KEY",
      "CFDI_LIVE_ENABLED",
      ...forbiddenCredentials.web,
    ])
      expect(webNames.has(name), `web declares ${name}`).toBe(false);
    expect([...webNames].filter((n) => n.startsWith("FACTURAPI_"))).toEqual([]);
    // Never declared anywhere (code constant, development-only, operator-only).
    for (const name of [
      "LEGAL_DOCUMENTS",
      "FACTURAPI_BASE_URL",
      "SUPPORT_DATABASE_URL",
      "TRUST_PROXY",
    ])
      expect(names(code).has(name), name).toBe(false);
    // DEMO_TENANT_ID: staging only (access A2, contracts D22).
    expect(code.match(/DEMO_TENANT_ID/g)).toHaveLength(1);
    expect(web).toMatch(
      /\.\.\.\(production \? \{\} : \{ DEMO_TENANT_ID: preserve\(\) \}\)/,
    );
    expect(code).toMatch(
      /const production = ctx\.environment === "production";/,
    );
    const registered = {
      common: [
        "NODE_ENV",
        "APP_ENV",
        "LOG_LEVEL",
        "APP_URL",
        "SENTRY_DSN",
        "ALERT_WEBHOOK_URL",
        "ALERT_WEBHOOK_KIND",
        "BILLING_SANDBOX_ENABLED",
        "BILLING_DATABASE_URL",
        "SAAS_TAX_MODE",
        "SAAS_COLLECT_TAX_ID",
      ],
      web: [
        "PROCESS_KIND",
        "PORT",
        "DB_POOL_MAX",
        "DB_STATEMENT_TIMEOUT_MS",
        "RAILWAY_DEPLOYMENT_DRAINING_SECONDS",
        "RAILWAY_DEPLOYMENT_OVERLAP_SECONDS",
        "WORKER_URL",
        "DATABASE_URL",
        "PG_APP_USER",
        "JWT_SECRET",
        "SIGNING_KEYS",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
        "STRIPE_WEBHOOK_SECRET",
        // LD-9 (3): access's variables stay declared, or CD stops on a planned deletion.
        "ACCESS_STEP_UP_SECONDS",
        "ACCESS_IDLE_LOCK_DEFAULT_SECONDS",
        "FISCAL_TICKETS_ENABLED",
        "CFDI_INVOICE_LINK_EXPIRY_HOURS",
        "LEGAL_ENTITY_NAME",
        "LEGAL_ENTITY_ADDRESS",
        "LEGAL_ENTITY_RFC",
        "LEGAL_JURISDICTION",
        "LEGAL_PRIVACY_CONTACT_NAME",
        "LEGAL_PRIVACY_CONTACT_EMAIL",
        "LEGAL_UNPUBLISHED_SIGNUP",
        "SUPPORT_EMAIL",
        "SUPPORT_PHONE",
        "SUPPORT_WHATSAPP",
        "SUPPORT_URL",
        "SUPPORT_HOURS",
        "SUPPORT_HOURS_EN",
        "SAAS_TAX_PROFILE_ENABLED",
        "PUBLIC_ORDERING_ENABLED",
        "DEMO_TENANT_ID",
      ],
      worker: [
        "PROCESS_KIND",
        "PORT",
        "DB_POOL_MAX",
        "DB_STATEMENT_TIMEOUT_MS",
        "RAILWAY_DEPLOYMENT_DRAINING_SECONDS",
        "WORKER_DATABASE_URL",
        "STRIPE_SECRET_KEY",
        "STRIPE_EXPECTED_ACCOUNT_ID",
        "STRIPE_PRICE_PRO_MONTHLY",
        "STRIPE_PRICE_PRO_ANNUAL",
        "STRIPE_PORTAL_CONFIG_ID",
        "STRIPE_TAX_RATE_ID",
        "FACTURAPI_API_KEY",
        "FACTURAPI_TEST_KEY",
        "CREDENTIAL_ENCRYPTION_KEY",
        "CFDI_LIVE_ENABLED",
        "CFDI_GLOBAL_GRACE_MINUTES",
      ],
    };
    for (const name of registered.common)
      expect(commonNames.has(name), `common ${name}`).toBe(true);
    for (const name of registered.web)
      expect(names(web).has(name), `web ${name}`).toBe(true);
    for (const name of registered.worker)
      expect(names(worker).has(name), `worker ${name}`).toBe(true);
    expect(worker).toMatch(/DB_STATEMENT_TIMEOUT_MS: "30000"/);
    // Every name .env.example registers in the Wave 2.0 block is declared for a service.
    const example = read(".env.example");
    const block = example.slice(
      example.indexOf("# ---- Wave 2.0 registered variables"),
    );
    const neverRailway = block.indexOf("# -- never Railway variables --");
    expect(neverRailway).toBeGreaterThan(0);
    const registeredInExample = [
      ...block.slice(0, neverRailway).matchAll(/^([A-Z][A-Z0-9_]+)=/gm),
    ].map((m) => m[1]);
    expect(registeredInExample.length).toBeGreaterThanOrEqual(25);
    for (const name of registeredInExample)
      expect(
        webNames.has(name) || workerNames.has(name),
        `.env.example registers ${name}`,
      ).toBe(true);
  });

  it("no workflow or action passes RD_* variables to a railway command (LD-3)", () => {
    const files = [
      ...readdirSync(".github/workflows").map((f) => `.github/workflows/${f}`),
      ".github/actions/deploy/action.yml",
    ];
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/\bRD_[A-Z0-9_]+/);
      for (const step of steps(text).filter((s) => /railway/.test(s)))
        expect(step, file).not.toMatch(/LEGAL_[A-Z_]+:|SUPPORT_[A-Z_]+:/);
    }
  });
});

describe("backup freshness counts production runs only (OPS-R7 regression)", () => {
  const envExpression =
    "github.event_name == 'workflow_dispatch' && inputs.environment || (github.event.schedule == '30 9 * * *' && 'production' || 'staging')";

  it("backup runs are named after their environment, like their job environment", () => {
    expect(backup).toContain(`run-name: Backup \${{ ${envExpression} }}`);
    expect(backup).toContain(`environment: \${{ ${envExpression} }}`);
    expect(uptime).toContain('.displayTitle == "Backup production"');
  });

  it.skipIf(!hasJq)(
    "the uptime filter skips newer staging runs and finds the production one",
    () => {
      const filter = uptime.match(/--jq '([^']+)'/)![1];
      const runs = [
        {
          createdAt: "2026-10-05T10:00:00Z",
          event: "schedule",
          displayTitle: "Backup staging",
        },
        {
          createdAt: "2026-10-05T09:45:00Z",
          event: "workflow_dispatch",
          displayTitle: "Backup staging",
        },
        {
          createdAt: "2026-10-04T09:30:00Z",
          event: "push",
          displayTitle: "Backup production",
        },
        {
          createdAt: "2026-10-03T09:30:00Z",
          event: "schedule",
          displayTitle: "Backup production",
        },
      ];
      const jq = (input: unknown) =>
        execFileSync("jq", ["-r", filter], {
          input: JSON.stringify(input),
          encoding: "utf8",
        }).trim();
      expect(jq(runs)).toBe("2026-10-03T09:30:00Z");
      expect(jq(runs.slice(0, 2))).toBe("null");
    },
  );
});

describe("alerting and schedules before provisioning (OPS-R9)", () => {
  it("scheduled jobs run only for environments listed in OPS_LIVE_ENVIRONMENTS", () => {
    expect(uptime).toMatch(
      /\n {4}if: github\.event_name == 'workflow_dispatch' \|\| contains\(vars\.OPS_LIVE_ENVIRONMENTS, 'production'\)\n/,
    );
    expect(backup).toContain(
      "(github.event.schedule == '30 9 * * *' && contains(vars.OPS_LIVE_ENVIRONMENTS, 'production'))",
    );
    expect(backup).toContain(
      "(github.event.schedule == '0 10 * * 0' && contains(vars.OPS_LIVE_ENVIRONMENTS, 'staging'))",
    );
    expect(retention).toContain(
      "(github.event.schedule == '15 11 * * *' && contains(vars.OPS_LIVE_ENVIRONMENTS, 'production'))",
    );
    expect(retention).toContain(
      "(github.event.schedule == '45 11 * * *' && contains(vars.OPS_LIVE_ENVIRONMENTS, 'staging'))",
    );
    // Environment-level variables are invisible to job-level conditions.
    for (const text of [uptime, backup, retention])
      expect(text).not.toMatch(/\n {4}if:[^\n]*vars\.APP_URL/);
  });

  it("every alert step creates the ops-alert label before filing an issue", () => {
    for (const text of [uptime, backup, retention]) {
      const alert = steps(text).find((s) => s.includes("gh issue create"))!;
      expect(alert).toMatch(/\n\s*if: failure\(\)\n/);
      const label = alert.indexOf("gh label create ops-alert");
      expect(label).toBeGreaterThan(-1);
      expect(label).toBeLessThan(alert.indexOf("gh issue list"));
      expect(alert).toContain("--force");
    }
    expect(read("scripts/ops/github-protect.sh")).toMatch(
      /run gh label create ops-alert --repo "\$repo"[^\n]*\\\n[^\n]*--force/,
    );
  });
});

describe("third-party actions are pinned by full commit SHA (OPS-R8 regression)", () => {
  const files = [
    ...readdirSync(".github/workflows").map((f) => `.github/workflows/${f}`),
    ".github/actions/deploy/action.yml",
  ];

  it("every uses: is a local action or owner/repo@<40-hex sha> # vX.Y.Z", () => {
    let pinned = 0;
    for (const file of files)
      for (const line of read(file).split("\n")) {
        const uses = line.match(/^\s*(?:- )?uses:\s*(\S+)(.*)$/);
        if (!uses) continue;
        if (uses[1].startsWith("./")) continue;
        expect(uses[1], `${file}: ${line.trim()}`).toMatch(
          /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/,
        );
        expect(uses[2], `${file}: version comment`).toMatch(
          /^ # v\d+\.\d+\.\d+$/,
        );
        pinned++;
      }
    expect(pinned).toBeGreaterThanOrEqual(9);
  });

  it("every actions/* JavaScript action is pinned to a Node 24 release (GitHub retires Node 20)", () => {
    // The first major whose action.yml declares runs.using: node24
    // (verified against each release's action.yml, docs/RELEASE.md).
    const firstNode24: Record<string, number> = {
      "actions/checkout": 5,
      "actions/setup-node": 5,
      "actions/upload-artifact": 6,
    };
    let checked = 0;
    for (const file of files)
      for (const [, name, major] of read(file).matchAll(
        /uses:\s*(actions\/[\w.-]+)@[0-9a-f]{40} # v(\d+)\./g,
      )) {
        expect(
          firstNode24[name],
          `${file}: ${name} needs its first node24 major recorded here`,
        ).toBeDefined();
        expect(Number(major), `${file}: ${name}`).toBeGreaterThanOrEqual(
          firstNode24[name],
        );
        checked++;
      }
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it("one action at one release resolves to one commit everywhere", () => {
    const seen = new Map<string, string>();
    for (const file of files)
      for (const [, name, sha, version] of read(file).matchAll(
        /uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v[\d.]+)/g,
      )) {
        const key = `${name}@${version}`;
        expect(seen.get(key) ?? sha, key).toBe(sha);
        seen.set(key, sha);
      }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

describe("the Neon CLI is pinned to an exact version (OPS-R13)", () => {
  // No API key reaches neonctl here: every case stops at the version check
  // or runs the dry run, which never calls neonctl or the Neon API.
  const base = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // The rehearsal imports dotenv/config; never load a local .env here.
    DOTENV_CONFIG_PATH: "/dev/null",
  };
  const run = (
    command: string,
    args: string[],
    env: Record<string, string>,
  ) => {
    try {
      const stdout = execFileSync(command, args, {
        env: { ...base, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out: stdout };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { status: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  const neonEnv = "t" + Date.now().toString(36);
  const fake = { NEON_API_KEY: "not-a-key", NEON_ORG_ID: "org-not-real" };

  it("provision-neon.sh refuses a missing or floating version", () => {
    for (const version of [undefined, "latest", "2", "2.1", "^2.1.0"]) {
      const result = run(
        "bash",
        ["scripts/ops/provision-neon.sh", neonEnv, "--dry-run"],
        version === undefined ? fake : { ...fake, NEONCTL_VERSION: version },
      );
      expect(result.status).toBe(2);
      expect(result.out).toContain("pin NEONCTL_VERSION");
    }
  });

  it("provision-neon.sh dry run proceeds with an exact version", () => {
    const result = run(
      "bash",
      ["scripts/ops/provision-neon.sh", neonEnv, "--dry-run"],
      { ...fake, NEONCTL_VERSION: "1.2.3" },
    );
    expect(result.status).toBe(0);
    expect(result.out).toContain("DRY-RUN: neon projects create");
    expect(result.out).not.toContain("not-a-key");
  });

  it("the restore rehearsal refuses to start without an exact version", () => {
    for (const version of [undefined, "latest"]) {
      const result = run(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/ops/rehearse-neon-restore.ts",
          "--dry-run",
        ],
        {
          REHEARSAL_SOURCE_ENV: "staging",
          ...(version === undefined ? {} : { NEONCTL_VERSION: version }),
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("NEONCTL_VERSION must be an exact version");
    }
  });
});
