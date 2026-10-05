// Migration rules for every area (wave 1 contract §1.3 plus the runner's
// constraints). Used by tests/migrations-lint.test.ts and runnable on any
// migrations directory, for example another track's worktree:
//
//   npx tsx scripts/ops/migrations-lint.ts [dir]      (default: migrations)
//
// Prints one JSON line per finding and exits 1 when there is any.
//
// Files numbered 022 and later follow every rule; earlier files predate them
// and are only checked for names, transactions and as the source of which
// tables force row-level security. Destructive DDL needs an explicit
// `-- gm:contract-approved` line agreed with the tech lead (docs/RELEASE.md).
//
// Backfill rule (OPS-R2): deployed migrations run as gm_migrator, which owns
// the tables but is neither a superuser nor BYPASSRLS, so FORCE ROW LEVEL
// SECURITY applies to it and, with no tenant set, every tenant_scope policy
// hides every row. An UPDATE, DELETE or INSERT ... SELECT then silently
// changes nothing, and tables read through FROM/JOIN/USING look empty. Every
// such table needs `ALTER TABLE t NO FORCE ROW LEVEL SECURITY` before the DML
// and `ALTER TABLE t FORCE ROW LEVEL SECURITY` after it, in the same file.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readMigrations,
  splitStatements,
  type MigrationFile,
} from "../../server/ops/schema.js";

export const RULES_FROM = 22;
/** Platform metadata tables that are deliberately not row-level secured. */
export const RLS_ALLOWLIST: ReadonlySet<string> = new Set([
  "schema_grants",
  "schema_migrations",
]);

export interface LintFinding {
  file: string;
  rule:
    | "lock_timeout"
    | "transaction_control"
    | "no_transaction_statement"
    | "rls_on_new_table"
    | "backfill_owner_pattern"
    | "destructive_ddl"
    | "ops_022_scope";
  detail: string;
}

interface Scanned {
  /** SQL without comments; every dollar-quoted body replaced by `$qN$`. */
  code: string;
  /** Dollar-quoted bodies, by placeholder number. */
  bodies: string[];
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * Removes comments and lifts dollar-quoted bodies out of the SQL so that
 * statements can be split on `;`. Single-quoted strings are kept (with ''
 * escapes) because DO loops list table names in them.
 */
export function scan(sql: string): Scanned {
  let code = "";
  const bodies: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      code += " ";
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      code += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$" && !(i > 0 && IDENT_CHAR.test(sql[i - 1]))) {
      let j = i + 1;
      if (j < sql.length && IDENT_START.test(sql[j]))
        while (j < sql.length && IDENT_CHAR.test(sql[j])) j++;
      if (sql[j] === "$") {
        const tag = sql.slice(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        if (end !== -1) {
          code += `$q${bodies.length}$`;
          bodies.push(sql.slice(j + 1, end));
          i = end + tag.length;
          continue;
        }
      }
    }
    code += c;
    i++;
  }
  return { code, bodies };
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const withoutStrings = (s: string) => s.replace(/'(?:[^']|'')*'/g, "''");

/** Statements of already-scanned code, whitespace-normalized and lower-case. */
export function statementsOf(code: string): string[] {
  return code.split(";").map(normalize).filter(Boolean);
}

/** Top-level statements of a migration body. */
export function statements(body: string): string[] {
  return statementsOf(scan(body).code);
}

/** Bodies of `DO $$ ... $$` blocks (they run at migration time; function bodies do not). */
export function doBlocks(body: string): Scanned[] {
  const { code, bodies } = scan(body);
  const blocks: Scanned[] = [];
  for (const m of code.matchAll(/\bdo\s+(?:language\s+\w+\s+)?\$q(\d+)\$/gi))
    blocks.push(scan(bodies[Number(m[1])]));
  return blocks;
}

const TABLE = String.raw`(?:if exists )?(?:only )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?`;
export type RlsMode = "enable" | "force" | "no force";
const MODES: RlsMode[] = ["enable", "force", "no force"];

/**
 * Tables a migration switches to each row-level security mode, through a
 * literal `ALTER TABLE t ... ROW LEVEL SECURITY` (top level or in a DO block)
 * or the standard DO loop:
 *   FOREACH t IN ARRAY ARRAY['a','b'] LOOP
 *     EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t); ...
 */
export function rlsTables(body: string): Record<RlsMode, Set<string>> {
  const result = {
    enable: new Set<string>(),
    force: new Set<string>(),
    "no force": new Set<string>(),
  } as Record<RlsMode, Set<string>>;
  const literal = (code: string) => {
    for (const mode of MODES)
      for (const m of normalize(code).matchAll(
        new RegExp(
          String.raw`alter table ${TABLE} ${mode} row level security`,
          "g",
        ),
      ))
        result[mode].add(m[1]);
  };
  literal(scan(body).code);
  for (const block of doBlocks(body)) {
    const code = normalize(block.code);
    literal(withoutStrings(code));
    const loops = [
      ...code.matchAll(/foreach (\w+) in array array ?\[([^\]]*)\]/g),
      ...code.matchAll(
        /for (\w+) in select unnest ?\( ?array ?\[([^\]]*)\] ?\)/g,
      ),
    ];
    for (const [, variable, list] of loops) {
      const tables = [...list.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map(
        (m) => m[1],
      );
      for (const mode of MODES)
        if (
          new RegExp(
            String.raw`execute format ?\( ?'alter table (?:only )?%i ${mode} row level security' ?, ?${variable} ?\)`,
          ).test(code)
        )
          for (const table of tables) result[mode].add(table);
    }
  }
  return result;
}

/** Tables created at the top level of a migration. */
export function createdTables(body: string): string[] {
  return [
    ...normalize(scan(body).code).matchAll(
      /create table (?:if not exists )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/g,
    ),
  ].map((m) => m[1]);
}

/** UPDATE / INSERT / DELETE statements that run at migration time (top level and DO blocks). */
export function dmlStatements(body: string): string[] {
  const DML = /^(with\b|update\b|insert into\b|delete from\b)/;
  // Inside PL/pgSQL a statement may follow BEGIN, LOOP, THEN or ELSE.
  const inBlock = (s: string) =>
    s.match(
      /^(?:.*?\b(?:begin|loop|then|else) )?((?:with|update|insert into|delete from)\b.*)$/,
    )?.[1];
  return [
    ...statements(body).filter((s) => DML.test(s)),
    ...doBlocks(body)
      .flatMap((block) => statementsOf(block.code))
      .map(inBlock)
      .filter((s): s is string => Boolean(s)),
  ];
}

const NOT_TABLES = new Set([
  "select",
  "lateral",
  "only",
  "values",
  "unnest",
  "rows",
]);

/**
 * The table a DML statement writes and the tables it reads through
 * FROM / JOIN / USING (CTE names and set-returning functions excluded).
 * Comma-separated FROM lists beyond the first item are not followed.
 */
export function dmlTables(statement: string): {
  target: string | null;
  reads: string[];
} {
  const s = normalize(withoutStrings(statement));
  let target: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (depth === 0 && (i === 0 || !IDENT_CHAR.test(s[i - 1]))) {
      const m = s
        .slice(i)
        .match(
          /^(?:update|insert into|delete from) (?:only )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/,
        );
      if (m) {
        target = m[1];
        break;
      }
    }
  }
  const ctes = new Set(
    [
      ...s.matchAll(
        /(?:\bwith(?: recursive)?|,) ([a-z_][a-z0-9_]*) (?:\([^)]*\) )?as (?:not )?(?:materialized )?\(/g,
      ),
    ].map((m) => m[1]),
  );
  const reads = new Set<string>();
  for (const m of s.matchAll(
    /\b(?:from|join|using) (?:only |lateral )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?( ?\()?/g,
  )) {
    if (m[2] || ctes.has(m[1]) || NOT_TABLES.has(m[1])) continue;
    reads.add(m[1]);
  }
  if (target) reads.delete(target);
  return { target, reads: [...reads] };
}

/** Returns the destructive statements not covered by a same-file replacement. */
export function destructive(body: string): string[] {
  const all = statements(body);
  const text = all.join(";\n");
  return all.filter((lower) => {
    if (
      /^drop (table|schema|database|type|sequence|view|materialized view|role|owned)\b/.test(
        lower,
      )
    )
      return true;
    if (/\bdrop column\b/.test(lower)) return true;
    if (/\brename\b/.test(lower)) return true;
    if (/\balter column \S+ (set data )?type\b/.test(lower)) return true;
    // Replacing a constraint, index, policy, trigger or function in the same
    // file (drop then create with the same name) widens or rebuilds; a bare
    // drop is a contract change.
    const constraint = lower.match(
      /\bdrop constraint (?:if exists )?"?([a-z0-9_]+)"?/,
    );
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

/** Lints a set of migration files (normally the whole directory). */
export function lintMigrations(files: MigrationFile[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (file: string, rule: LintFinding["rule"], detail: string) =>
    findings.push({ file, rule, detail });
  // Every table any file forces RLS on: the owner pattern applies to them.
  const forced = new Set<string>();
  for (const f of files) for (const t of rlsTables(f.body).force) forced.add(t);

  for (const f of files) {
    const code = scan(f.body).code;
    if (f.transactional) {
      if (/\bconcurrently\b/i.test(code))
        add(
          f.name,
          "transaction_control",
          "CONCURRENTLY needs -- gm:no-transaction",
        );
      if (
        /(^|;)\s*(begin|commit|rollback|start transaction|end)\s*(transaction|work)?\s*;/i.test(
          code,
        )
      )
        add(f.name, "transaction_control", "the runner owns the transaction");
    } else
      for (const part of splitStatements(f.body)) {
        const parts = statements(part);
        if (
          parts.length !== 1 ||
          !/^(create (unique )?index concurrently|drop index concurrently if exists|reindex (index|table) concurrently|alter table \S+ validate constraint)\b/.test(
            parts[0],
          )
        )
          add(
            f.name,
            "no_transaction_statement",
            "one concurrent index/validate statement per gm:statement-break",
          );
      }
    if (f.number < RULES_FROM) continue;

    if (
      f.transactional &&
      !/^set local lock_timeout ?= ?'\d+(ms|s)?'$/.test(
        statements(f.body)[0] ?? "",
      )
    )
      add(f.name, "lock_timeout", "start with SET LOCAL lock_timeout = '5s';");

    const own = rlsTables(f.body);
    for (const table of createdTables(f.body)) {
      if (RLS_ALLOWLIST.has(table)) continue;
      for (const mode of ["enable", "force"] as const)
        if (!own[mode].has(table))
          add(
            f.name,
            "rls_on_new_table",
            `${table}: ${mode} row level security`,
          );
    }

    for (const statement of dmlStatements(f.body)) {
      const { target, reads } = dmlTables(statement);
      for (const table of [target, ...reads])
        if (table && forced.has(table))
          for (const mode of ["no force", "force"] as const)
            if (!own[mode].has(table))
              add(
                f.name,
                "backfill_owner_pattern",
                `${table}: ALTER TABLE ${table} ${mode.toUpperCase()} ROW LEVEL SECURITY around the backfill`,
              );
    }

    const found = destructive(f.body);
    if (found.length && !/^-- gm:contract-approved\b/m.test(f.body))
      add(
        f.name,
        "destructive_ddl",
        `${found[0].slice(0, 120)} (needs -- gm:contract-approved)`,
      );

    if (f.number === 22) {
      for (const s of statements(f.body))
        if (
          !/^(set local (lock|statement)_timeout|create index \w+ on )/.test(s)
        )
          add(
            f.name,
            "ops_022_scope",
            `only hot-path indexes: ${s.slice(0, 80)}`,
          );
      if (/\bcheck\b/i.test(code))
        add(f.name, "ops_022_scope", "no CHECK constraints in 022");
    }
  }
  // One finding per file, rule and detail.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.file}|${f.rule}|${f.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function invokedDirectly() {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const dir = resolve(process.argv[2] ?? "migrations");
  const findings = lintMigrations(readMigrations(dir));
  for (const finding of findings) console.log(JSON.stringify(finding));
  console.log(
    JSON.stringify({
      message: "migrations_lint",
      dir,
      findings: findings.length,
    }),
  );
  process.exitCode = findings.length ? 1 : 0;
}
