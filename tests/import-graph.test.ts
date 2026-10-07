import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/** The source files a file imports statically by a relative path (absolute paths). */
function directImports(file: string): string[] {
  const out: string[] = [];
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
        out.push(candidate);
        break;
      }
  }
  return out;
}

/** Static relative imports reachable from an entry file (source tree). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const target of directImports(file)) visit(target);
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

  it("the worker reaches config.ts, the runner and worker-registry, never server/index.ts or server/jobs/handlers/index.ts", () => {
    const worker = reachable("server/worker.ts");
    expect(worker.has("server/config.ts")).toBe(true);
    expect(worker.has("server/jobs/runner.ts")).toBe(true);
    expect(worker.has("server/jobs/worker-registry.ts")).toBe(true);
    expect(worker.has("server/index.ts")).toBe(false);
    expect(
      [...worker].filter((f) => f.startsWith("server/jobs/handlers/")),
    ).toEqual([]);
    // P-15 defense: the worker holds no signing key and never mints a sealed
    // token (it reaches server/auth.ts through server/jobs/queue.ts and
    // server/billing-runtime.ts → server/owner-accounts.ts, but never
    // the seal/unseal module), nor the retention schedule or the migrator.
    // LD-16 L4: nor the web sales graph (orders, fiscal issuance) or cfdi's web
    // service and portal; auth.ts and access.ts stay reachable (the keyring
    // loads lazily and is never invoked there; splitting them is a wave-3 item).
    for (const forbidden of [
      "server/tokens.ts",
      "server/ops/retention.ts",
      "server/ops/schema.ts",
      "server/orders.ts",
      "server/fiscal.ts",
      "server/cfdi/service.ts",
      "server/cfdi/portal.ts",
    ])
      expect(worker.has(forbidden), forbidden).toBe(false);
    expect([...worker].filter((f) => f.startsWith("server/routes/"))).toEqual(
      [],
    );
  });

  it("cfdi (030): the web never reaches the worker registry, cfdi's worker modules, its vault or the Facturapi client; the worker reaches cfdi's register and boot modules, never its web service, portal, routes or the token module", () => {
    const web = reachable("server/index.ts");
    for (const forbidden of [
      "server/jobs/worker-registry.ts",
      "server/cfdi/vault.ts",
      "server/cfdi/facturapi.ts",
      "server/cfdi/errors.ts",
    ])
      expect(web.has(forbidden), forbidden).toBe(false);
    expect([...web].filter((f) => f.startsWith("server/cfdi/worker/"))).toEqual(
      [],
    );
    expect(web.has("server/routes/cfdi.ts")).toBe(true);
    expect(web.has("server/cfdi/service.ts")).toBe(true);
    expect(web.has("server/cfdi/portal.ts")).toBe(true);
    const worker = reachable("server/worker.ts");
    expect(worker.has("server/cfdi/worker/register.ts")).toBe(true);
    expect(worker.has("server/cfdi/worker/boot.ts")).toBe(true);
    // Fiscal's ticket readers come from the leaf module (LD-15 EXTRA, wave2-cross-track C4).
    expect(worker.has("server/fiscal-read.ts")).toBe(true);
    // LD-16 L4 (amended LD-15 cfdi Q1): never tokens.ts, orders.ts, fiscal.ts, index.ts, any
    // route module, or cfdi's web service and portal (CFDI-R2-6).
    for (const forbidden of [
      "server/tokens.ts",
      "server/index.ts",
      "server/routes/cfdi.ts",
      "server/cfdi/service.ts",
      "server/cfdi/portal.ts",
      "server/cfdi/hooks.ts",
      "server/cfdi/csd.ts",
      "server/orders.ts",
      "server/fiscal.ts",
    ])
      expect(worker.has(forbidden), forbidden).toBe(false);
    expect([...worker].filter((f) => f.startsWith("server/routes/"))).toEqual(
      [],
    );
  });

  it("LD-16 L4 (deferred beyond v1): the worker reaches the web's auth modules only through jobs/queue.ts and billing-runtime.ts → owner-accounts.ts, the two paths RUNBOOK's follow-up row names (POLISH-OPS-1)", () => {
    const authModules = [
      "server/auth.ts",
      "server/access.ts",
      "server/owner-accounts.ts",
    ];
    const worker = reachable("server/worker.ts");
    for (const module of authModules)
      expect(worker.has(module), module).toBe(true);
    // Every module of the worker's graph, outside the auth modules themselves,
    // that imports one of them: the entry points of the paths.
    const entries = [...worker]
      .filter((file) => !authModules.includes(file))
      .filter((file) =>
        directImports(resolve(file)).some((target) =>
          authModules.includes(relative(process.cwd(), target)),
        ),
      )
      .sort();
    expect(entries).toEqual([
      "server/billing-runtime.ts",
      "server/jobs/queue.ts",
    ]);
    // queue.ts → auth.ts; billing-runtime.ts → owner-accounts.ts → auth.ts and access.ts.
    const importsOf = (file: string) =>
      directImports(resolve(file)).map((t) => relative(process.cwd(), t));
    expect(importsOf("server/jobs/queue.ts")).toContain("server/auth.ts");
    expect(
      importsOf("server/billing-runtime.ts").filter((t) =>
        authModules.includes(t),
      ),
    ).toEqual(["server/owner-accounts.ts"]);
    expect(importsOf("server/owner-accounts.ts")).toEqual(
      expect.arrayContaining(["server/auth.ts", "server/access.ts"]),
    );
    // The runbook row names both paths and the remediation covers both.
    const runbook = readFileSync("docs/RUNBOOK.md", "utf8");
    const row = runbook
      .split("\n")
      .find((line) => line.startsWith("| LD-16 L4"));
    expect(row).toBeDefined();
    for (const file of [...entries, ...authModules])
      expect(row, file).toContain(`\`${file}\``);
    expect(row).toMatch(/split the billing worker loop/);
    expect(row).toMatch(
      /add `auth\.ts`, `access\.ts` and `owner-accounts\.ts` to the worker's forbidden list/,
    );
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
