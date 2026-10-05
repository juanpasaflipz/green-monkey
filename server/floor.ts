// Floor plan: dining areas and tables. Mutations serialize per tenant on an
// advisory lock (inside once()), which also guards name uniqueness.
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { audit, once } from "./orders.js";
import { requireSelling } from "./free-limits.js";
import { managers, permit } from "./auth.js";
import { DomainError, type Session } from "../shared/domain.js";
import {
  MENU_LIMITS,
  type DiningArea,
  type DiningTable,
} from "../shared/menu.js";
import {
  archiveInput,
  areaInput,
  reorderInput,
  tableInput,
  tablesBulkInput,
} from "../shared/menu-schema.js";

type AreaRow = {
  id: string;
  name: string;
  position: number;
  version: number;
  archived_at: Date | null;
};
type TableRow = {
  id: string;
  name: string;
  area_id: string | null;
  seats: number | null;
  position: number;
  version: number;
  archived_at: Date | null;
};

function toArea(r: AreaRow): DiningArea {
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    version: r.version,
    archived: r.archived_at !== null,
  };
}
function toTable(r: TableRow, open = false): DiningTable {
  return {
    id: r.id,
    name: r.name,
    areaId: r.area_id,
    seats: r.seats,
    position: r.position,
    version: r.version,
    archived: r.archived_at !== null,
    open,
  };
}

async function lockFloor(tx: Tx) {
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':floor',0))`;
}

/**
 * The ids of tables with an open check, optionally limited to some tables.
 * The single home of the "open check" rule (contract D10): the service
 * lifecycle's `o.check_state <> 'closed'`, written literally so the partial
 * index orders_table_open (024) serves it. A paid dine-in check still holds
 * its table until "Liberar mesa" closes it.
 */
export async function tablesWithOpenChecks(
  tx: Tx,
  tableIds?: string[],
): Promise<Set<string>> {
  const rows = await tx`select distinct o.table_id from orders o
    where o.table_id is not null
      ${tableIds ? tx`and o.table_id=any(${tx.array(tableIds)}::uuid[])` : tx``}
      and o.check_state <> 'closed'`;
  return new Set(rows.map((r) => r.table_id as string));
}

/** GET /tables: active tables in area, then table order (superset of old fields). */
export async function activeTables(tx: Tx) {
  return tx`select t.*,a.name as area_name,a.position as area_position
    from dining_tables t left join dining_areas a on a.tenant_id=t.tenant_id and a.id=t.area_id
    where t.archived_at is null
    order by a.position nulls first,t.position,t.name,t.id`;
}

export async function floorPayload(tx: Tx, s: Session) {
  permit(s, managers);
  const areas = await tx<
    AreaRow[]
  >`select * from dining_areas order by archived_at nulls first,position,name,id`;
  const tables = await tx<TableRow[]>`select t.* from dining_tables t
    left join dining_areas a on a.tenant_id=t.tenant_id and a.id=t.area_id
    order by a.position nulls first,t.position,t.name,t.id`;
  const open = await tablesWithOpenChecks(tx);
  return {
    areas: areas.map(toArea),
    tables: tables.map((t) => toTable(t, open.has(t.id))),
  };
}

async function activeAreaCount(tx: Tx) {
  const [r] =
    await tx`select count(*)::int as n from dining_areas where archived_at is null`;
  return r.n as number;
}
async function activeTableCount(tx: Tx) {
  const [r] =
    await tx`select count(*)::int as n from dining_tables where archived_at is null`;
  return r.n as number;
}
async function duplicateArea(tx: Tx, name: string, except: string) {
  const [r] =
    await tx`select 1 from dining_areas where archived_at is null and lower(name)=lower(${name}) and id<>${except}`;
  return !!r;
}
async function duplicateTables(tx: Tx, names: string[], except?: string) {
  const [r] = await tx`select 1 from dining_tables where archived_at is null
    and lower(name)=any(${tx.array(names.map((n) => n.toLowerCase()))}::text[])
    ${except ? tx`and id<>${except}` : tx``} limit 1`;
  return !!r;
}
async function nextTablePosition(tx: Tx, areaId: string | null) {
  const [r] =
    await tx`select coalesce(max(position),0)+1 as n from dining_tables where area_id is not distinct from ${areaId}::uuid`;
  return r.n as number;
}
async function requireActiveArea(tx: Tx, areaId: string | null) {
  if (!areaId) return;
  const [a] =
    await tx`select id from dining_areas where id=${areaId} and archived_at is null for share`;
  if (!a) throw new DomainError("invalid_area");
}

// --------------------------------------------------------------------- areas

export async function saveArea(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = areaInput.parse(raw);
  return once(tx, s, p.operationId, "floor.area.save", p, async () => {
    await requireSelling(tx, s);
    await lockFloor(tx);
    const [old] = await tx<
      AreaRow[]
    >`select * from dining_areas where id=${p.id} for update`;
    if ((old?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    if ((!old || !old.archived_at) && (await duplicateArea(tx, p.name, p.id)))
      throw new DomainError("duplicate_name", 409);
    let row: AreaRow;
    if (!old) {
      if ((await activeAreaCount(tx)) >= MENU_LIMITS.areas)
        throw new DomainError("menu_limit", 409);
      [row] = await tx<
        AreaRow[]
      >`insert into dining_areas(tenant_id,id,name,position)
        values(${s.tenantId},${p.id},${p.name},(select coalesce(max(position),0)+1 from dining_areas))
        returning *`;
    } else
      [row] = await tx<
        AreaRow[]
      >`update dining_areas set name=${p.name},version=version+1 where id=${p.id} returning *`;
    await audit(tx, s, "floor.area.saved", p.id, {
      before: old?.name ?? null,
      after: p.name,
    });
    return toArea(row);
  });
}

export async function reorderAreas(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = reorderInput.parse(raw);
  return once(tx, s, p.operationId, "floor.area.reorder", p, async () => {
    await requireSelling(tx, s);
    await lockFloor(tx);
    const active =
      await tx`select id from dining_areas where archived_at is null order by id for update`;
    if (
      new Set(p.ids).size !== p.ids.length ||
      p.ids.length !== active.length ||
      !active.every((a) => p.ids.includes(a.id))
    )
      throw new DomainError("menu_changed", 409);
    await tx`update dining_areas d set position=x.pos::int
      from unnest(${tx.array(p.ids)}::uuid[]) with ordinality as x(id,pos) where d.id=x.id`;
    await audit(tx, s, "floor.area.reordered", s.tenantId, { ids: p.ids });
    return { ok: true };
  });
}

export async function archiveArea(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = archiveInput.parse(raw);
  return once(tx, s, p.operationId, "floor.area.archive", p, async () => {
    await requireSelling(tx, s);
    await lockFloor(tx);
    const [old] = await tx<
      AreaRow[]
    >`select * from dining_areas where id=${p.id} for update`;
    if (!old || old.version !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    let row: AreaRow;
    if (p.archived) {
      const [inUse] =
        await tx`select 1 from dining_tables where area_id=${p.id} and archived_at is null limit 1`;
      if (inUse) throw new DomainError("area_in_use", 409);
      [row] = await tx<
        AreaRow[]
      >`update dining_areas set archived_at=coalesce(archived_at,now()),version=version+1 where id=${p.id} returning *`;
    } else {
      if (old.archived_at) {
        if (await duplicateArea(tx, old.name, p.id))
          throw new DomainError("duplicate_name", 409);
        if ((await activeAreaCount(tx)) >= MENU_LIMITS.areas)
          throw new DomainError("menu_limit", 409);
      }
      [row] = await tx<AreaRow[]>`update dining_areas set archived_at=null,
        position=case when archived_at is null then position
                      else (select coalesce(max(position),0)+1 from dining_areas) end,
        version=version+1 where id=${p.id} returning *`;
    }
    await audit(tx, s, "floor.area.archived", p.id, { archived: p.archived });
    return toArea(row);
  });
}

// -------------------------------------------------------------------- tables

export async function saveTable(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = tableInput.parse(raw);
  return once(tx, s, p.operationId, "floor.table.save", p, async () => {
    await requireSelling(tx, s);
    await lockFloor(tx);
    const [old] = await tx<
      TableRow[]
    >`select * from dining_tables where id=${p.id} for update`;
    if ((old?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    await requireActiveArea(tx, p.areaId);
    if (
      (!old || !old.archived_at) &&
      (await duplicateTables(tx, [p.name], p.id))
    )
      throw new DomainError("duplicate_name", 409);
    let row: TableRow;
    if (!old) {
      if ((await activeTableCount(tx)) >= MENU_LIMITS.tables)
        throw new DomainError("menu_limit", 409);
      [row] = await tx<
        TableRow[]
      >`insert into dining_tables(tenant_id,id,name,area_id,seats,position)
        values(${s.tenantId},${p.id},${p.name},${p.areaId},${p.seats},${await nextTablePosition(tx, p.areaId)})
        returning *`;
    } else {
      const position =
        old.area_id === p.areaId
          ? old.position
          : await nextTablePosition(tx, p.areaId);
      [row] = await tx<TableRow[]>`update dining_tables
        set name=${p.name},area_id=${p.areaId},seats=${p.seats},position=${position},version=version+1
        where id=${p.id} returning *`;
    }
    await audit(tx, s, "floor.table.saved", p.id, {
      before: old
        ? { name: old.name, areaId: old.area_id, seats: old.seats }
        : null,
      after: { name: p.name, areaId: p.areaId, seats: p.seats },
    });
    return toTable(row, (await tablesWithOpenChecks(tx, [p.id])).has(p.id));
  });
}

export function bulkTableNames(prefix: string, from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) =>
    `${prefix} ${from + i}`.trim(),
  );
}

export async function bulkTables(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = tablesBulkInput.parse(raw);
  return once(tx, s, p.operationId, "floor.table.bulk", p, async () => {
    await requireSelling(tx, s);
    await lockFloor(tx);
    await requireActiveArea(tx, p.areaId);
    const names = bulkTableNames(p.prefix, p.from, p.to);
    // All or nothing: one collision rejects the whole batch.
    if (await duplicateTables(tx, names))
      throw new DomainError("duplicate_name", 409);
    if ((await activeTableCount(tx)) + names.length > MENU_LIMITS.tables)
      throw new DomainError("menu_limit", 409);
    const start = await nextTablePosition(tx, p.areaId);
    const rows: TableRow[] = [];
    for (const [i, name] of names.entries()) {
      const [row] = await tx<
        TableRow[]
      >`insert into dining_tables(tenant_id,id,name,area_id,seats,position)
        values(${s.tenantId},${randomUUID()},${name},${p.areaId},${p.seats},${start + i})
        returning *`;
      rows.push(row);
    }
    await audit(tx, s, "floor.table.bulk", p.operationId, {
      areaId: p.areaId,
      names,
    });
    return rows.map((r) => toTable(r));
  });
}

export async function reorderTables(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = reorderInput.parse(raw);
  return once(tx, s, p.operationId, "floor.table.reorder", p, async () => {
    await requireSelling(tx, s);
    await lockFloor(tx);
    const active =
      await tx`select id from dining_tables where archived_at is null and area_id is not distinct from ${p.scopeId}::uuid order by id for update`;
    if (
      new Set(p.ids).size !== p.ids.length ||
      p.ids.length !== active.length ||
      !active.every((t) => p.ids.includes(t.id))
    )
      throw new DomainError("menu_changed", 409);
    await tx`update dining_tables d set position=x.pos::int
      from unnest(${tx.array(p.ids)}::uuid[]) with ordinality as x(id,pos) where d.id=x.id`;
    await audit(tx, s, "floor.table.reordered", p.scopeId ?? s.tenantId, {
      ids: p.ids,
    });
    return { ok: true };
  });
}

export async function archiveTable(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = archiveInput.parse(raw);
  return once(tx, s, p.operationId, "floor.table.archive", p, async () => {
    await requireSelling(tx, s);
    await lockFloor(tx);
    // The row lock waits for any order creation holding the table FOR SHARE.
    const [old] = await tx<
      TableRow[]
    >`select * from dining_tables where id=${p.id} for update`;
    if (!old || old.version !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    let row: TableRow;
    if (p.archived) {
      if ((await tablesWithOpenChecks(tx, [p.id])).has(p.id))
        throw new DomainError("table_in_use", 409);
      [row] = await tx<
        TableRow[]
      >`update dining_tables set archived_at=coalesce(archived_at,now()),version=version+1 where id=${p.id} returning *`;
    } else {
      if (old.archived_at) {
        if (await duplicateTables(tx, [old.name], p.id))
          throw new DomainError("duplicate_name", 409);
        if ((await activeTableCount(tx)) >= MENU_LIMITS.tables)
          throw new DomainError("menu_limit", 409);
      }
      // A table never returns into an archived area; it goes to "Sin área".
      const [area] = old.area_id
        ? await tx`select id from dining_areas where id=${old.area_id} and archived_at is null for share`
        : [];
      const areaId = area ? old.area_id : null;
      [row] = await tx<
        TableRow[]
      >`update dining_tables set archived_at=null,area_id=${areaId},
        position=${old.archived_at ? await nextTablePosition(tx, areaId) : old.position},version=version+1
        where id=${p.id} returning *`;
    }
    await audit(tx, s, "floor.table.archived", p.id, { archived: p.archived });
    return toTable(row, (await tablesWithOpenChecks(tx, [p.id])).has(p.id));
  });
}
