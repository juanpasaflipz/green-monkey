/**
 * Finanzas › Club de lealtad (038, specs/loyalty-w4.md §2.16, §4.11): one business-date range,
 * read from one REPEATABLE READ, READ ONLY snapshot (reports' snapshotTenant, the route's job).
 * Reward value reads discounts by reason directly (read-only, C5). The integrity check
 * loyalty_ledger_vs_members counts members whose cached balances differ from their ledger.
 */
import type { Tx } from "../db.js";
import { managers, permit } from "../auth.js";
import { type Session } from "../../shared/domain.js";
import { parseRange, LIMITS } from "../../shared/reports.js";
import {
  maskPhone,
  STAMP_TENDER_METHODS,
  type LoyaltyReport,
} from "../../shared/loyalty.js";

const bps = (num: number, den: number) =>
  den > 0 ? Math.round((num * 10000) / den) : null;

export async function loyaltyReport(
  tx: Tx,
  s: Session,
  raw: { from?: unknown; to?: unknown },
): Promise<LoyaltyReport> {
  permit(s, managers);
  const { from, to } = parseRange(raw, LIMITS.aggregateDays);
  const methods = tx.array([...STAMP_TENDER_METHODS]);
  const [members] = await tx`select
      count(*) filter (where redacted_at is null)::int as total,
      count(*) filter (where joined_via <> 'import'
        and business_date_at(tenant_id, joined_at) between ${from}::date and ${to}::date)::int as new
    from loyalty_members`;
  const [ledger] = await tx`select
      count(distinct member_id) filter (where kind='earn')::int as active,
      count(distinct member_id) filter (where kind='import')::int as imported,
      coalesce(sum(stamps_delta) filter (where kind='earn'),0)::int as earned,
      coalesce(-sum(stamps_delta) filter (where kind='earn_reversal'),0)::int as reversed,
      coalesce(sum(stamps_delta) filter (where kind='adjustment'),0)::int as adjusted,
      coalesce(sum(stamps_delta) filter (where kind='referral_bonus'),0)::int as referral_stamps,
      (count(*) filter (where kind='reward_earned') - count(*) filter (where kind='reward_unearned'))::int as rewards_earned,
      (count(*) filter (where kind='reward_redeemed') - count(*) filter (where kind='reward_restored'))::int as rewards_redeemed
    from loyalty_ledger where business_date between ${from}::date and ${to}::date`;
  const [value] = await tx`select coalesce(sum(
      coalesce((select sum(b.amount) from discount_allocations b
        where b.tenant_id=d.tenant_id and b.discount_id=d.id
          and not exists (select 1 from line_voids v where v.tenant_id=b.tenant_id
                          and v.line_id=b.line_id and b.unit_index=any(v.units))),0)),0)::int as amount
    from discounts d join orders o on o.tenant_id=d.tenant_id and o.id=d.order_id
    where d.reason_code='loyalty_reward' and d.reversed_at is null
      and o.business_date between ${from}::date and ${to}::date`;
  // Settled orders of the range with their stamp base (non-platform tenders net of refunds,
  // capped at the total) and their paid base (every tender), and their member if any.
  const sales = await tx`with settled as (
      select o.id,o.total,l.member_id,
        coalesce((select sum(t.amount - coalesce((select sum(r.amount) from refunds r
            where r.tenant_id=t.tenant_id and r.tender_id=t.id),0))
          from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id
            and t.method = any(${methods}::text[])),0) as stamp_paid,
        coalesce((select sum(t.amount - coalesce((select sum(r.amount) from refunds r
            where r.tenant_id=t.tenant_id and r.tender_id=t.id),0))
          from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0) as paid
      from orders o
      left join loyalty_order_links l on l.tenant_id=o.tenant_id and l.order_id=o.id
      where o.business_date between ${from}::date and ${to}::date
        and o.state not like 'recovery%' and o.state <> 'cancelled'
        and (o.check_state='paid' or (o.check_state='closed' and o.close_reason in ('settled','released'))))
    select member_id, count(*)::int as visits,
      sum(greatest(0, least(total, stamp_paid)))::bigint as member_base,
      sum(greatest(0, least(total, paid)))::bigint as sales
    from settled group by member_id`;
  let memberSales = 0,
    totalSales = 0;
  for (const r of sales) {
    totalSales += Number(r.sales);
    if (r.member_id) memberSales += Number(r.member_base);
  }
  const top = sales
    .filter((r) => r.member_id)
    .sort(
      (a, b) =>
        b.visits - a.visits ||
        Number(b.member_base) - Number(a.member_base) ||
        (a.member_id < b.member_id ? -1 : 1),
    )
    .slice(0, 10);
  const names = top.length
    ? await tx`select id,name,phone_e164 from loyalty_members
        where id = any(${tx.array(top.map((r) => r.member_id))}::uuid[])`
    : [];
  const [check] = await tx`select count(*)::int as n from loyalty_members m
    left join (select member_id,sum(stamps_delta)::int as s,sum(rewards_delta)::int as r
               from loyalty_ledger group by member_id) l on l.member_id=m.id
    where m.stamps <> coalesce(l.s,0) or m.rewards <> coalesce(l.r,0)`;
  return {
    from,
    to,
    members: {
      total: members.total,
      new: members.new,
      imported: ledger.imported,
      active: ledger.active,
    },
    stamps: {
      earned: ledger.earned,
      reversed: ledger.reversed,
      adjusted: ledger.adjusted,
    },
    referralStamps: ledger.referral_stamps,
    rewards: {
      earned: ledger.rewards_earned,
      redeemed: ledger.rewards_redeemed,
      rateBps: bps(ledger.rewards_redeemed, ledger.rewards_earned),
      value: value.amount,
    },
    sales: {
      members: memberSales,
      total: totalSales,
      shareBps: bps(memberSales, totalSales),
    },
    top: top.map((r) => {
      const m = names.find((n) => n.id === r.member_id);
      return {
        memberId: r.member_id,
        name: m?.name ?? "",
        maskedPhone: maskPhone(m?.phone_e164 ?? null),
        visits: r.visits,
        spend: Number(r.member_base),
      };
    }),
    mismatches: check.n,
  };
}
