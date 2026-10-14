/**
 * «Importar menú de POS Lite» (docs/MENU.md): one pos-lite export file → this restaurant's
 * categories, reusable modifier groups and products, written through the menu editor's own
 * helpers (server/menu.ts) so every record is the one the editor would have saved.
 *
 *   POST /api/menu/import/preview  the file → the plan, what the restaurant already has (no writes)
 *   POST /api/menu/import/commit   { file, stations, fileHash } → one import batch (step-up)
 *
 * The plan is always recomputed here from the file (shared/menu-import.ts); a client plan is
 * never trusted. fileHash is sha256 hex of JSON.stringify(file) as the server received it
 * (parsed JSON, unknown keys kept): the preview returns it and the commit must send it back
 * with the same file. One import per pos-lite restaurant: a second, different file is refused
 * (menu_import_existing_mapping); the same file again returns the stored report (replay).
 *
 * Lock order (docs/ARCHITECTURE.md "Global lock order", menu import row): the import key
 * (LO-1, class 0: tenant + source + pos-lite tenant, as commitImport and the loyalty import)
 * → restaurants FOR SHARE (LO-2) → requireSelling → menu_state (bumpMenuRevision, once) →
 * modifier_groups → menu_categories → catalog (LO-3, the menu write order of server/menu.ts).
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { DomainError, type Session } from "../shared/domain.js";
import { MENU_LIMITS } from "../shared/menu.js";
import { groupInput, productInput } from "../shared/menu-schema.js";
import {
  MENU_IMPORT_SOURCE,
  menuImportCommitInput,
  menuImportFile,
  planMenuImport,
  productNameKey,
  type MenuImportError,
  type MenuImportFile,
  type MenuImportPlan,
  type MenuImportPreview,
  type MenuImportResult,
  type Station,
} from "../shared/menu-import.js";
import { hash, managers, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { audit } from "./orders.js";
import { requireSelling } from "./free-limits.js";
import {
  activeCount,
  activeProducts,
  bumpMenuRevision,
  groupDocument,
  placeCategory,
  storeGroup,
  writeProduct,
} from "./menu.js";

/** What import_batches.report keeps for a replay and the import's audit row. */
type StoredReport = {
  batchId: string;
  sourceTenantId: string;
  counts: MenuImportResult["counts"];
  priceControlTotal: number;
  stations: Record<string, Station>;
  warnings: MenuImportPlan["warnings"];
};

/** The export file, validated, and the hash the commit must send back. */
function readFile(raw: unknown): { file: MenuImportFile; fileHash: string } {
  const parsed = menuImportFile.safeParse(raw);
  if (!parsed.success) throw new DomainError("menu_import_file_invalid", 422);
  return { file: parsed.data, fileHash: hash(JSON.stringify(raw)) };
}

/** The operator's -v target names the Green Monkey restaurant; prices must be its currency. */
function checkScope(s: Session, file: MenuImportFile, currency: string) {
  if (file.targetTenantId !== s.tenantId)
    throw new DomainError("menu_import_scope", 403);
  if (file.currency !== currency)
    throw new DomainError("menu_import_currency", 422);
}

/**
 * MENU_LIMITS against what the restaurant has plus what the import adds. A planned category
 * whose Spanish name matches an active one (as placeCategory matches it) adds nothing.
 */
async function limitErrors(
  tx: Tx,
  plan: MenuImportPlan,
): Promise<MenuImportError[]> {
  const names = plan.categories.map((c) => c.name.es);
  const [c] = names.length
    ? await tx`select count(distinct lower(k))::int as n from unnest(${tx.array(names)}::text[]) as k
        where not exists (select 1 from menu_categories m where m.archived_at is null and lower(m.name_es)=lower(k))`
    : [{ n: 0 }];
  const totals = [
    {
      code: "limit_categories" as const,
      entity: "category" as const,
      n: (await activeCount(tx, "menu_categories")) + c.n,
      max: MENU_LIMITS.categories,
    },
    {
      code: "limit_groups" as const,
      entity: "group" as const,
      n: (await activeCount(tx, "modifier_groups")) + plan.counts.groups,
      max: MENU_LIMITS.groups,
    },
    {
      code: "limit_products" as const,
      entity: "product" as const,
      n: (await activeProducts(tx)) + plan.counts.products,
      max: MENU_LIMITS.products,
    },
  ];
  return totals
    .filter((t) => t.n > t.max)
    .map((t) => ({ code: t.code, entity: t.entity, from: t.n, to: t.max }));
}

/** Any mapping of this pos-lite restaurant: a menu was already imported from it. */
async function importedBefore(tx: Tx, sourceTenantId: string) {
  const [m] =
    await tx`select 1 from source_mappings where source_system=${MENU_IMPORT_SOURCE} and source_tenant_id=${sourceTenantId} limit 1`;
  return !!m;
}

/** POST /api/menu/import/preview (owners and managers): what Importar would do. Writes nothing. */
export async function previewMenuImport(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<MenuImportPreview> {
  permit(s, managers);
  const { file, fileHash } = readFile(raw);
  const [restaurant] =
    await tx`select currency from restaurants where id=${s.tenantId}`;
  checkScope(s, file, restaurant?.currency);
  const plan = planMenuImport(file);
  const errors = [...plan.errors, ...(await limitErrors(tx, plan))];
  const [batch] =
    await tx`select id from import_batches where source=${MENU_IMPORT_SOURCE} and file_hash=${fileHash}`;
  const active = await tx<{ id: string; name: string }[]>`select id, data->'name'->>'es' as name
    from catalog where not coalesce((data->>'archived')::boolean,false) order by id`;
  const byKey = new Map(active.map((p) => [productNameKey(p.name ?? ""), p.id]));
  const existingNameClashes = plan.products.flatMap((p) => {
    const productId = byKey.get(productNameKey(p.name.es));
    return productId ? [{ legacyId: p.legacyId, name: p.name.es, productId }] : [];
  });
  return {
    ...plan,
    errors,
    fileHash,
    alreadyImported: !!batch,
    importedBefore: !batch && (await importedBefore(tx, file.sourceTenantId)),
    existingNameClashes,
  };
}

/**
 * POST /api/menu/import/commit (owners and managers, recent PIN): writes the plan of `file`
 * with the owner's stations. Groups first, then categories, then products, in one transaction
 * with one menu revision; one menu.import audit row (the per-record editor rows are not
 * repeated for each imported record).
 */
export async function commitMenuImport(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<MenuImportResult> {
  permit(s, managers);
  requireRecentAuth(s);
  const input = menuImportCommitInput.safeParse(raw);
  if (!input.success) throw new DomainError("invalid_input", 400);
  const { file, fileHash } = readFile(input.data.file);
  if (file.targetTenantId !== s.tenantId)
    throw new DomainError("menu_import_scope", 403);
  if (input.data.fileHash !== fileHash)
    throw new DomainError("menu_import_file_changed", 409);
  const stations = input.data.stations;
  const plan = planMenuImport(file, { stations });
  if (plan.errors.length) throw new DomainError("menu_import_invalid", 409);

  // The import's operation key (LO-1) before the restaurants row (LO-2), as once() takes them.
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + MENU_IMPORT_SOURCE + file.sourceTenantId},0))`;
  const [restaurant] =
    await tx`select currency from restaurants where id=${s.tenantId} for share`;
  if (!restaurant || restaurant.currency !== s.restaurant.currency)
    throw new DomainError("settings_changed", 409);
  checkScope(s, file, restaurant.currency);
  const [prior] =
    await tx`select id, report from import_batches where source=${MENU_IMPORT_SOURCE} and file_hash=${fileHash}`;
  if (prior) {
    const r = prior.report as StoredReport;
    return {
      batchId: prior.id,
      replayed: true,
      counts: r.counts,
      priceControlTotal: r.priceControlTotal,
    };
  }
  if (await importedBefore(tx, file.sourceTenantId))
    throw new DomainError("menu_import_existing_mapping", 409);
  await requireSelling(tx, s);
  // menu_state (LO-3) once: it serializes every menu write of the restaurant.
  await bumpMenuRevision(tx);
  if ((await limitErrors(tx, plan)).length)
    throw new DomainError("menu_import_invalid", 409);

  const mappings: { type: string; legacyId: string; targetId: string }[] = [];
  // modifier_groups: each as saveGroup stores a new one (fresh group and option ids, version 1,
  // options available).
  const groupIds = new Map<string, string>();
  for (const g of plan.groups) {
    const p = groupInput.parse({
      operationId: randomUUID(),
      id: randomUUID(),
      expectedVersion: 0,
      name: { es: g.name, en: "" },
      min: g.min,
      max: g.max,
      repeat: g.repeat,
      options: g.options.map((o) => ({
        id: randomUUID(),
        name: { es: o.name, en: "" },
        price: o.price,
      })),
    });
    await storeGroup(tx, s, p, groupDocument(p, []));
    groupIds.set(g.legacyId, p.id);
    mappings.push({ type: "modifier_group", legacyId: g.legacyId, targetId: p.id });
    g.options.forEach((o, i) =>
      mappings.push({ type: "modifier", legacyId: o.legacyId, targetId: p.options[i].id }),
    );
  }
  // menu_categories: an active one with the same Spanish name is reused, as the editor's
  // findOrCreateCategory does; a new one goes at the end, in pos-lite's order.
  const categoryIds = new Map<string, string>();
  let categoriesReused = 0;
  for (const c of plan.categories) {
    const placed = await placeCategory(tx, s, c.name, false);
    if (!placed.created) categoriesReused++;
    categoryIds.set(c.legacyId, placed.category.id);
    mappings.push({ type: "menu_category", legacyId: c.legacyId, targetId: placed.category.id });
  }
  // catalog: each product as saveMenuProduct creates it (writeProduct: compiled groups,
  // position at the end of its category, version 1, its recipe_versions row).
  for (const item of plan.products) {
    const p = productInput.parse({
      operationId: randomUUID(),
      id: randomUUID(),
      expectedVersion: 0,
      name: item.name,
      categoryId: categoryIds.get(item.categoryLegacyId),
      price: item.price,
      station: item.station,
      groupIds: item.groupLegacyIds.map((id) => groupIds.get(id)),
      ...(item.description ? { description: item.description } : {}),
    });
    await writeProduct(tx, s, p, true, false);
    mappings.push({ type: "catalog", legacyId: item.legacyId, targetId: p.id });
  }

  const batchId = randomUUID();
  const counts = { ...plan.counts, categoriesReused };
  const report: StoredReport = {
    batchId,
    sourceTenantId: file.sourceTenantId,
    counts,
    priceControlTotal: plan.priceControlTotal,
    stations: Object.fromEntries(plan.categories.map((c) => [c.legacyId, c.station])),
    warnings: plan.warnings,
  };
  await tx`insert into import_batches(tenant_id,id,source,file_hash,report)
    values(${s.tenantId},${batchId},${MENU_IMPORT_SOURCE},${fileHash},${tx.json(report as never)})`;
  if (mappings.length)
    await tx`insert into source_mappings(tenant_id,source_system,source_tenant_id,entity_type,legacy_id,target_id,import_batch_id)
      select ${s.tenantId}, ${MENU_IMPORT_SOURCE}, ${file.sourceTenantId}, m.t, m.l, m.id, ${batchId}
      from unnest(${tx.array(mappings.map((m) => m.type))}::text[], ${tx.array(mappings.map((m) => m.legacyId))}::text[],
                  ${tx.array(mappings.map((m) => m.targetId))}::uuid[]) as m(t, l, id)`;
  await audit(tx, s, "menu.import", batchId, {
    source: MENU_IMPORT_SOURCE,
    sourceTenantId: file.sourceTenantId,
    sourceName: file.sourceName ?? null,
    counts,
    priceControlTotal: plan.priceControlTotal,
    stations: report.stations,
    warnings: plan.warnings,
  });
  return { batchId, replayed: false, counts, priceControlTotal: plan.priceControlTotal };
}
