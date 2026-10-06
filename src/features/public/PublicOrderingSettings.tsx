import { useEffect, useRef, useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Session,
} from "../../../shared/domain";
import { parseMoneyInput } from "../../../shared/service";
import {
  HOLD_MINUTES,
  PUBLIC_LIMITS,
  type HoldPolicy,
  type PublicLinkView,
  type PublicLinksResponse,
  type PublicSettingsView,
  type RevealedLink,
} from "../../../shared/public-ordering";
import { strings, translateError, type Key } from "../../i18n";
import { api } from "../../api";
import { Badge, Button, Field } from "../../components/ui";
import { moneyFormatter } from "../Receipt";
import { fill } from "../menu/format";
import { LinkRevealDialog } from "./LinkRevealDialog";
import { shortDate, shortDateTime } from "./TableQrDialog";
import { refreshPublicInbox } from "./usePublicInbox";
import "./public.css";

const OPERATORS = ["owner", "manager", "cashier", "server"];

/**
 * Operations → Configuración: "Pedidos en línea (QR y kiosco)". Everyone
 * sees whether orders are coming in and can pause; managers set the policies
 * and manage kiosk and takeaway codes. Table codes live in Mesas. The save
 * button is never "Guardar" and the notice never "Configuración guardada"
 * (both belong to the restaurant settings above).
 */
export function PublicOrderingSettings({
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
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const operator = OPERATORS.includes(session.role);
  const currency = session.restaurant.currency;
  const exponent = currencyExponent(currency);
  const money = moneyFormatter(currency, locale);
  const [view, setView] = useState<PublicSettingsView | null>(null);
  const [links, setLinks] = useState<PublicLinkView[]>([]);
  const [form, setForm] = useState<{
    tablePolicy: HoldPolicy;
    counterPolicy: HoldPolicy;
    holdMinutes: number;
    maxText: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [labels, setLabels] = useState({ kiosk: "", counter: "" });
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);
  const [confirm, setConfirm] = useState<{
    link: PublicLinkView;
    action: "rotate" | "revoke";
  } | null>(null);
  const saveKey = useRef(crypto.randomUUID());

  async function load() {
    if (!operator) return;
    try {
      const v = await api<PublicSettingsView>("/ordering/settings");
      setView(v);
      setForm({
        tablePolicy: v.tablePolicy,
        counterPolicy: v.counterPolicy,
        holdMinutes: v.holdMinutes,
        maxText: (v.maxOrderTotal / 10 ** exponent).toFixed(exponent),
      });
      if (v.available && v.pro && v.canEdit)
        setLinks((await api<PublicLinksResponse>("/ordering/links")).links);
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  if (!operator || !view || !view.available) return null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      const code = (e as Error).message;
      if (code === "settings_changed") await load();
      if (code !== "step_up_cancelled") setError(translateError(code, locale));
    } finally {
      setBusy(false);
    }
  }
  const pause = (paused: boolean) =>
    run(async () => {
      setView(
        await api<PublicSettingsView>("/ordering/pause", {
          operationId: crypto.randomUUID(),
          paused,
        }),
      );
      refreshPublicInbox();
    });
  const save = () =>
    run(async () => {
      if (!form) return;
      let maxOrderTotal: number;
      try {
        maxOrderTotal = parseMoneyInput(form.maxText, exponent);
      } catch {
        throw new Error("invalid_amount");
      }
      if (
        maxOrderTotal < PUBLIC_LIMITS.minOrderTotal ||
        maxOrderTotal > PUBLIC_LIMITS.maxOrderTotal
      )
        throw new Error("invalid_amount");
      const next = await api<PublicSettingsView>("/ordering/settings", {
        operationId: saveKey.current,
        expectedVersion: view!.version,
        tablePolicy: form.tablePolicy,
        counterPolicy: form.counterPolicy,
        holdMinutes: form.holdMinutes,
        maxOrderTotal,
      });
      saveKey.current = crypto.randomUUID();
      setView(next);
      setNotice(t("publicSaved"));
    });
  const create = (kind: "kiosk" | "counter") =>
    run(async () => {
      const label = labels[kind].trim();
      if (!label) return;
      setRevealed(await api<RevealedLink>("/ordering/links", { kind, label }));
      setLabels((l) => ({ ...l, [kind]: "" }));
      refreshPublicInbox();
      await load();
    });
  const act = (link: PublicLinkView, action: "rotate" | "revoke") =>
    run(async () => {
      if (action === "rotate")
        setRevealed(
          await api<RevealedLink>(`/ordering/links/${link.id}/rotate`, {}),
        );
      else
        await api(`/ordering/links/${link.id}/revoke`, {
          operationId: crypto.randomUUID(),
        });
      setConfirm(null);
      await load();
    });

  const status = !view.pro
    ? t("publicStatusNoPro")
    : view.reason === "paused"
      ? t("publicStatusPaused")
      : view.reason === "no_staff"
        ? t("publicStatusNoStaff")
        : t("publicStatusOpen");
  const policyOptions = (
    value: HoldPolicy,
    label: string,
    set: (p: HoldPolicy) => void,
  ) => (
    <Field label={label}>
      <select
        value={value}
        disabled={!view.canEdit || busy || !online}
        onChange={(e) => set(e.target.value as HoldPolicy)}
      >
        <option value="accept">{t("publicPolicyAcceptOption")}</option>
        <option value="pay_first">{t("publicPolicyPayFirstOption")}</option>
      </select>
    </Field>
  );
  const linkList = (kind: "kiosk" | "counter") => {
    const active = links.filter((l) => l.kind === kind && !l.revokedAt);
    return (
      <section className="public-links">
        <h3>
          {kind === "kiosk" ? t("publicKiosks") : t("publicCounterLinks")}
        </h3>
        {active.length === 0 && <p className="muted">{t("publicNoLinks")}</p>}
        <ul>
          {active.map((l) => (
            <li key={l.id} className="public-link-row">
              <div>
                <strong>{l.label}</strong>
                <p className="muted tiny">
                  {t("publicLinkRef", { ref: l.ref })} ·{" "}
                  {t("publicLinkSince", {
                    date: shortDate(
                      l.createdAt,
                      locale,
                      session.restaurant.timezone,
                    ),
                  })}{" "}
                  ·{" "}
                  {l.lastHoldAt
                    ? t("publicLastOrder", {
                        date: shortDateTime(
                          l.lastHoldAt,
                          locale,
                          session.restaurant.timezone,
                        ),
                      })
                    : t("publicNoOrdersYet")}
                </p>
              </div>
              <div className="row wrap">
                <Button
                  disabled={busy || !online}
                  aria-label={t("publicReplaceItem", { name: l.label })}
                  onClick={() => setConfirm({ link: l, action: "rotate" })}
                >
                  {t("publicReplace")}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy || !online}
                  aria-label={t("publicRevokeItem", { name: l.label })}
                  onClick={() => setConfirm({ link: l, action: "revoke" })}
                >
                  {t("publicRevoke")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {active.length < view.limits[kind] && (
          <div className="public-add-link">
            <Field
              label={
                kind === "kiosk"
                  ? t("publicKioskLabel")
                  : t("publicCounterLabel")
              }
            >
              <input
                value={labels[kind]}
                maxLength={60}
                disabled={busy || !online}
                onChange={(e) =>
                  setLabels((x) => ({ ...x, [kind]: e.target.value }))
                }
              />
            </Field>
            <Button
              disabled={busy || !online || !labels[kind].trim()}
              onClick={() => void create(kind)}
            >
              {kind === "kiosk" ? t("publicAddKiosk") : t("publicAddCounter")}
            </Button>
          </div>
        )}
      </section>
    );
  };

  return (
    <section
      className="panel public-settings"
      aria-labelledby="public-settings-title"
    >
      <div className="public-settings-head">
        <h2 id="public-settings-title">{t("publicSettingsTitle")}</h2>
        <Badge tone={view.acceptingNow ? "green" : "amber"}>{status}</Badge>
      </div>
      {!view.pro ? (
        <p className="muted">{t("publicProRequired")}</p>
      ) : (
        <>
          {!online && <p className="warning-panel">{t("publicOffline")}</p>}
          {view.canPause && (
            <Button
              disabled={busy || !online}
              onClick={() => void pause(!view.paused)}
            >
              {view.paused ? t("publicResume") : t("publicPause")}
            </Button>
          )}
          <p className="muted tiny">{t("publicAutoPauseHint")}</p>
          {form && (
            <div className="public-policies">
              {policyOptions(form.tablePolicy, t("publicTablePolicy"), (p) =>
                setForm({ ...form, tablePolicy: p }),
              )}
              {policyOptions(
                form.counterPolicy,
                t("publicCounterPolicy"),
                (p) => setForm({ ...form, counterPolicy: p }),
              )}
              <Field label={t("publicHoldMinutes")}>
                <select
                  value={form.holdMinutes}
                  disabled={!view.canEdit || busy || !online}
                  onChange={(e) =>
                    setForm({ ...form, holdMinutes: Number(e.target.value) })
                  }
                >
                  {HOLD_MINUTES.map((n) => (
                    <option key={n} value={n}>
                      {t("publicMinutes", { n })}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="field">
                <span>{t("publicMaxTotal")}</span>
                <input
                  inputMode="decimal"
                  value={form.maxText}
                  disabled={!view.canEdit || busy || !online}
                  aria-describedby="public-max-hint"
                  onChange={(e) =>
                    setForm({ ...form, maxText: e.target.value })
                  }
                />
                <small id="public-max-hint" className="muted">
                  {t("publicMaxTotalHint", {
                    min: money(PUBLIC_LIMITS.minOrderTotal),
                    max: money(PUBLIC_LIMITS.maxOrderTotal),
                  })}
                </small>
              </label>
              {view.canEdit && (
                <Button
                  variant="primary"
                  disabled={busy || !online}
                  onClick={() => void save()}
                >
                  {t("publicSave")}
                </Button>
              )}
            </div>
          )}
          {view.canEdit && (
            <>
              {linkList("kiosk")}
              {linkList("counter")}
            </>
          )}
          <p className="muted">
            {t("publicFloorHint")}{" "}
            {view.canEdit && (
              <Button variant="ghost" onClick={() => navigate("floor")}>
                {t("publicGoToFloor")}
              </Button>
            )}
          </p>
        </>
      )}
      {notice && (
        <p className="public-notice" aria-live="polite">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirm && (
        <div className="warning-panel">
          <p>
            {confirm.action === "rotate"
              ? t("publicReplaceConfirm")
              : t("publicRevokeConfirm")}
          </p>
          <div className="row wrap">
            <Button
              variant={confirm.action === "rotate" ? "primary" : "danger"}
              disabled={busy}
              onClick={() => void act(confirm.link, confirm.action)}
            >
              {confirm.action === "rotate"
                ? t("publicReplaceItem", { name: confirm.link.label })
                : t("publicRevokeItem", { name: confirm.link.label })}
            </Button>
            <Button disabled={busy} onClick={() => setConfirm(null)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
      {revealed && (
        <LinkRevealDialog
          link={revealed}
          restaurant={session.restaurant.name}
          locale={locale}
          onClose={() => setRevealed(null)}
        />
      )}
    </section>
  );
}
