import { useEffect, useState } from "react";
import { Tag, Percent, X } from "lucide-react";
import {
  type Locale,
  type OrderInput,
  type Product,
  type Session,
} from "../../shared/domain";
import type { Offer } from "../../shared/offers";
import { api } from "../api";
import { translateError } from "../i18n";
import { mt, weekdays } from "../i18n-marketing";
import { Badge, Button, Empty, Field, Modal } from "../components/ui";

export type QuotePreview = {
  subtotal: number;
  discount: number;
  total: number;
  applied: {
    kind: string;
    name: string;
    code: string | null;
    amount: number;
  }[];
  code: { code: string; status: string } | null;
  lines: { id: string; total: number; gross: number; discount: number }[];
};
const codeMessage = {
  applied: "codeApplied",
  invalid: "codeInvalid",
  not_eligible: "codeNotEligible",
  superseded: "codeSuperseded",
} as const;

/** Cart block: promo code, applied reductions and the manual discount dialog.
 * Amounts always come from the server quote; nothing is calculated here. */
export function OfferSummary({
  session,
  locale,
  draft,
  setDraft,
  preview,
  online,
  round,
  money,
  parseAmount,
}: {
  session: Session;
  locale: Locale;
  draft: OrderInput;
  setDraft: (fn: (d: OrderInput) => OrderInput) => void;
  preview: QuotePreview | null;
  online: boolean;
  round: boolean;
  money: (n: number) => string;
  parseAmount: (s: string) => number;
}) {
  const t = mt(locale);
  const manager = ["owner", "manager"].includes(session.role);
  const [code, setCode] = useState("");
  const [dialog, setDialog] = useState(false);
  const [kind, setKind] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("10");
  const [reason, setReason] = useState("");
  const [login, setLogin] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!draft.lines.length) return null;
  if (!online)
    return draft.code || draft.manualDiscount ? (
      <p className="warning tiny" role="status">
        {t("offersOffline")}
      </p>
    ) : null;
  async function authorize() {
    setBusy(true);
    setError("");
    try {
      const amount =
        kind === "percent"
          ? Math.round(Number(value) * 100)
          : parseAmount(value);
      if (!Number.isInteger(amount) || amount < 1) throw Error("invalid_input");
      const manual = { kind, value: amount, reason: reason.trim() };
      if (manual.reason.length < 3) throw Error("invalid_input");
      if (manager) setDraft((d) => ({ ...d, manualDiscount: manual }));
      else {
        const approval = await api<{ approvalId: string }>("/approvals", {
          login,
          secret,
          operationId: draft.operationId,
          kind,
          value: amount,
        });
        setDraft((d) => ({
          ...d,
          manualDiscount: { ...manual, approvalId: approval.approvalId },
        }));
      }
      setSecret("");
      setDialog(false);
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  const status = preview?.code?.status as keyof typeof codeMessage | undefined;
  return (
    <div className="offer-summary">
      {/* A code left on the draft can always be removed, even on a later round. */}
      {(!round || draft.code) &&
        (draft.code ? (
          <div className="row between">
            <span>
              <Tag size={14} /> {draft.code}
            </span>
            <button
              className="text-button"
              aria-label={`${t("remove")} ${t("promoCode")}`}
              onClick={() =>
                setDraft(({ code: _code, ...d }) => d as OrderInput)
              }
            >
              <X size={14} />
              {t("remove")}
            </button>
          </div>
        ) : (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const next = code.trim().toUpperCase();
              if (!/^[A-Z0-9]{3,24}$/.test(next)) return;
              setDraft((d) => ({ ...d, code: next }));
              setCode("");
            }}
          >
            <input
              aria-label={t("promoCode")}
              placeholder={t("promoCode")}
              value={code}
              maxLength={24}
              autoCapitalize="characters"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <Button type="submit" disabled={code.trim().length < 3}>
              {t("apply")}
            </Button>
          </form>
        ))}
      {status && (
        <p
          className={status === "applied" ? "tiny muted" : "tiny error"}
          role="status"
        >
          {t(codeMessage[status])}
        </p>
      )}
      {preview && preview.discount > 0 && (
        <>
          <div className="row between tiny">
            <span>{t("subtotal")}</span>
            <span>{money(preview.subtotal)}</span>
          </div>
          {preview.applied.map((a, i) => (
            <div className="row between tiny" key={i}>
              <span>
                {a.kind === "manual" ? t("manualDiscount") + ": " : ""}
                {a.name}
              </span>
              <span>−{money(a.amount)}</span>
            </div>
          ))}
        </>
      )}
      <div className="row between">
        {draft.manualDiscount ? (
          <button
            className="text-button"
            onClick={() =>
              setDraft(({ manualDiscount: _manual, ...d }) => d as OrderInput)
            }
          >
            <X size={14} />
            {t("remove")} · {t("manualDiscount")}
          </button>
        ) : (
          <button className="text-button" onClick={() => setDialog(true)}>
            <Percent size={14} />
            {t("manualDiscount")}
          </button>
        )}
      </div>
      {dialog && (
        <Modal
          title={t("manualDiscount")}
          close={() => !busy && setDialog(false)}
          closeLabel={t("close")}
        >
          <div className="form-grid">
            <Field label={t("type")}>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="percent">{t("percent")}</option>
                <option value="amount">{t("fixedAmount")}</option>
              </select>
            </Field>
            <Field
              label={
                t("value") +
                (kind === "percent"
                  ? " (%)"
                  : ` (${session.restaurant.currency})`)
              }
            >
              <input
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          </div>
          <button
            className="text-button"
            onClick={() => {
              setKind("percent");
              setValue("100");
            }}
          >
            {t("courtesy")}
          </button>
          <Field label={t("reason")}>
            <input
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <p className="tiny muted">{t("reasonHint")}</p>
          {!manager && (
            <fieldset>
              <legend>{t("managerApproval")}</legend>
              <p className="tiny muted">{t("managerApprovalHint")}</p>
              <Field label={t("managerUser")}>
                <input
                  autoComplete="off"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                />
              </Field>
              <Field label={t("managerSecret")}>
                <input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </Field>
            </fieldset>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button
            variant="primary"
            className="full"
            disabled={
              busy ||
              reason.trim().length < 3 ||
              (!manager && (!login || secret.length < 4))
            }
            onClick={() => void authorize()}
          >
            {manager ? t("apply") : t("authorize")}
          </Button>
        </Modal>
      )}
    </div>
  );
}

const blank = (): Omit<Offer, "version" | "redeemed"> => ({
  id: crypto.randomUUID(),
  name: "",
  kind: "percent",
  value: 1000,
  scope: "order",
  targets: [],
  minSubtotal: 0,
  maxReduction: null,
  days: [1, 2, 3, 4, 5, 6, 7],
  fromMinute: 0,
  toMinute: 1440,
  startsOn: null,
  endsOn: null,
  channels: ["pos", "qr", "kiosk"],
  code: null,
  usageLimit: null,
  stackable: true,
  active: true,
});
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minutes = (value: string, end: boolean) => {
  const [h, m] = value.split(":").map(Number);
  const n = h * 60 + m;
  return end && n === 0 ? 1440 : n;
};

/** Manager screen for promotion definitions. */
export function OffersManager({
  locale,
  money,
  parseAmount,
  scale,
  exponent,
}: {
  locale: Locale;
  money: (n: number) => string;
  parseAmount: (s: string) => number;
  scale: number;
  exponent: number;
}) {
  const t = mt(locale);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [editing, setEditing] = useState<{
    offer: ReturnType<typeof blank>;
    version: number;
    value: string;
    min: string;
    max: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    Promise.all([
      api<Offer[]>("/offers").then(setOffers),
      api<Product[]>("/catalog").then(setCatalog),
    ]).catch((e) => setError(translateError(e.message, locale)));
  useEffect(() => {
    void load();
  }, []);
  const decimal = (n: number) => (n / scale).toFixed(exponent);
  const open = (o?: Offer) => {
    setError("");
    const {
      version = 0,
      redeemed: _redeemed,
      ...offer
    } = o ?? {
      ...blank(),
      version: 0,
      redeemed: 0,
    };
    setEditing({
      offer,
      version,
      value:
        offer.kind === "percent"
          ? String(offer.value / 100)
          : decimal(offer.value),
      min: offer.minSubtotal ? decimal(offer.minSubtotal) : "",
      max: offer.maxReduction ? decimal(offer.maxReduction) : "",
    });
  };
  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      const o = editing.offer;
      await api("/offers", {
        operationId: crypto.randomUUID(),
        expectedVersion: editing.version,
        offer: {
          ...o,
          value:
            o.kind === "percent"
              ? Math.round(Number(editing.value) * 100)
              : parseAmount(editing.value),
          minSubtotal: editing.min ? parseAmount(editing.min) : 0,
          maxReduction: editing.max ? parseAmount(editing.max) : null,
          targets: o.scope === "order" ? [] : o.targets,
        },
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  const set = (patch: Partial<ReturnType<typeof blank>>) =>
    setEditing((e) => e && { ...e, offer: { ...e.offer, ...patch } });
  const toggle = <T,>(list: T[], item: T) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  const categories = [...new Set(catalog.map((p) => p.category.es))];
  const describe = (o: Offer) =>
    (o.kind === "percent" ? `${o.value / 100}%` : money(o.value)) +
    " · " +
    (o.scope === "order"
      ? t("wholeOrder")
      : o.scope === "product"
        ? `${t("products")} (${o.targets.length})`
        : o.targets.join(", "));
  return (
    <>
      <div className="row between">
        <h2>{t("promotions")}</h2>
        <Button variant="primary" onClick={() => open()}>
          {t("newPromotion")}
        </Button>
      </div>
      {error && !editing && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {offers && !offers.length && (
        <Empty title={t("noPromotions")} detail={t("noPromotionsHint")} />
      )}
      <div className="stock-grid">
        {offers?.map((o) => (
          <article className="panel" key={o.id}>
            <div className="row between">
              <h3>{o.name}</h3>
              <Badge tone={o.active ? "green" : "amber"}>
                {t(o.active ? "active" : "inactive")}
              </Badge>
            </div>
            <p>{describe(o)}</p>
            <p className="tiny muted">
              {o.code ? `${t("code")}: ${o.code}` : t("automatic")} ·{" "}
              {o.days.map((d) => weekdays[locale][d - 1]).join(" ")} ·{" "}
              {clock(o.fromMinute)}–{clock(o.toMinute)} · {t("redeemed")}:{" "}
              {o.redeemed}
              {o.usageLimit ? ` / ${o.usageLimit}` : ""}
            </p>
            <Button onClick={() => open(o)}>{t("editPromotion")}</Button>
          </article>
        ))}
      </div>
      {editing && (
        <Modal
          wide
          title={t(editing.version ? "editPromotion" : "newPromotion")}
          close={() => !busy && setEditing(null)}
          closeLabel={t("close")}
        >
          <div className="form-grid">
            <Field label={t("name")}>
              <input
                value={editing.offer.name}
                maxLength={80}
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            <Field label={t("type")}>
              <select
                value={editing.offer.kind}
                onChange={(e) => set({ kind: e.target.value as Offer["kind"] })}
              >
                <option value="percent">{t("percent")}</option>
                <option value="amount">{t("fixedAmount")}</option>
              </select>
            </Field>
            <Field
              label={
                t("value") +
                (editing.offer.kind === "percent"
                  ? " (%)"
                  : editing.offer.scope === "order"
                    ? ""
                    : ` (${t("perUnit")})`)
              }
            >
              <input
                inputMode="decimal"
                value={editing.value}
                onChange={(e) =>
                  setEditing((x) => x && { ...x, value: e.target.value })
                }
              />
            </Field>
            <Field label={t("appliesTo")}>
              <select
                value={editing.offer.scope}
                onChange={(e) =>
                  set({ scope: e.target.value as Offer["scope"], targets: [] })
                }
              >
                <option value="order">{t("wholeOrder")}</option>
                <option value="category">{t("categories")}</option>
                <option value="product">{t("products")}</option>
              </select>
            </Field>
          </div>
          {editing.offer.scope !== "order" && (
            <fieldset>
              <legend>
                {t(
                  editing.offer.scope === "product" ? "products" : "categories",
                )}
              </legend>
              <div className="row wrap">
                {(editing.offer.scope === "product"
                  ? catalog.map((p) => [p.id, p.name[locale]])
                  : categories.map((c) => [c, c])
                ).map(([key, label]) => (
                  <label className="selection-check labelled" key={key}>
                    <input
                      type="checkbox"
                      checked={editing.offer.targets.includes(key)}
                      onChange={() =>
                        set({ targets: toggle(editing.offer.targets, key) })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="form-grid">
            <Field label={`${t("minSubtotal")} (${t("optional")})`}>
              <input
                inputMode="decimal"
                value={editing.min}
                onChange={(e) =>
                  setEditing((x) => x && { ...x, min: e.target.value })
                }
              />
            </Field>
            <Field label={`${t("maxReduction")} (${t("optional")})`}>
              <input
                inputMode="decimal"
                value={editing.max}
                onChange={(e) =>
                  setEditing((x) => x && { ...x, max: e.target.value })
                }
              />
            </Field>
            <Field label={t("from")}>
              <input
                type="time"
                value={clock(editing.offer.fromMinute)}
                onChange={(e) =>
                  set({ fromMinute: minutes(e.target.value, false) })
                }
              />
            </Field>
            <Field label={t("until")}>
              <input
                type="time"
                value={clock(editing.offer.toMinute)}
                onChange={(e) =>
                  set({ toMinute: minutes(e.target.value, true) })
                }
              />
            </Field>
            <Field label={`${t("startsOn")} (${t("optional")})`}>
              <input
                type="date"
                value={editing.offer.startsOn ?? ""}
                onChange={(e) => set({ startsOn: e.target.value || null })}
              />
            </Field>
            <Field label={`${t("endsOn")} (${t("optional")})`}>
              <input
                type="date"
                value={editing.offer.endsOn ?? ""}
                onChange={(e) => set({ endsOn: e.target.value || null })}
              />
            </Field>
            <Field label={`${t("code")} (${t("optional")})`}>
              <input
                value={editing.offer.code ?? ""}
                maxLength={24}
                onChange={(e) =>
                  set({
                    code:
                      e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") ||
                      null,
                  })
                }
              />
            </Field>
            <Field label={`${t("usageLimit")} (${t("optional")})`}>
              <input
                inputMode="numeric"
                value={editing.offer.usageLimit ?? ""}
                onChange={(e) =>
                  set({
                    usageLimit: Number.parseInt(e.target.value, 10) || null,
                  })
                }
              />
            </Field>
          </div>
          <p className="tiny muted">
            {t("allDayHint")} {t("codeHint")}
          </p>
          <fieldset>
            <legend>{t("days")}</legend>
            <div className="row wrap">
              {weekdays[locale].map((label, i) => (
                <label className="selection-check labelled" key={label}>
                  <input
                    type="checkbox"
                    checked={editing.offer.days.includes(i + 1)}
                    onChange={() =>
                      set({
                        days: toggle(editing.offer.days, i + 1).sort(
                          (a, b) => a - b,
                        ),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t("channels")}</legend>
            <div className="row wrap">
              {(["pos", "qr", "kiosk"] as const).map((channel) => (
                <label className="selection-check labelled" key={channel}>
                  <input
                    type="checkbox"
                    checked={editing.offer.channels.includes(channel)}
                    onChange={() =>
                      set({ channels: toggle(editing.offer.channels, channel) })
                    }
                  />
                  {t(channel)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="selection-check labelled">
            <input
              type="checkbox"
              checked={editing.offer.stackable}
              onChange={(e) => set({ stackable: e.target.checked })}
            />
            {t("stackable")}
          </label>
          <p className="tiny muted">{t("stackableHint")}</p>
          <label className="selection-check labelled">
            <input
              type="checkbox"
              checked={editing.offer.active}
              onChange={(e) => set({ active: e.target.checked })}
            />
            {t("active")}
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <Button onClick={() => setEditing(null)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                !editing.offer.name.trim() ||
                !editing.offer.days.length ||
                !editing.offer.channels.length ||
                (editing.offer.scope !== "order" &&
                  !editing.offer.targets.length)
              }
              onClick={() => void save()}
            >
              {t("save")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
