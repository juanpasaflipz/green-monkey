import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { Button } from "../components/ui";
import { PRO_OFFER, accessPlan, type BillingStatus } from "../../shared/plans";
import { planNotice } from "../../shared/plan-notice";
import { strings } from "../i18n";
import { loadAccountConfig, type AccountConfig } from "./accountConfig";
type Status = {
  enabled: boolean;
  hostedUrl?: string | null;
  billing?: {
    trial_used: boolean;
    has_subscription: boolean;
    interval: "month" | "year";
    locations?: number;
  } | null;
  operation?: { kind: string; state: string } | null;
  entitlement?: { status: string; access_until: string | null } | null;
};
export function BillingControls({
  tenantId,
  locale,
}: {
  tenantId: string;
  locale: Locale;
}) {
  const es = locale === "es";
  const [status, setStatus] = useState<Status | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [interval, setIntervalChoice] = useState<"month" | "year">("month"),
    [consent, setConsent] = useState(false),
    [coOwner, setCoOwner] = useState(false),
    [config, setConfig] = useState<AccountConfig | null>(null);
  async function load() {
    const r = await fetch(
      "/api/billing/status?tenantId=" + encodeURIComponent(tenantId),
    );
    // Billing belongs to the primary owner; a co-owner gets 403 (account 031).
    if (r.status === 403) {
      setCoOwner(true);
      return;
    }
    if (!r.ok) throw Error();
    setStatus(await r.json());
  }
  useEffect(() => {
    void loadAccountConfig()
      .then(setConfig)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) void load().catch(() => setError(true));
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tenantId]);
  async function request(kind: "trial" | "checkout" | "portal") {
    setBusy(true);
    setError(false);
    try {
      const a = await fetch("/api/auth/account");
      if (!a.ok) throw Error();
      const account = await a.json();
      const r = await fetch("/api/billing/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": account.csrf,
        },
        body: JSON.stringify({ tenantId, kind, interval, consent: true }),
      });
      if (!r.ok) throw Error();
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  if (status?.enabled === false)
    return (
      <p className="muted">
        {es
          ? "Las suscripciones y la prueba de 14 días aún no están disponibles."
          : "Subscriptions and the 14-day trial are not yet available."}
      </p>
    );
  const pending =
    status?.operation &&
    ["pending", "running"].includes(status.operation.state);
  const hasSubscription =
    status?.billing?.has_subscription &&
    status.entitlement?.status !== "canceled";
  const taxNote =
    config?.saasTax.mode === "tax_rate"
      ? es
        ? " + IVA 16 %."
        : " + 16% VAT."
      : " " + strings[locale].accountTaxNotConfigured;
  // The shared plan notice rules (shared/plan-notice.ts) replace the old
  // 3-day reminder: trial ending (7/3/1 days) and failed payment.
  const entitlement = status?.entitlement
    ? {
        status: status.entitlement.status,
        accessUntil: status.entitlement.access_until,
        source: null,
      }
    : null;
  const notice = entitlement
    ? planNotice(
        {
          ...entitlement,
          plan: accessPlan(
            {
              status: entitlement.status as BillingStatus,
              accessUntil: entitlement.accessUntil,
              source: "stripe",
            },
            Date.now(),
          ),
        },
        { allowed: true, basis: "pro", continuationUntil: null },
        Date.now(),
      )
    : null;
  if (coOwner)
    return <p className="muted">{strings[locale].accountCoOwnerBillingNote}</p>;
  return (
    <div>
      <p>
        {es
          ? "Entorno de prueba de facturación. No se cobran pagos reales."
          : "Billing test environment. No real payments are charged."}
      </p>
      {error && (
        <p role="alert">
          {es
            ? "No se pudo consultar la facturación. Inicia sesión con la cuenta propietaria y vuelve a intentar."
            : "Billing could not be loaded. Sign in with the owning account and try again."}
        </p>
      )}
      {(notice?.kind === "trial_ending" ||
        notice?.kind === "payment_failed") && (
        <p role="status">
          {notice.kind === "payment_failed"
            ? strings[locale].accountNoticePaymentFailed
            : strings[locale].accountNoticeTrialEnding
                .replace(
                  "{date}",
                  new Date(notice.at!).toLocaleString(es ? "es-MX" : "en-US"),
                )
                .replace("{device}", strings[locale].accountNoticeNoDevice)}
        </p>
      )}
      {pending && (
        <p role="status">
          {status?.operation?.kind === "checkout_watch"
            ? es
              ? "Completa el pago de prueba en Stripe."
              : "Complete test checkout in Stripe."
            : es
              ? "Activación pendiente. Tu restaurante sigue disponible."
              : "Activation pending. Your restaurant remains available."}
        </p>
      )}
      {status?.operation?.state === "review" && (
        <p role="status">
          {es
            ? "La solicitud requiere revisión para evitar una suscripción duplicada."
            : "This request needs review to prevent a duplicate subscription."}
        </p>
      )}
      {status?.entitlement?.status === "trialing" &&
        status.entitlement.access_until && (
          <p>
            {es ? "Tu prueba termina: " : "Your trial ends: "}
            {new Date(status.entitlement.access_until).toLocaleString(
              es ? "es-MX" : "en-US",
            )}
            .{" "}
            {es
              ? "Sin tarjeta, volverás a Free."
              : "Without a card, you return to Free."}
          </p>
        )}
      {status?.enabled && !pending && status.operation?.state !== "review" && (
        <>
          {!hasSubscription && (
            <label>
              {es ? "Periodo" : "Billing interval"}{" "}
              <select
                value={interval}
                onChange={(e) => {
                  setIntervalChoice(e.target.value as "month" | "year");
                  setConsent(false);
                }}
              >
                <option value="month">
                  {es ? "MXN 799 al mes" : "MXN 799 monthly"}
                </option>
                <option value="year">
                  {es
                    ? "MXN 7,990 al año, pago anticipado"
                    : "MXN 7,990 annually, upfront"}
                </option>
              </select>
            </label>
          )}
          {!hasSubscription && (status.billing?.locations ?? 1) > 1 && (
            <p>
              {es ? "Total de la organización: " : "Organization total: "}
              {new Intl.NumberFormat(es ? "es-MX" : "en-US", {
                style: "currency",
                currency: "MXN",
              }).format(
                (status.billing!.locations! *
                  (interval === "year"
                    ? PRO_OFFER.annualMinor
                    : PRO_OFFER.monthlyMinor)) /
                  100,
              )}
              {interval === "year"
                ? es
                  ? "/año"
                  : "/year"
                : es
                  ? "/mes"
                  : "/month"}
              {es
                ? ` por ${status.billing!.locations} sucursales.`
                : ` for ${status.billing!.locations} locations.`}
              {taxNote}
            </p>
          )}
          <label className="opening-day">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            {hasSubscription
              ? es
                ? "Continuar a Stripe para gestionar mi suscripción existente y forma de pago."
                : "Continue to Stripe to manage my existing subscription and payment method."
              : (es
                  ? "Acepto continuar a Stripe con el periodo seleccionado; cualquier suscripción pagada es recurrente, por restaurante."
                  : "I agree to continue to Stripe with the selected interval; any paid subscription recurs per restaurant.") +
                taxNote}
          </label>
          {!hasSubscription && !status.billing?.trial_used && (
            <Button disabled={busy} onClick={() => void request("trial")}>
              {es
                ? "Iniciar prueba de 14 días sin tarjeta"
                : "Start 14-day trial without a card"}
            </Button>
          )}
          <Button
            disabled={busy || !consent}
            onClick={() =>
              void request(hasSubscription ? "portal" : "checkout")
            }
          >
            {hasSubscription
              ? es
                ? "Gestionar en Stripe"
                : "Manage in Stripe"
              : es
                ? "Suscribirme en Stripe (prueba)"
                : "Subscribe in Stripe (test)"}
          </Button>
        </>
      )}
      {status?.hostedUrl && (
        <a className="button" href={status.hostedUrl} rel="noreferrer">
          {es ? "Continuar en Stripe" : "Continue in Stripe"}
        </a>
      )}
    </div>
  );
}
