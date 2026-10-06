// Staff side of held QR/kiosk orders (032): the Órdenes inbox, the shell
// summary, and the accept/reject decisions. Accepting runs the unmodified
// createOrder or addRound (and recordPayment for pay-first) as the staff
// member: rounds, stock, the kitchen job and the feed bump happen only here.
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
import {
  DomainError,
  quote,
  sum,
  type Order,
  type Product,
  type Session,
} from "../shared/domain.js";
import {
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

/** Shell badge and banner: one indexed statement, no orders read (GAP-4). */
export async function inboxSummary(tx: Tx, s: Session): Promise<InboxSummary> {
  permit(s, operators);
  const [r] = await tx`select
      count(*) filter (where h.expires_at>now())::int as pending,
      min(h.created_at) filter (where h.expires_at>now()) as oldest_at,
      exists(select 1 from public_links where revoked_at is null) as active
    from public_order_holds h where h.state='pending'`;
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
      if (input)
        current = quote([{ ...input, note: "" }], menu, false)[0].total;
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
      ${staffOnlineSql(tx)} as staff_online, now() as server_time
    from (select 1) one left join public_ordering_settings p on true`;
  const rows =
    await tx`select h.id,h.number,h.channel,h.table_id,h.policy,h.name,h.note,
      h.lines,h.priced,h.quoted_total,h.created_at,h.expires_at,
      l.kind,l.label as link_label,t.name as table_name
    from public_order_holds h
    join public_links l on l.tenant_id=h.tenant_id and l.id=h.link_id
    left join dining_tables t on t.tenant_id=h.tenant_id and t.id=h.table_id
    where h.state='pending' and h.expires_at>now()
    order by h.created_at,h.id limit 100`;
  const [expired] = await tx`select count(*)::int as n from public_order_holds
    where state='pending' and expires_at<=now() and expires_at>now()-interval '30 minutes'`;
  const tableIds = [
    ...new Set(rows.flatMap((r) => (r.table_id ? [r.table_id as string] : []))),
  ];
  const checks = tableIds.length
    ? await tx`select o.id,o.number,o.version,o.check_state,o.total,o.table_id,e.name as waiter_name,
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
    acceptingNow: reason === null,
    reason,
    paused: settings.paused,
    recentlyExpired: expired.n,
    serverTime: (settings.server_time as Date).toISOString(),
    holds: rows.map((r) => ({
      id: r.id,
      label: holdLabel(r.channel, r.number),
      kind: r.kind as LinkKind,
      channel: r.channel,
      tableId: r.table_id,
      tableName: r.table_name ?? null,
      linkLabel: r.link_label,
      name: r.name,
      note: r.note,
      policy: r.policy as HoldPolicy,
      createdAt: (r.created_at as Date).toISOString(),
      expiresAt: (r.expires_at as Date).toISOString(),
      quotedTotal: r.quoted_total,
      ...requote(r.lines as PublicLine[], r.priced as PricedHoldLine[], menu),
      openChecks: checks
        .filter((c) => c.table_id === r.table_id)
        .map((c) => ({
          id: c.id,
          number: c.number,
          version: c.version,
          checkState: c.check_state,
          total: c.total,
          paid: c.paid,
          waiterName: c.waiter_name,
        })),
    })),
  };
}

type HoldDecisionRow = {
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
  expired: boolean;
};

/** LO-2b: the hold row, always the first row lock of a decision. */
async function lockHold(tx: Tx, holdId: string): Promise<HoldDecisionRow> {
  const [h] = await tx<
    HoldDecisionRow[]
  >`select *,expires_at<=now() as expired from public_order_holds where id=${holdId} for update`;
  if (!h) throw new DomainError("not_found", 404);
  if (h.state !== "pending")
    throw new DomainError("public_order_not_pending", 409);
  if (h.expired) throw new DomainError("public_order_expired", 409);
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
  return once(
    tx,
    s,
    p.operationId,
    "public.hold.accept",
    { holdId, ...p },
    async () => {
      const h = await lockHold(tx, holdId);
      // Both targets: addRound alone would only check requireSelling.
      await requirePro(tx);
      if (p.payment && p.target.kind !== "new")
        throw new DomainError("invalid_input");
      const ids = new Set(h.lines.map((l) => l.id));
      const excluded = new Set(p.excludeLineIds);
      if ([...excluded].some((x) => !ids.has(x)) || excluded.size >= ids.size)
        throw new DomainError("invalid_input");
      const lines = h.lines
        .filter((l) => !excluded.has(l.id))
        .map((l) => ({ ...l, note: "" }));
      const quoted = sum(
        h.priced.filter((l) => !excluded.has(l.id)).map((l) => l.total),
      );
      // Menu errors (unavailable, invalid_modifier, …) pass through.
      const current = sum(
        quote(lines, await catalog(tx), false).map((l) => l.total),
      );
      if (current !== quoted && !p.priceChangeAcknowledged)
        throw new DomainError("public_hold_price_changed", 409);
      // Nothing to collect on a free order.
      if (p.payment && current === 0) throw new DomainError("invalid_input");
      const override = h.policy === "pay_first" && !p.payment && current > 0;
      if (override) {
        if (!managers.includes(s.role))
          throw new DomainError("public_payment_required", 409);
        // LD-2: a manager acting alone on a shared terminal confirms with a fresh PIN.
        requireRecentAuth(s);
      }
      let order: Order;
      if (p.target.kind === "new") {
        order = await createOrder(tx, s, {
          operationId: h.order_operation_id,
          lines,
          mode: h.mode,
          tableId: h.table_id,
          name: h.name,
          note: h.note,
          channel: h.channel,
        });
      } else {
        const [o] =
          await tx`select id,table_id,check_state from orders where id=${p.target.orderId}`;
        // Only an open check of the hold's own table (a paid check takes no
        // rounds once fiscal tickets exist, 027).
        if (
          !h.table_id ||
          !o ||
          o.table_id !== h.table_id ||
          o.check_state !== "open"
        )
          throw new DomainError("public_hold_target_invalid", 409);
        order = await addRound(tx, s, o.id, {
          operationId: h.order_operation_id,
          lines,
          mode: "dine_in",
          tableId: h.table_id,
          name: "",
          channel: h.channel,
          expectedVersion: p.target.expectedVersion,
          note: [holdLabel(h.channel, h.number), h.name, h.note]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 500),
        });
      }
      // The round this hold became: read, never derived from order.version
      // (a void bumps the version without inserting a round).
      const [{ round }] =
        await tx`select max(number)::int as round from rounds where order_id=${order.id}`;
      if (p.payment) {
        if (p.payment.amount !== order.total - order.paid)
          throw new DomainError("public_payment_must_cover_total", 409);
        // Server-fresh key (LO-R5, the recordSettlement pattern); the outer
        // once() makes the whole accept, payment included, idempotent.
        order = await recordPayment(tx, s, order.id, {
          ...p.payment,
          operationId: randomUUID(),
        });
      }
      await tx`update public_order_holds set state='accepted',decided_at=clock_timestamp(),
          decided_by=${s.employeeId},order_id=${order.id},order_round=${round},
          excluded_line_ids=${tx.array(p.excludeLineIds)}::uuid[],
          paid_at_accept=${!!p.payment},policy_override=${override}
        where id=${holdId}`;
      const label = holdLabel(h.channel, h.number);
      await audit(tx, s, "public.hold_accepted", holdId, {
        orderId: order.id,
        label,
        target: p.target.kind,
        round,
        paid: !!p.payment,
        override,
        excluded: p.excludeLineIds.length,
        priceChanged: current !== quoted,
      });
      return {
        hold: { id: holdId, label, state: "accepted" as const },
        order,
        round,
      };
    },
  );
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
  return once(
    tx,
    s,
    p.operationId,
    "public.hold.reject",
    { holdId, ...p },
    async () => {
      const h = await lockHold(tx, holdId);
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
      });
      return {
        hold: { id: holdId, label, state: "rejected" as const },
        revokedLink,
      };
    },
  );
}
