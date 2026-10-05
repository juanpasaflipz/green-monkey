/**
 * In-wave fallback for access's (023) lease API (wave contracts §3.10, §6).
 * At offline's merge the integrator imports these from ../offline-leases.js and
 * deletes this file. Signatures are exactly the contract's.
 */
import type { Tx } from "../db.js";
import type { Session } from "../../shared/domain.js";

export type LeaseWindow = {
  sequence: number;
  issued_at: Date;
  valid_until: Date;
}; // sequence 0 = base lease
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
  restaurant_snapshot: Session["restaurant"];
};

/** Base lease row plus its windows. Before access merges there are no renewals. */
export async function leaseForEvidence(
  tx: Tx,
  sessionId: string,
): Promise<(OfflineLeaseRow & { windows: LeaseWindow[] }) | null> {
  const [lease] = await tx<
    OfflineLeaseRow[]
  >`select tenant_id,session_id,employee_id,
      device_id,contract_version,issued_at,valid_until,selling_authorized,plan,
      configuration_version,restaurant_snapshot
    from offline_leases where session_id=${sessionId}`;
  if (!lease) return null;
  return {
    ...lease,
    windows: [
      {
        sequence: 0,
        issued_at: lease.issued_at,
        valid_until: lease.valid_until,
      },
    ],
  };
}

/**
 * access (023): step-up for money-affecting and configuration manager commands
 * (contract D23, LD-7). Access's real function throws 403 step_up_required on
 * a terminal whose PIN was not entered recently. Before access merges there is
 * no step-up primitive, so this fallback accepts the call; at offline's merge
 * the integrator imports access's requireRecentAuth and deletes this file, so
 * every call site already in place becomes enforced.
 */
export function requireRecentAuth(_s: Session, _maxAgeSeconds?: number): void {}
