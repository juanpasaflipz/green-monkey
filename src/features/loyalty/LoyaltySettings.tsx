/**
 * Configuración › Club de lealtad (038 §2.10; critic R26: its own section after Privacidad y
 * datos, because enabling needs that notice). Owners and managers; saving asks for step-up on a
 * shared terminal. Turning the club on needs Pro, the restaurant's privacy notice URL and the
 * attestation that the notice covers the club. The pos-lite import is offered while it is off.
 */
import { useEffect, useState } from "react";
import { minor, type Locale, type Session } from "../../../shared/domain";
import type { LoyaltySettingsView } from "../../../shared/loyalty";
import { errorNotice } from "../../i18n";
import { dateTime } from "../../datetime";
import { Button, Field } from "../../components/ui";
import { loyaltyApi, refreshClub } from "./loyaltyApi";
import { LoyaltyImport } from "./LoyaltyImport";
import { fill, money, tr } from "./format";
import "./loyalty.css";

const pesos = (n: number | null) => (n === null ? "" : (n / 100).toFixed(2));
const toMinor = (v: string) => (v.trim() === "" ? null : minor(v.trim()));

export function LoyaltySettings({
  session,
  locale,
  online,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
}) {
  const t = tr(locale);
  const [view, setView] = useState<LoyaltySettingsView | null>(null);
  const [form, setForm] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const load = () =>
    loyaltyApi
      .settings()
      .then((v) => {
        const s = v as LoyaltySettingsView;
        setView(s);
        setForm({
          enabled: s.enabled,
          programName: s.programName,
          stampsRequired: String(s.stampsRequired),
          stampThreshold: pesos(s.stampThreshold),
          maxStampsPerOrder: s.maxStampsPerOrder ? String(s.maxStampsPerOrder) : "",
          rewardKind: s.rewardKind,
          rewardDescription: s.rewardDescription,
          rewardAmount: pesos(s.rewardAmount),
          rewardMaxAmount: pesos(s.rewardMaxAmount),
          maxRewardsPerOrder: String(s.maxRewardsPerOrder),
          promptAtCheckout: s.promptAtCheckout,
          receiptJoinQr: s.receiptJoinQr,
          linkWindowDays: String(s.linkWindowDays),
          privacyAttested: !!s.privacyAttestedAt,
        });
      })
      .catch((e) => setError(errorNotice(e, locale)));
  useEffect(() => {
    if (online) void load();
  }, [online]);
  if (!["owner", "manager"].includes(session.role)) return null;
  const set = (k: string, v: unknown) => {
    setSaved(false);
    setForm((f) => ({ ...f!, [k]: v }));
  };
  async function save() {
    if (!view || !form) return;
    setBusy(true);
    setError("");
    try {
      const amount = form.rewardKind === "amount";
      const next = await loyaltyApi.saveSettings({
        operationId: crypto.randomUUID(),
        expectedVersion: view.version,
        enabled: form.enabled,
        programName: form.programName.trim(),
        stampsRequired: Number(form.stampsRequired),
        stampThreshold: toMinor(form.stampThreshold) ?? 0,
        maxStampsPerOrder: form.maxStampsPerOrder ? Number(form.maxStampsPerOrder) : null,
        rewardKind: form.rewardKind,
        rewardDescription: form.rewardDescription.trim(),
        rewardAmount: amount ? toMinor(form.rewardAmount) : null,
        rewardMaxAmount: amount ? null : toMinor(form.rewardMaxAmount),
        maxRewardsPerOrder: Number(form.maxRewardsPerOrder),
        promptAtCheckout: form.promptAtCheckout,
        receiptJoinQr: form.receiptJoinQr,
        linkWindowDays: Number(form.linkWindowDays),
        privacyAttested: form.privacyAttested,
      });
      setView(next);
      setSaved(true);
      await refreshClub(session);
      await load();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  const pro = view?.plan === "pro";
  return (
    <section className="panel loyalty-settings" aria-labelledby="loyalty-settings-title">
      <h2 id="loyalty-settings-title">{t("loyaltySettingsTitle")}</h2>
      {!online && <p className="muted">{t("loyaltyOfflineHint")}</p>}
      {view && !pro && <p className="muted">{t("loyaltyProOnly")}</p>}
      {view && form && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {view.privacyUrl ? (
            <p>
              {fill(t("loyaltyPrivacyNotice"), { url: view.privacyUrl })}
            </p>
          ) : (
            <p className="warning-panel">{t("loyaltyPrivacyMissing")}</p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={form.privacyAttested}
              onChange={(e) => set("privacyAttested", e.target.checked)}
            />
            {t("loyaltyPrivacyAttest")}
          </label>
          {view.privacyAttestedAt && view.privacyAttestedByName && (
            <p className="muted">
              {fill(t("loyaltyPrivacyAttested"), {
                name: view.privacyAttestedByName,
                date: dateTime(view.privacyAttestedAt, session.restaurant.timezone, locale),
              })}
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={!pro && !form.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            {t("loyaltyEnabled")}
          </label>
          <Field label={t("loyaltyProgramName")}>
            <input
              value={form.programName}
              maxLength={40}
              placeholder={`Club ${session.restaurant.name}`}
              onChange={(e) => set("programName", e.target.value)}
            />
          </Field>
          <p className="muted tiny">
            {fill(t("loyaltyProgramNameHint"), { restaurant: session.restaurant.name })}
          </p>
          <div className="loyalty-grid">
            <Field label={t("loyaltyStampsRequired")}>
              <input
                type="number"
                min={2}
                max={50}
                value={form.stampsRequired}
                onChange={(e) => set("stampsRequired", e.target.value)}
              />
            </Field>
            <Field label={t("loyaltyThreshold")}>
              <input
                inputMode="decimal"
                value={form.stampThreshold}
                onChange={(e) => set("stampThreshold", e.target.value)}
              />
            </Field>
            <Field label={t("loyaltyMaxStamps")}>
              <input
                type="number"
                min={1}
                max={20}
                value={form.maxStampsPerOrder}
                onChange={(e) => set("maxStampsPerOrder", e.target.value)}
              />
            </Field>
          </div>
          <p className="muted tiny">
            {fill(t("loyaltyThresholdHint"), {
              amount: money(view.stampThreshold || 40000, locale, session.restaurant.currency),
            })}
          </p>
          <fieldset className="loyalty-country">
            <legend>{t("loyaltyRewardKind")}</legend>
            {(["item", "amount"] as const).map((k) => (
              <label key={k}>
                <input
                  type="radio"
                  name="loyalty-reward-kind"
                  checked={form.rewardKind === k}
                  onChange={() => set("rewardKind", k)}
                />
                {t(k === "item" ? "loyaltyRewardItem" : "loyaltyRewardAmount")}
              </label>
            ))}
          </fieldset>
          {form.rewardKind === "item" ? (
            <Field label={t("loyaltyRewardCap")}>
              <input
                inputMode="decimal"
                value={form.rewardMaxAmount}
                onChange={(e) => set("rewardMaxAmount", e.target.value)}
              />
            </Field>
          ) : (
            <Field label={t("loyaltyRewardAmountValue")}>
              <input
                inputMode="decimal"
                value={form.rewardAmount}
                onChange={(e) => set("rewardAmount", e.target.value)}
              />
            </Field>
          )}
          <Field label={t("loyaltyRewardDescription")}>
            <input
              value={form.rewardDescription}
              maxLength={80}
              onChange={(e) => set("rewardDescription", e.target.value)}
            />
          </Field>
          <div className="loyalty-grid">
            <Field label={t("loyaltyRewardsPerOrder")}>
              <input
                type="number"
                min={1}
                max={3}
                value={form.maxRewardsPerOrder}
                onChange={(e) => set("maxRewardsPerOrder", e.target.value)}
              />
            </Field>
            <Field label={t("loyaltyLinkWindow")}>
              <input
                type="number"
                min={1}
                max={30}
                value={form.linkWindowDays}
                onChange={(e) => set("linkWindowDays", e.target.value)}
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.promptAtCheckout}
              onChange={(e) => set("promptAtCheckout", e.target.checked)}
            />
            {t("loyaltyPromptAtCheckout")}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.receiptJoinQr}
              onChange={(e) => set("receiptJoinQr", e.target.checked)}
            />
            {t("loyaltyReceiptQr")}
          </label>
          <div className="row wrap">
            <Button type="submit" variant="primary" disabled={busy || !online}>
              {t("loyaltySaveClub")}
            </Button>
            <span role="status" aria-live="polite" className="muted">
              {saved ? t("loyaltySaved") : ""}
            </span>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {view?.importAllowed && pro && (
        <LoyaltyImport
          session={session}
          locale={locale}
          online={online}
          stampsRequired={view.stampsRequired}
          onApplySettings={(s) => {
            if (s.stampsRequired) set("stampsRequired", String(s.stampsRequired));
            if (s.stampThreshold !== null) set("stampThreshold", pesos(s.stampThreshold));
            if (s.rewardDescription) set("rewardDescription", s.rewardDescription);
          }}
        />
      )}
    </section>
  );
}
