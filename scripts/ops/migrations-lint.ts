// Migration rules for every area (wave 1 contract §1.3 plus the runner's
// constraints). Used by tests/migrations-lint.test.ts and runnable on any
// migrations directory, for example another track's worktree:
//
//   npx tsx scripts/ops/migrations-lint.ts [dir]      (default: migrations)
//
// Prints one JSON line per finding and exits 1 when there is any.
//
// Files numbered 022 and later follow every rule; earlier files predate them
// and are only checked for names, transactions, the runtime role (below) and as
// the source of which tables force row-level security. Destructive DDL needs an
// explicit `-- gm:contract-approved` line agreed with the tech lead
// (docs/RELEASE.md).
//
// Runtime role rule (CFDIFIX-R2-1): no migration names the runtime login
// (gm_app locally and in CI, gm_<env>_app in staging and production, a rotated
// gm_<env>_app_<suffix>). Only scripts/grants.sql grants it, and the deploy
// applies that manifest with gm_app replaced by PG_APP_USER; a migration's
// literal name grants a role staging and production do not have (42704), or a
// stray one instead of the real login (every write fails with 42501).
// Comments may name it, and so may other names (a table gm_app_settings); it
// counts wherever SQL names a role (runtimeRoleNames), in statements, strings
// and dollar-quoted bodies, quoted or escaped (U&, E) (CFDIFIX-R3-2).
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
    | "ops_022_scope"
    | "runtime_role_named";
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

/** The end of a quoted token opened at `i` (`'` or `"`, the quote doubled inside), or -1. */
function quotedEnd(sql: string, i: number, backslash = false): number {
  const q = sql[i];
  let j = i + 1;
  while (j < sql.length) {
    if (backslash && sql[j] === "\\") j += 2;
    else if (sql[j] === q && sql[j + 1] === q) j += 2;
    else if (sql[j] === q) return j;
    else j++;
  }
  return -1;
}

const codePoint = (hex: string, fallback: string) => {
  const n = parseInt(hex, 16);
  return n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
};

/**
 * The text of a `U&"…"` identifier or `U&'…'` string body (PostgreSQL 4.1.1 and 4.1.2.3): the
 * escape character (backslash, or the UESCAPE one) followed by four hex digits, or by `+` and six,
 * is that code point; written twice it is itself.
 */
function unicodeEscapes(raw: string, escape: string): string {
  let out = "";
  for (let k = 0; k < raw.length; k++) {
    if (raw[k] !== escape) out += raw[k];
    else if (raw[k + 1] === escape) {
      out += escape;
      k++;
    } else {
      const six = raw[k + 1] === "+";
      const hex = raw.slice(k + (six ? 2 : 1), k + (six ? 8 : 5));
      if (/^[0-9a-f]+$/i.test(hex) && hex.length === (six ? 6 : 4)) {
        out += codePoint(hex, raw[k]);
        k += six ? 7 : 4;
      } else out += raw[k];
    }
  }
  return out;
}

/** The text of an `E'…'` string body (PostgreSQL 4.1.2.2, Table 4.1, and `''`). */
function cEscapes(raw: string): string {
  return raw.replace(
    /''|\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([\s\S]))/g,
    (all, octal, hex, u4, u8, other) =>
      all === "''"
        ? "'"
        : octal
          ? String.fromCharCode(parseInt(octal, 8) & 0xff)
          : hex
            ? String.fromCharCode(parseInt(hex, 16))
            : u4 || u8
              ? codePoint(u4 || u8, all)
              : ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[
                  other as string
                ] ?? other),
  );
}

const quoteString = (text: string) => "'" + text.replace(/'/g, "''") + "'";
const quoteIdent = (text: string) => '"' + text.replace(/"/g, '""') + '"';

/**
 * Removes comments and lifts dollar-quoted bodies out of the SQL so that
 * statements can be split on `;`. Single-quoted strings are kept (with ''
 * escapes) because DO loops list table names in them, and so are
 * double-quoted identifiers, whole: a `--`, `/*`, quote or `$` inside one is
 * part of the name (CFDIFIX-R3-2). `U&"…"` identifiers and `U&'…'` and
 * `E'…'` strings are written out decoded, as plain quoted ones.
 */
export function scan(sql: string): Scanned {
  let code = "";
  const bodies: string[] = [];
  let i = 0;
  const startsToken = (k: number) => !(k > 0 && IDENT_CHAR.test(sql[k - 1]));
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
    if (
      (c === "U" || c === "u") &&
      sql[i + 1] === "&" &&
      (sql[i + 2] === '"' || sql[i + 2] === "'") &&
      startsToken(i)
    ) {
      const q = sql[i + 2];
      const end = quotedEnd(sql, i + 2);
      const close = end === -1 ? sql.length : end;
      const uescape = /^\s*uescape\s*'([^'])'/i.exec(sql.slice(close + 1));
      const text = unicodeEscapes(
        sql
          .slice(i + 3, close)
          .split(q + q)
          .join(q),
        uescape ? uescape[1] : "\\",
      );
      code += q === '"' ? quoteIdent(text) : quoteString(text);
      i = close + 1 + (uescape ? uescape[0].length : 0);
      continue;
    }
    if ((c === "E" || c === "e") && sql[i + 1] === "'" && startsToken(i)) {
      const end = quotedEnd(sql, i + 1, true);
      const close = end === -1 ? sql.length : end;
      code += quoteString(cEscapes(sql.slice(i + 2, close)));
      i = close + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = quotedEnd(sql, i);
      const close = end === -1 ? sql.length - 1 : end;
      code += sql.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === "$" && startsToken(i)) {
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

/**
 * The runtime login, any environment's, as a whole name: gm_app, gm_<env>_app,
 * gm_<env>_app_<suffix>. It is matched only where SQL names a role (below), so
 * a table such as gm_app_settings is not the login (CFDIFIX-R3-2).
 */
const RUNTIME_ROLE = /^gm_(?:[a-z0-9]+_)?app(?:_[a-z0-9]+)?$/;

type Token = {
  /** word: unquoted name or key word, lower-cased; ident: double-quoted name; string: text. */
  kind: "word" | "ident" | "string" | "punct";
  text: string;
};

/** Tokens of scanned code; a `$qN$` placeholder is its dollar-quoted body, as a string. */
function tokenize(code: string, bodies: string[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = quotedEnd(code, i);
      const close = end === -1 ? code.length : end;
      out.push({
        kind: c === "'" ? "string" : "ident",
        text: code
          .slice(i + 1, close)
          .split(c + c)
          .join(c),
      });
      i = close + 1;
      continue;
    }
    const body = /^\$q(\d+)\$/.exec(code.slice(i, i + 16));
    if (body) {
      out.push({ kind: "string", text: bodies[Number(body[1])] });
      i += body[0].length;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < code.length && /[A-Za-z0-9_$]/.test(code[j])) j++;
      out.push({ kind: "word", text: code.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    const two = code.slice(i, i + 2);
    const op = ["::", "||", "<>", "!="].includes(two) ? two : c;
    out.push({ kind: "punct", text: op });
    i += op.length;
  }
  return out;
}

const isPunct = (t: Token | undefined, p: string) =>
  t?.kind === "punct" && t.text === p;
const isName = (t: Token | undefined) =>
  t?.kind === "word" || t?.kind === "ident";

/** The index of the `)` closing the `(` at `open` (or the end). */
function closing(t: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < t.length; k++)
    if (isPunct(t[k], "(")) depth++;
    else if (isPunct(t[k], ")") && --depth === 0) return k;
  return t.length;
}

/** The arguments between `(` at `open` and its `)`, split on top-level commas. */
function args(t: Token[], open: number): Token[][] {
  const close = closing(t, open);
  const out: Token[][] = [[]];
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    if (isPunct(t[k], "(")) depth++;
    if (isPunct(t[k], ")")) depth--;
    if (depth === 0 && isPunct(t[k], ",")) out.push([]);
    else out[out.length - 1].push(t[k]);
  }
  return out;
}

/**
 * The SQL text an operand of dynamic SQL stands for: a string's text, quote_ident /
 * quote_literal / format of literals, or `_` for anything computed at run time.
 */
function operand(t: Token[], j: number): { text: string; next: number } | null {
  const x = t[j];
  if (x?.kind === "string") return { text: x.text, next: j + 1 };
  if (!isName(x)) return null;
  if (isPunct(t[j + 1], "(")) {
    const a = args(t, j + 1);
    const lit = a.length === 1 ? literal(a[0]) : null;
    const text =
      x.kind !== "word"
        ? "_"
        : x.text === "quote_ident" && lit !== null
          ? quoteIdent(lit)
          : x.text === "quote_literal" && lit !== null
            ? quoteString(lit)
            : x.text === "format"
              ? (formatted(a) ?? "_")
              : "_";
    return { text, next: closing(t, j + 1) + 1 };
  }
  let n = j + 1;
  while (isPunct(t[n], ".") && isName(t[n + 1])) n += 2;
  return { text: "_", next: n };
}

/** An argument's SQL text when it is one operand known before run time. */
function literal(arg: Token[]): string | null {
  const o = operand(arg, 0);
  return o && o.next === arg.length && o.text !== "_" ? o.text : null;
}

/** format(fmt, …) with its literal arguments in place (%s, %I, %L, %n$…, %%). */
function formatted(a: Token[][]): string | null {
  const fmt =
    a[0]?.length === 1 && a[0][0].kind === "string" ? a[0][0].text : null;
  if (fmt === null) return null;
  let next = 1;
  return fmt.replace(
    /%(?:(\d+)\$)?-?\d*([sIL%])/g,
    (all, position: string | undefined, type: string) => {
      if (type === "%") return "%";
      const value = literal(a[position ? Number(position) : next] ?? []);
      if (!position) next++;
      if (value === null) return "_";
      return type === "I"
        ? quoteIdent(value)
        : type === "L"
          ? quoteString(value)
          : value;
    },
  );
}

/** Functions whose string arguments name roles, and columns compared with role names. */
const ROLE_FUNCTIONS = /^(?:pg_has_role|has_[a-z_]+_privilege|to_regrole)$/;
const ROLE_COLUMNS = new Set([
  "current_user",
  "session_user",
  "current_role",
  "user",
  "rolname",
  "usename",
  "grantee",
  "grantor",
]);
const COMPARISONS = ["=", "<>", "!="];

/**
 * Runtime login names a migration's SQL carries where SQL names a role
 * (CFDIFIX-R3-2): after TO in GRANT, CREATE/ALTER POLICY, OWNER TO and
 * REASSIGN; after FROM in REVOKE; after ROLE, USER, GROUP, AUTHORIZATION,
 * ADMIN, OWNED BY, GRANTED BY, MAPPING FOR; the roles a GRANT or REVOKE
 * grants; a string argument of pg_has_role, has_*_privilege or to_regrole, a
 * `::regrole` cast, a value compared with current_user, rolname and the like,
 * and set_config('role', …). Statements, single-quoted strings and every
 * dollar-quoted body are read, nested ones included (DO blocks, function bodies,
 * EXECUTE strings, format() with its literal arguments and || concatenations of
 * literals). Comments and other names (tables, columns) do not count.
 */
export function runtimeRoleNames(body: string): string[] {
  const found = new Set<string>();
  const check = (name: string) => {
    if (RUNTIME_ROLE.test(name.toLowerCase())) found.add(name.toLowerCase());
  };
  const seen = new Set<string>();
  const visit = (sql: string) => {
    if (seen.has(sql)) return;
    seen.add(sql);
    const { code, bodies } = scan(sql);
    const all = tokenize(code, bodies);
    let from = 0;
    for (let k = 0; k <= all.length; k++)
      if (k === all.length || isPunct(all[k], ";")) {
        statement(all.slice(from, k));
        from = k + 1;
      }
  };
  const statement = (t: Token[]) => {
    const word = (k: number, ...w: string[]) =>
      t[k]?.kind === "word" && w.includes(t[k].text);
    const before = (k: number, w: string) =>
      t.slice(0, k).some((x) => x.kind === "word" && x.text === w);
    /** A role list from `k`: [IF [NOT] EXISTS] [GROUP|ROLE|USER] name [, …]. */
    const roles = (k: number) => {
      if (word(k, "if")) k += word(k + 1, "not") ? 3 : 2;
      for (;;) {
        if (word(k, "group", "role", "user") && isName(t[k + 1])) k++;
        if (!isName(t[k]) && t[k]?.kind !== "string") return;
        check(t[k].text);
        if (!isPunct(t[k + 1], ",")) return;
        k += 2;
      }
    };
    /** The `(` enclosing token `k`, or -1. */
    const opener = (k: number) => {
      let depth = 0;
      for (let j = k - 1; j >= 0; j--)
        if (isPunct(t[j], ")")) depth++;
        else if (isPunct(t[j], "(") && depth-- === 0) return j;
      return -1;
    };
    for (let k = 0; k < t.length; k++) {
      const x = t[k];
      if (x.kind === "word")
        switch (x.text) {
          case "to":
            if (
              word(k - 1, "owner") ||
              before(k, "grant") ||
              before(k, "policy") ||
              before(k, "reassign")
            )
              roles(k + 1);
            break;
          case "from":
            if (before(k, "revoke")) roles(k + 1);
            break;
          case "role":
          case "user":
          case "group":
          case "authorization":
          case "admin":
            roles(k + 1);
            break;
          case "by":
            if (word(k - 1, "owned", "granted")) roles(k + 1);
            break;
          case "for":
            if (word(k - 1, "mapping")) roles(k + 1);
            break;
          case "grant":
          case "revoke":
            // GRANT role TO …; REVOKE [ADMIN|INHERIT|SET|GRANT OPTION FOR] role FROM …
            roles(word(k + 2, "option") && word(k + 3, "for") ? k + 4 : k + 1);
            break;
          case "set_config":
            if (isPunct(t[k + 1], "(")) {
              const a = args(t, k + 1);
              const setting = a[0] ? literal(a[0]) : null;
              const value = a[1] ? literal(a[1]) : null;
              if (
                value !== null &&
                ["role", "session_authorization"].includes(
                  setting?.toLowerCase() ?? "",
                )
              )
                check(value);
            }
            break;
          case "format":
            if (isPunct(t[k + 1], "(")) {
              const text = formatted(args(t, k + 1));
              if (text !== null) visit(text);
            }
            break;
        }
      if (x.kind === "string") {
        visit(x.text);
        const open = opener(k);
        const fn = open > 0 ? t[open - 1] : undefined;
        if (
          (isPunct(t[k + 1], "::") && word(k + 2, "regrole")) ||
          (fn?.kind === "word" && ROLE_FUNCTIONS.test(fn.text)) ||
          (fn?.kind === "word" &&
            fn.text === "in" &&
            t[open - 2]?.kind === "word" &&
            ROLE_COLUMNS.has(t[open - 2].text)) ||
          (COMPARISONS.some((c) => isPunct(t[k - 1], c)) &&
            t[k - 2]?.kind === "word" &&
            ROLE_COLUMNS.has(t[k - 2].text)) ||
          (COMPARISONS.some((c) => isPunct(t[k + 1], c)) &&
            t[k + 2]?.kind === "word" &&
            ROLE_COLUMNS.has(t[k + 2].text))
        )
          check(x.text);
      }
      // Dynamic SQL built with ||: the literal parts joined, run-time parts as `_`.
      const first = operand(t, k);
      if (first && isPunct(t[first.next], "||")) {
        const parts = [first.text];
        let next = first.next;
        while (isPunct(t[next], "||")) {
          const o = operand(t, next + 1);
          if (!o) break;
          parts.push(o.text);
          next = o.next;
        }
        visit(parts.join(""));
      }
    }
  };
  visit(body);
  return [...found].sort();
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
    for (const role of runtimeRoleNames(f.body))
      add(
        f.name,
        "runtime_role_named",
        `${role}: the runtime login is granted only by scripts/grants.sql (PG_APP_USER), never by a migration`,
      );
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
