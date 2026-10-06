import type express from "express";
import { z } from "zod";
import type { Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import { audit, once } from "./orders.js";
import {
  freeSelection,
  freeSelectionMode,
  lockFreeLimits,
} from "./free-limits.js";
import { DomainError, id, type Session } from "../shared/domain.js";

export { freeSelectionMode };

/**
 * Per-restaurant account settings (account 031): the restaurant's own privacy
 * notice URL, shown to diners where QR/kiosk ordering asks for a name, and the
 * Free-selection mode (auto/manual, GAP-1). Row absent = defaults.
 */
export async function restaurantPrivacy(
  tx: Tx,
  s: Session,
): Promise<{ privacyNoticeUrl: string | null; version: number }> {
  permit(s, managers);
  const [row] =
    await tx`select privacy_notice_url,version from restaurant_account_settings where tenant_id=${s.tenantId}`;
  return {
    privacyNoticeUrl: row?.privacy_notice_url ?? null,
    version: row?.version ?? 0,
  };
}

const privacyUrl = z
  .url({ protocol: /^https$/ })
  .max(500)
  .refine((u) => u.startsWith("https://") && !/\s/.test(u));
const privacyInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0),
    privacyNoticeUrl: privacyUrl.nullable(),
  })
  .strict();

/**
 * Owner (or co-owner) saves the restaurant's privacy notice URL. The route calls
 * requireRecentAuth first, so a shared terminal needs a recent owner PIN.
 * expectedVersion 0 means "no row yet"; any mismatch is settings_changed.
 */
export async function saveRestaurantPrivacy(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<{ privacyNoticeUrl: string | null; version: number }> {
  permit(s, ["owner"]);
  const p = privacyInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "account.restaurant_privacy",
    p,
    async () => {
      const [row] =
        await tx`select version from restaurant_account_settings where tenant_id=${s.tenantId} for update`;
      if ((row?.version ?? 0) !== p.expectedVersion)
        throw new DomainError("settings_changed", 409);
      const [saved] = row
        ? await tx`update restaurant_account_settings set privacy_notice_url=${p.privacyNoticeUrl},
            version=version+1,updated_at=now(),updated_by=${s.employeeId}
          where tenant_id=${s.tenantId} returning privacy_notice_url,version`
        : await tx`insert into restaurant_account_settings(tenant_id,privacy_notice_url,updated_by)
          values(${s.tenantId},${p.privacyNoticeUrl},${s.employeeId})
          on conflict(tenant_id) do nothing returning privacy_notice_url,version`;
      // A concurrent first save won the insert: same answer as a version mismatch.
      if (!saved) throw new DomainError("settings_changed", 409);
      await audit(tx, s, "account.restaurant_privacy", s.tenantId, {
        privacyNoticeUrl: saved.privacy_notice_url,
        version: saved.version,
      });
      return {
        privacyNoticeUrl: saved.privacy_notice_url as string | null,
        version: saved.version as number,
      };
    },
  );
}

/**
 * The diner-facing privacy URL (tenant-scoped transaction; public ordering, cfdi portal).
 *
 * MERGE NOTE (cfdi 030, LD-16): server/cfdi/portal.ts is not on this branch.
 * At the account merge, the portal's restaurant-privacy anchor returns
 * `await restaurantPrivacyUrl(tx)` inside its tenant transaction, so the
 * self-invoicing page links the restaurant's notice like QR/kiosk do.
 */
export async function restaurantPrivacyUrl(tx: Tx): Promise<string | null> {
  const [row] =
    await tx`select privacy_notice_url from restaurant_account_settings where tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid`;
  return row?.privacy_notice_url ?? null;
}

const modeInput = z
  .object({ operationId: id, mode: z.literal("auto") })
  .strict();
/**
 * "Volver a automático": the Free slot follows drawer openers again (GAP-1).
 * Any explicit owner selection (POST /plan/selection) sets manual instead.
 */
export async function setFreeSelectionMode(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<unknown> {
  permit(s, ["owner"]);
  const p = modeInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "account.free_selection_mode",
    p,
    async () => {
      await lockFreeLimits(tx);
      await tx`insert into restaurant_account_settings(tenant_id,free_selection_mode,updated_by)
        values(${s.tenantId},'auto',${s.employeeId})
      on conflict(tenant_id) do update set free_selection_mode='auto',
        version=restaurant_account_settings.version+1,updated_at=now(),updated_by=excluded.updated_by`;
      await audit(tx, s, "account.free_selection_mode", s.tenantId, {
        mode: p.mode,
      });
      return freeSelection(tx, s);
    },
  );
}

/**
 * Public-ordering interim switch (account 031, §2.15): QR/kiosk ordering stays off
 * in production until the wave-3 public-ordering area ships. Pure; each caller
 * reads it once at module load, so an invalid value fails startup.
 */
export function publicOrderingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.PUBLIC_ORDERING_ENABLED?.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (!v) return env.APP_ENV !== "production";
  throw Error("public_ordering_flag_invalid");
}

/** First middleware of /api/public: answers 404 before any token or rate limit when disabled. */
export function publicOrderingGate(
  env: NodeJS.ProcessEnv = process.env,
): express.RequestHandler {
  return publicOrderingEnabled(env)
    ? (_req, _res, next) => next()
    : (_req, res) => {
        res.status(404).json({ error: "public_ordering_disabled" });
      };
}
