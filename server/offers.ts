import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { hash, managers, matches, permit } from "./auth.js";
import { audit, catalog, once } from "./orders.js";
import {
  DomainError,
  id,
  quote,
  sum,
  type ManualDiscount,
  type OrderInput,
  type Session,
} from "../shared/domain.js";
import {
  applyOffers,
  offerClock,
  offerInput,
  OFFER_RULES_VERSION,
  type AppliedOffer,
  type Offer,
  type OfferQuote,
} from "../shared/offers.js";

const day = (value: Date | string | null) =>
  value === null
    ? null
    : typeof value === "string"
      ? value.slice(0, 10)
      : value.toISOString().slice(0, 10);
export async function listOffers(tx: Tx): Promise<Offer[]> {
  const rows = await tx`select p.*,
      (select count(*)::int from promotion_redemptions r
        where r.tenant_id=p.tenant_id and r.promotion_id=p.id) as redeemed
    from promotions p order by p.active desc,p.name,p.id`;
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    name: r.name,
    kind: r.kind,
    value: r.value,
    scope: r.scope,
    targets: r.targets,
    minSubtotal: r.min_subtotal,
    maxReduction: r.max_reduction,
    days: r.days,
    fromMinute: r.from_minute,
    toMinute: r.to_minute,
    startsOn: day(r.starts_on),
    endsOn: day(r.ends_on),
    channels: r.channels,
    code: r.code,
    usageLimit: r.usage_limit,
    stackable: r.stackable,
    active: r.active,
    redeemed: r.redeemed,
  }));
}
export async function saveOffer(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = offerInput.parse(raw);
  return once(tx, s, p.operationId, "offer.save", p, async () => {
    const o = p.offer;
    const [old] =
      await tx`select version from promotions where id=${o.id} for update`;
    if ((old?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("stale_order", 409);
    if (o.code) {
      const [taken] =
        await tx`select id from promotions where code=${o.code} and id<>${o.id}`;
      if (taken) throw new DomainError("promo_code_taken", 409);
    }
    if (o.scope === "product") {
      const known = new Set((await catalog(tx)).map((product) => product.id));
      if (o.targets.some((target) => !known.has(target)))
        throw new DomainError("invalid_target");
    }
    const version = p.expectedVersion + 1;
    await tx`insert into promotions(tenant_id,id,version,name,kind,value,scope,targets,min_subtotal,max_reduction,days,from_minute,to_minute,starts_on,ends_on,channels,code,usage_limit,stackable,active)
      values(${s.tenantId},${o.id},${version},${o.name},${o.kind},${o.value},${o.scope},${tx.json(o.targets)},${o.minSubtotal},${o.maxReduction},${o.days},${o.fromMinute},${o.toMinute},${o.startsOn},${o.endsOn},${o.channels},${o.code},${o.usageLimit},${o.stackable},${o.active})
      on conflict(tenant_id,id) do update set version=excluded.version,name=excluded.name,kind=excluded.kind,value=excluded.value,scope=excluded.scope,targets=excluded.targets,min_subtotal=excluded.min_subtotal,max_reduction=excluded.max_reduction,days=excluded.days,from_minute=excluded.from_minute,to_minute=excluded.to_minute,starts_on=excluded.starts_on,ends_on=excluded.ends_on,channels=excluded.channels,code=excluded.code,usage_limit=excluded.usage_limit,stackable=excluded.stackable,active=excluded.active`;
    await audit(tx, s, "offer.saved", o.id, { version, definition: o });
    return { ...o, version };
  });
}

const binding = (
  requesterId: string,
  operationId: string,
  manual: Pick<ManualDiscount, "kind" | "value">,
) =>
  hash(
    JSON.stringify([
      "manual_discount",
      requesterId,
      operationId,
      manual.kind,
      manual.value,
    ]),
  );
export const approvalInput = z
  .object({
    login: z.string().min(1).max(100),
    secret: z.string().min(4).max(200),
    operationId: id,
    kind: z.enum(["percent", "amount"]),
    value: z.number().int().min(1).max(100_000_000),
  })
  .strict();
/** A manager authorizes one exact discount on one exact order submission. */
export async function requestApproval(tx: Tx, s: Session, raw: unknown) {
  const p = approvalInput.parse(raw);
  const [approver] =
    await tx`select id,name,role,secret_hash from employees where login=${p.login} and active`;
  if (
    !approver ||
    !managers.includes(approver.role) ||
    !matches(p.secret, approver.secret_hash)
  )
    throw new DomainError("invalid_approval", 401);
  const approvalId = randomUUID();
  const [row] =
    await tx`insert into approvals(tenant_id,id,approver_id,requester_id,action,binding,expires_at)
      values(${s.tenantId},${approvalId},${approver.id},${s.employeeId},'manual_discount',${binding(s.employeeId, p.operationId, p)},now()+interval '5 minutes')
      returning expires_at`;
  await audit(tx, s, "approval.granted", approvalId, {
    action: "manual_discount",
    approverId: approver.id,
    operationId: p.operationId,
    kind: p.kind,
    value: p.value,
  });
  return {
    approvalId,
    approver: approver.name,
    expiresAt: row.expires_at.toISOString(),
  };
}
async function authorizeManual(tx: Tx, s: Session, input: OrderInput) {
  const manual = input.manualDiscount;
  if (!manual) return null;
  if (!["pos"].includes(input.channel)) throw new DomainError("forbidden", 403);
  if (managers.includes(s.role)) return null;
  if (!manual.approvalId) throw new DomainError("approval_required", 403);
  const [approval] =
    await tx`select *,expires_at>now() as live from approvals where id=${manual.approvalId} for update`;
  if (
    !approval ||
    approval.consumed_at ||
    !approval.live ||
    approval.requester_id !== s.employeeId ||
    approval.binding !== binding(s.employeeId, input.operationId, manual)
  )
    throw new DomainError("approval_required", 403);
  await tx`update approvals set consumed_at=now() where id=${approval.id}`;
  return approval.id as string;
}

export type PricedOrder = OfferQuote & { approvalId: string | null };
/**
 * The only place an order submission is priced. `commit` locks limited offers
 * and consumes any manager approval; previews pass `commit=false`.
 */
export async function priceOrder(
  tx: Tx,
  s: Session,
  input: OrderInput,
  firstRound: boolean,
  commit: boolean,
): Promise<PricedOrder> {
  const products = await catalog(tx);
  const priced = quote(input.lines, products, managers.includes(s.role));
  if (input.channel === "offline") {
    // Offline sales are priced on the device with no network; they never carry
    // offers, so the synchronized total always equals what the guest paid.
    if (input.code || input.manualDiscount)
      throw new DomainError("offers_unavailable_offline", 409);
    const total = sum(priced.map((l) => l.total));
    return {
      rules: OFFER_RULES_VERSION,
      lines: priced,
      subtotal: total,
      discount: 0,
      total,
      applied: [],
      code: null,
      approvalId: null,
    };
  }
  if (input.code && !firstRound)
    throw new DomainError("promo_code_not_eligible", 409);
  if (commit)
    await tx`select id from promotions where active and usage_limit is not null order by id for update`;
  const approvalId = commit ? await authorizeManual(tx, s, input) : null;
  if (!commit && input.manualDiscount && input.channel !== "pos")
    throw new DomainError("forbidden", 403);
  const result = applyOffers(
    priced,
    Object.fromEntries(products.map((p) => [p.id, p.category.es])),
    await listOffers(tx),
    {
      channel: input.channel,
      clock: offerClock(new Date().toISOString(), s.restaurant.timezone),
      firstRound,
      code: input.code ?? null,
      manual: input.manualDiscount ?? null,
    },
  );
  if (
    commit &&
    result.code &&
    ["invalid", "not_eligible"].includes(result.code.status)
  )
    throw new DomainError("promo_code_" + result.code.status, 409);
  return { ...result, approvalId };
}
export async function redeem(
  tx: Tx,
  s: Session,
  orderId: string,
  round: number,
  priced: PricedOrder,
) {
  for (const a of priced.applied)
    await tx`insert into promotion_redemptions(tenant_id,id,order_id,round,kind,promotion_id,promotion_version,name,code,amount,reason,actor_id,approval_id)
      values(${s.tenantId},${randomUUID()},${orderId},${round},${a.kind},${a.id},${a.version},${a.name},${a.code},${a.amount},${a.reason ?? null},${s.employeeId},${a.kind === "manual" ? priced.approvalId : null})`;
  if (priced.applied.length)
    await audit(tx, s, "order.discounted", orderId, {
      round,
      rules: priced.rules,
      subtotal: priced.subtotal,
      discount: priced.discount,
      applied: priced.applied,
      approvalId: priced.approvalId,
    });
}
/** Rows of one round share a transaction timestamp, so the order shown on
 * receipts is defined explicitly: promotions, then the manual discount. */
export async function orderDiscounts(
  tx: Tx,
  orderId: string,
): Promise<AppliedOffer[]> {
  const rows =
    await tx`select kind,promotion_id,promotion_version,name,code,amount,reason from promotion_redemptions where order_id=${orderId} order by round,(kind='manual'),amount desc,id`;
  return rows.map((r) => ({
    kind: r.kind,
    id: r.promotion_id,
    version: r.promotion_version,
    name: r.name,
    code: r.code,
    amount: r.amount,
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}
/** Preview with the same calculation as checkout; never writes. */
export function publicQuote(q: OfferQuote) {
  return {
    rules: q.rules,
    subtotal: q.subtotal,
    discount: q.discount,
    total: q.total,
    applied: q.applied.map(({ kind, name, code, amount }) => ({
      kind,
      name,
      code,
      amount,
    })),
    code: q.code,
    lines: q.lines.map((l) => ({
      id: l.id,
      total: l.total,
      gross: l.gross ?? l.total,
      discount: l.discount ?? 0,
    })),
  };
}
