/**
 * Global lock order ratchet (platform §6.2, docs/ARCHITECTURE.md "Global lock order").
 *
 * A static scan of every server/**\/*.ts with the TypeScript compiler API (parse only, no
 * type checking, no regex over source text). It sees direct calls only; indirect sequences
 * (offline sync through createOrder and recordPayment) are covered by DB tests (fiscal DB 28,
 * discounts DB 22; risk R12).
 *
 * Units: every top-level function declaration and top-level `const` initialised with a
 * function; every top-level `X.y = <function>` assignment (the offline appliers); every
 * top-level expression statement, and every expression statement directly inside a top-level
 * register/registerPreAuth body, that is a call with a function argument (route
 * registrations, named "<verb> <path>"). Calls inside nested callbacks (once(…), tenant(…),
 * .map(…)) belong to the enclosing unit, in source order.
 *
 * Events: calls named bumpKitchenFeed (feed), refreshCheckState or issueDueTicket (issue),
 * drawer (drawer), lockStockItems or stock (stock); tagged templates locking cash_sessions
 * FOR UPDATE (drawer) or rounds FOR UPDATE (rounds).
 *
 * Rules:
 *   A  every refresh/issue comes after the first feed (LO-R3);
 *   B  the first drawer lock comes after the last feed (LO-R3);
 *   C  after the first refresh/issue, no feed, drawer or stock follows (LO-R4);
 *   D  after the first stock event, no rounds FOR UPDATE follows (LO-7 before LO-9).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

type Kind = "feed" | "issue" | "drawer" | "stock" | "rounds";
type Rule = "A" | "B" | "C" | "D";
type Unit = { name: string; events: { kind: Kind; at: number }[] };

/**
 * Allowed violations, keyed by (unit, rule). A listed entry that no longer violates fails
 * the test, so stale entries cannot stay.
 */
// Fiscal (027) reorders these call sites (feed before refresh) and deletes these entries
// in the same commit (platform §6.2 rows 1, 6 and 8).
const FISCAL_REORDER = [
  "server/orders.ts#createOrder:A",
  "server/orders.ts#createOrder:C",
  "server/voids.ts#voidLines:A",
  "server/voids.ts#voidLines:C",
  "server/service.ts#assignService:A",
  "server/service.ts#assignService:C",
];
// Permanent, sanctioned exception (LD-11 MENU-INT-5): voids with stock return lock stock
// rows before rounds rows; no cycle, because rounds are only locked under their order's
// LO-5 lock.
const PERMANENT = ["server/voids.ts#voidLines:D"];
const ALLOWLIST = [...FISCAL_REORDER, ...PERMANENT];

const CALL_EVENTS: Record<string, Kind> = {
  bumpKitchenFeed: "feed",
  refreshCheckState: "issue",
  issueDueTicket: "issue",
  drawer: "drawer",
  lockStockItems: "stock",
  stock: "stock",
};
const DRAWER_LOCK = /cash_sessions[\s\S]*\bfor\s+update\b/i;
const ROUNDS_LOCK = /\brounds\b[\s\S]*\bfor\s+update\b/i;
const REGISTER = new Set(["register", "registerPreAuth"]);

const isFunction = (
  node: ts.Node | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression =>
  !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function templateText(template: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  return [
    template.head.text,
    ...template.templateSpans.map((span) => span.literal.text),
  ].join(" $ ");
}

/** Every event in a subtree, in source order. */
function eventsIn(node: ts.Node, sf: ts.SourceFile): Unit["events"] {
  const events: Unit["events"] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      const kind =
        name && Object.hasOwn(CALL_EVENTS, name) && CALL_EVENTS[name];
      if (kind) events.push({ kind, at: n.getStart(sf) });
    } else if (ts.isTaggedTemplateExpression(n)) {
      const text = templateText(n.template);
      if (DRAWER_LOCK.test(text))
        events.push({ kind: "drawer", at: n.getStart(sf) });
      if (ROUNDS_LOCK.test(text))
        events.push({ kind: "rounds", at: n.getStart(sf) });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return events.sort((a, b) => a.at - b.at);
}

/** A call with a function argument (a route registration), named "<verb> <path>". */
function routeName(statement: ts.Statement, sf: ts.SourceFile): string | null {
  if (!ts.isExpressionStatement(statement)) return null;
  const call = statement.expression;
  if (!ts.isCallExpression(call) || !call.arguments.some((a) => isFunction(a)))
    return null;
  const strings = call.arguments
    .filter(ts.isStringLiteralLike)
    .map((a) => a.text);
  const callee = calleeName(call.expression) ?? "call";
  if (strings.length >= 2) return `${strings[0]} ${strings[1]}`;
  if (strings.length === 1) return `${callee} ${strings[0]}`;
  const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1;
  return `${callee} :${line}`;
}

/** The units of one source file (see the header). */
function scanUnits(fileName: string, source: string): Unit[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const units: Unit[] = [];
  const add = (name: string, node: ts.Node) =>
    units.push({ name, events: eventsIn(node, sf) });
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const name = statement.name?.text ?? "default";
      if (!REGISTER.has(name)) {
        add(name, statement);
        continue;
      }
      // register/registerPreAuth: one unit per route registration, the rest as one unit.
      const rest: ts.Statement[] = [];
      for (const inner of statement.body.statements) {
        const route = routeName(inner, sf);
        if (route) add(route, inner);
        else rest.push(inner);
      }
      units.push({
        name,
        events: rest
          .flatMap((s) => eventsIn(s, sf))
          .sort((a, b) => a.at - b.at),
      });
    } else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations)
        if (ts.isIdentifier(d.name) && isFunction(d.initializer))
          add(d.name.text, d.initializer);
    } else if (ts.isExpressionStatement(statement)) {
      const e = statement.expression;
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(e.left) &&
        isFunction(e.right)
      )
        add(e.left.getText(sf), e.right);
      else {
        const route = routeName(statement, sf);
        if (route) add(route, statement);
      }
    }
  }
  return units;
}

/** The rules a unit breaks. */
function violations(unit: Unit): Rule[] {
  const at = (kinds: Kind[]) =>
    unit.events.filter((e) => kinds.includes(e.kind)).map((e) => e.at);
  const feeds = at(["feed"]);
  const issues = at(["issue"]);
  const drawers = at(["drawer"]);
  const stocks = at(["stock"]);
  const rounds = at(["rounds"]);
  const out: Rule[] = [];
  if (feeds.length && issues.some((i) => i < feeds[0])) out.push("A");
  if (feeds.length && drawers.length && drawers[0] < feeds.at(-1)!)
    out.push("B");
  if (
    issues.length &&
    at(["feed", "drawer", "stock"]).some((e) => e > issues[0])
  )
    out.push("C");
  if (stocks.length && rounds.some((r) => r > stocks[0])) out.push("D");
  return out;
}

function scan(fileName: string, source: string): string[] {
  return scanUnits(fileName, source).flatMap((unit) =>
    violations(unit).map((rule) => `${fileName}#${unit.name}:${rule}`),
  );
}

function serverFiles(dir = "server"): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return serverFiles(path);
      return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
    });
}

describe("global lock order ratchet (platform §6.2, critic #9)", () => {
  it("server/**/*.ts violates rules A-D only where the allowlist says so, and every allowlist entry still violates", () => {
    const files = serverFiles();
    expect(files).toContain("server/orders.ts");
    expect(files).toContain("server/offline-tables.ts");
    const found = files
      .flatMap((file) => scan(file, readFileSync(file, "utf8")))
      .sort();
    const unexpected = found.filter((v) => !ALLOWLIST.includes(v));
    const stale = ALLOWLIST.filter((v) => !found.includes(v));
    expect(
      unexpected,
      "new lock-order violations (docs/ARCHITECTURE.md: name the sequence; never allowlist silently)",
    ).toEqual([]);
    expect(
      stale,
      "allowlist entries that no longer violate: delete them",
    ).toEqual([]);
  });

  it("scans the offline appliers, route registrations and the money commands as units", () => {
    const units = (file: string) =>
      scanUnits(file, readFileSync(file, "utf8")).map((u) => u.name);
    expect(units("server/offline-tables.ts")).toEqual(
      expect.arrayContaining([
        "appliers.order",
        "appliers.round",
        "appliers.payment",
        "reconcilers.payment",
      ]),
    );
    expect(units("server/orders.ts")).toEqual(
      expect.arrayContaining(["createOrder", "addRound", "recordPayment"]),
    );
    expect(units("server/routes/service.ts")).toEqual(
      expect.arrayContaining(["post /service/orders/:id/close"]),
    );
    expect(units("server/index.ts")).toEqual(
      expect.arrayContaining(["post /api/orders/:id/voids"]),
    );
    // The scanner sees the events of a conforming money command.
    const payment = scanUnits(
      "server/orders.ts",
      readFileSync("server/orders.ts", "utf8"),
    ).find((u) => u.name === "recordPayment")!;
    expect(payment.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["drawer", "issue"]),
    );
    expect(violations(payment)).toEqual([]);
  });

  it("finds each rule's violation in a synthetic source, including one hidden inside a once() callback", () => {
    const source = `
      export async function feedAfterRefresh(tx, s) {
        await refreshCheckState(tx, s, id);
        await bumpKitchenFeed(tx, s);
      }
      export async function drawerBeforeFeed(tx, s) {
        await drawer(tx, s);
        await bumpKitchenFeed(tx, s);
      }
      export const stockAfterIssue = async (tx, s) => {
        await issueDueTicket(tx, s, id);
        await lockStockItems(tx, ids);
      };
      export async function roundsAfterStock(tx, s) {
        await lockStockItems(tx, ids);
        await tx\`select id from rounds where order_id=\${id} for update\`;
      }
      export async function hidden(tx, s, raw) {
        return once(tx, s, key, "kind", raw, async () => {
          await tx\`select id from cash_sessions where id=\${d} for update\`;
          await Promise.all([1].map(async () => bumpKitchenFeed(tx, s)));
        });
      }
      export function conforming(tx, s) {
        return once(tx, s, key, "kind", raw, async () => {
          await tx\`select id from rounds where id=\${r} for update\`;
          await stock(tx, s, item);
          await bumpKitchenFeed(tx, s);
          await tx\`select * from cash_sessions where id=\${d} for update\`;
          await refreshCheckState(tx, s, id);
        });
      }
    `;
    expect(scan("fixture.ts", source).sort()).toEqual([
      "fixture.ts#drawerBeforeFeed:B",
      "fixture.ts#feedAfterRefresh:A",
      "fixture.ts#feedAfterRefresh:C",
      "fixture.ts#hidden:B",
      "fixture.ts#roundsAfterStock:D",
      "fixture.ts#stockAfterIssue:C",
    ]);
  });

  it("two route registrations in one register body are separate units: calls that would violate only if merged are not reported", () => {
    const source = `
      export function register({ app, route }) {
        const limiter = rateLimit({});
        route("post", "/a", (tx, s) => refreshCheckState(tx, s, id));
        route("post", "/b", async (tx, s) => { await bumpKitchenFeed(tx, s); });
        app.post("/api/c", async (req, res) => { await drawer(tx, s); });
        app.post("/api/d", async (req, res) => { await bumpKitchenFeed(tx, s); await refreshCheckState(tx, s, id); });
      }
      app.get("/api/e", async () => { await refreshCheckState(tx, s, id); await bumpKitchenFeed(tx, s); });
    `;
    const units = scanUnits("routes.ts", source);
    expect(units.map((u) => u.name)).toEqual([
      "post /a",
      "post /b",
      "post /api/c",
      "post /api/d",
      "register",
      "get /api/e",
    ]);
    expect(scan("routes.ts", source)).toEqual([
      "routes.ts#get /api/e:A",
      "routes.ts#get /api/e:C",
    ]);
  });

  it("an assignment unit (appliers.x = async …) is scanned", () => {
    const source = `
      const appliers = {};
      appliers.sale = async (tx, s, record) => {
        await refreshCheckState(tx, s, id);
        await tx\`select id from cash_sessions where device_id=\${d} for update\`;
      };
      appliers.ok = async function (tx, s) { await drawer(tx, s); await refreshCheckState(tx, s, id); };
      handlers.notAFunction = 3;
    `;
    expect(scanUnits("appliers.ts", source).map((u) => u.name)).toEqual([
      "appliers.sale",
      "appliers.ok",
    ]);
    expect(scan("appliers.ts", source)).toEqual([
      "appliers.ts#appliers.sale:C",
    ]);
  });

  it("declarations are not calls, and unrelated templates are not locks", () => {
    const source = `
      export async function drawer(tx, s) { return tx\`select * from cash_sessions where open\`; }
      export async function stock(tx, s) { return 1; }
      export async function readOnly(tx, s) {
        await refreshCheckState(tx, s, id);
        await tx\`select * from rounds where id=\${r}\`;
        await tx\`select * from orders where id=\${o} for update\`;
      }
    `;
    expect(scan("decl.ts", source)).toEqual([]);
  });

  it("the permanent voidLines:D entry survives fiscal deleting the A and C entries of the same unit", () => {
    // voidLines after fiscal's reorder (feed before refresh): only rule D remains.
    const reordered = `
      export async function voidLines(tx, s, orderId, raw) {
        return once(tx, s, key, "order.void", raw, async () => {
          await tx\`select * from orders where id=\${orderId} for update\`;
          await lockStockItems(tx, ids);
          await tx\`select * from rounds where order_id=\${orderId} and number=\${n} for update\`;
          await stock(tx, s, item);
          await bumpKitchenFeed(tx, s);
          await refreshCheckState(tx, s, orderId);
        });
      }
    `;
    const found = scan("server/voids.ts", reordered);
    expect(found).toEqual(["server/voids.ts#voidLines:D"]);
    const afterFiscal = ALLOWLIST.filter((e) => !FISCAL_REORDER.includes(e));
    expect(found.filter((v) => !afterFiscal.includes(v))).toEqual([]);
    expect(afterFiscal).toEqual(PERMANENT);
  });
});
