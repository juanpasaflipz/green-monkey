import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/** Static relative imports reachable from an entry file (source tree). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']|(?:^|\n)\s*import\s+["'](\.[^"']+)["']/g,
    )) {
      const spec = m[1] ?? m[2];
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      for (const candidate of [
        target,
        target + ".ts",
        resolve(target, "index.ts"),
      ])
        if (existsSync(candidate) && candidate.endsWith(".ts")) {
          visit(candidate);
          break;
        }
    }
  };
  visit(resolve(entry));
  return new Set([...seen].map((f) => relative(process.cwd(), f)));
}

describe("process boundaries", () => {
  it("server/index.ts never reaches worker-registry, any server/cfdi/worker/ file, the migration library, retention, the watchdog, server/worker.ts or scripts/*, and does reach server/jobs/handlers/index.ts", () => {
    const web = reachable("server/index.ts");
    expect(web.has("server/routes/ops.ts")).toBe(true);
    expect(web.has("server/jobs/runner.ts")).toBe(true);
    expect(web.has("server/jobs/handlers/index.ts")).toBe(true);
    for (const forbidden of [
      "server/jobs/worker-registry.ts",
      "server/ops/schema.ts",
      "server/ops/retention.ts",
      "server/worker.ts",
      "server/ops/watchdog.ts",
    ])
      expect(web.has(forbidden), forbidden).toBe(false);
    expect([...web].filter((f) => f.startsWith("server/cfdi/worker/"))).toEqual(
      [],
    );
    expect([...web].filter((f) => f.startsWith("scripts/"))).toEqual([]);
  });

  it("runner.ts imports no handler module", () => {
    const runner = reachable("server/jobs/runner.ts");
    expect(
      [...runner].filter((f) => f.startsWith("server/jobs/handlers/")),
    ).toEqual([]);
    expect(runner.has("server/jobs/worker-registry.ts")).toBe(false);
  });

  it("the worker never imports the web entry or the runtime jobs runner", () => {
    const worker = reachable("server/worker.ts");
    expect(worker.has("server/index.ts")).toBe(false);
    expect(worker.has("server/jobs/runner.ts")).toBe(false);
    expect(worker.has("server/config.ts")).toBe(true);
  });

  it("the instrument preload loads configuration before anything else", () => {
    const source = readFileSync("server/instrument.ts", "utf8");
    const firstImport = source.match(/^import\s+["'][^"']+["'];/m)?.[0];
    expect(firstImport).toBe('import "./config.js";');
    const docker = readFileSync("Dockerfile", "utf8");
    expect(docker).toMatch(
      /CMD \["node", ?"--import", ?"\.\/build\/server\/instrument\.js", ?"build\/server\/index\.js"\]/,
    );
  });
});
