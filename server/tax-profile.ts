import { z } from "zod";
import type { Tx } from "./db.js";
import {
  accountEvent,
  organizationScope,
  type AccountCtx,
} from "./co-owners.js";
import { legalConfig, requireCurrentLegal, type LegalConfig } from "./legal.js";
import type { SaasTaxConfig } from "./saas-tax.js";
import { DomainError } from "../shared/domain.js";
import {
  USE_LABELS,
  postalCodeSchema,
  regimeAllowedFor,
  regimenFiscalSchema,
  usoCfdiAllowed,
  validateRfc,
} from "../shared/sat.js";

/**
 * Optional SaaS billing profile (GAP-6, SAAS_TAX_PROFILE_ENABLED): receptor
 * data for a future subscription CFDI. Validated with shared/sat.ts only.
 */
export type TaxProfile = {
  rfc: string;
  legalName: string;
  taxRegime: string;
  postalCode: string;
  cfdiUse: string;
  invoiceEmail: string | null;
  version: number;
  updatedAt: string;
};
/** Uses offered for the subscription CFDI (G02 is for returns, never a purchase). */
export const SAAS_CFDI_USES = (Object.keys(USE_LABELS) as string[]).filter(
  (u) => u !== "G02",
);

/** Pure validation shared with tests: invalid_input with the failing path. */
export const taxProfileInput = z
  .object({
    organizationId: z.uuid(),
    expectedVersion: z.number().int().min(0),
    rfc: z.string().trim().toUpperCase().max(13),
    legalName: z.string().trim().min(1).max(254),
    taxRegime: regimenFiscalSchema,
    postalCode: postalCodeSchema,
    cfdiUse: z.string().refine((u) => SAAS_CFDI_USES.includes(u)),
    invoiceEmail: z
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase())
      .nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const r = validateRfc(v.rfc);
    if (!r.ok || !r.kind) {
      ctx.addIssue({ code: "custom", path: ["rfc"], message: "rfc" });
      return;
    }
    if (!regimeAllowedFor(v.taxRegime, r.kind))
      ctx.addIssue({ code: "custom", path: ["taxRegime"], message: "regime" });
    else if (!usoCfdiAllowed(v.taxRegime, v.cfdiUse))
      ctx.addIssue({ code: "custom", path: ["cfdiUse"], message: "use" });
  });

const toProfile = (r: Record<string, any>): TaxProfile => ({
  rfc: r.rfc,
  legalName: r.legal_name,
  taxRegime: r.tax_regime,
  postalCode: r.postal_code,
  cfdiUse: r.cfdi_use,
  invoiceEmail: r.invoice_email,
  version: r.version,
  updatedAt: (r.updated_at as Date).toISOString(),
});

/** Owners (primary or co-owner) read; tax_profile_disabled unless the flag is on. */
export async function getTaxProfile(
  tx: Tx,
  a: AccountCtx,
  organizationId: string,
  c: SaasTaxConfig,
): Promise<TaxProfile | null> {
  if (!c.taxProfileEnabled) throw new DomainError("tax_profile_disabled", 404);
  await organizationScope(tx, a.id, organizationId, "owner");
  const [row] =
    await tx`select * from organization_tax_profiles where organization_id=${organizationId}`;
  return row ? toProfile(row) : null;
}

/** The primary saves (optimistic version; no PII in the account event). */
export async function saveTaxProfile(
  tx: Tx,
  a: AccountCtx,
  raw: unknown,
  c: SaasTaxConfig,
  legal: LegalConfig = legalConfig(process.env),
): Promise<TaxProfile> {
  if (!c.taxProfileEnabled) throw new DomainError("tax_profile_disabled", 404);
  const p = taxProfileInput.parse(raw);
  await requireCurrentLegal(tx, a.id, legal);
  await organizationScope(tx, a.id, p.organizationId, "primary");
  const [old] =
    await tx`select * from organization_tax_profiles where organization_id=${p.organizationId} for update`;
  if ((old?.version ?? 0) !== p.expectedVersion)
    throw new DomainError("profile_changed", 409);
  const values = {
    rfc: validateRfc(p.rfc).rfc,
    legal_name: p.legalName,
    tax_regime: p.taxRegime,
    postal_code: p.postalCode,
    cfdi_use: p.cfdiUse,
    invoice_email: p.invoiceEmail,
  };
  const [row] = old
    ? await tx`update organization_tax_profiles set rfc=${values.rfc},legal_name=${values.legal_name},
          tax_regime=${values.tax_regime},postal_code=${values.postal_code},cfdi_use=${values.cfdi_use},
          invoice_email=${values.invoice_email},version=version+1,updated_at=now(),updated_by_account=${a.id}
        where organization_id=${p.organizationId} returning *`
    : await tx`insert into organization_tax_profiles(organization_id,rfc,legal_name,tax_regime,postal_code,cfdi_use,invoice_email,updated_by_account)
        values(${p.organizationId},${values.rfc},${values.legal_name},${values.tax_regime},${values.postal_code},${values.cfdi_use},${values.invoice_email},${a.id})
        on conflict(organization_id) do nothing returning *`;
  if (!row) throw new DomainError("profile_changed", 409);
  const changed = (Object.keys(values) as Array<keyof typeof values>).filter(
    (k) => !old || old[k] !== values[k],
  );
  await accountEvent(tx, {
    organizationId: p.organizationId,
    actor: a.id,
    kind: "tax_profile_updated",
    detail: { fields: changed },
  });
  return toProfile(row);
}
