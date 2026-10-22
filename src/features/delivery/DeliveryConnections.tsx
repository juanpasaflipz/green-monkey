import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  DELIVERY_CONSENT,
  DELIVERY_NAMES,
  deliveryProvider,
  validDeliveryLiveUrl,
  type DeliveryProvider,
  type DeliveryState,
  type DeliveryView,
} from "../../../shared/delivery";
import { api } from "../../api";
import { dateTime } from "../../datetime";
import { Button } from "../../components/ui";
import "./delivery.css";

const copy = {
  es: {
    title: "Tus ventas de delivery, juntas",
    intro:
      "Conecta tus cuentas una vez. Actualizaremos tus ventas cada día, sin descargar archivos.",
    consent:
      "Autorizo a Green Monkey a conservar una sesión de acceso y obtener mis reportes de ventas y pagos automáticamente. Puedo desconectar la cuenta cuando quiera.",
    privacy:
      "El inicio de sesión se realiza en un navegador alojado por Browserbase. Escribe tu contraseña y los códigos de verificación únicamente en la página de la plataforma.",
    connect: "Conectar",
    reconnect: "Volver a conectar",
    disconnect: "Desconectar",
    open: "Abrir inicio de sesión",
    done: "Ya inicié sesión",
    select: "Confirmar tienda",
    store: "Tienda",
    soon: "Próximamente",
    pro: "Disponible con Pro",
    updated: "Última actualización",
    empty:
      "Tus primeras ventas aparecerán aquí después de conectar una tienda.",
    error: "No se pudo completar la acción. Inténtalo de nuevo.",
    retry: "Reintentar",
    review: "La conexión necesita atención. Tus últimos datos se conservan.",
    identity:
      "La plataforma devolvió otra tienda con el mismo nombre. Vuelve a conectar y confirma la tienda correcta; sus ventas se conservarán por separado.",
    expired: "La sesión de conexión terminó. Vuelve a conectar para continuar.",
    hint: "Inicia sesión, regresa aquí y selecciona «Ya inicié sesión». Puedes continuar usando Green Monkey mientras preparamos tus ventas.",
    figures: "Ventas reportadas por plataforma",
    incomplete:
      "Reporte pendiente de verificar. Se reintentará automáticamente; no se cuenta como cero ventas.",
    separate:
      "Importes provisionales por fecha local de la plataforma. Se muestran por separado de las ventas del POS para evitar duplicados.",
    day: "Fecha",
    orders: "Pedidos",
    sales: "Ventas después de ajustes",
    currency: "Moneda",
    source: "Plataforma",
    owner: "El propietario puede conectar las cuentas.",
    states: {
      disconnected: "Sin conectar",
      preparing: "Preparando conexión…",
      awaiting_login: "Inicia sesión para continuar",
      verifying: "Verificando tu cuenta…",
      choose_store: "Confirma tu tienda",
      syncing: "Preparando tus ventas…",
      connected: "Conectada",
      attention: "Necesita atención",
      disconnecting: "Desconectando…",
    },
  },
  en: {
    title: "Your delivery sales, together",
    intro:
      "Connect your accounts once. We’ll update sales every day, with no files to download.",
    consent:
      "I authorize Green Monkey to retain a sign-in session and retrieve my sales and payment reports automatically. I can disconnect anytime.",
    privacy:
      "Sign-in takes place in a browser hosted by Browserbase. Enter passwords and verification codes only on the platform’s own page.",
    connect: "Connect",
    reconnect: "Reconnect",
    disconnect: "Disconnect",
    open: "Open sign-in",
    done: "I’ve signed in",
    select: "Confirm store",
    store: "Store",
    soon: "Coming soon",
    pro: "Available with Pro",
    updated: "Last updated",
    empty: "Your first sales will appear here after you connect a store.",
    error: "We couldn’t complete that action. Please try again.",
    retry: "Retry",
    review:
      "This connection needs attention. Your last verified data is preserved.",
    identity:
      "The platform returned a different store with the same name. Reconnect and confirm the correct store; its sales will be kept separately.",
    expired: "The connection session ended. Reconnect to continue.",
    hint: "Sign in, return here, and select “I’ve signed in”. You can keep using Green Monkey while we prepare your sales.",
    figures: "Platform-reported sales",
    incomplete:
      "Report awaiting verification. We’ll retry automatically; this is not counted as zero sales.",
    separate:
      "Provisional figures by the platform’s local date. Shown separately from POS sales to avoid duplicates.",
    day: "Date",
    orders: "Orders",
    sales: "Sales after adjustments",
    currency: "Currency",
    source: "Platform",
    owner: "The owner can connect accounts.",
    states: {
      disconnected: "Not connected",
      preparing: "Preparing connection…",
      awaiting_login: "Sign in to continue",
      verifying: "Verifying your account…",
      choose_store: "Confirm your store",
      syncing: "Preparing your sales…",
      connected: "Connected",
      attention: "Needs attention",
      disconnecting: "Disconnecting…",
    },
  },
};

export function DeliveryConnections({
  session,
  locale,
  online,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
}) {
  const t = copy[locale],
    owner = session.role === "owner";
  const [view, setView] = useState<DeliveryView | null>(null),
    [error, setError] = useState(false),
    [busy, setBusy] = useState<DeliveryProvider | null>(null);
  const [consent, setConsent] = useState<
    Partial<Record<DeliveryProvider, boolean>>
  >({});
  const [choices, setChoices] = useState<
    Partial<Record<DeliveryProvider, string>>
  >({});
  const scope = useRef(session.tenantId);
  scope.current = session.tenantId;
  const load = useCallback(async () => {
    const tid = session.tenantId;
    try {
      const result = await api<DeliveryView>("/delivery");
      if (scope.current === tid) {
        setView(result);
        setError(false);
      }
    } catch {
      if (scope.current === tid) setError(true);
    }
  }, [session.tenantId]);
  useEffect(() => {
    setView(null);
    setConsent({});
    setChoices({});
    if (!online) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, online]);
  async function command(provider: DeliveryProvider, body: unknown) {
    if (busy) return;
    const tid = session.tenantId;
    setBusy(provider);
    setError(false);
    try {
      const result = await api<DeliveryView>(`/delivery/${provider}`, body);
      if (scope.current === tid) setView(result);
    } catch {
      if (scope.current === tid) setError(true);
    } finally {
      setBusy(null);
    }
  }
  async function open(provider: DeliveryProvider) {
    // Open synchronously to avoid popup blocking; never place a live URL in app navigation/history.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const { url } = await api<{ url: string }>(
        `/delivery/${provider}/login`,
        {},
      );
      if (!validDeliveryLiveUrl(url)) throw Error();
      if (!popup) throw Error();
      popup.location.replace(url);
    } catch {
      popup?.close();
      setError(true);
    }
  }
  return (
    <section
      className="panel delivery-connections"
      aria-labelledby="delivery-title"
    >
      <h2 id="delivery-title">{t.title}</h2>
      <p className="muted">{t.intro}</p>
      {error && (
        <p role="alert">
          {t.error}{" "}
          <Button onClick={() => void load()} disabled={!online}>
            {t.retry}
          </Button>
        </p>
      )}
      {!owner && <p>{t.owner}</p>}
      <div className="delivery-grid">
        {deliveryProvider.options.map((provider) => {
          const connection = view?.connections.find(
            (c) => c.provider === provider,
          );
          const state: DeliveryState = connection?.state ?? "disconnected";
          const available = Boolean(view?.available.includes(provider));
          const expired =
            state === "awaiting_login" &&
            connection?.loginExpiresAt &&
            Date.parse(connection.loginExpiresAt) <= Date.now();
          const storeId = choices[provider] ?? connection?.stores[0]?.id ?? "";
          return (
            <article className="delivery-card" key={provider}>
              <h3>{DELIVERY_NAMES[provider]}</h3>
              <p role="status">
                {!view
                  ? "…"
                  : !available && state === "disconnected"
                    ? t.soon
                    : t.states[state]}
              </p>
              {connection?.store && <strong>{connection.store.name}</strong>}
              {connection?.lastSyncedAt && (
                <p className="muted">
                  {t.updated}:{" "}
                  {dateTime(
                    connection.lastSyncedAt,
                    session.restaurant?.timezone,
                    locale,
                  )}
                </p>
              )}
              {state === "attention" && (
                <p>
                  {connection?.errorCode === "delivery_store_identity_changed"
                    ? t.identity
                    : t.review}
                </p>
              )}
              {owner &&
                available &&
                ["disconnected", "attention", "connected"].includes(state) && (
                  <>
                    {state !== "connected" && (
                      <label className="delivery-consent">
                        <input
                          type="checkbox"
                          checked={Boolean(consent[provider])}
                          onChange={(e) =>
                            setConsent({
                              ...consent,
                              [provider]: e.target.checked,
                            })
                          }
                        />
                        <span>{t.consent}</span>
                      </label>
                    )}
                    {state !== "connected" && (
                      <Button
                        variant="primary"
                        disabled={
                          !online ||
                          Boolean(busy) ||
                          !consent[provider] ||
                          !view?.pro
                        }
                        onClick={() =>
                          void command(provider, {
                            action: "connect",
                            consent: DELIVERY_CONSENT,
                          })
                        }
                      >
                        {state === "attention" ? t.reconnect : t.connect}
                      </Button>
                    )}
                    {!view?.pro && <p>{t.pro}</p>}
                  </>
                )}
              {owner && state === "awaiting_login" && connection && (
                <>
                  <p>{expired ? t.expired : t.hint}</p>
                  {!expired && (
                    <>
                      <p className="muted">{t.privacy}</p>
                      <Button
                        variant="primary"
                        onClick={() => void open(provider)}
                        disabled={!online || Boolean(busy)}
                      >
                        {t.open}
                      </Button>
                      <Button
                        onClick={() =>
                          void command(provider, {
                            action: "verify",
                            generation: connection.generation,
                          })
                        }
                        disabled={!online || Boolean(busy)}
                      >
                        {t.done}
                      </Button>
                    </>
                  )}
                </>
              )}
              {owner && state === "choose_store" && connection && (
                <>
                  <label className="field">
                    <span>{t.store}</span>
                    <select
                      value={storeId}
                      onChange={(e) =>
                        setChoices({ ...choices, [provider]: e.target.value })
                      }
                    >
                      {connection.stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="primary"
                    disabled={!online || Boolean(busy) || !storeId}
                    onClick={() =>
                      void command(provider, {
                        action: "select",
                        generation: connection.generation,
                        storeId,
                      })
                    }
                  >
                    {t.select}
                  </Button>
                </>
              )}
              {owner && state !== "disconnected" && (
                <Button
                  variant="ghost"
                  disabled={
                    !online ||
                    Boolean(busy) ||
                    (state === "disconnecting" && !connection?.errorCode)
                  }
                  onClick={() =>
                    void command(provider, { action: "disconnect" })
                  }
                >
                  {t.disconnect}
                </Button>
              )}
            </article>
          );
        })}
      </div>
      <h3>{t.figures}</h3>
      <p className="muted">{t.separate}</p>
      {view?.issues?.map((issue) => (
        <p key={`${issue.provider}:${issue.day}`} role="status">
          {DELIVERY_NAMES[issue.provider]} · {issue.day}: {t.incomplete}
        </p>
      ))}
      {!view?.days.length ? (
        <p>{t.empty}</p>
      ) : (
        <div className="delivery-table">
          <table>
            <thead>
              <tr>
                <th>{t.source}</th>
                <th>{t.day}</th>
                <th>{t.orders}</th>
                <th>{t.sales}</th>
              </tr>
            </thead>
            <tbody>
              {view.days.map((d) => (
                <tr key={`${d.provider}:${d.day}`}>
                  <td>{DELIVERY_NAMES[d.provider]}</td>
                  <td>{d.day}</td>
                  <td>{d.orderCount}</td>
                  <td>
                    {new Intl.NumberFormat(locale, {
                      style: "currency",
                      currency: d.currency,
                    }).format(d.adjusted / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
