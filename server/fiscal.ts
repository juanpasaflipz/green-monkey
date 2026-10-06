// server/fiscal.ts — fiscal commands (migration 027, docs/FISCAL.md): the restaurant fiscal
// profile, ticket issuance with a gapless folio when a check is settled, refund tax
// adjustments, the ticket register, the IVA summary and the missing-ticket repair. Readers live
// in the leaf server/fiscal-read.ts and are re-exported here.
//
// Lock order (docs/ARCHITECTURE.md "Global lock order"): issueDueTicket takes the
// fiscal_folio_counters row (LO-12) and is always the last lock of its command; its callers
// already hold the order row (LO-5).
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type postgres from "postgres";
import type { Tx } from "./db.js";
import { managers, operators, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { audit, once } from "./orders.js";
import { discountsByLine } from "./discounts.js";
import {
  businessDate,
  DomainError,
  id,
  type PricedLine,
  type Session,
} from "../shared/domain.js";
import {
  BORDER_STIMULUS_VALID_UNTIL,
  effectiveFiscalIdentity,
  fiscalProfileInput,
  fiscalProfileIssues,
  formatFolio,
  orderTaxBreakdown,
  orderTaxSummary,
  parseFolio,
  productFiscalInput,
  refundScopeCategories,
  refundTaxSplit,
  selfInvoiceCodeFromBytes,
  TAX_CATEGORIES,
  TAX_RULES,
  ticketLineSnapshots,
  validateRfc,
  type CategoryTotals,
  type FiscalContextView,
  type FiscalProfileView,
  type FiscalSummary,
  type FiscalTicketView,
  type IssuerSnapshot,
  type RefundTaxScope,
  type RefundTaxView,
  type TaxCategory,
  type TaxSummary,
  type TicketLineSnapshot,
  type TicketRow,
} from "../shared/fiscal.js";
import {
  contextOf,
  fiscalContext,
  issuerOf,
  readTicket,
  refundViews,
  ticketView,
  type AdjustmentRecord,
  type ProfileRecord,
  type TicketRecord,
  type TicketTaxRecord,
} from "./fiscal-read.js";

export * from "./fiscal-read.js";

// ---------------------------------------------------------------------------------------------
// Profile and context
// ---------------------------------------------------------------------------------------------

type ProfileJoin = ProfileRecord & {
  trade_name: string;
  currency: string;
  version: number | null;
  border_confirmed_at: Date | null;
  updated_at: Date | null;
};

function contextView(r: ProfileJoin): FiscalContextView {
  const issuer = issuerOf(r.rfc ? r : null, r.trade_name);
  const ctx = contextOf(r.version ? r : null);
  return {
    version: r.version ?? 0,
    complete: !!issuer,
    multipleBranches: !!r.multiple_branches,
    currencySupported: r.currency === "MXN",
    issuer: issuer
      ? {
          rfc: issuer.rfc,
          legalName: issuer.legalName,
          regime: issuer.regime,
          regimeName: issuer.regimeName,
          postalCode: issuer.postalCode,
          address: issuer.address,
        }
      : null,
    tradeName: r.trade_name,
    ticketSeries: r.ticket_series ?? "",
    taxRegion: ctx.region,
    defaultTaxCategory: ctx.defaultCategory,
    borderStimulusValidUntil: BORDER_STIMULUS_VALID_UNTIL,
  };
}

/** What receipts and the product editor need (cached on the device for offline receipts). */
export async function fiscalContextView(
  tx: Tx,
  s: Session,
): Promise<FiscalContextView> {
  permit(s, operators);
  const [r] =
    await tx`select r.name as trade_name,r.currency,p.rfc,p.legal_name,p.regime,p.postal_code,
      p.address,p.ticket_series,p.tax_region,p.default_tax_category,p.multiple_branches,p.version
    from restaurants r left join restaurant_fiscal_profiles p on p.tenant_id=r.id
    where r.id=${s.tenantId}`;
  if (!r) throw new DomainError("not_found", 404);
  return contextView(r as unknown as ProfileJoin);
}

/** The Settings panel: the context plus edit rights, the last folio and repair state. */
export async function getFiscalProfile(
  tx: Tx,
  s: Session,
): Promise<FiscalProfileView> {
  permit(s, managers);
  const [r] =
    await tx`select r.name as trade_name,r.currency,p.rfc,p.legal_name,p.regime,p.postal_code,
      p.address,p.ticket_series,p.tax_region,p.default_tax_category,p.multiple_branches,p.version,
      p.border_confirmed_at,p.updated_at,e.name as updated_by_name,
      (select c.last_value from fiscal_folio_counters c
        where c.tenant_id=r.id and c.series=coalesce(p.ticket_series,'')) as last_value,
      (select jsonb_build_object('series',c.series,'number',c.last_value) from fiscal_folio_counters c
        join fiscal_tickets t on t.tenant_id=c.tenant_id and t.series=c.series and t.number=c.last_value
        where c.tenant_id=r.id and c.series<>coalesce(p.ticket_series,'')
        order by t.issued_at desc limit 1) as previous_folio,
      (select count(*)::int from catalog k where k.data->'fiscal'->>'taxCategory'='iva8'
        and not coalesce((k.data->>'archived')::boolean,false)) as iva8_products
    from restaurants r left join restaurant_fiscal_profiles p on p.tenant_id=r.id
    left join employees e on e.tenant_id=p.tenant_id and e.id=p.updated_by
    where r.id=${s.tenantId}`;
  if (!r) throw new DomainError("not_found", 404);
  const row = r as unknown as ProfileJoin & {
    updated_by_name: string | null;
    last_value: string | number | null;
    previous_folio: { series: string; number: string | number } | null;
    iva8_products: number;
  };
  return {
    ...contextView(row),
    canEdit: s.role === "owner",
    ticketsEnabled: enabled(),
    borderConfirmedAt: row.border_confirmed_at
      ? row.border_confirmed_at.toISOString()
      : null,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    updatedByName: row.updated_by_name ?? null,
    lastFolio:
      row.last_value === null
        ? null
        : formatFolio(row.ticket_series ?? "", Number(row.last_value)),
    // FISCAL-UI-9: a new series has no folio yet; the last one of the series used before.
    previousFolio:
      row.last_value === null && row.previous_folio
        ? formatFolio(
            row.previous_folio.series,
            Number(row.previous_folio.number),
          )
        : null,
    missingTickets: await missingTicketCount(tx),
    iva8Products: row.iva8_products,
  };
}

/**
 * Owner only, with a fresh PIN. Never touches restaurants or config_version, so queued
 * offline sales stay valid (offline-sync.ts evaluateEvidence E9).
 */
export async function saveFiscalProfile(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<FiscalProfileView> {
  permit(s, ["owner"]);
  requireRecentAuth(s);
  const p = fiscalProfileInput.parse(raw);
  const issue = fiscalProfileIssues(p).find((i) => !i.warning);
  if (issue) throw new DomainError(issue.code, 400);
  return once(tx, s, p.operationId, "fiscal.profile", p, async () => {
    // LO-3: the area key (class 922, an area key for the lock scanner like 920 and
    // 923) serializes the first creation, then the row itself.
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + ":fiscal-profile"},922))`;
    const [row] =
      await tx`select rfc,legal_name,regime,postal_code,address,ticket_series,tax_region,
        default_tax_category,multiple_branches,border_confirmed_at,border_confirmed_by,version
      from restaurant_fiscal_profiles for update`;
    if ((row?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("fiscal_profile_changed", 409);
    if (p.taxRegion === "general") {
      // LO-3, after the profile row: product saves take menu_state before they read the
      // region, so a concurrent IVA 8% product save is either counted here or sees the
      // general region (FISCAL-CONCURRENCY-3). The no-op upsert locks the row even if no
      // menu save created it yet.
      await tx`insert into menu_state(tenant_id,revision) values(${s.tenantId},0)
        on conflict(tenant_id) do update set revision=menu_state.revision`;
      const [products] =
        await tx`select count(*)::int as n from catalog where data->'fiscal'->>'taxCategory'='iva8'
          and not coalesce((data->>'archived')::boolean,false)`;
      if (products.n > 0)
        throw new DomainError("fiscal_border_products_exist", 409);
    }
    const keepBorder =
      p.taxRegion !== "general" &&
      row?.tax_region === p.taxRegion &&
      row?.border_confirmed_at;
    const borderAt =
      p.taxRegion === "general"
        ? null
        : keepBorder
          ? (row!.border_confirmed_at as Date)
          : new Date();
    const borderBy =
      p.taxRegion === "general"
        ? null
        : keepBorder
          ? (row!.border_confirmed_by as string)
          : s.employeeId;
    const identity = effectiveFiscalIdentity(p.identity);
    const values = {
      rfc: identity ? validateRfc(identity.rfc).rfc : null,
      legal_name: identity ? identity.legalName.trim() : null,
      regime: identity ? identity.regime.trim() : null,
      postal_code: identity ? identity.postalCode.trim() : null,
      address: identity ? identity.address : {},
      ticket_series: p.ticketSeries,
      tax_region: p.taxRegion,
      default_tax_category: p.defaultTaxCategory,
    };
    await tx`insert into restaurant_fiscal_profiles(tenant_id,rfc,legal_name,regime,postal_code,address,
        ticket_series,tax_region,default_tax_category,border_confirmed_at,border_confirmed_by,multiple_branches,
        version,updated_by,updated_at)
      values(${s.tenantId},${values.rfc},${values.legal_name},${values.regime},${values.postal_code},
        ${tx.json(values.address)},${values.ticket_series},${values.tax_region},${values.default_tax_category},
        ${borderAt},${borderBy},${p.multipleBranches},1,${s.employeeId},now())
      on conflict (tenant_id) do update set rfc=excluded.rfc,legal_name=excluded.legal_name,
        regime=excluded.regime,postal_code=excluded.postal_code,address=excluded.address,
        ticket_series=excluded.ticket_series,tax_region=excluded.tax_region,
        default_tax_category=excluded.default_tax_category,
        border_confirmed_at=excluded.border_confirmed_at,border_confirmed_by=excluded.border_confirmed_by,
        multiple_branches=excluded.multiple_branches,
        version=restaurant_fiscal_profiles.version+1,updated_by=excluded.updated_by,updated_at=now()`;
    const { operationId: _operationId, ...after } = p;
    await audit(tx, s, "fiscal.profile.saved", s.tenantId, {
      before: row
        ? {
            rfc: row.rfc,
            legalName: row.legal_name,
            regime: row.regime,
            postalCode: row.postal_code,
            address: row.address,
            ticketSeries: row.ticket_series,
            taxRegion: row.tax_region,
            defaultTaxCategory: row.default_tax_category,
            multipleBranches: row.multiple_branches,
            version: row.version,
          }
        : null,
      after,
    });
    return getFiscalProfile(tx, s);
  });
}

/**
 * For menu's saveMenuProduct: a product's fiscal field must parse, and IVA 8% needs a border
 * region.
 */
export async function assertProductFiscalAllowed(
  tx: Tx,
  fiscal: unknown,
): Promise<void> {
  const parsed = productFiscalInput.safeParse(fiscal ?? {});
  if (!parsed.success) throw new DomainError("fiscal_invalid_sat_key", 400);
  if (
    parsed.data.taxCategory === "iva8" &&
    (await fiscalContext(tx)).region === "general"
  )
    throw new DomainError("fiscal_border_rate_not_allowed", 400);
}

// ---------------------------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------------------------

/** 12 Crockford base-32 characters (60 bits) from fresh random bytes. */
export function newSelfInvoiceCode(bytes: Uint8Array = randomBytes(12)) {
  return selfInvoiceCodeFromBytes(bytes);
}

/** The issuer snapshot a ticket would freeze now, or null while the profile is incomplete. */
export async function issuerSnapshot(tx: Tx, s: Session) {
  const [r] =
    await tx`select r.name as trade_name,p.rfc,p.legal_name,p.regime,p.postal_code,p.address,
      p.ticket_series,p.tax_region,p.default_tax_category,p.multiple_branches
    from restaurants r left join restaurant_fiscal_profiles p on p.tenant_id=r.id
    where r.id=${s.tenantId}`;
  return r ? issuerOf(r as unknown as ProfileRecord, r.trade_name) : null;
}

/** postgres.js's row helper (Tx narrows the call signature to tagged templates). */
const helper = (tx: Tx) => tx as unknown as postgres.Sql;

const enabled = () => process.env.FISCAL_TICKETS_ENABLED !== "false";

/** The lines statement of getOrders' lines member, for one order. */
async function orderLines(tx: Tx, orderId: string): Promise<PricedLine[]> {
  const rows =
    await tx`select l.data,l.round,coalesce((select array_agg(u order by u) from line_voids v, unnest(v.units) u
        where v.tenant_id=l.tenant_id and v.line_id=l.id),'{}') as voided_units
      from order_lines l where l.order_id=${orderId} order by l.round,l.id`;
  return rows.map(
    (l) =>
      ({
        ...(l.data as PricedLine),
        round: l.round,
        voidedUnits: l.voided_units,
      }) as PricedLine,
  );
}

/** Everything a ticket freezes, computed before the folio counter is taken. */
type DueTicket = {
  orderId: string;
  source: FiscalTicketView["source"];
  businessDate: string;
  summary: TaxSummary;
  payments: FiscalTicketView["payments"];
  tip: number;
  issuer: IssuerSnapshot | null;
  series: string;
  ticketLines: TicketLineSnapshot[];
};

/**
 * Reads and computes the order's ticket without taking the folio counter (no lock): its stored
 * ticket, the ticket that is due, or null for a zero total, an unpaid balance or a non-MXN
 * restaurant. The caller holds FOR UPDATE on the order.
 */
async function prepareTicket(
  tx: Tx,
  orderId: string,
  source: DueTicket["source"],
): Promise<{ ticket: FiscalTicketView | null } | { due: DueTicket } | null> {
  const [o] =
    await tx`select o.total,o.business_date::text as business_date,r.currency,r.name as trade_name,
      coalesce((select sum(t.amount) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0)::int as paid,
      (select f.id from fiscal_tickets f where f.tenant_id=o.tenant_id and f.order_id=o.id) as ticket_id,
      p.rfc,p.legal_name,p.regime,p.postal_code,p.address,p.ticket_series,p.tax_region,p.default_tax_category,
      p.multiple_branches
    from orders o join restaurants r on r.id=o.tenant_id
    left join restaurant_fiscal_profiles p on p.tenant_id=o.tenant_id
    where o.id=${orderId}`;
  if (!o) throw new DomainError("not_found", 404);
  if (o.ticket_id) return { ticket: await readTicket(tx, o.ticket_id) };
  if (o.total <= 0 || o.paid < o.total || o.currency !== "MXN") return null;
  const profile = o.tax_region ? (o as unknown as ProfileRecord) : null;
  const lines = await orderLines(tx, orderId);
  // discounts (028): per-unit allocations by due, active and on non-voided units.
  const lineDiscounts = await discountsByLine(tx, orderId);
  const ctx = contextOf(profile);
  const breakdown = orderTaxBreakdown({
    lines,
    lineDiscounts,
    total: o.total,
    ctx,
  });
  const tenders =
    await tx`select method,amount,tip,external_reference,created_at from tenders
      where order_id=${orderId} order by created_at,id`;
  const payments = tenders.map((t) => ({
    method: t.method as "cash" | "external",
    amount: t.amount as number,
    tip: t.tip as number,
    reference: (t.external_reference as string | null) ?? null,
    at: (t.created_at as Date).toISOString(),
  }));
  return {
    due: {
      orderId,
      source,
      businessDate: o.business_date,
      summary: breakdown.summary,
      payments,
      tip: payments.reduce((a, p) => a + p.tip, 0),
      issuer: issuerOf(profile, o.trade_name),
      series: profile?.ticket_series ?? "",
      ticketLines: ticketLineSnapshots(lines, breakdown),
    },
  };
}

/**
 * LO-12: takes the series' next folio and inserts the ticket row, two statements (a row lock
 * and update, not a sequence, so a rollback restores it). Nothing after it locks below LO-12.
 */
async function insertDueTicket(
  tx: Tx,
  s: Session,
  due: DueTicket,
): Promise<TicketRecord> {
  const { summary } = due;
  const [counter] =
    await tx`insert into fiscal_folio_counters(tenant_id,series,last_value) values(${s.tenantId},${due.series},1)
      on conflict (tenant_id,series) do update set last_value=fiscal_folio_counters.last_value+1
      returning last_value`;
  const number = Number(counter.last_value);
  const ticketId = randomUUID();
  let inserted: { issued_at: Date; self_invoice_code: string } | undefined;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const code = newSelfInvoiceCode();
    [inserted] =
      (await tx`insert into fiscal_tickets(tenant_id,id,order_id,series,number,self_invoice_code,
        business_date,issued_by,device_id,source,currency,gross_before_discount,discount,unallocated_discount,
        gross,base,tax,tip,tax_basis,issuer,lines,payments)
      values(${s.tenantId},${ticketId},${due.orderId},${due.series},${number},${code},${due.businessDate},${s.employeeId},
        (select d.id from devices d where d.id=${s.deviceId}),${due.source},'MXN',${summary.grossBeforeDiscount},
        ${summary.discount},${summary.unallocatedDiscount},${summary.gross},${summary.base},${summary.tax},${due.tip},
        ${summary.basis},${due.issuer ? tx.json(due.issuer) : null},${tx.json(due.ticketLines)},${tx.json(due.payments)})
      on conflict (self_invoice_code) do nothing
      returning issued_at,self_invoice_code`) as unknown as (typeof inserted)[];
  }
  if (!inserted) throw new Error("self_invoice_code_exhausted");
  return {
    id: ticketId,
    order_id: due.orderId,
    series: due.series,
    number,
    self_invoice_code: inserted.self_invoice_code,
    issued_at: inserted.issued_at,
    business_date: due.businessDate,
    source: due.source,
    currency: "MXN",
    gross_before_discount: summary.grossBeforeDiscount,
    discount: summary.discount,
    unallocated_discount: summary.unallocatedDiscount,
    gross: summary.gross,
    base: summary.base,
    tax: summary.tax,
    tip: due.tip,
    tax_basis: summary.basis,
    issuer: due.issuer,
    lines: due.ticketLines,
    payments: due.payments,
  };
}

/**
 * The inserted tickets' category rows and their audit rows (fiscal.ticket.issued and, for an
 * unallocated discount, fiscal.ticket.unallocated_discount): one statement each however many
 * tickets, all inserts (LO-R8).
 */
async function finishTickets(
  tx: Tx,
  s: Session,
  issued: { due: DueTicket; record: TicketRecord }[],
): Promise<FiscalTicketView[]> {
  if (!issued.length) return [];
  const rows = issued.map(({ due, record }) => {
    const taxes: TicketTaxRecord[] = due.summary.groups.map((g) => ({
      category: g.category,
      rate_bps: g.rateBps,
      gross_before_discount: g.grossBeforeDiscount,
      discount: g.discount,
      gross: g.gross,
      base_before_discount: g.baseBeforeDiscount,
      discount_base: g.discountBase,
      base: g.base,
      tax: g.tax,
    }));
    return { due, record, taxes, view: ticketView(record, taxes) };
  });
  await tx`insert into fiscal_ticket_taxes ${helper(tx)(
    rows.flatMap(({ record, taxes }) =>
      taxes.map((t) => ({
        tenant_id: s.tenantId,
        ticket_id: record.id,
        ...t,
      })),
    ),
    "tenant_id",
    "ticket_id",
    "category",
    "rate_bps",
    "gross_before_discount",
    "discount",
    "gross",
    "base_before_discount",
    "discount_base",
    "base",
    "tax",
  )}`;
  const audits = rows.flatMap(({ due, record, view }) => [
    {
      id: randomUUID(),
      operation: "fiscal.ticket.issued",
      entity: due.orderId,
      detail: {
        ticketId: record.id,
        folio: view.folio,
        gross: view.gross,
        tax: view.tax,
        source: due.source,
      },
    },
    ...(due.summary.unallocatedDiscount > 0
      ? [
          {
            id: randomUUID(),
            operation: "fiscal.ticket.unallocated_discount",
            entity: due.orderId,
            detail: {
              ticketId: record.id,
              folio: view.folio,
              unallocatedDiscount: due.summary.unallocatedDiscount,
            },
          },
        ]
      : []),
  ]);
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
    select ${s.tenantId},a.id,${s.employeeId},a.operation,a.entity,a.detail
    from jsonb_to_recordset(${tx.json(audits)}) as a(id uuid,operation text,entity text,detail jsonb)`;
  return rows.map((r) => r.view);
}

/**
 * Issues the order's ticket when its balance first reaches zero with a positive total, in the
 * caller's transaction (the caller holds FOR UPDATE on the order). Idempotent: an existing
 * ticket is returned without touching the counter. Null for a zero total, an unpaid balance, a
 * non-MXN restaurant or the kill switch (FISCAL_TICKETS_ENABLED=false; repair issues later).
 * The folio counter (LO-12) is the last lock: nothing after it locks below, and only the
 * ticket, its category rows and the audit rows are written under it.
 */
export async function issueDueTicket(
  tx: Tx,
  s: Session,
  orderId: string,
  source: "sale" | "recovery" | "repair" = "sale",
): Promise<FiscalTicketView | null> {
  if (!enabled()) return null;
  const prepared = await prepareTicket(tx, orderId, source);
  if (!prepared) return null;
  if ("ticket" in prepared) return prepared.ticket;
  const record = await insertDueTicket(tx, s, prepared.due);
  const [view] = await finishTickets(tx, s, [{ due: prepared.due, record }]);
  return view;
}

/**
 * MONEY-1 (LD-25): no refund, by amount or by item, on an order that has no fiscal ticket and
 * still has a balance due (refund_balance_due). Before payment staff void lines instead, so no
 * IVA adjustment is ever recorded against a provisional gross that can still change. The
 * caller holds FOR UPDATE on the order.
 */
export async function assertRefundAllowed(
  tx: Tx,
  orderId: string,
): Promise<void> {
  const [o] = await tx`select o.total,
      coalesce((select sum(t.amount) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0)::int as paid,
      exists(select 1 from fiscal_tickets f where f.tenant_id=o.tenant_id and f.order_id=o.id) as ticketed
    from orders o where o.id=${orderId}`;
  if (!o) throw new DomainError("not_found", 404);
  if (!o.ticketed && o.total > o.paid)
    throw new DomainError("refund_balance_due", 409);
}

// ---------------------------------------------------------------------------------------------
// Refund tax
// ---------------------------------------------------------------------------------------------

/**
 * Writes the refund's fiscal_adjustments (one row per category) after its money row is
 * inserted, by complement extraction against the ticket's categories (or the provisional
 * summary when the order has no ticket but is fully paid: a refund on an unticketed order with
 * a balance due is refused, refund_balance_due, MONEY-1). Idempotent per refund. Item refunds
 * pass their scope with each entry's exact `gross` (discounts 028), categorized as the ticket
 * froze each line (MONEY-4). Dated by its refund batch's business_date (discounts 028,
 * computed once per command from the transaction's start), or, for a batchless refund, by the
 * refund row's own creation time (MONEY-3). No audit of its own: the refund command audits
 * refund.recorded.
 */
export async function recordRefundTax(
  tx: Tx,
  s: Session,
  refundId: string,
  scope?: RefundTaxScope[],
): Promise<RefundTaxView> {
  // discounts (028): a batched refund carries the business date its command computed once.
  const [refund] =
    await tx`select r.amount,r.created_at,t.order_id,b.business_date::text as batch_date
      from refunds r join tenders t on t.tenant_id=r.tenant_id and t.id=r.tender_id
      left join refund_batches b on b.tenant_id=r.tenant_id and b.id=r.batch_id
      where r.id=${refundId}`;
  if (!refund) throw new DomainError("not_found", 404);
  const batchDate = (refund.batch_date as string | null) ?? null;
  // The batch's date, else the refund row's business date (its created_at, the transaction's
  // start), never the app clock when this runs: reports date refunds the same way (MONEY-3).
  const date =
    batchDate ??
    businessDate(
      (refund.created_at as Date).toISOString(),
      s.restaurant.timezone,
      s.restaurant.cutoff,
    );
  if (s.restaurant.currency !== "MXN")
    return {
      refundId,
      createdAt: (refund.created_at as Date).toISOString(),
      businessDate: date,
      groups: [],
    };
  const orderId = refund.order_id as string;
  const adjustments =
    (await tx`select refund_id,category,rate_bps,gross,base,tax,
      business_date::text as business_date,created_at
    from fiscal_adjustments where order_id=${orderId} order by created_at,category`) as unknown as AdjustmentRecord[];
  const mine = adjustments.filter((a) => a.refund_id === refundId);
  if (mine.length) return refundViews(mine)[0];
  const [ticket] = await tx`select t.id,o.total,t.lines,
      coalesce((select sum(n.amount) from tenders n where n.tenant_id=o.tenant_id and n.order_id=o.id),0)::int as paid,
      (select jsonb_agg(jsonb_build_object('category',c.category,'rateBps',c.rate_bps,'gross',c.gross))
        from fiscal_ticket_taxes c where c.tenant_id=t.tenant_id and c.ticket_id=t.id) as groups
      from orders o left join fiscal_tickets t on t.tenant_id=o.tenant_id and t.order_id=o.id
      where o.id=${orderId}`;
  // MONEY-1 backstop for every refund path (the legacy refund checks first): never split a
  // refund against the provisional gross of a check that can still shrink.
  if (ticket && !ticket.id && ticket.total > ticket.paid)
    throw new DomainError("refund_balance_due", 409);
  const ctx = await fiscalContext(tx);
  const needsLines = !!scope || !ticket?.id;
  // discounts (028): the lines' active discounts, read only when the lines are.
  const lineDiscounts = needsLines ? await discountsByLine(tx, orderId) : {};
  const lines = needsLines ? await orderLines(tx, orderId) : [];
  const saleGroups: {
    category: TaxCategory;
    rateBps: number | null;
    gross: number;
  }[] = ticket?.id
    ? ((ticket.groups as typeof saleGroups | null) ?? [])
    : orderTaxSummary({
        lines,
        lineDiscounts,
        total: ticket?.total ?? 0,
        ctx,
      }).groups;
  const split = refundTaxSplit({
    refundGross: refund.amount,
    saleGroups,
    previous: adjustments.map((a) => ({
      category: a.category,
      gross: a.gross,
      tax: a.tax,
    })),
    scope: scope
      ? refundScopeCategories({
          lines,
          scope,
          lineDiscounts,
          ctx,
          // MONEY-4: the category each line was frozen under on the ticket.
          categories: ticket?.id
            ? Object.fromEntries(
                ((ticket.lines as TicketLineSnapshot[] | null) ?? [])
                  .filter((l) => l.lineId)
                  .map((l) => [l.lineId!, l.category]),
              )
            : undefined,
        })
      : undefined,
  });
  if (!split.length)
    return {
      refundId,
      createdAt: (refund.created_at as Date).toISOString(),
      businessDate: date,
      groups: [],
    };
  const rows = split.map((g) => ({
    tenant_id: s.tenantId,
    id: randomUUID(),
    kind: "refund",
    refund_id: refundId,
    order_id: orderId,
    category: g.category,
    rate_bps: g.rateBps,
    gross: g.gross,
    base: g.base,
    tax: g.tax,
    business_date: date,
    created_by: s.employeeId,
  }));
  const inserted = (await tx`insert into fiscal_adjustments ${helper(tx)(
    rows,
    "tenant_id",
    "id",
    "kind",
    "refund_id",
    "order_id",
    "category",
    "rate_bps",
    "gross",
    "base",
    "tax",
    "business_date",
    "created_by",
  )} returning refund_id,category,rate_bps,gross,base,tax,business_date::text as business_date,created_at`) as unknown as AdjustmentRecord[];
  // cfdi (030): enqueueCfdiRefund(tx, s, refundId) here, only when rows were inserted.
  return refundViews(inserted)[0];
}

// ---------------------------------------------------------------------------------------------
// Missing tickets and repair
// ---------------------------------------------------------------------------------------------

/** Days back (business dates) the repair looks for paid sales without a ticket. */
export const REPAIR_WINDOW_DAYS = 40;
/**
 * Orders issued per repair call. Small, because every ticket of the batch is inserted while the
 * tenant's folio counter is held (FISCAL-CONCURRENCY-1); the panel says to repeat.
 */
export const REPAIR_BATCH = 20;

/**
 * Paid sales (Σ tenders ≥ total > 0) of an MXN restaurant created after fiscal_epoch() without a
 * ticket, by order business date: in `range`, or by default in the last 40 business days up to
 * today. A non-MXN restaurant never issues tickets, so it has none missing (FISCAL-SAT-5).
 */
export async function missingTicketCount(
  tx: Tx,
  range?: { from: string; to: string },
): Promise<number> {
  const window = range
    ? tx`o.business_date between ${range.from}::date and ${range.to}::date`
    : tx`o.business_date >= (select ((now() at time zone r.timezone) - make_interval(mins => r.cutoff))::date - ${REPAIR_WINDOW_DAYS}::int
          from restaurants r where r.id=nullif(current_setting('app.tenant_id',true),'')::uuid)`;
  const [row] = await tx`select count(*)::int as n from orders o
    where ${window}
      and o.created_at >= fiscal_epoch()
      and o.total > 0
      and o.total <= coalesce((select sum(t.amount) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0)
      and not exists (select 1 from fiscal_tickets f where f.tenant_id=o.tenant_id and f.order_id=o.id)
      and exists (select 1 from restaurants r where r.id=o.tenant_id and r.currency='MXN')`;
  return row.n as number;
}

const repairInput = z.object({ operationId: id }).strict();

/**
 * Emitir tickets faltantes: issues up to REPAIR_BATCH missing tickets of the last 40 business
 * days (source 'repair'). Managers, with a fresh PIN (LD-15 fiscal Q5): it writes immutable
 * records and assigns folios. Refused while the kill switch is on (fiscal_tickets_disabled).
 *
 * Lock order: the candidates (LO-5, one statement sorted by id), then the missing-ticket
 * predicate again for the locked rows (an order ticketed meanwhile by a payment or a release
 * is left out, FISCAL-SAT-6), every ticket computed and the remaining count read, and only then
 * the folio counter (LO-12): two statements per ticket and one insert each for the category
 * and audit rows while it is held (FISCAL-CONCURRENCY-1).
 */
export async function repairMissingTickets(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<{ issued: number; remaining: number; folios: string[] }> {
  permit(s, managers);
  requireRecentAuth(s);
  const p = repairInput.parse(raw);
  return once(tx, s, p.operationId, "fiscal.repair", p, async () => {
    if (!enabled()) throw new DomainError("fiscal_tickets_disabled", 409);
    const today = businessDate(
      new Date().toISOString(),
      s.restaurant.timezone,
      s.restaurant.cutoff,
    );
    const from = new Date(
      Date.parse(today + "T00:00:00Z") - REPAIR_WINDOW_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const missing = (ids?: string[]) =>
      tx`select o.id,o.created_at from orders o
        where ${ids ? tx`o.id=any(${tx.array(ids)}::uuid[])` : tx`o.business_date between ${from}::date and ${today}::date`}
          and o.created_at >= fiscal_epoch()
          and o.total > 0
          and o.total <= coalesce((select sum(t.amount) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0)
          and not exists (select 1 from fiscal_tickets f where f.tenant_id=o.tenant_id and f.order_id=o.id)
          and exists (select 1 from restaurants r where r.id=o.tenant_id and r.currency='MXN')
        order by o.business_date,o.created_at,o.id limit ${REPAIR_BATCH}`;
    const ids = (await missing()).map((c) => c.id as string);
    if (ids.length)
      await tx`select id from orders where id=any(${tx.array(ids)}::uuid[]) order by id for update`;
    // A new statement sees what committed while this one waited for the order locks.
    const locked = ids.length ? await missing(ids) : [];
    const due: DueTicket[] = [];
    for (const o of [...locked].sort(
      (a, b) =>
        (a.created_at as Date).getTime() - (b.created_at as Date).getTime() ||
        String(a.id).localeCompare(String(b.id)),
    )) {
      const prepared = await prepareTicket(tx, o.id as string, "repair");
      if (prepared && "due" in prepared) due.push(prepared.due);
    }
    const before = await missingTicketCount(tx);
    const issued: { due: DueTicket; record: TicketRecord }[] = [];
    for (const d of due)
      issued.push({ due: d, record: await insertDueTicket(tx, s, d) });
    const folios = (await finishTickets(tx, s, issued)).map((v) => v.folio);
    await audit(tx, s, "fiscal.tickets.repaired", s.tenantId, {
      count: folios.length,
      folios,
    });
    return {
      issued: folios.length,
      remaining: Math.max(0, before - folios.length),
      folios,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Register and summary (heavy reads: 30 s transaction-local statement timeout, contract C-13)
// ---------------------------------------------------------------------------------------------

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_RANGE_DAYS = 31;

/** A business-date range of at most 31 days (inclusive), else fiscal_range_invalid. */
export function fiscalRange(from: unknown, to: unknown) {
  const f = date.safeParse(from),
    t = date.safeParse(to);
  const start = f.success ? Date.parse(f.data + "T00:00:00Z") : NaN;
  const end = t.success ? Date.parse(t.data + "T00:00:00Z") : NaN;
  if (
    !f.success ||
    !t.success ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString().slice(0, 10) !== f.data ||
    new Date(end).toISOString().slice(0, 10) !== t.data ||
    end < start ||
    (end - start) / 86_400_000 + 1 > MAX_RANGE_DAYS
  )
    throw new DomainError("fiscal_range_invalid", 400);
  return { from: f.data, to: t.data };
}

export const fiscalRangeQuery = z
  .object({ from: z.string().max(10), to: z.string().max(10) })
  .strict()
  .transform((q) => fiscalRange(q.from, q.to));

export const ticketListQuery = z
  .object({
    from: z.string().max(10).optional(),
    to: z.string().max(10).optional(),
    folio: z.string().trim().max(40).optional(),
    after: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

/** Ticket register page: by business-date range (≤ 31 days) or one exact folio. */
export async function listTickets(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<{ rows: TicketRow[]; next: string | null }> {
  permit(s, managers);
  const q = ticketListQuery.parse(raw ?? {});
  const folio = q.folio ? parseFolio(q.folio) : null;
  if (q.folio && !folio) return { rows: [], next: null };
  const range = folio ? null : fiscalRange(q.from, q.to);
  let after: { at: string; id: string } | null = null;
  if (q.after) {
    const [at, afterId] = q.after.split("|");
    if (!at || !id.safeParse(afterId).success || Number.isNaN(Date.parse(at)))
      throw new DomainError("invalid_input");
    after = { at, id: afterId };
  }
  await tx`select set_config('statement_timeout','30s',true)`;
  // A range lists the refunds recorded up to its last day, so a period's export does not change
  // when a later refund arrives (LIVA art. 7 deducts a return in its own month; FISCAL-SAT-4).
  // One folio shows every refund of its ticket.
  const refundsUpTo = range
    ? tx`and a.business_date <= ${range.to}::date`
    : tx``;
  const rows =
    await tx`select t.id,t.order_id,o.number as order_number,t.series,t.number,
      t.issued_at,t.issued_at::text as cursor_at,t.business_date::text as business_date,
      t.gross,t.base,t.tax,t.discount,t.tip,t.self_invoice_code,t.source,t.payments,
      (select jsonb_agg(jsonb_build_object('category',c.category,'rateBps',c.rate_bps,'gross',c.gross,'base',c.base,'tax',c.tax))
         from fiscal_ticket_taxes c where c.tenant_id=t.tenant_id and c.ticket_id=t.id) as groups,
      coalesce((select sum(a.gross) from fiscal_adjustments a where a.tenant_id=t.tenant_id and a.order_id=t.order_id
        ${refundsUpTo}),0)::int as refund_gross,
      coalesce((select sum(a.tax) from fiscal_adjustments a where a.tenant_id=t.tenant_id and a.order_id=t.order_id
        ${refundsUpTo}),0)::int as refund_tax
    from fiscal_tickets t join orders o on o.tenant_id=t.tenant_id and o.id=t.order_id
    where ${
      folio
        ? tx`t.series=${folio.series} and t.number=${folio.number}`
        : tx`t.business_date between ${range!.from}::date and ${range!.to}::date`
    }
      ${after ? tx`and (t.issued_at,t.id) > (${after.at}::text::timestamptz,${after.id}::uuid)` : tx``}
    order by t.issued_at,t.id limit ${q.limit + 1}`.catch(
      (e: { code?: string }) => {
        if (e?.code === "22007" || e?.code === "22008")
          throw new DomainError("invalid_input");
        throw e;
      },
    );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    rows: page.map((r) => {
      const groups = ((r.groups as TicketRow["groups"] | null) ?? []).sort(
        (a, b) =>
          TAX_CATEGORIES.indexOf(a.category) -
          TAX_CATEGORIES.indexOf(b.category),
      );
      return {
        id: r.id,
        orderId: r.order_id,
        orderNumber: r.order_number,
        folio: formatFolio(r.series, Number(r.number)),
        issuedAt: (r.issued_at as Date).toISOString(),
        businessDate: r.business_date,
        gross: r.gross,
        base: r.base,
        tax: r.tax,
        discount: r.discount,
        tip: r.tip,
        groups,
        refundGross: r.refund_gross,
        refundTax: r.refund_tax,
        payments: (r.payments as FiscalTicketView["payments"]).map((p) => ({
          method: p.method,
          amount: p.amount,
        })),
        selfInvoiceCode: r.self_invoice_code,
        source: r.source,
      };
    }),
    next: rows.length > q.limit && last ? `${last.cursor_at}|${last.id}` : null,
  };
}

const totalsOf = (
  category: TaxCategory,
  v: Partial<Omit<CategoryTotals, "category" | "rateBps">> = {},
): CategoryTotals => ({
  category,
  rateBps: TAX_RULES[category].rateBps,
  grossBeforeDiscount: v.grossBeforeDiscount ?? 0,
  discount: v.discount ?? 0,
  gross: v.gross ?? 0,
  base: v.base ?? 0,
  tax: v.tax ?? 0,
});

/**
 * IVA by business date for reports 029 and the register: tickets by their business date,
 * refund adjustments by theirs. IVA is never recomputed from orders. Any range of ≤ 31 days.
 */
export async function fiscalSummary(
  tx: Tx,
  s: Session,
  range: { from: string; to: string },
): Promise<FiscalSummary> {
  permit(s, managers);
  const { from, to } = fiscalRange(range.from, range.to);
  await tx`select set_config('statement_timeout','30s',true)`;
  const sales =
    await tx`select c.category,sum(c.gross_before_discount)::int8 as gbd,
      sum(c.discount)::int8 as discount,sum(c.gross)::int8 as gross,sum(c.base)::int8 as base,
      sum(c.tax)::int8 as tax
    from fiscal_tickets t join fiscal_ticket_taxes c on c.tenant_id=t.tenant_id and c.ticket_id=t.id
    where t.business_date between ${from}::date and ${to}::date group by c.category`;
  const refunds =
    await tx`select category,sum(gross)::int8 as gross,sum(base)::int8 as base,
      sum(tax)::int8 as tax
    from fiscal_adjustments where business_date between ${from}::date and ${to}::date group by category`;
  // Contiguous folio runs per series: tickets belong to their sale's business date but take
  // folios when issued, so a late offline sync, a repair or a cross-day settlement puts a later
  // folio into an earlier day. A min..max range would read as gaps in a gapless series
  // (FISCAL-SAT-3, FISCAL-OFFLINE-5).
  const series =
    await tx`select series,min(number)::int8 as first,max(number)::int8 as last,
      count(*)::int8 as count,sum(tip)::int8 as tips
    from (select series,number,tip,
            number - row_number() over (partition by series order by number) as run
          from fiscal_tickets where business_date between ${from}::date and ${to}::date) r
    group by series,run order by series,first`;
  const missingTickets = await missingTicketCount(tx, { from, to });
  const n = (v: unknown) => Number(v ?? 0);
  const salesBy = new Map(
    sales.map((r) => [
      r.category as TaxCategory,
      totalsOf(r.category, {
        grossBeforeDiscount: n(r.gbd),
        discount: n(r.discount),
        gross: n(r.gross),
        base: n(r.base),
        tax: n(r.tax),
      }),
    ]),
  );
  const refundsBy = new Map(
    refunds.map((r) => [
      r.category as TaxCategory,
      totalsOf(r.category, {
        grossBeforeDiscount: n(r.gross),
        gross: n(r.gross),
        base: n(r.base),
        tax: n(r.tax),
      }),
    ]),
  );
  const present = TAX_CATEGORIES.filter(
    (c) => salesBy.has(c) || refundsBy.has(c),
  );
  const salesRows = TAX_CATEGORIES.filter((c) => salesBy.has(c)).map((c) =>
    salesBy.get(c)!,
  );
  const refundRows = TAX_CATEGORIES.filter((c) => refundsBy.has(c)).map((c) =>
    refundsBy.get(c)!,
  );
  const net = present.map((c) => {
    const a = salesBy.get(c) ?? totalsOf(c);
    const b = refundsBy.get(c) ?? totalsOf(c);
    return totalsOf(c, {
      grossBeforeDiscount: a.grossBeforeDiscount - b.grossBeforeDiscount,
      discount: a.discount - b.discount,
      gross: a.gross - b.gross,
      base: a.base - b.base,
      tax: a.tax - b.tax,
    });
  });
  const sumOf = (rows: CategoryTotals[], k: "gross" | "base" | "tax") =>
    rows.reduce((a, r) => a + r[k], 0);
  return {
    from,
    to,
    tickets: {
      count: series.reduce((a, r) => a + n(r.count), 0),
      series: series.map((r) => ({
        series: r.series,
        first: n(r.first),
        last: n(r.last),
        count: n(r.count),
      })),
    },
    sales: salesRows,
    refunds: refundRows,
    net,
    totals: {
      gross: sumOf(salesRows, "gross"),
      base: sumOf(salesRows, "base"),
      tax: sumOf(salesRows, "tax"),
      tips: series.reduce((a, r) => a + n(r.tips), 0),
      refundGross: sumOf(refundRows, "gross"),
      refundTax: sumOf(refundRows, "tax"),
      netGross: sumOf(net, "gross"),
      netBase: sumOf(net, "base"),
      netTax: sumOf(net, "tax"),
    },
    missingTickets,
  };
}
