import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import {
  DomainError,
  currencyExponent,
  quote,
  businessDate,
  type Session,
} from "../shared/domain.js";
import { offlineSale } from "../shared/offline-recovery.js";
import { hash, permit, managers, operators } from "./auth.js";
import {
  once,
  audit,
  drawer,
  catalog,
  createOrder,
  recordPayment,
  getOrder,
} from "./orders.js";
export const offlineInput = offlineSale;
async function originalContext(tx: Tx, p: z.infer<typeof offlineInput>) {
  const [session] = await tx`select * from sessions where id=${p.sessionId}`;
  const [lease] =
    await tx`select * from offline_leases where session_id=${p.sessionId}`;
  const [cash] =
    await tx`select * from cash_sessions where id=${p.cashSessionId}`;
  if (
    !session ||
    !lease ||
    !cash ||
    cash.device_id !== session.device_id ||
    p.received < p.expectedTotal + p.tip ||
    new Date(p.recordedAt) > new Date() ||
    new Date(p.recordedAt) < cash.opened_at ||
    (cash.closed_at && new Date(p.recordedAt) > cash.closed_at) ||
    new Date(p.recordedAt) < lease.issued_at ||
    new Date(p.recordedAt) > lease.valid_until
  )
    throw new DomainError("offline_context_invalid", 409);
  if (
    "formatVersion" in p &&
    (p.tenantId !== session.tenant_id ||
      p.employeeId !== lease.employee_id ||
      p.deviceId !== lease.device_id ||
      p.leaseVersion !== lease.contract_version ||
      p.currency !== lease.restaurant_snapshot.currency ||
      p.currencyExponent !== currencyExponent(p.currency) ||
      p.configurationVersion !== lease.configuration_version)
  )
    throw new DomainError("offline_context_invalid", 409);
  return { session, lease, cash };
}
export async function synchronizeOffline(tx: Tx, s: Session, raw: unknown) {
  const p = offlineInput.parse(raw);
  permit(s, operators);
  return once(tx, s, p.operationId, "offline_sync", p, async () => {
    const { session, lease } = await originalContext(tx, p);
    const [identity] =
      await tx`select e.active as employee_active,d.active as device_active
      from employees e cross join devices d where e.id=${session.employee_id} and d.id=${session.device_id}`;
    if (
      session.employee_id !== s.employeeId ||
      session.device_id !== s.deviceId ||
      session.revoked ||
      !identity?.employee_active ||
      !identity?.device_active ||
      !lease.selling_authorized ||
      new Date(p.recordedAt) > lease.valid_until
    )
      throw new DomainError("offline_conflict", 409);
    const d = await drawer(tx, s);
    if (d.id !== p.cashSessionId)
      throw new DomainError("offline_drawer_conflict", 409);
    const [restaurant] =
      await tx`select config_version from restaurants where id=${s.tenantId} for share`;
    if (restaurant.config_version !== lease.configuration_version)
      throw new DomainError("settings_changed", 409);
    // Hold the catalog versions through createOrder, so a concurrent edit cannot
    // change the recipe between verification and stock consumption.
    const productIds = [
      ...new Set(p.order.lines.map((line) => line.productId)),
    ].sort();
    const versions =
      await tx`select id,data from catalog where id=any(${tx.array(productIds)}::uuid[]) order by id for share`;
    const priced = quote(p.order.lines, await catalog(tx), false);
    if (priced.reduce((a, l) => a + l.total, 0) !== p.expectedTotal)
      throw new DomainError("price_conflict", 409);
    const snapshots =
      "receiptSnapshot" in p ? p.receiptSnapshot?.lines : undefined;
    for (const line of p.order.lines) {
      const current = versions.find((product) => product.id === line.productId);
      const snapshot = snapshots?.find(
        (
          value,
        ): value is { id: string; productId: string; productVersion: number } =>
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          value.id === line.id &&
          "productId" in value &&
          value.productId === line.productId &&
          "productVersion" in value &&
          Number.isInteger(value.productVersion),
      );
      // Legacy evidence has no catalog revision. A never-edited product is safe;
      // an edited product requires review rather than invented historical stock.
      if (
        current &&
        (snapshot
          ? snapshot.productVersion !== current.data.version
          : current.data.version !== 1)
      )
        throw new DomainError("offline_conflict", 409);
    }
    const order = await createOrder(
      tx,
      s,
      { ...p.order, channel: "offline" },
      true,
    );
    return recordPayment(tx, s, order.id, {
      operationId: randomUUID(),
      method: "cash",
      amount: p.expectedTotal,
      tip: p.tip,
      received: p.received,
    });
  });
}
export async function reviewOffline(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = offlineInput.parse(raw);
  const { session, lease, cash } = await originalContext(tx, p);
  const [prior] =
    await tx`select kind,hash,result from operations where id=${p.operationId}`;
  let currentTotal: number | null = null;
  try {
    currentTotal = quote(p.order.lines, await catalog(tx), false).reduce(
      (a, l) => a + l.total,
      0,
    );
  } catch {
    /* Unavailable/deleted menu is explicitly unknown. */
  }
  const [employee] =
    await tx`select name from employees where id=${lease.employee_id}`;
  return {
    collected: p.expectedTotal,
    tip: p.tip,
    recordedAt: p.recordedAt,
    currentTotal,
    originalEmployee: employee?.name,
    originalDeviceId: lease.device_id,
    originalDrawerId: cash.id,
    drawerClosed: !!cash.closed_at,
    sessionRevoked: session.revoked,
    evidenceVersion: lease.contract_version,
    prior: prior ? { kind: prior.kind } : null,
  };
}
export async function reconcileOffline(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const { sale: p, reason } = z
    .object({
      sale: offlineInput,
      reason: z.string().trim().min(10).max(500),
      confirmed: z.literal(true),
    })
    .strict()
    .parse(raw);
  // Same key AND normalized payload as ordinary sync: either path wins once.
  return once(tx, s, p.operationId, "offline_sync", p, async () => {
    const { lease } = await originalContext(tx, p);
    const [cash] =
      await tx`select * from cash_sessions where id=${p.cashSessionId} for update`;
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + p.order.operationId},0))`;
    const [existingOrder] =
      await tx`select id from operations where id=${p.order.operationId}`;
    if (existingOrder)
      throw new DomainError("offline_order_already_exists", 409);
    const originalRestaurant =
      lease.restaurant_snapshot as Session["restaurant"];
    const date = businessDate(
      p.recordedAt,
      originalRestaurant.timezone,
      originalRestaurant.cutoff,
    );
    const [number] =
      await tx`insert into order_numbers(tenant_id,business_date,value) values(${s.tenantId},${date},1) on conflict(tenant_id,business_date) do update set value=order_numbers.value+1 returning value`;
    const orderId = randomUUID(),
      tenderId = randomUUID(),
      recoveryId = randomUUID();
    // Financial recovery is deliberately not a reconstructed fulfillment order.
    // Keep the claimed source lines in audit; do not invent historical unit prices,
    // repeat kitchen dispatch, or deduct current recipes from stock.
    await tx`insert into orders(tenant_id,id,number,business_date,employee_id,table_id,mode,name,note,channel,total,state,restaurant_snapshot) values(${s.tenantId},${orderId},${number.value},${date},${lease.employee_id},null,${p.order.mode},${p.order.name},${"Offline cash reconciliation: " + reason},'offline',${p.expectedTotal},'recovery_pending',${tx.json(originalRestaurant)})`;
    await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,source,source_id,created_at) values(${s.tenantId},${tenderId},${orderId},${cash.id},'cash',${p.expectedTotal},${p.tip},${p.received},'offline_recovery',${p.operationId},clock_timestamp())`;
    await tx`insert into offline_recoveries(
      tenant_id,id,operation_id,order_operation_id,original_session_id,
      original_employee_id,original_device_id,original_drawer_id,actor_id,
      reason,evidence_version,evidence,order_id,tender_id,original_sold_at,recognized_at
    ) values(
      ${s.tenantId},${recoveryId},${p.operationId},${p.order.operationId},
      ${p.sessionId},${lease.employee_id},${lease.device_id},${cash.id},
      ${s.employeeId},${reason},${lease.contract_version},${tx.json(p as any)},
      ${orderId},${tenderId},${p.recordedAt},clock_timestamp()
    )`;
    for (const kind of ["kitchen", "stock"])
      await tx`insert into offline_recovery_tasks(tenant_id,id,recovery_id,kind) values(${s.tenantId},${randomUUID()},${recoveryId},${kind})`;
    await audit(tx, s, "offline.reconciled", orderId, {
      reason,
      original: p,
      originalEmployeeId: lease.employee_id,
      originalDeviceId: lease.device_id,
      originalDrawerClosed: !!cash.closed_at,
      recoveryId,
      fulfillment: "pending",
      stock: "pending",
    });
    const result = await getOrder(tx, orderId);
    await tx`insert into operations(tenant_id,id,kind,hash,result) values(${s.tenantId},${p.order.operationId},'create_order',${hash(JSON.stringify({ ...p.order, channel: "offline" }))},${tx.json(result)})`;
    return result;
  });
}

export async function listOfflineRecoveries(tx: Tx, s: Session) {
  permit(s, managers);
  return tx`select r.id,r.operation_id,r.order_id,r.reason,r.original_sold_at,
    r.recognized_at,r.original_employee_id,r.original_device_id,
    r.original_drawer_id,r.item_allocation_complete,
    coalesce(jsonb_agg(jsonb_build_object('id',t.id,'kind',t.kind,'state',t.state,
      'resolution',t.resolution,'resolvedAt',t.resolved_at) order by t.kind)
      filter(where t.id is not null),'[]') as tasks
    from offline_recoveries r left join offline_recovery_tasks t
      on t.tenant_id=r.tenant_id and t.recovery_id=r.id
    group by r.tenant_id,r.id order by r.recognized_at desc`;
}

export async function resolveOfflineRecoveryTask(
  tx: Tx,
  s: Session,
  raw: unknown,
) {
  permit(s, managers);
  const p = z
    .object({
      operationId: z.uuid(),
      taskId: z.uuid(),
      outcome: z.enum(["already_completed", "not_completed"]),
      reason: z.string().trim().min(10).max(500),
    })
    .strict()
    .parse(raw);
  return once(tx, s, p.operationId, "offline_recovery.task", p, async () => {
    await tx`select o.id from orders o join offline_recoveries r on r.tenant_id=o.tenant_id and r.order_id=o.id
      join offline_recovery_tasks t on t.tenant_id=r.tenant_id and t.recovery_id=r.id where t.id=${p.taskId} for update of o`;
    const [task] = await tx`select t.*,r.order_id from offline_recovery_tasks t
      join offline_recoveries r on r.tenant_id=t.tenant_id and r.id=t.recovery_id
      where t.id=${p.taskId} for update of t`;
    if (!task) throw new DomainError("not_found", 404);
    if (task.state === "resolved")
      return {
        id: task.id,
        state: task.state,
        resolution: task.resolution,
      };
    const resolution = `${p.outcome}: ${p.reason}`;
    await tx`update offline_recovery_tasks set state='resolved',resolved_by=${s.employeeId},resolution=${resolution},resolved_at=now() where id=${task.id}`;
    const [remaining] =
      await tx`select count(*)::int as count from offline_recovery_tasks where recovery_id=${task.recovery_id} and state='pending'`;
    if (remaining.count === 0)
      await tx`update orders set state='recovery_reviewed' where id=${task.order_id}`;
    await audit(tx, s, `offline.${task.kind}_reviewed`, task.recovery_id, {
      outcome: p.outcome,
      reason: p.reason,
    });
    return { id: task.id, state: "resolved", resolution };
  });
}
