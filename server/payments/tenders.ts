// The one tender writer (payments 037, spec §4.0): recordPayment, offline
// newTender/reconcile/financial recovery, resolvePaymentAttempt and (P2) the
// attempt settle all insert through insertTender. It snapshots the terminal
// label, estimates the fee from the terminal's or platform's rate, and checks
// the platform shape before 037's table checks would.
import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { DomainError, type Session } from "../../shared/domain.js";
import {
  estimateFee,
  isTenderMethod,
  PLATFORMS,
  type CardType,
  type PlatformCode,
  type Provider,
  type TenderMethod,
} from "../../shared/payments.js";

export type TenderTerminal = {
  id: string;
  name: string;
  kind: string;
  fee_bp: number | null;
  active: boolean;
  archived_at: Date | null;
};
export type TenderPlatform = {
  platform: PlatformCode;
  enabled: boolean;
  commission_bp: number | null;
};

/**
 * A terminal named on a tender. Online payments need an active, non-archived
 * one; offline evidence (allowArchived) predates the archive, so an archived
 * terminal is accepted; an unknown id is null for the caller to handle.
 */
export async function tenderTerminal(
  tx: Tx,
  terminalId: string,
): Promise<TenderTerminal | null> {
  const [t] = await tx<TenderTerminal[]>`
    select id,name,kind,fee_bp,active,archived_at from payment_terminals where id=${terminalId}`;
  return t ?? null;
}
export async function liveTerminal(
  tx: Tx,
  terminalId: string,
): Promise<TenderTerminal> {
  const t = await tenderTerminal(tx, terminalId);
  if (!t) throw new DomainError("payments_terminal_not_found", 404);
  if (!t.active || t.archived_at)
    throw new DomainError("payments_terminal_inactive", 409);
  return t;
}
/** A platform's row; no row means enabled with no commission (037 §3). */
export async function tenderPlatform(
  tx: Tx,
  platform: PlatformCode,
): Promise<TenderPlatform> {
  const [p] = await tx<TenderPlatform[]>`
    select platform,enabled,commission_bp from payment_platforms where platform=${platform}`;
  return p ?? { platform, enabled: true, commission_bp: null };
}

export type TenderSpec = {
  orderId: string;
  /** cash_sessions.id the tender belongs to (tenders.session_id). */
  drawerId: string;
  method: TenderMethod;
  amount: number;
  tip: number;
  received: number;
  reference: string | null;
  groupId?: string | null;
  /** Offline recovery provenance (018): source 'offline_recovery' and its record. */
  source?: { kind: "offline_recovery"; id: string };
  /** created_at = clock_timestamp() (offline paths) instead of now(). */
  clock?: boolean;
  terminal?: TenderTerminal | null;
  platform?: { row: TenderPlatform; label: string | null } | null;
  /** P2: an integrated attempt's provider data; its fee wins over the estimate. */
  integrated?: {
    attemptId: string;
    provider: Provider;
    providerReference: string;
    cardType: CardType | null;
    cardBrand: string | null;
    cardLast4: string | null;
    fee: number | null;
    feeSource: "provider" | "estimated" | null;
  };
};

/** Inserts one tender; returns its id. */
export async function insertTender(
  tx: Tx,
  s: Session,
  spec: TenderSpec,
): Promise<string> {
  if (!isTenderMethod(spec.method)) throw new DomainError("invalid_input");
  const terminal = spec.terminal ?? null;
  const platform = spec.platform ?? null;
  if (terminal && spec.method !== "external")
    throw new DomainError("invalid_input");
  if ((spec.method === "platform") !== Boolean(platform))
    throw new DomainError("payments_platform_required");
  if (platform) {
    if (!PLATFORMS.includes(platform.row.platform))
      throw new DomainError("invalid_input");
    if ((platform.row.platform === "other") !== Boolean(platform.label))
      throw new DomainError("payments_platform_required");
    if (spec.tip !== 0) throw new DomainError("payments_platform_no_tip");
    if (spec.received !== spec.amount) throw new DomainError("invalid_input");
  }
  let fee: number | null = null;
  let feeSource: "provider" | "estimated" | null = null;
  if (spec.integrated?.fee !== undefined && spec.integrated?.fee !== null) {
    fee = spec.integrated.fee;
    feeSource = spec.integrated.feeSource ?? "estimated";
  } else if (terminal) {
    fee = estimateFee(spec.amount + spec.tip, terminal.fee_bp);
    feeSource = fee === null ? null : "estimated";
  } else if (platform) {
    fee = estimateFee(spec.amount, platform.row.commission_bp);
    feeSource = fee === null ? null : "estimated";
  }
  const tenderId = randomUUID();
  const integrated = spec.integrated ?? null;
  await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,
      external_reference,group_id,source,source_id,created_at,
      terminal_id,terminal_label,provider,provider_reference,attempt_id,card_type,card_brand,card_last4,
      platform,platform_label,fee,fee_source)
    values(${s.tenantId},${tenderId},${spec.orderId},${spec.drawerId},${spec.method},${spec.amount},
      ${spec.tip},${spec.received},${spec.reference},${spec.groupId ?? null},
      ${spec.source ? spec.source.kind : "normal"},${spec.source?.id ?? null},
      ${spec.clock ? tx`clock_timestamp()` : tx`now()`},
      ${terminal?.id ?? null},${terminal ? terminal.name.trim() : null},
      ${integrated?.provider ?? null},${integrated?.providerReference ?? null},${integrated?.attemptId ?? null},
      ${integrated?.cardType ?? null},${integrated?.cardBrand ?? null},${integrated?.cardLast4 ?? null},
      ${platform?.row.platform ?? null},${platform?.label ?? null},${fee},${feeSource})`;
  return tenderId;
}
