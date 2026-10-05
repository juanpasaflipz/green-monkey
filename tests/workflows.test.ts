import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
