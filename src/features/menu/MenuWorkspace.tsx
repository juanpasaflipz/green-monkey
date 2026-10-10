import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Locale, Product, Session } from "../../../shared/domain";
import type {
  MenuCategory,
  MenuEditorPayload,
  MenuGroup,
} from "../../../shared/menu";
import { api } from "../../api";
import { errorNotice, translateError } from "../../i18n";
import { Badge, Button, Empty, Modal } from "../../components/ui";
import { CategoryDialog } from "./CategoryDialog";
import { GroupEditor } from "./GroupEditor";
import { ProductEditor, type ProductPreset } from "./ProductEditor";
import { MenuMediaImport } from "./MenuMediaImport";
import {
  fiscalDraft,
  ProductFiscalFields,
} from "../fiscal/ProductFiscalFields";
import { withOptionAvailable, withProductAvailable } from "./availability";
import { groupRuleText, moneyFormatter, translator } from "./format";

type Tab = "products" | "categories" | "modifiers";
const tabs: [
  Tab,
  "menuTabProducts" | "menuTabCategories" | "menuTabModifiers",
][] = [
  ["products", "menuTabProducts"],
  ["categories", "menuTabCategories"],
  ["modifiers", "menuTabModifiers"],
];

/** A required group has fewer available choices than it needs. */
function requiredSoldOut(p: Product) {
  return p.groups.some(
    (g) =>
      g.min > 0 &&
      g.options.filter((o) => o.available).length < (g.repeat ? 1 : g.min),
  );
}
/** Active combos whose only required group is `groupId` (archive would strand them). */
function strandedCombos(products: Product[], groupId: string) {
  return products.filter(
    (p) =>
      !p.archived &&
      p.kind === "combo" &&
      (p.groupIds ?? []).includes(groupId) &&
      !p.groups.some((g) => g.id !== groupId && g.min >= 1),
  );
}
function swap<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + delta, 0, item);
  return next;
}

/** Menú → Productos / Categorías / Modificadores. */
export function MenuWorkspace({
  session,
  locale,
  online,
  navigate,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  navigate: (view: string) => void;
}) {
  const t = translator(locale);
  const money = moneyFormatter(locale, session.restaurant.currency);
  const [payload, setPayload] = useState<MenuEditorPayload | null>(null);
  const [tab, setTab] = useState<Tab>("products");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{
    key: string;
    product?: Product;
    duplicateOf?: Product;
    preset?: ProductPreset;
  } | null>(null);
  // "Nuevo producto" starts in the category last saved to (OWNER-13).
  const [lastCategory, setLastCategory] = useState<string | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<{
    category?: MenuCategory;
  } | null>(null);
  const [groupDialog, setGroupDialog] = useState<{ group?: MenuGroup } | null>(
    null,
  );
  const [archiveGroup, setArchiveGroup] = useState<MenuGroup | null>(null);
  const [importing, setImporting] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  // A reload applies only if nothing newer happened while it was in flight:
  // an older response must not undo a switch flipped (optimistically) since.
  const generation = useRef(0);
  async function load() {
    const mine = ++generation.current;
    try {
      const next = await api<MenuEditorPayload>("/menu");
      if (mine === generation.current) setPayload(next);
    } catch (e) {
      if (mine === generation.current) setError(errorNotice(e, locale));
    }
  }
  /** Optimistic local change; supersedes any reload already in flight. */
  function patch(update: (p: MenuEditorPayload) => MenuEditorPayload) {
    generation.current++;
    setPayload((cur) => cur && update(cur));
  }
  useEffect(() => {
    void load();
  }, []);
  function saved() {
    setStatus(t("menuSaved"));
    setError("");
    void load();
  }
  /** Runs one mutation with a fresh operationId per user action. */
  async function run(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await api(path, { operationId: crypto.randomUUID(), ...body });
      saved();
      return true;
    } catch (e) {
      setError(errorNotice(e, locale));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  const newProduct = (preset?: ProductPreset) =>
    setEditor({ key: crypto.randomUUID(), preset });
  /** Shown at once; the reload (or a failure's reload) then confirms it. */
  async function setProductAvailable(p: Product, available: boolean) {
    patch((cur) => withProductAvailable(cur, p.id, available));
    await run("/menu/products/availability", { id: p.id, available });
  }
  async function setOptionAvailable(
    g: MenuGroup,
    optionId: string,
    available: boolean,
  ) {
    patch((cur) => withOptionAvailable(cur, g.id, optionId, available));
    await run("/menu/groups/option-availability", {
      groupId: g.id,
      optionId,
      available,
    });
  }

  if (!payload)
    return (
      <>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <p className="muted">{t("loading")}</p>
      </>
    );

  const locked = !online || busy;
  const stranded = archiveGroup
    ? strandedCombos(payload.products, archiveGroup.id)
    : [];
  const categories = payload.categories.filter(
    (c) => showArchived || !c.archived,
  );
  const needle = query.trim().toLocaleLowerCase();
  const visible = payload.products.filter(
    (p) =>
      (showArchived || !p.archived) &&
      (!needle ||
        p.name.es.toLocaleLowerCase().includes(needle) ||
        p.name.en.toLocaleLowerCase().includes(needle)),
  );
  const sections = [
    ...categories.map((c) => ({
      key: c.id,
      category: c as MenuCategory | null,
      title: c.name[locale],
      products: visible.filter((p) => p.categoryId === c.id),
    })),
    {
      key: "none",
      category: null,
      title: t("menuNoCategory"),
      products: visible.filter(
        (p) =>
          !p.categoryId ||
          !payload.categories.some((c) => c.id === p.categoryId),
      ),
    },
  ].filter((s) => s.products.length || (s.category && !needle));

  async function reorderProducts(
    categoryId: string,
    index: number,
    delta: number,
  ) {
    const active = payload!.products.filter(
      (p) => p.categoryId === categoryId && !p.archived,
    );
    const next = swap(active, index, delta);
    // Optimistic: reflect the new order before the server confirms it.
    const queue = [...next];
    patch((cur) => ({
      ...cur,
      products: cur.products.map((p) =>
        p.categoryId === categoryId && !p.archived ? queue.shift()! : p,
      ),
    }));
    await run("/menu/products/reorder", {
      scopeId: categoryId,
      ids: next.map((p) => p.id),
    });
  }
  async function reorderCategories(index: number, delta: number) {
    const active = payload!.categories.filter((c) => !c.archived);
    const next = swap(active, index, delta);
    patch((cur) => ({
      ...cur,
      categories: [...next, ...cur.categories.filter((c) => c.archived)],
    }));
    await run("/menu/categories/reorder", { ids: next.map((c) => c.id) });
  }

  const productRow = (p: Product) => {
    // Reorder works on the full, unfiltered category list.
    const active = payload.products.filter(
      (x) => x.categoryId === p.categoryId && !x.archived,
    );
    const activeIndex = active.findIndex((x) => x.id === p.id);
    const name = p.name[locale];
    return (
      <li className="menu-row" key={p.id}>
        <div className="menu-row-main">
          <strong>{name}</strong>
          <div className="menu-badges">
            {p.archived && <Badge>{t("menuArchivedBadge")}</Badge>}
            {p.kind === "combo" && <Badge>{t("menuKindCombo")}</Badge>}
            {p.openAmount && <Badge>{t("menuOpenPriceBadge")}</Badge>}
            {p.groups.length > 0 && (
              <Badge>{t("menuGroupCount", { n: p.groups.length })}</Badge>
            )}
            {!!p.recipe?.length && <Badge>{t("menuRecipeBadge")}</Badge>}
            {requiredSoldOut(p) && (
              <Badge tone="red">{t("menuRequiredSoldOut")}</Badge>
            )}
          </div>
        </div>
        <span className="menu-price">
          {p.openAmount
            ? p.openMax
              ? t("menuOpenPriceMax", { amount: money(p.openMax) })
              : t("menuOpenPriceBadge")
            : money(p.price)}
        </span>
        <div className="row wrap menu-row-actions">
          {!p.archived && (
            <label className="menu-switch">
              <input
                type="checkbox"
                role="switch"
                checked={p.available}
                disabled={locked}
                aria-label={t("menuAvailableSwitch", { name })}
                onChange={(e) => void setProductAvailable(p, e.target.checked)}
              />
              <span aria-hidden="true">{t("menuAvailable")}</span>
            </label>
          )}
          {!p.archived && p.categoryId && (
            <>
              <Button
                variant="ghost"
                disabled={locked || activeIndex <= 0}
                aria-label={t("menuMoveUp", { name })}
                onClick={() =>
                  void reorderProducts(p.categoryId!, activeIndex, -1)
                }
              >
                ↑
              </Button>
              <Button
                variant="ghost"
                disabled={locked || activeIndex === active.length - 1}
                aria-label={t("menuMoveDown", { name })}
                onClick={() =>
                  void reorderProducts(p.categoryId!, activeIndex, 1)
                }
              >
                ↓
              </Button>
            </>
          )}
          <Button
            aria-label={t("menuEditItem", { name })}
            onClick={() => setEditor({ key: crypto.randomUUID(), product: p })}
          >
            {t("menuEdit")}
          </Button>
        </div>
      </li>
    );
  };

  return (
    <div className="menu-workspace">
      <div role="tablist" aria-label={t("menuNavMenu")} className="menu-tabs">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={`menu-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={tab === key ? `menu-panel-${key}` : undefined}
            className={tab === key ? "selected" : ""}
            onClick={() => setTab(key)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <p role="status" className="menu-status">
        {status}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!online && <p className="warning-panel">{t("menuOfflineHint")}</p>}
      <div
        role="tabpanel"
        id={`menu-panel-${tab}`}
        aria-labelledby={`menu-tab-${tab}`}
      >
        <div className="menu-toolbar">
          {tab === "products" && (
            <input
              type="search"
              className="menu-search"
              aria-label={t("menuSearch")}
              placeholder={t("menuSearch")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {tab !== "modifiers" && (
            <Button
              variant={tab === "products" ? "primary" : "secondary"}
              disabled={!online}
              onClick={() =>
                newProduct(
                  lastCategory ? { categoryId: lastCategory } : undefined,
                )
              }
            >
              {t("menuNewProduct")}
            </Button>
          )}
          {tab === "products" && (
            <Button disabled={!online} onClick={() => setImporting(true)}>
              {t("menuImportPhotos")}
            </Button>
          )}
          {tab !== "modifiers" && (
            <Button
              variant={tab === "categories" ? "primary" : "secondary"}
              disabled={!online}
              onClick={() => setCategoryDialog({})}
            >
              {t("menuNewCategory")}
            </Button>
          )}
          {tab === "modifiers" && (
            <Button
              variant="primary"
              disabled={!online}
              onClick={() => setGroupDialog({})}
            >
              {t("menuNewGroup")}
            </Button>
          )}
          <label className="menu-check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            <span>{t("menuShowArchived")}</span>
          </label>
        </div>

        {tab === "products" &&
          (payload.products.length === 0 ? (
            <section className="panel menu-onboarding">
              <h2>{t("menuEmptyTitle")}</h2>
              <ol>
                <li>
                  <button
                    className="text-button"
                    onClick={() => setCategoryDialog({})}
                  >
                    {t("menuStepCategories")}
                  </button>
                </li>
                <li>
                  <button className="text-button" onClick={() => newProduct()}>
                    {t("menuStepProducts")}
                  </button>
                </li>
                <li>
                  <button
                    className="text-button"
                    onClick={() => navigate("floor")}
                  >
                    {t("menuStepTables")}
                  </button>
                </li>
                <li>
                  <button
                    className="text-button"
                    onClick={() => navigate("stock")}
                  >
                    {t("menuStepRecipes")}
                  </button>
                </li>
              </ol>
              <p className="muted">
                <button
                  className="text-button"
                  onClick={() => navigate("settings")}
                >
                  {t("menuImportHint")}
                </button>
              </p>
            </section>
          ) : (
            sections.map((section) => {
              return (
                <section className="menu-section-list" key={section.key}>
                  <div className="menu-section-head">
                    <h2 className="menu-section-title">
                      {section.title}
                      <small>
                        {t("menuProductCount", { n: section.products.length })}
                      </small>
                    </h2>
                    {section.category && !section.category.archived && (
                      <Button
                        variant="ghost"
                        className="menu-section-add"
                        disabled={!online}
                        aria-label={t("menuAddProductTo", {
                          name: section.title,
                        })}
                        title={t("menuAddProductTo", { name: section.title })}
                        onClick={() =>
                          newProduct({ categoryId: section.category!.id })
                        }
                      >
                        <Plus size={20} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  {!section.category && (
                    <p className="tiny muted">{t("menuNoCategoryHint")}</p>
                  )}
                  <ul className="menu-list">
                    {section.products.map((p) => productRow(p))}
                  </ul>
                </section>
              );
            })
          ))}

        {tab === "categories" &&
          (categories.length ? (
            <ul className="menu-list">
              {categories.map((c) => {
                const active = payload.categories.filter((x) => !x.archived);
                const index = active.findIndex((x) => x.id === c.id);
                const name = c.name[locale];
                const value = names[c.id] ?? c.name.es;
                return (
                  <li className="menu-row" key={c.id}>
                    <form
                      className="menu-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run("/menu/categories/save", {
                          id: c.id,
                          expectedVersion: c.version,
                          name: {
                            es: value,
                            en: c.name.en === c.name.es ? "" : c.name.en,
                          },
                        }).then(
                          (ok) =>
                            ok &&
                            setNames(({ [c.id]: _done, ...rest }) => rest),
                        );
                      }}
                    >
                      <input
                        aria-label={t("menuRenameCategory", { name })}
                        value={value}
                        maxLength={80}
                        required
                        onChange={(e) =>
                          setNames({ ...names, [c.id]: e.target.value })
                        }
                      />
                      <Button
                        type="submit"
                        disabled={locked || value.trim() === c.name.es}
                      >
                        {t("menuSave")}
                      </Button>
                    </form>
                    <div className="menu-badges">
                      {c.archived && <Badge>{t("menuArchivedBadge")}</Badge>}
                      <span className="muted tiny">
                        {t("menuProductCount", { n: c.productCount })}
                      </span>
                    </div>
                    <div className="row wrap menu-row-actions">
                      {!c.archived && (
                        <>
                          <Button
                            variant="ghost"
                            disabled={locked || index <= 0}
                            aria-label={t("menuMoveUp", { name })}
                            onClick={() => void reorderCategories(index, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={locked || index === active.length - 1}
                            aria-label={t("menuMoveDown", { name })}
                            onClick={() => void reorderCategories(index, 1)}
                          >
                            ↓
                          </Button>
                        </>
                      )}
                      <Button
                        disabled={locked}
                        title={
                          !c.archived && c.productCount
                            ? translateError("category_in_use", locale)
                            : undefined
                        }
                        onClick={() =>
                          void run("/menu/categories/archive", {
                            id: c.id,
                            expectedVersion: c.version,
                            archived: !c.archived,
                          })
                        }
                      >
                        {t(c.archived ? "menuRestore" : "menuArchive")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty title={t("menuStepCategories")} />
          ))}

        {tab === "modifiers" &&
          (payload.groups.some((g) => showArchived || !g.archived) ? (
            <div className="menu-group-grid">
              {payload.groups
                .filter((g) => showArchived || !g.archived)
                .map((g) => (
                  <article className="panel menu-group-card" key={g.id}>
                    <div className="row between">
                      <h2>{g.name[locale]}</h2>
                      {g.archived && <Badge>{t("menuArchivedBadge")}</Badge>}
                    </div>
                    <p className="menu-rule">{groupRuleText(g, t)}</p>
                    <p className="muted tiny menu-option-preview">
                      {g.options.map((o, index) => (
                        <span key={o.id}>
                          {index > 0 && " · "}
                          {o.name[locale]}
                          {!o.available && (
                            <>
                              {" "}
                              <Badge tone="red">{t("menuSoldOut")}</Badge>
                            </>
                          )}
                        </span>
                      ))}
                    </p>
                    {!g.archived && (
                      // One tap to 86 a choice, like a product in the list.
                      <details className="menu-option-switches">
                        <summary>
                          {t("menuOptionsAvailability")}
                          {g.options.some((o) => !o.available) &&
                            ` · ${t("menuOptionsSoldOut", {
                              n: g.options.filter((o) => !o.available).length,
                            })}`}
                        </summary>
                        {g.options.map((o) => (
                          <label className="menu-switch" key={o.id}>
                            <input
                              type="checkbox"
                              role="switch"
                              checked={o.available}
                              disabled={locked}
                              aria-label={t("menuAvailableSwitch", {
                                name: o.name[locale],
                              })}
                              onChange={(e) =>
                                void setOptionAvailable(
                                  g,
                                  o.id,
                                  e.target.checked,
                                )
                              }
                            />
                            <span aria-hidden="true">{o.name[locale]}</span>
                          </label>
                        ))}
                      </details>
                    )}
                    <p className="muted tiny">
                      {t("menuGroupUsedBy", { n: g.usedBy.length })}
                    </p>
                    <div className="row wrap">
                      <Button
                        aria-label={t("menuEditItem", { name: g.name[locale] })}
                        onClick={() => setGroupDialog({ group: g })}
                      >
                        {t("menuEdit")}
                      </Button>
                      <Button
                        disabled={locked}
                        onClick={() =>
                          g.archived
                            ? void run("/menu/groups/archive", {
                                id: g.id,
                                expectedVersion: g.version,
                                archived: false,
                              })
                            : setArchiveGroup(g)
                        }
                      >
                        {t(g.archived ? "menuRestore" : "menuArchive")}
                      </Button>
                    </div>
                  </article>
                ))}
            </div>
          ) : (
            <Empty
              title={t("menuGroupsEmpty")}
              detail={t("menuGroupsEmptyHint")}
            />
          ))}
      </div>

      {editor && (
        <ProductEditor
          key={editor.key}
          payload={payload}
          product={editor.product}
          duplicateOf={editor.duplicateOf}
          preset={editor.preset}
          locale={locale}
          session={session}
          online={online}
          renderFiscal={(p) => (
            <ProductFiscalFields
              value={fiscalDraft(p.value)}
              onChange={p.onChange}
              locale={locale}
              disabled={p.disabled}
            />
          )}
          onClose={() => setEditor(null)}
          onReload={() => {
            setEditor(null);
            void load();
          }}
          onDuplicate={(p) =>
            setEditor({ key: crypto.randomUUID(), duplicateOf: p })
          }
          onSaved={(p) => {
            if (p.categoryId) setLastCategory(p.categoryId);
            setEditor(null);
            saved();
          }}
          onSaveAndNew={async (p) => {
            if (p.categoryId) setLastCategory(p.categoryId);
            setEditor(null);
            setStatus(t("menuSaved"));
            setError("");
            // The next editor starts from a payload that has the saved
            // product and any category or group created along the way.
            await load();
            newProduct({
              categoryId: p.categoryId,
              groupIds: p.groupIds ?? p.groups.map((g) => g.id),
              station: p.station,
              kind: p.kind,
            });
          }}
          onAvailability={(id, available) => {
            patch((cur) => withProductAvailable(cur, id, available));
            void load();
          }}
          onPhoto={() => void load()}
        />
      )}
      {importing && (
        <MenuMediaImport
          products={payload.products}
          locale={locale}
          online={online}
          onClose={() => setImporting(false)}
          onImported={() => void load()}
        />
      )}
      {categoryDialog && (
        <CategoryDialog
          category={categoryDialog.category}
          locale={locale}
          online={online}
          onClose={() => setCategoryDialog(null)}
          onSaved={() => {
            setCategoryDialog(null);
            saved();
          }}
        />
      )}
      {groupDialog && (
        <GroupEditor
          payload={payload}
          group={groupDialog.group}
          locale={locale}
          currency={session.restaurant.currency}
          online={online}
          onClose={() => setGroupDialog(null)}
          onReload={() => {
            setGroupDialog(null);
            void load();
          }}
          onSaved={() => {
            setGroupDialog(null);
            saved();
          }}
          onAvailability={(optionId, available) => {
            const g = groupDialog.group;
            if (g)
              patch((cur) =>
                withOptionAvailable(cur, g.id, optionId, available),
              );
            void load();
          }}
        />
      )}
      {archiveGroup && (
        <Modal
          title={t("menuArchiveTitle", { name: archiveGroup.name[locale] })}
          close={() => setArchiveGroup(null)}
          closeLabel={t("close")}
        >
          <p>
            {t("menuGroupArchiveConfirm", { n: archiveGroup.usedBy.length })}
          </p>
          {stranded.length > 0 && (
            <p role="alert" className="error">
              {t("menuGroupArchiveCombos", {
                names: stranded.map((p) => p.name[locale]).join(", "),
              })}
            </p>
          )}
          <div className="row wrap">
            <Button
              variant="danger"
              disabled={locked || stranded.length > 0}
              onClick={async () => {
                const g = archiveGroup;
                setArchiveGroup(null);
                await run("/menu/groups/archive", {
                  id: g.id,
                  expectedVersion: g.version,
                  archived: true,
                });
              }}
            >
              {t("menuArchive")}
            </Button>
            <Button onClick={() => setArchiveGroup(null)}>
              {t("menuCancel")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
