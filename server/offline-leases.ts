import type { Tx } from "./db.js";

export async function issueOfflineLease(tx: Tx, sessionId: string) {
  await tx`insert into offline_leases(
    tenant_id,session_id,employee_id,device_id,contract_version,issued_at,
    valid_until,selling_authorized,plan,configuration_version,restaurant_snapshot
  )
  select s.tenant_id,s.id,s.employee_id,s.device_id,1,now(),s.offline_until,
         s.selling_authorized,
         case when e.status in ('trialing','active') and e.access_until>now()
              then 'pro' else 'free' end,
         r.config_version,
         jsonb_build_object('name',r.name,'currency',r.currency,'timezone',r.timezone,'cutoff',r.cutoff)
  from sessions s
  join restaurants r on r.id=s.tenant_id
  left join restaurant_entitlements e on e.tenant_id=s.tenant_id
  where s.id=${sessionId}`;
}

/**
 * Appends an offline window renewal while the device is in contact (OFF-3):
 * a rolling 4 h window, capped by the session's absolute expiry, written at most
 * when the current window has less than 3 h 45 min left. Lease rows stay
 * immutable; renewals are separate append-only evidence. Returns the new
 * valid_until, or null when no renewal was needed or allowed.
 */
export async function renewOfflineLease(
  tx: Tx,
  sessionId: string,
  cap: Date,
): Promise<Date | null> {
  const [row] = await tx`with cur as (
      select l.tenant_id,
        greatest(l.valid_until,coalesce(max(r.valid_until),l.valid_until)) as until,
        coalesce(max(r.sequence),0) as seq
      from offline_leases l left join offline_lease_renewals r
        on r.tenant_id=l.tenant_id and r.session_id=l.session_id
      where l.session_id=${sessionId} and l.selling_authorized
      group by l.tenant_id,l.session_id,l.valid_until)
    insert into offline_lease_renewals(tenant_id,session_id,sequence,issued_at,valid_until)
    select tenant_id,${sessionId},seq+1,now(),least(now()+interval '4 hours',${cap}::timestamptz) from cur
     where until < least(now()+interval '4 hours',${cap}::timestamptz) - interval '15 minutes'
    on conflict do nothing returning valid_until`;
  return row?.valid_until ?? null;
}

/**
 * True when recordedAt falls inside the session's base lease or any renewal.
 * Every recordedAt-versus-lease check must use this, never valid_until alone.
 */
export async function leaseCovers(
  tx: Tx,
  sessionId: string,
  recordedAt: string | Date,
): Promise<boolean> {
  const at = new Date(recordedAt);
  const [row] = await tx`select
      exists(select 1 from offline_leases l where l.session_id=${sessionId}
        and ${at}::timestamptz between l.issued_at and l.valid_until)
      or exists(select 1 from offline_lease_renewals r where r.session_id=${sessionId}
        and ${at}::timestamptz between r.issued_at and r.valid_until) as covered`;
  return Boolean(row?.covered);
}

/** One validity window of an offline lease; sequence 0 is the base lease. */
export type LeaseWindow = { sequence: number; issued_at: Date; valid_until: Date };
export type OfflineLeaseRow = {
  tenant_id: string;
  session_id: string;
  employee_id: string;
  device_id: string;
  contract_version: number;
  issued_at: Date;
  valid_until: Date;
  selling_authorized: boolean;
  plan: "free" | "pro";
  configuration_version: number | null;
  restaurant_snapshot: import("../shared/domain.js").Session["restaurant"];
};

/**
 * The base lease of a session plus every window (base first, then renewals in
 * sequence order). Offline evidence is valid when some window covers it.
 */
export async function leaseForEvidence(
  tx: Tx,
  sessionId: string,
): Promise<(OfflineLeaseRow & { windows: LeaseWindow[] }) | null> {
  const [lease] = await tx<OfflineLeaseRow[]>`select tenant_id,session_id,employee_id,device_id,
      contract_version,issued_at,valid_until,selling_authorized,plan,configuration_version,restaurant_snapshot
    from offline_leases where session_id=${sessionId}`;
  if (!lease) return null;
  const renewals = await tx<LeaseWindow[]>`select sequence,issued_at,valid_until
    from offline_lease_renewals where session_id=${sessionId} order by sequence`;
  return {
    ...lease,
    windows: [
      { sequence: 0, issued_at: lease.issued_at, valid_until: lease.valid_until },
      ...renewals,
    ],
  };
}
