import { BrandLogo } from "../components/BrandLogo";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ChefHat,
  ShoppingBag,
  ChartNoAxesCombined,
  ArrowUpRight,
} from "lucide-react";
import { PRO_OFFER, PRO_ANNUAL_SAVING_MINOR } from "../../shared/plans";
import type { Locale } from "../../shared/domain";
import "./landing.css";

export default function Landing() {
  const [locale, setLocale] = useState<Locale>(() =>
    localStorage.getItem("gm-locale") === "en" ? "en" : "es",
  );
  const [annual, setAnnual] = useState(false);
  const [preview, setPreview] = useState(0);
  const es = locale === "es";
  const t = (spanish: string, english: string) => (es ? spanish : english);
  const money = (minor: number) =>
    new Intl.NumberFormat(es ? "es-MX" : "en-US", {
      style: "currency",
      currency: PRO_OFFER.currency,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  useEffect(() => {
    localStorage.setItem("gm-locale", locale);
    document.documentElement.lang = locale;
    document.title = es
      ? "Green Monkey — Tu restaurante, en orden"
      : "Green Monkey — Your restaurant, in order";
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        "content",
        es
          ? "Conoce Green Monkey: ventas, mesas, cocina y caja para tu restaurante. Plan Free y próximo plan Pro con kiosco. Precios en MXN."
          : "Meet Green Monkey: sales, tables, kitchen and cash management for your restaurant. Free plan and upcoming Pro with kiosk. Pricing in MXN.",
      );
  }, [locale, es]);
  const workspaces = [
    t("Vender", "Sell"),
    t("Cocina", "Kitchen"),
    t("Hoy", "Today"),
  ];
  const benefits = [
    {
      icon: ShoppingBag,
      n: "01",
      title: t("Una orden. Todo el contexto.", "One order. All the context."),
      body: t(
        "De la primera ronda a la cuenta dividida. Mesas, notas y pagos juntos, para seguir el ritmo del servicio.",
        "From the first round to a split bill. Tables, notes and payments together, keeping pace with service.",
      ),
    },
    {
      icon: ChefHat,
      n: "02",
      title: t(
        "Que cocina sepa qué sigue.",
        "Help the kitchen see what’s next.",
      ),
      body: t(
        "Tickets por estación y avances claros. Preparar una orden y cobrarla son pasos distintos, visibles para tu equipo.",
        "Station tickets and clear progress. Preparing an order and collecting payment are separate steps your team can see.",
      ),
    },
    {
      icon: ChartNoAxesCombined,
      n: "03",
      title: t("Cierra el día con respuestas.", "Close the day with answers."),
      body: t(
        "Revisa ventas, movimientos de caja y diferencias. Abre los registros detrás de cada resultado.",
        "Review sales, cash movements and discrepancies. Open the records behind each result.",
      ),
    },
  ];
  const freeFeatures = [
    t("Ventas y recibos", "Sales and receipts"),
    t("Mesas y cuentas divididas", "Tables and split payments"),
    t(
      "Efectivo y registro de terminal externa",
      "Cash and external terminal recording",
    ),
    t(
      "Efectivo sin conexión en sesiones autorizadas",
      "Offline cash for authorized sessions",
    ),
  ];
  const proFeatures = [
    t("Todo lo incluido en Free", "Everything in Free"),
    t("Kiosco y pedidos QR", "Kiosk and QR ordering"),
    t(
      "Inventario, recetas y compras avanzadas",
      "Advanced inventory, recipes and purchasing",
    ),
    t(
      "Márgenes, reportes y múltiples cajas",
      "Margins, reporting and multiple registers",
    ),
    t("Equipo sin cargo por empleado", "Team access without per-employee fees"),
  ];
  const faqs = [
    [
      t("¿Puedo empezar gratis?", "Can I start for free?"),
      t(
        "El plan Free no tiene fecha de vencimiento. Green Monkey está en beta: el acceso depende de la configuración de tu entorno. Los pilotos beta permanecen gratis hasta que los flujos Pro prometidos estén validados.",
        "The Free plan does not expire. Green Monkey is in beta: access depends on your environment’s configuration. Beta pilots stay free until the promised Pro workflows are qualified.",
      ),
    ],
    [
      t("¿Cómo funcionará la prueba Pro?", "How will the Pro trial work?"),
      t(
        `Al habilitarse, tendrás ${PRO_OFFER.trialDays} días desde la creación del restaurante, sin tarjeta. Al terminar, pasarás a Free si no eliges una suscripción. La prueba y los cobros de suscripción aún no están activos.`,
        `Once enabled, you’ll have ${PRO_OFFER.trialDays} days from restaurant creation, with no card required. You’ll return to Free unless you choose a subscription. Trials and subscription billing are not active yet.`,
      ),
    ],
    [
      t("¿Qué incluye el precio?", "What does the price include?"),
      t(
        "El software por restaurante, en MXN, más los impuestos aplicables. El hardware, las comisiones de procesamiento y los servicios con consumo, como IA o WhatsApp, se cotizan por separado. El pago anual se cobra completo por adelantado.",
        "Software per restaurant, in MXN, plus applicable taxes. Hardware, processing fees and metered services such as AI or WhatsApp are separate. Annual billing is paid in full upfront.",
      ),
    ],
    [
      t(
        "¿Qué pasa si se va el internet?",
        "What happens if the internet goes down?",
      ),
      t(
        "Una sesión autorizada puede seguir vendiendo sin internet: guarda cobros en efectivo o con terminal externa, imprime comandas desde el navegador y sincroniza al volver la conexión, durante su periodo permitido. No hay cobros integrados con tarjeta sin conexión.",
        "An authorized session can keep selling without internet: it saves cash or external-terminal payments, prints kitchen tickets from the browser and syncs when the connection returns, within its allowed period. There are no integrated offline card charges.",
      ),
    ],
    [
      t("¿El kiosco viene con Pro?", "Is kiosk included in Pro?"),
      t(
        "Sí. Kiosco y pedidos QR forman parte del plan Pro. El flujo web actual permite enviar pedidos para pagar en caja; el hardware y los pagos integrados requieren configuración y validación adicionales.",
        "Yes. Kiosk and QR ordering are part of Pro. The current web flow supports orders paid at the counter; hardware and integrated payments require additional setup and validation.",
      ),
    ],
  ];
  return (
    <div className="gm-site">
      <a className="gm-skip" href="#main">
        {t("Saltar al contenido", "Skip to content")}
      </a>
      <header className="gm-header gm-wrap">
        <a href="/" className="gm-logo" aria-label="Green Monkey">
          <BrandLogo />
        </a>
        <nav aria-label={t("Navegación principal", "Main navigation")}>
          <a href="#product">{t("Producto", "Product")}</a>
          <a href="#pricing">{t("Precios", "Pricing")}</a>
          <button
            className="gm-language"
            onClick={() => setLocale(es ? "en" : "es")}
            aria-label={t("Switch to English", "Cambiar a español")}
          >
            {es ? "EN" : "ES"}
          </button>
          <a className="gm-login" href="/app">
            {t("Entrar", "Sign in")}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <a className="gm-signup" href="/app?signup">
            {t("Crear cuenta", "Create account")}
          </a>
        </nav>
      </header>
      <main id="main">
        <section className="gm-hero gm-wrap" aria-labelledby="hero-heading">
          <div className="gm-hero-copy">
            <p className="gm-eyebrow">
              <span />
              {t(
                "HECHO PARA EL RITMO DE TU RESTAURANTE",
                "BUILT FOR THE PACE OF YOUR RESTAURANT",
              )}
            </p>
            <h1 id="hero-heading">
              {t("Menos vueltas.", "Less back and forth.")}
              <br />
              <em>{t("Más servicio.", "More service.")}</em>
            </h1>
            <p className="gm-lead">
              {t(
                "Ventas, mesas, cocina y caja en un mismo lugar. Dale orden a tu operación y atención a lo que importa: tus comensales.",
                "Sales, tables, kitchen and cash in one place. Bring order to your operation and attention to what matters: your guests.",
              )}
            </p>
            <div className="gm-actions">
              <a className="gm-cta" href="/app?signup">
                {t("Crear cuenta gratis", "Create a free account")}
                <ArrowRight size={18} aria-hidden="true" />
              </a>
              <a className="gm-text-link" href="#product">
                {t("Ver cómo funciona", "See how it works")}
                <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="gm-fine">
              {t(
                "En beta · Plan Free disponible · Pro próximamente",
                "In beta · Free plan available · Pro coming soon",
              )}
            </p>
          </div>
          <div className="gm-preview" id="product">
            <div className="gm-preview-top">
              <span>
                Green Monkey{" "}
                <span className="gm-demo-label">
                  {t("VISTA ILUSTRATIVA", "ILLUSTRATIVE PREVIEW")}
                </span>
              </span>
              <span className="gm-preview-dots" aria-hidden="true">
                •••
              </span>
            </div>
            <div
              className="gm-preview-tabs"
              role="group"
              aria-label={t("Vista del producto", "Product preview")}
            >
              {workspaces.map((label, i) => (
                <button
                  key={i}
                  aria-pressed={preview === i}
                  onClick={() => setPreview(i)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="gm-preview-body" aria-live="polite">
              <div className="gm-preview-heading">
                <div>
                  <small>
                    {t("RESTAURANTE DE EJEMPLO", "EXAMPLE RESTAURANT")}
                  </small>
                  <h2>
                    {preview === 0
                      ? t("Todo listo para servir.", "Ready to serve.")
                      : preview === 1
                        ? t(
                            "Cada ticket, en su lugar.",
                            "Every ticket in its place.",
                          )
                        : t("Tu día, a la vista.", "Your day, at a glance.")}
                  </h2>
                </div>
                <span className="gm-demo-badge">{t("Ejemplo", "Sample")}</span>
              </div>
              {preview === 0 ? (
                <>
                  <div className="gm-example-row">
                    <span>
                      {t("Mesa 04", "Table 04")}
                      <small>
                        {t(
                          "Para comer aquí · 2 personas",
                          "Dine in · 2 guests",
                        )}
                      </small>
                    </span>
                    <span>{t("Orden abierta", "Open order")}</span>
                  </div>
                  <div className="gm-food-row">
                    <span className="gm-food-icon" aria-hidden="true">
                      02
                    </span>
                    <span>
                      {t("Tacos de hongos", "Mushroom tacos")}
                      <small>{t("Sin cebolla", "No onion")}</small>
                    </span>
                    <strong>{money(9000)}</strong>
                  </div>
                  <div className="gm-food-row">
                    <span className="gm-food-icon gm-drink" aria-hidden="true">
                      01
                    </span>
                    <span>
                      {t("Agua de jamaica", "Hibiscus water")}
                      <small>{t("Sin hielo", "No ice")}</small>
                    </span>
                    <strong>{money(3500)}</strong>
                  </div>
                  <div className="gm-example-total">
                    <span>
                      Total <small>MXN</small>
                    </span>
                    <strong>{money(12500)}</strong>
                  </div>
                  <div className="gm-status-line">
                    <Check size={16} aria-hidden="true" />
                    {t(
                      "Estado de ejemplo: cocina recibió",
                      "Example status: kitchen acknowledged",
                    )}
                  </div>
                </>
              ) : preview === 1 ? (
                <div className="gm-kitchen-examples">
                  {[
                    t("En preparación", "Preparing"),
                    t("Listo para servir", "Ready to serve"),
                  ].map((label, i) => (
                    <div key={i}>
                      <span className="gm-kitchen-status">{label}</span>
                      <h3>
                        {t("Mesa", "Table")} {i ? "02" : "04"}
                      </h3>
                      <p>
                        {i
                          ? t("1 × Café americano", "1 × Americano")
                          : t("2 × Tacos de hongos", "2 × Mushroom tacos")}
                      </p>
                      <small>
                        {i
                          ? t("Sin azúcar", "No sugar")
                          : t("Sin cebolla · Ronda 1", "No onion · Round 1")}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="gm-today-example">
                  <small>
                    {t(
                      "VENTAS NETAS · DATOS FICTICIOS",
                      "NET SALES · FICTIONAL DATA",
                    )}
                  </small>
                  <strong>{money(428000)}</strong>
                  <div className="gm-bars" aria-hidden="true">
                    {[32, 48, 40, 74, 65, 92, 78].map((height, i) => (
                      <span key={i} style={{ height: `${height}%` }} />
                    ))}
                  </div>
                  <p>
                    {t(
                      "Del resultado al registro que lo explica.",
                      "From the result to the record behind it.",
                    )}
                  </p>
                </div>
              )}
            </div>
            <div className="gm-preview-footer">
              {t(
                "Una operación conectada, de principio a fin.",
                "One connected operation, from start to finish.",
              )}
            </div>
          </div>
        </section>
        <div className="gm-audience">
          <div className="gm-wrap">
            <span>
              {t(
                "EN LA BARRA. EN LA MESA. EN LA COCINA.",
                "AT THE COUNTER. AT THE TABLE. IN THE KITCHEN.",
              )}
            </span>
            <p>
              {t("Un mismo equipo. Un mismo sistema.", "One team. One system.")}
            </p>
          </div>
        </div>
        <section
          className="gm-workflow gm-wrap"
          aria-labelledby="workflow-heading"
        >
          <div className="gm-section-intro">
            <p className="gm-eyebrow">
              {t(
                "DEL PRIMER PEDIDO AL ÚLTIMO CORTE",
                "FROM FIRST ORDER TO FINAL CLOSE",
              )}
            </p>
            <h2 id="workflow-heading">
              {t("Cada parte del servicio,", "Every part of service,")}
              <br />
              {t("en su lugar.", "in its place.")}
            </h2>
          </div>
          <div className="gm-benefits">
            {benefits.map(({ icon: Icon, n, title, body }) => (
              <article key={n}>
                <div className="gm-benefit-top">
                  <Icon aria-hidden="true" />
                  <span>{n}</span>
                </div>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>
        <section
          className="gm-pricing-section"
          id="pricing"
          aria-labelledby="pricing-heading"
        >
          <div className="gm-wrap">
            <div className="gm-pricing-intro">
              <div>
                <p className="gm-eyebrow">
                  {t("ESPACIO PARA CRECER", "ROOM TO GROW")}
                </p>
                <h2 id="pricing-heading">
                  {t("Empieza simple.", "Start simple.")}
                  <br />
                  {t("Crece con Pro.", "Grow with Pro.")}
                </h2>
              </div>
              <div>
                <p>
                  {t(
                    "Precios por restaurante. En pesos mexicanos.",
                    "Per-restaurant pricing. In Mexican pesos.",
                  )}
                </p>
                <div
                  className="gm-billing-switch"
                  role="group"
                  aria-label={t("Periodo de facturación", "Billing period")}
                >
                  <button
                    aria-pressed={!annual}
                    onClick={() => setAnnual(false)}
                  >
                    {t("Mensual", "Monthly")}
                  </button>
                  <button aria-pressed={annual} onClick={() => setAnnual(true)}>
                    {t("Anual · 2 meses gratis", "Annual · 2 months free")}
                  </button>
                </div>
              </div>
            </div>
            <div className="gm-plan-grid">
              <article className="gm-plan">
                <span className="gm-plan-label">
                  {t("LO ESENCIAL", "THE ESSENTIALS")}
                </span>
                <h3>Free</h3>
                <p>
                  {t(
                    "Para empezar a poner orden.",
                    "Bring order to your everyday service.",
                  )}
                </p>
                <div className="gm-price">
                  {money(0)}
                  <span>MXN / {t("siempre", "forever")}</span>
                </div>
                <a className="gm-cta gm-outline" href="/app?signup">
                  {t("Crear cuenta gratis", "Create a free account")}
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
                <ul>
                  {freeFeatures.map((x) => (
                    <li key={x}>
                      <Check size={18} aria-hidden="true" />
                      {x}
                    </li>
                  ))}
                </ul>
              </article>
              <article className="gm-plan gm-pro">
                <span className="gm-plan-label">
                  {t(
                    "PRÓXIMAMENTE · PRECIO DE LANZAMIENTO",
                    "COMING SOON · LAUNCH PRICING",
                  )}
                </span>
                <h3>Pro</h3>
                <p>
                  {t(
                    "Más herramientas para tu siguiente etapa.",
                    "More tools for your next chapter.",
                  )}
                </p>
                <div className="gm-price" aria-live="polite">
                  {money(
                    annual ? PRO_OFFER.annualMinor : PRO_OFFER.monthlyMinor,
                  )}
                  <span>
                    MXN / {annual ? t("año", "year") : t("mes", "month")}
                  </span>
                </div>
                <p className="gm-price-note">
                  {annual
                    ? t(
                        `Un pago anual. Ahorra ${money(PRO_ANNUAL_SAVING_MINOR)} al año.`,
                        `One annual payment. Save ${money(PRO_ANNUAL_SAVING_MINOR)} per year.`,
                      )
                    : t(
                        "Por restaurante. Sin cargo por empleado.",
                        "Per restaurant. No per-employee fee.",
                      )}
                </p>
                <a className="gm-cta" href="#availability">
                  {t("Consultar disponibilidad", "Check availability")}
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
                <ul>
                  {proFeatures.map((x) => (
                    <li key={x}>
                      <Check size={18} aria-hidden="true" />
                      {x}
                    </li>
                  ))}
                </ul>
              </article>
            </div>
            <p className="gm-pricing-footnote">
              {t(
                "Impuestos aplicables adicionales. Hardware, comisiones de pago y servicios por consumo no incluidos.",
                "Applicable taxes are additional. Hardware, payment processing fees and metered services are not included.",
              )}
            </p>
            <div className="gm-availability" id="availability">
              <span className="gm-plan-label">
                {t("CONSTRUYENDO CONTIGO", "BUILDING WITH YOU")}
              </span>
              <h3>
                {t(
                  "Beta gratuita. Una prueba Pro cuando esté lista.",
                  "Free beta. A Pro trial when it’s ready.",
                )}
              </h3>
              <p>
                {t(
                  `La prueba de ${PRO_OFFER.trialDays} días sin tarjeta comenzará al crear tu restaurante cuando se habilite. Hoy las suscripciones y la prueba aún no están activas; algunas funciones avanzadas siguen en desarrollo. Los pilotos beta permanecen gratis hasta validar los flujos Pro prometidos.`,
                  `The ${PRO_OFFER.trialDays}-day trial without a card will start when you create your restaurant, once enabled. Subscriptions and trials are not active today; some advanced features remain in development. Beta pilots stay free until the promised Pro workflows are qualified.`,
                )}
              </p>
            </div>
          </div>
        </section>
        <section className="gm-faq gm-wrap" aria-labelledby="faq-heading">
          <div>
            <p className="gm-eyebrow">
              {t("ANTES DE EMPEZAR", "BEFORE YOU START")}
            </p>
            <h2 id="faq-heading">
              {t("Las cosas claras.", "Clear from the start.")}
            </h2>
          </div>
          <div>
            {faqs.map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="gm-final gm-wrap">
          <p className="gm-eyebrow">GREEN MONKEY</p>
          <h2>
            {t("Tu siguiente servicio,", "Your next service,")}
            <br />
            <em>{t("con más claridad.", "with more clarity.")}</em>
          </h2>
          <a className="gm-cta" href="/app?signup">
            {t("Crear cuenta gratis", "Create a free account")}
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>
      </main>
      <footer className="gm-footer gm-wrap">
        <a href="/" className="gm-logo">
          <BrandLogo />
        </a>
        <p>
          {t(
            "Hecho para quienes dan de comer.",
            "Made for the people who feed us.",
          )}
        </p>
        <a href="#pricing">{t("Planes y precios", "Plans and pricing")}</a>
      </footer>
    </div>
  );
}
