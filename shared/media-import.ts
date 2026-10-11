// In-app owner photo import (039; critic R42/Q7, «Importar fotos» in Menú e inventario). The
// operator downloads the old system's product photos and writes a JSON manifest (format below and
// in docs/KIOSK.md §7); the owner picks the manifest and the image files, reviews the product each
// item maps to, and commits. Each file goes through the normal upload pipeline (the browser's
// WebP re-encode, the server's container validation, LD-88). Pure.
import { z } from "zod";
import { id } from "./domain.js";

export const MEDIA_IMPORT_FORMAT = "gm-menu-media-v1";
export const MEDIA_IMPORT_LIMITS = {
  items: 500,
  /** After a media_rate_limited answer the import waits, then retries the same item. */
  rateLimitWaitMs: 60_000,
  rateLimitRetries: 11,
  /** After a media_busy or media_server_busy answer (another upload in flight, KV-SECURITY-1,
   * KF-SECURITY-1): a short wait, then the same item. */
  busyWaitMs: 3_000,
  busyRetries: 20,
} as const;

const sourceId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/);
/** A file name the operator saved, never a path or a URL. */
const fileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (f) =>
      !/[/\\]|^\.\.?$/.test(f) &&
      ![...f].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    { message: "invalid_file_name" },
  );

/**
 * The manifest: `{format, source, items: [{id, name, file}]}`. `id` is the old system's product
 * id (the report names it), `name` its product name (the proposal matches it against the menu),
 * `file` the image file's name as saved next to the manifest. Ids are unique.
 */
export const mediaManifest = z
  .object({
    format: z.literal(MEDIA_IMPORT_FORMAT),
    source: z.string().trim().min(1).max(40),
    items: z
      .array(
        z
          .object({
            id: sourceId,
            name: z.string().trim().min(1).max(120),
            file: fileName,
          })
          .strict(),
      )
      .min(1)
      .max(MEDIA_IMPORT_LIMITS.items)
      .refine(
        (items) => new Set(items.map((i) => i.id)).size === items.length,
        {
          message: "duplicate_id",
        },
      ),
  })
  .strict();
export type MediaManifest = z.output<typeof mediaManifest>;
export type ManifestItem = MediaManifest["items"][number];

/** "Café con Leche " → "cafe con leche": accents, case, punctuation and spacing ignored. */
export function matchKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type ImportProduct = {
  id: string;
  name: { es: string; en: string };
  archived?: boolean;
  version: number;
  image?: { id: string } | null;
};

/**
 * The proposal the owner reviews: an item maps to the one active product whose Spanish or English
 * name matches it; none or several stay unmapped (the owner picks), and a product two items would
 * take goes to the first only.
 */
export function proposeMapping(
  items: ManifestItem[],
  products: ImportProduct[],
): Record<string, string | null> {
  const byKey = new Map<string, Set<string>>();
  for (const p of products) {
    if (p.archived) continue;
    for (const n of [p.name.es, p.name.en]) {
      const k = matchKey(n);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k)!.add(p.id);
    }
  }
  const taken = new Set<string>();
  const out: Record<string, string | null> = {};
  for (const item of items) {
    const found = byKey.get(matchKey(item.name));
    const only = found?.size === 1 ? [...found][0] : null;
    out[item.id] = only && !taken.has(only) ? only : null;
    if (out[item.id]) taken.add(only!);
  }
  return out;
}

export type ImportStatus =
  "ready" | "unmatched" | "missing_file" | "has_photo" | "duplicate";
/** What committing would do with one item, given the owner's choices. */
export function importStatus(
  item: ManifestItem,
  productId: string | null,
  o: {
    files: ReadonlySet<string>;
    products: ImportProduct[];
    replace: boolean;
    /** Product ids an earlier item of the list already takes. */
    takenBefore: ReadonlySet<string>;
  },
): ImportStatus {
  if (!productId) return "unmatched";
  if (o.takenBefore.has(productId)) return "duplicate";
  if (!o.files.has(item.file)) return "missing_file";
  const p = o.products.find((x) => x.id === productId);
  if (p?.image && !o.replace) return "has_photo";
  return "ready";
}

/**
 * The upload's operation id: the same product, at the same version, with the same file bytes is
 * the same upload, so a retried request, a second tab or a resumed run replays it instead of
 * storing a second copy (RFC 9562 version 5 layout from a SHA-256).
 */
export function importOperationId(sha256Hex: string): string {
  const h = sha256Hex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("invalid_digest");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** What the operation id digests. */
export const importDigestInput = (
  productId: string,
  version: number,
  fileSha256Hex: string,
) => `${MEDIA_IMPORT_FORMAT}:${productId}:${version}:${fileSha256Hex}`;

export const IMPORT_OUTCOMES = [
  "imported",
  "unmatched",
  "missing_file",
  "has_photo",
  "duplicate",
  "failed",
] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];

/** The upload's tag (headers x-gm-import and x-gm-import-item): its audit row names the import. */
export const importRef = z.object({ batchId: id, sourceId }).strict();

/** POST /api/menu/media-import: the run's report, kept as one audit row (managers). */
export const mediaImportReportInput = z
  .object({
    operationId: id,
    source: z.string().trim().min(1).max(40),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    replace: z.boolean(),
    items: z
      .array(
        z
          .object({
            id: sourceId,
            name: z.string().trim().min(1).max(120),
            productId: id.nullable(),
            outcome: z.enum(IMPORT_OUTCOMES),
            assetId: id.nullable().default(null),
            code: z
              .string()
              .regex(/^[a-z0-9_]{1,64}$/)
              .nullable()
              .default(null),
          })
          .strict(),
      )
      .min(1)
      .max(MEDIA_IMPORT_LIMITS.items),
  })
  .strict();
export type MediaImportReport = z.input<typeof mediaImportReportInput>;
