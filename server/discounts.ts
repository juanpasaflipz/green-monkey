// Discounts and courtesies (028): money controls, apply and reverse, and the
// readers fiscal (discountsByLine) and getOrders (adjustmentRows) consume.
// Lock order (docs/ARCHITECTURE.md, global lock order): applyDiscount
// 1 → 2 → 5 → 5a → 8 → [refresh → 12]; reverseDiscount 1 → 2 → 5 → 5a → 8;
// saveMoneyControls 1 → 2 → 3 (area key class 929). None of them bumps the kitchen feed or takes
// the drawer.
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { operators, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { requireSelling } from "./free-limits.js";
import { audit, getOrder, once } from "./orders.js";
import { assertCheckWritable, refreshCheckState } from "./checks.js";
import { assertNoFiscalTicket } from "./fiscal.js";
import { DomainError, type Order, type Session } from "../shared/domain.js";
import {
  canCloseDrawer,
  canSeeExpected,
  DEFAULT_MONEY_CONTROLS,
  discountInput,
  discountInputIssue,
  discountLimitCheck,
  discountPlanMatches,
  discountReverseInput,
  moneyControlsInput,
  planDiscount,
  type AdjustmentRow,
  type MoneyControls,
  type MoneyControlsView,
  type StaffRole,
} from "../shared/discounts.js";

/** The result of the route's approval step for this request (null = no approver). */
export type ApprovalContext = { approverId: string | null };

type ApprovalBody = { approval?: { employeeId: string } | { login: string } };
/**
 * What once() fingerprints: the request without the secret, naming the
 * approver, so a retry with the same approver replays and a different
 * approver conflicts.
 */
export function approvalFingerprint<T extends ApprovalBody>(
  extra: Record<string, unknown>,
  p: T,
) {
  const { approval, ...rest } = p;
  return {
    ...extra,
    ...rest,
    approver: approval
      ? "employeeId" in approval
        ? approval.employeeId
        : approval.login
      : null,
  };
}

const ROLE_ORDER = ["manager", "cashier", "server"] as const;
function controlsOf(row: Record<string, any>): MoneyControls {
  return {
    limits: {
      cashier: {
        maxPercentBps: row.cashier_max_percent_bps,
        maxAmount: row.cashier_max_amount,
      },
      server: {
        maxPercentBps: row.server_max_percent_bps,
        maxAmount: row.server_max_amount,
      },
    },
    blindClose: row.blind_close,
    expectedRoles: ROLE_ORDER.filter((r) =>
      (row.expected_roles as string[]).includes(r),
    ),
    closeRoles: (["cashier", "server"] as const).filter((r) =>
      (row.close_roles as string[]).includes(r),
    ),
  };
}

/** This restaurant's controls; defaults with version 0 when none were saved. One statement. */
export async function moneyControls(
  tx: Tx,
): Promise<MoneyControls & { version: number }> {
  const [row] =
    await tx`select * from money_controls where tenant_id=current_setting('app.tenant_id')::uuid`;
  if (!row) return { ...DEFAULT_MONEY_CONTROLS, version: 0 };
  return { ...controlsOf(row), version: row.version };
}

export async function getMoneyControls(
  tx: Tx,
  s: Session,
): Promise<MoneyControlsView> {
  permit(s, operators);
  const [row] = await tx`select c.*,e.name as updated_by_name
    from money_controls c join employees e on e.tenant_id=c.tenant_id and e.id=c.updated_by
    where c.tenant_id=current_setting('app.tenant_id')::uuid`;
  const c = row ? controlsOf(row) : DEFAULT_MONEY_CONTROLS;
  const staff = s.role === "cashier" || s.role === "server";
  return {
    ...c,
    version: row?.version ?? 0,
    canEdit: s.role === "owner",
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    updatedByName: row?.updated_by_name ?? null,
    you: {
      canSeeExpected: canSeeExpected(s.role, c),
      canClose: canCloseDrawer(s.role, c),
      limit: staff ? c.limits[s.role as StaffRole] : "unlimited",
    },
  };
}

/** Owner only, with step-up. Never touches restaurants (config_version unchanged). */
export async function saveMoneyControls(tx: Tx, s: Session, raw: unknown) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
  const parsed = moneyControlsInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("money_controls_invalid", 400);
  const p = parsed.data;
  return once(tx, s, p.operationId, "discount.controls", p, async () => {
    // LO-3 area key, class 929 (docs/ARCHITECTURE.md LO-3): its own non-zero
    // class, so it never shares class 0 with once()'s operation keys (LO-1).
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + ":money.controls"},929))`;
    const [row] =
      await tx`select * from money_controls where tenant_id=${s.tenantId} for update`;
    if ((row?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("money_controls_changed", 409);
    const before = row ? controlsOf(row) : DEFAULT_MONEY_CONTROLS;
    const after: MoneyControls = {
      limits: p.limits,
      blindClose: p.blindClose,
      expectedRoles: ROLE_ORDER.filter((r) => p.expectedRoles.includes(r)),
      closeRoles: (["cashier", "server"] as const).filter((r) =>
        p.closeRoles.includes(r),
      ),
    };
    await tx`insert into money_controls(tenant_id,cashier_max_percent_bps,cashier_max_amount,
        server_max_percent_bps,server_max_amount,blind_close,expected_roles,close_roles,version,updated_by,updated_at)
      values(${s.tenantId},${after.limits.cashier.maxPercentBps},${after.limits.cashier.maxAmount},
        ${after.limits.server.maxPercentBps},${after.limits.server.maxAmount},${after.blindClose},
        ${after.expectedRoles}::text[],${after.closeRoles}::text[],1,${s.employeeId},now())
      on conflict (tenant_id) do update set
        cashier_max_percent_bps=excluded.cashier_max_percent_bps,cashier_max_amount=excluded.cashier_max_amount,
        server_max_percent_bps=excluded.server_max_percent_bps,server_max_amount=excluded.server_max_amount,
        blind_close=excluded.blind_close,expected_roles=excluded.expected_roles,close_roles=excluded.close_roles,
        version=money_controls.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`;
    await audit(tx, s, "discount.controls.saved", s.tenantId, {
      before,
      after,
    });
    return getMoneyControls(tx, s);
  });
}

/**
 * Re-checks inside the command that an approver other than the actor is still
 * an active owner or manager (voids pattern: employees FOR SHARE right after
 * the order row, lock level LO-5a).
 */
export async function assertApproverActive(
  tx: Tx,
  approverId: string,
  s: Session,
): Promise<void> {
  if (approverId === s.employeeId) return;
  const [approver] =
    await tx`select id from employees where id=${approverId} and active and role in ('owner','manager') for share`;
  if (!approver) throw new DomainError("approval_denied", 403);
}

type LockedOrder = {
  id: string;
  version: number;
  state: string;
  check_state: string;
};
async function lockOrder(tx: Tx, orderId: string, expectedVersion: number) {
  const [o] =
    await tx`select id,version,state,check_state from orders where id=${orderId} for update`;
  if (!o) throw new DomainError("not_found", 404);
  if (o.version !== expectedVersion) throw new DomainError("stale_order", 409);
  return o as LockedOrder;
}

/**
 * Applies a line or check discount (or comp) to unpaid units of sent items.
 * LD-2: a verified approver (a manager's PIN, or a manager acting alone after
 * their own step-up) is the only PIN; a within-limit staff discount without an
 * approver needs the actor's own recent PIN. approval_required is answered
 * before any step-up, so staff over their limit are asked for one PIN only.
 */
export async function applyDiscount(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
  a: ApprovalContext,
): Promise<Order> {
  permit(s, operators);
  const p = discountInput.parse(raw);
  const issue = discountInputIssue(p);
  if (issue) throw new DomainError(issue, 400);
  return once(
    tx,
    s,
    p.operationId,
    "discount.apply",
    approvalFingerprint({ orderId }, p),
    async () => {
      await requireSelling(tx, s);
      const o = await lockOrder(tx, orderId, p.expectedVersion);
      assertCheckWritable(o);
      await assertNoFiscalTicket(tx, orderId);
      const controls = await moneyControls(tx);
      const order = await getOrder(tx, orderId);
      if (!order.itemSplitAvailable)
        throw new DomainError("unallocated_history", 409);
      const plan = planDiscount(order, p);
      // §2.2 (DSC-R13): the preview and the result are identical. Payments
      // (online, offline sync, recovery) and service changes do not bump
      // orders.version, so the request carries what its preview showed and a
      // different plan, starting balance or closing outcome is refused here,
      // under the order lock, before any approval or limit is evaluated.
      if (!discountPlanMatches(order, plan, p))
        throw new DomainError("discount_changed", 409);
      // MONEY-2/MONEY-3 (LD-26): the request's own kind rule and, per check,
      // the staff discounts recorded without an approver, read under the lock.
      const check = discountLimitCheck(s.role, p, plan, controls, order);
      let approver: string | null;
      if (check === "self") approver = a.approverId ?? s.employeeId;
      else if (check === "within") approver = a.approverId;
      else {
        if (!a.approverId) throw new DomainError("approval_required", 403);
        approver = a.approverId;
      }
      if (!a.approverId) requireRecentAuth(s);
      if (approver) await assertApproverActive(tx, approver, s);
      const discountId = randomUUID();
      await tx`insert into discounts(tenant_id,id,order_id,scope,line_id,kind,percent_bps,requested_amount,
          base,amount,units,reason_code,note,actor_id,approver_id,device_id)
        values(${s.tenantId},${discountId},${orderId},${p.scope},${p.scope === "line" ? p.lineId! : null},${p.kind},
          ${p.kind === "percent" ? p.percentBps! : null},${p.kind === "amount" ? p.amount! : null},
          ${plan.base},${plan.amount},${plan.units},${p.reasonCode},${p.note},${s.employeeId},${approver},${s.deviceId})`;
      // One statement for every allocation (the guard trigger runs per row).
      await tx`insert into discount_allocations(tenant_id,discount_id,order_id,line_id,unit_index,amount)
        select ${s.tenantId},${discountId},${orderId},x.line_id,x.unit_index,x.amount
        from unnest(${tx.array(plan.allocations.map((x) => x.lineId))}::uuid[],
          ${tx.array(plan.allocations.map((x) => x.unit))}::int[],
          ${tx.array(plan.allocations.map((x) => x.amount))}::int[]) as x(line_id,unit_index,amount)`;
      await tx`update orders set total=total-${plan.amount},discount=discount+${plan.amount},version=version+1 where id=${orderId}`;
      await audit(tx, s, "discount.applied", orderId, {
        discountId,
        scope: p.scope,
        lineId: p.lineId ?? null,
        kind: p.kind,
        percentBps: p.percentBps ?? null,
        amount: plan.amount,
        base: plan.base,
        units: plan.units,
        reasonCode: p.reasonCode,
        approverId: approver,
      });
      // A balance of 0 settles the check (a takeaway or tableless one closes
      // and the discount becomes final; a table check becomes "paid").
      await refreshCheckState(tx, s, orderId);
      return getOrder(tx, orderId);
    },
  );
}

/**
 * Removes a discount (its single reversal). Only while the check is open or
 * "paid" (a table check), none of its units is paid, and no later active
 * discount covers any of its units (LIFO). A closed check's discounts are final.
 */
export async function reverseDiscount(
  tx: Tx,
  s: Session,
  orderId: string,
  discountId: string,
  raw: unknown,
  a: ApprovalContext,
): Promise<Order> {
  permit(s, operators);
  const p = discountReverseInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "discount.reverse",
    approvalFingerprint({ orderId, discountId }, p),
    async () => {
      // The route always sets an approver for this command (LD-2); the rule
      // stays literal here: staff need one, a manager alone needs step-up.
      if (!a.approverId && !["owner", "manager"].includes(s.role))
        throw new DomainError("approval_required", 403);
      if (!a.approverId) requireRecentAuth(s);
      const approver = a.approverId ?? s.employeeId;
      const o = await lockOrder(tx, orderId, p.expectedVersion);
      if (o.check_state === "closed")
        throw new DomainError("discount_not_reversible", 409);
      assertCheckWritable(o);
      await assertNoFiscalTicket(tx, orderId);
      await assertApproverActive(tx, approver, s);
      const [d] = await tx`select d.id,d.reversed_at,
          coalesce((select sum(b.amount) from discount_allocations b
            where b.tenant_id=d.tenant_id and b.discount_id=d.id
              and not exists (select 1 from line_voids v where v.tenant_id=b.tenant_id
                              and v.line_id=b.line_id and b.unit_index=any(v.units))),0)::int as active,
          exists (select 1 from discount_allocations b
            join tender_allocations t on t.tenant_id=b.tenant_id and t.order_id=b.order_id
              and t.line_id=b.line_id and t.unit_index=b.unit_index
            where b.tenant_id=d.tenant_id and b.discount_id=d.id) as paid,
          exists (select 1 from discounts x
            join discount_allocations xa on xa.tenant_id=x.tenant_id and xa.discount_id=x.id
            join discount_allocations b on b.tenant_id=xa.tenant_id and b.discount_id=d.id
              and b.line_id=xa.line_id and b.unit_index=xa.unit_index
            where x.tenant_id=d.tenant_id and x.order_id=d.order_id and x.id<>d.id
              and x.reversed_at is null and (x.created_at,x.id) > (d.created_at,d.id)
              -- an overlap on a unit voided since no longer matters (DSC-R6,
              -- same rule as discountRemovable on the client)
              and not exists (select 1 from line_voids v where v.tenant_id=b.tenant_id
                              and v.line_id=b.line_id and b.unit_index=any(v.units))) as covered
        from discounts d where d.id=${discountId} and d.order_id=${orderId} for update of d`;
      if (!d) throw new DomainError("not_found", 404);
      if (d.reversed_at || d.paid || d.covered)
        throw new DomainError("discount_not_reversible", 409);
      const restored = d.active as number;
      await tx`update discounts set reversed_at=clock_timestamp(),reversed_by=${s.employeeId},
          reversal_approver_id=${approver},reversal_note=${p.note},reversed_amount=${restored}
        where id=${discountId}`;
      await tx`update orders set total=total+${restored},discount=discount-${restored},version=version+1 where id=${orderId}`;
      await audit(tx, s, "discount.reversed", orderId, {
        discountId,
        restored,
        note: p.note,
        approverId: approver,
      });
      // A reversal raises the balance: a "paid" table check returns to open.
      await refreshCheckState(tx, s, orderId);
      return getOrder(tx, orderId);
    },
  );
}

/**
 * Fiscal contract (027): Σ active discount allocations on non-voided units per
 * line, tax-inclusive. Order discounts are already allocated per unit by due.
 * One statement.
 */
export async function discountsByLine(
  tx: Tx,
  orderId: string,
): Promise<Record<string, number>> {
  const rows = await tx`select a.line_id,sum(a.amount)::int as amount
    from discount_allocations a
    join discounts d on d.tenant_id=a.tenant_id and d.id=a.discount_id
    where a.order_id=${orderId} and d.reversed_at is null
      and not exists (select 1 from line_voids v where v.tenant_id=a.tenant_id
                      and v.line_id=a.line_id and a.unit_index=any(v.units))
    group by a.line_id`;
  return Object.fromEntries(rows.map((r) => [r.line_id, r.amount]));
}

/**
 * getOrders' discounts member: discounts with allocations, refund money rows,
 * batches, unit and line refunds of every order, in ONE statement whatever the
 * number of ids (statement budget, ARCHITECTURE C-14).
 */
export async function adjustmentRows(
  tx: Tx,
  ids: string[],
): Promise<Map<string, AdjustmentRow>> {
  const rows =
    await tx`with ids as (select unnest(${tx.array(ids)}::uuid[]) as id)
    select i.id as order_id,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id',d.id,'scope',d.scope,'lineId',d.line_id,'kind',d.kind,'percentBps',d.percent_bps,
          'base',d.base,'amount',d.amount,'units',d.units,'reasonCode',d.reason_code,'note',d.note,
          'actorName',ea.name,'approverName',em.name,'createdAt',d.created_at,
          'reversedAt',d.reversed_at,'reversedByName',er.name,'reversalApproverName',ex.name,
          'reversalNote',d.reversal_note,'reversedAmount',d.reversed_amount,
          'allocations',(select coalesce(jsonb_agg(jsonb_build_object('lineId',x.line_id,'unit',x.unit_index,'amount',x.amount)
                           order by x.line_id,x.unit_index),'[]') from discount_allocations x
                         where x.tenant_id=d.tenant_id and x.discount_id=d.id))
         order by d.created_at,d.id),'[]')
       from discounts d
       join employees ea on ea.tenant_id=d.tenant_id and ea.id=d.actor_id
       left join employees em on em.tenant_id=d.tenant_id and em.id=d.approver_id
       left join employees er on er.tenant_id=d.tenant_id and er.id=d.reversed_by
       left join employees ex on ex.tenant_id=d.tenant_id and ex.id=d.reversal_approver_id
       where d.order_id=i.id) as discounts,
      (select coalesce(jsonb_agg(jsonb_build_object('refundId',r.id,'tenderId',r.tender_id,'batchId',r.batch_id,
          'method',r.method,'amount',r.amount,'reference',r.external_reference,'reason',r.reason,
          'createdAt',r.created_at,'actorName',e.name)
          order by r.created_at,t.created_at,t.id,r.id),'[]')
       from tenders t join refunds r on r.tenant_id=t.tenant_id and r.tender_id=t.id
       join employees e on e.tenant_id=r.tenant_id and e.id=r.actor_id
       where t.order_id=i.id) as refunds,
      (select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'mode',b.mode,'amount',b.amount,
          'cashAmount',b.cash_amount,'externalAmount',b.external_amount,'reasonCode',b.reason_code,'note',b.note,
          'restock',b.restock,'actorName',ea.name,'approverName',em.name,'createdAt',b.created_at,
          'businessDate',b.business_date) order by b.created_at,b.id),'[]')
       from refund_batches b
       join employees ea on ea.tenant_id=b.tenant_id and ea.id=b.actor_id
       join employees em on em.tenant_id=b.tenant_id and em.id=b.approver_id
       where b.order_id=i.id) as batches,
      (select coalesce(jsonb_agg(jsonb_build_object('refundId',u.refund_id,'tenderId',u.tender_id,'lineId',u.line_id,
          'unit',u.unit_index,'amount',u.amount) order by u.refund_id,u.line_id,u.unit_index),'[]')
       from refund_units u where u.order_id=i.id) as refund_units,
      (select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'batchId',l.batch_id,'lineId',l.line_id,'units',l.units,
          'amount',l.amount,'restocked',l.restocked,'preparationState',l.preparation_state,
          'kitchenPending',l.kitchen_ack_required and l.kitchen_acknowledged_at is null) order by l.created_at,l.id),'[]')
       from refund_lines l where l.order_id=i.id) as refund_lines
    from ids i`;
  return new Map(
    rows.map((r) => [
      r.order_id as string,
      {
        discounts: r.discounts,
        refunds: r.refunds,
        batches: r.batches,
        refundUnits: r.refund_units,
        refundLines: r.refund_lines,
      } as AdjustmentRow,
    ]),
  );
}
