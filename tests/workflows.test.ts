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

  it("the production guard fetches main with the job token as masked basic auth, never a bearer header (first production dispatch)", () => {
    const guard = deploy.slice(deploy.indexOf("- name: Guard"));
    // GitHub's git endpoint rejects a bearer header for a private repository:
    // git then prompts for a username and the guard dies with exit 128.
    expect(guard).not.toMatch(/extraheader=AUTHORIZATION: bearer/i);
    expect(guard).toContain(
      "auth=$(printf 'x-access-token:%s' \"$GH_TOKEN\" | base64 | tr -d '\\n')",
    );
    expect(guard).toContain('echo "::add-mask::$auth"');
    expect(guard).toContain(
      'git -c "http.extraheader=AUTHORIZATION: basic $auth" fetch -q origin main',
    );
    expect(guard.indexOf("::add-mask::$auth")).toBeLessThan(
      guard.indexOf("fetch -q origin main"),
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

  it("retention.yml runs the compiled build/scripts/migrate.js --retention-only with pinned actions and the environment secret, and its crons fall inside RETENTION_WINDOW and at least 90 minutes after backup.yml's production cron", () => {
    const pass = steps(retention).find((s) => s.includes("--retention-only"))!;
    // PLATFORM-CI-4: the secret-holding step runs compiled code only (no tsx, no npx).
    expect(pass).toContain("node build/scripts/migrate.js --retention-only");
    expect(pass).not.toMatch(/\btsx\b|\bnpx\b|npm (ci|install|run)/);
    expect(pass).toContain(
      "MIGRATION_DATABASE_URL: ${{ secrets.MIGRATION_DATABASE_URL }}",
    );
    // Install and compile run before it, in a step without any secret.
    const all = steps(retention);
    const install = all.findIndex((s) => s.includes("npm ci"));
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(all.indexOf(pass));
    expect(all[install]).toContain("npx tsc -p tsconfig.server.json");
    expect(all[install]).not.toContain("secrets.");
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

  it("retention.yml retries exit 75 at most twice, 5 minutes apart, and passes 0 and 1 through; a scheduled run never starts outside RETENTION_WINDOW and stops retrying once it closes (PLATFORM-OPS-8)", () => {
    const pass = steps(retention).find((s) => s.includes("--retention-only"))!;
    const body = pass
      .split("run: |\n")[1]
      .split("\n")
      .map((l) => l.replace(/^ {10}/, ""))
      .join("\n");
    const dir = mkdtempSync(join(tmpdir(), "gm-retention-yml-"));
    try {
      // Stubs: node runs either the window probe (answers from $WINDOWS, one line
      // per call: in = exit 0, out = exit 3, error = exit 1 like a failed import) or
      // migrate.js (exits with the next scripted code); sleep records its argument.
      writeFileSync(
        join(dir, "node"),
        [
          "#!/usr/bin/env bash",
          'if [[ "$*" == *inRetentionWindow* ]]; then',
          '  echo w >> "$WINDOW_CALLS"; n=$(wc -l < "$WINDOW_CALLS")',
          '  answer=$(sed -n "${n}p" "$WINDOWS")',
          '  case "${answer:-in}" in in) exit 0 ;; out) exit 3 ;; *) exit 1 ;; esac',
          "fi",
          'echo "node $*" >> "$CALLS"',
          'n=$(wc -l < "$CALLS")',
          'code=$(sed -n "${n}p" "$CODES")',
          'exit "${code:-0}"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, "sleep"),
        '#!/usr/bin/env bash\necho "sleep $*" >> "$SLEEPS"\n',
        { mode: 0o755 },
      );
      let runs = 0;
      const run = (
        codes: number[],
        o: { event?: string; windows?: string[] } = {},
      ) => {
        const tag = String(runs++);
        const calls = join(dir, `calls-${tag}`);
        const sleeps = join(dir, `sleeps-${tag}`);
        const codesFile = join(dir, `codes-${tag}`);
        const windows = join(dir, `windows-${tag}`);
        const windowCalls = join(dir, `window-calls-${tag}`);
        writeFileSync(calls, "");
        writeFileSync(sleeps, "");
        writeFileSync(windowCalls, "");
        writeFileSync(codesFile, codes.join("\n") + "\n");
        writeFileSync(windows, (o.windows ?? []).join("\n") + "\n");
        let status = 0;
        let out: string;
        try {
          out = execFileSync("bash", ["-e", "-c", body], {
            env: {
              PATH: `${dir}:${process.env.PATH ?? ""}`,
              MIGRATION_DATABASE_URL: "postgresql://m@h/d",
              EVENT: o.event ?? "workflow_dispatch",
              CALLS: calls,
              SLEEPS: sleeps,
              CODES: codesFile,
              WINDOWS: windows,
              WINDOW_CALLS: windowCalls,
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
          windowChecks: read(windowCalls).trim().split("\n").filter(Boolean)
            .length,
        };
      };
      expect(run([0])).toMatchObject({ status: 0, sleeps: [] });
      expect(run([0]).calls).toEqual([
        "node build/scripts/migrate.js --retention-only",
      ]);
      expect(run([1])).toMatchObject({ status: 1, sleeps: [] });
      const retried = run([75, 0]);
      expect(retried).toMatchObject({ status: 0, sleeps: ["sleep 300"] });
      expect(retried.calls).toHaveLength(2);
      expect(retried.windowChecks, "a dispatch never checks the window").toBe(
        0,
      );
      expect(run([75, 75, 1])).toMatchObject({
        status: 1,
        sleeps: ["sleep 300", "sleep 300"],
      });
      const red = run([75, 75, 75, 0]);
      expect(red.status).toBe(75);
      expect(red.calls).toHaveLength(3);
      expect(red.sleeps).toEqual(["sleep 300", "sleep 300"]);
      expect(red.out).toContain("::error::retention skipped three times");
      // Scheduled: a delayed cron outside the window does nothing and is green.
      const late = run([0], { event: "schedule", windows: ["out"] });
      expect(late).toMatchObject({ status: 0, calls: [] });
      expect(late.out).toContain("retention_outside_window");
      // Scheduled: inside the window it runs and retries while the window is open…
      expect(
        run([75, 0], { event: "schedule", windows: ["in", "in"] }),
      ).toMatchObject({ status: 0, sleeps: ["sleep 300"] });
      // …and stops (red) once the window has closed after a skip.
      const closed = run([75, 0], {
        event: "schedule",
        windows: ["in", "out"],
      });
      expect(closed.status).toBe(75);
      expect(closed.calls).toHaveLength(1);
      expect(closed.out).toContain("RETENTION_WINDOW has closed");
      // A probe that cannot answer (import error) is red, never "outside" (PLAT-HR-3).
      const broken = run([0], { event: "schedule", windows: ["error"] });
      expect(broken).toMatchObject({ status: 1, calls: [] });
      expect(broken.out).toContain("::error::retention_window_check_failed");
      expect(broken.out).not.toContain("retention_outside_window");
      const brokenLater = run([75, 0], {
        event: "schedule",
        windows: ["in", "error"],
      });
      expect(brokenLater).toMatchObject({ status: 1 });
      expect(brokenLater.calls).toHaveLength(1);
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
  }, 30_000);

  it("retention.yml's window probe runs the release's compiled inRetentionWindow: exit 0 inside, 3 outside, and a failed import or a missing export fails the run (PLAT-HR-3)", () => {
    const block = marked(retention, "retention-window-probe");
    const dir = mkdtempSync(join(tmpdir(), "gm-retention-probe-"));
    try {
      const probe = (module: string | null) => {
        const cwd = join(dir, String(Math.random()).slice(2));
        execFileSync("mkdir", ["-p", join(cwd, "build/server/ops")]);
        if (module !== null)
          writeFileSync(join(cwd, "build/server/ops/retention.js"), module);
        try {
          const out = execFileSync(
            "bash",
            [
              "-e",
              "-c",
              `${block}\nif in_window; then echo inside; else echo outside; fi`,
            ],
            { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
          return { status: 0, out };
        } catch (error) {
          const e = error as { status: number; stdout: string };
          return { status: e.status, out: e.stdout };
        }
      };
      expect(
        probe("export const inRetentionWindow = () => true;"),
      ).toMatchObject({ status: 0, out: "inside\n" });
      expect(
        probe("export const inRetentionWindow = () => false;"),
      ).toMatchObject({ status: 0, out: "outside\n" });
      for (const broken of [
        null, // build/server/ops/retention.js missing
        "export const retentionWindow = () => true;", // renamed export
        "throw new Error('config');", // a module that fails to load
      ]) {
        const result = probe(broken);
        expect(result.status, String(broken)).toBe(1);
        expect(result.out).toContain("::error::retention_window_check_failed");
        expect(result.out).not.toContain("outside");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("retention.yml checks out the environment's live release, never the bare default branch, without persisted credentials or a shared npm cache (PLATFORM-ROLES-1, CI-3, CI-5)", () => {
    const checkouts = steps(retention).filter((s) =>
      s.includes("actions/checkout@"),
    );
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toContain("ref: ${{ steps.live.outputs.sha }}");
    expect(checkouts[0]).toContain("persist-credentials: false");
    const all = steps(retention);
    const live = all.findIndex((s) => /\n\s*id: live\n/.test(s));
    expect(live).toBeGreaterThan(-1);
    expect(live).toBeLessThan(all.indexOf(checkouts[0]));
    expect(all[live]).not.toContain("secrets.");
    // Privileged jobs never restore the npm cache Qualification saves.
    for (const [name, text] of [
      ["retention.yml", retention],
      ["backup.yml", backup],
      ["deploy action", action],
    ] as const) {
      expect(text, name).not.toMatch(/\n\s*cache: npm\n/);
      expect(text, name).toContain("package-manager-cache: false");
    }
    for (const [name, text] of [
      ["retention.yml", retention],
      ["backup.yml", backup],
      ["deploy.yml", deploy],
    ] as const)
      for (const step of steps(text).filter((s) =>
        s.includes("actions/checkout@"),
      ))
        expect(step, name).toContain("persist-credentials: false");
    // The release tag comes from gh release create alone (no git push with a
    // persisted token).
    expect(deploy).not.toMatch(/\bgit (tag|push)\b/);
    expect(deploy).toContain(
      'gh release create "$tag" --repo "$GITHUB_REPOSITORY" --target "$SHA"',
    );
  });

  it.skipIf(!hasJq)(
    "retention's live release: production = the newest prod-* tag (staged, on main), staging = the main commit with the most recent successful deploy/staging status; it fails closed otherwise, and a production dispatch respects service hours (PLATFORM-ROLES-1, CI-6)",
    () => {
      const block = marked(retention, "retention-live-release");
      const dir = mkdtempSync(join(tmpdir(), "gm-retention-live-"));
      try {
        const sha = (c: string) => c.repeat(40);
        // gh stand-in: GET responses from $RESPONSES (path -> JSON), through jq.
        writeFileSync(
          join(dir, "gh"),
          [
            `#!${process.execPath}`,
            'const { execFileSync } = require("node:child_process");',
            'const { readFileSync } = require("node:fs");',
            "const args = process.argv.slice(2).filter((a) => a !== '--paginate');",
            'const jq = args.includes("--jq") ? args[args.indexOf("--jq") + 1] : ".";',
            'const path = args.find((a) => a.startsWith("repos/"));',
            'const responses = JSON.parse(readFileSync(process.env.RESPONSES, "utf8"));',
            'if (!(path in responses)) { console.error("404 " + path); process.exit(1); }',
            'process.stdout.write(execFileSync("jq", ["-r", jq], { input: JSON.stringify(responses[path]), encoding: "utf8" }));',
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        writeFileSync(
          join(dir, "date"),
          '#!/usr/bin/env bash\necho "$FAKE_HOUR"\n',
          { mode: 0o755 },
        );
        const repo = "repos/owner/repo";
        const staged = (
          state = "success",
          createdAt = "2026-10-04T10:00:00Z",
        ) => [
          { context: "ci/other", state: "failure" },
          { context: "deploy/staging", state, created_at: createdAt },
        ];
        const base: Record<string, unknown> = {
          [`${repo}/git/matching-refs/tags/prod-`]: [
            { ref: "refs/tags/prod-20261001-0930-aaaaaaa" },
            { ref: "refs/tags/prod-20261004-1015-bbbbbbb" },
            { ref: "refs/tags/prod-20261003-2200-ccccccc" },
            { ref: "refs/tags/prod-manual-zzz" },
          ],
          [`${repo}/commits/tags/prod-20261004-1015-bbbbbbb`]: {
            sha: sha("b"),
          },
          [`${repo}/commits/${sha("b")}/statuses`]: staged(),
          [`${repo}/compare/${sha("b")}...main`]: { status: "ahead" },
          [`${repo}/commits?sha=main&per_page=30`]: [
            { sha: sha("f") },
            { sha: sha("e") },
            { sha: sha("d") },
          ],
          [`${repo}/commits/${sha("f")}/statuses`]: [],
          [`${repo}/commits/${sha("e")}/statuses`]: staged("failure"),
          [`${repo}/commits/${sha("d")}/statuses`]: staged(),
          [`${repo}/compare/${sha("d")}...main`]: { status: "ahead" },
        };
        let n = 0;
        const resolve = (
          env: string,
          o: {
            responses?: Record<string, unknown>;
            event?: string;
            hour?: string;
            allow?: string;
          } = {},
        ) => {
          const responses = join(dir, `responses-${n}.json`);
          const output = join(dir, `output-${n++}`);
          writeFileSync(responses, JSON.stringify({ ...base, ...o.responses }));
          writeFileSync(output, "");
          let status = 0;
          let out: string;
          try {
            out = execFileSync("bash", ["-e", "-c", block], {
              env: {
                PATH: `${dir}:${process.env.PATH ?? ""}`,
                RETENTION_ENV: env,
                EVENT: o.event ?? "schedule",
                ALLOW_SERVICE_HOURS: o.allow ?? "",
                GITHUB_REPOSITORY: "owner/repo",
                GITHUB_OUTPUT: output,
                RESPONSES: responses,
                FAKE_HOUR: o.hour ?? "05",
              },
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch (error) {
            const e = error as { status: number; stdout: string };
            status = e.status;
            out = e.stdout;
          }
          return { status, out, output: read(output).trim() };
        };
        expect(resolve("production")).toMatchObject({
          status: 0,
          output: `sha=${sha("b")}`,
        });
        expect(resolve("staging")).toMatchObject({
          status: 0,
          output: `sha=${sha("d")}`,
        });
        // PLAT-HR-8: the most recently deployed commit wins, not the newest one. An
        // older commit re-deployed after a newer one is the live release; a commit
        // whose latest deploy/staging status failed is not live, whatever came before.
        expect(
          resolve("staging", {
            responses: {
              [`${repo}/commits/${sha("f")}/statuses`]: staged(
                "success",
                "2026-10-04T12:00:00Z",
              ),
              [`${repo}/commits/${sha("d")}/statuses`]: staged(
                "success",
                "2026-10-05T09:00:00Z",
              ),
            },
          }),
        ).toMatchObject({ status: 0, output: `sha=${sha("d")}` });
        expect(
          resolve("staging", {
            responses: {
              [`${repo}/commits/${sha("f")}/statuses`]: staged(
                "success",
                "2026-10-05T09:00:00Z",
              ),
              [`${repo}/compare/${sha("f")}...main`]: { status: "identical" },
            },
          }),
        ).toMatchObject({ status: 0, output: `sha=${sha("f")}` });
        expect(
          resolve("staging", {
            responses: {
              [`${repo}/commits/${sha("d")}/statuses`]: [
                {
                  context: "deploy/staging",
                  state: "failure",
                  created_at: "2026-10-05T09:00:00Z",
                },
                ...staged("success", "2026-10-03T09:00:00Z"),
              ],
            },
          }),
        ).toMatchObject({ status: 1 });
        // Fail closed: no tag, a tag that never reached staging, a commit off main,
        // a tag whose name does not match its commit, nothing staged.
        const failures: [string, Record<string, unknown>, string][] = [
          [
            "production",
            { [`${repo}/git/matching-refs/tags/prod-`]: [] },
            "no prod-* release tag",
          ],
          [
            "production",
            { [`${repo}/commits/${sha("b")}/statuses`]: staged("failure") },
            "was never live on staging",
          ],
          [
            "production",
            { [`${repo}/compare/${sha("b")}...main`]: { status: "diverged" } },
            "is not on main",
          ],
          [
            "production",
            {
              [`${repo}/commits/tags/prod-20261004-1015-bbbbbbb`]: {
                sha: sha("c"),
              },
            },
            "does not point at its commit",
          ],
          [
            "staging",
            { [`${repo}/commits/${sha("d")}/statuses`]: [] },
            "carries a successful deploy/staging status",
          ],
          [
            "staging",
            { [`${repo}/compare/${sha("d")}...main`]: { status: "behind" } },
            "is not on main",
          ],
        ];
        for (const [env, responses, message] of failures) {
          const result = resolve(env, { responses });
          expect(result.status, message).toBe(1);
          expect(result.out, message).toContain(message);
          expect(result.output, message).toBe("");
        }
        // CI-6: a manual production run at 12:00 or later needs allow_service_hours.
        expect(
          resolve("production", { event: "workflow_dispatch", hour: "13" }),
        ).toMatchObject({ status: 1 });
        expect(
          resolve("production", {
            event: "workflow_dispatch",
            hour: "13",
            allow: "true",
          }),
        ).toMatchObject({ status: 0, output: `sha=${sha("b")}` });
        expect(
          resolve("production", { event: "workflow_dispatch", hour: "06" }),
        ).toMatchObject({ status: 0 });
        expect(
          resolve("staging", { event: "workflow_dispatch", hour: "13" }),
        ).toMatchObject({ status: 0, output: `sha=${sha("d")}` });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

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
    // The fictional/acceptance RD_* sets may appear in test steps (acceptance), never in
    // a step that runs a railway command, nor anywhere on the deploy path.
    const files = [
      ...readdirSync(".github/workflows").map((f) => `.github/workflows/${f}`),
      ".github/actions/deploy/action.yml",
    ];
    let railwaySteps = 0;
    for (const file of files) {
      const text = read(file);
      if (file.endsWith("deploy.yml") || file.endsWith("action.yml"))
        expect(text, file).not.toMatch(/\bRD_[A-Z0-9_]+/);
      for (const step of steps(text).filter((s) =>
        /@railway\/cli|railway@|\brailway (up|config|variable)/.test(s),
      )) {
        railwaySteps++;
        expect(step, file).not.toMatch(/\bRD_[A-Z0-9_]+/);
        expect(step, file).not.toMatch(/\b(LEGAL|SUPPORT)_[A-Z_]+:/);
      }
    }
    expect(railwaySteps).toBeGreaterThanOrEqual(3);
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

describe("GitHub environments deploy only from main (PLATFORM-CI-2)", () => {
  /** Runs github-protect.sh against tests/fakes/gh-environments.mjs as `gh`. */
  function protect(initial: Record<string, unknown>, dryRun = false) {
    const dir = mkdtempSync(join(tmpdir(), "gm-protect-"));
    try {
      const stateFile = join(dir, "state.json");
      writeFileSync(stateFile, JSON.stringify({ nextId: 100, ...initial }));
      writeFileSync(
        join(dir, "gh"),
        `#!/usr/bin/env bash\nexec "${process.execPath}" "${join(process.cwd(), "tests/fakes/gh-environments.mjs")}" "$@"\n`,
        { mode: 0o755 },
      );
      let status = 0;
      let out = "";
      try {
        out = execFileSync(
          "bash",
          ["scripts/ops/github-protect.sh", ...(dryRun ? ["--dry-run"] : [])],
          {
            env: {
              PATH: `${dir}:${process.env.PATH ?? ""}`,
              GITHUB_REPOSITORY: "owner/repo",
              GH_FAKE_STATE: stateFile,
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        const e = error as { status: number; stdout: string; stderr: string };
        status = e.status;
        out = `${e.stdout}${e.stderr}`;
      }
      return {
        status,
        out,
        state: JSON.parse(read(stateFile)) as {
          envs: Record<
            string,
            {
              policy: Record<string, boolean> | null;
              policies: { type: string; name: string }[];
            }
          >;
          calls: string[];
        },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(!hasJq)(
    "each environment ends with a custom policy allowing exactly the branch main; stray policies are removed; the protected-branches mode is never used",
    () => {
      const result = protect({
        envs: {
          staging: {
            policy: { protected_branches: true, custom_branch_policies: false },
            policies: [
              { id: 1, type: "branch", name: "release/*" },
              { id: 2, type: "tag", name: "v*" },
            ],
          },
        },
      });
      expect(result.out).toContain(
        "environment staging: deployments only from branch main",
      );
      expect(result.status).toBe(0);
      for (const name of ["staging", "production"]) {
        expect(result.state.envs[name].policy, name).toEqual({
          protected_branches: false,
          custom_branch_policies: true,
        });
        expect(
          result.state.envs[name].policies.map((p) => `${p.type}:${p.name}`),
          name,
        ).toEqual(["branch:main"]);
      }
      expect(
        result.state.calls.filter((c) => c.startsWith("api -X DELETE")),
      ).toEqual([
        "api -X DELETE repos/owner/repo/environments/staging/deployment-branch-policies/1",
        "api -X DELETE repos/owner/repo/environments/staging/deployment-branch-policies/2",
      ]);
      expect(result.state.calls.join("\n")).not.toContain(
        "protected_branches]=true",
      );
      // A second run is idempotent: nothing deleted, main not added twice.
      const again = protect({ envs: result.state.envs });
      expect(again.status).toBe(0);
      expect(
        again.state.calls.some((c) =>
          /-X (DELETE|POST) .*deployment-branch-policies/.test(c),
        ),
      ).toBe(false);
    },
    30_000,
  );

  it.skipIf(!hasJq)(
    "the read-back fails the script when GitHub keeps another mode (a plan without branch policies)",
    () => {
      const result = protect({
        ignorePut: true,
        envs: {
          staging: {
            policy: { protected_branches: true, custom_branch_policies: false },
            policies: [],
          },
        },
      });
      expect(result.status).toBe(1);
      expect(result.out).toContain(
        "environment staging: deployment branch policy is 'protected=true custom=false'",
      );
    },
    30_000,
  );

  it("the dry run shows the custom policy and the main rule; the checklist names every 2.0 secret and variable", () => {
    const result = protect({ envs: {} }, true);
    expect(result.status).toBe(0);
    for (const name of ["staging", "production"]) {
      expect(result.out).toContain(
        `DRY-RUN: gh api -X PUT repos/owner/repo/environments/${name} -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true`,
      );
      expect(result.out).toContain(
        `DRY-RUN: gh api -X POST repos/owner/repo/environments/${name}/deployment-branch-policies -f name=main -f type=branch`,
      );
    }
    expect(result.state.calls ?? []).toEqual([]);
    for (const line of [
      "gh secret set MIGRATION_DATABASE_URL --env",
      "gh variable set PG_APP_USER --env",
      "gh variable set ALERT_WEBHOOK_KIND --env",
      "gh secret set RAILWAY_TOKEN --env",
    ])
      expect(result.out).toContain(line);
  }, 30_000);
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

describe("restaurant-day.yml: the go-live gate (specs/acceptance.md §13)", () => {
  const day = read(".github/workflows/restaurant-day.yml");
  const job = (name: string) => {
    const start = day.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const next = day.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    return next === -1 ? day.slice(start) : day.slice(start, start + 1 + next);
  };

  it("runs on demand, nightly and on release/* PRs into main, never on ordinary PRs", () => {
    expect(day).toMatch(/\n {2}workflow_dispatch:\n/);
    expect(day).toContain('- cron: "0 13 * * *"');
    expect(day).toMatch(/pull_request:\n {4}branches: \[main\]/);
    for (const name of ["day", "cfdi-key", "day-payments"])
      expect(job(name), name).toContain(
        "startsWith(github.head_ref, 'release/')",
      );
    // Branch P (payments §12.4, LD-80): its own job against the payments fake; the lead makes it
    // a required check once it is green on main.
    expect(job("day-payments")).toContain("name: restaurant-day-payments\n");
    expect(job("day-payments")).toContain('RD_PAYMENTS_FAKE_PORT: "4899"');
    expect(job("day")).not.toContain("RD_PAYMENTS_FAKE_PORT:");
    expect(job("day-cfdi")).not.toContain("RD_PAYMENTS_FAKE_PORT:");
    expect(job("day-cfdi")).toContain("needs: cfdi-key");
    // The ruleset requires both by job name; a job skipped by its `if` reports success.
    expect(job("day")).toContain("name: restaurant-day\n");
    expect(job("day-cfdi")).toContain("name: restaurant-day-cfdi\n");
    const ruleset = JSON.parse(read("ops/github/main-ruleset.json")) as {
      rules: Array<{
        type: string;
        parameters?: { required_status_checks?: Array<{ context: string }> };
      }>;
    };
    const required = ruleset.rules
      .find((r) => r.type === "required_status_checks")!
      .parameters!.required_status_checks!.map((c) => c.context);
    expect(required).toEqual(
      expect.arrayContaining([
        "qualify",
        "security",
        "restaurant-day",
        "restaurant-day-cfdi",
      ]),
    );
    expect(job("day-cfdi")).toContain(
      "if: needs.cfdi-key.outputs.present == 'true'",
    );
  });

  it("generates its keys per run and names only the disposable acceptance database (§3.2, §3.3)", () => {
    for (const name of ["day", "day-cfdi", "day-payments"]) {
      const text = job(name);
      expect(text, name).not.toMatch(
        /\b(SIGNING_KEYS|JWT_SECRET|DATABASE_URL|DEMO_TENANT_ID|MIGRATION_DATABASE_URL|CREDENTIAL_ENCRYPTION_KEY):/,
      );
      expect(text, name).not.toContain("LEGAL_UNPUBLISHED_SIGNUP");
      expect(text, name).toContain("TEST_BASE_URL: http://127.0.0.1:3390");
      expect(text, name).toMatch(/APP_URL: https:\/\/127\.0\.0\.1:3390\b/);
      expect(text, name).toContain('RD_ACCEPTANCE: "1"');
      expect(text, name).toContain("run: npm run test:acceptance:day");
      expect(text, name).toContain("node scripts/ops/stamp-build.mjs");
      expect(text, name).toMatch(
        /upload-artifact@[0-9a-f]{40} # v[\d.]+\n {8}if: always\(\)/,
      );
      for (const variable of [
        "LEGAL_ENTITY_NAME",
        "LEGAL_ENTITY_ADDRESS",
        "LEGAL_PRIVACY_CONTACT_EMAIL",
        "LEGAL_JURISDICTION",
        "SUPPORT_EMAIL",
        "SUPPORT_PHONE",
        "SUPPORT_HOURS",
      ])
        expect(text, `${name} ${variable}`).toContain(
          `RD_${variable}: \${{ vars.RD_${variable} }}`,
        );
    }
    // Only the Facturapi branch sees the test key, and only in its test step.
    expect(job("day")).not.toContain("FACTURAPI");
    expect(job("day-payments")).not.toContain("FACTURAPI");
    expect(day.match(/secrets\.FACTURAPI_TEST_KEY/g)).toHaveLength(2);
  });

  it("a waiver on a release PR fails without the product owner's label (§13.5)", () => {
    const guard = marked(day, "waiver-guard");
    const body = guard
      .split("\n")
      .filter((l) => l.trim())
      .join("\n");
    // day-cfdi and day-payments carry the same guard.
    for (const name of ["day-cfdi", "day-payments"]) {
      const other = job(name)
        .split("\n")
        .map((l) => l.trim())
        .join("\n");
      expect(other, name).toContain(
        body
          .split("\n")
          .map((l) => l.trim())
          .join("\n"),
      );
    }
    const status = (env: Record<string, string>) => {
      try {
        execFileSync("bash", ["-e", "-c", guard], {
          env: { PATH: process.env.PATH ?? "", ...env },
          stdio: "ignore",
        });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    expect(status({})).toBe(0);
    expect(status({ RD_WAIVE: "", WAIVER_APPROVED: "false" })).toBe(0);
    expect(status({ RD_WAIVE: " , ", WAIVER_APPROVED: "false" })).toBe(0);
    expect(status({ RD_WAIVE: "GAP-4", WAIVER_APPROVED: "false" })).toBe(1);
    expect(status({ RD_WAIVE: "GAP-4,FOH-10" })).toBe(1);
    expect(status({ RD_WAIVE: "GAP-4", WAIVER_APPROVED: "true" })).toBe(0);
  });
});
