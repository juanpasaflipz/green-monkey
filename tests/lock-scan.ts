/**
 * Static lock-order scanner behind tests/lock-order.test.ts (platform §6.2,
 * docs/ARCHITECTURE.md "Global lock order"; PLATFORM-LOCKS-1, LOCKS-2).
 *
 * It parses every server/**\/*.ts with the TypeScript compiler API (parse only, no type
 * checking) and, per unit, builds the tree of lock events the unit takes, expanding calls
 * to other server functions transitively (imports resolved by module path, aliases and
 * re-exports followed, cycles cut). It then checks, per transaction, that LO levels never
 * step back (LO-R1) unless the object is already held (a free re-lock), and that no table
 * locked FOR SHARE is later locked for update (LO-R6, no SHARE->UPDATE upgrade).
 *
 * What it sees (and therefore enforces):
 * - Builtin lock calls, never expanded: once() = LO-1 operation key, then LO-2
 *   restaurants FOR SHARE unless its kind literal is one once() excludes (parsed from
 *   server/orders.ts); bumpKitchenFeed = LO-10; drawer = LO-11; lockStockItems, stock =
 *   LO-9; refreshCheckState, issueDueTicket = LO-12 (issuance, from fiscal 027).
 * - SQL in tagged templates and in string arguments to tx.unsafe: FOR UPDATE / FOR NO KEY
 *   UPDATE / FOR SHARE / FOR KEY SHARE on a table of the LO table (the FROM table, or the
 *   alias named by "for update of"); UPDATE of such a table (an implicit row lock), except
 *   orders, which commands update only under their own LO-5 lock; INSERT … ON CONFLICT DO
 *   UPDATE upserts of the counter rows (order_numbers, kitchen_feed_versions, menu_state,
 *   fiscal_folio_counters); INSERT INTO stock_movements (its trigger updates stock_items);
 *   and pg_advisory_xact_lock keys: organization and owner-account classes 711, 918, 919
 *   and 921 are LO-0, other non-zero classes (920 free limits, 923 pairing) and the named
 *   ':floor', ':stock-items' and offline-prefix keys LO-3, a tender key LO-6, any other key
 *   an operation key (LO-1).
 * - Control flow: the two sides of an if/else, a ?: and the right side of &&, || and ??
 *   are alternatives, each checked from the state before them, as are switch cases; an
 *   if whose branch ends in return or throw makes the rest of the block the other
 *   alternative. After the alternatives the transaction holds what any of them took.
 *   tenant(…) and sql.begin(…) open a new transaction: levels restart inside them.
 * - Units: top-level functions; top-level consts whose initializer contains a function
 *   (`export const cmd = wrap(async …)`); object-literal methods (`const appliers = {
 *   order: async … }` → appliers.order); class methods (Class.method); top-level
 *   `X.y = …function…` assignments; route registrations (top level and inside
 *   register/registerPreAuth bodies, named "<verb> <path>").
 * - Calls: an identifier resolved to a top-level function, const or import (aliases,
 *   re-exports and default exports followed; a namespace import's `ns.fn()`), expanded
 *   in place. A builtin imported under another name fails the ratchet.
 *
 * What it does NOT see (DB tests stay the dynamic guard, with tests/db-retries.ts):
 * calls through object properties or callbacks passed around (appliers[kind](…)), SQL
 * built from fragments or variables, which alternative a parameter selects (a function
 * whose lock depends on an argument counts with and without it), loop repetition, and
 * row identity: a second lock of the same table is treated as a re-lock of the same rows.
 *
 * Violations are reported where both events of the pair are visible, never in every
 * caller: a step back inside a called function is that function's violation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";

/** LO levels as numbers; LO-2b and LO-5a sit between their neighbours. */
export const LEVEL = {
  organization: 0,
  key: 1,
  restaurants: 2,
  holds: 2.5,
  config: 3,
  orderNumbers: 4,
  orders: 5,
  employees: 5.5,
  tender: 6,
  rounds: 7,
  voids: 8,
  stock: 9,
  feed: 10,
  drawer: 11,
  issue: 12,
} as const;

/** "2b", "5a" and the integers, as written in the LO table. */
export function levelLabel(level: number): string {
  if (level === LEVEL.holds) return "2b";
  if (level === LEVEL.employees) return "5a";
  return String(level);
}

/** Tables of the LO table and their levels. Any other table takes no ordered lock. */
export const TABLE_LEVEL: Record<string, number> = {
  restaurants: LEVEL.restaurants,
  public_order_holds: LEVEL.holds,
  menu_state: LEVEL.config,
  money_controls: LEVEL.config,
  restaurant_fiscal_profiles: LEVEL.config,
  modifier_groups: LEVEL.config,
  menu_categories: LEVEL.config,
  catalog: LEVEL.config,
  dining_areas: LEVEL.config,
  dining_tables: LEVEL.config,
  order_numbers: LEVEL.orderNumbers,
  orders: LEVEL.orders,
  employees: LEVEL.employees,
  rounds: LEVEL.rounds,
  offline_kitchen_reviews: LEVEL.rounds,
  line_voids: LEVEL.voids,
  discounts: LEVEL.voids,
  stock_items: LEVEL.stock,
  kitchen_feed_versions: LEVEL.feed,
  cash_sessions: LEVEL.drawer,
  fiscal_folio_counters: LEVEL.issue,
};
/** Implicit row locks counted for UPDATE statements (orders: see the header). */
const UPDATE_LOCKS = new Set(
  Object.keys(TABLE_LEVEL).filter((t) => t !== "orders"),
);
const UPSERTED = new Set([
  "order_numbers",
  "kitchen_feed_versions",
  "menu_state",
  "fiscal_folio_counters",
]);
/** Advisory key classes above any tenant lock (billing, owner accounts, organizations). */
const ORGANIZATION_CLASSES = new Set([711, 918, 919, 921]);

/** Builtin lock calls (never expanded). once() is special-cased. */
export const CALL_LEVEL: Record<string, number> = {
  bumpKitchenFeed: LEVEL.feed,
  refreshCheckState: LEVEL.issue,
  issueDueTicket: LEVEL.issue,
  drawer: LEVEL.drawer,
  lockStockItems: LEVEL.stock,
  stock: LEVEL.stock,
};
const CALL_OBJECT: Record<string, string> = {
  bumpKitchenFeed: "kitchen_feed_versions",
  refreshCheckState: "issue",
  issueDueTicket: "issue",
  drawer: "cash_sessions",
  lockStockItems: "stock_items",
  stock: "stock_items",
};
export const BUILTINS = new Set([...Object.keys(CALL_LEVEL), "once"]);
const TX_START = new Set(["tenant", "begin"]);
const REGISTER = new Set(["register", "registerPreAuth"]);
const ROUTE_CALLS = new Set([
  "route",
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "use",
]);

export type LockEvent = {
  level: number;
  /** Table or key; an operation key is unique per event (never a free re-lock). */
  object: string;
  mode: "share" | "update" | "key";
  label: string;
  /** Call sites from the unit down to the function that takes the lock. */
  path: string[];
};
/** A unit's lock tree: events, alternatives, nested transactions and calls. */
export type Node =
  | { event: LockEvent }
  | { branch: Node[][] }
  | { tx: Node[] }
  | { call: string; site: string };
export type Unit = {
  file: string;
  name: string;
  /** Callable name in its file (functions and consts), for call resolution. */
  callable?: string;
  nodes: Node[];
};
export type Violation = {
  unit: string;
  pair: string;
  from: LockEvent;
  to: LockEvent;
};

const isFunctionLike = (node: ts.Node | undefined): boolean =>
  !!node &&
  (ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionDeclaration(node));

function containsFunction(node: ts.Node): boolean {
  if (isFunctionLike(node)) return true;
  return !!ts.forEachChild(
    node,
    (child) => containsFunction(child) || undefined,
  );
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** The SQL text of a template, and the same with its substitutions as source (for keys). */
function sqlText(template: ts.TemplateLiteral, sf: ts.SourceFile) {
  if (ts.isNoSubstitutionTemplateLiteral(template))
    return { sql: template.text, full: template.text };
  return {
    sql: [
      template.head.text,
      ...template.templateSpans.map((span) => span.literal.text),
    ].join(" $ "),
    full: [
      template.head.text,
      ...template.templateSpans.map(
        (span) => `\${${span.expression.getText(sf)}}${span.literal.text}`,
      ),
    ].join(""),
  };
}

const LOCK_CLAUSE =
  /\bfor\s+(no\s+key\s+update|update|key\s+share|share)\b(?:\s+of\s+([a-z_][a-z0-9_]*))?/i;

/** Lock events of one SQL statement (zero or one). */
export function sqlEvents(sql: string, full = sql): Omit<LockEvent, "path">[] {
  const text = sql.replace(/\s+/g, " ");
  const event = (
    table: string,
    mode: LockEvent["mode"],
    label: string,
  ): Omit<LockEvent, "path">[] => {
    const level = TABLE_LEVEL[table];
    return level === undefined ? [] : [{ level, object: table, mode, label }];
  };
  if (/pg_advisory_xact_lock\s*\(/i.test(text)) {
    // hashtextextended(<key>, <class>): the class decides the level.
    const seed = Number(
      /hashtextextended\(.*?,\s*(\d+)\s*\)\s*\)/i.exec(text)?.[1] ?? 0,
    );
    const named = /':floor'|':stock-items'|offline_prefix/.exec(full)?.[0];
    if (ORGANIZATION_CLASSES.has(seed))
      return [
        {
          level: LEVEL.organization,
          object: `key:${seed}:${full}`,
          mode: "key",
          label: `organization key ${seed}`,
        },
      ];
    if (seed !== 0 || named)
      return [
        {
          level: LEVEL.config,
          // One object per area key: taking it again is a free re-lock.
          object: `area:${named ?? seed}`,
          mode: "key",
          label: `area key ${named ?? seed}`,
        },
      ];
    const tender = /tenderId/.test(full);
    return [
      {
        level: tender ? LEVEL.tender : LEVEL.key,
        object: `key:${full}`,
        mode: "key",
        label: tender ? "tender key" : "operation key",
      },
    ];
  }
  const lock = LOCK_CLAUSE.exec(text);
  if (lock) {
    const mode = /update/i.test(lock[1]) ? "update" : "share";
    let table: string | undefined;
    if (lock[2]) {
      const alias = lock[2].toLowerCase();
      const aliased = new RegExp(
        `\\b(?:from|join)\\s+([a-z_][a-z0-9_]*)\\s+(?:as\\s+)?${alias}\\b`,
        "i",
      ).exec(text);
      table = (aliased?.[1] ?? alias).toLowerCase();
    } else
      table = /\bfrom\s+([a-z_][a-z0-9_]*)/i.exec(text)?.[1]?.toLowerCase();
    return table
      ? event(table, mode, `${table} for ${lock[1].toLowerCase()}`)
      : [];
  }
  const update = /^\s*(?:with\b.*?\)\s*)?update\s+([a-z_][a-z0-9_]*)/i.exec(
    text,
  );
  if (update) {
    const table = update[1].toLowerCase();
    return UPDATE_LOCKS.has(table)
      ? event(table, "update", `update ${table}`)
      : [];
  }
  const insert = /\binsert\s+into\s+([a-z_][a-z0-9_]*)/i.exec(text);
  if (insert) {
    const table = insert[1].toLowerCase();
    if (table === "stock_movements")
      return event("stock_items", "update", "insert into stock_movements");
    if (UPSERTED.has(table) && /on\s+conflict.*do\s+update/i.test(text))
      return event(table, "update", `upsert ${table}`);
  }
  return [];
}

/** The once() kinds that skip its restaurants FOR SHARE, read from server/orders.ts. */
export function onceExclusions(ordersSource: string): Set<string> {
  const body = ordersSource.slice(
    ordersSource.indexOf("export async function once"),
  );
  const condition = body.match(/if \(((?:kind !== "[^"]+"(?: && )?)+)\)/);
  return new Set(
    [...(condition?.[1] ?? "").matchAll(/kind !== "([^"]+)"/g)].map(
      (m) => m[1],
    ),
  );
}

type FileInfo = {
  units: Unit[];
  /** local name → [module file, exported name]; "*" for a namespace import. */
  imports: Map<string, [string, string]>;
  reexports: { from: string; names: Map<string, string> | "*" }[];
  aliasedBuiltins: string[];
  /** The local callable a named default export points at (`export default fn`). */
  defaultExport?: string;
};

/** A relative import resolved within the scanned files ("./x.js" → "<dir>/x.ts"). */
function resolveModule(
  from: string,
  spec: string,
  known: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(from), spec)).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, join(base, "index.ts")])
    if (known.has(candidate)) return candidate;
  return null;
}

/** A statement after which control never reaches the next one. */
function terminates(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement))
    return true;
  if (ts.isBlock(statement))
    return (
      statement.statements.length > 0 &&
      terminates(statement.statements[statement.statements.length - 1])
    );
  if (ts.isIfStatement(statement))
    return (
      !!statement.elseStatement &&
      terminates(statement.thenStatement) &&
      terminates(statement.elseStatement)
    );
  return false;
}

/** Parses one file into units (lock trees) and its import/export map. */
export function scanFile(
  fileName: string,
  source: string,
  excluded: Set<string>,
  known: ReadonlySet<string> = new Set(),
): FileInfo {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const info: FileInfo = {
    units: [],
    imports: new Map(),
    reexports: [],
    aliasedBuiltins: [],
  };
  const line = (n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const ev = (e: Omit<LockEvent, "path">): Node => ({
    event: { ...e, path: [] },
  });

  const statements = (list: readonly ts.Statement[]): Node[] => {
    const out: Node[] = [];
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      if (ts.isIfStatement(st)) {
        out.push(...collect(st.expression));
        const then = collect(st.thenStatement);
        if (st.elseStatement)
          out.push({ branch: [then, collect(st.elseStatement)] });
        else if (terminates(st.thenStatement)) {
          // Early return: the rest of the block is the other alternative.
          out.push({ branch: [then, statements(list.slice(i + 1))] });
          return out;
        } else out.push({ branch: [then, []] });
      } else if (ts.isSwitchStatement(st)) {
        out.push(...collect(st.expression));
        const cases = st.caseBlock.clauses.map((c) => statements(c.statements));
        if (!st.caseBlock.clauses.some(ts.isDefaultClause)) cases.push([]);
        out.push({ branch: cases });
      } else out.push(...collect(st));
    }
    return out;
  };

  const collect = (n: ts.Node): Node[] => {
    if (ts.isBlock(n) || ts.isSourceFile(n)) return statements(n.statements);
    if (isFunctionLike(n)) {
      const body = (n as ts.FunctionLikeDeclaration).body;
      if (!body) return [];
      return ts.isBlock(body) ? statements(body.statements) : collect(body);
    }
    if (ts.isConditionalExpression(n))
      return [
        ...collect(n.condition),
        { branch: [collect(n.whenTrue), collect(n.whenFalse)] },
      ];
    if (
      ts.isBinaryExpression(n) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(n.operatorToken.kind)
    )
      return [...collect(n.left), { branch: [collect(n.right), []] }];
    if (ts.isTaggedTemplateExpression(n)) {
      const { sql, full } = sqlText(n.template, sf);
      return sqlEvents(sql, full).map(ev);
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      const args = n.arguments.flatMap((a) => collect(a));
      if (name === "once") {
        const kind = n.arguments[3];
        const skipsShare =
          kind && ts.isStringLiteralLike(kind) && excluded.has(kind.text);
        return [
          ev({
            level: LEVEL.key,
            object: `key:once@${fileName}:${line(n)}`,
            mode: "key",
            label: "once()",
          }),
          ...(skipsShare
            ? []
            : [
                ev({
                  level: LEVEL.restaurants,
                  object: "restaurants",
                  mode: "share",
                  label: "once() restaurants for share",
                }),
              ]),
          ...args,
        ];
      }
      if (name && Object.hasOwn(CALL_LEVEL, name))
        return [
          ...args,
          ev({
            level: CALL_LEVEL[name],
            object: CALL_OBJECT[name],
            mode: "update",
            label: `${name}()`,
          }),
        ];
      if (name && TX_START.has(name)) return [{ tx: args }];
      if (name === "unsafe")
        return n.arguments.flatMap((a) =>
          ts.isStringLiteralLike(a) ? sqlEvents(a.text).map(ev) : collect(a),
        );
      const call = ts.isIdentifier(n.expression)
        ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression)
          ? `${n.expression.expression.text}.${n.expression.name.text}`
          : null;
      // Arguments run first (callbacks they define run inside the call, which
      // the expansion places after them: the callee's own locks come first in
      // the cases that matter, a helper that locks and then calls back).
      return call
        ? [{ call, site: `${fileName}:${line(n)}` }, ...args]
        : [...collect(n.expression), ...args];
    }
    const out: Node[] = [];
    ts.forEachChild(n, (child) => {
      out.push(...collect(child));
    });
    return out;
  };

  const add = (name: string, node: ts.Node, callable?: string) =>
    info.units.push({ file: fileName, name, callable, nodes: collect(node) });
  const routeName = (
    statement: ts.Statement,
    anyCall: boolean,
  ): string | null => {
    if (!ts.isExpressionStatement(statement)) return null;
    const call = statement.expression;
    if (
      !ts.isCallExpression(call) ||
      !call.arguments.some((a) => isFunctionLike(a))
    )
      return null;
    // Inside an ordinary function only Express-style registrations split off
    // (app.post(…), router.get(…), route(…)); once(…) and the like stay inline.
    if (!anyCall && !ROUTE_CALLS.has(calleeName(call.expression) ?? ""))
      return null;
    const strings = call.arguments
      .filter(ts.isStringLiteralLike)
      .map((a) => a.text);
    const callee = calleeName(call.expression) ?? "call";
    if (strings.length >= 2) return `${strings[0]} ${strings[1]}`;
    if (strings.length === 1) return `${callee} ${strings[0]}`;
    return `${callee} :${line(call)}`;
  };
  const objectUnits = (prefix: string, object: ts.ObjectLiteralExpression) => {
    for (const p of object.properties) {
      const key =
        p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))
          ? p.name.text
          : null;
      if (!key) continue;
      if (ts.isMethodDeclaration(p)) add(`${prefix}.${key}`, p);
      else if (ts.isPropertyAssignment(p) && containsFunction(p.initializer))
        add(`${prefix}.${key}`, p.initializer);
    }
  };

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const target = resolveModule(
        fileName,
        (statement.moduleSpecifier as ts.StringLiteral).text,
        known,
      );
      const clause = statement.importClause;
      if (!target || !clause || clause.isTypeOnly) continue;
      if (clause.name) info.imports.set(clause.name.text, [target, "default"]);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        info.imports.set(bindings.name.text, [target, "*"]);
      else if (bindings)
        for (const el of bindings.elements) {
          const exported = (el.propertyName ?? el.name).text;
          info.imports.set(el.name.text, [target, exported]);
          if (el.propertyName && BUILTINS.has(exported))
            info.aliasedBuiltins.push(
              `${fileName}: ${exported} as ${el.name.text}`,
            );
        }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      // export { fn as default }
      for (const el of statement.exportClause.elements)
        if (el.name.text === "default")
          info.defaultExport = (el.propertyName ?? el.name).text;
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      // export default fn; export default async (tx) => …
      const e = statement.expression;
      if (ts.isIdentifier(e)) info.defaultExport = e.text;
      else if (containsFunction(e)) add("default", e, "default");
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const target = resolveModule(
        fileName,
        (statement.moduleSpecifier as ts.StringLiteral).text,
        known,
      );
      if (!target) continue;
      const clause = statement.exportClause;
      if (!clause) info.reexports.push({ from: target, names: "*" });
      else if (ts.isNamedExports(clause)) {
        info.reexports.push({
          from: target,
          names: new Map(
            clause.elements.map((el) => [
              el.name.text,
              (el.propertyName ?? el.name).text,
            ]),
          ),
        });
        for (const el of clause.elements)
          if (el.propertyName && BUILTINS.has(el.propertyName.text))
            info.aliasedBuiltins.push(
              `${fileName}: re-exports ${el.propertyName.text} as ${el.name.text}`,
            );
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.body) {
      const name = statement.name?.text ?? "default";
      // export default function fn(…): importers ask for "default".
      if (
        name !== "default" &&
        statement.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
        )
      )
        info.defaultExport = name;
      // One unit per route registration in the body (every request is its own
      // transaction), the rest as the function's unit. register/registerPreAuth
      // bodies hold nothing but registrations.
      const rest: ts.Statement[] = [];
      for (const inner of statement.body.statements) {
        const route = routeName(inner, REGISTER.has(name));
        if (route) add(route, inner);
        else rest.push(inner);
      }
      if (rest.length === statement.body.statements.length)
        add(name, statement, name);
      else
        info.units.push({
          file: fileName,
          name,
          callable: name,
          nodes: statements(rest),
        });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      for (const member of statement.members)
        if (
          member.name &&
          ts.isIdentifier(member.name) &&
          (ts.isMethodDeclaration(member) ||
            (ts.isPropertyDeclaration(member) &&
              member.initializer &&
              containsFunction(member.initializer)))
        )
          add(`${statement.name.text}.${member.name.text}`, member);
    } else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = d.initializer;
        if (ts.isObjectLiteralExpression(init)) objectUnits(d.name.text, init);
        else if (containsFunction(init)) add(d.name.text, init, d.name.text);
      }
    } else if (ts.isExpressionStatement(statement)) {
      const e = statement.expression;
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(e.left)
      ) {
        if (ts.isObjectLiteralExpression(e.right))
          objectUnits(e.left.getText(sf), e.right);
        else if (containsFunction(e.right)) add(e.left.getText(sf), e.right);
      } else {
        const route = routeName(statement, true);
        if (route) add(route, statement);
      }
    }
  }
  return info;
}

export type Program = {
  units: Unit[];
  /** The unit's lock tree with calls expanded (events carry their call path). */
  expand(unit: Unit): Node[];
  aliasedBuiltins: string[];
};

/** Builds the call graph over a set of files. */
export function program(
  files: Map<string, string>,
  excluded: Set<string>,
): Program {
  const infos = new Map<string, FileInfo>();
  const known = new Set(files.keys());
  for (const [file, source] of files)
    infos.set(file, scanFile(file, source, excluded, known));
  const callables = new Map<string, Unit>();
  for (const info of infos.values())
    for (const unit of info.units)
      if (unit.callable) callables.set(`${unit.file}#${unit.callable}`, unit);

  const exported = (file: string, name: string, depth = 0): Unit | null => {
    if (depth > 10) return null;
    const own = callables.get(`${file}#${name}`);
    if (own) return own;
    const info = infos.get(file);
    if (!info) return null;
    if (name === "default" && info.defaultExport)
      return exported(file, info.defaultExport, depth + 1);
    for (const r of info.reexports) {
      if (r.names === "*") {
        const hit = exported(r.from, name, depth + 1);
        if (hit) return hit;
      } else if (r.names.has(name))
        return exported(r.from, r.names.get(name)!, depth + 1);
    }
    const imported = info.imports.get(name);
    if (imported && imported[1] !== "*")
      return exported(imported[0], imported[1], depth + 1);
    return null;
  };
  const resolve = (unit: Unit, call: string): Unit | null => {
    const info = infos.get(unit.file)!;
    const [head, member] = call.split(".");
    if (member !== undefined) {
      const ns = info.imports.get(head);
      return ns && ns[1] === "*" ? exported(ns[0], member) : null;
    }
    if (BUILTINS.has(head) || TX_START.has(head)) return null;
    const local = callables.get(`${unit.file}#${head}`);
    if (local) return local;
    const imported = info.imports.get(head);
    return imported && imported[1] !== "*"
      ? exported(imported[0], imported[1])
      : null;
  };

  const prefixed = (nodes: Node[], site: string): Node[] =>
    nodes.map((n) =>
      "event" in n
        ? { event: { ...n.event, path: [site, ...n.event.path] } }
        : "branch" in n
          ? { branch: n.branch.map((alt) => prefixed(alt, site)) }
          : "tx" in n
            ? { tx: prefixed(n.tx, site) }
            : n,
    );
  const memo = new Map<Unit, Node[]>();
  const expandNodes = (unit: Unit, nodes: Node[], stack: Set<Unit>): Node[] =>
    nodes.flatMap((n): Node[] => {
      if ("call" in n) {
        const target = resolve(unit, n.call);
        if (!target || target === unit || stack.has(target)) return [];
        return prefixed(expandUnit(target, stack), `${n.call}@${n.site}`);
      }
      if ("branch" in n)
        return [
          { branch: n.branch.map((alt) => expandNodes(unit, alt, stack)) },
        ];
      if ("tx" in n) return [{ tx: expandNodes(unit, n.tx, stack) }];
      return [n];
    });
  const expandUnit = (unit: Unit, stack = new Set<Unit>()): Node[] => {
    const cached = memo.get(unit);
    if (cached) return cached;
    stack.add(unit);
    const out = expandNodes(unit, unit.nodes, stack);
    stack.delete(unit);
    // A result cut short by a cycle is not cached (another entry point sees more).
    if (stack.size === 0) memo.set(unit, out);
    return out;
  };
  return {
    units: [...infos.values()].flatMap((i) => i.units),
    expand: (unit) => expandUnit(unit),
    aliasedBuiltins: [...infos.values()].flatMap((i) => i.aliasedBuiltins),
  };
}

type State = {
  max: LockEvent | null;
  held: Map<string, LockEvent["mode"]>;
  shared: Map<string, LockEvent>;
};
const freshState = (): State => ({
  max: null,
  held: new Map(),
  shared: new Map(),
});
const cloneState = (s: State): State => ({
  max: s.max,
  held: new Map(s.held),
  shared: new Map(s.shared),
});

/**
 * Level-monotonic check of one unit's expanded tree: a lock below the transaction's
 * highest level so far is a step back ("<from>><to>") unless the object is already held;
 * a table held FOR SHARE and then locked for update is an "upgrade:<table>". A pair whose
 * two events both come from one call site of the unit is that callee's violation.
 */
export function violations(unitName: string, nodes: Node[]): Violation[] {
  const out: Violation[] = [];
  const sameCallee = (a: LockEvent, b: LockEvent) =>
    a.path.length > 0 && b.path.length > 0 && a.path[0] === b.path[0];
  const walk = (list: Node[], state: State): State => {
    for (const n of list) {
      if ("tx" in n) {
        walk(n.tx, freshState());
        continue;
      }
      if ("branch" in n) {
        const ends = n.branch.map((alt) => walk(alt, cloneState(state)));
        const merged = cloneState(state);
        for (const end of ends) {
          if (end.max && (!merged.max || end.max.level > merged.max.level))
            merged.max = end.max;
          for (const [object, mode] of end.held)
            if (merged.held.get(object) !== "update")
              merged.held.set(object, mode);
          for (const [object, e] of end.shared)
            if (!merged.shared.has(object)) merged.shared.set(object, e);
        }
        state = merged;
        continue;
      }
      if ("call" in n) continue;
      const e = n.event;
      const heldMode = state.held.get(e.object);
      if (heldMode !== undefined) {
        if (heldMode === "share" && e.mode === "update") {
          const first = state.shared.get(e.object)!;
          if (!sameCallee(first, e))
            out.push({
              unit: unitName,
              pair: `upgrade:${e.object}`,
              from: first,
              to: e,
            });
          state.held.set(e.object, "update");
        }
        continue;
      }
      if (state.max && e.level < state.max.level && !sameCallee(state.max, e))
        out.push({
          unit: unitName,
          pair: `${levelLabel(state.max.level)}>${levelLabel(e.level)}`,
          from: state.max,
          to: e,
        });
      state.held.set(e.object, e.mode);
      if (e.mode === "share") state.shared.set(e.object, e);
      if (!state.max || e.level > state.max.level) state.max = e;
    }
    return state;
  };
  walk(nodes, freshState());
  return out;
}

/** The events of a tree in order, alternatives flattened (for tests and messages). */
export function flatten(nodes: Node[]): LockEvent[] {
  return nodes.flatMap((n) =>
    "event" in n
      ? [n.event]
      : "branch" in n
        ? n.branch.flatMap(flatten)
        : "tx" in n
          ? flatten(n.tx)
          : [],
  );
}

export function serverFiles(dir = "server"): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return serverFiles(path);
      return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
    });
}

/** Every violation in a set of sources, one per (unit, pair), sorted by key. */
export function scanSources(
  files: Map<string, string>,
  excluded: Set<string>,
): { found: Map<string, Violation>; program: Program } {
  const p = program(files, excluded);
  const found = new Map<string, Violation>();
  for (const unit of p.units)
    for (const v of violations(unit.name, p.expand(unit))) {
      const key = `${unit.file}#${unit.name}:${v.pair}`;
      if (!found.has(key)) found.set(key, v);
    }
  return {
    found: new Map([...found].sort(([a], [b]) => a.localeCompare(b))),
    program: p,
  };
}

/** Scans server/**\/*.ts. */
export function scanServer() {
  const files = new Map(serverFiles().map((f) => [f, readFileSync(f, "utf8")]));
  return scanSources(
    files,
    onceExclusions(files.get("server/orders.ts") ?? ""),
  );
}

/** One line per violation, for failure messages. */
export function explain(key: string, v: Violation): string {
  const where = (e: LockEvent) =>
    `${e.label}${e.path.length ? ` via ${e.path.join(" > ")}` : ""}`;
  return `${key}: ${where(v.from)} THEN ${where(v.to)}`;
}
