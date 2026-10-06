/**
 * Global lock order ratchet (platform §6.2, docs/ARCHITECTURE.md "Global lock order").
 *
 * tests/lock-scan.ts parses every server/**\/*.ts, expands calls transitively and checks
 * that, inside one transaction, LO levels never step back (LO-R1) and no table locked FOR
 * SHARE is later locked for update (LO-R6). Its header lists exactly what it sees and what
 * it does not (DB tests and tests/db-retries.ts stay the dynamic guard: LO-R9).
 *
 * Every violation of the current code is listed below, keyed by (unit, level pair), with
 * its reason. A new violation fails the test, and so does a listed entry that no longer
 * violates. A new command never adds an entry silently: it conforms, or it names its
 * sequence and a sanctioned exception in docs/ARCHITECTURE.md first (PLATFORM-LOCKS-1/2).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  explain,
  flatten,
  levelLabel,
  onceExclusions,
  scanServer,
  scanSources,
  sqlEvents,
} from "./lock-scan.js";

// Fiscal (027) reorders these call sites (feed before refresh: platform §6.2 rows 1, 6
// and 8) and deletes these three entries in the same commit.
const FISCAL_REORDER: Record<string, string> = {
  "server/orders.ts#createOrder:12>10": "row 1: refresh before the feed",
  "server/voids.ts#voidLines:12>10": "row 6: refresh before the feed",
  "server/service.ts#assignService:12>10": "row 8: refresh before the feed",
};

// Permanent, sanctioned exceptions (docs/ARCHITECTURE.md "Global lock order"); none can
// close a cycle, for the reason given.
const PERMANENT: Record<string, string> = {
  // E2 (LD-14 OQ-1): tables FOR SHARE after the order; floor edits lock no orders.
  "server/service.ts#assignService:5a>3": "E2",
  // E3 (LD-11 MENU-INT-5): stock before the round rows; rounds are locked only under
  // their order's LO-5 lock, which the void holds.
  "server/voids.ts#voidLines:9>7": "E3",
  // E4 (LD-14 OQ-3): offline review placement updates rounds this transaction inserted.
  "server/offline-sync.ts#applySale:12>7": "E4",
  "server/offline-tables.ts#appliers.order:12>7": "E4",
  "server/offline-tables.ts#appliers.round:12>7": "E4",
  // E5: a refresh that cannot issue. createOrder's (nothing is paid at creation) and
  // applyRound's (a check that takes rounds is not paid: LD-15 fiscal Q2) take no folio
  // lock; what follows them is the order row this transaction inserted (applySale), the
  // drawer and the kitchen feed.
  "server/orders.ts#addRound:12>10": "E5",
  "server/offline-sync.ts#applySale:12>11": "E5",
  "server/offline-sync.ts#applySale:12>5":
    "E5 (and the row was inserted by this transaction)",
  // E6: financial recovery after a target lookup. Recovery's new order takes an order
  // number (LO-4) after the lookup locked a cancelled online order (reconcileSale) or
  // nothing (an unresolvable target); no transaction locks order_numbers and then an
  // existing order.
  "server/offline-sync.ts#reconcileSale:5>4": "E6",
  "server/offline-tables.ts#reconcilers.payment:5>4": "E6",
  // LO-R5: nested operation keys, fresh or the key of the record the command acts on.
  "server/checks.ts#recordSettlement:5>1":
    "LO-R5 fresh key (recordPayment(randomUUID()))",
  "server/offline-sync.ts#applySale:12>1": "LO-R5 fresh key (newTender)",
  "server/offline-tables.ts#appliers.payment:5>1":
    "LO-R5 fresh key (newTender)",
  // The nested once() re-takes restaurants FOR SHARE, which the sync caller already
  // holds (evaluateEvidence); the unit alone does not show that.
  "server/offline-tables.ts#appliers.payment:5>2":
    "LO-R5 (restaurants held by syncOfflineRecord)",
  "server/offline-attempts.ts#resolvePaymentAttempt:2>1":
    "LO-R5 the attempt's own payment key",
  "server/offline-sync.ts#archiveOfflineRecord:2>1":
    "LO-R5 the archived record's key",
  "server/offline-sync.ts#resolveOrCreateOrder:3>1":
    "LO-R5 createOrder(order.operationId)",
  "server/offline-sync.ts#resolveOrCreateOrder:3>2":
    "LO-R5 (restaurants held by syncOfflineRecord)",
  "server/offline-sync.ts#reconcileSale:5>1":
    "LO-R5 financialRecovery re-takes the draft's order key reconcileSale took first",
  "server/offline-tables.ts#reconcilers.payment:5>1":
    "LO-R5 the order's key, only when paymentTarget locked nothing (unresolvable)",
};
const ALLOWLIST = { ...FISCAL_REORDER, ...PERMANENT };

/** Scans in-memory sources (fixtures), with orders.ts's real once() exclusions. */
const excluded = onceExclusions(readFileSync("server/orders.ts", "utf8"));
const scan = (files: Record<string, string>) =>
  [
    ...scanSources(new Map(Object.entries(files)), excluded).found.keys(),
  ].sort();

describe("global lock order ratchet (platform §6.2, critic #9, PLATFORM-LOCKS-1/2)", () => {
  const { found, program } = scanServer();

  it("server/**/*.ts steps back only where the allowlist says so, and every allowlist entry still violates", () => {
    const keys = [...found.keys()];
    const unexpected = keys
      .filter((k) => !Object.hasOwn(ALLOWLIST, k))
      .map((k) => explain(k, found.get(k)!));
    const stale = Object.keys(ALLOWLIST).filter((k) => !found.has(k));
    expect(
      unexpected,
      "new lock-order violations (docs/ARCHITECTURE.md: name the sequence; never allowlist silently)",
    ).toEqual([]);
    expect(
      stale,
      "allowlist entries that no longer violate: delete them",
    ).toEqual([]);
    // Every entry names its reason.
    for (const [key, reason] of Object.entries(ALLOWLIST))
      expect(reason, key).toMatch(/^(E\d|LO-R\d|row \d)/);
  });

  it("no builtin lock function is imported or re-exported under another name", () => {
    expect(program.aliasedBuiltins).toEqual([]);
  });

  it("scans route registrations, appliers and the money commands as units, and sees their locks", () => {
    const names = new Set(program.units.map((u) => `${u.file}#${u.name}`));
    for (const unit of [
      "server/offline-tables.ts#appliers.order",
      "server/offline-tables.ts#appliers.round",
      "server/offline-tables.ts#appliers.payment",
      "server/offline-tables.ts#reconcilers.payment",
      "server/orders.ts#createOrder",
      "server/orders.ts#addRound",
      "server/orders.ts#recordPayment",
      "server/routes/service.ts#post /service/orders/:id/close",
      "server/index.ts#post /api/orders/:id/voids",
      "server/routes/ops.ts#post /jobs/:id/cancel",
    ])
      expect(names, unit).toContain(unit);
    const levels = (name: string) =>
      flatten(
        program.expand(
          program.units.find((u) => `${u.file}#${u.name}` === name)!,
        ),
      ).map((e) => levelLabel(e.level));
    // recordPayment: once (1, 2) → order (5) → drawer (11) → refresh (12).
    expect(levels("server/orders.ts#recordPayment")).toEqual([
      "1",
      "2",
      "5",
      "11",
      "12",
    ]);
    // A route sees its command's locks through the call (transitive expansion).
    expect(
      levels("server/routes/service.ts#post /service/orders/:id/close"),
    ).toEqual(expect.arrayContaining(["1", "2", "5"]));
    // The D20 fix holds: no SHARE->UPDATE upgrade anywhere.
    expect([...found.keys()].filter((k) => k.includes("upgrade:"))).toEqual([]);
    expect(excluded).toEqual(new Set(["restaurant.settings", "stock.policy"]));
  });
});

describe("the scanner finds what the rules forbid (fixtures)", () => {
  it("LOCKS-1: a lock below the highest level so far is a step back, for every pair the old rules missed", () => {
    const found = scan({
      "f.ts": `
        export async function feedThenStock(tx, s) {
          await bumpKitchenFeed(tx, s);
          await lockStockItems(tx, ids);
        }
        export async function feedThenRounds(tx, s) {
          await bumpKitchenFeed(tx, s);
          await tx\`select id from rounds where order_id=\${id} for update\`;
        }
        export async function feedThenOrders(tx, s) {
          await bumpKitchenFeed(tx, s);
          await tx\`select * from orders where id=\${id} for update\`;
        }
        export async function drawerThenStock(tx, s) {
          await drawer(tx, s);
          await stock(tx, s, item);
        }
        export async function drawerThenOrders(tx, s) {
          await tx\`select * from cash_sessions where id=\${d} for update\`;
          await tx\`select * from orders where id=\${id} for no key update\`;
        }
        export async function refreshThenFeed(tx, s) {
          await refreshCheckState(tx, s, id);
          await bumpKitchenFeed(tx, s);
        }
        export async function roundsAfterStock(tx, s) {
          await lockStockItems(tx, ids);
          await tx\`select id from rounds where order_id=\${id} for update\`;
        }
        export function conforming(tx, s, key, raw) {
          return once(tx, s, key, "order.kind", raw, async () => {
            await tx\`select * from orders where id=\${id} for update\`;
            await tx\`select id from employees where id=\${a} for share\`;
            await tx\`select id from rounds where id=\${r} for update\`;
            await stock(tx, s, item);
            await bumpKitchenFeed(tx, s);
            await tx\`select * from cash_sessions where id=\${d} for update\`;
            await refreshCheckState(tx, s, id);
          });
        }
      `,
    });
    expect(found).toEqual([
      "f.ts#drawerThenOrders:11>5",
      "f.ts#drawerThenStock:11>9",
      "f.ts#feedThenOrders:10>5",
      "f.ts#feedThenRounds:10>7",
      "f.ts#feedThenStock:10>9",
      "f.ts#refreshThenFeed:12>10",
      "f.ts#roundsAfterStock:9>7",
    ]);
  });

  it("LOCKS-2: locks taken inside helpers, imported functions (aliased, re-exported, namespaced), wrapped consts, object-literal and class methods count", () => {
    const found = scan({
      "server/locks.ts": `
        export async function closeDrawerRow(tx, id) {
          await tx\`update cash_sessions set closed_at=now() where id=\${id}\`;
        }
        export async function placeRounds(tx, id) {
          await tx\`update rounds set state='review' where order_id=\${id}\`;
        }
      `,
      "server/barrel.ts": `export { closeDrawerRow as closeRow } from "./locks.js";`,
      "server/commands.ts": `
        import { closeDrawerRow as close, placeRounds } from "./locks.js";
        import { closeRow } from "./barrel.js";
        import * as locks from "./locks.js";
        async function issueHelper(tx, s) { await refreshCheckState(tx, s, 1); }
        export async function aliasedHelper(tx, s) {
          await close(tx, 1);
          await bumpKitchenFeed(tx, s);
        }
        export async function viaBarrel(tx, s) {
          await closeRow(tx, 1);
          await bumpKitchenFeed(tx, s);
        }
        export async function viaNamespace(tx, s) {
          await locks.closeDrawerRow(tx, 1);
          await stock(tx, s, item);
        }
        export async function helperThenFeed(tx, s) {
          await issueHelper(tx, s);
          await bumpKitchenFeed(tx, s);
        }
        export async function updateRoundsAfterDrawer(tx, s) {
          await drawer(tx, s);
          await placeRounds(tx, 1);
        }
        export const wrapped = wrap(async (tx, s) => {
          await drawer(tx, s);
          await tx.unsafe("select id from orders where id=$1 for update", [1]);
        });
        export const commands = {
          async method(tx, s) { await drawer(tx, s); await lockStockItems(tx, ids); },
          arrow: async (tx, s) => { await bumpKitchenFeed(tx, s); await tx\`insert into stock_movements(id) values(1)\`; },
        };
        export class Service {
          async run(tx, s) { await refreshCheckState(tx, s, 1); await drawer(tx, s); }
        }
      `,
    });
    expect(found).toEqual([
      "server/commands.ts#Service.run:12>11",
      "server/commands.ts#aliasedHelper:11>10",
      "server/commands.ts#commands.arrow:10>9",
      "server/commands.ts#commands.method:11>9",
      "server/commands.ts#helperThenFeed:12>10",
      "server/commands.ts#updateRoundsAfterDrawer:11>7",
      "server/commands.ts#viaBarrel:11>10",
      "server/commands.ts#viaNamespace:11>9",
      "server/commands.ts#wrapped:11>5",
    ]);
  });

  it("an aliased import of a builtin lock function is reported", () => {
    const { program } = scanSources(
      new Map([
        [
          "server/kitchen.ts",
          "export async function bumpKitchenFeed(tx, s) {}",
        ],
        [
          "server/x.ts",
          `import { bumpKitchenFeed as bump } from "./kitchen.js";
           export async function f(tx, s) { await bump(tx, s); }`,
        ],
      ]),
      excluded,
    );
    expect(program.aliasedBuiltins).toEqual([
      "server/x.ts: bumpKitchenFeed as bump",
    ]);
  });

  it("a SHARE->UPDATE upgrade is reported unless once() skips its FOR SHARE for that kind (LO-R6, D20)", () => {
    expect(
      scan({
        "f.ts": `
          export function upgrades(tx, s, raw) {
            return once(tx, s, raw.operationId, "menu.save", raw, async () => {
              await tx\`update restaurants set name=\${raw.name} where id=\${s.tenantId}\`;
            });
          }
          export function policy(tx, s, raw) {
            return once(tx, s, raw.operationId, "stock.policy", raw, async () => {
              await tx\`select id from restaurants where id=\${s.tenantId} for update\`;
              await tx\`update restaurants set negative_stock=\${raw.policy}\`;
            });
          }
        `,
      }),
    ).toEqual(["f.ts#upgrades:upgrade:restaurants"]);
  });

  it("if/else and switch alternatives, an early return and ?: are separate paths; what any of them took is held afterwards", () => {
    expect(
      scan({
        "f.ts": `
          export async function alternatives(tx, s, deactivate) {
            await tx\`select * from employees where id=\${e} for update\`;
            if (deactivate) await tx\`select * from cash_sessions where id=\${d} for update\`;
            else await tx\`update rounds set state='x' where id=\${r}\`;
          }
          export async function earlyReturn(tx, s, created) {
            if (!created) return drawer(tx, s);
            await tx\`select * from orders where id=\${id} for update\`;
          }
          export async function choice(tx, s, lock) {
            return lock ? drawer(tx, s) : lockStockItems(tx, ids);
          }
          export async function afterBranch(tx, s, x) {
            if (x) await drawer(tx, s);
            await lockStockItems(tx, ids);
          }
          export async function cases(tx, s, kind) {
            switch (kind) {
              case "a": return drawer(tx, s);
              case "b": return bumpKitchenFeed(tx, s);
              default: await tx\`select * from orders where id=\${id} for update\`;
            }
          }
        `,
      }),
    ).toEqual(["f.ts#afterBranch:11>9"]);
  });

  it("each tenant() or sql.begin() is its own transaction; a re-lock of a held table or area key is free", () => {
    expect(
      scan({
        "f.ts": `
          export async function twoTransactions(sql, s) {
            await tenant(sql, s.tenantId, (tx) => drawer(tx, s));
            await sql.begin(async (tx) => { await lockStockItems(tx, ids); });
          }
          export async function relock(tx, s) {
            await tx\`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id'),920))\`;
            await tx\`select * from orders where id=\${a} for update\`;
            await tx\`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id'),920))\`;
            await drawer(tx, s);
            await tx\`select * from orders where id=\${a} for update\`;
          }
          export async function newKeyAfterRows(tx, s) {
            await tx\`select * from orders where id=\${a} for update\`;
            await tx\`select pg_advisory_xact_lock(hashtextextended(\${s.tenantId + key},0))\`;
          }
        `,
      }),
    ).toEqual(["f.ts#newKeyAfterRows:5>1"]);
  });

  it("a step back inside a called function is that function's violation, not its callers'", () => {
    expect(
      scan({
        "server/a.ts": `
          export async function inner(tx, s) {
            await refreshCheckState(tx, s, 1);
            await bumpKitchenFeed(tx, s);
          }
          export async function outer(tx, s) {
            await tx\`select * from orders where id=\${id} for update\`;
            await inner(tx, s);
          }
          route("post", "/x", (tx, s) => outer(tx, s));
        `,
      }),
    ).toEqual(["server/a.ts#inner:12>10"]);
  });

  it("classifies advisory keys and SQL locks by LO level", () => {
    const level = (sql: string, full = sql) =>
      sqlEvents(sql, full).map((e) => levelLabel(e.level));
    expect(
      level(
        "select pg_advisory_xact_lock(hashtextextended( $ ,0))",
        "select pg_advisory_xact_lock(hashtextextended(${s.tenantId + key},0))",
      ),
    ).toEqual(["1"]);
    expect(
      level(
        "select pg_advisory_xact_lock(hashtextextended( $ ,0))",
        "select pg_advisory_xact_lock(hashtextextended(${s.tenantId + p.tenderId},0))",
      ),
    ).toEqual(["6"]);
    expect(
      level(
        "select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':floor',0))",
      ),
    ).toEqual(["3"]);
    expect(
      level(
        "select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id'),920))",
      ),
    ).toEqual(["3"]);
    expect(
      level("select pg_advisory_xact_lock(hashtextextended( $ ,711))"),
    ).toEqual(["0"]);
    expect(
      level(
        "select * from rounds r join orders o on o.id=r.order_id where r.id= $ for update of r",
      ),
    ).toEqual(["7"]);
    expect(level("select * from orders where id= $ for no key update")).toEqual(
      ["5"],
    );
    expect(level("update cash_sessions set closed_at=now()")).toEqual(["11"]);
    expect(level("update stock_items set on_hand=0")).toEqual(["9"]);
    expect(
      level(
        "insert into order_numbers(d,n) values($,1) on conflict (d) do update set n=n+1",
      ),
    ).toEqual(["4"]);
    expect(level("insert into stock_movements(id) values( $ )")).toEqual(["9"]);
    // Reads, inserts of new rows and tables outside the LO table take no ordered lock.
    for (const sql of [
      "select * from orders where id= $",
      "insert into orders(id) values( $ )",
      "update orders set note= $",
      "select * from devices where id= $ for update",
      "update jobs set state='done'",
    ])
      expect(level(sql), sql).toEqual([]);
  });

  it("after fiscal's reorder (feed before refresh) only the permanent entries of those commands remain", () => {
    const found = scan({
      "server/orders.ts": `
        export async function createOrder(tx, s, raw) {
          return once(tx, s, raw.operationId, "order.create", raw, async () => {
            await tx\`select id from dining_tables where id=\${t} and archived_at is null for share\`;
            await tx\`insert into order_numbers(tenant_id,business_date,n) values(\${s.tenantId},\${d},1) on conflict (tenant_id,business_date) do update set n=order_numbers.n+1\`;
            await lockStockItems(tx, ids);
            await bumpKitchenFeed(tx, s);
            await refreshCheckState(tx, s, id);
          });
        }
      `,
      "server/voids.ts": `
        export async function voidLines(tx, s, orderId, raw) {
          return once(tx, s, raw.operationId, "order.void", raw, async () => {
            await tx\`select * from orders where id=\${orderId} for update\`;
            await tx\`select id from employees where id=\${a} for share\`;
            await lockStockItems(tx, ids);
            await tx\`select * from rounds where order_id=\${orderId} and number=\${n} for update\`;
            await stock(tx, s, item);
            await bumpKitchenFeed(tx, s);
            await refreshCheckState(tx, s, orderId);
          });
        }
      `,
      "server/service.ts": `
        export async function assignService(tx, s, orderId, raw) {
          return once(tx, s, raw.operationId, "order.service", raw, async () => {
            await tx\`select * from orders where id=\${orderId} for update\`;
            await tx\`select id from employees where id=\${e} for share\`;
            await tx\`select id from dining_tables where id=\${t} for share\`;
            await bumpKitchenFeed(tx, s);
            await refreshCheckState(tx, s, orderId);
          });
        }
      `,
    });
    expect(found).toEqual([
      "server/service.ts#assignService:5a>3",
      "server/voids.ts#voidLines:9>7",
    ]);
    for (const key of found) expect(Object.keys(PERMANENT)).toContain(key);
    for (const key of Object.keys(FISCAL_REORDER))
      expect(found, key).not.toContain(key);
  });
});
