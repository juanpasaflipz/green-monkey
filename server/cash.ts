// Drawer (cash session) reads and the close/review commands (028). Cash and
// external-terminal money are separated: only cash refunds reduce expected
// cash, card tips never inflate it, and roles that may not see expected cash
// get a redacted summary from the server (blind count, MON-9 / FIT-10).
// Lock order: closeCash / closeDrawerRow 1 → 2 → 11; reviewDrawer 1 → 2 → 11
// (FOR SHARE).
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { managers, operators, permit } from "./auth.js";
import { audit, drawer, once } from "./orders.js";
import { moneyControls } from "./discounts.js";
import { DomainError, type Session } from "../shared/domain.js";
import {
  canCloseDrawer,
  canSeeExpected,
  cashCloseInput,
  cashReviewInput,
} from "../shared/discounts.js";

export type DrawerTotals = {
  opening: number;
  cashSales: number;
  cashTips: number;
  cashRefunds: number;
  movements: number;
  expectedCash: number;
  externalSales: number;
  externalTips: number;
  externalRefunds: number;
  externalNet: number;
  paymentCount: number;
  externalCount: number;
};

/**
 * Totals of one drawer in one statement. Expected cash = opening + cash sales
 * and tips − cash refunds + movements (paid-outs are negative); terminal money
 * is reported apart and never counted as cash. Exported for reports 029.
 */
export async function drawerTotals(
  tx: Tx,
  drawerId: string,
): Promise<DrawerTotals> {
  const [r] = await tx`select c.opening,
      coalesce(t.cash_sales,0)::int as cash_sales,coalesce(t.cash_tips,0)::int as cash_tips,
      coalesce(t.external_sales,0)::int as external_sales,coalesce(t.external_tips,0)::int as external_tips,
      coalesce(t.payments,0)::int as payments,coalesce(t.external_count,0)::int as external_count,
      coalesce(f.cash,0)::int as cash_refunds,coalesce(f.external,0)::int as external_refunds,
      coalesce(m.amount,0)::int as movements
    from cash_sessions c
    left join lateral (select sum(amount) filter (where method='cash') as cash_sales,
        sum(tip) filter (where method='cash') as cash_tips,
        sum(amount) filter (where method='external') as external_sales,
        sum(tip) filter (where method='external') as external_tips,
        count(*) as payments,count(*) filter (where method='external') as external_count
      from tenders where tenant_id=c.tenant_id and session_id=c.id) t on true
    left join lateral (select sum(amount) filter (where method='cash') as cash,
        sum(amount) filter (where method='external') as external
      from refunds where tenant_id=c.tenant_id and session_id=c.id) f on true
    left join lateral (select sum(amount) as amount from cash_movements
      where tenant_id=c.tenant_id and session_id=c.id) m on true
    where c.id=${drawerId}`;
  if (!r) throw new DomainError("not_found", 404);
  const expectedCash =
    r.opening + r.cash_sales + r.cash_tips - r.cash_refunds + r.movements;
  return {
    opening: r.opening,
    cashSales: r.cash_sales,
    cashTips: r.cash_tips,
    cashRefunds: r.cash_refunds,
    movements: r.movements,
    expectedCash,
    externalSales: r.external_sales,
    externalTips: r.external_tips,
    externalRefunds: r.external_refunds,
    externalNet: r.external_sales + r.external_tips - r.external_refunds,
    paymentCount: r.payments,
    externalCount: r.external_count,
  };
}

export type CashView = Record<string, unknown> & {
  id: string;
  opened_at: string;
  closed_at: string | null;
  opening: number;
  visibility: "full" | "blind";
  canClose: boolean;
  blindClose: boolean;
  openedByName: string;
  closedByName: string | null;
  countMode: "blind" | "visible" | null;
  external: {
    sales: number;
    tips: number;
    refunds: number;
    net: number;
    count: number;
    reported: number | null;
    difference: number | null;
    /** Terminal payments recorded after the close (late offline sync); not in the close snapshot. */
    late: number;
  };
  paymentCount: number;
  expected: number | null;
  closedExpected: number | null;
  lateRecovery: number | null;
  discrepancy: number | null;
  originalDiscrepancy: number | null;
  counted: number | null;
  cash: {
    sales: number;
    tips: number;
    refunds: number;
    movements: number;
    expected: number;
  } | null;
  tenders: unknown[];
  refunds: unknown[];
  movements: unknown[];
  review: { note: string; reviewerName: string; at: string } | null;
};

/**
 * This device's latest drawer, or one drawer by id (managers). Keeps the legacy
 * keys old bundles and offline read (id, opened_at, closed_at for every role).
 * Roles that may not see expected cash get no expected, cash figures, cash
 * tenders, cash refunds or movements (blind count).
 */
export async function cashSummary(
  tx: Tx,
  s: Session,
  drawerId?: string,
): Promise<CashView | null> {
  if (drawerId) permit(s, managers);
  const [d] = drawerId
    ? await tx`select c.*,o.name as opened_by_name,cl.name as closed_by_name from cash_sessions c
        join employees o on o.tenant_id=c.tenant_id and o.id=c.employee_id
        left join employees cl on cl.tenant_id=c.tenant_id and cl.id=c.closed_by
        where c.id=${drawerId}`
    : await tx`select c.*,o.name as opened_by_name,cl.name as closed_by_name from cash_sessions c
        join employees o on o.tenant_id=c.tenant_id and o.id=c.employee_id
        left join employees cl on cl.tenant_id=c.tenant_id and cl.id=c.closed_by
        where c.device_id=${s.deviceId} order by c.opened_at desc limit 1`;
  if (!d) return null;
  const controls = await moneyControls(tx);
  const totals = await drawerTotals(tx, d.id);
  const tenders =
    await tx`select * from tenders where session_id=${d.id} order by created_at,id`;
  const refunds =
    await tx`select * from refunds where session_id=${d.id} order by created_at,id`;
  const movements =
    await tx`select * from cash_movements where session_id=${d.id} order by created_at,id`;
  const [review] = await tx`select r.note,e.name as reviewer_name,r.created_at
    from cash_count_reviews r join employees e on e.tenant_id=r.tenant_id and e.id=r.reviewer_id
    where r.drawer_id=${d.id}`;
  const closedAt = d.closed_at ? new Date(d.closed_at).getTime() : null;
  const late = (method: string) =>
    closedAt === null
      ? 0
      : tenders
          .filter(
            (t) =>
              t.method === method &&
              new Date(t.created_at).getTime() > closedAt,
          )
          .reduce((sum, t) => sum + t.amount + t.tip, 0);
  const { opened_by_name, closed_by_name, ...row } = d;
  const external = {
    sales: totals.externalSales,
    tips: totals.externalTips,
    refunds: totals.externalRefunds,
    net: totals.externalNet,
    count: totals.externalCount,
    reported: d.external_reported ?? null,
    difference:
      d.external_reported === null ||
      d.external_reported === undefined ||
      d.external_expected === null ||
      d.external_expected === undefined
        ? null
        : d.external_reported - d.external_expected,
    late: late("external"),
  };
  const common = {
    visibility: "full" as "full" | "blind",
    canClose: canCloseDrawer(s.role, controls),
    blindClose: controls.blindClose,
    openedByName: opened_by_name as string,
    closedByName: (closed_by_name ?? null) as string | null,
    countMode: (d.count_mode ?? null) as "blind" | "visible" | null,
    external,
    paymentCount: totals.paymentCount,
  };
  if (!canSeeExpected(s.role, controls))
    return {
      ...row,
      ...common,
      visibility: "blind",
      expected: null,
      closedExpected: null,
      lateRecovery: null,
      discrepancy: null,
      originalDiscrepancy: null,
      counted: null,
      reason: null,
      cash: null,
      tenders: tenders.filter((t) => t.method === "external"),
      refunds: refunds.filter((r) => r.method === "external"),
      movements: [],
      review: null,
    } as unknown as CashView;
  return {
    ...row,
    ...common,
    originalDiscrepancy: d.counted === null ? null : d.counted - d.expected,
    closedExpected: d.expected,
    lateRecovery: late("cash"),
    expected: totals.expectedCash,
    tenders,
    refunds,
    movements,
    discrepancy: d.counted === null ? null : d.counted - totals.expectedCash,
    cash: {
      sales: totals.cashSales,
      tips: totals.cashTips,
      refunds: totals.cashRefunds,
      movements: totals.movements,
      expected: totals.expectedCash,
    },
    review: review
      ? {
          note: review.note,
          reviewerName: review.reviewer_name,
          at: new Date(review.created_at).toISOString(),
        }
      : null,
  } as unknown as CashView;
}

/** Closed drawers, newest first (managers): closer, count mode, terminal figures and review. */
export async function cashHistory(tx: Tx, s: Session, offset: number) {
  permit(s, managers);
  return tx`select c.id,c.opened_at,c.closed_at,d.name as device_name,
    c.expected,c.counted,c.reason,
    coalesce((select sum(t.amount+t.tip) from tenders t where t.session_id=c.id and t.method='cash' and t.created_at>c.closed_at),0)::int as late_recovery,
    coalesce((select sum(t.amount+t.tip) from tenders t where t.session_id=c.id and t.method='external' and t.created_at>c.closed_at),0)::int as late_external,
    (select jsonb_agg(distinct o.restaurant_snapshot->>'currency') from tenders t join orders o on o.tenant_id=t.tenant_id and o.id=t.order_id where t.session_id=c.id) as currencies,
    opener.name as opened_by_name,closer.name as closed_by_name,c.count_mode,
    c.external_expected,c.external_reported,
    r.note as review_note,rv.name as reviewer_name,r.created_at as reviewed_at,
    (c.counted <> c.expected and r.id is null) as needs_review
    from cash_sessions c join devices d on d.tenant_id=c.tenant_id and d.id=c.device_id
    join employees opener on opener.tenant_id=c.tenant_id and opener.id=c.employee_id
    left join employees closer on closer.tenant_id=c.tenant_id and closer.id=c.closed_by
    left join cash_count_reviews r on r.tenant_id=c.tenant_id and r.drawer_id=c.id
    left join employees rv on rv.tenant_id=r.tenant_id and rv.id=r.reviewer_id
    where c.closed_at is not null order by c.closed_at desc,c.id limit 50 offset ${offset}`;
}

/**
 * Steps 3–6 of closeCash for an already-locked open drawer row (reports' exact
 * signature: its remote close reuses it and never edits this file). Blind mode
 * never answers reason_required, so a retry cannot reveal expected cash.
 */
export async function closeDrawerRow(
  tx: Tx,
  s: Session,
  d: { id: string },
  p: { counted: number; reason: string; externalReported?: number | null },
  mode: "blind" | "visible",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const totals = await drawerTotals(tx, d.id);
  if (
    mode === "visible" &&
    totals.expectedCash !== p.counted &&
    p.reason.trim().length < 3
  )
    throw new DomainError("reason_required");
  const closed =
    await tx`update cash_sessions set counted=${p.counted},expected=${totals.expectedCash},
      reason=${p.reason},closed_at=clock_timestamp(),closed_by=${s.employeeId},count_mode=${mode},
      external_expected=${totals.externalNet},external_reported=${p.externalReported ?? null}
    where id=${d.id} and closed_at is null returning id`;
  if (!closed.length) throw new DomainError("drawer_required", 409);
  await audit(tx, s, "cash.close", d.id, {
    counted: p.counted,
    expected: totals.expectedCash,
    discrepancy: p.counted - totals.expectedCash,
    countMode: mode,
    externalExpected: totals.externalNet,
    externalReported: p.externalReported ?? null,
    ...extra,
  });
}

/** Counts and closes this device's drawer; the result is redacted for blind roles. */
export async function closeCash(tx: Tx, s: Session, raw: unknown) {
  permit(s, operators);
  const controls = await moneyControls(tx);
  if (!canCloseDrawer(s.role, controls))
    throw new DomainError("cash_close_not_allowed", 403);
  const p = cashCloseInput.parse(raw);
  // Unchanged kind and fingerprint: a legacy body hashes as before (I-17).
  return once(tx, s, p.operationId, "cash.close", p, async () => {
    const mode =
      controls.blindClose || !canSeeExpected(s.role, controls)
        ? "blind"
        : "visible";
    const d = (await drawer(tx, s)) as { id: string };
    await closeDrawerRow(tx, s, d, p, mode);
    return cashSummary(tx, s);
  });
}

/** One immutable manager review of a closed drawer's cash difference. */
export async function reviewDrawer(
  tx: Tx,
  s: Session,
  drawerId: string,
  raw: unknown,
) {
  permit(s, managers);
  const p = cashReviewInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "cash.review",
    { drawerId, ...p },
    async () => {
      const [d] =
        await tx`select id,closed_at,counted,expected from cash_sessions where id=${drawerId} for share`;
      if (!d) throw new DomainError("not_found", 404);
      if (!d.closed_at || d.counted === d.expected)
        throw new DomainError("cash_review_not_needed", 409);
      const [r] =
        await tx`insert into cash_count_reviews(tenant_id,id,drawer_id,reviewer_id,note)
        values(${s.tenantId},${randomUUID()},${drawerId},${s.employeeId},${p.note})
        on conflict (tenant_id,drawer_id) do nothing returning id`;
      if (!r) throw new DomainError("cash_review_exists", 409);
      await audit(tx, s, "cash.reviewed", drawerId, { drawerId, note: p.note });
      return cashSummary(tx, s, drawerId);
    },
  );
}
