// Menu photos (039; specs/kiosk-w4.md §2.9, §4.7; LD-88; critic R36): the upload pipeline, the
// photo commands, the same-origin media route and the purge jobs. Web process only.
//
// LD-88 (no native image library): the browser re-encodes the photo into three WebP variants on a
// canvas, or three JPEG variants where it cannot encode WebP (every WebKit browser; LD-91,
// KIOSK-UX-11); processUpload, the single seam a server re-encoder could replace later, validates
// each container and rebuilds it without metadata. The server validates the container, not the
// pixels; uploads are staff-only (owners and managers).
//
// Lock order (ARCHITECTURE row 63): tx A 1 → 2 → menu_media insert; object writes outside any
// transaction; tx B 1 → 2 → 3 menu_state → 3 catalog → 3 menu_media. Jobs: the media row alone.
import { createHash, randomUUID } from "node:crypto";
import type express from "express";
import type postgres from "postgres";
import { tenant, type Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import { audit, once } from "./orders.js";
import { requireSelling } from "./free-limits.js";
import { bumpMenuRevision } from "./menu.js";
import { enqueueJob, registerJobHandler } from "./jobs.js";
import { mediaStore, objectKey } from "./media-store.js";
import { menuPhotosEnabled } from "./kiosk-config.js";
import { log } from "./logging.js";
import {
  DomainError,
  id,
  type Product,
  type Session,
} from "../shared/domain.js";
import { cleanWebp, splitRiffs, WebpError } from "../shared/webp.js";
import { cleanJpeg, JpegError, splitJpegs } from "../shared/jpeg.js";
import {
  MEDIA_LIMITS,
  MEDIA_TYPES,
  MEDIA_VARIANTS,
  sniffType,
  type MediaType,
  type MediaVariant,
} from "../shared/media.js";
import { z } from "zod";
import { importRef, mediaImportReportInput } from "../shared/media-import.js";

export type ProcessedVariant = {
  name: MediaVariant;
  bytes: Buffer;
  w: number;
  h: number;
  sha256: string;
};
export type Processed = {
  width: number;
  height: number;
  /** The three variants' one type (the body's first bytes decide it). */
  type: MediaType;
  variants: ProcessedVariant[];
};

/**
 * The upload pipeline (LD-88, LD-91): thumb ‖ card ‖ hero, all WebP or all JPEG, each validated
 * and rebuilt without metadata (WebP: EXIF, XMP, ICC; JPEG: every APPn and COM). The variants
 * must be one picture at the three widths (never enlarged): hero at most 1200 px, card
 * min(480, hero), thumb min(160, hero), heights in the hero's proportion (±1 px).
 */
export function processUpload(body: Buffer): Processed {
  if (body.length > MEDIA_LIMITS.maxUploadBytes)
    throw new DomainError("media_too_large", 413);
  const all = new Uint8Array(body.buffer, body.byteOffset, body.length);
  // JPEG when the body starts with SOI; anything else goes the WebP way (which names a non-WebP
  // media_type_unsupported, as before).
  const type: MediaType =
    sniffType(all) === "image/jpeg" ? "image/jpeg" : "image/webp";
  let files: Uint8Array[];
  try {
    files = type === "image/jpeg" ? splitJpegs(all, 3) : splitRiffs(all, 3);
  } catch (e) {
    throw mediaError(e);
  }
  const out = files.map((f, i) => {
    const v = MEDIA_VARIANTS[i];
    if (f.length > v.maxBytes) throw new DomainError("media_too_large", 413);
    let c;
    try {
      const caps = { maxSide: Math.max(v.width, 4 * v.width) };
      c = type === "image/jpeg" ? cleanJpeg(f, caps) : cleanWebp(f, caps);
    } catch (e) {
      throw mediaError(e);
    }
    const bytes = Buffer.from(c.bytes);
    return {
      name: v.name,
      bytes,
      w: c.width,
      h: c.height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const hero = out[2];
  if (hero.w > MEDIA_VARIANTS[2].width)
    throw new DomainError("media_invalid", 400);
  for (const [i, v] of out.entries()) {
    const width = Math.min(MEDIA_VARIANTS[i].width, hero.w);
    const height = Math.round((hero.h * width) / hero.w);
    if (v.w !== width || Math.abs(v.h - height) > 1)
      throw new DomainError("media_invalid", 400);
  }
  // A strip narrower than 1:4 is not a menu photo (and keeps decoded sizes bounded).
  if (hero.h > 4 * hero.w || hero.w > 4 * hero.h)
    throw new DomainError("media_invalid", 400);
  return { width: hero.w, height: hero.h, type, variants: out };
}
function mediaError(e: unknown): DomainError {
  if (e instanceof WebpError || e instanceof JpegError)
    return new DomainError(
      e.code,
      e.code === "media_type_unsupported"
        ? 415
        : e.code === "media_too_large"
          ? 413
          : 400,
    );
  return e as DomainError;
}

/**
 * Upload admission before the body is read (R8, KV-SECURITY-1, KF-SECURITY-1): one upload in
 * flight per restaurant (else media_busy) and MEDIA_LIMITS.uploadSlots in the process (else
 * media_server_busy, so a restaurant is never told one of its own photos is uploading). A refused
 * request is answered without its body being buffered or parsed, so concurrent bodies never pile
 * up in memory behind serial(). The returned release runs once: the route calls it when the
 * upload's processing ends, or when its body never arrived (KF-SECURITY-4).
 */
const uploading = new Set<string>();
/** Uploads admitted and not finished (the kiosk DB suite waits on it). */
export const uploadsInFlight = () => uploading.size;
export function admitUpload(
  tenantId: string,
): (() => void) | "media_busy" | "media_server_busy" {
  if (uploading.has(tenantId)) return "media_busy";
  if (uploading.size >= MEDIA_LIMITS.uploadSlots) return "media_server_busy";
  uploading.add(tenantId);
  let held = true;
  return () => {
    if (held) uploading.delete(tenantId);
    held = false;
  };
}

/** One upload at a time per process (R8: bounded CPU and memory on the web replica). */
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;
function serial<T>(fn: () => Promise<T>): Promise<T> {
  queued += 1;
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  void queue.then(() => (queued -= 1));
  return next;
}
/**
 * The upload queue, for the kiosk DB suite: it holds the queue to see an upload's slot outlive a
 * client that left after its body arrived (KF-SECURITY-4), and reads its depth.
 */
export const mediaQueue = { hold: serial, depth: () => queued };

type ImageResult = {
  productId: string;
  version: number;
  image: Product["image"];
};

type VariantMeta = { sha256: string; type?: MediaType };
/** id → {tenant, variants}: the media route's cache (10 minutes, 2000 entries). */
const lru = new Map<
  string,
  { at: number; tenantId: string; variants: Record<string, VariantMeta> }
>();
const LRU_MAX = 2000,
  LRU_MS = 10 * 60_000;
export const forgetMedia = (assetId?: string) =>
  assetId ? lru.delete(assetId) : lru.clear();

const uploadInput = z
  .object({
    operationId: id,
    productId: id,
    /** «Importar fotos» (R42/Q7): the import run and item this upload belongs to. */
    importRef: importRef.optional(),
  })
  .strict();

/**
 * POST /api/menu/products/:id/image (owners and managers): the three variants as one raw body.
 * tx A records the asset (uploading), the objects are written outside any transaction, tx B
 * marks it ready and attaches it to the product (menu revision bump). A replay of the operation
 * id answers its first result; an upload interrupted between A and B is swept by media_stale.
 */
export async function uploadProductImage(
  sql: postgres.Sql,
  s: Session,
  raw: { operationId: unknown; productId: unknown; importRef?: unknown },
  body: Buffer,
): Promise<ImageResult> {
  permit(s, managers);
  const p = uploadInput.parse(raw);
  if (!menuPhotosEnabled()) throw new DomainError("media_disabled", 404);
  const store = mediaStore();
  // MEDIA_STORE unset (a deployment without the R2 media bucket): photos are unavailable, never a
  // local directory; the menus show text tiles (/capabilities: media_store_not_configured).
  if (!store) throw new DomainError("media_store_not_configured", 503);
  const prior = await tenant(sql, s.tenantId, async (tx) => {
    const [r] =
      await tx`select kind,result from operations where id=${p.operationId}`;
    return r;
  });
  if (prior) {
    if (prior.kind !== "menu.product.image")
      throw new DomainError("operation_conflict", 409);
    return prior.result as ImageResult;
  }
  return serial(async () => {
    // The cheap refusals before the parse (both re-checked in tx A): the restaurant's window, and
    // a product that does not exist. Then the parse, one at a time (KV-SECURITY-1).
    await tenant(sql, s.tenantId, async (tx) => {
      const [n] = await tx`select count(*)::int as n from menu_media
        where created_at>now()-interval '10 minutes'`;
      if (n.n >= MEDIA_LIMITS.uploadsPerWindow)
        throw new DomainError("media_rate_limited", 429);
      const [product] =
        await tx`select id from catalog where id=${p.productId}`;
      if (!product) throw new DomainError("not_found", 404);
    });
    const processed = processUpload(body);
    // Let the requests that waited during the parse run before the next phase.
    await new Promise((resolve) => setImmediate(resolve));
    const assetId = randomUUID();
    await tenant(sql, s.tenantId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + p.operationId},0))`;
      await tx`select id from restaurants where id=${s.tenantId} for share`;
      await requireSelling(tx, s);
      const [n] = await tx`select count(*)::int as n from menu_media
        where created_at>now()-interval '10 minutes'`;
      if (n.n >= MEDIA_LIMITS.uploadsPerWindow)
        throw new DomainError("media_rate_limited", 429);
      const [product] =
        await tx`select id from catalog where id=${p.productId}`;
      if (!product) throw new DomainError("not_found", 404);
      await tx`insert into menu_media(tenant_id,id,created_by) values(${s.tenantId},${assetId},${s.employeeId})`;
      await enqueueJob(tx, s, {
        kind: "media_stale",
        dedupeKey: assetId,
        payload: { assetId },
        runAt: new Date(Date.now() + MEDIA_LIMITS.staleAfterMs),
      });
    });
    try {
      for (const v of processed.variants)
        await store.put(
          objectKey(s.tenantId, assetId, v.name, processed.type),
          v.bytes,
          processed.type,
        );
    } catch (e) {
      log.error("media_store_failed", {
        op: "put",
        error: String((e as Error).message ?? e),
      });
      throw new DomainError("media_unavailable", 503);
    }
    return tenant(sql, s.tenantId, (tx) =>
      once(
        tx,
        s,
        p.operationId,
        "menu.product.image",
        { productId: p.productId, assetId },
        async () => {
          await bumpMenuRevision(tx);
          const [old] = await tx<
            { data: Product }[]
          >`select data from catalog where id=${p.productId} for update`;
          if (!old) throw new DomainError("not_found", 404);
          const [m] =
            await tx`select state from menu_media where id=${assetId} for update`;
          if (m?.state !== "uploading")
            throw new DomainError("media_invalid", 400);
          const variants = Object.fromEntries(
            processed.variants.map((v) => [
              v.name,
              {
                w: v.w,
                h: v.h,
                bytes: v.bytes.length,
                sha256: v.sha256,
                type: processed.type,
              },
            ]),
          );
          await tx`update menu_media set state='ready',width=${processed.width},height=${processed.height},
            variants=${tx.json(variants)} where id=${assetId}`;
          const image: Product["image"] = {
            id: assetId,
            w: processed.width,
            h: processed.height,
            // The URL's extension follows it (mediaUrl); absent = WebP.
            ...(processed.type === "image/jpeg"
              ? { type: "image/jpeg" as const }
              : {}),
          };
          const data: Product = {
            ...old.data,
            image,
            version: old.data.version + 1,
          };
          await tx`update catalog set data=${tx.json(data as never)} where id=${p.productId}`;
          if (old.data.image?.id) await retire(tx, s, old.data.image.id);
          await audit(tx, s, "menu.media.attached", p.productId, {
            assetId,
            previous: old.data.image?.id ?? null,
            ...(p.importRef
              ? { via: { kind: "menu_import", ...p.importRef } }
              : {}),
          });
          return { productId: p.productId, version: data.version, image };
        },
      ),
    );
  });
}

/**
 * POST /api/menu/media-import (owners and managers): «Importar fotos»'s report, one audit row per
 * run under its own operation id (the photos were each attached by the upload route, tagged with
 * the run). It records what was imported and what was not and why (no product, no file, already
 * a photo, a product two items named, failed), so the unmatched items stay on record.
 */
export async function recordMediaImport(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<{ batchId: string; counts: Record<string, number> }> {
  permit(s, managers);
  const p = mediaImportReportInput.parse(raw);
  return once(tx, s, p.operationId, "menu.media.import", p, async () => {
    const counts: Record<string, number> = {};
    for (const item of p.items)
      counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
    // An item reported imported names an asset this restaurant attached to that product: its
    // upload's menu.media.attached audit row (KV-SECURITY-2), read in the last 7 days (the
    // audit's (tenant_id, created_at) index; an import reports right after its run). Any run's
    // row counts, so a replayed upload (same operation id, an earlier run) still matches.
    const claimed = p.items.filter((i) => i.outcome === "imported");
    if (claimed.some((i) => !i.assetId || !i.productId))
      throw new DomainError("invalid_input");
    if (claimed.length) {
      const [found] = await tx`select count(*)::int as n from (
          select distinct a.entity_id,a.detail->>'assetId' from audit a
          where a.created_at>now()-interval '7 days' and a.operation='menu.media.attached'
            and (a.entity_id,a.detail->>'assetId') in (
              select * from unnest(${tx.array(claimed.map((i) => i.productId!))}::text[],
                ${tx.array(claimed.map((i) => i.assetId!))}::text[]))) x`;
      if (
        found.n !==
        new Set(claimed.map((i) => `${i.productId}:${i.assetId}`)).size
      )
        throw new DomainError("not_found", 404);
    }
    await audit(tx, s, "menu.media.import", p.operationId, {
      source: p.source,
      manifestSha256: p.manifestSha256,
      replace: p.replace,
      counts,
      items: p.items.map((i) => ({
        id: i.id,
        name: i.name,
        productId: i.productId,
        outcome: i.outcome,
        ...(i.assetId ? { assetId: i.assetId } : {}),
        ...(i.code ? { code: i.code } : {}),
      })),
    });
    return { batchId: p.operationId, counts };
  });
}

/** Marks an asset deleted (404 at once) and schedules its purge 7 days later. */
async function retire(tx: Tx, s: Session, assetId: string) {
  const [m] =
    await tx`update menu_media set state='deleted',deleted_at=now(),deleted_by=${s.employeeId}
    where id=${assetId} and state in ('uploading','ready') returning deleted_at`;
  if (!m) return;
  forgetMedia(assetId);
  await enqueueJob(tx, s, {
    kind: "media_purge",
    dedupeKey: assetId,
    payload: { assetId },
    runAt: new Date(Date.now() + MEDIA_LIMITS.purgeAfterDays * 86_400_000),
  });
}

const removeInput = z
  .object({ operationId: id, expectedVersion: z.number().int().min(1) })
  .strict();

/** DELETE /api/menu/products/:id/image: "Quitar foto" (the menu revision bumps; 404 at once). */
export async function removeProductImage(
  tx: Tx,
  s: Session,
  productId: string,
  raw: unknown,
): Promise<ImageResult> {
  permit(s, managers);
  id.parse(productId);
  const p = removeInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "menu.product.image_remove",
    { productId, ...p },
    async () => {
      await requireSelling(tx, s);
      await bumpMenuRevision(tx);
      const [old] = await tx<
        { data: Product }[]
      >`select data from catalog where id=${productId} for update`;
      if (!old) throw new DomainError("not_found", 404);
      if (old.data.version !== p.expectedVersion)
        throw new DomainError("menu_changed", 409);
      const assetId = old.data.image?.id ?? null;
      const { image: _image, ...rest } = old.data;
      const data: Product = { ...rest, version: old.data.version + 1 };
      await tx`update catalog set data=${tx.json(data as never)} where id=${productId}`;
      if (assetId) {
        await tx`select id from menu_media where id=${assetId} for update`;
        await retire(tx, s, assetId);
      }
      await audit(tx, s, "menu.media.removed", productId, { assetId });
      return { productId, version: data.version, image: null };
    },
  );
}

/** The media route's path; `file` is <variant>.webp or <variant>.jpg (mediaUrl). */
export const MEDIA_ROUTE = "/media/:assetId/:file";
const FILE = /^(thumb|card|hero)\.(webp|jpg)$/;

/**
 * GET /media/:assetId/<variant>.webp|jpg (outside /api, before the SPA fallback): exactly the
 * ready asset whose id the URL carries, through the menu_media_lookup policy (no tenant in the
 * URL), served as the type it was stored as; the extension must match it (KIOSK-UX-11).
 * Immutable (a new upload is a new id), nosniff, sandboxed, same-origin only.
 */
export function mediaRoute(sql: postgres.Sql): express.RequestHandler {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return async (req, res) => {
    const notFound = (code: string) => res.status(404).json({ error: code });
    try {
      if (!menuPhotosEnabled()) return notFound("media_disabled");
      const assetId = String(req.params.assetId ?? "");
      const file = FILE.exec(String(req.params.file ?? ""));
      if (!UUID.test(assetId) || !file) return notFound("media_not_found");
      const [, variant, ext] = file;
      let hit = lru.get(assetId);
      if (!hit || Date.now() - hit.at > LRU_MS) {
        const row = (await sql.begin(async (raw) => {
          const tx = raw as Tx;
          await tx`select set_config('app.media_id', ${assetId}, true)`;
          const [r] =
            await tx`select tenant_id,variants from menu_media where id=${assetId} and state='ready'`;
          return r;
        })) as
          | { tenant_id: string; variants: Record<string, VariantMeta> }
          | undefined;
        if (!row) {
          lru.delete(assetId);
          return notFound("media_not_found");
        }
        hit = {
          at: Date.now(),
          tenantId: row.tenant_id,
          variants: row.variants,
        };
        if (lru.size >= LRU_MAX) lru.delete(lru.keys().next().value!);
        lru.set(assetId, hit);
      }
      const meta = hit.variants[variant];
      // Assets stored before KIOSK-UX-11 carry no type: WebP.
      const type: MediaType = meta?.type ?? "image/webp";
      if (!meta || MEDIA_TYPES[type] !== ext)
        return notFound("media_not_found");
      const headers = {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${meta.sha256}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      };
      if (req.get("if-none-match") === headers.ETag)
        return res.status(304).set(headers).end();
      const store = mediaStore();
      if (!store) return res.status(503).json({ error: "media_unavailable" });
      let bytes: Buffer | null;
      try {
        bytes = await store.get(
          objectKey(hit.tenantId, assetId, variant, type),
        );
      } catch (e) {
        log.error("media_store_failed", {
          op: "get",
          error: String((e as Error).message ?? e),
        });
        return res.status(503).json({ error: "media_unavailable" });
      }
      if (!bytes) return notFound("media_not_found");
      res.status(200).set(headers).send(bytes);
    } catch (e) {
      log.error("media_route_failed", {
        error: String((e as Error).message ?? e),
      });
      res.status(503).json({ error: "media_unavailable" });
    }
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Every object the asset may have: a half-done upload has no recorded type, so both types. */
async function deleteObjects(tenantId: string, assetId: string) {
  const store = mediaStore();
  if (!store) throw Error("media_store_unconfigured");
  for (const v of MEDIA_VARIANTS)
    for (const type of Object.keys(MEDIA_TYPES) as MediaType[])
      await store.delete(objectKey(tenantId, assetId, v.name, type));
}

/** Web jobs (critic R36): the purge 7 days after removal, and the sweep of a half-done upload. */
export function registerMediaJobs(): void {
  registerJobHandler(
    "media_purge",
    async (ctx) => {
      const assetId = (ctx.job.payload as { assetId?: unknown } | null)
        ?.assetId;
      if (typeof assetId !== "string" || !UUID.test(assetId))
        return { status: "dead", code: "media_payload_invalid" };
      const due = await ctx.tenant(async (tx) => {
        const [m] =
          await tx`select state,deleted_at<=now()-make_interval(days=>${MEDIA_LIMITS.purgeAfterDays}) as due
          from menu_media where id=${assetId}`;
        return m?.state === "deleted" && m.due;
      });
      if (!due) return { status: "done" };
      await deleteObjects(ctx.job.tenantId, assetId);
      await ctx.tenant(
        (tx) =>
          tx`update menu_media set state='purged',purged_at=now() where id=${assetId} and state='deleted'`,
      );
      return { status: "done" };
    },
    { concurrency: 1, leaseSeconds: 60, maxAttempts: 8 },
  );
  registerJobHandler(
    "media_stale",
    async (ctx) => {
      const assetId = (ctx.job.payload as { assetId?: unknown } | null)
        ?.assetId;
      if (typeof assetId !== "string" || !UUID.test(assetId))
        return { status: "dead", code: "media_payload_invalid" };
      const stale = await ctx.tenant(async (tx) => {
        const [m] = await tx`select state from menu_media where id=${assetId}`;
        return m?.state === "uploading";
      });
      if (!stale) return { status: "done" };
      await deleteObjects(ctx.job.tenantId, assetId);
      await ctx.tenant(async (tx) => {
        await tx`update menu_media set state='deleted',deleted_at=now() where id=${assetId} and state='uploading'`;
        await tx`update menu_media set state='purged',purged_at=now() where id=${assetId} and state='deleted'`;
      });
      return { status: "done" };
    },
    { concurrency: 1, leaseSeconds: 60, maxAttempts: 8 },
  );
}
