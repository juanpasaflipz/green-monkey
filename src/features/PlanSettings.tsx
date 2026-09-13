import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { api } from "../api";
import { Button } from "../components/ui";
import { translateError } from "../i18n";
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
  return (
    <section
      className="panel"
      aria-label={es ? "Plan y suscripción" : "Plan and subscription"}
    >
      <h2>{es ? "Plan y suscripción" : "Plan and subscription"}</h2>
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
