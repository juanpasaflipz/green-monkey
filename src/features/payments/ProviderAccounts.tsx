import { useEffect, useId, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import type {
  CredentialsSaved,
  Provider,
  ProviderAccountView,
  ProvidersView,
  TerminalKind,
} from "../../../shared/payments";
import { api } from "../../api";
import { Button, Field } from "../../components/ui";
import { strings, errorNotice, translateError, type Key } from "../../i18n";
import { dateTime } from "../../datetime";

export const PROVIDER_NAMES: Record<Provider, string> = {
  mercadopago: "Mercado Pago",
  clip: "Clip",
};
const KIND_OF: Record<Provider, TerminalKind> = {
  mercadopago: "mercadopago_point",
  clip: "clip_pinpad",
};

/**
 * Configuración → Mercado Pago and Clip (payments 037, P2; spec §5.2). Managers see each account's
 * state, find the provider's devices ("Buscar terminales"), add one as a terminal and switch an MP
 * device between Integrado (PDV) and Independiente (step-up, restart warning). Only the owner
 * connects, replaces or disconnects credentials (step-up: api() asks for the PIN and retries).
 * The credentials go to the server once and are never shown again; the notification URL is shown
 * once, right after the save, with Copiar.
 */
export function ProviderAccounts({
  session,
  locale,
  online,
  onAddTerminal,
  onTestCharge,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  /** Prefills Configuración's terminal form with a found device. */
  onAddTerminal: (kind: TerminalKind, deviceId: string) => void;
  /** "Cobro de prueba": opens Venta. */
  onTestCharge?: () => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const owner = session.role === "owner";
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [saved, setSaved] = useState<CredentialsSaved | null>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState<Provider | null>(null);
  const ids = useId();

  async function load() {
    try {
      setView(await api<ProvidersView>("/payments/providers"));
      setError("");
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  useEffect(() => {
    if (online) void load();
  }, [session.id, online]);
  // While an account verifies or a device search runs, refresh every 3 s (the worker is quick).
  const waiting =
    !!view?.accounts.some((a) => a.state === "verifying") ||
    status === t("payDevicesRequested");
  useEffect(() => {
    if (!online || !waiting) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [online, waiting]);
  // A device search answers within seconds; stop refreshing for it after 30 s.
  useEffect(() => {
    if (status !== t("payDevicesRequested")) return;
    const timer = setTimeout(() => setStatus(""), 30_000);
    return () => clearTimeout(timer);
  }, [status]);

  async function run(fn: () => Promise<unknown>, done = "") {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await fn();
      await load();
      if (done) setStatus(done);
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  function connect(provider: Provider) {
    const body =
      provider === "mercadopago"
        ? { accessToken: first.trim(), webhookSecret: second.trim() }
        : { apiKey: first.trim(), secretKey: second.trim() };
    void run(async () => {
      const reply = await api<CredentialsSaved>(
        `/payments/providers/${provider}/credentials`,
        body,
      );
      // The plaintext leaves the page's state at once; only the one-time URL stays.
      setFirst("");
      setSecond("");
      setConnecting(null);
      setCopied(false);
      setSaved(reply);
    });
  }
  function stateLine(a: ProviderAccountView) {
    if (!a.available) return t("payProviderUnavailable");
    switch (a.state) {
      case "not_connected":
        return t("payAccountNotConnected");
      case "verifying":
        return t("payAccountVerifying");
      case "active":
        return t("payAccountActive")
          .replace("{account}", a.label ?? PROVIDER_NAMES[a.provider])
          .replace(
            "{date}",
            a.verifiedAt
              ? dateTime(a.verifiedAt, session.restaurant.timezone, locale)
              : "—",
          );
      case "failed":
        return t("payAccountFailed").replace(
          "{reason}",
          translateError(
            a.errorCode ?? "payments_credentials_rejected",
            locale,
          ),
        );
      case "disabled":
        return t("payAccountDisabled");
    }
  }
  const statusText = (s: string | null) =>
    s === "active"
      ? t("payTerminalOnline")
      : s === "inactive" || s === "expired"
        ? t("payTerminalOffline")
        : t("payTerminalNoData");

  if (!view)
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : null;
  return (
    <div className="payment-providers">
      <h3>{t("payProviders")}</h3>
      <p className="muted">{t("payProvidersHint")}</p>
      {!owner && <p className="muted tiny">{t("payOwnerOnly")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}
      {saved && (
        <div className="warning-panel" role="status">
          <p>
            <strong>{t("payWebhookUrl")}</strong> ·{" "}
            {PROVIDER_NAMES[saved.provider]}
          </p>
          <Field label={t("payWebhookUrl")}>
            <input readOnly value={saved.webhookUrl} />
          </Field>
          <p>{t("payWebhookUrlOnce")}</p>
          {saved.provider === "clip" && (
            // Clip takes the URL with every charge (webhook_url): nothing to paste (P2-UX-11).
            <p>{t("payWebhookClipNoPaste")}</p>
          )}
          <div className="row wrap">
            <Button
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(saved.webhookUrl)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? t("payCopied") : t("payCopy")}
            </Button>
            <Button onClick={() => setSaved(null)}>{t("close")}</Button>
          </div>
        </div>
      )}
      {view.accounts.map((a) => {
        const name = PROVIDER_NAMES[a.provider];
        const devices = view.devices.filter((d) => d.provider === a.provider);
        const connected = a.state === "active";
        const formId = `${ids}-${a.provider}`;
        return (
          <section
            key={a.provider}
            className="payment-provider"
            aria-labelledby={`${formId}-title`}
          >
            <h4 id={`${formId}-title`}>{name}</h4>
            <p>
              <span className="muted">{t("payAccountState")}: </span>
              {stateLine(a)}
            </p>
            {owner && a.available && (
              <div className="row wrap">
                {connecting !== a.provider && (
                  <Button
                    disabled={busy || !online}
                    onClick={() => {
                      setConnecting(a.provider);
                      setFirst("");
                      setSecond("");
                      setSaved(null);
                    }}
                  >
                    {a.state === "not_connected" || a.state === "disabled"
                      ? t(
                          a.provider === "mercadopago"
                            ? "payMpConnect"
                            : "payClipConnect",
                        )
                      : t("payReplaceCredentials")}
                  </Button>
                )}
                {a.state !== "not_connected" && a.state !== "disabled" && (
                  <Button
                    variant="danger"
                    disabled={busy || !online}
                    onClick={() => {
                      if (
                        !window.confirm(
                          t("payDisconnectConfirm").replace("{provider}", name),
                        )
                      )
                        return;
                      void run(() =>
                        api(`/payments/providers/${a.provider}/disable`, {}),
                      );
                    }}
                  >
                    {t("payDisconnect")}
                  </Button>
                )}
              </div>
            )}
            {owner && connecting === a.provider && (
              <form
                className="payment-credentials"
                aria-label={t(
                  a.provider === "mercadopago"
                    ? "payMpConnect"
                    : "payClipConnect",
                )}
                onSubmit={(e) => {
                  e.preventDefault();
                  connect(a.provider);
                }}
              >
                <p className="muted tiny">
                  {t(
                    a.provider === "mercadopago"
                      ? "payMpSteps"
                      : "payClipSteps",
                  )}
                </p>
                <Field
                  label={t(
                    a.provider === "mercadopago"
                      ? "payMpAccessToken"
                      : "payClipApiKey",
                  )}
                >
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={first}
                    disabled={busy}
                    onChange={(e) => setFirst(e.target.value)}
                  />
                </Field>
                <Field
                  label={t(
                    a.provider === "mercadopago"
                      ? "payMpWebhookSecret"
                      : "payClipSecret",
                  )}
                >
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={second}
                    disabled={busy}
                    onChange={(e) => setSecond(e.target.value)}
                  />
                </Field>
                <p className="muted tiny">
                  {t("payCredentialsHidden")} {t("payRotateHint")}
                </p>
                <div className="row wrap">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      busy || !online || !first.trim() || !second.trim()
                    }
                  >
                    {t("payConnect")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setConnecting(null);
                      setFirst("");
                      setSecond("");
                    }}
                  >
                    {t("cancel")}
                  </Button>
                </div>
              </form>
            )}
            {connected && (
              <>
                <div className="row wrap">
                  <Button
                    disabled={busy || !online}
                    onClick={() =>
                      void run(
                        () =>
                          api(
                            `/payments/providers/${a.provider}/devices/refresh`,
                            {},
                          ),
                        t("payDevicesRequested"),
                      )
                    }
                  >
                    {t(
                      a.provider === "mercadopago"
                        ? "payFindDevices"
                        : "payFindReaders",
                    )}
                  </Button>
                  <Button
                    aria-expanded={testing === a.provider}
                    onClick={() =>
                      setTesting(testing === a.provider ? null : a.provider)
                    }
                  >
                    {t("payTestCharge")}
                  </Button>
                </div>
                {testing === a.provider && (
                  <div className="notice" role="status">
                    <p>{t("payTestChargeHint").replace("{terminal}", name)}</p>
                    {onTestCharge && (
                      <Button disabled={!online} onClick={onTestCharge}>
                        {t("payTestChargeOpen")}
                      </Button>
                    )}
                  </div>
                )}
                {devices.length ? (
                  <div
                    className="data-table"
                    role="region"
                    aria-label={`${t("payDevices")} · ${name}`}
                    tabIndex={0}
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>{t("payDeviceSerial")}</th>
                          {a.provider === "mercadopago" ? (
                            <th>{t("payDeviceMode")}</th>
                          ) : (
                            <th>{t("payDeviceStatus")}</th>
                          )}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {devices.map((d) => (
                          <tr key={d.deviceId}>
                            <td>{d.deviceId}</td>
                            <td>
                              {a.provider === "mercadopago"
                                ? d.operatingMode === "PDV"
                                  ? t("payModePdv")
                                  : d.operatingMode === "STANDALONE"
                                    ? t("payModeStandalone")
                                    : "—"
                                : statusText(d.status)}
                            </td>
                            <td>
                              <div className="row wrap">
                                {d.terminalId ? (
                                  <span className="muted">
                                    {t("payDeviceConfigured")}
                                  </span>
                                ) : (
                                  <Button
                                    disabled={busy || !online}
                                    onClick={() =>
                                      onAddTerminal(
                                        KIND_OF[a.provider],
                                        d.deviceId,
                                      )
                                    }
                                  >
                                    {t("payDeviceAdd")}
                                  </Button>
                                )}
                                {a.provider === "mercadopago" &&
                                  d.operatingMode && (
                                    <Button
                                      disabled={busy || !online}
                                      aria-label={`${t(d.operatingMode === "PDV" ? "payModeToStandalone" : "payModeToPdv")} · ${d.deviceId}`}
                                      onClick={() =>
                                        // The target is named, and the restart asked for first (P2-UX-10).
                                        window.confirm(
                                          `${t(d.operatingMode === "PDV" ? "payModeToStandalone" : "payModeToPdv")}? ${t("payModeRestart")}`,
                                        ) &&
                                        void run(
                                          () =>
                                            api(
                                              `/payments/providers/mercadopago/devices/${encodeURIComponent(d.deviceId)}/mode`,
                                              {
                                                operationId:
                                                  crypto.randomUUID(),
                                                mode:
                                                  d.operatingMode === "PDV"
                                                    ? "STANDALONE"
                                                    : "PDV",
                                              },
                                            ),
                                          t("payModeRequested").replace(
                                            "{restart}",
                                            t("payModeRestart"),
                                          ),
                                        )
                                      }
                                    >
                                      {t(
                                        d.operatingMode === "PDV"
                                          ? "payModeToStandalone"
                                          : "payModeToPdv",
                                      )}
                                    </Button>
                                  )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">{t("payDevicesEmpty")}</p>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
