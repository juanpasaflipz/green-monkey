import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import type { Session } from "../shared/domain.js";
import { DomainError } from "../shared/domain.js";
import { previewImport } from "../shared/import.js";
import { hash, permit, managers } from "./auth.js";
import { audit } from "./orders.js";
import { requireSelling } from "./free-limits.js";
export async function commitImport(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const [restaurant] =
    await tx`select currency from restaurants where id=${s.tenantId} for share`;
  if (restaurant.currency !== s.restaurant.currency)
    throw new DomainError("settings_changed", 409);
  const report = previewImport(raw);
  if (
    report.targetTenantId !== s.tenantId ||
    report.currency !== s.restaurant.currency
  )
    throw new DomainError("import_scope", 403);
  if (report.rejected.length) throw new DomainError("import_rejected", 409);
  const fingerprint = hash(JSON.stringify(raw));
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + report.source + report.sourceTenantId},0))`;
  const [prior] =
    await tx`select * from import_batches where source=${report.source} and file_hash=${fingerprint}`;
  if (prior) return prior.report;
  await requireSelling(tx, s);
  const batchId = randomUUID();
  await tx`insert into import_batches(tenant_id,id,source,file_hash,report) values(${s.tenantId},${batchId},${report.source},${fingerprint},${tx.json(report)})`;
  for (const r of report.accepted) {
    const [mapping] =
      await tx`select target_id from source_mappings where source_system=${report.source} and source_tenant_id=${report.sourceTenantId} and entity_type='catalog' and legacy_id=${r.legacyId}`;
    if (mapping) throw new DomainError("import_existing_mapping", 409);
    const productId = randomUUID();
    const data = {
      id: productId,
      name: { es: r.name, en: r.name },
      category: { es: r.category, en: r.category },
      price: r.price,
      available: r.available,
      station: "kitchen",
      groups: [],
      recipe: [],
      cost: null,
      version: 1,
    };
    await tx`insert into catalog(tenant_id,id,data) values(${s.tenantId},${productId},${tx.json(data)})`;
    await tx`insert into source_mappings(tenant_id,source_system,source_tenant_id,entity_type,legacy_id,target_id,import_batch_id) values(${s.tenantId},${report.source},${report.sourceTenantId},'catalog',${r.legacyId},${productId},${batchId})`;
  }
  await audit(tx, s, "import.catalog", batchId, {
    source: report.source,
    count: report.accepted.length,
  });
  return report;
}
