// Menu editor: categories, products, reusable modifier groups and availability.
// Every mutation runs inside once() (idempotent replay first), then
// requireSelling(), then bumpMenuRevision(), whose menu_state row lock
// serializes all menu writes of a tenant. Lock order inside a menu write:
// menu_state → modifier_groups → menu_categories → catalog (order by id).
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Tx } from "./db.js";
import { audit, once } from "./orders.js";
import { menuRevision } from "./menu-read.js";
import { negativeStockPolicy } from "./stock.js";
import { entitlement, requirePro } from "./entitlements.js";
import { requireSelling } from "./free-limits.js";
import { assertProductFiscalAllowed } from "./fiscal.js";
import { managers, permit } from "./auth.js";
import {
  DomainError,
  type Group,
  type Label,
  type Option,
  type Product,
  type Session,
} from "../shared/domain.js";
import {
  MENU_LIMITS,
  type MenuCategory,
  type MenuEditorPayload,
  type MenuGroup,
  type RecipeLine,
} from "../shared/menu.js";
import {
  archiveInput,
  availabilityInput,
  categoryInput,
  groupInput,
  legacyProductInput,
  optionAvailabilityInput,
  productInput,
  reorderInput,
} from "../shared/menu-schema.js";
import type { ProductFiscal } from "../shared/tax.js";

type CategoryRow = {
  id: string;
  name_es: string;
  name_en: string;
  position: number;
  version: number;
  archived_at: Date | null;
};
type GroupData = {
  name: Label;
  min: number;
  max: number;
  repeat: boolean;
  options: Option[];
};
type GroupRow = {
  id: string;
  version: number;
  archived_at: Date | null;
  data: GroupData;
};
/** Normalized product command shared by the editor and the legacy adapter. */
type ProductDraft = {
  id: string;
  expectedVersion: number;
  name: Label;
  categoryId: string;
  kind: "item" | "combo";
  price: number;
  openAmount: boolean;
  openMax: number | null;
  station: "kitchen" | "bar";
  available: boolean;
  groupIds: string[];
  recipe: RecipeLine[];
  cost: number | null;
  /** fiscal (027): absent keeps the stored value (legacy saves, imports). */
  fiscal?: ProductFiscal;
  /** kiosk (039): absent keeps the stored value. */
  description?: { es: string; en: string };
};

const json = (value: unknown) => JSON.stringify(value);

/** Increments the tenant's menu revision; its row lock serializes menu writes. */
export async function bumpMenuRevision(tx: Tx): Promise<number> {
  const [r] =
    await tx`insert into menu_state(tenant_id,revision) values(current_setting('app.tenant_id')::uuid,1)
      on conflict(tenant_id) do update set revision=menu_state.revision+1,updated_at=now()
      returning revision`;
  return Number(r.revision);
}

function toCategory(r: CategoryRow, productCount = 0): MenuCategory {
  return {
    id: r.id,
    name: { es: r.name_es, en: r.name_en },
    position: r.position,
    version: r.version,
    archived: r.archived_at !== null,
    productCount,
  };
}
function toGroup(r: GroupRow, usedBy: string[] = []): MenuGroup {
  return {
    id: r.id,
    name: r.data.name,
    min: r.data.min,
    max: r.data.max,
    repeat: !!r.data.repeat,
    options: r.data.options,
    version: r.version,
    archived: r.archived_at !== null,
    usedBy,
  };
}

async function activeCount(
  tx: Tx,
  table: "menu_categories" | "modifier_groups",
): Promise<number> {
  const [r] =
    table === "menu_categories"
      ? await tx`select count(*)::int as n from menu_categories where archived_at is null`
      : await tx`select count(*)::int as n from modifier_groups where archived_at is null`;
  return r.n;
}
export async function activeProducts(tx: Tx): Promise<number> {
  const [r] =
    await tx`select count(*)::int as n from catalog where not coalesce((data->>'archived')::boolean,false)`;
  return r.n;
}
async function nextCategoryPosition(tx: Tx): Promise<number> {
  const [r] =
    await tx`select coalesce(max(position),0)+1 as n from menu_categories`;
  return r.n;
}
async function nextProductPosition(tx: Tx, categoryId: string) {
  const [r] =
    await tx`select coalesce(max((data->>'position')::int),0)+1 as n from catalog where data->>'categoryId'=${categoryId}`;
  return r.n as number;
}
async function duplicateCategory(tx: Tx, name: string, except: string) {
  const [r] =
    await tx`select 1 from menu_categories where archived_at is null and lower(name_es)=lower(${name}) and id<>${except}`;
  return !!r;
}
/** Locks catalog rows matching a condition in id order before bulk updates. */
async function lockProductsInCategory(tx: Tx, categoryIds: string[]) {
  return tx<{ id: string; data: Product }[]>`select id,data from catalog
    where data->>'categoryId'=any(${tx.array(categoryIds)}::text[]) order by id for update`;
}
async function lockProductsUsingGroup(tx: Tx, groupId: string) {
  return tx<{ id: string; data: Product }[]>`select id,data from catalog
    where data->'groupIds' @> jsonb_build_array(${groupId}::text) order by id for update`;
}

/** One recipe: at most 30 lines, each stock item once, quantity > 0. */
function checkRecipeShape(recipe: RecipeLine[]) {
  const ids = recipe.map((r) => r.stockId);
  if (
    recipe.length > MENU_LIMITS.recipeLines ||
    new Set(ids).size !== ids.length ||
    recipe.some((r) => !new Decimal(r.quantity).gt(0))
  )
    throw new DomainError("invalid_recipe");
}
/** Every listed stock item exists and is not archived (one query). */
async function requireActiveStock(tx: Tx, stockIds: string[]) {
  const ids = [...new Set(stockIds)];
  if (!ids.length) return;
  const found =
    await tx`select id from stock_items where id=any(${tx.array(ids)}::uuid[]) and archived_at is null`;
  if (found.length !== ids.length) throw new DomainError("invalid_recipe");
}
/** Recipe lines must name distinct, active stock items with quantity > 0. */
export async function validateRecipe(tx: Tx, recipe: RecipeLine[]) {
  if (!recipe.length) return;
  checkRecipeShape(recipe);
  await requireActiveStock(
    tx,
    recipe.map((r) => r.stockId),
  );
}
/**
 * Every choice recipe must be valid and name only active stock items, so a
 * group that is saved, restored or linked can never make a sale deduct an
 * archived ingredient (archived items leave Existencias and recipe pickers).
 */
async function validateOptionRecipes(
  tx: Tx,
  options: { recipe?: RecipeLine[] }[],
) {
  const recipes = options.map((o) => o.recipe ?? []).filter((r) => r.length);
  for (const recipe of recipes) checkRecipeShape(recipe);
  await requireActiveStock(
    tx,
    recipes.flat().map((r) => r.stockId),
  );
}

/** Loads active groups in the order given; a missing one is invalid_group. */
export async function compileGroups(tx: Tx, ids: string[]): Promise<Group[]> {
  if (!ids.length) return [];
  const rows = await tx<
    GroupRow[]
  >`select id,version,archived_at,data from modifier_groups where id=any(${tx.array(ids)}::uuid[]) and archived_at is null`;
  return ids.map((id) => {
    const r = rows.find((g) => g.id === id);
    if (!r) throw new DomainError("invalid_group");
    return compiledGroup(r);
  });
}
function compiledGroup(r: GroupRow): Group {
  return {
    id: r.id,
    version: r.version,
    name: r.data.name,
    min: r.data.min,
    max: r.data.max,
    repeat: !!r.data.repeat,
    options: r.data.options,
  };
}
/** Product-level rules over its compiled groups. */
function checkProductGroups(kind: string | undefined, groups: Group[]) {
  if (groups.length > MENU_LIMITS.groupsPerProduct)
    throw new DomainError("invalid_group");
  if (groups.reduce((a, g) => a + g.max, 0) > MENU_LIMITS.choicesPerLine)
    throw new DomainError("invalid_group");
  if (kind === "combo" && !groups.some((g) => g.min >= 1))
    throw new DomainError("combo_requires_choice");
}
async function recordRecipeVersion(tx: Tx, s: Session, p: Product) {
  await tx`insert into recipe_versions(tenant_id,id,product_id,version,data) values(${s.tenantId},${randomUUID()},${p.id},${p.version},${tx.json(
    {
      recipe: p.recipe ?? [],
      cost: p.cost,
      groups: p.groups.map((g) => ({ id: g.id, version: g.version ?? 1 })),
    } as never,
  )})`;
}
async function writeDoc(tx: Tx, s: Session, data: Product) {
  await tx`insert into catalog(tenant_id,id,data) values(${s.tenantId},${data.id},${tx.json(data as never)})
    on conflict(tenant_id,id) do update set data=excluded.data`;
}

/** Editor payload for managers: everything including archived records. */
export async function menuEditor(
  tx: Tx,
  s: Session,
): Promise<MenuEditorPayload> {
  permit(s, managers);
  const categories = await tx<
    CategoryRow[]
  >`select * from menu_categories order by position,name_es,id`;
  const counts =
    await tx`select data->>'categoryId' as id,count(*)::int as n from catalog
      where not coalesce((data->>'archived')::boolean,false) group by 1`;
  const products = (
    await tx`select data from catalog
      order by coalesce((data->>'categoryPosition')::int,2147483647),data->'category'->>'es',
               coalesce((data->>'position')::int,2147483647),data->'name'->>'es',id`
  ).map((r) => r.data as Product);
  const groups = await tx<
    GroupRow[]
  >`select id,version,archived_at,data from modifier_groups order by archived_at nulls first,data->'name'->>'es',id`;
  const stockItems =
    await tx`select id,name,unit,kind,archived_at is not null as archived from stock_items order by name,id`;
  return {
    categories: categories.map((c) =>
      toCategory(c, counts.find((r) => r.id === c.id)?.n ?? 0),
    ),
    products,
    groups: groups.map((g) =>
      toGroup(
        g,
        products.filter((p) => p.groupIds?.includes(g.id)).map((p) => p.id),
      ),
    ),
    stockItems: stockItems.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      kind: i.kind,
      archived: i.archived,
    })),
    policy: await negativeStockPolicy(tx),
    plan: (await entitlement(tx)).plan,
    revision: (await menuRevision(tx)).revision,
  };
}

// ---------------------------------------------------------------- categories

/** Active category with this Spanish name (case-insensitive), or a new one. */
export async function findOrCreateCategory(
  tx: Tx,
  s: Session,
  label: Label,
): Promise<MenuCategory> {
  await bumpMenuRevision(tx);
  const es = label.es.trim().slice(0, 200) || "General";
  const en = label.en.trim().slice(0, 200) || es;
  const [found] = await tx<
    CategoryRow[]
  >`select * from menu_categories where archived_at is null and lower(name_es)=lower(${es}) order by position limit 1 for share`;
  if (found) return toCategory(found);
  if ((await activeCount(tx, "menu_categories")) >= MENU_LIMITS.categories)
    throw new DomainError("menu_limit", 409);
  const [row] = await tx<
    CategoryRow[]
  >`insert into menu_categories(tenant_id,id,name_es,name_en,position) values(${s.tenantId},${randomUUID()},${es},${en},${await nextCategoryPosition(tx)}) returning *`;
  await audit(tx, s, "menu.category.saved", row.id, {
    before: null,
    after: { name: { es, en } },
  });
  return toCategory(row);
}

export async function saveCategory(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = categoryInput.parse(raw);
  return once(tx, s, p.operationId, "menu.category.save", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    const [old] = await tx<
      CategoryRow[]
    >`select * from menu_categories where id=${p.id} for update`;
    if ((old?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    if (
      (!old || !old.archived_at) &&
      (await duplicateCategory(tx, p.name.es, p.id))
    )
      throw new DomainError("duplicate_name", 409);
    let row: CategoryRow;
    if (!old) {
      if ((await activeCount(tx, "menu_categories")) >= MENU_LIMITS.categories)
        throw new DomainError("menu_limit", 409);
      [row] = await tx<
        CategoryRow[]
      >`insert into menu_categories(tenant_id,id,name_es,name_en,position) values(${s.tenantId},${p.id},${p.name.es},${p.name.en},${await nextCategoryPosition(tx)}) returning *`;
    } else {
      [row] = await tx<
        CategoryRow[]
      >`update menu_categories set name_es=${p.name.es},name_en=${p.name.en},version=version+1 where id=${p.id} returning *`;
      // A label rename is not priced content: product versions do not change.
      await lockProductsInCategory(tx, [p.id]);
      await tx`update catalog set data=data||jsonb_build_object('category',${tx.json(p.name)}::jsonb)
        where data->>'categoryId'=${p.id}`;
    }
    await audit(tx, s, "menu.category.saved", p.id, {
      before: old ? { es: old.name_es, en: old.name_en } : null,
      after: p.name,
    });
    const [count] =
      await tx`select count(*)::int as n from catalog where data->>'categoryId'=${p.id} and not coalesce((data->>'archived')::boolean,false)`;
    return toCategory(row, count.n);
  });
}

export async function reorderCategories(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = reorderInput.parse(raw);
  return once(tx, s, p.operationId, "menu.category.reorder", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    const active =
      await tx`select id from menu_categories where archived_at is null order by id for update`;
    if (
      new Set(p.ids).size !== p.ids.length ||
      p.ids.length !== active.length ||
      !active.every((c) => p.ids.includes(c.id))
    )
      throw new DomainError("menu_changed", 409);
    await tx`update menu_categories c set position=x.pos::int
      from unnest(${tx.array(p.ids)}::uuid[]) with ordinality as x(id,pos) where c.id=x.id`;
    await lockProductsInCategory(tx, p.ids);
    await tx`update catalog k set data=k.data||jsonb_build_object('categoryPosition',x.pos::int)
      from unnest(${tx.array(p.ids)}::uuid[]) with ordinality as x(id,pos)
      where k.data->>'categoryId'=x.id::text`;
    await audit(tx, s, "menu.category.reordered", s.tenantId, { ids: p.ids });
    return { ok: true };
  });
}

export async function archiveCategory(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = archiveInput.parse(raw);
  return once(tx, s, p.operationId, "menu.category.archive", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    const [old] = await tx<
      CategoryRow[]
    >`select * from menu_categories where id=${p.id} for update`;
    if (!old || old.version !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    let row: CategoryRow;
    if (p.archived) {
      const [inUse] =
        await tx`select 1 from catalog where data->>'categoryId'=${p.id} and not coalesce((data->>'archived')::boolean,false) limit 1`;
      if (inUse) throw new DomainError("category_in_use", 409);
      [row] = await tx<
        CategoryRow[]
      >`update menu_categories set archived_at=coalesce(archived_at,now()),version=version+1 where id=${p.id} returning *`;
    } else {
      if (old.archived_at) {
        if (await duplicateCategory(tx, old.name_es, p.id))
          throw new DomainError("duplicate_name", 409);
        if (
          (await activeCount(tx, "menu_categories")) >= MENU_LIMITS.categories
        )
          throw new DomainError("menu_limit", 409);
      }
      [row] = await tx<
        CategoryRow[]
      >`update menu_categories set archived_at=null,position=${old.archived_at ? await nextCategoryPosition(tx) : old.position},version=version+1 where id=${p.id} returning *`;
      await lockProductsInCategory(tx, [p.id]);
      await tx`update catalog set data=data||jsonb_build_object('categoryPosition',${row.position}::int) where data->>'categoryId'=${p.id}`;
    }
    await audit(tx, s, "menu.category.archived", p.id, {
      archived: p.archived,
    });
    return toCategory(row);
  });
}

// ------------------------------------------------------------------ products

/**
 * Validates and writes one product document. `keepAvailability` keeps the
 * live availability of an existing product (the editor never changes it).
 */
async function writeProduct(
  tx: Tx,
  s: Session,
  p: ProductDraft,
  keepAvailability: boolean,
): Promise<Product> {
  const groups = p.groupIds.length
    ? await tx<
        GroupRow[]
      >`select id,version,archived_at,data from modifier_groups where id=any(${tx.array(p.groupIds)}::uuid[]) and archived_at is null order by id for share`
    : [];
  if (groups.length !== p.groupIds.length)
    throw new DomainError("invalid_group");
  const [category] = await tx<
    CategoryRow[]
  >`select * from menu_categories where id=${p.categoryId} for share`;
  if (!category || category.archived_at)
    throw new DomainError("invalid_category");
  const [old] = await tx<
    { data: Product }[]
  >`select data from catalog where id=${p.id} for update`;
  if ((old?.data.version ?? 0) !== p.expectedVersion)
    throw new DomainError("menu_changed", 409);
  if (!old && (await activeProducts(tx)) >= MENU_LIMITS.products)
    throw new DomainError("menu_limit", 409);
  const compiled = p.groupIds.map((id) =>
    compiledGroup(groups.find((g) => g.id === id)!),
  );
  checkProductGroups(p.kind, compiled);
  await validateRecipe(tx, p.recipe);
  await validateOptionRecipes(
    tx,
    compiled.flatMap((g) => g.options),
  );
  if (
    json(old?.data.recipe ?? []) !== json(p.recipe) ||
    (old?.data.cost ?? null) !== p.cost
  )
    await requirePro(tx);
  const archived = old?.data.archived ?? false;
  const data: Product = {
    ...(old?.data ?? {}),
    id: p.id,
    name: p.name,
    categoryId: category.id,
    category: { es: category.name_es, en: category.name_en },
    categoryPosition: category.position,
    position:
      old && old.data.categoryId === category.id && old.data.position
        ? old.data.position
        : await nextProductPosition(tx, category.id),
    kind: p.kind,
    price: p.openAmount ? 0 : p.price,
    openAmount: p.openAmount,
    openMax: p.openAmount ? p.openMax : null,
    station: p.station,
    available: archived
      ? false
      : old && keepAvailability
        ? old.data.available
        : p.available,
    archived,
    groupIds: p.groupIds,
    groups: compiled,
    recipe: p.recipe,
    cost: p.cost,
    ...(p.fiscal !== undefined ? { fiscal: p.fiscal } : {}),
    // kiosk (039): the description is saved here; the photo only by the photo commands (the
    // spread of the old document keeps it).
    ...(p.description !== undefined ? { description: p.description } : {}),
    version: p.expectedVersion + 1,
  };
  await writeDoc(tx, s, data);
  await recordRecipeVersion(tx, s, data);
  await audit(tx, s, "menu.product.saved", p.id, {
    version: data.version,
    price: data.price,
    openMax: data.openMax,
    groupIds: data.groupIds,
    taxCategory: p.fiscal?.taxCategory,
  });
  return data;
}

export async function saveMenuProduct(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = productInput.parse(raw);
  return once(tx, s, p.operationId, "menu.product.save", p, async () => {
    await requireSelling(tx, s);
    // The menu_state row first: a fiscal profile save that leaves the border region takes it
    // before counting IVA 8% products, so the two checks cannot pass each other
    // (FISCAL-CONCURRENCY-3).
    await bumpMenuRevision(tx);
    if (p.fiscal !== undefined) await assertProductFiscalAllowed(tx, p.fiscal);
    return writeProduct(tx, s, p, true);
  });
}

/**
 * POST /catalog/save from clients of the previous revision. The category label
 * becomes a category; groups, kind and open price are kept from the saved doc.
 * Keeps the legacy operation kind so earlier replays still match.
 */
export async function saveLegacyProduct(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = legacyProductInput.parse(raw);
  return once(tx, s, p.operationId, "catalog.save", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    const category = await findOrCreateCategory(tx, s, p.category);
    const [old] = await tx<
      { data: Product }[]
    >`select data from catalog where id=${p.id}`;
    const openAmount = old?.data.openAmount ?? false;
    return writeProduct(
      tx,
      s,
      {
        id: p.id,
        expectedVersion: p.expectedVersion,
        name: { es: p.name.es.trim(), en: p.name.en.trim() || p.name.es },
        categoryId: category.id,
        kind: old?.data.kind ?? "item",
        price: openAmount ? 0 : p.price,
        openAmount,
        openMax: openAmount ? (old?.data.openMax ?? null) : null,
        station: p.station,
        // The legacy form edits availability explicitly; honour it.
        available: p.available,
        groupIds: old?.data.groupIds ?? [],
        recipe: p.recipe.map((r) => ({
          stockId: r.stockId,
          quantity: r.quantity,
        })),
        cost: p.cost,
      },
      false,
    );
  });
}

export async function reorderProducts(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = reorderInput.parse(raw);
  return once(tx, s, p.operationId, "menu.product.reorder", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    if (!p.scopeId) throw new DomainError("invalid_category");
    const docs = (await lockProductsInCategory(tx, [p.scopeId])).filter(
      (r) => !r.data.archived,
    );
    if (
      new Set(p.ids).size !== p.ids.length ||
      p.ids.length !== docs.length ||
      !docs.every((d) => p.ids.includes(d.id))
    )
      throw new DomainError("menu_changed", 409);
    await tx`update catalog k set data=k.data||jsonb_build_object('position',x.pos::int)
      from unnest(${tx.array(p.ids)}::uuid[]) with ordinality as x(id,pos) where k.id=x.id`;
    await audit(tx, s, "menu.product.reordered", p.scopeId, { ids: p.ids });
    return { ok: true };
  });
}

export async function archiveProduct(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = archiveInput.parse(raw);
  return once(tx, s, p.operationId, "menu.product.archive", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    let category: CategoryRow | undefined;
    if (!p.archived) {
      const [doc] = await tx<
        { data: Product }[]
      >`select data from catalog where id=${p.id}`;
      [category] = doc?.data.categoryId
        ? await tx<
            CategoryRow[]
          >`select * from menu_categories where id=${doc.data.categoryId} for share`
        : [];
    }
    const [old] = await tx<
      { data: Product }[]
    >`select data from catalog where id=${p.id} for update`;
    if (!old || old.data.version !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    let data: Product;
    if (p.archived) {
      // available=false too, so the previous revision also refuses it.
      data = {
        ...old.data,
        archived: true,
        available: false,
        version: old.data.version + 1,
      };
    } else {
      if (!category || category.archived_at)
        throw new DomainError("invalid_category");
      if (
        old.data.archived &&
        (await activeProducts(tx)) >= MENU_LIMITS.products
      )
        throw new DomainError("menu_limit", 409);
      checkProductGroups(old.data.kind, old.data.groups);
      await validateRecipe(tx, old.data.recipe ?? []);
      // LD-28: a restored product meets the tax rule a save does (IVA 8% needs a border
      // region; fiscal owns the check). menu_state was taken above, so a profile save that
      // leaves the border region either counts this product or this restore reads the
      // general region (FISCAL-CONCURRENCY-3).
      if (old.data.archived)
        await assertProductFiscalAllowed(tx, old.data.fiscal);
      data = {
        ...old.data,
        archived: false,
        available: true,
        category: { es: category.name_es, en: category.name_en },
        categoryPosition: category.position,
        position: old.data.archived
          ? await nextProductPosition(tx, category.id)
          : old.data.position,
        version: old.data.version + 1,
      };
    }
    await writeDoc(tx, s, data);
    await recordRecipeVersion(tx, s, data);
    await audit(tx, s, "menu.product.archived", p.id, {
      archived: p.archived,
      version: data.version,
    });
    return data;
  });
}

/** Live "86" state: last write wins, no version bump (§3.3). */
export async function setProductAvailability(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = availabilityInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "menu.product.availability",
    p,
    async () => {
      await requireSelling(tx, s);
      await bumpMenuRevision(tx);
      const [old] = await tx<
        { data: Product }[]
      >`select data from catalog where id=${p.id} for update`;
      if (!old || old.data.archived) throw new DomainError("not_found", 404);
      const [row] = await tx<
        { data: Product }[]
      >`update catalog set data=jsonb_set(data,'{available}',to_jsonb(${p.available}::boolean)) where id=${p.id} returning data`;
      await audit(tx, s, "menu.product.availability", p.id, {
        before: old.data.available,
        after: p.available,
      });
      return row.data;
    },
  );
}

// -------------------------------------------------------------------- groups

/** Rewrites the compiled groups of every product linked to a group. */
async function recompileLinked(
  tx: Tx,
  s: Session,
  groupId: string,
  bumpVersions: boolean,
  unlink = false,
): Promise<number> {
  const docs = await lockProductsUsingGroup(tx, groupId);
  for (const doc of docs) {
    const groupIds = unlink
      ? (doc.data.groupIds ?? []).filter((id) => id !== groupId)
      : (doc.data.groupIds ?? []);
    const groups = await compileGroups(tx, groupIds);
    if (bumpVersions && !unlink) checkProductGroups(doc.data.kind, groups);
    // Unlinking must not leave an active combo without a required choice; an
    // archived one is checked again when it is restored.
    if (
      unlink &&
      !doc.data.archived &&
      doc.data.kind === "combo" &&
      !groups.some((g) => g.min >= 1)
    )
      throw new DomainError("combo_requires_choice");
    const data: Product = {
      ...doc.data,
      groupIds,
      groups,
      version: bumpVersions ? doc.data.version + 1 : doc.data.version,
    };
    await writeDoc(tx, s, data);
    if (bumpVersions) await recordRecipeVersion(tx, s, data);
  }
  return docs.length;
}

export async function saveGroup(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = groupInput.parse(raw);
  return once(tx, s, p.operationId, "menu.group.save", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    const [old] = await tx<
      GroupRow[]
    >`select id,version,archived_at,data from modifier_groups where id=${p.id} for update`;
    if ((old?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    if (
      !old &&
      (await activeCount(tx, "modifier_groups")) >= MENU_LIMITS.groups
    )
      throw new DomainError("menu_limit", 409);
    const optionIds = p.options.map((o) => o.id);
    const [collision] =
      await tx`select 1 from modifier_groups g, jsonb_array_elements(g.data->'options') o
        where g.id<>${p.id} and o->>'id'=any(${tx.array(optionIds)}::text[]) limit 1`;
    if (collision) throw new DomainError("invalid_group");
    await validateOptionRecipes(tx, p.options);
    const before = old?.data.options ?? [];
    if (
      p.options.some((o) => {
        const prior = before.find((b) => b.id === o.id);
        return (
          json(prior?.recipe ?? []) !== json(o.recipe) ||
          (prior?.cost ?? null) !== o.cost
        );
      })
    )
      await requirePro(tx);
    const data: GroupData = {
      name: p.name,
      min: p.min,
      max: p.max,
      repeat: p.repeat,
      options: p.options.map((o) => ({
        id: o.id,
        name: o.name,
        price: o.price,
        available: before.find((b) => b.id === o.id)?.available ?? true,
        cost: o.cost,
        recipe: o.recipe,
      })),
    };
    const [row] = await tx<
      GroupRow[]
    >`insert into modifier_groups(tenant_id,id,data,version)
      values(${s.tenantId},${p.id},${tx.json(data as never)},${p.expectedVersion + 1})
      on conflict(tenant_id,id) do update set data=excluded.data,version=excluded.version
      returning id,version,archived_at,data`;
    const recompiled = row.archived_at
      ? 0
      : await recompileLinked(tx, s, p.id, true);
    await audit(tx, s, "menu.group.saved", p.id, {
      version: row.version,
      recompiled,
    });
    const usedBy =
      await tx`select id from catalog where data->'groupIds' @> jsonb_build_array(${p.id}::text) order by id`;
    return {
      group: toGroup(
        row,
        usedBy.map((r) => r.id),
      ),
      recompiled,
    };
  });
}

export async function archiveGroup(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = archiveInput.parse(raw);
  return once(tx, s, p.operationId, "menu.group.archive", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    const [old] = await tx<
      GroupRow[]
    >`select id,version,archived_at,data from modifier_groups where id=${p.id} for update`;
    if (!old || old.version !== p.expectedVersion)
      throw new DomainError("menu_changed", 409);
    let unlinked = 0;
    if (p.archived) {
      await tx`update modifier_groups set archived_at=coalesce(archived_at,now()),version=version+1 where id=${p.id}`;
      // D10: unlinked from every product; past order lines keep their snapshot.
      unlinked = await recompileLinked(tx, s, p.id, true, true);
    } else {
      if (
        old.archived_at &&
        (await activeCount(tx, "modifier_groups")) >= MENU_LIMITS.groups
      )
        throw new DomainError("menu_limit", 409);
      // An ingredient may have been archived while this group was archived
      // (archived groups do not block that); restoring must not bring back a
      // choice that deducts it. Restore the ingredient first.
      if (old.archived_at) await validateOptionRecipes(tx, old.data.options);
      await tx`update modifier_groups set archived_at=null,version=version+1 where id=${p.id}`;
    }
    const [row] = await tx<
      GroupRow[]
    >`select id,version,archived_at,data from modifier_groups where id=${p.id}`;
    await audit(tx, s, "menu.group.archived", p.id, {
      archived: p.archived,
      unlinked,
    });
    return { group: toGroup(row), unlinked };
  });
}

/** Live "86" state of one choice; product versions do not change. */
export async function setOptionAvailability(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = optionAvailabilityInput.parse(raw);
  return once(tx, s, p.operationId, "menu.option.availability", p, async () => {
    await requireSelling(tx, s);
    await bumpMenuRevision(tx);
    const [old] = await tx<
      GroupRow[]
    >`select id,version,archived_at,data from modifier_groups where id=${p.groupId} for update`;
    const option = old?.data.options.find((o) => o.id === p.optionId);
    if (!old || old.archived_at || !option)
      throw new DomainError("not_found", 404);
    const data: GroupData = {
      ...old.data,
      options: old.data.options.map((o) =>
        o.id === p.optionId ? { ...o, available: p.available } : o,
      ),
    };
    const [row] = await tx<
      GroupRow[]
    >`update modifier_groups set data=${tx.json(data as never)} where id=${p.groupId} returning id,version,archived_at,data`;
    await recompileLinked(tx, s, p.groupId, false);
    await audit(tx, s, "menu.option.availability", p.optionId, {
      groupId: p.groupId,
      before: option.available,
      after: p.available,
    });
    const usedBy =
      await tx`select id from catalog where data->'groupIds' @> jsonb_build_array(${p.groupId}::text) order by id`;
    return toGroup(
      row,
      usedBy.map((r) => r.id),
    );
  });
}
