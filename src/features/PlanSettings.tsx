import { BillingControls } from "./BillingControls";
import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { api } from "../api";
import { Button } from "../components/ui";
import { strings, errorNotice } from "../i18n";
import { loadAccountConfig, type AccountConfig } from "./accountConfig";
import { PRO_OFFER, PRO_ANNUAL_SAVING_MINOR } from "../../shared/plans";
export function PlanSettings({
  locale,
  timezone,
  tenantId,
}: {
  locale: Locale;
  timezone: string;
  tenantId: string;
}) {
  const [plan, setPlan] = useState<{
    plan: string;
    status: string;
    accessUntil: string | null;
    kiosk: boolean;
    source?: "stripe" | "fixture" | "support" | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<AccountConfig | null>(null);
  async function load() {
    try {
      setPlan(await api("/plan"));
      setError("");
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  useEffect(() => {
    void load();
    void loadAccountConfig()
      .then(setConfig)
      .catch(() => undefined);
  }, []);
  // Until the configuration loads, QR/kiosk ordering is not advertised (§2.15).
  const ordering = config?.publicOrdering.enabled === true;
  const taxed = config?.saasTax.mode === "tax_rate";
  const withTax = (minor: number) => Math.round((minor * 116) / 100);
  const es = locale === "es";
  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(es ? "es-MX" : "en-US", {
      dateStyle: "medium",
      timeZone: timezone,
      timeStyle: "short",
      hourCycle: "h23",
    }).format(new Date(iso));
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
          ? `El pago anual ahorra ${formatPrice(PRO_ANNUAL_SAVING_MINOR)}: dos meses gratis. ${ordering ? "Kiosco incluido; s" : "S"}in cargo por empleado.`
          : `Annual billing saves ${formatPrice(PRO_ANNUAL_SAVING_MINOR)}: two months free. ${ordering ? "Kiosk included; n" : "N"}o per-employee fee.`}
      </p>
      <p className="muted">
        {taxed
          ? [PRO_OFFER.monthlyMinor, PRO_OFFER.annualMinor]
              .map((minor) =>
                strings[locale].accountTaxIncluded
                  .replace("{price}", formatPrice(minor))
                  .replace("{total}", formatPrice(withTax(minor))),
              )
              .join(" · ")
          : strings[locale].accountTaxNotConfigured}
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
            {plan.plan !== "pro"
              ? strings[locale].accountFreeLimitsSummary
              : ordering && plan.kiosk
                ? es
                  ? "Kiosco y órdenes QR habilitados."
                  : "Kiosk and QR ordering enabled."
                : config?.publicOrdering.switchedOff
                  ? strings[locale].accountPublicOrderingOff
                  : strings[locale].accountPublicOrderingSoon}
          </p>
          {plan.accessUntil && plan.plan === "pro" && (
            <p>
              {plan.source === "support" &&
                strings[locale].accountSupportGrantPrefix + " · "}
              {es ? "Acceso hasta: " : "Access until: "}
              {formatDate(plan.accessUntil)}
            </p>
          )}
          {/* On Free a past date is when Pro ended (a lapsed trial or grant,
              a canceled subscription's ended_at), never "access until"
              (ACC-19); a future date on Free (no access) is not shown. */}
          {plan.accessUntil &&
            plan.plan !== "pro" &&
            Date.parse(plan.accessUntil) <= Date.now() && (
              <p>
                {strings[locale].accountPlanProEnded.replace(
                  "{date}",
                  formatDate(plan.accessUntil),
                )}
              </p>
            )}
          <BillingControls
            key={tenantId}
            tenantId={tenantId}
            locale={locale}
            timezone={timezone}
          />
        </>
      )}
    </section>
  );
}
