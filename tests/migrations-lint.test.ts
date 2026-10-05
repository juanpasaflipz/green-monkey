import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  isNoTransaction,
  readMigrations,
  splitStatements,
} from "../server/ops/schema.js";
import { retentionRules } from "../server/ops/retention.js";

/**
 * Migration rules for every area (ops spec §6.1). Files numbered 022 and later
 * follow them; earlier files predate the rules and are only checked for names.
 */
const RULES_FROM = 22;
/** Platform metadata tables that are deliberately not row-level secured. */
const RLS_ALLOWLIST = new Set(["schema_grants", "schema_migrations"]);

/** Removes comments and dollar-quoted bodies (functions, DO blocks). */
function code(body: string) {
  return body
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "$$body$$")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}
const statements = (body: string) =>
  code(body)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
const ident = String.raw`(?:public\.)?"?([a-z_][a-z0-9_]*)"?`;

const files = readMigrations();
const ruled = files.filter((f) => f.number >= RULES_FROM);

/** Returns the destructive statements not covered by a same-file replacement. */
function destructive(body: string): string[] {
  const all = statements(body);
  const text = all.join(";\n").toLowerCase();
  return all.filter((s) => {
    const lower = s.toLowerCase();
    if (/^drop (table|schema|database|type|sequence|view|materialized view|role|owned)\b/.test(lower))
      return true;
    if (/\bdrop column\b/.test(lower)) return true;
    if (/\brename\b/.test(lower)) return true;
    if (/\balter column \S+ (set data )?type\b/.test(lower)) return true;
    // Replacing a constraint, index, policy, trigger or function in the same
    // file (drop then create with the same name) widens or rebuilds; a bare
    // drop is a contract change.
    const constraint = lower.match(/\bdrop constraint (?:if exists )?"?([a-z0-9_]+)"?/);
    if (constraint)
      return !new RegExp(`add constraint "?${constraint[1]}"?\\b`).test(text);
    const other = lower.match(
      /^drop (index|policy|trigger|function)(?: concurrently)?(?: if exists)? "?([a-z0-9_]+)"?/,
    );
    if (other)
      return !new RegExp(
        `create (or replace )?(unique )?${other[1]}( concurrently)?( if not exists)? "?${other[2]}"?\\b`,
      ).test(text);
    return false;
  });
}

describe("migrations lint", () => {
  it("file names match NNN_name.sql with unique numbers", () => {
    const names = readdirSync("migrations").filter((n) => n.endsWith(".sql"));
    expect(names.length).toBe(files.length);
    for (const name of names) expect(name).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
    const numbers = files.map((f) => f.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("migrations ≥ 022 set lock_timeout", () => {
    expect(ruled.map((f) => f.name)).toContain("022_ops.sql");
    for (const f of ruled.filter((f) => f.transactional))
      expect(f.body, f.name).toMatch(/^\s*SET LOCAL lock_timeout\s*=/im);
  });

  it("transactional files contain no CONCURRENTLY/BEGIN/COMMIT", () => {
    for (const f of files.filter((f) => f.transactional)) {
      const c = code(f.body);
      expect(c, f.name).not.toMatch(/\bconcurrently\b/i);
      expect(c, f.name).not.toMatch(
        /(^|;)\s*(begin|commit|rollback|start transaction|end)\s*(transaction|work)?\s*;/i,
      );
    }
  });

  it("no-transaction files contain only concurrent index/validate statements split by gm:statement-break", () => {
    expect(isNoTransaction("-- note\n-- gm:no-transaction\nCREATE INDEX CONCURRENTLY x ON t(a);")).toBe(true);
    expect(isNoTransaction("CREATE TABLE t();\n-- gm:no-transaction")).toBe(false);
    expect(
      splitStatements("-- gm:no-transaction\nA;\n-- gm:statement-break\nB;\n-- gm:statement-break\n"),
    ).toEqual(["-- gm:no-transaction\nA;", "B;"]);
    for (const f of files.filter((f) => !f.transactional))
      for (const part of splitStatements(f.body)) {
        const parts = statements(part);
        expect(parts.length, `${f.name}: one statement per break`).toBe(1);
        expect(parts[0], f.name).toMatch(
          /^(create (unique )?index concurrently|drop index concurrently if exists|reindex (index|table) concurrently|alter table \S+ validate constraint)\b/i,
        );
      }
  });

  it("new tables in ≥ 022 enable and force RLS (allowlist: schema_grants)", () => {
    for (const f of ruled) {
      const c = code(f.body);
      for (const m of c.matchAll(
        new RegExp(String.raw`create table (?:if not exists )?${ident}`, "gi"),
      )) {
        const table = m[1].toLowerCase();
        if (RLS_ALLOWLIST.has(table)) continue;
        for (const mode of ["enable", "force"])
          expect(c, `${f.name}: ${table} ${mode} RLS`).toMatch(
            new RegExp(
              String.raw`alter table (?:if exists )?(?:public\.)?"?${table}"? ${mode} row level security`,
              "i",
            ),
          );
      }
    }
  });

  it("backfill DML requires gm:backfill and NO FORCE/FORCE on that table", () => {
    for (const f of ruled)
      for (const s of statements(f.body)) {
        const m = s.match(
          new RegExp(String.raw`^(?:with .* )?(?:update|insert into|delete from) ${ident}`, "i"),
        );
        if (!m) continue;
        const table = m[1].toLowerCase();
        expect(f.body, `${f.name}: gm:backfill ${table}`).toMatch(
          new RegExp(String.raw`^-- gm:backfill ${table}\b`, "m"),
        );
        expect(code(f.body), `${f.name}: NO FORCE ${table}`).toMatch(
          new RegExp(String.raw`alter table (?:public\.)?"?${table}"? no force row level security`, "i"),
        );
        expect(code(f.body), `${f.name}: FORCE ${table}`).toMatch(
          new RegExp(String.raw`alter table (?:public\.)?"?${table}"? force row level security`, "i"),
        );
      }
  });

  it("destructive DDL requires gm:contract-approved", () => {
    expect(destructive("ALTER TABLE t DROP COLUMN c;")).toHaveLength(1);
    expect(destructive("ALTER TABLE t RENAME TO u;")).toHaveLength(1);
    expect(destructive("ALTER TABLE t ALTER COLUMN c TYPE bigint;")).toHaveLength(1);
    expect(
      destructive(
        "ALTER TABLE t DROP CONSTRAINT t_kind_check; ALTER TABLE t ADD CONSTRAINT t_kind_check CHECK (kind IN ('a','b'));",
      ),
    ).toHaveLength(0);
    expect(destructive("DROP INDEX old_idx;")).toHaveLength(1);
    for (const f of ruled) {
      const found = destructive(f.body);
      if (found.length)
        expect(f.body, `${f.name}: ${found[0]}`).toMatch(/^-- gm:contract-approved\b/m);
    }
  });

  it("022 retention predicates equal server/ops/retention.ts rules", () => {
    const body = readFileSync("migrations/022_ops.sql", "utf8");
    const rules = [
      ...body.matchAll(/ARRAY\['([a-z_]+)',\s*\$p\$([\s\S]*?)\$p\$\]/g),
    ].map((m) => ({ table: m[1], predicate: m[2] }));
    expect(rules).toEqual(retentionRules);
  });
});
