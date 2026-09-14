import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { api } from "../api";
import { Button } from "../components/ui";
import { translateError } from "../i18n";
import { PRO_OFFER, PRO_ANNUAL_SAVING_MINOR } from "../../shared/plans";
export function PlanSettings({
  locale,
  timezone,
}: {
  locale: Locale;
  timezone: string;
}) {
  const [plan, setPlan] = useState<{
    plan: string;
    status: string;
    accessUntil: string | null;
    kiosk: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  async function load() {
    try {
      setPlan(await api("/plan"));
      setError("");
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const es = locale === "es";
  const formatPrice = (minor: number) =>
    new Intl.NumberFormat(es ? "es-MX" : "en-US", {
      style: "currency",
      currency: PRO_OFFER.currency,
      currencyDisplay: "code",
    }).format(minor / 100);
  return (
    <section
      className="panel"
      aria-label={es ? "Plan y suscripción" : "Plan and subscription"}
    >
      <h2>{es ? "Plan y suscripción" : "Plan and subscription"}</h2>
      <p>
        {es
          ? "Precio Pro al lanzamiento, por restaurante:"
          : "Pro launch pricing, per restaurant:"}
      </p>
      <p>
        <strong>{formatPrice(PRO_OFFER.monthlyMinor)}</strong>
        {es ? " al mes o " : " monthly or "}
        <strong>{formatPrice(PRO_OFFER.annualMinor)}</strong>
        {es ? " al año, en un solo pago." : " annually, paid upfront."}
      </p>
      <p className="muted">
        {es
          ? `El pago anual ahorra ${formatPrice(PRO_ANNUAL_SAVING_MINOR)}: dos meses gratis. Impuestos aplicables adicionales. Kiosco incluido; sin cargo por empleado.`
          : `Annual billing saves ${formatPrice(PRO_ANNUAL_SAVING_MINOR)}: two months free. Applicable taxes are additional. Kiosk included; no per-employee fee.`}
      </p>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Button onClick={() => void load()}>
            {es ? "Reintentar" : "Retry"}
          </Button>
        </>
      ) : !plan ? (
        <p role="status">{es ? "Cargando…" : "Loading…"}</p>
      ) : (
        <>
          <h3>{plan.plan === "pro" ? "Pro" : "Free"}</h3>
          <p>
            {plan.kiosk
              ? es
                ? "Kiosco y órdenes QR habilitados."
                : "Kiosk and QR ordering enabled."
              : es
                ? "Kiosco y órdenes QR requieren Pro. Las ventas, cobros y recibos siguen disponibles."
                : "Kiosk and QR ordering require Pro. Selling, payments and receipts remain available."}
          </p>
          {plan.accessUntil && (
            <p>
              {es ? "Acceso hasta: " : "Access until: "}
              {new Intl.DateTimeFormat(es ? "es-MX" : "en-US", {
                dateStyle: "medium",
                timeZone: timezone,
                timeStyle: "short",
              }).format(new Date(plan.accessUntil))}
            </p>
          )}
          <p className="muted">
            {es
              ? "Las suscripciones y la prueba de 14 días aún no están disponibles."
              : "Subscriptions and the 14-day trial are not yet available."}
          </p>
        </>
      )}
    </section>
  );
}
