// Stock item setup (FIT-5), the negative-stock policy and paginated history.
import { Decimal } from "decimal.js";
import type { Tx } from "./db.js";
import { audit, once } from "./orders.js";
import { negativeStockPolicy, stock } from "./stock.js";
import { bumpMenuRevision } from "./menu.js";
import { requirePro } from "./entitlements.js";
import { requireSelling } from "./free-limits.js";
import { managers, permit } from "./auth.js";
import { DomainError, id, type Session } from "../shared/domain.js";
import {
  MENU_LIMITS,
  type StockItem,
  type StockMovement,
} from "../shared/menu.js";
import {
  archiveInput,
  movementsQuery,
  stockItemInput,
  stockPolicyInput,
} from "../shared/menu-schema.js";

type ItemRow = {
  id: string;
  name: string;
  unit: string;
  kind: string;
  threshold: string;
  par_level: string | null;
  on_hand: string;
  negative_since: Date | null;
  settings_version: number;
  archived_at: Date | null;
  has_movements: boolean;
};
type Usage = { products: string[]; options: string[] };

const itemColumns = (
  tx: Tx,
) => tx`i.id,i.name,i.unit,i.kind,i.threshold::text as threshold,
  i.par_level::text as par_level,i.on_hand::text as on_hand,i.negative_since,i.settings_version,i.archived_at,
  exists(select 1 from stock_movements m where m.tenant_id=i.tenant_id and m.stock_id=i.id) as has_movements`;

function toItem(r: ItemRow, usedBy: Usage): StockItem {
  return {
    id: r.id,
    name: r.name,
    unit: r.unit,
    kind: r.kind,
    threshold: r.threshold,
    parLevel: r.par_level,
    onHand: r.on_hand,
    negativeSince: r.negative_since?.toISOString() ?? null,
    settingsVersion: r.settings_version,
    archived: r.archived_at !== null,
    hasMovements: r.has_movements,
    usedBy,
  };
}

/**
 * Names of recipes that reference each stock item. `active` covers only
 * active products and groups (archive check, display); otherwise archived
 * ones count too (unit lock: a restored recipe must keep its meaning).
 */
async function recipeUsage(
  tx: Tx,
  active: boolean,
): Promise<Map<string, Usage>> {
  const products =
    await tx`select data->'name'->>'es' as name,data->'recipe' as recipe from catalog
    ${active ? tx`where not coalesce((data->>'archived')::boolean,false)` : tx``}`;
  const options =
    await tx`select g.data->'name'->>'es' as group_name,o->'name'->>'es' as name,o->'recipe' as recipe
    from modifier_groups g cross join jsonb_array_elements(g.data->'options') o
    ${active ? tx`where g.archived_at is null` : tx``}`;
  const usage = new Map<string, Usage>();
  const entry = (stockId: string) => {
    if (!usage.has(stockId)) usage.set(stockId, { products: [], options: [] });
    return usage.get(stockId)!;
  };
  for (const p of products)
    for (const line of (p.recipe ?? []) as { stockId: string }[])
      entry(line.stockId).products.push(p.name);
  for (const o of options)
    for (const line of (o.recipe ?? []) as { stockId: string }[])
      entry(line.stockId).options.push(`${o.group_name}: ${o.name}`);
  return usage;
}
const noUsage = (): Usage => ({ products: [], options: [] });
const used = (u: Usage | undefined) =>
  !!u && (u.products.length > 0 || u.options.length > 0);

async function lockStockSetup(tx: Tx) {
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':stock-items',0))`;
}
async function loadItem(tx: Tx, stockId: string) {
  const [row] = await tx<
    ItemRow[]
  >`select ${itemColumns(tx)} from stock_items i where i.id=${stockId}`;
  return row as ItemRow | undefined;
}
/** loadItem under the row lock (LO-9); a separate function so the lock-order scan sees exactly where it is taken. */
async function lockItem(tx: Tx, stockId: string) {
  const [row] = await tx<
    ItemRow[]
  >`select ${itemColumns(tx)} from stock_items i where i.id=${stockId} for update of i`;
  return row as ItemRow | undefined;
}
async function duplicateName(tx: Tx, name: string, except: string) {
  const [r] =
    await tx`select 1 from stock_items where archived_at is null and lower(name)=lower(${name}) and id<>${except}`;
  return !!r;
}
async function activeItems(tx: Tx) {
  const [r] =
    await tx`select count(*)::int as n from stock_items where archived_at is null`;
  return r.n as number;
}

export async function listStockItems(tx: Tx, s: Session) {
  permit(s, managers);
  const rows = await tx<
    ItemRow[]
  >`select ${itemColumns(tx)} from stock_items i order by i.archived_at nulls first,lower(i.name),i.id`;
  const usage = await recipeUsage(tx, true);
  return {
    policy: await negativeStockPolicy(tx),
    items: rows.map((r) => toItem(r, usage.get(r.id) ?? noUsage())),
  };
}

export async function saveStockItem(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = stockItemInput.parse(raw);
  return once(tx, s, p.operationId, "stock.item.save", p, async () => {
    await requireSelling(tx, s);
    await requirePro(tx);
    await lockStockSetup(tx);
    // A unit change decides from recipe usage, so it must not race a menu
    // save that links this item with quantities in the old unit: take the
    // menu_state lock first, in the same order as archiveStockItem. Stock-item
    // saves serialize on lockStockSetup, so the unit peeked here is stable.
    const current = await loadItem(tx, p.id);
    if (current && current.unit !== p.unit) await bumpMenuRevision(tx);
    const old = await lockItem(tx, p.id);
    if ((old?.settings_version ?? 0) !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    if (old && p.openingQuantity !== null)
      throw new DomainError("invalid_quantity");
    if ((!old || !old.archived_at) && (await duplicateName(tx, p.name, p.id)))
      throw new DomainError("duplicate_name", 409);
    if (old && old.unit !== p.unit) {
      const usage = await recipeUsage(tx, false);
      if (old.has_movements || used(usage.get(p.id)))
        throw new DomainError("unit_locked", 409);
    }
    if (!old) {
      if ((await activeItems(tx)) >= MENU_LIMITS.stockItems)
        throw new DomainError("menu_limit", 409);
      await tx`insert into stock_items(tenant_id,id,name,unit,kind,threshold,par_level)
        values(${s.tenantId},${p.id},${p.name},${p.unit},${p.kind},${p.threshold},${p.parLevel})`;
      if (p.openingQuantity !== null && new Decimal(p.openingQuantity).gt(0))
        await stock(
          tx,
          s,
          p.id,
          p.openingQuantity,
          "opening",
          p.id,
          "Existencia inicial",
          "allow",
        );
    } else
      await tx`update stock_items set name=${p.name},unit=${p.unit},kind=${p.kind},threshold=${p.threshold},
        par_level=${p.parLevel},settings_version=settings_version+1 where id=${p.id}`;
    const row = (await loadItem(tx, p.id))!;
    await audit(tx, s, "stock.item.saved", p.id, {
      before: old
        ? {
            name: old.name,
            unit: old.unit,
            kind: old.kind,
            threshold: old.threshold,
            parLevel: old.par_level,
          }
        : null,
      after: {
        name: p.name,
        unit: p.unit,
        kind: p.kind,
        threshold: p.threshold,
        parLevel: p.parLevel,
        openingQuantity: p.openingQuantity,
      },
    });
    return toItem(row, (await recipeUsage(tx, true)).get(p.id) ?? noUsage());
  });
}

export async function archiveStockItem(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = archiveInput.parse(raw);
  return once(tx, s, p.operationId, "stock.item.archive", p, async () => {
    await requireSelling(tx, s);
    await lockStockSetup(tx);
    // Menu writes that add recipe links serialize on menu_state; take it too so
    // a recipe cannot link this item while it is being archived.
    await bumpMenuRevision(tx);
    const old = await lockItem(tx, p.id);
    if (!old || old.settings_version !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    const usage = await recipeUsage(tx, true);
    if (p.archived) {
      if (used(usage.get(p.id))) throw new DomainError("stock_in_use", 409);
      await tx`update stock_items set archived_at=coalesce(archived_at,now()),settings_version=settings_version+1 where id=${p.id}`;
    } else {
      if (old.archived_at) {
        if (await duplicateName(tx, old.name, p.id))
          throw new DomainError("duplicate_name", 409);
        if ((await activeItems(tx)) >= MENU_LIMITS.stockItems)
          throw new DomainError("menu_limit", 409);
      }
      await tx`update stock_items set archived_at=null,settings_version=settings_version+1 where id=${p.id}`;
    }
    await audit(tx, s, "stock.item.archived", p.id, {
      archived: p.archived,
      onHand: old.on_hand,
    });
    return toItem((await loadItem(tx, p.id))!, usage.get(p.id) ?? noUsage());
  });
}

/**
 * Opaque history cursor "<created_at>_<movement id>". The instant keeps
 * microseconds (a JS Date would truncate them and skip rows), and the id
 * breaks ties between movements of one transaction, which share now().
 */
function parseCursor(before: string | undefined) {
  if (!before) return null;
  const [at, movementId] = before.split("_");
  return { at, id: movementId ?? null };
}

export async function stockMovements(
  tx: Tx,
  s: Session,
  stockId: string,
  query: unknown,
): Promise<{ movements: StockMovement[]; next: string | null }> {
  permit(s, managers);
  id.parse(stockId);
  const q = movementsQuery.parse(query);
  const [item] = await tx`select id from stock_items where id=${stockId}`;
  if (!item) throw new DomainError("not_found", 404);
  const cursor = parseCursor(q.before);
  const rows =
    await tx`select m.id,m.quantity::text as quantity,m.balance_after::text as balance_after,
      m.cause,m.cause_id,m.reason,m.created_at,e.name as actor_name,
      to_char(m.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
    from stock_movements m left join employees e on e.tenant_id=m.tenant_id and e.id=m.actor_id
    where m.stock_id=${stockId}
      ${
        cursor
          ? cursor.id
            ? // ::text first: a timestamptz parameter would go through a JS Date
              // in postgres.js and lose its microseconds.
              tx`and (m.created_at,m.id)<(${cursor.at}::text::timestamptz,${cursor.id}::uuid)`
            : tx`and m.created_at<${cursor.at}::text::timestamptz`
          : tx``
      }
    order by m.created_at desc,m.id desc limit ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    movements: page.map((r) => ({
      id: r.id,
      quantity: r.quantity,
      balanceAfter: r.balance_after,
      cause: r.cause,
      causeId: r.cause_id,
      reason: r.reason,
      actorName: r.actor_name,
      createdAt: r.created_at.toISOString(),
    })),
    next: rows.length > q.limit && last ? `${last.cursor_at}_${last.id}` : null,
  };
}

/** Owner or manager; no selling gate (a safety policy is configuration recovery). */
export async function saveNegativeStockPolicy(
  tx: Tx,
  s: Session,
  raw: unknown,
) {
  permit(s, managers);
  const p = stockPolicyInput.parse(raw);
  return once(tx, s, p.operationId, "stock.policy", p, async () => {
    // LO-2 first (once() skips its FOR SHARE for this kind): two concurrent
    // saves queue here instead of deadlocking on an upgrade (P-18). FOR NO KEY
    // UPDATE leaves foreign-key checks on restaurants (KEY SHARE) unblocked
    // (PLATFORM-LOCKS-5).
    await tx`select id from restaurants where id=current_setting('app.tenant_id')::uuid for no key update`;
    const before = await negativeStockPolicy(tx);
    await tx`update restaurants set negative_stock_policy=${p.policy} where id=current_setting('app.tenant_id')::uuid`;
    await audit(tx, s, "stock.policy.changed", s.tenantId, {
      before,
      after: p.policy,
    });
    return { policy: p.policy };
  });
}
