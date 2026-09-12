import { z } from "zod";
import { minor, currencyExponent } from "./domain.js";
const legacyRow = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string().min(1),
    price: z.union([z.string(), z.number()]),
    category: z.string().min(1),
    is_available: z.boolean().optional(),
  })
  .strict();
const exportSchema = z
  .object({
    source: z.enum(["pos-lite", "luma"]),
    sourceTenantId: z.string().min(1),
    targetTenantId: z.string().uuid(),
    currency: z.string().length(3),
    rows: z.array(z.unknown()),
  })
  .strict();
export function previewImport(raw: unknown) {
  const input = exportSchema.parse(raw);
  const accepted: {
    legacyId: string;
    name: string;
    price: number;
    category: string;
    available: boolean;
  }[] = [];
  const rejected: { row: number; reason: string }[] = [];
  const seen = new Set<string>();
  input.rows.forEach((value, index) => {
    const parsed = legacyRow.safeParse(value);
    if (!parsed.success) {
      rejected.push({ row: index + 1, reason: "unknown_or_invalid_fields" });
      return;
    }
    const r = parsed.data;
    const key = String(r.id);
    if (seen.has(key)) {
      rejected.push({ row: index + 1, reason: "duplicate_source_id" });
      return;
    }
    seen.add(key);
    try {
      accepted.push({
        legacyId: key,
        name: r.name,
        price: minor(String(r.price), currencyExponent(input.currency)),
        category: r.category,
        available: r.is_available ?? true,
      });
    } catch {
      rejected.push({ row: index + 1, reason: "invalid_money" });
    }
  });
  return {
    ...input,
    rows: undefined,
    accepted,
    rejected,
    counts: {
      input: input.rows.length,
      accepted: accepted.length,
      rejected: rejected.length,
    },
    priceControlTotal: accepted.reduce((a, r) => a + r.price, 0),
    sideEffects: [],
  };
}
