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
import { resolve } from "node:path";
import postgres from "postgres";
import { connect, tenant, type Tx } from "../server/db.js";
import { exceptionRows } from "../server/reports/exceptions.js";
import { buildGlobalRequests } from "../server/cfdi/build.js";
import { loadTickets } from "../server/cfdi/worker/tickets.js";
import { paymentFormFor } from "../shared/cfdi.js";
import type { Session } from "../shared/domain.js";
import {
  DATABASE,
  OUT,
  STATE_FILE,
  runUrls,
  type RunState,
} from "./restaurant-day/env.js";
import { EXPECTED_P } from "./restaurant-day/expected-p.js";
import { EXPECTED_S } from "./restaurant-day/expected-s.js";
import {
  CLUB_S,
  KIOSKS_S,
  ORDERS_S,
  PAYMENTS_S,
  RESTAURANT_S,
} from "./restaurant-day/scenario-s.js";
import {
  CFDI_FORMS_P,
  ORDERS_P,
  PAYMENTS_P,
  RESTAURANT_P,
} from "./restaurant-day/scenario-p.js";
import {
  mxn,
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

// ---------------------------------------------------------------- branch P
// Payments spec §12.4 (LD-80): the restaurant-day-payments job plays Restaurant P alone against
// the payments fake. Its rows are reconciled with the hand-typed table (expected-p.ts); A, B and
// L do not exist in that run, so their checks (D1-D23) belong to the A/B job.
if (state.branch === "P") {
  const P = state.tenantP!;
  const inP = <T>(fn: (tx: Tx) => Promise<T>) => inT(P, fn);
  const staffId = async (key: string) => {
    const name = RESTAURANT_P.staff.find((p) => p.key === key)!.name;
    const [e] = await inP(
      (tx) => tx`select id from employees where name=${name}`,
    );
    return e!.id as string;
  };
  const orderOf = (n: number) => ORDERS_P.find((o) => o.number === n)!;

  await check(
    "DP1",
    "Restaurant P: folios P-000001..8 with their totals and IVA, and one tender per order (method, amount, tip, terminal, card, platform, fee and its source, reference) equal branch P's book",
    async () => {
      const tickets = await inP(
        (tx) =>
          tx`select t.series||'-'||lpad(t.number::text,6,'0') as folio, o.number::int as n, t.gross::int as gross,
            o.total::int as total, t.business_date::text as d,
            (select json_build_object('base',x.base::int,'tax',x.tax::int) from fiscal_ticket_taxes x
              where x.ticket_id=t.id and x.category='iva16') as iva16,
            (select count(*)::int from fiscal_ticket_taxes x where x.ticket_id=t.id) as categories
          from fiscal_tickets t join orders o on o.id=t.order_id order by t.number`,
      );
      for (const t of tickets) {
        assert.equal(
          t.gross,
          t.total,
          `${t.folio}: gross is the order's total`,
        );
        assert.equal(t.d, state.businessDateP, `${t.folio}: business date`);
        assert.equal(t.categories, 1, `${t.folio}: IVA 16 % only`);
      }
      assert.deepEqual(
        tickets.map((t) => ({
          folio: t.folio,
          number: t.n,
          total: mxn(t.total),
          base: mxn(t.iva16.base),
          tax: mxn(t.iva16.tax),
        })),
        EXPECTED_P.tickets,
      );
      const tenders = await inP(
        (tx) =>
          tx`select o.number::int as n, x.method, x.amount::int as amount, x.tip::int as tip,
            x.terminal_label, x.platform, x.card_brand, x.card_type, x.card_last4, x.fee::int as fee,
            x.fee_source, x.provider, x.provider_reference, x.attempt_id, x.external_reference as ref,
            x.session_id is not null as drawer
          from tenders x join orders o on o.id=x.order_id order by o.number, x.created_at`,
      );
      assert.deepEqual(
        tenders.map((x) => ({
          order: orderOf(x.n).id,
          method: x.method,
          amount: mxn(x.amount),
          tip: mxn(x.tip),
          terminal: x.terminal_label,
          platform: x.platform,
          card: x.card_brand
            ? `${x.card_brand} ${x.card_type} ${x.card_last4}`
            : null,
          fee: x.fee === null ? null : mxn(x.fee),
          feeSource: x.fee_source,
        })),
        EXPECTED_P.tenders,
      );
      for (const x of tenders) {
        const o = orderOf(x.n);
        const p = o.payment;
        assert.equal(x.drawer, true, `${o.id}: on the drawer`);
        if (p.kind === "integrated" || p.kind === "unknown") {
          // Integrated: provider, attempt and the provider's reference (the manager's on P5).
          const t = PAYMENTS_P.terminals[p.terminal];
          assert.equal(x.provider, t.provider, `${o.id} provider`);
          assert.ok(x.attempt_id, `${o.id}: the tender names its attempt`);
          if (p.kind === "unknown") {
            assert.equal(
              x.provider_reference,
              p.reference,
              `${o.id} reference`,
            );
            assert.equal(x.ref, p.reference, `${o.id} external reference`);
          } else
            // The provider's own id of the charge the fake made for this sale (P2V-GATE-5:
            // MP's order id, Clip's pinpad request id), never just any value.
            assert.equal(
              x.provider_reference,
              (state.paymentsCharges as Record<string, string>)[o.id],
              `${o.id}: the provider's reference is the fake's charge`,
            );
        } else {
          assert.equal(x.provider, null, `${o.id}: no provider`);
          assert.equal(x.attempt_id, null, `${o.id}: no attempt`);
        }
        if (p.kind === "manual")
          assert.equal(x.ref, p.reference, `${o.id} approval reference`);
        if (p.kind === "platform")
          assert.equal(x.ref, p.orderNumber, `${o.id} platform order number`);
      }
    },
  );

  await check(
    "DP2",
    "Restaurant P's terminal charges: one attempt per integrated charge, each final; the settled ones carry their order's tender, the declined one none, the unknown one recorded by Ulises with his reason; nothing live",
    async () => {
      const attempts = await inP(
        (tx) =>
          tx`select o.number::int as n, a.state, a.provider, a.terminal_label, a.error_code, a.resolution,
            a.resolution_note, a.resolved_by, a.amount::int as amount, a.tip::int as tip,
            a.tender_id, (select x.id from tenders x where x.attempt_id=a.id) as tender_of,
            (select array_agg(e.kind order by e.created_at, e.id) from payment_attempt_events e
              where e.attempt_id=a.id) as events
          from payment_attempts a join orders o on o.id=a.order_id order by a.created_at`,
      );
      const name = (k: "mp" | "clip") => PAYMENTS_P.terminals[k].name;
      assert.deepEqual(
        attempts.map((a) => ({
          order: orderOf(a.n).id,
          terminal:
            a.terminal_label === name("mp")
              ? "mp"
              : a.terminal_label === name("clip")
                ? "clip"
                : a.terminal_label,
          state: a.state,
          errorCode: a.error_code,
          resolution: a.resolution,
        })),
        EXPECTED_P.attempts,
      );
      const ulises = await staffId("ulises");
      for (const a of attempts) {
        const o = orderOf(a.n);
        const p = o.payment;
        assert.equal(
          a.tip,
          p.kind === "integrated" ? (p.tip ?? 0) : 0,
          `${o.id} tip`,
        );
        if (a.state === "settled")
          assert.equal(
            a.tender_id,
            a.tender_of,
            `${o.id}: the attempt's tender`,
          );
        else
          assert.equal(
            a.tender_id,
            null,
            `${o.id}: a declined charge has no tender`,
          );
        assert.ok(
          a.events.includes("created") && a.events.includes("sent"),
          `${o.id} events ${a.events}`,
        );
        if (p.kind === "unknown") {
          assert.equal(
            a.resolved_by,
            ulises,
            `${o.id}: resolved by the manager`,
          );
          assert.equal(
            a.resolution_note,
            p.note,
            `${o.id}: the manager's reason`,
          );
          assert.ok(
            a.events.includes("unknown") && a.events.includes("settled"),
            `${o.id} events ${a.events}`,
          );
        } else
          assert.equal(a.resolved_by, null, `${o.id}: no manager resolution`);
        if (p.kind === "declinedThenCash")
          assert.ok(
            a.events.includes("declined"),
            `${o.id} events ${a.events}`,
          );
      }
      const [live] = await inP(
        (tx) =>
          tx`select count(*)::int as n from payment_attempts
            where state in ('created','sending','pending','unknown','approved','review')`,
      );
      assert.equal(live.n, 0, "no charge left live");
    },
  );

  await check(
    "DP3",
    "Restaurant P's Excepciones for the day: exactly the charge Ulises recorded (who started it, who resolved it, the amount, the terminal and the reason) and his partial refund of the Rappi order (platform money); no charge in review or unconfirmed",
    async () => {
      const [restaurant] = await inP(
        (tx) => tx`select name,currency,timezone,cutoff from restaurants`,
      );
      const owner = await staffId("rebeca");
      const session = {
        id: "00000000-0000-4000-8000-0000000000d1",
        tenantId: P,
        employeeId: owner,
        name: RESTAURANT_P.owner.name,
        role: "owner",
        deviceId: "00000000-0000-4000-8000-000000000000",
        expiresAt: "",
        offlineUntil: "",
        csrf: "",
        restaurant,
      } as unknown as Session;
      const page = await inP((tx) =>
        exceptionRows(tx, session, {
          from: state.businessDateP,
          to: state.businessDateP,
          limit: "500",
        }),
      );
      const resolved = ORDERS_P.find((o) => o.payment.kind === "unknown")!;
      const p = resolved.payment as Extract<
        (typeof resolved)["payment"],
        { kind: "unknown" }
      >;
      const ulises = RESTAURANT_P.staff.find((s) => s.key === "ulises")!.name;
      const refund = EXPECTED_P.refunds[0]!;
      assert.deepEqual(
        page.rows
          .map((r) => ({
            kind: r.kind,
            order: r.orderNumber,
            actor: r.actorName,
            approver: r.approverName,
            amount: mxn(r.amount),
            note: r.note,
            terminal: r.detail.terminal,
            resolution: r.detail.resolution,
            platform: r.detail.platform,
          }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
        [
          // Ulises's partial refund of the Rappi order: platform money only (P2V-GATE-3).
          {
            kind: "refund",
            order: refund.order,
            actor: ulises,
            approver: ulises,
            amount: refund.amount,
            note: refund.note,
            terminal: undefined,
            resolution: undefined,
            platform: cents(refund.platform),
          },
          {
            kind: "terminal_attempt_dismissed",
            order: EXPECTED_P.exception.number,
            actor: RESTAURANT_P.staff.find((s) => s.key === "ximena")!.name,
            approver: ulises,
            amount: EXPECTED_P.exception.amount,
            note: p.note,
            terminal: EXPECTED_P.exception.terminal,
            resolution: "recorded",
            platform: undefined,
          },
        ],
      );
    },
  );

  await check(
    "DP4",
    "Restaurant P's drawer: closed by Ulises with the exact count; expected cash is cash only (platform money apart); one batch count per terminal equal to its net",
    async () => {
      const [drawer] = await inP(
        (tx) =>
          tx`select count(*) over ()::int as drawers, c.opening::int as opening, c.counted::int as counted,
            c.expected::int as expected, c.closed_at is not null as closed, c.closed_by
          from cash_sessions c`,
      );
      const z = EXPECTED_P.corteZ;
      assert.deepEqual(
        {
          drawers: drawer.drawers,
          opening: mxn(drawer.opening),
          counted: mxn(drawer.counted),
          expected: mxn(drawer.expected),
          closed: drawer.closed,
          closedBy: drawer.closed_by,
        },
        {
          drawers: 1,
          opening: z.cash.opening,
          counted: z.cash.counted,
          expected: z.cash.expected,
          closed: true,
          closedBy: await staffId("ulises"),
        },
      );
      const counts = await inP(
        (tx) =>
          tx`select t.name, c.expected::int as expected, c.reported::int as reported
          from drawer_terminal_counts c left join payment_terminals t on t.id=c.terminal_id order by t.name`,
      );
      const want = Object.entries(z.terminal.byTerminal).map(([label, v]) => ({
        name: label.replace(/ \(\d+\)$/, ""),
        expected: v.net,
        reported: v.batch,
      }));
      assert.deepEqual(
        counts.map((c) => ({
          name: c.name,
          expected: mxn(c.expected),
          reported: mxn(c.reported),
        })),
        want.sort((a, b) => a.name.localeCompare(b.name)),
      );
    },
  );

  await check(
    "DP5",
    "Restaurant P's provider credentials are sealed and nowhere else: no credential in an audit detail, job payload, operation result, attempt event, account row or sealed box, nor in the web, worker or fake logs; no notification URL in a table",
    async () => {
      const c = PAYMENTS_P.credentials;
      const secrets = [
        c.mercadopago.token,
        c.mercadopago.secret,
        c.clip.key,
        c.clip.secret,
      ];
      for (const value of secrets) {
        const like = `%${value}%`;
        const [row] = await meta(
          (tx) =>
            tx`select
              (select count(*)::int from audit where tenant_id=${P} and detail::text like ${like}) as audit,
              (select count(*)::int from jobs where tenant_id=${P} and payload::text like ${like}) as jobs,
              (select count(*)::int from operations where tenant_id=${P} and (result::text like ${like} or hash like ${like})) as operations,
              (select count(*)::int from payment_attempt_events where tenant_id=${P} and detail::text like ${like}) as events,
              (select count(*)::int from payment_provider_accounts where tenant_id=${P}
                and concat_ws(' ',account_label,provider_account_id,hook_hash,error_code) like ${like}) as accounts,
              (select count(*)::int from payment_secrets where tenant_id=${P} and payload_secret like ${like}) as secrets`,
        );
        assert.deepEqual(
          row,
          {
            audit: 0,
            jobs: 0,
            operations: 0,
            events: 0,
            accounts: 0,
            secrets: 0,
          },
          "a credential value reached a table",
        );
        for (const file of ["server.log", "worker.log", "payments-fake.log"])
          assert.equal(
            readFileSync(resolve(OUT, file), "utf8").includes(value),
            false,
            `${file} holds a credential`,
          );
      }
      // Nor any notification URL (the token is shown once and stored only as its hash; the
      // browser test scans the logs for the tokens themselves, P2V-GATE-5).
      const like = "%/api/payments/webhooks/%";
      const [urls] = await meta(
        (tx) =>
          tx`select
            (select count(*)::int from audit where tenant_id=${P} and detail::text like ${like}) as audit,
            (select count(*)::int from jobs where tenant_id=${P} and payload::text like ${like}) as jobs,
            (select count(*)::int from operations where tenant_id=${P} and result::text like ${like}) as operations,
            (select count(*)::int from payment_attempt_events where tenant_id=${P} and detail::text like ${like}) as events`,
      );
      assert.deepEqual(
        urls,
        { audit: 0, jobs: 0, operations: 0, events: 0 },
        "a notification URL reached a table",
      );
      // Both accounts are active with their sealed credentials (the upload boxes were wiped).
      const [accounts] = await meta(
        (tx) =>
          tx`select (select array_agg(provider||':'||state order by provider) from payment_provider_accounts where tenant_id=${P}) as accounts,
            (select array_agg(purpose order by purpose) from payment_secrets where tenant_id=${P} and wiped_at is null) as sealed`,
      );
      assert.deepEqual(accounts, {
        accounts: ["clip:active", "mercadopago:active"],
        sealed: ["clip_credentials", "mp_credentials"],
      });
    },
  );

  await check(
    "DP6",
    "Restaurant P's jobs: nothing dead, every payments job finished or waiting on nothing live",
    async () => {
      const [r] = await meta(
        (tx) =>
          tx`select (select count(*)::int from jobs where tenant_id=${P} and state='dead') as dead,
            (select count(*)::int from jobs where tenant_id=${P} and kind like 'payments\\_%' and state='running') as running`,
      );
      assert.deepEqual(r, { dead: 0, running: 0 });
    },
  );

  await check(
    "DP7",
    "Restaurant P's refund: Ulises's partial refund of the Rappi order is one batch of platform money only (no cash, no card), with his reason; the drawer's expected cash did not move",
    async () => {
      const batches = await inP(
        (tx) =>
          tx`select o.number::int as n, b.mode, b.amount::int as amount, b.cash_amount::int as cash,
            b.external_amount::int as external, b.platform_amount::int as platform, b.reason_code,
            b.note, ea.name as actor, ep.name as approver,
            (select array_agg(r.method order by r.created_at) from refunds r where r.batch_id=b.id) as methods,
            (select count(*)::int from refunds r where r.batch_id=b.id and r.session_id is not null) as on_drawer
          from refund_batches b join orders o on o.id=b.order_id
            join employees ea on ea.id=b.actor_id join employees ep on ep.id=b.approver_id
          order by b.created_at`,
      );
      assert.deepEqual(
        batches.map((b) => ({
          order: b.n,
          amount: mxn(b.amount),
          cash: mxn(b.cash),
          external: mxn(b.external),
          platform: mxn(b.platform),
          reason: b.reason_code,
          note: b.note,
          actor: b.actor,
        })),
        EXPECTED_P.refunds,
      );
      for (const b of batches) {
        assert.equal(b.mode, "amount");
        assert.equal(b.approver, b.actor, "a manager's own refund");
        assert.deepEqual(b.methods, ["platform"]);
      }
      const [drawer] = await inP(
        (tx) => tx`select expected::int as expected from cash_sessions`,
      );
      assert.equal(mxn(drawer.expected), EXPECTED_P.corteZ.cash.expected);
    },
  );

  await check(
    "DP8",
    "Restaurant P's CFDI forms of payment: each ticket's FormaPago from its tenders and the restaurant's forms (credit 04, debit 28, no card type the card form, cash 01, platform 31), and the daily global invoice built from the day's tickets net of the refund: one concept per ticket, the largest ticket's form",
    async () => {
      const [settings] = await inP(
        (tx) =>
          tx`select card_payment_form, platform_payment_form from cfdi_settings`,
      );
      // No CFDI settings row yet (the restaurant never activated CFDI): 030/037's defaults.
      const forms = {
        card: (settings?.card_payment_form ?? "04") as "04" | "28",
        platform: (settings?.platform_payment_form ?? "31") as "31",
      };
      assert.deepEqual(forms, CFDI_FORMS_P);
      const day = await inP(async (tx) => {
        const ids = await tx`select id from fiscal_tickets order by number`;
        return loadTickets(
          tx,
          ids.map((r) => r.id as string),
        );
      });
      assert.deepEqual(day.excluded, []);
      const tickets = [...day.tickets].sort((a, b) =>
        a.folio.localeCompare(b.folio),
      );
      assert.deepEqual(
        Object.fromEntries(
          tickets.map((t) => [t.folio, paymentFormFor(t.payments, forms)]),
        ),
        EXPECTED_P.cfdi.forms,
      );
      const parts = buildGlobalRequests({
        docIds: () => "00000000-0000-4000-8000-0000000000d8",
        tickets,
        period: { periodicity: "day", months: "01", year: 2026 },
        issuerPostalCode: RESTAURANT_P.fiscal.zip,
        cardForm: forms.card,
        platformForm: forms.platform,
        maxConcepts: Infinity,
      } as Parameters<typeof buildGlobalRequests>[0]);
      assert.equal(parts.length, 1);
      assert.deepEqual(
        {
          form: parts[0]!.body.payment_form,
          concepts: parts[0]!.body.items.length,
          total: mxn(parts[0]!.expectedTotal),
        },
        EXPECTED_P.cfdi.global,
      );
    },
  );

  // -------------------------------------------------------------- branch S
  // Kiosk self-checkout (039; critic R13, R47; LD-80/LD-89): Restaurant S plays after P in the
  // same job. Its rows are reconciled with its hand-typed table (expected-s.ts).
  const S = state.tenantS!;
  const inS = <T>(fn: (tx: Tx) => Promise<T>) => inT(S, fn);
  const staffS = (key: string) =>
    RESTAURANT_S.staff.find((p) => p.key === key)!.name;
  const orderS = (n: number) => ORDERS_S.find((o) => o.number === n)!;

  await check(
    "DS1",
    "Restaurant S: folios S-000001..4 with their totals and IVA, and its tenders (card per kiosk charge on its station's reader with the provider's reference, the difference in cash) equal branch S's book, all in the register's one drawer",
    async () => {
      const tickets = await inS(
        (tx) =>
          tx`select t.series||'-'||lpad(t.number::text,6,'0') as folio, o.number::int as n, t.gross::int as gross,
            o.total::int as total, t.business_date::text as d,
            (select json_build_object('base',x.base::int,'tax',x.tax::int) from fiscal_ticket_taxes x
              where x.ticket_id=t.id and x.category='iva16') as iva16
          from fiscal_tickets t join orders o on o.id=t.order_id order by t.number`,
      );
      for (const t of tickets) {
        assert.equal(
          t.gross,
          t.total,
          `${t.folio}: gross is the order's total`,
        );
        assert.equal(t.d, state.businessDateS, `${t.folio}: business date`);
      }
      assert.deepEqual(
        tickets.map((t) => ({
          folio: t.folio,
          number: t.n,
          total: mxn(t.total),
          base: mxn(t.iva16.base),
          tax: mxn(t.iva16.tax),
        })),
        EXPECTED_S.tickets,
      );
      const tenders = await inS(
        (tx) =>
          tx`select o.number::int as n, x.method, x.amount::int as amount, x.tip::int as tip,
            x.terminal_label, x.card_brand, x.card_type, x.card_last4, x.fee::int as fee,
            x.fee_source, x.provider, x.provider_reference, x.attempt_id, x.session_id
          from tenders x join orders o on o.id=x.order_id
          order by (x.method='cash'), o.number, x.created_at`,
      );
      assert.deepEqual(
        tenders.map((x) => ({
          order: orderS(x.n).id,
          method: x.method,
          amount: mxn(x.amount),
          terminal: x.terminal_label,
          card: x.card_brand
            ? `${x.card_brand} ${x.card_type} ${x.card_last4}`
            : null,
          fee: x.fee === null ? null : mxn(x.fee),
        })),
        EXPECTED_S.tenders,
      );
      const drawers = await inS(
        (tx) => tx`select id from cash_sessions order by opened_at`,
      );
      assert.equal(drawers.length, 1, "one drawer: the register's");
      for (const x of tenders) {
        const o = orderS(x.n);
        assert.equal(
          x.session_id,
          drawers[0]!.id,
          `${o.id}: the register's drawer`,
        );
        assert.equal(x.tip, 0, `${o.id}: no tip`);
        if (x.method === "external") {
          const t = PAYMENTS_S.terminals[KIOSKS_S[o.kiosk].terminal];
          assert.equal(x.provider, t.provider, `${o.id} provider`);
          assert.equal(x.fee_source, "estimated", `${o.id} fee estimated`);
          assert.ok(x.attempt_id, `${o.id}: the tender names its attempt`);
          assert.equal(
            x.provider_reference,
            (state.kioskCharges as Record<string, string>)[o.id],
            `${o.id}: the provider's reference is the fake's charge`,
          );
        } else {
          assert.equal(x.provider, null);
          assert.equal(x.attempt_id, null);
        }
      }
    },
  );

  await check(
    "DS2",
    "Restaurant S's kiosk charges: one hold-target attempt per order, from the kiosk, into the register's drawer as the drawer opener, all settled on their order's card tender; the retried review keeps its code with no resolution, the accepted one is Saúl's record with his note; nothing live",
    async () => {
      const rows = await inS(
        (tx) =>
          tx`select o.number::int as n, a.target, a.origin, a.amount::int as amount, a.tip::int as tip,
            a.state, a.error_code, a.resolution, a.resolution_note, a.terminal_label,
            er.name as resolver, e.name as actor, a.tender_id=x.id as own_tender,
            a.cash_session_id=d.id as on_drawer, a.hold_id=h.id as on_hold,
            (select count(*)::int from payment_attempt_events v where v.attempt_id=a.id and v.kind='review') as reviews
          from payment_attempts a
          join orders o on o.id=a.order_id
          join public_order_holds h on h.order_id=o.id
          join employees e on e.id=a.employee_id
          left join employees er on er.id=a.resolved_by
          left join tenders x on x.attempt_id=a.id
          cross join (select id from cash_sessions) d
          order by o.number`,
      );
      const terminals = { mp: "MP Kiosco", clip: "Clip Kiosco" } as const;
      assert.deepEqual(
        rows.map((a) => ({
          order: orderS(a.n).id,
          terminal: (Object.keys(terminals) as (keyof typeof terminals)[]).find(
            (k) => terminals[k] === a.terminal_label,
          ),
          amount: mxn(a.amount),
          state: a.state,
          errorCode: a.error_code,
          resolution: a.resolution,
        })),
        EXPECTED_S.attempts,
      );
      for (const a of rows) {
        const o = orderS(a.n);
        assert.deepEqual(
          { target: a.target, origin: a.origin, tip: a.tip },
          { target: "kiosk_hold", origin: "kiosk", tip: 0 },
          o.id,
        );
        assert.equal(a.own_tender, true, `${o.id}: settled on its own tender`);
        assert.equal(a.on_drawer, true, `${o.id}: the register's drawer`);
        assert.equal(a.on_hold, true, `${o.id}: the hold's attempt`);
        assert.equal(a.actor, staffS("ines"), `${o.id}: the drawer opener`);
        assert.equal(
          a.reviews,
          o.resolution.kind === "approved" ? 0 : 1,
          `${o.id}: review events`,
        );
        if (o.resolution.kind === "acceptWithRest") {
          assert.equal(a.resolver, staffS("saul"));
          assert.equal(a.resolution_note, o.resolution.note);
        } else assert.equal(a.resolver, null);
      }
      const [all] = await inS(
        (tx) =>
          tx`select count(*)::int as n,
            count(*) filter (where state in ('created','sending','pending','unknown','approved','review'))::int as live
          from payment_attempts`,
      );
      assert.deepEqual(all, { n: ORDERS_S.length, live: 0 });
    },
  );

  await check(
    "DS3",
    "Restaurant S's kiosk holds and orders: every hold accepted and paid at the accept, by the kiosk (no staff tap, LD-72) except the one Saúl accepted with the kiosk payment; para aquí is dine-in with no table; each order's round reached the kitchen stations of its lines; the suggested side kept its origin",
    async () => {
      const holds = await inS(
        (tx) =>
          tx`select o.number::int as n, h.channel, h.state, h.decision_source, h.paid_at_accept,
            h.accepted_total::int as accepted, o.mode, o.table_id, o.channel as order_channel,
            e.name as decided_by, h.lines,
            (select count(*)::int from rounds r where r.order_id=o.id and r.number=1) as rounds,
            (select count(*)::int from rounds r where r.order_id=o.id and r.number>1) as later_rounds,
            (select a.detail->'via' from audit a where a.operation='public.hold_accepted'
              and a.entity_id=h.id::text) as via
          from public_order_holds h join orders o on o.id=h.order_id
          join employees e on e.id=h.decided_by
          order by o.number`,
      );
      assert.equal(holds.length, ORDERS_S.length);
      assert.deepEqual(
        holds.map((h) => ({
          order: orderS(h.n).id,
          number: h.n,
          decisionSource: h.decision_source,
          mode: h.mode,
          acceptedTotal: mxn(h.accepted),
        })),
        EXPECTED_S.holds,
      );
      const stationOf = (id: string) =>
        RESTAURANT_S.products.find((p) => p.id === id)!.station;
      for (const h of holds) {
        const o = orderS(h.n);
        assert.equal(h.channel, "kiosk");
        assert.equal(h.order_channel, "kiosk");
        assert.equal(h.state, "accepted");
        assert.equal(h.paid_at_accept, true, `${o.id}: paid at the accept`);
        assert.equal(h.table_id, null, `${o.id}: no table`);
        const stations = new Set([
          ...o.lines.map((l) => stationOf(l.product)),
          ...(o.suggestion ? [stationOf(o.suggestion)] : []),
        ]);
        assert.equal(h.rounds, stations.size, `${o.id}: one round per station`);
        assert.equal(h.later_rounds, 0);
        if (o.resolution.kind === "acceptWithRest") {
          assert.equal(h.decided_by, staffS("saul"));
          assert.equal(h.via, null, `${o.id}: a staff decision`);
        } else {
          assert.equal(
            h.decided_by,
            staffS("ines"),
            `${o.id}: the kiosk actor`,
          );
          assert.deepEqual(
            h.via,
            { kind: "kiosk" },
            `${o.id}: decided by the kiosk`,
          );
        }
        const suggested = (h.lines as { origin?: string; productId: string }[])
          .filter((l) => l.origin === "suggestion")
          .map((l) => l.productId);
        assert.equal(
          suggested.length,
          o.suggestion ? 1 : 0,
          `${o.id}: suggestion lines`,
        );
      }
    },
  );

  await check(
    "DS4",
    "Restaurant S's drawer: closed by Saúl with the expected cash (the opening plus the accepted difference) counted exactly, and each terminal's batch total equal to its kiosk tenders",
    async () => {
      const [d] = await inS(
        (tx) =>
          tx`select d.expected::int as expected, d.counted::int as counted, e.name as closer,
            d.closed_at is not null as closed
          from cash_sessions d join employees e on e.id=d.closed_by`,
      );
      assert.deepEqual(
        {
          expected: mxn(d.expected),
          counted: mxn(d.counted),
          closer: d.closer,
          closed: d.closed,
        },
        {
          expected: EXPECTED_S.corteZ.cash.expected,
          counted: EXPECTED_S.corteZ.cash.counted,
          closer: staffS("saul"),
          closed: true,
        },
      );
      const counts = await inS(
        (tx) =>
          tx`select t.name, c.reported::int as reported from drawer_terminal_counts c
            join payment_terminals t on t.id=c.terminal_id order by t.name`,
      );
      assert.deepEqual(
        counts.map((c) => [c.name, mxn(c.reported)]),
        Object.entries(EXPECTED_S.corteZ.terminal.byTerminal).map(([l, v]) => [
          l.replace(/ \(\d+\)$/, ""),
          v.batch,
        ]),
      );
    },
  );

  await check(
    "DS5",
    "Restaurant S's club: one member, enrolled at the counter (never at the kiosk); the member's kiosk order is linked from the kiosk and earned one stamp; the kiosk checkout keeps the member reference",
    async () => {
      const members = await inS(
        (tx) =>
          tx`select id, name, joined_via, stamps::int as stamps from loyalty_members`,
      );
      assert.equal(members.length, 1);
      assert.deepEqual(
        { name: members[0]!.name, via: members[0]!.joined_via },
        { name: CLUB_S.member.name, via: "pos" },
      );
      // Posted by loyalty's reconcile job long before the day closed.
      assert.equal(members[0]!.stamps, EXPECTED_S.club.stampsAfter);
      const links = await inS(
        (tx) =>
          tx`select o.number::int as n, l.via, l.member_id from loyalty_order_links l
            join orders o on o.id=l.order_id order by o.number`,
      );
      const member = ORDERS_S.find((o) => o.member)!;
      assert.deepEqual(
        links.map((l) => [orderS(l.n).id, l.via, l.member_id]),
        [[member.id, "kiosk", members[0]!.id]],
      );
      const [c] = await inS(
        (tx) =>
          tx`select k.loyalty_member_id from kiosk_checkouts k
            join public_order_holds h on h.id=k.hold_id join orders o on o.id=h.order_id
            where o.number=${member.number}`,
      );
      assert.equal(c!.loyalty_member_id, members[0]!.id);
    },
  );

  await check(
    "DS6",
    "Restaurant S's kiosks: two stations on their readers receiving into the register, each with one bound tablet; one checkout per hold with one attempt; Excepciones lists payments' kinds only (two reviews, Saúl's record); nothing dead",
    async () => {
      const stations = await inS(
        (tx) =>
          tx`select l.label, t.name as terminal, dv.name as till,
            (select count(*)::int from kiosk_devices k where k.station_id=s.id and k.revoked_at is null
              and k.paired_at is not null) as tablets
          from kiosk_stations s join public_links l on l.station_id=s.id
          left join payment_terminals t on t.id=s.terminal_id
          left join devices dv on dv.id=s.register_device_id
          order by l.label`,
      );
      assert.deepEqual(
        stations.map((x) => [x.label, x.terminal, x.till, x.tablets]),
        [
          ["Entrada", PAYMENTS_S.terminals.mp.name, "Caja", 1],
          ["Terraza", PAYMENTS_S.terminals.clip.name, "Caja", 1],
        ],
      );
      const checkouts = await inS(
        (tx) =>
          tx`select k.attempt_count::int as attempts, k.payment_choice from kiosk_checkouts k`,
      );
      assert.equal(checkouts.length, ORDERS_S.length);
      for (const c of checkouts)
        assert.deepEqual(c, { attempts: 1, payment_choice: "card" });
      const [restaurant] = await inS(
        (tx) => tx`select name,currency,timezone,cutoff from restaurants`,
      );
      const [owner] = await inS(
        (tx) => tx`select id from employees where role='owner'`,
      );
      const session = {
        id: "00000000-0000-4000-8000-0000000000d5",
        tenantId: S,
        employeeId: owner!.id,
        name: RESTAURANT_S.owner.name,
        role: "owner",
        deviceId: "00000000-0000-4000-8000-000000000000",
        expiresAt: "",
        offlineUntil: "",
        csrf: "",
        restaurant,
      } as unknown as Session;
      const page = await inS((tx) =>
        exceptionRows(tx, session, {
          from: state.businessDateS,
          to: state.businessDateS,
          limit: "500",
        }),
      );
      assert.deepEqual(
        page.rows
          .map((r) => ({
            kind: r.kind,
            order: r.orderNumber,
            amount: mxn(r.amount),
            terminal: r.detail.terminal,
          }))
          .sort(
            (a, b) =>
              a.kind.localeCompare(b.kind) || (a.order ?? 0) - (b.order ?? 0),
          ),
        [
          ...EXPECTED_S.exceptions.recorded.map((x) => ({
            kind: "terminal_attempt_dismissed",
            order: x.number,
            amount: x.amount,
            terminal: x.terminal,
          })),
          ...EXPECTED_S.exceptions.review.map((x) => ({
            kind: "terminal_attempt_review",
            order: x.number,
            amount: x.amount,
            terminal: x.terminal,
          })),
        ],
      );
      const [jobs] = await meta(
        (tx) =>
          tx`select (select count(*)::int from jobs where tenant_id=${S} and state='dead') as dead`,
      );
      assert.deepEqual(jobs, { dead: 0 });
    },
  );

  await sql.end();
  await admin.end();
  if (failed) {
    console.error(
      `Restaurant-day DB reconciliation (branches P and S): ${failed} check(s) failed.`,
    );
    process.exit(1);
  }
  console.log(
    `Restaurant-day DB reconciliation passed (${passed} checks, branches P and S).`,
  );
  process.exit(0);
}

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
