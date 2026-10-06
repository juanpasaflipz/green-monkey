import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/** Relative imports of one source file (static `import`/`export … from`). */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [
    ...source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']|(?:^|\n)\s*import\s+["'](\.[^"']+)["']/g,
    ),
  ].map((m) => {
    const target = resolve(
      dirname(file),
      (m[1] ?? m[2]).replace(/\.js$/, ".ts"),
    );
    return relative(
      process.cwd(),
      existsSync(target) ? target : target + ".ts",
    );
  });
}
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    for (const next of importsOf(file)) visit(next);
  };
  visit(entry);
  return seen;
}

describe("fiscal process boundaries (LD-15 fiscal EXTRA, LD-16 C4)", () => {
  it("server/fiscal-read.ts is a leaf: it imports only server/db.ts and shared/*", () => {
    const direct = importsOf("server/fiscal-read.ts");
    expect(direct.length).toBeGreaterThan(0);
    expect(
      direct.filter((f) => f !== "server/db.ts" && !f.startsWith("shared/")),
    ).toEqual([]);
    const closure = reachable("server/fiscal-read.ts");
    for (const forbidden of [
      "server/fiscal.ts",
      "server/orders.ts",
      "server/auth.ts",
      "server/access.ts",
      "server/tokens.ts",
      "server/checks.ts",
      "server/index.ts",
    ])
      expect(closure.has(forbidden), forbidden).toBe(false);
    expect([...closure].filter((f) => f.startsWith("server/routes/"))).toEqual(
      [],
    );
  });

  it("server/fiscal.ts re-exports the leaf's readers (ticketForCfdi, fiscalTicketIdentity and the ticket readers)", async () => {
    const leaf = await import("../server/fiscal-read");
    const fiscal = await import("../server/fiscal");
    for (const name of [
      "ticketForCfdi",
      "fiscalTicketIdentity",
      "readTicket",
      "orderRefundTax",
      "fiscalRows",
      "composeOrderFiscal",
      "fiscalContext",
      "assertNoFiscalTicket",
    ]) {
      expect(typeof (leaf as Record<string, unknown>)[name], name).toBe(
        "function",
      );
      expect((fiscal as Record<string, unknown>)[name], name).toBe(
        (leaf as Record<string, unknown>)[name],
      );
    }
  });
});
