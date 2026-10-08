/**
 * LO-R9 guard (PLATFORM-LOCKS-3, PLAT-HR-1): tenant() retries one deadlock (40P01) or
 * serialization failure (40001) silently, so a concurrency burst in a DB suite proves
 * nothing about lock order unless it asserts that tenant() caught none. This test parses
 * every DB suite (tests/database.ts, tests/*-db.ts) and requires each Promise.all /
 * Promise.allSettled to be wrapped in noRetries() (tests/db-retries.ts), to run inside
 * one tenant() callback (one transaction, nothing concurrent), or to be listed below with
 * the reason it cannot hide a retried deadlock.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

// file#binding (the variable the burst's result is assigned to) → why it needs no
// noRetries(). Only transactions opened by tenant() retry; the others fail the test on
// their first deadlock, which is the assertion noRetries() adds.
const NOT_THROUGH_TENANT: Record<string, string> = {
  "tests/billing-db.ts#requests": "billing store transactions (no tenant())",
  "tests/billing-db.ts#claims": "billing store transactions (no tenant())",
  "tests/billing-db.ts#quotes": "billing store transactions (no tenant())",
  "tests/billing-db.ts#confirmations":
    "billing store transactions (no tenant())",
  "tests/free-limits-db.ts#entries": "withOwner → accountScope (no tenant())",
  "tests/google-attempts-db.ts#results":
    "Google attempt store transactions (no tenant())",
  "tests/owner-accounts-db.ts#created":
    "withOwner → accountScope (no tenant())",
  "tests/owner-management-db.ts#locations":
    "withOwner → accountScope (no tenant())",
  "tests/owner-management-db.ts#accepts":
    "withOwner → accountScope (no tenant())",
  "tests/offline-sync-db.ts#[up, slowServer, downServer]":
    "HTTP fixtures starting, no transaction",
  "tests/offline-sync-db.ts#pings":
    "HTTP pings (the coalescing check), no transaction",
  // The one deliberate deadlock asserts dbRetryCount() itself: exactly one retry.
  "tests/menu-db.ts#both": "the deliberate deadlock counts its own retry",
};

const suites = () =>
  readdirSync("tests")
    .filter((f) => f === "database.ts" || f.endsWith("-db.ts"))
    .map((f) => `tests/${f}`)
    .sort();

const calleeName = (call: ts.CallExpression): string | null => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e))
    return `${e.expression.getText()}.${e.name.text}`;
  return null;
};

type Burst = { key: string; guard: "noRetries" | "tenant" | null };

/** Every Promise.all/allSettled in one source, with its binding key and guard. */
export function bursts(file: string, source: string): Burst[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: Burst[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ["Promise.all", "Promise.allSettled"].includes(calleeName(node) ?? "")
    ) {
      let guard: Burst["guard"] = null;
      let binding: string | null = null;
      let inFunction = false;
      for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
        // The binding is the variable the burst's own expression is assigned to.
        if (ts.isFunctionLike(p)) inFunction = true;
        if (!binding && !inFunction && ts.isVariableDeclaration(p))
          binding = p.name.getText(sf);
        if (ts.isCallExpression(p)) {
          const name = calleeName(p);
          if (name === "noRetries") guard = "noRetries";
          else if (name === "tenant") guard ??= "tenant";
        }
        if (guard === "noRetries") break;
      }
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({ key: `${file}#${binding ?? `line ${line + 1}`}`, guard });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("DB suites assert that tenant() retried no deadlock (LO-R9, PLATFORM-LOCKS-3)", () => {
  const all = suites().flatMap((f) => bursts(f, readFileSync(f, "utf8")));

  it("every concurrent burst is wrapped in noRetries(), runs inside one tenant(), or is listed with its reason", () => {
    const unguarded = all
      .filter((b) => !b.guard && !Object.hasOwn(NOT_THROUGH_TENANT, b.key))
      .map((b) => b.key);
    expect(
      unguarded,
      "wrap the burst in noRetries(label, () => Promise.allSettled(…)) (tests/db-retries.ts)",
    ).toEqual([]);
  });

  it("every listed exception still exists and is still unwrapped", () => {
    const unwrapped = new Set(all.filter((b) => !b.guard).map((b) => b.key));
    expect(
      Object.keys(NOT_THROUGH_TENANT).filter((k) => !unwrapped.has(k)),
      "stale exceptions: delete them",
    ).toEqual([]);
  });

  it("the core suite's money and kitchen races are among the wrapped bursts (PLAT-HR-1)", () => {
    const core = bursts(
      "tests/database.ts",
      readFileSync("tests/database.ts", "utf8"),
    );
    expect(core.length).toBeGreaterThanOrEqual(5);
    expect(core.every((b) => b.guard === "noRetries")).toBe(true);
  });

  it("recognizes the guards and reports an unwrapped burst", () => {
    const found = bursts(
      "tests/x-db.ts",
      `
        const a = await noRetries("x", () => Promise.allSettled([tenant(sql, t, f)]));
        const b = await tenant(sql, t, (tx) => Promise.all([tx\`select 1\`]));
        const c = await Promise.all([tenant(sql, t, f), tenant(sql, t, f)]);
        await Promise.all([tenant(sql, t, f)]);
      `,
    );
    expect(found).toEqual([
      { key: "tests/x-db.ts#line 2", guard: "noRetries" },
      { key: "tests/x-db.ts#line 3", guard: "tenant" },
      { key: "tests/x-db.ts#c", guard: null },
      { key: "tests/x-db.ts#line 5", guard: null },
    ]);
  });
});
