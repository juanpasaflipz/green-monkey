/**
 * cfdi core: SAT catalog values and pure rules the builders need, kept LOCAL for now.
 *
 * TEMPORARY. One block here moves elsewhere in a later step; keep the names and signatures so the
 * swap is an import change only:
 *   1. SatUse / USE_LABELS / USE_REGIMES / usoCfdiAllowed now live in shared/sat.ts (Wave 2.0 (j),
 *      LD-14 OQ-4): re-exported below, so one uso catalog exists.
 *   2. CFDI_USES / CardForm / PAYMENT_FORMS / paymentFormFor / needsCardForm / Receptor: spec §4.2
 *      shared/cfdi.ts (implementation step 1). When that lands, re-export them from there.
 */
import type { SatUse } from "../../shared/sat.js";

// --- 1. c_UsoCFDI (shared/sat.ts, Wave 2.0 (j)) -------------------------------------------------
export {
  USE_LABELS,
  USE_REGIMES,
  usoCfdiAllowed,
  type SatUse,
} from "../../shared/sat.js";

// --- 2. Receptor and payment form (spec §4.2; moves to shared/cfdi.ts) ------------------------
export const CFDI_USES = [
  "G03",
  "G01",
  "S01",
] as const satisfies readonly SatUse[];
export type CfdiUse = (typeof CFDI_USES)[number];
export const PAYMENT_FORMS = {
  "01": "Efectivo",
  "04": "Tarjeta de crédito",
  "28": "Tarjeta de débito",
} as const;
export const CARD_PAYMENT_FORMS = ["04", "28"] as const;
export type CardForm = (typeof CARD_PAYMENT_FORMS)[number];

/** A nominative receptor as shared/cfdi.ts `receptorInput` produces it (already validated). */
export type Receptor = {
  rfc: string;
  legalName: string;
  regime: string;
  postalCode: string;
  use: CfdiUse;
  email: string | null;
};

/**
 * SAT FormaPago: the form with which the largest amount was paid (CFDI 4.0 Anexo 20 guide; SAT
 * global guide for the ticket of greatest amount). Cash tenders are "01"; an external terminal is
 * the card form given (credit 04 / debit 28). Ties take the form of the earliest tender (array
 * order = created_at). Tips are not part of `amount`. No payment at all reads as cash.
 */
export function paymentFormFor(
  payments: readonly { method: string; amount: number }[],
  card: CardForm,
): "01" | CardForm {
  const sums = new Map<"01" | CardForm, number>();
  for (const p of payments) {
    const form = p.method === "external" ? card : "01";
    sums.set(
      form,
      (sums.get(form) ?? 0) + (Number.isFinite(p.amount) ? p.amount : 0),
    );
  }
  let best: "01" | CardForm = "01";
  let bestAmount = -Infinity;
  // Map iteration is insertion order: the first tender's form wins a tie.
  for (const [form, amount] of sums)
    if (amount > bestAmount) {
      best = form;
      bestAmount = amount;
    }
  return best;
}

/** True when the forma de pago depends on a card answer (credit or debit). */
export function needsCardForm(
  payments: readonly { method: string; amount: number }[],
): boolean {
  return paymentFormFor(payments, "04") !== "01";
}
