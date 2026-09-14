import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { Button } from "../components/ui";
type Status = {
  enabled: boolean;
  hostedUrl?: string | null;
  billing?: {
    trial_used: boolean;
    has_subscription: boolean;
    interval: "month" | "year";
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
    [consent, setConsent] = useState(false);
  async function load() {
    const r = await fetch(
      "/api/billing/status?tenantId=" + encodeURIComponent(tenantId),
    );
    if (!r.ok) throw Error();
    setStatus(await r.json());
  }
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
  const daysLeft = status?.entitlement?.access_until
    ? Math.ceil(
        (Date.parse(status.entitlement.access_until) - Date.now()) / 86400000,
      )
    : null;
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
      {status?.entitlement?.status === "trialing" &&
        daysLeft !== null &&
        daysLeft > 0 &&
        daysLeft <= 3 && (
          <p role="status">
            {es
              ? `Tu prueba termina en ${daysLeft} día(s). Puedes añadir una forma de pago en Stripe o continuar en Free.`
              : `Your trial ends in ${daysLeft} day(s). Add a payment method in Stripe or continue on Free.`}
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
              : es
                ? "Acepto continuar a Stripe con el periodo seleccionado; cualquier suscripción pagada es recurrente, por restaurante, más impuestos aplicables."
                : "I agree to continue to Stripe with the selected interval; any paid subscription recurs per restaurant, plus applicable taxes."}
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
