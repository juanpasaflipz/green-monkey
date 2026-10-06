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
    // Environment-level variables are invisible to job-level conditions.
    for (const text of [uptime, backup])
      expect(text).not.toMatch(/\n {4}if:[^\n]*vars\.APP_URL/);
  });

  it("every alert step creates the ops-alert label before filing an issue", () => {
    for (const text of [uptime, backup]) {
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
