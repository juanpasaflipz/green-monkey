// «Importar menú de POS Lite» (docs/MENU.md, shared/menu-import.ts): the owner picks the menu
// export file, the server previews it (source restaurant, counts, the price control total, each
// category's station, the products with their option groups, warnings and blocking errors), the
// owner confirms the restaurant and imports (step-up PIN through api()). The file object sent to
// commit is the very object sent to preview: the server's fileHash is sha256 of its JSON. A
// station change re-requests nothing; the server recomputes the plan from the file and `stations`.
import { useId, useMemo, useState } from "react";
import type { Locale } from "../../../shared/domain";
import type {
  MenuImportError,
  MenuImportErrorCode,
  MenuImportIssue,
  MenuImportPreview,
  MenuImportResult,
  MenuImportWarning,
  MenuImportWarningCode,
  Station,
} from "../../../shared/menu-import";
import { api } from "../../api";
import { errorNotice, type Key } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { moneyFormatter, translator, type Translate } from "./format";

export const WARNING_KEY: Record<MenuImportWarningCode, Key> = {
  min_ignored: "menuPosLiteWarnMinIgnored",
  max_zero: "menuPosLiteWarnMaxZero",
  max_clamped: "menuPosLiteWarnMaxClamped",
  empty_group: "menuPosLiteWarnEmptyGroup",
  inactive_category: "menuPosLiteWarnInactiveCategory",
  duplicate_category_name: "menuPosLiteWarnDuplicateCategory",
  virtual_brands_not_imported: "menuPosLiteWarnVirtualBrands",
  combos_not_imported: "menuPosLiteWarnCombos",
  photos_separate: "menuPosLiteWarnPhotos",
};
export const ERROR_KEY: Record<MenuImportErrorCode, Key> = {
  currency: "menuPosLiteErrCurrency",
  duplicate_id: "menuPosLiteErrDuplicateId",
  category_name: "menuPosLiteErrCategoryName",
  product_name: "menuPosLiteErrProductName",
  group_name: "menuPosLiteErrGroupName",
  option_name: "menuPosLiteErrOptionName",
  description_too_long: "menuPosLiteErrDescriptionLong",
  description_forbidden: "menuPosLiteErrDescriptionForbidden",
  invalid_money: "menuPosLiteErrInvalidMoney",
  unknown_category: "menuPosLiteErrUnknownCategory",
  unknown_group: "menuPosLiteErrUnknownGroup",
  unknown_item: "menuPosLiteErrUnknownItem",
  selection_type: "menuPosLiteErrSelectionType",
  group_unsatisfiable: "menuPosLiteErrGroupUnsatisfiable",
  duplicate_option: "menuPosLiteErrDuplicateOption",
  too_many_groups: "menuPosLiteErrTooManyGroups",
  too_many_choices: "menuPosLiteErrTooManyChoices",
  limit_categories: "menuPosLiteErrLimitCategories",
  limit_products: "menuPosLiteErrLimitProducts",
  limit_groups: "menuPosLiteErrLimitGroups",
  limit_options: "menuPosLiteErrLimitOptions",
};

/** One warning or error in plain words; a missing name falls back to the pos-lite id. */
export function issueText<C extends string>(
  t: Translate,
  keys: Record<C, Key>,
  issue: MenuImportIssue<C>,
): string {
  return t(keys[issue.code], {
    name: issue.name ?? issue.ref ?? "—",
    ref: issue.ref ?? "—",
    from: issue.from ?? 0,
    to: issue.to ?? 0,
  });
}

type Phase = "pick" | "review" | "done";

export function MenuPosLiteImport({
  locale,
  currency,
  restaurant,
  online,
  onClose,
  onImported,
}: {
  locale: Locale;
  currency: string;
  /** This restaurant's name (the confirmation names it). */
  restaurant: string;
  online: boolean;
  onClose: () => void;
  /** The menu changed: the Productos list reloads. */
  onImported: () => void;
}) {
  const t = translator(locale);
  const ids = useId();
  const money = moneyFormatter(locale, currency);
  const [phase, setPhase] = useState<Phase>("pick");
  // The exact parsed object sent to preview; commit sends it unchanged (fileHash).
  const [file, setFile] = useState<unknown>(null);
  const [preview, setPreview] = useState<MenuImportPreview | null>(null);
  const [stations, setStations] = useState<Record<string, Station>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MenuImportResult | null>(null);

  async function read(f: File | undefined) {
    setError("");
    setPreview(null);
    setFile(null);
    setConfirmed(false);
    if (!f) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await f.text());
    } catch {
      setError(t("menuPosLiteFileUnreadable"));
      return;
    }
    setBusy(true);
    try {
      const p = await api<MenuImportPreview>("/menu/import/preview", parsed, {
        timeoutMs: 60_000,
      });
      setFile(parsed);
      setPreview(p);
      setStations(
        Object.fromEntries(p.categories.map((c) => [c.legacyId, c.station])),
      );
      setPhase("review");
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview || file === null) return;
    setError("");
    setBusy(true);
    try {
      const r = await api<MenuImportResult>(
        "/menu/import/commit",
        { file, stations, fileHash: preview.fileHash },
        { timeoutMs: 120_000 },
      );
      setResult(r);
      setPhase("done");
      onImported();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setPhase("pick");
    setPreview(null);
    setFile(null);
    setConfirmed(false);
    setError("");
  }

  const p = preview;
  const blocked = !p || p.errors.length > 0 || p.importedBefore;
  /** Products per category, in the plan's order. */
  const byCategory = useMemo(() => {
    const out = new Map<string, MenuImportPreview["products"]>();
    for (const product of p?.products ?? []) {
      const list = out.get(product.categoryLegacyId) ?? [];
      list.push(product);
      out.set(product.categoryLegacyId, list);
    }
    return out;
  }, [p]);
  const groupNames = useMemo(
    () => new Map((p?.groups ?? []).map((g) => [g.legacyId, g.name])),
    [p],
  );

  const footer =
    phase === "review" ? (
      <div className="row wrap">
        <Button disabled={busy} onClick={restart}>
          {t("menuPosLiteChooseAnother")}
        </Button>
        <Button
          variant="primary"
          disabled={!online || busy || blocked || !confirmed}
          onClick={() => void commit()}
        >
          {t("menuPosLiteCommit")}
        </Button>
      </div>
    ) : phase === "done" ? (
      <Button variant="primary" onClick={onClose}>
        {t("menuPosLiteBackToProducts")}
      </Button>
    ) : undefined;

  const warnings: MenuImportWarning[] = p?.warnings ?? [];
  const errors: MenuImportError[] = p?.errors ?? [];

  return (
    <Modal
      title={t("menuPosLiteTitle")}
      close={() => !busy && onClose()}
      closeLabel={t("menuClose")}
      wide
      footer={footer}
    >
      {phase === "pick" && (
        <>
          <p>{t("menuPosLiteIntro")}</p>
          <Field label={t("menuPosLiteFile")}>
            <input
              type="file"
              accept="application/json,.json"
              disabled={!online || busy}
              onChange={(e) => void read(e.target.files?.[0])}
            />
          </Field>
          {busy && <p role="status">{t("menuPosLiteReading")}</p>}
        </>
      )}
      {phase === "review" && p && (
        <div className="poslite-import">
          <p>
            <strong>
              {t("menuPosLiteSource", {
                source: p.sourceName ?? t("menuPosLiteSourceUnknown"),
                restaurant,
              })}
            </strong>
          </p>
          <p role="status">
            {t("menuPosLiteCounts", {
              categories: p.counts.categories,
              products: p.counts.products,
              groups: p.counts.groups,
              options: p.counts.options,
            })}
          </p>
          <p>
            {t("menuPosLitePriceTotal", { total: money(p.priceControlTotal) })}
            <br />
            <small className="muted">{t("menuPosLitePriceTotalHint")}</small>
          </p>
          {p.alreadyImported && (
            <p className="warning-panel" role="note">
              {t("menuPosLiteAlready")}
            </p>
          )}
          {p.importedBefore && (
            <p className="error" role="alert">
              {t("menuPosLiteImportedBefore")}
            </p>
          )}
          {errors.length > 0 && (
            <section className="error" role="alert" aria-labelledby={`${ids}-errors`}>
              <h3 id={`${ids}-errors`}>{t("menuPosLiteErrors")}</h3>
              <p>{t("menuPosLiteErrorsHint")}</p>
              <ul>
                {errors.map((e, i) => (
                  <li key={`${e.code}:${e.ref ?? ""}:${i}`}>
                    {issueText(t, ERROR_KEY, e)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(warnings.length > 0 || p.existingNameClashes.length > 0) && (
            <section className="warning-panel" aria-labelledby={`${ids}-warnings`}>
              <h3 id={`${ids}-warnings`}>{t("menuPosLiteWarnings")}</h3>
              <ul>
                {p.existingNameClashes.length > 0 && (
                  <li>
                    {t("menuPosLiteClashes", {
                      names: p.existingNameClashes.map((c) => c.name).join(", "),
                    })}
                  </li>
                )}
                {warnings.map((w, i) => (
                  <li key={`${w.code}:${w.ref ?? ""}:${i}`}>
                    {issueText(t, WARNING_KEY, w)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <h3 id={`${ids}-categories`}>{t("menuPosLiteCategories")}</h3>
          <div
            className="data-table poslite-scroll"
            role="region"
            aria-labelledby={`${ids}-categories`}
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("menuPosLiteCategory")}</th>
                  <th scope="col">{t("menuPosLiteProductCount")}</th>
                  <th scope="col">{t("menuPosLiteStation")}</th>
                </tr>
              </thead>
              <tbody>
                {p.categories.map((c) => (
                  <tr key={c.legacyId}>
                    <td>
                      {c.name[locale]}
                      {c.inactiveInSource && (
                        <small className="muted"> ({t("menuPosLiteInactive")})</small>
                      )}
                    </td>
                    <td>{byCategory.get(c.legacyId)?.length ?? 0}</td>
                    <td>
                      <select
                        aria-label={t("menuPosLiteStationFor", { name: c.name[locale] })}
                        value={stations[c.legacyId] ?? c.station}
                        disabled={busy}
                        onChange={(e) =>
                          setStations((s) => ({
                            ...s,
                            [c.legacyId]: e.target.value as Station,
                          }))
                        }
                      >
                        <option value="kitchen">{t("kitchen")}</option>
                        <option value="bar">{t("bar")}</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 id={`${ids}-products`}>{t("menuPosLiteProducts")}</h3>
          <div
            className="poslite-products poslite-scroll"
            role="region"
            aria-label={t("menuPosLiteProductsRegion")}
            tabIndex={0}
          >
            {p.categories.map((c) => {
              const products = byCategory.get(c.legacyId) ?? [];
              if (products.length === 0) return null;
              return (
                <section key={c.legacyId} aria-label={c.name[locale]}>
                  <h4>{c.name[locale]}</h4>
                  <ul>
                    {products.map((product) => (
                      <li key={product.legacyId}>
                        <span className="poslite-product-line">
                          <span>{product.name[locale]}</span>
                          <strong>{money(product.price)}</strong>
                        </span>
                        <small className="muted">
                          {product.groupLegacyIds.length > 0
                            ? product.groupLegacyIds
                                .map((id) => groupNames.get(id) ?? id)
                                .join(" · ")
                            : t("menuPosLiteNoGroups")}
                        </small>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          <label className="option">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={blocked || busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>{t("menuPosLiteConfirm", { restaurant })}</span>
          </label>
          {busy && <p role="status">{t("menuPosLiteImporting")}</p>}
        </div>
      )}
      {phase === "done" && result && (
        <p role="status" className="poslite-import-done">
          {result.replayed ? `${t("menuPosLiteReplayed")} ` : ""}
          {t("menuPosLiteDone", {
            categories: result.counts.categories,
            reused: result.counts.categoriesReused,
            products: result.counts.products,
            groups: result.counts.groups,
            options: result.counts.options,
          })}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
