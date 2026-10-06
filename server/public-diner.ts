// Diner commands of public QR/kiosk ordering (032). Each runs inside
// tenant(sql, resolved.tenantId, fn) and has no outside side effects (wave
// rule 0.7): no logging here, the router logs. A submitted order becomes a
// hold: no order number, round, kitchen job, stock movement, feed bump or
// fiscal ticket until a person accepts it (server/public-holds.ts).
import { createHash, randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { requirePro } from "./entitlements.js";
import { catalog, menuRevision, publicCatalog } from "./menu-read.js";
import { staffOnlineSql } from "./public-links.js";
import { statusHash } from "./public-tokens.js";
import { restaurantPrivacyUrl } from "./compat/public-account.js";
import { fiscalTicketIdentity } from "./compat/public-fiscal.js";
import { selfInvoiceOffered } from "./compat/public-cfdi.js";
import {
  DomainError,
  businessDate,
  quote,
  sum,
  type PricedLine,
  type Product,
} from "../shared/domain.js";
import {
  PUBLIC_LIMITS,
  PUBLIC_TOKEN,
  canonicalRequest,
  dinerRejectReason,
  holdLabel,
  publicOrderInput,
  roundProgress,
  type DinerHoldView,
  type HoldPolicy,
  type LinkKind,
  type OrderingState,
  type PricedHoldLine,
  type PublicLine,
  type PublicMenuView,
  type RejectReason,
} from "../shared/public-ordering.js";

type LinkContext = {
  id: string;
  kind: LinkKind;
  channel: "qr" | "kiosk";
  table_id: string | null;
  table_name: string | null;
  table_archived: boolean;
  label: string;
  revoked: boolean;
  name: string;
  currency: string;
  timezone: string;
  cutoff: number;
  paused: boolean;
  table_policy: HoldPolicy;
  counter_policy: HoldPolicy;
  hold_minutes: number;
  max_order_total: number;
  staff_online: boolean;
};

/** The link, its table, the restaurant and the ordering settings: one statement. */
async function linkContext(tx: Tx, linkId: string): Promise<LinkContext> {
  const [c] = await tx<
    LinkContext[]
  >`select l.id,l.kind,l.channel,l.table_id,l.label,l.revoked_at is not null as revoked,
      t.name as table_name,(t.archived_at is not null) as table_archived,
      r.name,r.currency,r.timezone,r.cutoff,
      coalesce(s.paused,false) as paused,coalesce(s.table_policy,'accept') as table_policy,
      coalesce(s.counter_policy,'accept') as counter_policy,coalesce(s.hold_minutes,30) as hold_minutes,
      coalesce(s.max_order_total,1000000) as max_order_total,
      ${staffOnlineSql(tx)} as staff_online
    from public_links l join restaurants r on r.id=l.tenant_id
    left join dining_tables t on t.tenant_id=l.tenant_id and t.id=l.table_id
    left join public_ordering_settings s on s.tenant_id=l.tenant_id
    where l.id=${linkId}`;
  if (!c) throw new DomainError("public_link_invalid", 404);
  return c;
}

/** Diners never learn why ordering is closed (paused or no staff terminal). */
function orderingState(c: LinkContext): OrderingState {
  const reason = c.table_archived
    ? "table_unavailable"
    : c.paused || !c.staff_online
      ? "paused"
      : null;
  return {
    open: reason === null,
    reason,
    policy: c.kind === "table" ? c.table_policy : c.counter_policy,
    holdMinutes: c.hold_minutes,
    maxTotal: c.max_order_total,
  };
}

async function activeContext(tx: Tx, linkId: string) {
  const c = await linkContext(tx, linkId);
  if (c.revoked) throw new DomainError("public_link_invalid", 404);
  await requirePro(tx);
  return c;
}

/** The menu for a link: browsable even while ordering is closed. */
export async function dinerMenu(
  tx: Tx,
  linkId: string,
): Promise<PublicMenuView> {
  const c = await activeContext(tx, linkId);
  // Revision first: a menu change committed between the two reads then only
  // causes one extra refetch, never a missed one (MENU-R1).
  const { revision } = await menuRevision(tx);
  const products = (await publicCatalog(tx)) as Product[];
  return {
    link: {
      kind: c.kind,
      channel: c.channel,
      tableName: c.table_name,
      label: c.label,
    },
    restaurant: {
      name: c.name,
      currency: c.currency,
      timezone: c.timezone,
      privacyNoticeUrl: await restaurantPrivacyUrl(tx),
    },
    ordering: orderingState(c),
    revision,
    catalog: products,
  };
}

/** The minute poll: the menu revision and whether ordering is open now. */
export async function dinerRevision(
  tx: Tx,
  linkId: string,
): Promise<{ revision: number; ordering: OrderingState }> {
  const c = await activeContext(tx, linkId);
  const { revision } = await menuRevision(tx);
  return { revision, ordering: orderingState(c) };
}

type HoldRow = {
  id: string;
  link_id: string;
  request_hash: string;
  number: number;
  channel: "qr" | "kiosk";
  mode: "dine_in" | "takeaway";
  table_id: string | null;
  policy: HoldPolicy;
  priced: PricedHoldLine[];
  quoted_total: number;
  state: "pending" | "accepted" | "rejected" | "cancelled";
  created_at: Date;
  expires_at: Date;
  reject_reason: RejectReason | null;
  order_id: string | null;
  order_round: number | null;
  excluded_line_ids: string[];
  expired: boolean;
};

const holdKind = (h: HoldRow): LinkKind =>
  h.table_id ? "table" : h.channel === "kiosk" ? "kiosk" : "counter";

/** The diner's view of a hold; accepted holds add one order statement (plus fiscal from 027). */
async function holdView(tx: Tx, h: HoldRow): Promise<DinerHoldView> {
  const excluded = new Set(h.excluded_line_ids ?? []);
  const lines = h.priced.map((l) => ({ ...l, excluded: excluded.has(l.id) }));
  const view: DinerHoldView = {
    label: holdLabel(h.channel, h.number),
    state: h.state === "pending" && h.expired ? "expired" : h.state,
    kind: holdKind(h),
    policy: h.policy,
    createdAt: h.created_at.toISOString(),
    expiresAt: h.expires_at.toISOString(),
    lines,
    total: sum(lines.filter((l) => !l.excluded).map((l) => l.total)),
    rejectReason: dinerRejectReason(h.reject_reason),
    order: null,
  };
  if (h.state !== "accepted" || !h.order_id || !h.order_round) return view;
  // Round 1 is a new check; an appended round is always 2 or later.
  const target = h.order_round === 1 ? "new" : "append";
  const [o] = await tx`select o.number,o.total,
      coalesce((select sum(t.amount) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0)::int as paid,
      coalesce((select array_agg(r.state order by r.station) from rounds r
        where r.tenant_id=o.tenant_id and r.order_id=o.id and r.number=${h.order_round}),'{}') as states
    from orders o where o.id=${h.order_id}`;
  if (!o) return view;
  let fiscal: NonNullable<DinerHoldView["order"]>["fiscal"] = null;
  if (target === "new") {
    const ticket = await fiscalTicketIdentity(tx, h.order_id);
    if (ticket)
      fiscal = {
        folio: ticket.folio,
        selfInvoiceCode: (await selfInvoiceOffered(tx))
          ? ticket.selfInvoiceCode
          : null,
      };
  }
  view.order = {
    number: o.number,
    target,
    progress: roundProgress(o.states as string[]),
    money:
      target === "new"
        ? { total: o.total, paid: o.paid, balance: o.total - o.paid }
        : null,
    fiscal,
  };
  return view;
}

/**
 * A diner submits an order: it becomes a pending hold after the link, plan,
 * liveness, price, maximum and the durable caps are checked. Idempotent on
 * the diner's operationId; never calls append, stock, bumpKitchenFeed,
 * refreshCheckState, fiscal or a job.
 */
export async function submitHold(
  tx: Tx,
  linkId: string,
  raw: unknown,
): Promise<DinerHoldView> {
  const p = publicOrderInput.parse(raw);
  const requestHash = createHash("sha256")
    .update(canonicalRequest(p))
    .digest("hex");
  // LO-1: the diner's idempotency key, disjoint from staff once() keys.
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':public-op:'||${p.operationId},0))`;
  const [prior] = await tx<
    HoldRow[]
  >`select *,(state='pending' and expires_at<=now()) as expired from public_order_holds where operation_id=${p.operationId}`;
  if (prior) {
    if (prior.link_id !== linkId || prior.request_hash !== requestHash)
      throw new DomainError("operation_conflict", 409);
    return holdView(tx, prior);
  }
  const keyHash = statusHash(p.statusKey);
  const [reused] =
    await tx`select 1 from public_order_holds where status_key_hash=${keyHash}`;
  if (reused) throw new DomainError("operation_conflict", 409);

  const c = await activeContext(tx, linkId);
  const ordering = orderingState(c);
  if (ordering.reason === "table_unavailable")
    throw new DomainError("public_table_unavailable", 409);
  if (ordering.reason === "paused")
    throw new DomainError("public_ordering_paused", 409);

  const { revision } = await menuRevision(tx);
  let priced: PricedLine[];
  try {
    priced = quote(
      p.lines.map((l) => ({ ...l, note: "" })),
      await catalog(tx),
      false,
    );
  } catch (e) {
    // Repeated line ids come only from a modified client.
    if (e instanceof DomainError && e.code === "duplicate_line")
      throw new DomainError("invalid_input");
    throw e;
  }
  const total = sum(priced.map((l) => l.total));
  if (total !== p.expectedTotal)
    throw new DomainError("public_price_changed", 409);
  if (total > c.max_order_total)
    throw new DomainError("public_order_too_large", 409);

  // LO-3: exact durable caps per table (every link of it) or per link.
  const scope = c.table_id ?? c.id;
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':public-hold:'||${scope},0))`;
  const [counts] = await tx`select
      count(*) filter (where state='pending' and expires_at>now())::int as pending,
      count(*) filter (where created_at>now()-make_interval(mins=>${PUBLIC_LIMITS.windowMinutes}))::int as recent
    from public_order_holds
    where created_at>now()-interval '2 hours'
      and ${c.table_id ? tx`table_id=${c.table_id}` : tx`link_id=${c.id}`}`;
  const cap = PUBLIC_LIMITS[c.kind];
  if (counts.pending >= cap.pending || counts.recent >= cap.perWindow)
    throw new DomainError("public_order_limit", 429);
  // A soft restaurant cap, counted without a lock.
  const [tenantCount] =
    await tx`select count(*)::int as n from public_order_holds where state='pending' and expires_at>now()`;
  if (tenantCount.n >= PUBLIC_LIMITS.tenantPending)
    throw new DomainError("public_ordering_busy", 429);
  if (c.table_id) {
    const [t] =
      await tx`select id from dining_tables where id=${c.table_id} and archived_at is null for share`;
    if (!t) throw new DomainError("public_table_unavailable", 409);
  }
  const date = businessDate(new Date().toISOString(), c.timezone, c.cutoff);
  const [number] =
    await tx`insert into public_hold_numbers(tenant_id,business_date,value)
      values(current_setting('app.tenant_id')::uuid,${date},1)
      on conflict (tenant_id,business_date) do update set value=public_hold_numbers.value+1
      returning value`;
  // Server line ids: they become order_lines keys at acceptance, so a diner can
  // never choose one (a reused id would fail the accept). request_hash covers
  // the diner's own body, so a replay still matches.
  const ids = priced.map(() => randomUUID());
  const lines: PublicLine[] = p.lines.map((l, i) => ({
    id: ids[i],
    productId: l.productId,
    quantity: l.quantity,
    options: l.options,
  }));
  const shown: PricedHoldLine[] = priced.map((l, i) => ({
    id: ids[i],
    quantity: l.quantity,
    name: l.name,
    optionNames: l.optionNames,
    unitPrice: l.unitPrice,
    total: l.total,
  }));
  const [hold] = await tx<
    HoldRow[]
  >`insert into public_order_holds(tenant_id,id,link_id,operation_id,request_hash,status_key_hash,
      business_date,number,channel,mode,table_id,policy,name,note,lines,priced,quoted_total,
      menu_revision,order_operation_id,expires_at)
    values(current_setting('app.tenant_id')::uuid,${randomUUID()},${c.id},${p.operationId},${requestHash},${keyHash},
      ${date},${number.value},${c.channel},${c.table_id ? "dine_in" : "takeaway"},${c.table_id},${ordering.policy},
      ${p.name},${p.note},${tx.json(lines)},${tx.json(shown as never)},${total},${revision},${randomUUID()},
      now()+make_interval(mins=>${c.hold_minutes}))
    returning *,false as expired`;
  return holdView(tx, hold);
}

const holdByKey = (tx: Tx, linkId: string, statusKey: string, lock = false) =>
  tx<
    HoldRow[]
  >`select *,(state='pending' and expires_at<=now()) as expired from public_order_holds
    where status_key_hash=${statusHash(statusKey)} and link_id=${linkId}
    ${lock ? tx`for update` : tx``}`;

/**
 * The diner's status page. Lookups go through the link the hold was sent
 * from, active or not, so a replaced QR keeps its pending orders readable.
 * At most 5 statements: the hold, the order, and (from 027/030) the ticket
 * identity and the self-invoice offer. Never calls getOrder.
 */
export async function holdStatus(
  tx: Tx,
  linkId: string,
  statusKey: string,
): Promise<DinerHoldView> {
  if (!PUBLIC_TOKEN.test(statusKey))
    throw new DomainError("public_hold_not_found", 404);
  const [h] = await holdByKey(tx, linkId, statusKey);
  if (!h) throw new DomainError("public_hold_not_found", 404);
  return holdView(tx, h);
}

/** The diner cancels a pending hold (LO-2b: the hold row is its only lock). */
export async function cancelHold(
  tx: Tx,
  linkId: string,
  statusKey: string,
): Promise<DinerHoldView> {
  if (!PUBLIC_TOKEN.test(statusKey))
    throw new DomainError("public_hold_not_found", 404);
  const [h] = await holdByKey(tx, linkId, statusKey, true);
  if (!h) throw new DomainError("public_hold_not_found", 404);
  if (h.state !== "pending")
    throw new DomainError("public_order_not_pending", 409);
  if (h.expired) throw new DomainError("public_order_expired", 409);
  const [done] = await tx<
    HoldRow[]
  >`update public_order_holds set state='cancelled',decided_at=clock_timestamp()
    where id=${h.id} returning *,false as expired`;
  return holdView(tx, done);
}
