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
