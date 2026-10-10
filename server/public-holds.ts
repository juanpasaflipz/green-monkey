// Staff side of held QR/kiosk orders (032): the Órdenes inbox, the shell
// summary, and the accept/reject decisions. Accepting runs the unmodified
// createOrder or addRound (and recordPayment for pay-first) as the staff
// member: rounds, stock, the kitchen job, the feed bump and, when the accept
// pays the check, its fiscal ticket (027) happen only here.
//
// Lock order (docs/PUBLIC_ORDERING.md): every decision takes its once() key
// (LO-1), restaurants FOR SHARE (LO-2), then the hold row FOR UPDATE (LO-2b)
// before anything else. The nested once() keys are the hold's own
// order_operation_id (LO-R5) and a server-fresh key for the payment.
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { managers, operators, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { requirePro } from "./entitlements.js";
import {
  addRound,
  audit,
  catalog,
  createOrder,
  once,
  recordPayment,
} from "./orders.js";
import { lockLinks, revokeLinkRow, staffOnlineSql } from "./public-links.js";
import { liveAttemptForHold } from "./payments/guards.js";
import {
  applyApprovedAttempt,
  dismissAttempt,
  type AttemptRow,
} from "./payments/terminal.js";
import { linkFromKiosk } from "./loyalty/links.js";
import {
  DomainError,
  quote,
  sum,
  type Order,
  type Product,
  type Session,
} from "../shared/domain.js";
import {
  PAID_ACCEPT_GRACE_SECONDS,
  PUBLIC_LIMITS,
  acceptInput,
  holdLabel,
  rejectInput,
  type HoldPolicy,
  type InboxHold,
  type InboxResponse,
  type InboxSummary,
  type LinkKind,
  type PricedHoldLine,
  type PublicLine,
} from "../shared/public-ordering.js";

export { staffOnlineSql };

/**
 * Shell badge and banner: one indexed statement, no orders read (GAP-4).
 * Expired holds stay 'pending', so live-hold queries also bound created_at to
 * 2 hours: exact under public_order_holds_window (expires_at <= created_at +
 * 2 h), and an index range however much history the tenant has.
 */
export async function inboxSummary(tx: Tx, s: Session): Promise<InboxSummary> {
  permit(s, operators);
  const [r] = await tx`select
      count(*) filter (where h.expires_at>now())::int as pending,
      min(h.created_at) filter (where h.expires_at>now()) as oldest_at,
      exists(select 1 from public_links where revoked_at is null) as active
    from public_order_holds h
    where h.state='pending' and h.created_at>now()-interval '2 hours'`;
  return {
    available: true,
    active: r.active,
    pending: r.pending,
    oldestAt: r.oldest_at ? (r.oldest_at as Date).toISOString() : null,
  };
}

/** Codes a re-quote turns into "Ya no disponible". */
const UNAVAILABLE = new Set([
  "unavailable",
  "invalid_modifier",
  "required_modifier",
  "forbidden",
  "open_amount_exceeds",
  "invalid_amount",
]);

/** Each held line against the current menu: unavailable, a new price, or fine. */
function requote(
  lines: PublicLine[],
  priced: PricedHoldLine[],
  menu: Product[],
): Pick<InboxHold, "lines" | "currentTotal"> {
  let anyUnavailable = false;
  const out = priced.map((shown) => {
    const input = lines.find((l) => l.id === shown.id);
    let current: number | null = null;
    try {
      if (input) {
        const { origin: _origin, ...line } = input;
        current = quote([{ ...line, note: "" }], menu, false)[0].total;
      }
    } catch (e) {
      if (!(e instanceof DomainError) || !UNAVAILABLE.has(e.code)) throw e;
    }
    if (current === null) anyUnavailable = true;
    return {
      ...shown,
      issue:
        current === null
          ? ("unavailable" as const)
          : current !== shown.total
            ? ("price_changed" as const)
            : null,
      currentTotal: current,
    };
  });
  return {
    lines: out,
    currentTotal: anyUnavailable
      ? null
      : sum(out.map((l) => l.currentTotal ?? 0)),
  };
}

/**
 * The Órdenes inbox: at most 5 statements, and 3 when nothing is pending
 * (the catalog and open checks are read only for pending holds).
 */
export async function inbox(tx: Tx, s: Session): Promise<InboxResponse> {
  permit(s, operators);
  const [settings] = await tx`select coalesce(p.paused,false) as paused,
      ${staffOnlineSql(tx)} as staff_online, now() as server_time,
      exists(select 1 from public_links where revoked_at is null) as active
    from (select 1) one left join public_ordering_settings p on true`;
  const rows =
    await tx`select h.id,h.number,h.channel,h.table_id,h.policy,h.name,h.note,
      h.lines,h.priced,h.quoted_total,h.created_at,h.expires_at,
      l.kind,l.label as link_label,l.revoke_reason as link_revoked,t.name as table_name,
      k.hold_id as checkout_hold,k.payment_choice,a.id as attempt_id,a.state as attempt_state,a.error_code as attempt_code,
      a.amount as attempt_amount,a.terminal_label as attempt_terminal,a.provider as attempt_provider
    from public_order_holds h
    join public_links l on l.tenant_id=h.tenant_id and l.id=h.link_id
    left join dining_tables t on t.tenant_id=h.tenant_id and t.id=h.table_id
    left join kiosk_checkouts k on k.tenant_id=h.tenant_id and k.hold_id=h.id
    left join payment_attempts a on a.tenant_id=k.tenant_id and a.id=k.attempt_id
    where h.state='pending'
      and ((h.created_at>now()-interval '2 hours' and h.expires_at>now())
        -- kiosk (039): money taken at the kiosk keeps its card in the inbox past expiry, and
        -- past the 2-hour window while the attempt is live or in review (KIOSK-MONEY-4, R13:
        -- the red card stays while it blocks the receiving till's corte)
        or a.state in ('created','sending','pending','unknown','approved','review'))
    order by (a.state='review') desc nulls last,h.created_at,h.id limit 100`;
  // The recently expired count and the churning codes (ABUSE-2): diner
  // cancellations per scope (a table across its links, or a link) in the
  // window that reached the kind's budget. One statement.
  const [expired] = await tx`select
      (select count(*)::int from public_order_holds
        where state='pending' and expires_at<=now() and expires_at>now()-interval '30 minutes'
          and created_at>now()-interval '150 minutes') as n,
      (select coalesce(json_agg(json_build_object('kind',c.kind,'name',c.name) order by c.name),'[]'::json)
        from (select min(l.kind) as kind,coalesce(min(t.name),min(l.label)) as name,
            count(*)::int as cancelled
          from public_order_holds h
          join public_links l on l.tenant_id=h.tenant_id and l.id=h.link_id
          left join dining_tables t on t.tenant_id=h.tenant_id and t.id=h.table_id
          where h.state='cancelled'
            and h.created_at>now()-make_interval(mins=>${PUBLIC_LIMITS.windowMinutes})
          group by coalesce(h.table_id,h.link_id)) c
        where c.cancelled>=case c.kind when 'table' then ${PUBLIC_LIMITS.table.cancelsPerWindow}::int
          when 'counter' then ${PUBLIC_LIMITS.counter.cancelsPerWindow}::int
          else ${PUBLIC_LIMITS.kiosk.cancelsPerWindow}::int end) as churning`;
  const tableIds = [
    ...new Set(rows.flatMap((r) => (r.table_id ? [r.table_id as string] : []))),
  ];
  const checks = tableIds.length
    ? await tx`select o.id,o.number,o.business_date::text as business_day,o.version,o.check_state,o.total,o.table_id,e.name as waiter_name,
          coalesce((select sum(t.amount) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0)::int as paid
        from orders o
        join employees e on e.tenant_id=o.tenant_id and e.id=coalesce(o.assigned_employee_id,o.employee_id)
        where o.check_state <> 'closed' and o.table_id=any(${tx.array(tableIds)}::uuid[])
        order by o.created_at,o.id`
    : [];
  const menu = rows.length ? await catalog(tx) : [];
  const reason = settings.paused
    ? "paused"
    : !settings.staff_online
      ? "no_staff"
      : null;
  return {
    available: true,
    active: settings.active,
    acceptingNow: reason === null,
    reason,
    paused: settings.paused,
    recentlyExpired: expired.n,
    churning: expired.churning as InboxResponse["churning"],
    serverTime: (settings.server_time as Date).toISOString(),
    holds: rows.map((r) => ({
      id: r.id,
      label: holdLabel(r.channel, r.number),
      kind: r.kind as LinkKind,
      channel: r.channel,
      tableId: r.table_id,
      tableName: r.table_name ?? null,
      linkLabel: r.link_label,
      linkRevoked: (r.link_revoked ?? null) as InboxHold["linkRevoked"],
      name: r.name,
      note: r.note,
      policy: r.policy as HoldPolicy,
      createdAt: (r.created_at as Date).toISOString(),
      expiresAt: (r.expires_at as Date).toISOString(),
      quotedTotal: r.quoted_total,
      ...requote(r.lines as PublicLine[], r.priced as PricedHoldLine[], menu),
      // A pre-039 kiosk link's hold has no checkout: a counter hold, as before 039.
      kiosk:
        r.channel === "kiosk" && r.checkout_hold
          ? {
              paymentChoice: r.payment_choice ?? null,
              attemptId: r.attempt_id ?? null,
              charging: [
                "created",
                "sending",
                "pending",
                "unknown",
                "approved",
              ].includes(r.attempt_state),
              unknown: r.attempt_state === "unknown",
              review:
                r.attempt_state === "review"
                  ? {
                      attemptId: r.attempt_id,
                      code: r.attempt_code ?? "kiosk_settle_other",
                      amount: r.attempt_amount,
                      terminalLabel: r.attempt_terminal,
                      provider: r.attempt_provider,
                    }
                  : null,
            }
          : null,
      openChecks: checks
        .filter((c) => c.table_id === r.table_id)
        .map((c) => ({
          id: c.id,
          number: c.number,
          businessDate: c.business_day,
          version: c.version,
          checkState: c.check_state,
          total: c.total,
          paid: c.paid,
          waiterName: c.waiter_name,
        })),
    })),
  };
}

export type HoldDecisionRow = {
  id: string;
  link_id: string;
  number: number;
  channel: "qr" | "kiosk";
  mode: "dine_in" | "takeaway";
  table_id: string | null;
  policy: HoldPolicy;
  name: string;
  note: string;
  lines: PublicLine[];
  priced: PricedHoldLine[];
  order_operation_id: string;
  state: string;
};

/**
 * LO-2b: the hold row, always the first row lock of a decision. Expiry is
 * judged by the clock once the row is locked (not the transaction start), so
 * a decision that waited for the row cannot start after expires_at; the
 * diner's status gives an accept that commits a moment later a grace
 * (HOLD_EXPIRY_GRACE_SECONDS, CONCURRENCY-2). An accept that carries the
 * payment of a pay-first hold passes up to PAID_ACCEPT_GRACE_SECONDS after
 * expires_at: the cashier already charged the terminal when it arrives
 * (LD-41, PUBLIC-MONEY-2). `paidInTime` (kiosk, critic R12): a card charge
 * started while the hold was valid passes at any time, so the money always
 * becomes an order or a review, and a review stays resolvable (R13).
 */
export async function lockHold(
  tx: Tx,
  holdId: string,
  o: { withPayment?: boolean; paidInTime?: boolean } = {},
): Promise<HoldDecisionRow> {
  const [h] = await tx<
    HoldDecisionRow[]
  >`select * from public_order_holds where id=${holdId} for update`;
  if (!h) throw new DomainError("not_found", 404);
  // Kiosk (039, LO-2b): the checkout row right after its hold, in every decision.
  if (h.channel === "kiosk")
    await tx`select hold_id from kiosk_checkouts where hold_id=${holdId} for update`;
  if (h.state !== "pending")
    throw new DomainError("public_order_not_pending", 409);
  if (o.paidInTime) return h;
  const grace =
    o.withPayment && h.policy === "pay_first" ? PAID_ACCEPT_GRACE_SECONDS : 0;
  // A second statement: the lock statement's own expressions may be computed
  // before it waited for the row.
  const [clock] =
    await tx`select expires_at+make_interval(secs=>${grace})<=clock_timestamp() as expired
      from public_order_holds where id=${holdId}`;
  if (clock.expired) throw new DomainError("public_order_expired", 409);
  return h;
}

export type AcceptResult = {
  hold: { id: string; label: string; state: "accepted" };
  order: Order;
  round: number;
};

/**
 * "Aceptar y enviar a cocina" / "Cobrar y enviar a cocina": the hold becomes a
 * new check or a round on the table's open check, as the staff member, in
 * one transaction. Any throw (stock, drawer, stale target, payment) rolls
 * everything back and the hold stays pending.
 */
export async function acceptHold(
  tx: Tx,
  s: Session,
  holdId: string,
  raw: unknown,
): Promise<AcceptResult> {
  permit(s, operators);
  const p = acceptInput.parse(raw);
  const pay = p.payment;
  // «Aceptar con el pago del kiosco» is a manager's resolution of an approved charge (critic
  // R13: payments' record, with its recent PIN).
  if (pay?.method === "attempt") {
    permit(s, managers);
    requireRecentAuth(s);
  }
  return once(
    tx,
    s,
    p.operationId,
    "public.hold.accept",
    { holdId, ...p },
    async () => {
      if (pay?.method === "attempt") {
        // «Aceptar con el pago del kiosco» (039; critic R13, kiosk §2.7): a kiosk hold whose
        // card charge was approved without an order (review) becomes a new check with that
        // charge as its payment. Lines may be excluded and current prices acknowledged as on
        // any card. No partial refund in v1 (Q5): the total is at least the charge
        // (kiosk_charge_above_total: restore lines, or «Rechazar y reembolsar»); a total above
        // it collects the rest (cash or a manual terminal) here. The charge is payments' manager
        // record into the attempt's own drawer; the rest goes into this device's drawer.
        // Locks: 1 → 2 → 2b (hold → checkout) → 2c (attempt) → 1′ (the hold's order key) →
        // createOrder → linkFromKiosk → 11 (the attempt's drawer) → tender → [12] → [the rest:
        // recordPayment's 11 → tender → 12]: row 58's shape (E8).
        if (p.target.kind !== "new") throw new DomainError("invalid_input");
        const h = await lockHold(tx, holdId, {
          paidInTime: await chargeTakenInTime(tx, holdId, pay.attemptId),
        });
        if (h.channel !== "kiosk") throw new DomainError("invalid_input");
        const a = await lockReviewAttempt(tx, holdId, pay.attemptId);
        if (a.error_code === "payments_refunded_before_settle")
          throw new DomainError("payments_refunded_before_settle", 409);
        const [other] =
          await tx`select id from payment_attempts where hold_id=${holdId} and id<>${a.id}
            and state in ('created','sending','pending','unknown','approved','review') limit 1`;
        if (other) throw new DomainError("kiosk_charge_in_progress", 409);
        // createHoldOrder links the member the guest identified at the kiosk (critic R23).
        const r = await createHoldOrder(tx, s, h, p, true);
        const due = r.order.total - r.order.paid;
        if (due < a.amount)
          throw new DomainError("kiosk_charge_above_total", 409);
        if ((pay.rest?.amount ?? 0) !== due - a.amount)
          throw new DomainError("public_payment_must_cover_total", 409);
        const out = await applyApprovedAttempt(
          tx,
          s,
          a,
          "manager",
          { employeeId: s.employeeId, note: pay.note, reference: null },
          r.order.id,
        );
        if (out.state !== "settled")
          throw new DomainError("payments_settle_order_changed", 409);
        r.order = out.order;
        await audit(tx, s, "payment.terminal_resolved", r.order.id, {
          attemptId: a.id,
          outcome: "recorded",
          note: pay.note,
          via: { kind: "kiosk_accept", holdId },
        });
        if (pay.rest)
          r.order = await recordPayment(tx, s, r.order.id, {
            ...pay.rest,
            operationId: randomUUID(),
          });
        return finishHoldAccept(tx, s, h, p, r, {
          paid: true,
          decisionSource: "staff",
        });
      }
      const h = await lockHold(tx, holdId, { withPayment: !!pay });
      await assertNoKioskCharge(tx, h);
      const r = await createHoldOrder(tx, s, h, p, !!pay, {
        payFirst: await kioskNotAtCounter(tx, h),
      });
      if (pay) {
        if (pay.amount !== r.order.total - r.order.paid)
          throw new DomainError("public_payment_must_cover_total", 409);
        // Server-fresh key (LO-R5, the recordSettlement pattern); the outer
        // once() makes the whole accept, payment included, idempotent.
        r.order = await recordPayment(tx, s, r.order.id, {
          ...pay,
          operationId: randomUUID(),
        });
      }
      return finishHoldAccept(tx, s, h, p, r, {
        paid: !!pay,
        decisionSource: "staff",
      });
    },
  );
}

/**
 * Whether a hold's card charge started while the hold was valid (critic R12): a plain read
 * before lockHold (the attempt's created_at and the hold's expires_at never change).
 */
export async function chargeTakenInTime(
  tx: Tx,
  holdId: string,
  attemptId: string,
): Promise<boolean> {
  const [x] = await tx`select a.created_at<h.expires_at as in_time
    from payment_attempts a join public_order_holds h on h.tenant_id=a.tenant_id and h.id=a.hold_id
    where a.id=${attemptId} and h.id=${holdId}`;
  return x?.in_time === true;
}

/**
 * LO-2c after the hold and its checkout: the hold's own attempt in review with what the provider
 * reported (critic R13). A charge refunded before it was recorded is only ever refunded.
 */
async function lockReviewAttempt(
  tx: Tx,
  holdId: string,
  attemptId: string,
): Promise<AttemptRow> {
  const [a] = await tx<AttemptRow[]>`select * from payment_attempts
    where id=${attemptId} and hold_id=${holdId} for update`;
  if (!a) throw new DomainError("payments_attempt_not_found", 404);
  if (a.state !== "review" || a.paid_amount === null)
    throw new DomainError("payments_not_approved", 409);
  return a;
}

/**
 * A kiosk hold the guest has not sent to the counter (KIOSK-UX-04, KIOSK-MONEY-3; kiosk spec
 * §2.5): still at the kiosk with no choice yet, or a card checkout that never paid (a decline, a
 * walk-away, a review refunded at the provider). Staff take it pay-first whatever the counter
 * policy: «Cobrar y enviar a cocina», or a manager's exception, never a plain accept that fires
 * an unpaid order. Only «Pagar en caja» (or a kiosk that could not take cards) makes it a normal
 * card. A plain read after LO-2b (lockHold locked the checkout).
 */
async function kioskNotAtCounter(tx: Tx, h: HoldDecisionRow) {
  if (h.channel !== "kiosk") return false;
  const [c] =
    await tx`select payment_choice from kiosk_checkouts where hold_id=${h.id}`;
  return !!c && c.payment_choice !== "counter";
}

/**
 * Staff decisions on a kiosk hold refuse while payments may still take or has taken its card
 * charge (critic R12: a plain read after LO-2b and the checkout). An approved but unapplied
 * charge (review) is resolved from its red card, never by a plain accept or reject.
 */
export async function assertNoKioskCharge(tx: Tx, h: HoldDecisionRow) {
  if (h.channel !== "kiosk") return;
  if (await liveAttemptForHold(tx, h.id))
    throw new DomainError("kiosk_charge_in_progress", 409);
}

type AcceptBody = Pick<
  ReturnType<typeof acceptInput.parse>,
  "target" | "excludeLineIds" | "acknowledgedTotal" | "abuseAcknowledged"
> & { operationId?: string };

/** What createHoldOrder hands to finishHoldAccept. */
export type HoldOrder = {
  order: Order;
  round: number;
  roundTotal: number;
  charged: { id: string; unit_price: number; total: number }[];
  excluded: Set<string>;
  override: boolean;
  abuse: boolean;
  label: string;
  priceChanged: boolean;
};

/**
 * The accept's first half, after the hold (and, for a kiosk hold, its checkout) is locked (kiosk
 * spec §7.3: shared by acceptHold and the kiosk's own accepts): checks, then createOrder or
 * addRound on the hold's own order key, and the round it charged. `paid` says the caller records
 * the payment before finishHoldAccept (staff: recordPayment; kiosk: payments'
 * applyApprovedAttempt). A kiosk hold's member is linked here, right after createOrder (critic
 * R23), so every caller's tender and refresh see the link.
 */
export async function createHoldOrder(
  tx: Tx,
  s: Session,
  h: HoldDecisionRow,
  p: AcceptBody,
  paid: boolean,
  /** Take the hold pay-first whatever its policy (a kiosk hold not sent to the counter). */
  o: { payFirst?: boolean } = {},
): Promise<HoldOrder> {
  // Both targets: addRound alone would only check requireSelling.
  await requirePro(tx);
  if (paid && p.target.kind !== "new") throw new DomainError("invalid_input");
  // ABUSE-1: a code deactivated as abuse may still carry real diners'
  // orders, so its holds are accepted only after staff verified them.
  const [link] =
    await tx`select revoke_reason from public_links where id=${h.link_id}`;
  const abuse = link?.revoke_reason === "abuse";
  if (abuse && !p.abuseAcknowledged)
    throw new DomainError("public_hold_link_abuse", 409);
  const ids = new Set(h.lines.map((l) => l.id));
  const excluded = new Set(p.excludeLineIds);
  if ([...excluded].some((x) => !ids.has(x)) || excluded.size >= ids.size)
    throw new DomainError("invalid_input");
  const lines = h.lines
    .filter((l) => !excluded.has(l.id))
    .map(({ origin: _origin, ...l }) => ({ ...l, note: "" }));
  const quoted = sum(
    h.priced.filter((l) => !excluded.has(l.id)).map((l) => l.total),
  );
  // Menu errors (unavailable, invalid_modifier, …) pass through.
  const current = sum(
    quote(lines, await catalog(tx), false).map((l) => l.total),
  );
  // MONEY-1: the total staff saw. A changed price needs the exact new
  // total acknowledged; any acknowledged total must be the current one.
  if (
    (current !== quoted || p.acknowledgedTotal !== null) &&
    p.acknowledgedTotal !== current
  )
    throw new DomainError("public_hold_price_changed", 409);
  // Nothing to collect on a free order.
  if (paid && current === 0) throw new DomainError("invalid_input");
  const override =
    (h.policy === "pay_first" || !!o.payFirst) && !paid && current > 0;
  if (override) {
    if (!managers.includes(s.role))
      throw new DomainError("public_payment_required", 409);
    // LD-2: a manager acting alone on a shared terminal confirms with a fresh PIN.
    requireRecentAuth(s);
  }
  const label = holdLabel(h.channel, h.number);
  let order: Order;
  if (p.target.kind === "new") {
    // MONEY-2: the diner knows the order only by its label (Q-14/K-14),
    // so the label leads the call name (KDS, kitchen ticket, Órdenes) and
    // the order note (the receipt prints it, LD-1).
    order = await createOrder(tx, s, {
      operationId: h.order_operation_id,
      lines,
      mode: h.mode,
      tableId: h.table_id,
      name: [label, h.name].filter(Boolean).join(" · "),
      note: [label, h.note].filter(Boolean).join(" · "),
      channel: h.channel,
    });
  } else {
    const [o] =
      await tx`select id,table_id,check_state from orders where id=${p.target.orderId}`;
    // Only an open check of the hold's own table: a check gets its fiscal
    // ticket when it is paid and takes no rounds afterwards (fiscal D1,
    // LD-15 fiscal Q2; LD-P15 OQ-4).
    if (
      !h.table_id ||
      !o ||
      o.table_id !== h.table_id ||
      o.check_state !== "open"
    )
      throw new DomainError("public_hold_target_invalid", 409);
    // The round note carries the label and the kitchen note, never the
    // diner's name: round notes print on the shared check's receipt
    // (PRIVACY-3, LD-1).
    try {
      order = await addRound(tx, s, o.id, {
        operationId: h.order_operation_id,
        lines,
        mode: "dine_in",
        tableId: h.table_id,
        name: "",
        channel: h.channel,
        expectedVersion: p.target.expectedVersion,
        note: [label, h.note].filter(Boolean).join(" · ").slice(0, 500),
      });
    } catch (e) {
      // The check above read the target without a lock. A payment that
      // settled it since issued its ticket, and addRound refuses a
      // ticketed check under the order lock: the same answer as any
      // target that is no longer open (the whole accept rolls back).
      if (e instanceof DomainError && e.code === "fiscal_ticket_issued")
        throw new DomainError("public_hold_target_invalid", 409);
      throw e;
    }
  }
  // The member the guest identified at the kiosk (critic R23, kiosk spec §2.10; KIOSK-UX-01):
  // linked right after createOrder on every path that creates a kiosk hold's order (the
  // kiosk's own accepts, the hold settle, «Cobrar y enviar», a staff accept of a «Pagar en caja»
  // hold, a manager's exception, «Aceptar con el pago del kiosco»), before any tender or
  // refresh, so the settle hook stamps it once. A plain read after LO-2b (lockHold locked the
  // checkout).
  if (h.channel === "kiosk" && p.target.kind === "new") {
    const [c] =
      await tx`select loyalty_member_id from kiosk_checkouts where hold_id=${h.id}`;
    if (c?.loyalty_member_id)
      await linkFromKiosk(tx, s, order.id, c.loyalty_member_id as string);
  }
  // The round this hold became: read, never derived from order.version
  // (a void bumps the version without inserting a round).
  const [{ round }] =
    await tx`select max(number)::int as round from rounds where order_id=${order.id}`;
  // What the round actually charged: createOrder/addRound re-read the
  // menu, so a change committed since the check above is caught here and
  // rolls everything back (MONEY-1).
  const charged = await tx<
    { id: string; unit_price: number; total: number }[]
  >`select id,(data->>'unitPrice')::int as unit_price,(data->>'total')::int as total
    from order_lines where order_id=${order.id} and round=${round} order by id`;
  const roundTotal = sum(charged.map((l) => l.total));
  if (
    roundTotal !== current ||
    charged.length !== lines.length ||
    charged.some((l) => !ids.has(l.id) || excluded.has(l.id))
  )
    throw new DomainError("public_hold_price_changed", 409);
  // CONCURRENCY-3: the target's state was read without a lock; a payment
  // that settled it in between leaves its version unchanged. A check that
  // was fully paid before this round refuses it (rolled back). With
  // fiscal tickets on, addRound already refused it above; this guard
  // covers a check paid while issuance was off (FISCAL_TICKETS_ENABLED).
  if (p.target.kind === "append") {
    const before = order.total - roundTotal;
    if (before > 0 && order.paid >= before)
      throw new DomainError("public_hold_target_invalid", 409);
  }
  return {
    order,
    round,
    roundTotal,
    charged,
    excluded,
    override,
    abuse,
    label,
    priceChanged: current !== quoted,
  };
}

/** The accept's second half: the last abuse check, the decision and its audit row. */
export async function finishHoldAccept(
  tx: Tx,
  s: Session,
  h: HoldDecisionRow,
  p: AcceptBody,
  r: HoldOrder,
  o: { paid: boolean; decisionSource: "staff" | "kiosk" },
): Promise<AcceptResult> {
  const holdId = h.id;
  const {
    order,
    round,
    roundTotal,
    charged,
    excluded,
    override,
    abuse,
    label,
  } = r;
  const paid = o.paid;
  // ABUSE-1 again, as the last read before the decision: a sibling's
  // abuse rejection locks only its own hold, so nothing above waited for
  // it. Under READ COMMITTED this statement sees one that committed while
  // createOrder/addRound ran, and the whole accept rolls back (PUB-HR-2).
  const [linkNow] =
    await tx`select revoke_reason from public_links where id=${h.link_id}`;
  const abuseNow = abuse || linkNow?.revoke_reason === "abuse";
  if (abuseNow && !p.abuseAcknowledged)
    throw new DomainError("public_hold_link_abuse", 409);
  await tx`update public_order_holds set state='accepted',decided_at=clock_timestamp(),
      decided_by=${s.employeeId},order_id=${order.id},order_round=${round},
      excluded_line_ids=${tx.array([...excluded])}::uuid[],
      paid_at_accept=${paid},policy_override=${override},
      decision_source=${o.decisionSource},
      accepted_total=${roundTotal},
      accepted_lines=${tx.json(charged.map((l) => ({ id: l.id, unitPrice: l.unit_price, total: l.total })))}
    where id=${holdId}`;
  await audit(tx, s, "public.hold_accepted", holdId, {
    orderId: order.id,
    label,
    target: p.target.kind,
    round,
    paid,
    override,
    ...(o.decisionSource === "kiosk" ? { via: { kind: "kiosk" } } : {}),
    excluded: excluded.size,
    priceChanged: r.priceChanged,
    total: roundTotal,
    ...(abuseNow ? { abuseAcknowledged: true } : {}),
  });
  return {
    hold: { id: holdId, label, state: "accepted" as const },
    order,
    round,
  };
}

/**
 * "Rechazar": any operator, no PIN. With revokeLink (managers, "abuso") the
 * hold's link is deactivated in the same transaction, after the hold row.
 */
export async function rejectHold(
  tx: Tx,
  s: Session,
  holdId: string,
  raw: unknown,
): Promise<{
  hold: { id: string; label: string; state: "rejected" };
  revokedLink: boolean;
}> {
  permit(s, operators);
  const p = rejectInput.parse(raw);
  if (p.revokeLink) permit(s, managers);
  // «Rechazar y reembolsar» (critic R13): payments' refunded_at_provider, a manager's with a
  // recent PIN.
  if (p.refund) {
    permit(s, managers);
    requireRecentAuth(s);
  }
  const refund = p.refund;
  return once(
    tx,
    s,
    p.operationId,
    "public.hold.reject",
    { holdId, ...p },
    async () => {
      const h = await lockHold(
        tx,
        holdId,
        refund
          ? {
              paidInTime: await chargeTakenInTime(tx, holdId, refund.attemptId),
            }
          : {},
      );
      if (refund) {
        // LO-2c after the hold and its checkout; the dismissal names the provider refund.
        if (h.channel !== "kiosk") throw new DomainError("invalid_input");
        const a = await lockReviewAttempt(tx, holdId, refund.attemptId);
        await dismissAttempt(tx, s, a, "refunded_at_provider", refund.note);
      }
      await assertNoKioskCharge(tx, h);
      await tx`update public_order_holds set state='rejected',reject_reason=${p.reason},
          decided_at=clock_timestamp(),decided_by=${s.employeeId}
        where id=${holdId}`;
      let revokedLink = false;
      if (p.revokeLink) {
        await lockLinks(tx);
        await tx`select id from public_links where id=${h.link_id} for update`;
        revokedLink = await revokeLinkRow(tx, s, h.link_id, "abuse");
      }
      const label = holdLabel(h.channel, h.number);
      await audit(tx, s, "public.hold_rejected", holdId, {
        reason: p.reason,
        label,
        revokedLink,
        ...(refund ? { refundedAttemptId: refund.attemptId } : {}),
      });
      return {
        hold: { id: holdId, label, state: "rejected" as const },
        revokedLink,
      };
    },
  );
}
