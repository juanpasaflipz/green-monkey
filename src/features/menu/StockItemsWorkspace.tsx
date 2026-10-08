import { useEffect, useState } from "react";
import { Decimal } from "decimal.js";
import type { Locale, Session } from "../../../shared/domain";
import type {
  NegativeStockPolicy,
  StockItem,
  StockMovement,
} from "../../../shared/menu";
import { api } from "../../api";
import { errorNotice, translateError, type Key } from "../../i18n";
import { Badge, Button, Empty, Modal } from "../../components/ui";
import { StockItemDialog } from "./StockItemDialog";
import { unitLabel } from "./RecipeEditor";
import { translator, trimDecimal } from "./format";
import { dateTime } from "../../datetime";

type Filter = "all" | "low" | "negative" | "archived";
const filters: [Filter, Key][] = [
  ["all", "menuStockFilterAll"],
  ["low", "menuStockFilterLow"],
  ["negative", "menuStockFilterNegative"],
  ["archived", "menuStockFilterArchived"],
];
const causeKeys: Record<string, Key> = {
  sale: "menuCauseSale",
  receipt: "menuCauseReceipt",
  waste: "menuCauseWaste",
  count_adjust: "menuCauseCount",
  opening: "menuCauseOpening",
  void: "menuCauseVoid",
  prep_input: "menuCausePrepInput",
  prep_output: "menuCausePrepOutput",
  // discounts (028): an item refund that returned its ingredients.
  refund: "discountsStockCauseRefund",
};
/**
 * Causes written by the system carry an internal reason ("dispatch",
 * "void_return", "Existencia inicial"); the translated cause says it all.
 * Receipts, waste, counts and prep keep the reason the person typed.
 */
const systemCauses = new Set(["sale", "void", "opening", "refund"]);
const negative = (i: StockItem) => new Decimal(i.onHand).isNegative();
const low = (i: StockItem) =>
  new Decimal(i.onHand).lte(new Decimal(i.threshold));

/** Insumos: stock item setup, the negative-stock policy and history. */
export function StockItemsWorkspace({
  session,
  locale,
  online,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
}) {
  const t = translator(locale);
  const number = new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
    maximumFractionDigits: 6,
  });
  const qty = (text: string) => number.format(Number(text));
  const [data, setData] = useState<{
    policy: NegativeStockPolicy;
    items: StockItem[];
  } | null>(null);
  const [plan, setPlan] = useState<"free" | "pro">("pro");
  const [filter, setFilter] = useState<Filter>("all");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{
    key: string;
    item?: StockItem;
  } | null>(null);
  const [archive, setArchive] = useState<StockItem | null>(null);
  const [history, setHistory] = useState<{
    item: StockItem;
    movements: StockMovement[];
    next: string | null;
  } | null>(null);

  async function load() {
    try {
      const [items, entitlement] = await Promise.all([
        api<{ policy: NegativeStockPolicy; items: StockItem[] }>(
          "/stock-items",
        ),
        api<{ plan: "free" | "pro" }>("/plan"),
      ]);
      setData(items);
      setPlan(entitlement.plan);
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function run(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await api(path, { operationId: crypto.randomUUID(), ...body });
      setStatus(t("menuSaved"));
      await load();
      return true;
    } catch (e) {
      setError(errorNotice(e, locale));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function openHistory(item: StockItem, before?: string) {
    try {
      const page = await api<{
        movements: StockMovement[];
        next: string | null;
      }>(
        `/stock-items/${item.id}/movements${before ? `?before=${encodeURIComponent(before)}` : ""}`,
      );
      setHistory((old) => ({
        item,
        movements:
          before && old
            ? [...old.movements, ...page.movements]
            : page.movements,
        next: page.next,
      }));
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }

  if (!data)
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : (
      <p className="muted">{t("loading")}</p>
    );
  const locked = !online || busy;
  const shown = data.items.filter((i) =>
    filter === "archived"
      ? i.archived
      : !i.archived &&
        (filter === "all" ||
          (filter === "low" && low(i)) ||
          (filter === "negative" && negative(i))),
  );
  // dd/MM/yyyy HH:mm, never es-MX's "4:53 p.m." (ACC-PR-5).
  const date = (iso: string) =>
    dateTime(iso, session.restaurant.timezone, locale);

  return (
    <div className="menu-workspace">
      <p role="status" className="menu-status">
        {status}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!online && <p className="warning-panel">{t("menuOfflineHint")}</p>}
      <fieldset className="panel menu-policy">
        <legend>{t("menuPolicyTitle")}</legend>
        {(
          [
            ["allow", "menuPolicyAllow", "menuPolicyAllowHint"],
            ["block", "menuPolicyBlock", "menuPolicyBlockHint"],
          ] as const
        ).map(([value, label, hint]) => (
          <label className="option" key={value}>
            <input
              type="radio"
              name="negative-stock-policy"
              checked={data.policy === value}
              disabled={locked}
              onChange={() => {
                // Optimistic: the radio reflects the choice while it saves.
                setData({ ...data, policy: value });
                void run("/stock-items/policy", { policy: value });
              }}
            />
            <span>
              {t(label)}
              <small>{t(hint)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="menu-toolbar">
        <div
          className="menu-filters"
          role="group"
          aria-label={t("menuStockFilter")}
        >
          {filters.map(([value, label]) => (
            <Button
              key={value}
              variant={filter === value ? "primary" : "secondary"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(label)}
            </Button>
          ))}
        </div>
        <Button
          variant="primary"
          disabled={!online}
          onClick={() => setDialog({ key: crypto.randomUUID() })}
        >
          {t("menuStockNew")}
        </Button>
      </div>
      {shown.length ? (
        <table className="menu-table">
          <thead>
            <tr>
              <th scope="col">{t("menuColIngredient")}</th>
              <th scope="col">{t("menuColUnit")}</th>
              <th scope="col">{t("menuColKind")}</th>
              <th scope="col">{t("menuStockOnHand")}</th>
              <th scope="col">{t("menuStockReorder")}</th>
              <th scope="col">{t("menuColPar")}</th>
              <th scope="col">{t("menuStockSuggested")}</th>
              <th scope="col">{t("menuStockStatus")}</th>
              <th scope="col">{t("menuStockActions")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => {
              const suggested =
                i.parLevel !== null
                  ? new Decimal(i.parLevel).minus(i.onHand)
                  : null;
              const hintId = `negative-${i.id}`;
              return (
                <tr key={i.id}>
                  <th scope="row" data-label={t("menuColIngredient")}>
                    {i.name}
                    {i.archived && <Badge>{t("menuArchivedBadge")}</Badge>}
                    {(i.usedBy.products.length > 0 ||
                      i.usedBy.options.length > 0) && (
                      <small className="muted">
                        {t("menuStockUsedBy", {
                          names: [
                            ...i.usedBy.products,
                            ...i.usedBy.options,
                          ].join(", "),
                        })}
                      </small>
                    )}
                  </th>
                  <td data-label={t("menuColUnit")}>{unitLabel(i.unit, t)}</td>
                  <td data-label={t("menuColKind")}>
                    {t(
                      i.kind === "prepared"
                        ? "menuStockPrepared"
                        : "menuStockRaw",
                    )}
                  </td>
                  <td data-label={t("menuStockOnHand")} className="numeric">
                    {qty(i.onHand)}
                  </td>
                  <td data-label={t("menuStockReorder")} className="numeric">
                    {qty(i.threshold)}
                  </td>
                  <td data-label={t("menuColPar")} className="numeric">
                    {i.parLevel !== null ? qty(i.parLevel) : "—"}
                  </td>
                  <td data-label={t("menuStockSuggested")} className="numeric">
                    {suggested && suggested.gt(0)
                      ? qty(trimDecimal(suggested.toFixed(6)))
                      : "—"}
                  </td>
                  <td data-label={t("menuStockStatus")}>
                    {negative(i) ? (
                      <>
                        <span
                          title={
                            i.negativeSince
                              ? t("menuStockNegativeHint", {
                                  date: date(i.negativeSince),
                                })
                              : undefined
                          }
                        >
                          <Badge tone="red">{t("menuStockNegative")}</Badge>
                        </span>
                        {i.negativeSince && (
                          <small
                            id={hintId}
                            className="muted menu-negative-hint"
                          >
                            {t("menuStockNegativeHint", {
                              date: date(i.negativeSince),
                            })}
                          </small>
                        )}
                      </>
                    ) : low(i) ? (
                      <Badge tone="amber">{t("menuStockLow")}</Badge>
                    ) : (
                      <Badge tone="green">{t("menuStockOk")}</Badge>
                    )}
                  </td>
                  <td data-label={t("menuStockActions")}>
                    <div className="row wrap menu-row-actions">
                      <Button
                        aria-label={t("menuEditItem", { name: i.name })}
                        disabled={!online}
                        onClick={() =>
                          setDialog({ key: crypto.randomUUID(), item: i })
                        }
                      >
                        {t("menuEdit")}
                      </Button>
                      <Button
                        disabled={locked}
                        onClick={() =>
                          i.archived
                            ? void run("/stock-items/archive", {
                                id: i.id,
                                expectedVersion: i.settingsVersion,
                                archived: false,
                              })
                            : setArchive(i)
                        }
                      >
                        {t(i.archived ? "menuRestore" : "menuArchive")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => void openHistory(i)}
                      >
                        {t("menuStockHistory")}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty title={t("menuStockEmpty")} detail={t("menuStockEmptyHint")} />
      )}

      {dialog &&
        (plan === "pro" ? (
          <StockItemDialog
            key={dialog.key}
            item={dialog.item}
            locale={locale}
            online={online}
            onClose={() => setDialog(null)}
            onReload={() => {
              setDialog(null);
              void load();
            }}
            onSaved={() => {
              setDialog(null);
              setStatus(t("menuSaved"));
              void load();
            }}
          />
        ) : (
          <Modal
            title={t(dialog.item ? "menuStockEdit" : "menuStockNew")}
            close={() => setDialog(null)}
            closeLabel={t("close")}
          >
            <p className="menu-locked">{t("menuProRequired")}</p>
            <p>{translateError("pro_required", locale)}</p>
          </Modal>
        ))}
      {archive && (
        <Modal
          title={t("menuStockArchiveTitle", { name: archive.name })}
          close={() => setArchive(null)}
          closeLabel={t("close")}
        >
          {archive.usedBy.products.length + archive.usedBy.options.length >
          0 ? (
            <>
              <p role="alert" className="error">
                {translateError("stock_in_use", locale)}
              </p>
              <p>
                {t("menuStockUsedBy", {
                  names: [
                    ...archive.usedBy.products,
                    ...archive.usedBy.options,
                  ].join(", "),
                })}
              </p>
            </>
          ) : (
            !new Decimal(archive.onHand).isZero() && (
              <p>
                {t("menuStockArchiveWarning", {
                  qty: qty(archive.onHand),
                  unit: unitLabel(archive.unit, t),
                })}
              </p>
            )
          )}
          <div className="row wrap">
            <Button
              variant="danger"
              disabled={
                locked ||
                archive.usedBy.products.length + archive.usedBy.options.length >
                  0
              }
              onClick={async () => {
                const item = archive;
                setArchive(null);
                await run("/stock-items/archive", {
                  id: item.id,
                  expectedVersion: item.settingsVersion,
                  archived: true,
                });
              }}
            >
              {t("menuArchive")}
            </Button>
            <Button onClick={() => setArchive(null)}>{t("menuCancel")}</Button>
          </div>
        </Modal>
      )}
      {history && (
        <Modal
          wide
          title={t("menuStockHistoryOf", { name: history.item.name })}
          close={() => setHistory(null)}
          closeLabel={t("close")}
        >
          {history.movements.length ? (
            <table className="menu-table menu-history">
              <thead>
                <tr>
                  <th scope="col">{t("menuStockWhen")}</th>
                  <th scope="col">{t("menuStockMovement")}</th>
                  <th scope="col">{t("menuStockMovementQty")}</th>
                  <th scope="col">{t("menuStockBalance")}</th>
                  <th scope="col">{t("menuStockReason")}</th>
                </tr>
              </thead>
              <tbody>
                {history.movements.map((m) => (
                  <tr key={m.id}>
                    <td data-label={t("menuStockWhen")}>{date(m.createdAt)}</td>
                    <td data-label={t("menuStockMovement")}>
                      {causeKeys[m.cause] ? t(causeKeys[m.cause]) : m.cause}
                    </td>
                    <td
                      data-label={t("menuStockMovementQty")}
                      className="numeric"
                    >
                      {qty(m.quantity)}
                    </td>
                    <td data-label={t("menuStockBalance")} className="numeric">
                      {m.balanceAfter !== null ? qty(m.balanceAfter) : "—"}
                    </td>
                    <td data-label={t("menuStockReason")}>
                      {systemCauses.has(m.cause) ? (
                        m.actorName && (
                          <small className="muted">{m.actorName}</small>
                        )
                      ) : (
                        <>
                          {m.reason}
                          {m.actorName && (
                            <small className="muted"> · {m.actorName}</small>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">{t("menuStockHistoryEmpty")}</p>
          )}
          {history.next && (
            <Button
              onClick={() => void openHistory(history.item, history.next!)}
            >
              {t("menuLoadMore")}
            </Button>
          )}
        </Modal>
      )}
    </div>
  );
}
