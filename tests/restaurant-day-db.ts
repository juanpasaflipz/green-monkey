/**
 * Restaurant-day DB reconciliation (specs/acceptance.md §9): runs after the
 * browser suite (`npm run test:db:restaurant-day`, scripts/restaurant-day.sh)
 * and reconciles the database with the independent oracle. Tenant-scoped
 * checks run as the runtime role under RLS (`tenant()`); cross-tenant meta
 * checks run as the provisioner in read-only transactions. The first failing
 * check stops the suite and prints expected vs actual.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { connect, tenant, type Tx } from "../server/db.js";
import {
  DATABASE,
  STATE_FILE,
  runUrls,
  type RunState,
} from "./restaurant-day/env.js";
import {
  oracleA,
  oracleB,
  oracleL,
  stampsFor,
  ticketFigures,
} from "./restaurant-day/oracle.js";
import {
  CHECKS_B,
  CLUB_L,
  ORDERS_A,
  ORDERS_L,
  REFUNDS_A,
  REFUNDS_L,
  RESTAURANT_A,
  RESTAURANT_B,
  RESTAURANT_L,
} from "./restaurant-day/scenario.js";

const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as RunState;
const urls = runUrls();
if (!urls.target.endsWith(`/${DATABASE}`))
  throw Error(`refusing ${urls.target}`);
const sql = connect(urls.runtime);
const admin = postgres(urls.provisioner, { max: 2, onnotice: () => {} });
const A = state.tenantA!;
const B = state.tenantB!;
const L = state.tenantL!;
const FIG = ticketFigures();
const cents = (money: string) => {
  const m = /^([−-])?\$([\d,]+)\.(\d{2})$/.exec(money);
  if (!m) throw Error(`money ${money}`);
  const v = Number(m[2]!.replace(/,/g, "")) * 100 + Number(m[3]);
  return m[1] ? -v : v;
};

let passed = 0;
let failed = 0;
/** Local triage only: RD_DB_CONTINUE=1 lists every failure (the exit code still fails). */
const keepGoing = process.env.RD_DB_CONTINUE === "1" && !process.env.CI;
async function check(id: string, name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${id}: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${id}: ${name}`);
    console.error(error);
    if (keepGoing) return;
    await sql.end();
    await admin.end();
    process.exit(1);
  }
}
/** Query results as plain arrays and objects (postgres.js Result has its own prototype). */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** A read-only provisioner transaction (cross-tenant meta checks only). */
async function meta<T>(fn: (tx: postgres.Sql) => Promise<T>) {
  return plain(
    (await admin.begin(async (t) => {
      const tx = t as unknown as postgres.Sql;
      await tx`set transaction read only`;
      return fn(tx);
    })) as T,
  );
}
/** A tenant-scoped read as the runtime role under RLS. */
const inT = async <T>(t: string, fn: (tx: Tx) => Promise<T>) =>
  plain(await tenant(sql, t, fn));
const inA = <T>(fn: (tx: Tx) => Promise<T>) => inT(A, fn);
const inB = <T>(fn: (tx: Tx) => Promise<T>) => inT(B, fn);

const expectedA = oracleA();
const expectedB = oracleB();
const expectedL = oracleL();
const inL = <T>(fn: (tx: Tx) => Promise<T>) => inT(L, fn);

await check(
  "D1",
  "folios are gapless per restaurant and series; folio → order equals §6.12 and §7.9",
  async () => {
    for (const [t, series, rows] of [
      [
        A,
        RESTAURANT_A.fiscal.series,
        ORDERS_A.filter((o) => FIG[o.id]!.folio).map((o) => [
          FIG[o.id]!.folio!,
          o.number,
        ]),
      ],
      [
        B,
        RESTAURANT_B.fiscal.series,
        CHECKS_B.map((c) => [FIG[c.id]!.folio!, c.number]),
      ],
    ] as const) {
      const got = await inT(t, async (tx) => {
        const [agg] =
          await tx`select count(*)::int as n, min(number)::int as lo, max(number)::int as hi from fiscal_tickets where series=${series}`;
        const [counter] =
          await tx`select last_value::int as v from fiscal_folio_counters where series=${series}`;
        const map =
          await tx`select t.series||'-'||lpad(t.number::text,6,'0') as folio, o.number::int as n
        from fiscal_tickets t join orders o on o.id=t.order_id where t.series=${series} order by t.number`;
        return {
          agg,
          counter: counter?.v,
          map: map.map((r) => [r.folio, r.n]),
        };
      });
      assert.deepEqual(got.agg, { n: rows.length, lo: 1, hi: rows.length });
      assert.equal(got.counter, rows.length);
      assert.deepEqual(got.map, rows);
    }
  },
);

await check(
  "D2",
  "ticket gross equals the order total; per-category rows equal §6.12/§7.9; tax_basis line_snapshot",
  async () => {
    for (const [t, ids] of [
      [A, ORDERS_A.filter((o) => FIG[o.id]!.folio).map((o) => o.id)],
      [B, CHECKS_B.map((c) => c.id)],
    ] as const) {
      const rows = await inT(
        t,
        async (tx) =>
          tx`select o.number::int as n, t.gross::int as gross, o.total::int as total, t.tax_basis,
          (select coalesce(json_object_agg(x.category, json_build_object('gross',x.gross::int,'base',x.base::int,'tax',x.tax::int)),'{}')
             from fiscal_ticket_taxes x where x.ticket_id=t.id) as cats
        from fiscal_tickets t join orders o on o.id=t.order_id`,
      );
      for (const id of ids) {
        const f = FIG[id]!;
        const row = rows.find((r) => r.n === f.number);
        assert.ok(row, `ticket for ${id}`);
        assert.equal(row.gross, f.total, `${id} gross`);
        assert.equal(row.total, f.total, `${id} order total`);
        assert.equal(row.tax_basis, "line_snapshot", `${id} tax_basis`);
        const want: Record<
          string,
          { gross: number; base: number; tax: number }
        > = {};
        for (const [cat, g] of Object.entries(f.groups))
          if (g.gross) want[cat] = g;
        assert.deepEqual(row.cats, want, `${id} categories`);
      }
    }
  },
);

await check(
  "D3",
  "the fully voided order #14 closed as voided with no ticket and no tender",
  async () => {
    const [o] = await inA(
      (tx) =>
        tx`select o.check_state, o.close_reason, o.total::int as total,
        (select count(*)::int from fiscal_tickets t where t.order_id=o.id) as tickets,
        (select count(*)::int from tenders x where x.order_id=o.id) as tenders
      from orders o where o.number=14 and o.business_date=${state.businessDateA}`,
    );
    assert.deepEqual(o, {
      check_state: "closed",
      close_reason: "voided",
      total: 0,
      tickets: 0,
      tenders: 0,
    });
  },
);

await check(
  "D4",
  "every order and ticket is dated on the run's business day; the fiscal summary equals the oracle",
  async () => {
    for (const [t, date, orders] of [
      [A, state.businessDateA, ORDERS_A.length],
      [B, state.businessDateB, CHECKS_B.length],
    ] as const) {
      const [r] = await inT(
        t,
        async (tx) =>
          tx`select (select count(*)::int from orders) as orders,
          (select count(*)::int from orders where business_date<>${date}) as other_orders,
          (select count(*)::int from fiscal_tickets where business_date<>${date}) as other_tickets`,
      );
      assert.deepEqual(r, { orders, other_orders: 0, other_tickets: 0 });
    }
    const [sums] = await inA(
      (tx) =>
        tx`select coalesce(sum(gross),0)::int as gross, coalesce(sum(base),0)::int as base, coalesce(sum(tax),0)::int as tax
      from fiscal_ticket_taxes where category='iva16'`,
    );
    const z = expectedA.corteZ;
    assert.deepEqual(sums, {
      gross: cents(z.iva16.sales),
      base: cents(z.iva16.base),
      tax: cents(z.iva16.tax),
    });
  },
);

await check(
  "D5",
  "tenders equal the order book: one per paid order (A 25, B 10), the lost-response order #23 has exactly one",
  async () => {
    const a = await inA(
      (tx) =>
        tx`select o.number::int as n, x.method, x.amount::int as amount, x.tip::int as tip, x.received::int as received, x.external_reference as ref
      from tenders x join orders o on o.id=x.order_id order by o.number, x.created_at`,
    );
    assert.equal(a.length, 25);
    assert.equal(a.filter((x) => x.n === 23).length, 1);
    for (const o of ORDERS_A.filter((x) => x.payment)) {
      const f = FIG[o.id]!;
      const t = a.find((x) => x.n === o.number)!;
      const p = o.payment!;
      assert.equal(t.method, p.method, `${o.id} method`);
      assert.equal(t.amount, f.total, `${o.id} amount`);
      assert.equal(t.tip, p.tip ?? 0, `${o.id} tip`);
      if (p.method === "external") {
        assert.equal(t.ref, p.ref, `${o.id} reference`);
        assert.equal(t.received, t.amount + t.tip, `${o.id} external received`);
      } else
        assert.equal(
          t.received,
          p.bill ? p.bill * 100 : f.total + (p.tip ?? 0),
          `${o.id} received`,
        );
    }
    const sum = (m: string, k: "amount" | "tip") =>
      a.filter((x) => x.method === m).reduce((s, x) => s + x[k], 0);
    const z = expectedA.corteZ;
    assert.equal(sum("cash", "amount"), cents(z.cash));
    assert.equal(sum("external", "amount"), cents(z.external));
    assert.equal(sum("cash", "tip"), cents(z.cashTips));
    assert.equal(sum("external", "tip"), cents(z.externalTips));
    const b = await inB(
      (tx) =>
        tx`select method, amount::int as amount, tip::int as tip from tenders`,
    );
    assert.equal(
      b.length,
      CHECKS_B.reduce((s, c) => s + c.payments.length, 0),
    );
    const zb = expectedB.corteZ;
    assert.equal(
      b.filter((x) => x.method === "cash").reduce((s, x) => s + x.amount, 0),
      cents(zb.cash),
    );
    assert.equal(
      b
        .filter((x) => x.method === "external")
        .reduce((s, x) => s + x.amount, 0),
      cents(zb.external),
    );
  },
);

await check(
  "D6",
  "refunds: two amount batches in A (R1 Marisol self-approved, R2 Diego approved by Marisol), complement-extraction IVA, one operation each; none in B",
  async () => {
    const staff = await inA((tx) => tx`select id, name from employees`);
    const id = (name: string) => staff.find((e) => e.name === name)!.id;
    const batches = await inA(
      (tx) =>
        tx`select o.number::int as n, b.mode, b.cash_amount::int as cash, b.external_amount::int as external, b.actor_id, b.approver_id
      from refund_batches b join orders o on o.id=b.order_id order by o.number`,
    );
    const marisol = id("Marisol Vega"),
      diego = id("Diego Ramos");
    assert.deepEqual(batches, [
      {
        n: 2,
        mode: "amount",
        cash: 0,
        external: 4500,
        actor_id: diego,
        approver_id: marisol,
      },
      {
        n: 6,
        mode: "amount",
        cash: 4500,
        external: 0,
        actor_id: marisol,
        approver_id: marisol,
      },
    ]);
    const rows = await inA(
      (tx) =>
        tx`select o.number::int as n, r.method, r.external_reference as ref, r.session_id is not null as drawer
      from refunds r join orders o on o.id=r.order_id order by o.number`,
    );
    assert.deepEqual(rows, [
      {
        n: 2,
        method: "external",
        ref: REFUNDS_A[1]!.terminalRef,
        drawer: rows[0]?.drawer ?? false,
      },
      { n: 6, method: "cash", ref: null, drawer: true },
    ]);
    const [units] = await inA(
      (tx) =>
        tx`select (select count(*)::int from refund_units) as units, (select count(*)::int from refund_lines) as lines`,
    );
    assert.deepEqual(units, { units: 0, lines: 0 });
    const adj = await inA(
      (tx) =>
        tx`select o.number::int as n, a.category, a.gross::int as gross, a.base::int as base, a.tax::int as tax, a.business_date::text as d
      from fiscal_adjustments a join orders o on o.id=a.order_id order by o.number`,
    );
    assert.deepEqual(adj, [
      {
        n: 2,
        category: "iva16",
        gross: 4500,
        base: 3879,
        tax: 621,
        d: state.businessDateA,
      },
      {
        n: 6,
        category: "iva16",
        gross: 4500,
        base: 3880,
        tax: 620,
        d: state.businessDateA,
      },
    ]);
    // One operation per refund operationId: neither the step-up refusal nor the lost response duplicated it.
    const [ops] = await inA(
      (tx) =>
        tx`select count(*)::int as n from operations where kind like 'refund%'`,
    );
    assert.equal(ops.n, 2);
    const [none] = await inB(
      (tx) =>
        tx`select (select count(*)::int from refund_batches) as b, (select count(*)::int from refunds) as r`,
    );
    assert.deepEqual(none, { b: 0, r: 0 });
  },
);

await check(
  "D7",
  "offline exactly once: 4 sale records, corrected times, the sale's business day, the drawer, kitchen decisions",
  async () => {
    const recs = await inA(
      (tx) =>
        tx`select r.provisional_number as p, r.kind, r.path, r.clock_offset_ms::int as offset,
        extract(epoch from (r.recorded_at_device - r.recorded_at))::float as drift,
        extract(epoch from r.sold_at)*1000 as sold, r.business_date::text as d, o.number::int as n, o.channel
      from offline_sync_records r join orders o on o.id=r.order_id order by r.provisional_number`,
    );
    assert.equal(recs.length, 4);
    const prefix = state.offlinePrefix;
    recs.forEach((r, i) => {
      assert.equal(r.p, `${prefix}-${String(i + 1).padStart(2, "0")}`);
      assert.equal(r.kind, "sale");
      assert.equal(r.path, "automatic");
      assert.ok(
        r.offset >= -182_000 && r.offset <= -178_000,
        `clock offset ${r.offset}`,
      );
      assert.ok(r.drift >= 178 && r.drift <= 182, `device drift ${r.drift}`);
      assert.equal(r.d, state.businessDateA);
      assert.equal(r.channel, "offline");
      const id = ["A19", "A20", "A21", "A22"][i]!;
      assert.equal(r.n, ORDERS_A.find((o) => o.id === id)!.number);
      assert.ok(
        Math.abs(Number(r.sold) - state.realSoldAt[id]!) <= 10_000,
        `${id} sold_at`,
      );
    });
    const [ch] = await inA(
      (tx) => tx`select count(*)::int as n from orders where channel='offline'`,
    );
    assert.equal(ch.n, 4);
    const [ops] = await inA(
      (tx) =>
        tx`select count(*)::int as n from operations where kind='offline_sync'`,
    );
    assert.equal(ops.n, 4);
    const [drawers] = await inA(
      (tx) =>
        tx`select count(distinct x.session_id)::int as n from tenders x join orders o on o.id=x.order_id where o.channel='offline'`,
    );
    assert.equal(drawers.n, 1);
    // One review per kitchen station round: A22's drink is a bar round (spec §9 counts sales).
    const reviews = await inA(
      (tx) =>
        tx`select state, count(*)::int as n from offline_kitchen_reviews group by state order by state`,
    );
    assert.deepEqual(reviews, [
      { state: "already_served", n: 4 },
      { state: "prepare", n: 1 },
    ]);
  },
);

await check(
  "D8",
  "drawers: one per restaurant, blind close by the cashier, expected and counted, A's review by Lucía",
  async () => {
    for (const [t, z, closer, opening, counted, terminal, reviews] of [
      [
        A,
        expectedA.corteZ,
        "Diego Ramos",
        RESTAURANT_A.openingCash,
        RESTAURANT_A.countedCash,
        cents(expectedA.corteZ.terminalNet),
        1,
      ],
      [
        B,
        expectedB.corteZ,
        "Karla Medina",
        RESTAURANT_B.openingCash,
        RESTAURANT_B.countedCash,
        cents(expectedB.corteZ.terminalTotal),
        0,
      ],
    ] as const) {
      const rows = await inT(
        t,
        async (tx) =>
          tx`select c.opening::int as opening, c.expected::int as expected, c.counted::int as counted, c.count_mode,
          c.external_expected::int as terminal, e.name as closer,
          (select count(*)::int from cash_count_reviews r where r.drawer_id=c.id) as reviews,
          (select note from cash_count_reviews r where r.drawer_id=c.id limit 1) as note
        from cash_sessions c left join employees e on e.id=c.closed_by`,
      );
      assert.equal(rows.length, 1);
      assert.deepEqual(
        { ...rows[0], note: undefined },
        {
          opening,
          expected: cents(z.expectedCash),
          counted,
          count_mode: "blind",
          terminal,
          closer,
          reviews,
          note: undefined,
        },
      );
      if (reviews) assert.equal(rows[0]!.note, "Faltante en cambio");
    }
  },
);

await check(
  "D9",
  "stock equals §6.16/§7.12; no drift; Suadero negative; void returns for #8 and #14 only; no refund movements",
  async () => {
    for (const [t, stock] of [
      [A, expectedA.stock],
      [B, expectedB.stock],
    ] as const) {
      const items = await inT(
        t,
        async (tx) =>
          tx`select s.name, s.on_hand::numeric::float as on_hand, s.negative_since is not null as negative,
          (select coalesce(sum(m.quantity),0)::float from stock_movements m where m.stock_id=s.id) as total
        from stock_items s order by s.name`,
      );
      for (const s of stock) {
        const row = items.find((i) => i.name === s.name)!;
        assert.ok(
          Math.abs(row.on_hand - s.final) < 1e-9,
          `${s.name} on_hand ${row.on_hand} vs ${s.final}`,
        );
        assert.ok(Math.abs(row.total - row.on_hand) < 1e-9, `${s.name} drift`);
        assert.equal(row.negative, s.negative, `${s.name} negative_since`);
      }
    }
    const returns = await inA(
      (tx) =>
        tx`select distinct o.number::int as n from stock_movements m join line_voids v on v.id::text=m.cause_id
        join orders o on o.id=v.order_id where m.cause='void' order by 1`,
    );
    assert.deepEqual(
      returns.map((r) => r.n),
      [8, 14],
    );
    const [refund] = await inA(
      (tx) =>
        tx`select count(*)::int as n from stock_movements where cause like 'refund%'`,
    );
    assert.equal(refund.n, 0);
  },
);

await check(
  "D10",
  "notes and options are persisted on orders, rounds and lines",
  async () => {
    const notes = await inA(
      (tx) =>
        tx`select number::int as n, note from orders where note<>'' order by number`,
    );
    assert.deepEqual(notes, [{ n: 4, note: "ALERGIA: cacahuate" }]);
    const lineNotes = await inA(
      (tx) =>
        tx`select o.number::int as n, l.data->>'note' as note from order_lines l join orders o on o.id=l.order_id
      where coalesce(l.data->>'note','')<>'' order by o.number`,
    );
    assert.deepEqual(
      lineNotes,
      ORDERS_A.flatMap((o) =>
        o.lines
          .filter((l) => l.note)
          .map((l) => ({ n: o.number, note: l.note! })),
      ),
    );
    const bNotes = await inB(
      (tx) =>
        tx`select number::int as n, note from orders where note<>'' order by number`,
    );
    assert.deepEqual(
      bNotes,
      CHECKS_B.filter((c) => c.orderNote).map((c) => ({
        n: c.number,
        note: c.orderNote!,
      })),
    );
    const roundNotes = await inB(
      (tx) =>
        tx`select distinct o.number::int as n, r.number::int as round, r.note from rounds r join orders o on o.id=r.order_id
      where r.note<>'' and r.note<>o.note order by 1,2`,
    );
    assert.deepEqual(
      roundNotes,
      CHECKS_B.flatMap((c) =>
        c.rounds
          .map((rd, i) => ({ n: c.number, round: i + 1, note: rd.note }))
          .filter((x) => x.note && x.round > 1),
      ),
    );
  },
);

await check(
  "D11",
  "tenant isolation: no row of the other tenant is visible under RLS; tenant() refuses a missing tenant",
  async () => {
    const tables = await meta(
      (tx) =>
        tx`select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id'
      and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')`,
    );
    for (const { table_name } of tables) {
      for (const [mine, other] of [
        [A, B],
        [B, A],
      ]) {
        // A table the runtime role cannot read (no grant) cannot leak through it.
        const [r] = await inT(mine, async (tx) => {
          const [grant] =
            await tx`select has_table_privilege(${table_name}, 'select') as ok`;
          if (!grant!.ok) return [{ n: 0 }];
          return tx`select count(*)::int as n from ${tx(table_name)} where tenant_id=${other}`;
        });
        assert.equal(r.n, 0, `${table_name} leaks ${other} into ${mine}`);
      }
    }
    await assert.rejects(
      tenant(sql, "", async () => null),
      /missing_tenant/,
    );
    const [fk] = await meta(
      (tx) =>
        tx`select count(*)::int as n from tenders x join orders o on o.id=x.order_id where o.tenant_id<>x.tenant_id`,
    );
    assert.equal(fk.n, 0);
  },
);

await check(
  "D12",
  "audit attribution: voids, discount and courtesy, refunds, money controls, closes, review, recall, assignment, tickets, deactivation",
  async () => {
    const count = async (t: string) =>
      Object.fromEntries(
        (
          await inT(
            t,
            (tx) =>
              tx`select operation, count(*)::int as n from audit group by operation`,
          )
        ).map((r) => [r.operation as string, r.n as number]),
      ) as Record<string, number>;
    const a = await count(A);
    const b = await count(B);
    const want = (ops: Record<string, number>, exp: Record<string, number>) =>
      assert.deepEqual(
        Object.fromEntries(Object.keys(exp).map((k) => [k, ops[k] ?? 0])),
        exp,
      );
    want(a, {
      "order.void": 3,
      "discount.applied": 2,
      "refund.recorded": 2,
      "discount.controls.saved": 1,
      "cash.close": 1,
      "cash.reviewed": 1,
      "kitchen.recall": 1,
      "fiscal.ticket.issued": 25,
      "access.employee_deactivated": 1,
    });
    want(b, {
      "discount.controls.saved": 1,
      "cash.close": 1,
      "cash.reviewed": 0,
      "service.assigned": 1,
      "fiscal.ticket.issued": 7,
    });
    const staff = await inA((tx) => tx`select id, name from employees`);
    const id = (name: string) =>
      staff.find((e) => e.name === name)!.id as string;
    const voids = await inA(
      (tx) => tx`select actor_id, approver_id from line_voids`,
    );
    assert.deepEqual(
      voids.map((v) => [v.actor_id, v.approver_id]),
      [
        [id("Diego Ramos"), id("Marisol Vega")],
        [id("Diego Ramos"), id("Marisol Vega")],
        [id("Diego Ramos"), id("Marisol Vega")],
      ],
    );
    const discounts = await inA(
      (tx) =>
        tx`select kind, percent_bps, amount::int as amount, reason_code, actor_id, approver_id from discounts order by created_at`,
    );
    assert.deepEqual(discounts, [
      {
        kind: "percent",
        percent_bps: 1000,
        amount: 1820,
        reason_code: "regular_customer",
        actor_id: id("Diego Ramos"),
        approver_id: id("Marisol Vega"),
      },
      {
        kind: "comp",
        percent_bps: null,
        amount: 4500,
        reason_code: "courtesy",
        actor_id: id("Diego Ramos"),
        approver_id: id("Marisol Vega"),
      },
    ]);
    const [sumDiscount] = await inA(
      (tx) => tx`select coalesce(sum(discount),0)::int as n from orders`,
    );
    assert.equal(sumDiscount.n, 6320);
  },
);

await check(
  "D13",
  "sessions and devices: Paola's sessions revoked, Caja 2 (respaldo) and Tableta temporal unpaired",
  async () => {
    const devices = await inA(
      (tx) =>
        tx`select name, revoked_reason from devices where revoked_at is not null order by name`,
    );
    assert.deepEqual(
      devices.map((d) => d.name),
      ["Caja 2 (respaldo)", "Tableta temporal"],
    );
    const [paola] = await inA(
      (tx) =>
        tx`select count(*)::int as live from sessions s join employees e on e.id=s.employee_id
      where e.name='Paola Núñez' and s.revoked=false and s.ended_at is null`,
    );
    assert.equal(paola.live, 0);
  },
);

await check(
  "D14",
  "jobs: nothing old is still queued and nothing is dead",
  async () => {
    const [r] = await meta(
      (tx) =>
        tx`select (select count(*)::int from jobs where state in ('queued','available') and created_at<now()-interval '60 seconds' and kind='kitchen_dispatch') as stale,
        (select count(*)::int from jobs where state='dead') as dead`,
    );
    assert.deepEqual(r, { stale: 0, dead: 0 });
  },
);

await check(
  "D15",
  "kitchen: no round in offline review; every round completed",
  async () => {
    for (const t of [A, B]) {
      const [r] = await inT(
        t,
        async (tx) =>
          tx`select (select count(*)::int from rounds where state='offline_review') as review,
          (select count(*)::int from rounds where state<>'completed') as open`,
      );
      assert.deepEqual(r, { review: 0, open: 0 });
    }
  },
);

await check(
  "D16",
  "checks: every order closed; A settled ×25 and voided ×1; B released ×7, #4 released after its ticket",
  async () => {
    const a = await inA(
      (tx) =>
        tx`select close_reason, count(*)::int as n from orders group by close_reason order by 1`,
    );
    assert.deepEqual(a, [
      { close_reason: "settled", n: 25 },
      { close_reason: "voided", n: 1 },
    ]);
    const b = await inB(
      (tx) =>
        tx`select close_reason, count(*)::int as n from orders group by close_reason`,
    );
    assert.deepEqual(b, [{ close_reason: "released", n: 7 }]);
    const [four] = await inB(
      (tx) =>
        tx`select o.closed_at > t.issued_at as later from orders o join fiscal_tickets t on t.order_id=o.id where o.number=4`,
    );
    assert.equal(four.later, true);
  },
);

await check(
  "D17",
  "entitlements: Pro from support until business day + 60, one grant-entitlement action each",
  async () => {
    for (const [t, date] of [
      [A, state.businessDateA],
      [B, state.businessDateB],
    ] as const) {
      const [e] = await meta(
        (tx) =>
          tx`select source, access_until from restaurant_entitlements where tenant_id=${t}`,
      );
      assert.equal(e.source, "support");
      const until = new Date(`${date}T12:00:00Z`);
      until.setUTCDate(until.getUTCDate() + 60);
      assert.equal(
        new Date(e.access_until).toISOString().slice(0, 10) >=
          until.toISOString().slice(0, 10),
        true,
      );
      const [n] = await meta(
        (tx) =>
          tx`select count(*)::int as n from support_actions where tenant_id=${t} and action='grant_entitlement'`,
      );
      assert.equal(n.n, 1);
    }
  },
);

await check("D18", "no demo data", async () => {
  const [r] = await meta(
    (tx) =>
      tx`select (select count(*)::int from restaurants where id::text like '10000000-%') as demo,
        (select count(*)::int from employees where name like '% Demo') as people`,
  );
  assert.deepEqual(r, { demo: 0, people: 0 });
});

await check(
  "D19",
  `factura global readiness (branch ${state.branch}): one concept per ticket and category, sums equal §7.11 row ${state.branch}`,
  async () => {
    // Branch K: J-000003 has the one active claim (its individual test invoice), so the
    // readiness set is the other six tickets. The built claims table is cfdi_document_tickets.
    const claims = await inB(
      (tx) =>
        tx`select t.series||'-'||lpad(t.number::text,6,'0') as folio, c.mode, d.kind, d.status, d.amount_check, d.expected_total::int as expected
      from cfdi_document_tickets c join fiscal_tickets t on t.id=c.ticket_id join cfdi_documents d on d.id=c.document_id
      where c.state='active'`,
    );
    if (state.branch === "K")
      assert.deepEqual(plain(claims), [
        {
          folio: "J-000003",
          mode: "test",
          kind: "invoice",
          status: "valid",
          amount_check: "exact",
          expected: 38500,
        },
      ]);
    else assert.deepEqual(plain(claims), []);
    const claimed = new Set(claims.map((c) => c.folio as string));
    const concepts = (
      await inB(
        (tx) =>
          tx`select t.series||'-'||lpad(t.number::text,6,'0') as folio, x.category, x.gross::int as gross, x.base::int as base, x.tax::int as tax
        from fiscal_tickets t join fiscal_ticket_taxes x on x.ticket_id=t.id where t.business_date=${state.businessDateB} and x.gross<>0`,
      )
    ).filter((c) => !claimed.has(c.folio as string));
    const g = state.branch === "K" ? expectedB.globalK : expectedB.globalN;
    assert.equal(concepts.length, g.concepts);
    assert.equal(new Set(concepts.map((c) => c.folio)).size, g.tickets);
    const iva8 = concepts.filter((c) => c.category === "iva8");
    assert.deepEqual(
      {
        sales: iva8.reduce((s, c) => s + c.gross, 0),
        base: iva8.reduce((s, c) => s + c.base, 0),
        tax: iva8.reduce((s, c) => s + c.tax, 0),
      },
      {
        sales: cents(g.iva8.sales),
        base: cents(g.iva8.base),
        tax: cents(g.iva8.tax),
      },
    );
    assert.equal(
      concepts
        .filter((c) => c.category === "iva0")
        .reduce((s, c) => s + c.gross, 0),
      cents(g.tasa0),
    );
  },
);

// ---------------------------------------------------------------- branch L
// Loyalty spec §9.4 (LD-80): Restaurant L's club day reconciled with the oracle (R18, R19) and
// the hand-typed tables (expected.ts L); the club exists in no other restaurant.

await check(
  "D20",
  "Restaurant L: folios L-000001..3, tickets, tenders, the reward discount, the refund and the open drawer equal branch L's book",
  async () => {
    const series = RESTAURANT_L.fiscal.series;
    const tickets = await inL(
      (tx) =>
        tx`select t.series||'-'||lpad(t.number::text,6,'0') as folio, o.number::int as n, t.gross::int as gross,
          o.total::int as total, o.discount::int as discount, t.business_date::text as d,
          (select coalesce(json_object_agg(x.category, json_build_object('gross',x.gross::int,'base',x.base::int,'tax',x.tax::int)),'{}')
             from fiscal_ticket_taxes x where x.ticket_id=t.id) as cats
        from fiscal_tickets t join orders o on o.id=t.order_id where t.series=${series} order by t.number`,
    );
    assert.deepEqual(
      tickets.map((t) => [t.folio, t.n]),
      ORDERS_L.map((o) => [FIG[o.id]!.folio, o.number]),
    );
    for (const o of ORDERS_L) {
      const f = FIG[o.id]!;
      const t = tickets.find((x) => x.n === o.number)!;
      assert.equal(t.gross, f.total, `${o.id} gross`);
      assert.equal(t.total, f.total, `${o.id} total`);
      assert.equal(t.d, state.businessDateL, `${o.id} business date`);
      assert.equal(
        t.discount,
        f.grossBeforeDiscount - f.total,
        `${o.id} discount`,
      );
      assert.deepEqual(t.cats, { iva16: f.groups.iva16 }, `${o.id} IVA`);
    }
    const tenders = await inL(
      (tx) =>
        tx`select o.number::int as n, x.method, x.amount::int as amount, x.tip::int as tip, x.received::int as received,
          x.external_reference as ref, x.session_id is not null as drawer
        from tenders x join orders o on o.id=x.order_id order by o.number, x.created_at`,
    );
    assert.deepEqual(
      tenders,
      ORDERS_L.map((o) => ({
        n: o.number,
        method: o.payment!.method,
        amount: FIG[o.id]!.total,
        tip: 0,
        received:
          o.payment!.method === "cash"
            ? o.payment!.bill! * 100
            : FIG[o.id]!.total,
        ref: o.payment!.ref ?? null,
        drawer: true,
      })),
    );
    const staff = await inL((tx) => tx`select id, name from employees`);
    const id = (key: string) =>
      staff.find(
        (e) => e.name === RESTAURANT_L.staff.find((p) => p.key === key)!.name,
      )!.id as string;
    // The reward (R18): a comp of one unit within the cap, no approver, the cashier's own.
    const rewardOrder = ORDERS_L.find((o) => o.reward)!;
    const reward = expectedL.adjustments[0]!;
    const discounts = await inL(
      (tx) =>
        tx`select o.number::int as n, d.kind, d.amount::int as amount, d.units, d.reason_code, d.actor_id,
          d.approver_id, d.reversed_at is null as active
        from discounts d join orders o on o.id=d.order_id`,
    );
    assert.deepEqual(discounts, [
      {
        n: rewardOrder.number,
        kind: reward.courtesy !== "—" ? "comp" : "amount",
        amount: cents(
          reward.courtesy !== "—" ? reward.courtesy : reward.discount,
        ),
        units: 1,
        reason_code: "loyalty_reward",
        actor_id: id(rewardOrder.cashier),
        approver_id: null,
        active: true,
      },
    ]);
    // The refund (R8): one amount batch from the drawer, the cashier with the manager's PIN.
    const batches = await inL(
      (tx) =>
        tx`select o.number::int as n, b.mode, b.cash_amount::int as cash, b.external_amount::int as external,
          b.platform_amount::int as platform, b.actor_id, b.approver_id
        from refund_batches b join orders o on o.id=b.order_id order by o.number`,
    );
    assert.deepEqual(
      batches,
      REFUNDS_L.map((rf) => ({
        n: FIG[rf.order]!.number,
        mode: "amount",
        cash: rf.method === "cash" ? rf.amount : 0,
        external: rf.method === "external" ? rf.amount : 0,
        platform: 0,
        actor_id: id(rf.actor),
        approver_id: id(rf.approver),
      })),
    );
    const adj = await inL(
      (tx) =>
        tx`select t.series||'-'||lpad(t.number::text,6,'0') as folio, a.gross::int as gross, a.base::int as base, a.tax::int as tax
        from fiscal_adjustments a join fiscal_tickets t on t.order_id=a.order_id order by t.number`,
    );
    assert.deepEqual(
      adj,
      expectedL.refunds.map((rf) => ({
        folio: rf.folio,
        gross: cents(rf.amount),
        base: cents(rf.base),
        tax: cents(rf.tax),
      })),
    );
    // R11: the drawer is still open; its expected cash recomputed from tenders and refunds.
    const [drawer] = await inL(
      (tx) =>
        tx`select count(*) over ()::int as drawers, c.opening::int as opening, c.closed_at is null as open,
          c.opening + coalesce((select sum(x.amount + x.tip) from tenders x where x.session_id=c.id and x.method='cash'),0)
            - coalesce((select sum(r.amount) from refunds r where r.session_id=c.id and r.method='cash'),0) as expected
        from cash_sessions c`,
    );
    assert.deepEqual(
      { ...drawer, expected: Number(drawer.expected) },
      {
        drawers: 1,
        opening: RESTAURANT_L.openingCash,
        open: true,
        expected: cents(expectedL.day.expectedCash),
      },
    );
  },
);

await check(
  "D21",
  "Restaurant L's club: settings and attestation, one consented member, links, and a ledger equal to R19 (earn, card, redemption, reversal)",
  async () => {
    const staff = await inL((tx) => tx`select id, name from employees`);
    const id = (key: string) =>
      staff.find(
        (e) => e.name === RESTAURANT_L.staff.find((p) => p.key === key)!.name,
      )!.id as string;
    const [settings] = await inL(
      (tx) =>
        tx`select s.enabled, s.program_name, s.stamps_required, s.stamp_threshold, s.reward_kind,
          s.reward_max_amount, s.reward_description, s.prompt_at_checkout, s.receipt_join_qr,
          s.privacy_attested_by, s.privacy_attested_at is not null as attested,
          (select privacy_notice_url from restaurant_account_settings) as notice
        from loyalty_settings s`,
    );
    assert.deepEqual(settings, {
      enabled: true,
      program_name: CLUB_L.programName,
      stamps_required: CLUB_L.stampsRequired,
      stamp_threshold: CLUB_L.threshold,
      reward_kind: "item",
      reward_max_amount: CLUB_L.rewardCap,
      reward_description: CLUB_L.rewardDescription,
      prompt_at_checkout: true,
      receipt_join_qr: true,
      privacy_attested_by: id("ines"),
      attested: true,
      notice: CLUB_L.privacyNoticeUrl,
    });
    const members = await inL(
      (tx) =>
        tx`select id, name, phone_e164, joined_via, joined_by, consent_channel, consent_notice_url,
          marketing_opt_in, redacted_at is null as live, stamps, rewards, lifetime_stamps,
          rewards_earned, rewards_redeemed
        from loyalty_members`,
    );
    assert.equal(members.length, 1);
    const m = members[0]!;
    const cashier = ORDERS_L.find((o) => o.club === "enroll")!.cashier;
    assert.deepEqual(
      { ...m, id: undefined },
      {
        id: undefined,
        name: CLUB_L.member.name,
        phone_e164: "+52" + CLUB_L.member.phone,
        joined_via: "pos",
        joined_by: id(cashier),
        consent_channel: "staff_attested",
        consent_notice_url: CLUB_L.privacyNoticeUrl,
        marketing_opt_in: false,
        live: true,
        stamps: expectedL.club.member.stamps,
        rewards: expectedL.club.member.rewards,
        lifetime_stamps: expectedL.club.member.lifetimeStamps,
        rewards_earned: expectedL.club.member.rewardsEarned,
        rewards_redeemed: expectedL.club.member.rewardsRedeemed,
      },
    );
    // Links: every member order to Rosa at the register; the walk-in has none.
    const links = await inL(
      (tx) =>
        tx`select o.number::int as n, k.member_id, k.via, k.linked_by
        from loyalty_order_links k join orders o on o.id=k.order_id order by o.number`,
    );
    assert.deepEqual(
      links,
      ORDERS_L.filter((o) => o.club === "enroll" || o.club === "lookup").map(
        (o) => ({
          n: o.number,
          member_id: m.id,
          via: "pos",
          linked_by: id(o.cashier),
        }),
      ),
    );
    // The ledger, in posting order, equals R19's; each earn row carries its order's stamp base
    // and the rule it earned under; the redemption names the reward discount.
    const ledger = await inL(
      (tx) =>
        tx`select o.number::int as n, l.kind, l.stamps_delta as stamps, l.rewards_delta as rewards,
          l.base, l.stamp_threshold, l.member_id, l.discount_id, l.business_date::text as d,
          (select d.reason_code from discounts d where d.id=l.discount_id) as reason
        from loyalty_ledger l join orders o on o.id=l.order_id order by l.created_at, l.id`,
    );
    const number = (key: string) => FIG[key]!.number;
    assert.deepEqual(
      ledger.map((x) => ({
        order: ORDERS_L.find((o) => o.number === x.n)!.id,
        kind: x.kind,
        stamps: x.stamps,
        rewards: x.rewards,
      })),
      expectedL.club.ledger,
    );
    for (const x of ledger) {
      assert.equal(x.member_id, m.id);
      assert.equal(x.d, state.businessDateL);
      if (x.kind === "earn" || x.kind === "earn_reversal") {
        assert.equal(x.stamp_threshold, CLUB_L.threshold);
        // The base each posting used is the one whose R19 target the running sum reaches.
        const upTo = ledger.slice(0, ledger.indexOf(x) + 1);
        const posted = upTo
          .filter(
            (y) =>
              y.n === x.n && (y.kind === "earn" || y.kind === "earn_reversal"),
          )
          .reduce((s, y) => s + y.stamps, 0);
        assert.equal(
          stampsFor(x.base),
          posted,
          `#${x.n} ${x.kind} base ${x.base}`,
        );
      }
      if (x.kind === "reward_redeemed")
        assert.equal(x.reason, "loyalty_reward");
      else assert.equal(x.discount_id, null);
    }
    const settled = ORDERS_L.find((o) => o.club === "enroll")!;
    const refunded = REFUNDS_L.filter((rf) => rf.order === settled.id);
    const earn = ledger.find(
      (x) => x.n === number(settled.id) && x.kind === "earn",
    )!;
    const reversal = ledger.find(
      (x) => x.n === number(settled.id) && x.kind === "earn_reversal",
    )!;
    assert.equal(earn.base, FIG[settled.id]!.total);
    assert.equal(
      reversal.base,
      FIG[settled.id]!.total - refunded.reduce((s, rf) => s + rf.amount, 0),
    );
    // Balances are the ledger's sums (the club report's ledger-vs-members check).
    assert.deepEqual(
      {
        stamps: ledger.reduce((s, x) => s + x.stamps, 0),
        rewards: ledger.reduce((s, x) => s + x.rewards, 0),
      },
      { stamps: m.stamps, rewards: m.rewards },
    );
  },
);

await check(
  "D22",
  "Restaurant L's club: every reconcile job done, audit rows per command, and no phone or name in audit details, job payloads or operation results",
  async () => {
    const jobs = await meta(
      (tx) =>
        tx`select state, count(*)::int as n from jobs where tenant_id=${L} and kind='loyalty_reconcile' group by state order by state`,
    );
    assert.ok(jobs.length > 0, "the hooks enqueued reconcile jobs");
    assert.deepEqual(
      jobs.map((j) => j.state),
      ["done"],
      JSON.stringify(jobs),
    );
    const ops = Object.fromEntries(
      (
        await inL(
          (tx) =>
            tx`select operation, count(*)::int as n from audit where operation like 'loyalty.%' or operation in ('discount.applied','refund.recorded') group by operation`,
        )
      ).map((r) => [r.operation as string, r.n as number]),
    );
    assert.deepEqual(ops, {
      "loyalty.settings.saved": 1,
      "loyalty.member.enrolled": 1,
      "loyalty.order.linked": ops["loyalty.order.linked"] ?? 0,
      "loyalty.reward.redeemed": 1,
      "discount.applied": 1,
      "refund.recorded": REFUNDS_L.length,
    });
    assert.ok(
      ops["loyalty.order.linked"]! >= 1,
      "the member orders were linked",
    );
    // LOYALTY-PRIVACY-1, H1: personal data never in audit details, job payloads or once() results.
    const digits = CLUB_L.member.phone;
    const [leaks] = await meta(
      (tx) =>
        tx`select
          (select count(*)::int from audit where tenant_id=${L} and (detail::text like ${"%" + digits + "%"} or detail::text like ${"%" + CLUB_L.member.name + "%"})) as audit,
          (select count(*)::int from jobs where tenant_id=${L} and (payload::text like ${"%" + digits + "%"} or payload::text like ${"%" + CLUB_L.member.name + "%"})) as jobs,
          (select count(*)::int from operations where tenant_id=${L} and (result::text like ${"%" + digits + "%"} or result::text like ${"%" + CLUB_L.member.name + "%"})) as operations`,
    );
    assert.deepEqual(leaks, { audit: 0, jobs: 0, operations: 0 });
  },
);

await check(
  "D23",
  "the club exists only in Restaurant L: A and B have no loyalty rows, and no L row is visible from A or B (or the reverse) under RLS",
  async () => {
    for (const t of [A, B]) {
      const [r] = await inT(
        t,
        async (tx) =>
          tx`select (select count(*)::int from loyalty_settings) as settings, (select count(*)::int from loyalty_members) as members,
          (select count(*)::int from loyalty_order_links) as links, (select count(*)::int from loyalty_ledger) as ledger`,
      );
      assert.deepEqual(r, { settings: 0, members: 0, links: 0, ledger: 0 });
    }
    const tables = await meta(
      (tx) =>
        tx`select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id'
      and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')`,
    );
    for (const { table_name } of tables)
      for (const [mine, other] of [
        [L, A],
        [L, B],
        [A, L],
        [B, L],
      ]) {
        const [r] = await inT(mine, async (tx) => {
          const [grant] =
            await tx`select has_table_privilege(${table_name}, 'select') as ok`;
          if (!grant!.ok) return [{ n: 0 }];
          return tx`select count(*)::int as n from ${tx(table_name)} where tenant_id=${other}`;
        });
        assert.equal(r.n, 0, `${table_name} leaks ${other} into ${mine}`);
      }
  },
);

await sql.end();
await admin.end();
if (failed) {
  console.error(`Restaurant-day DB reconciliation: ${failed} check(s) failed.`);
  process.exit(1);
}
console.log(`Restaurant-day DB reconciliation passed (${passed} checks).`);
