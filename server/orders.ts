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
import {
  DomainError,
  orderInput,
  quote,
  sum,
  businessDate,
  money,
  id,
  type Session,
  type Product,
  type Order,
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
  if (kind !== "restaurant.settings") {
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
export async function catalog(tx: Tx): Promise<Product[]> {
  return (
    await tx`select data from catalog order by data->'category'->>'es',data->'name'->>'es'`
  ).map((r) => r.data as Product);
}
export async function getOrder(tx: Tx, orderId: string): Promise<Order> {
  const [o] =
    await tx`select o.*,e.name as waiter_name,t.name as table_name from orders o join employees e on e.tenant_id=o.tenant_id and e.id=coalesce(o.assigned_employee_id,o.employee_id) left join dining_tables t on t.tenant_id=o.tenant_id and t.id=o.table_id where o.id=${orderId}`;
  if (!o) throw new DomainError("not_found", 404);
  const lines =
    await tx`select data from order_lines where order_id=${orderId} order by round,id`;
  const tenders =
    await tx`select t.*,coalesce((select sum(r.amount) from refunds r where r.tender_id=t.id),0)::int as refunded from tenders t where order_id=${orderId} order by created_at`;
  const rounds =
    await tx`select * from rounds where order_id=${orderId} order by number,station`;
  const allocations = await tx<
    Allocation[]
  >`select line_id as "lineId", unit_index as unit, amount from tender_allocations where order_id=${orderId}`;
  const allocated = sum(allocations.map((a) => a.amount));
  const paid = sum(tenders.map((t) => t.amount));
  return {
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
          )
        : [],
    id: o.id,
    number: o.number,
    version: o.version,
    mode: o.mode,
    tableId: o.table_id,
    name: o.name,
    note: o.note,
    lines: lines.map((l) => l.data),
    total: o.total,
    paid: sum(tenders.map((t) => t.amount)),
    refunded: sum(tenders.map((t) => t.refunded)),
    state: o.state,
    createdAt: o.created_at.toISOString(),
    rounds,
    tenders,
  };
}
export async function stock(
  tx: Tx,
  s: Session,
  stockId: string,
  quantity: string,
  cause: string,
  causeId: string,
  reason: string,
  allowNegative = false,
) {
  const [item] =
    await tx`select * from stock_items where id=${stockId} for update`;
  if (!item) throw new DomainError("not_found", 404);
  const [existing] =
    await tx`select id from stock_movements where stock_id=${stockId} and cause=${cause} and cause_id=${causeId}`;
  if (existing) return;
  const [balance] =
    await tx`select coalesce(sum(quantity),0)::text as quantity from stock_movements where stock_id=${stockId}`;
  const next = new Decimal(balance.quantity).add(quantity);
  if (next.isNegative() && !allowNegative)
    throw new DomainError("insufficient_stock", 409);
  await tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id) values(${s.tenantId},${randomUUID()},${stockId},${quantity},${cause},${causeId},${reason},${s.employeeId})`;
  await tx`update stock_items set version=version+1 where id=${stockId}`;
}
async function append(
  tx: Tx,
  s: Session,
  orderId: string,
  lines: ReturnType<typeof quote>,
  round: number,
) {
  for (const l of lines) {
    await tx`insert into order_lines(tenant_id,id,order_id,product_id,round,data) values(${s.tenantId},${l.id},${orderId},${l.productId},${round},${tx.json(l)})`;
    for (const r of [...l.recipe].sort((a, b) =>
      a.stockId.localeCompare(b.stockId),
    ))
      await stock(
        tx,
        s,
        r.stockId,
        new Decimal(r.quantity).mul(l.quantity).negated().toFixed(6),
        "sale",
        l.id,
        "dispatch",
      );
  }
  for (const station of new Set(lines.map((l) => l.station))) {
    await tx`insert into rounds(tenant_id,id,order_id,number,station) values(${s.tenantId},${randomUUID()},${orderId},${round},${station})`;
  }
  await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state) values(${s.tenantId},${randomUUID()},'kitchen_dispatch',${orderId + ":" + round},${tx.json({ orderId, round })},'available')`;
}
export async function createOrder(tx: Tx, s: Session, raw: unknown) {
  permit(s, operators);
  const input = orderInput.parse(raw);
  return once(tx, s, input.operationId, "create_order", input, async () => {
    if (["qr", "kiosk"].includes(input.channel)) await requirePro(tx);
    const lines = quote(
      input.lines,
      await catalog(tx),
      ["manager", "owner"].includes(s.role),
    );
    const date = businessDate(
      new Date().toISOString(),
      s.restaurant.timezone,
      s.restaurant.cutoff,
    );
    const [number] =
      await tx`insert into order_numbers(tenant_id,business_date,value) values(${s.tenantId},${date},1) on conflict(tenant_id,business_date) do update set value=order_numbers.value+1 returning value`;
    const orderId = randomUUID();
    await tx`insert into orders(tenant_id,id,number,business_date,employee_id,table_id,mode,name,note,channel,total,restaurant_snapshot) values(${s.tenantId},${orderId},${number.value},${date},${s.employeeId},${input.tableId},${input.mode},${input.name},${input.note},${input.channel},${sum(lines.map((l) => l.total))},${tx.json(s.restaurant)})`;
    await append(tx, s, orderId, lines, 1);
    await audit(tx, s, "order.created", orderId, {
      channel: input.channel,
      deviceId: s.deviceId,
      capabilityId: s.id,
    });
    return getOrder(tx, orderId);
  });
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
      const [o] = await tx`select * from orders where id=${orderId} for update`;
      if (!o) throw new DomainError("not_found", 404);
      if (o.version !== input.expectedVersion || o.state === "completed")
        throw new DomainError("stale_order", 409);
      const lines = quote(
        input.lines,
        await catalog(tx),
        ["manager", "owner"].includes(s.role),
      );
      await append(tx, s, orderId, lines, o.version + 1);
      await tx`update orders set total=total+${sum(lines.map((l) => l.total))},version=version+1,state='active' where id=${orderId}`;
      await audit(tx, s, "order.round", orderId);
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
    method: z.enum(["cash", "external"]),
    externalConfirmed: z.boolean().default(false),
    reference: z.string().max(120).default(""),
    items: z
      .array(z.string().regex(/^[0-9a-f-]{36}:\d{1,2}$/i))
      .min(1)
      .max(9900)
      .optional(),
  })
  .strict();
export async function drawer(tx: Tx, s: Session) {
  const [d] =
    await tx`select * from cash_sessions where device_id=${s.deviceId} and closed_at is null for update`;
  if (!d) throw new DomainError("drawer_required", 409);
  return d;
}
export async function recordPayment(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
  groupId: string | null = null,
) {
  permit(s, operators);
  const p = paymentInput.parse(raw);
  return once(tx, s, p.operationId, "payment", { orderId, ...p }, async () => {
    await tx`select id from orders where id=${orderId} for update`;
    const o = await getOrder(tx, orderId);
    if (p.amount > o.total - o.paid) throw new DomainError("overpayment", 409);
    if (p.received < p.amount + p.tip)
      throw new DomainError("insufficient_cash");
    if (
      p.method === "external" &&
      (!p.externalConfirmed || !p.reference.trim())
    )
      throw new DomainError("external_confirmation");
    if (p.items && !o.itemSplitAvailable)
      throw new DomainError("unallocated_history", 409);
    const allocations = o.itemSplitAvailable
      ? allocatePayment(o.paymentUnits!, p.amount, p.items)
      : [];
    const d = await drawer(tx, s);
    const tenderId = randomUUID();
    await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,external_reference,group_id) values(${s.tenantId},${tenderId},${orderId},${d.id},${p.method},${p.amount},${p.tip},${p.received},${p.reference},${groupId})`;
    for (const allocation of allocations)
      await tx`insert into tender_allocations(tenant_id,order_id,tender_id,line_id,unit_index,amount) values(${s.tenantId},${orderId},${tenderId},${allocation.lineId},${allocation.unit},${allocation.amount})`;
    await audit(tx, s, "payment.recorded", orderId, {
      method: p.method,
      amount: p.amount,
      tip: p.tip,
    });
    const receipt = await getOrder(tx, orderId);
    await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,error_code) values(${s.tenantId},${randomUUID()},'receipt',${p.operationId},${tx.json({ orderId, receipt })},'blocked','printer_not_paired')`;
    return receipt;
  });
}
