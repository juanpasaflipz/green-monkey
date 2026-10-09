import { requireSelling } from "./free-limits.js";
import { requirePro } from "./entitlements.js";
import {
  payableUnits,
  allocatePayment,
  type Allocation,
} from "../shared/settlement.js";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { Tx } from "./db.js";
import { hash, permit, operators } from "./auth.js";
import { catalog } from "./menu-read.js";
export { catalog };
import { stock, lockStockItems } from "./stock.js";
export { stock };
import { recipeStockIds } from "../shared/menu.js";
import { assertCheckWritable, refreshCheckState } from "./checks.js";
import { assertNoLiveAttempt } from "./payments/guards.js";
import {
  insertTender,
  liveTerminal,
  tenderPlatform,
  tenderTerminal,
  type TenderSpec,
} from "./payments/tenders.js";
import {
  PAYMENTS_LIMITS,
  paymentMethodInput,
  platformReferenceProblem,
  tenderExtras,
} from "../shared/payments.js";
import { bumpKitchenFeed } from "./kitchen.js";
import { adjustmentRows } from "./discounts.js";
import {
  composeOrderAdjustments,
  type TenderAllocation,
} from "../shared/discounts.js";
import {
  assertNoFiscalTicket,
  composeOrderFiscal,
  fiscalContext,
  fiscalRows,
} from "./fiscal-read.js";
import {
  DomainError,
  orderInput,
  quote,
  sum,
  businessDate,
  money,
  id,
  type Session,
  type Order,
  type PricedLine,
} from "../shared/domain.js";
export async function audit(
  tx: Tx,
  s: Session,
  operation: string,
  entity: string,
  detail: unknown = {},
) {
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${s.tenantId},${randomUUID()},${s.employeeId},${operation},${entity},${tx.json(detail as any)})`;
}
export async function once<T>(
  tx: Tx,
  s: Session,
  key: string,
  kind: string,
  body: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  id.parse(key);
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + key},0))`;
  const fingerprint = hash(JSON.stringify(body));
  const [prior] = await tx`select * from operations where id=${key}`;
  if (prior) {
    if (prior.kind !== kind || prior.hash !== fingerprint)
      throw new DomainError("operation_conflict", 409);
    return prior.result as T;
  }
  // Commands that update the restaurants row lock it FOR NO KEY UPDATE themselves:
  // a FOR SHARE here would be a SHARE->UPDATE upgrade (lock order LO-R6).
  if (kind !== "restaurant.settings" && kind !== "stock.policy") {
    const [restaurant] =
      await tx`select currency,timezone,cutoff from restaurants where id=${s.tenantId} for share`;
    if (
      !restaurant ||
      restaurant.currency !== s.restaurant.currency ||
      restaurant.timezone !== s.restaurant.timezone ||
      restaurant.cutoff !== s.restaurant.cutoff
    )
      throw new DomainError("settings_changed", 409);
  }
  const result = await fn();
  await tx`insert into operations(tenant_id,id,kind,hash,result) values(${s.tenantId},${key},${kind},${fingerprint},${tx.json(result as any)})`;
  return result;
}
/** Groups rows by order id, keeping each group's query order. */
function byOrder<T extends { order_id: string }>(rows: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.order_id);
    if (group) group.push(row);
    else groups.set(row.order_id, [row]);
  }
  return groups;
}
/**
 * Loads several orders with a constant number of statements (pipelined on the
 * transaction connection), whatever the number of ids. Input order is kept and
 * missing ids are skipped.
 */
export async function getOrders(tx: Tx, ids: string[]): Promise<Order[]> {
  if (!ids.length) return [];
  const list = tx.array(ids);
  const [
    orders,
    lineRows,
    voidRows,
    tenderRows,
    roundRows,
    allocationRows,
    recoveryRows,
    offlineRows,
    fiscalMap /* fiscal */,
    adjustmentMap /* discounts */,
  ] = await Promise.all([
    tx`select o.*,o.business_date::text as business_day,e.name as waiter_name,
          opener.name as opened_by,t.name as table_name
        from orders o
        join employees e on e.tenant_id=o.tenant_id and e.id=coalesce(o.assigned_employee_id,o.employee_id)
        join employees opener on opener.tenant_id=o.tenant_id and opener.id=o.employee_id
        left join dining_tables t on t.tenant_id=o.tenant_id and t.id=o.table_id
        where o.id=any(${list}::uuid[])`,
    tx`select l.order_id,l.data,l.round,coalesce((select array_agg(u order by u) from line_voids v, unnest(v.units) u
          where v.tenant_id=l.tenant_id and v.line_id=l.id),'{}') as voided_units
        from order_lines l where l.order_id=any(${list}::uuid[]) order by l.round,l.id`,
    tx`select v.order_id,v.id,v.line_id,cardinality(v.units)::int as quantity,v.amount,v.reason,
          v.stock_disposition,v.preparation_state,v.created_at,v.kitchen_ack_required,v.kitchen_acknowledged_at,
          a.name as actor_name,m.name as approver_name
        from line_voids v
        join employees a on a.tenant_id=v.tenant_id and a.id=v.actor_id
        join employees m on m.tenant_id=v.tenant_id and m.id=v.approver_id
        where v.order_id=any(${list}::uuid[]) order by v.created_at,v.id`,
    tx`select t.*,coalesce((select sum(r.amount) from refunds r where r.tenant_id=t.tenant_id and r.tender_id=t.id),0)::int as refunded
        from tenders t where t.order_id=any(${list}::uuid[]) order by t.created_at,t.id`,
    tx`select * from rounds where order_id=any(${list}::uuid[]) order by number,station`,
    tx`select order_id,tender_id as "tenderId",line_id as "lineId",unit_index as unit,amount
        from tender_allocations where order_id=any(${list}::uuid[])`,
    tx`select r.order_id,r.id,r.reason,r.original_sold_at,
          r.recognized_at,r.evidence_version,r.item_allocation_complete,
          coalesce(jsonb_object_agg(t.kind,t.state) filter(where t.kind is not null),'{}') as tasks
        from offline_recoveries r left join offline_recovery_tasks t
          on t.tenant_id=r.tenant_id and t.recovery_id=r.id
        where r.order_id=any(${list}::uuid[])
        group by r.tenant_id,r.id`,
    // offline (026): provisional number and sale time of orders created by sync.
    tx`select distinct on (order_id) order_id,provisional_number,sold_at
        from offline_sync_records
        where order_id=any(${list}::uuid[]) and kind in ('sale','order')
        order by order_id,sold_at`,
    // fiscal (027): ticket, tax groups and refund adjustments, one statement.
    fiscalRows(tx, ids),
    // discounts (028): discounts, refund batches, unit and line refunds (one statement).
    adjustmentRows(tx, ids),
  ]);
  const linesBy = byOrder(
    lineRows as unknown as {
      order_id: string;
      data: PricedLine;
      round: number;
      voided_units: number[];
    }[],
  );
  const voidsBy = byOrder(
    voidRows as unknown as ({ order_id: string } & Record<string, any>)[],
  );
  const tendersBy = byOrder(
    tenderRows as unknown as ({ order_id: string } & Record<string, any>)[],
  );
  const roundsBy = byOrder(
    roundRows as unknown as ({ order_id: string } & Record<string, any>)[],
  );
  const allocationsBy = byOrder(
    allocationRows as unknown as ({ order_id: string } & TenderAllocation)[],
  );
  const recoveryBy = byOrder(
    recoveryRows as unknown as ({ order_id: string } & Record<string, any>)[],
  );
  const offlineBy = byOrder(
    offlineRows as unknown as ({ order_id: string } & Record<string, any>)[],
  );
  const found = new Map(orders.map((o) => [o.id as string, o]));
  return ids.flatMap((orderId) => {
    const o = found.get(orderId);
    if (!o) return [];
    const lines = (linesBy.get(orderId) ?? []).map((l) => ({
      data: {
        ...l.data,
        round: l.round,
        voidedUnits: l.voided_units,
      } as PricedLine,
    }));
    const voids = voidsBy.get(orderId) ?? [];
    // payments (037): fees are manager figures (reports and corte); the order
    // view every role and the receipt job read never carries them.
    const tenders = (tendersBy.get(orderId) ?? []).map(
      ({ fee: _fee, fee_source: _feeSource, ...t }) => t,
    );
    const rounds = roundsBy.get(orderId) ?? [];
    const tenderAllocations = (allocationsBy.get(orderId) ?? []).map(
      ({ order_id: _order, ...a }) => a as TenderAllocation,
    );
    const allocations = tenderAllocations.map(
      ({ tenderId: _tender, ...a }) => a as Allocation,
    );
    const adj = composeOrderAdjustments(adjustmentMap.get(orderId), {
      lines: lines.map((l) => l.data),
    }); // discounts
    const allocated = sum(allocations.map((a) => a.amount));
    const paid = sum(tenders.map((t) => t.amount));
    const recovery = recoveryBy.get(orderId)?.[0];
    const offline = offlineBy.get(orderId)?.[0];
    return [
      {
        recovery: recovery
          ? {
              id: recovery.id,
              reason: recovery.reason,
              original: { recordedAt: recovery.original_sold_at.toISOString() },
              recognizedAt: recovery.recognized_at.toISOString(),
              evidenceVersion: recovery.evidence_version,
              itemAllocationComplete: recovery.item_allocation_complete,
              fulfillment: recovery.tasks.kitchen,
              stock: recovery.tasks.stock,
            }
          : null,
        serviceVersion: o.service_version,
        assignedEmployeeId: o.assigned_employee_id ?? o.employee_id,
        waiterName: o.waiter_name,
        tableName: o.table_name,
        restaurantSnapshot: o.restaurant_snapshot,
        itemSplitAvailable: allocated === paid,
        paymentUnits:
          allocated === paid
            ? payableUnits(
                lines.map((l) => l.data),
                allocations,
                adj.unitDiscounts, // discounts
              ).filter(
                (unit) =>
                  !lines
                    .find((l) => l.data.id === unit.lineId)
                    ?.data.voidedUnits?.includes(unit.unit),
              )
            : [],
        voids: voids.map((v) => ({
          id: v.id,
          lineId: v.line_id,
          quantity: v.quantity,
          amount: v.amount,
          reason: v.reason,
          stockDisposition: v.stock_disposition,
          preparationState: v.preparation_state,
          actorName: v.actor_name,
          approverName: v.approver_name,
          createdAt: v.created_at.toISOString(),
          kitchenPending: v.kitchen_ack_required && !v.kitchen_acknowledged_at,
        })),
        checkState: o.check_state,
        closedAt: o.closed_at ? o.closed_at.toISOString() : null,
        closeReason: o.close_reason ?? null,
        channel: o.channel,
        pricePlatform: o.price_platform ?? null, // payments (037, LD-72)
        businessDate: o.business_day,
        openedBy: o.opened_by,
        id: o.id,
        number: o.number,
        version: o.version,
        mode: o.mode,
        tableId: o.table_id,
        name: o.name,
        note: o.note,
        lines: lines.map((l) => l.data),
        total: o.total,
        paid,
        refunded: sum(tenders.map((t) => t.refunded)),
        state: o.state,
        createdAt: o.created_at.toISOString(),
        rounds,
        tenders,
        offline: offline
          ? {
              provisionalNumber: offline.provisional_number,
              soldAt: offline.sold_at.toISOString(),
            }
          : null,
        fiscal: composeOrderFiscal(fiscalMap.get(orderId), {
          total: o.total,
          lines: lines.map((l) => l.data),
          lineDiscounts: adj.lineDiscounts, // discounts
        }),
        discount: o.discount, // discounts
        discounts: adj.discounts, // discounts
        lineDiscounts: adj.lineDiscounts, // discounts
        refundBatches: adj.refundBatches, // discounts
        refundedUnits: adj.refundedUnits, // discounts
        tenderAllocations, // discounts
      } as Order,
    ];
  });
}
export async function getOrder(tx: Tx, orderId: string): Promise<Order> {
  const [order] = await getOrders(tx, [orderId]);
  if (!order) throw new DomainError("not_found", 404);
  return order;
}
export type AppendOptions = {
  /** service (024): kitchen note for this round (rounds.note). */
  note?: string;
  /** menu (025): negative-stock policy; offline-collected sales pass "allow". */
  stockPolicy?: "allow" | "block";
};
export async function append(
  tx: Tx,
  s: Session,
  orderId: string,
  lines: ReturnType<typeof quote>,
  round: number,
  opts: AppendOptions = {},
) {
  // DB-5: every stock row of every line, locked once in uuid order.
  await lockStockItems(tx, recipeStockIds(lines));
  for (const l of lines) {
    await tx`insert into order_lines(tenant_id,id,order_id,product_id,round,data) values(${s.tenantId},${l.id},${orderId},${l.productId},${round},${tx.json(l)})`;
    for (const r of l.recipe)
      await stock(
        tx,
        s,
        r.stockId,
        new Decimal(r.quantity).mul(l.quantity).negated().toFixed(6),
        "sale",
        l.id,
        "dispatch",
        opts.stockPolicy,
      );
  }
  for (const station of new Set(lines.map((l) => l.station))) {
    await tx`insert into rounds(tenant_id,id,order_id,number,station,note)
             values(${s.tenantId},${randomUUID()},${orderId},${round},${station},${opts.note ?? ""})`;
  }
  await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state) values(${s.tenantId},${randomUUID()},'kitchen_dispatch',${orderId + ":" + round},${tx.json({ orderId, round })},'available')`;
}
export async function createOrder(
  tx: Tx,
  s: Session,
  raw: unknown,
  offline?: { businessDate: string },
) {
  permit(s, operators);
  const input = orderInput.parse(raw);
  return once(tx, s, input.operationId, "create_order", input, async () => {
    if (["qr", "kiosk"].includes(input.channel)) await requirePro(tx);
    else if (!offline) await requireSelling(tx, s);
    // payments (037, LD-72): only staff orders ring at a platform's prices, and online only at an
    // enabled platform's (PAYMENTS-SECURITY-5; offline sales already happened, OFF-8). A platform
    // list is for delivery: never on a table or a dine-in order (LD-75).
    if (input.pricePlatform && ["qr", "kiosk"].includes(input.channel))
      throw new DomainError("invalid_input");
    if (input.pricePlatform && !offline) {
      if (input.tableId || input.mode === "dine_in")
        throw new DomainError("payments_platform_dine_in", 409);
      if (!(await tenderPlatform(tx, input.pricePlatform)).enabled)
        throw new DomainError("payments_platform_disabled", 409);
    }
    const lines = quote(
      input.lines,
      await catalog(tx),
      !["qr", "kiosk"].includes(input.channel),
      await fiscalContext(tx),
      input.pricePlatform ?? null,
    );
    if (input.tableId) {
      const [t] =
        await tx`select id from dining_tables where id=${input.tableId} and archived_at is null for share`;
      if (!t) throw new DomainError("invalid_table", 400);
    }
    const date =
      offline?.businessDate ??
      businessDate(
        new Date().toISOString(),
        s.restaurant.timezone,
        s.restaurant.cutoff,
      );
    const [number] =
      await tx`insert into order_numbers(tenant_id,business_date,value) values(${s.tenantId},${date},1) on conflict(tenant_id,business_date) do update set value=order_numbers.value+1 returning value`;
    const orderId = randomUUID();
    await tx`insert into orders(tenant_id,id,number,business_date,employee_id,table_id,mode,name,note,channel,total,restaurant_snapshot,price_platform) values(${s.tenantId},${orderId},${number.value},${date},${s.employeeId},${input.tableId},${input.mode},${input.name},${input.note},${input.channel},${sum(lines.map((l) => l.total))},${tx.json(s.restaurant)},${input.pricePlatform ?? null})`;
    await append(tx, s, orderId, lines, 1, {
      stockPolicy: offline ? "allow" : undefined,
    });
    await audit(tx, s, "order.created", orderId, {
      channel: input.channel,
      deviceId: s.deviceId,
      capabilityId: s.id,
      ...(input.pricePlatform ? { pricePlatform: input.pricePlatform } : {}),
    });
    // LO-R3: the kitchen feed (LO-10) after every order, round and stock lock of
    // this command and before refreshCheckState, whose issuance takes the folio
    // counter (LO-12) last. A zero-total takeaway closes at once; it never issues
    // here (nothing is paid at creation, E5).
    await bumpKitchenFeed(tx, s);
    await refreshCheckState(tx, s, orderId);
    return getOrder(tx, orderId);
  });
}
type RoundTarget = {
  id: string;
  version: number;
  state: string;
  check_state: string;
};
/**
 * The shared tail of every round (online rounds and offline round sync). The
 * caller holds FOR UPDATE on the order row and did its own version check.
 */
export async function applyRound(
  tx: Tx,
  s: Session,
  order: RoundTarget,
  lines: PricedLine[],
  opts: AppendOptions & { detail?: Record<string, unknown> } = {},
): Promise<number> {
  assertCheckWritable(order);
  // fiscal (027): a ticketed check takes no rounds; late items go out as a new order.
  await assertNoFiscalTicket(tx, order.id);
  const n = order.version + 1;
  await append(tx, s, order.id, lines, n, opts);
  await tx`update orders set total=total+${sum(lines.map((l) => l.total))},version=version+1,state='active' where id=${order.id}`;
  await audit(tx, s, "order.round", order.id, opts.detail ?? {});
  await refreshCheckState(tx, s, order.id);
  return n;
}
export async function addRound(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
) {
  permit(s, operators);
  const input = orderInput
    .extend({ expectedVersion: z.number().int() })
    .parse(raw);
  return once(
    tx,
    s,
    input.operationId,
    "round",
    { orderId, ...input },
    async () => {
      await requireSelling(tx, s);
      const [o] = await tx`select * from orders where id=${orderId} for update`;
      if (!o) throw new DomainError("not_found", 404);
      // A stale client is refreshed first; served (completed) orders accept rounds.
      if (o.version !== input.expectedVersion)
        throw new DomainError("stale_order", 409);
      assertCheckWritable(o as { check_state: string; state: string });
      // payments (037, LD-72): a round takes the order's own price list, set at creation; a
      // round body naming another list is refused.
      if (input.pricePlatform && input.pricePlatform !== o.price_platform)
        throw new DomainError("payments_platform_price_list", 409);
      const lines = quote(
        input.lines,
        await catalog(tx),
        true,
        await fiscalContext(tx),
        o.price_platform ?? null,
      );
      await applyRound(tx, s, o as RoundTarget, lines, { note: input.note });
      await bumpKitchenFeed(tx, s);
      return getOrder(tx, orderId);
    },
  );
}
export const paymentInput = z
  .object({
    operationId: id,
    amount: money.refine((n) => n > 0),
    tip: money.default(0),
    received: money,
    method: paymentMethodInput,
    externalConfirmed: z.boolean().default(false),
    reference: z.string().max(120).default(""),
    items: z
      .array(z.string().regex(/^[0-9a-f-]{36}:\d{1,2}$/i))
      .min(1)
      .max(9900)
      .optional(),
    // payments (037): optional, no defaults, so old payloads hash the same.
    ...tenderExtras,
  })
  .strict();
export async function drawer(tx: Tx, s: Session) {
  const [d] =
    await tx`select * from cash_sessions where device_id=${s.deviceId} and closed_at is null for update`;
  if (!d) throw new DomainError("drawer_required", 409);
  return d;
}
export type RecordPaymentOptions = {
  /**
   * Offline evidence (OFF-8): money already collected is always applied. It
   * skips the live-attempt guard and the platform's online-only rules (full
   * balance, enabled platform, price list); an archived terminal is accepted.
   */
  evidence?: boolean;
  /** Offline evidence named a terminal that no longer exists: noted on the audit row. */
  droppedTerminalId?: string | null;
};
export async function recordPayment(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
  groupId: string | null = null,
  expectedDrawerId?: string,
  opts: RecordPaymentOptions = {},
) {
  permit(s, operators);
  const p = paymentInput.parse(raw);
  return once(tx, s, p.operationId, "payment", { orderId, ...p }, async () => {
    const [row] =
      await tx`select id,state,check_state,price_platform,table_id,mode from orders where id=${orderId} for update`;
    if (!row) throw new DomainError("not_found", 404);
    assertCheckWritable(row as { check_state: string; state: string });
    // payments (037): no second payment while money may be in flight at a terminal.
    if (!opts.evidence) await assertNoLiveAttempt(tx, orderId);
    const o = await getOrder(tx, orderId);
    if (p.amount > o.total - o.paid) throw new DomainError("overpayment", 409);
    if (p.terminalId && p.method !== "external")
      throw new DomainError("invalid_input");
    if ((p.platform || p.platformLabel) && p.method !== "platform")
      throw new DomainError("invalid_input");
    // An external terminal collects no cash: received is ignored for it.
    if (p.method === "cash" && p.received < p.amount + p.tip)
      throw new DomainError("insufficient_cash");
    if (
      p.method === "external" &&
      (!p.externalConfirmed || !p.reference.trim())
    )
      throw new DomainError("external_confirmation");
    let platform: TenderSpec["platform"] = null;
    /** Online platform rules offline evidence broke (PAYMENTS-SECURITY-4): noted, not refused. */
    const skipped: string[] = [];
    if (p.method === "platform") {
      if (!p.platform) throw new DomainError("payments_platform_required");
      if ((p.platform === "other") !== Boolean(p.platformLabel))
        throw new DomainError("payments_platform_required");
      if (!p.externalConfirmed)
        throw new DomainError("payments_platform_confirm_required");
      if (p.tip !== 0) throw new DomainError("payments_platform_no_tip");
      if (p.items) throw new DomainError("invalid_input");
      if (p.reference.trim().length > PAYMENTS_LIMITS.platformReferenceMax)
        throw new DomainError("invalid_input");
      const platformRow = await tenderPlatform(tx, p.platform);
      // LD-75 (PAYMENTS-SECURITY-1): each rule names the online error it raises.
      const rules: [string, boolean, string][] = [
        // Q6: a platform covers the whole remaining balance.
        [
          "full_balance",
          p.amount !== o.total - o.paid,
          "payments_platform_full_balance",
        ],
        // Disabled by default: the owner opts in per platform.
        ["disabled", !platformRow.enabled, "payments_platform_disabled"],
        // A platform pays a delivery or takeaway order, never a table or dine-in one.
        [
          "dine_in",
          Boolean(row.table_id) || row.mode === "dine_in",
          "payments_platform_dine_in",
        ],
        // LD-72: an order rung at a platform's prices is paid by that platform.
        [
          "price_list",
          Boolean(row.price_platform) && row.price_platform !== p.platform,
          "payments_platform_price_list",
        ],
        // LD-75: a platform with prices of its own pays only orders rung at its list.
        [
          "needs_price_list",
          !row.price_platform && platformRow.has_prices,
          "payments_platform_needs_price_list",
        ],
        // Uber Eats, Rappi and DiDi tenders carry the platform's order number.
        [
          "reference",
          platformReferenceProblem(p.platform, p.reference) !== null,
          "payments_platform_reference_required",
        ],
      ];
      for (const [rule, broken, code] of rules) {
        if (!broken) continue;
        if (!opts.evidence)
          throw new DomainError(code, rule === "reference" ? 400 : 409);
        skipped.push(rule);
      }
      platform = { row: platformRow, label: p.platformLabel ?? null };
    }
    let terminal: TenderSpec["terminal"] = null;
    if (p.method === "external" && p.terminalId) {
      // An integrated terminal used manually is the documented fallback.
      terminal = opts.evidence
        ? await tenderTerminal(tx, p.terminalId)
        : await liveTerminal(tx, p.terminalId);
      if (!terminal) throw new DomainError("payments_terminal_not_found", 404);
    }
    if (p.items && !o.itemSplitAvailable)
      throw new DomainError("unallocated_history", 409);
    const allocations = o.itemSplitAvailable
      ? allocatePayment(o.paymentUnits!, p.amount, p.items)
      : [];
    const d = await drawer(tx, s);
    if (expectedDrawerId && d.id !== expectedDrawerId)
      throw new DomainError("payment_review_required", 409);
    const received =
      p.method === "external"
        ? p.amount + p.tip
        : p.method === "platform"
          ? p.amount
          : p.received;
    const reference = p.method === "cash" ? null : p.reference.trim() || null;
    const tenderId = await insertTender(tx, s, {
      orderId,
      drawerId: d.id,
      method: p.method,
      amount: p.amount,
      tip: p.tip,
      received,
      reference,
      groupId,
      terminal,
      platform,
    });
    for (const allocation of allocations)
      await tx`insert into tender_allocations(tenant_id,order_id,tender_id,line_id,unit_index,amount) values(${s.tenantId},${orderId},${tenderId},${allocation.lineId},${allocation.unit},${allocation.amount})`;
    await audit(tx, s, "payment.recorded", orderId, {
      method: p.method,
      amount: p.amount,
      tip: p.tip,
      // Excepciones joins a platform tender to its actor through this id (LD-75).
      tenderId,
      ...(terminal ? { terminalId: terminal.id } : {}),
      ...(platform ? { platform: platform.row.platform } : {}),
      ...(opts.droppedTerminalId
        ? {
            droppedTerminalId: opts.droppedTerminalId,
            note: "payments_terminal_unknown",
          }
        : {}),
      ...(skipped.length
        ? {
            platformRulesSkipped: skipped,
            platformNote: "payments_platform_rule_skipped",
          }
        : {}),
    });
    // Settle the check before the receipt is read; a settling payment issues
    // the fiscal ticket there (folio counter, LO-12, last). Payments never bump
    // the kitchen feed: it is LO-10, below the drawer this command holds
    // (LO-11, LO-R3).
    await refreshCheckState(tx, s, orderId);
    const receipt = await getOrder(tx, orderId);
    await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,error_code) values(${s.tenantId},${randomUUID()},'receipt',${p.operationId},${tx.json({ orderId, receipt })},'blocked','printer_not_paired')`;
    return receipt;
  });
}
