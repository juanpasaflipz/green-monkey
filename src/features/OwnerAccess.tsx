import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { Button, Field } from "../components/ui";
import { changeRestaurant, db } from "../offline";
import { clearSessionScope } from "../api";
import { OwnerManagement } from "./OwnerManagement";
import { strings, translateError } from "../i18n";
import { AccountCenter } from "./AccountCenter";
import { LegalAcceptance, type LegalAccepted } from "./LegalAcceptance";
import { loadAccountConfig, type AccountConfig } from "./accountConfig";
import { legalText } from "../../shared/legal";

type Account = {
  name: string;
  email: string;
  csrf: string;
  organizations: { id: string; name: string; role: "primary" | "co_owner" }[];
  restaurants: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    activation_pending: boolean;
    free_location: boolean;
    organization_id: string;
  }[];
  legal?: { status: string; pending: Array<"terms" | "privacy"> };
};
type InvitationPreview = {
  role: string;
  restaurantName: string;
  organizationName: string;
  expiresAt: string;
  emailMatches: boolean;
};
const copy = {
  es: {
    google: "Continuar con Google",
    signupTitle: "Crear cuenta",
    signupHint:
      "¿Nuevo en Green Monkey? Crea tu restaurante gratis con tu cuenta de Google. Si ya tienes cuenta, entras con el mismo botón.",
    signupUnavailable:
      "La creación de cuentas con Google no está configurada en este entorno.",
    or: "o vincula este dispositivo con un código",
    title: "Tu restaurante",
    name: "Nombre del restaurante",
    currency: "Moneda",
    timezone: "Zona horaria",
    cutoff: "Inicio del día operativo",
    days: "Días de apertura",
    settings: "Moneda y horario",
    invalid: "Revisa la zona horaria y selecciona al menos un día de apertura.",
    create: "Crear restaurante gratis",
    enter: "Entrar",
    logout: "Cerrar sesión de cuenta",
    free: "Plan Free. La prueba Pro aún no está disponible; no se solicitará tarjeta ni se hará ningún cobro.",
    error:
      "No se pudo completar la solicitud. Revisa tu conexión e inténtalo de nuevo.",
    authError:
      "No se pudo verificar el acceso con Google. Inicia sesión de nuevo.",
    busy: "Guardando…",
    loading: "Cargando cuenta…",
    retry: "Reintentar",
    week: [
      "Lunes",
      "Martes",
      "Miércoles",
      "Jueves",
      "Viernes",
      "Sábado",
      "Domingo",
    ],
  },
  en: {
    google: "Continue with Google",
    signupTitle: "Create account",
    signupHint:
      "New to Green Monkey? Create your restaurant for free with your Google account. If you already have an account, the same button signs you in.",
    signupUnavailable: "Google account creation is not configured here.",
    or: "or pair this device with a code",
    title: "Your restaurant",
    name: "Restaurant name",
    currency: "Currency",
    timezone: "Time zone",
    cutoff: "Business day starts at",
    days: "Opening days",
    settings: "Currency and hours",
    invalid: "Check the time zone and select at least one opening day.",
    create: "Create free restaurant",
    enter: "Enter",
    logout: "Sign out of account",
    free: "Free plan. The Pro trial is not available yet; no card is requested and no charge will be made.",
    error:
      "The request could not be completed. Check your connection and try again.",
    authError: "Google sign-in could not be verified. Please sign in again.",
    busy: "Saving…",
    loading: "Loading account…",
    retry: "Retry",
    week: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
  },
};
export function OwnerAccess({
  locale,
  onReady,
  onAccount,
}: {
  locale: Locale;
  onReady: () => Promise<void>;
  onAccount: (active: boolean) => void;
}) {
  const t = copy[locale];
  const [account, setAccount] = useState<Account | null>(null);
  const [google, setGoogle] = useState(false);
  // GAP-2: on a shared terminal the owner's Google account is never offered.
  const [terminal, setTerminal] = useState(
    new URLSearchParams(location.search).get("auth_error") === "terminal",
  );
  const [billingSandbox, setBillingSandbox] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [transitionError, setTransitionError] = useState("");
  const [invitation, setInvitation] = useState(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get("invite");
    if (token) {
      sessionStorage.setItem("gm-invitation", token);
      history.replaceState(null, "", location.pathname + location.search);
    }
    return token ?? sessionStorage.getItem("gm-invitation") ?? "";
  });
  // account (031): an ownership transfer link (#transfer=…) waits for the
  // target's Google sign-in like an invitation does.
  const [transferToken, setTransferToken] = useState(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get("transfer");
    if (token) {
      sessionStorage.setItem("gm-transfer", token);
      history.replaceState(null, "", location.pathname + location.search);
    }
    return token ?? sessionStorage.getItem("gm-transfer") ?? "";
  });
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [inviteLegal, setInviteLegal] = useState<LegalAccepted | null>(null);
  const [signupLegal, setSignupLegal] = useState<LegalAccepted | null>(null);
  const [wantsSignup] = useState(() =>
    new URLSearchParams(location.search).has("signup"),
  );
  const [authError] = useState(
    new URLSearchParams(location.search).get("auth_error") ?? "",
  );
  async function refresh() {
    setLoading(true);
    setFailed(false);
    try {
      const [providerResponse, accountResponse] = await Promise.all([
        fetch("/api/auth/providers"),
        fetch("/api/auth/account"),
      ]);
      if (
        !providerResponse.ok ||
        (!accountResponse.ok && accountResponse.status !== 401)
      )
        throw Error();
      const providers = await providerResponse.json();
      setConfig(await loadAccountConfig().catch(() => null));
      setGoogle(providers.google);
      if (providers.terminal) setTerminal(true);
      setBillingSandbox(providers.billingSandbox === true);
      const value = accountResponse.ok ? await accountResponse.json() : null;
      setAccount(value);
      onAccount(Boolean(value));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!account || !invitation) return;
    fetch("/api/auth/account-center/invitations/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": account.csrf,
      },
      body: JSON.stringify({ token: invitation }),
    })
      .then(async (r) => (r.ok ? setPreview(await r.json()) : setPreview(null)))
      .catch(() => setPreview(null));
  }, [account?.csrf, invitation]);
  async function command(path: string, body: unknown) {
    const response = await fetch("/api/auth/account/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": account?.csrf ?? "",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      setInvalid(error.error === "invalid_input");
      if (error.error === "device_is_terminal") setTerminal(true);
      throw Error(error.error ?? "");
    }
    return response.json();
  }
  async function enter(tenantId: string) {
    setBusy(true);
    setTransitionError("");
    setFailed(false);
    try {
      await changeRestaurant(tenantId, () => command("enter", { tenantId }));
      await onReady();
    } catch (error) {
      const code = (error as Error).message;
      if (code === "owner_reauth_required") {
        // The device was unpaired after this Google sign-in, which the server
        // has now ended: show the Google sign-in again (A6).
        setTransitionError(translateError(code, locale));
        await refresh();
        return;
      }
      setTransitionError(
        code === "pending_before_switch"
          ? locale === "es"
            ? "Sincroniza o resuelve las ventas pendientes antes de cambiar de restaurante."
            : "Sync or resolve pending sales before switching restaurants."
          : locale === "es"
            ? "No se pudo entrar. Revisa la conexión y la activación de la sucursal."
            : "Could not enter. Check your connection and location activation.",
      );
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  if (terminal)
    return (
      <section className="owner-access" aria-label={t.title}>
        <p role="status">{strings[locale].accessTerminalNoGoogle}</p>
      </section>
    );
  if (loading && !account) return <p role="status">{t.loading}</p>;
  return (
    <section className="owner-access" aria-label={t.title}>
      {authError && authError !== "terminal" && (
        <p role="alert" className="error">
          {authError === "signup_paused"
            ? strings[locale].accountSignupPaused
            : t.authError}
        </p>
      )}
      {failed && (
        <div role="alert">
          <p className="error">{invalid ? t.invalid : t.error}</p>
          <Button onClick={() => void refresh()}>{t.retry}</Button>
        </div>
      )}
      {transitionError && <p role="alert">{transitionError}</p>}
      {!account && (google || wantsSignup) && (
        <div className="signup-cta">
          <h2>{t.signupTitle}</h2>
          <p className="muted">
            {!google
              ? t.signupUnavailable
              : config && !config.legal.signupOpen
                ? strings[locale].accountSignupPaused
                : t.signupHint}
          </p>
          {google && (
            <a
              className={`button full ${wantsSignup ? "primary" : ""}`}
              href="/api/auth/google/start"
              aria-describedby="signup-privacy-notice"
            >
              {config && !config.legal.signupOpen
                ? strings[locale].accountGoogleExisting
                : t.google}
            </a>
          )}
          {google && config && config.legal.signupOpen && (
            <p id="signup-privacy-notice" className="muted signup-notice">
              {config.legal.status === "published" && config.legal.entity
                ? legalText(
                    strings[locale].accountSimplifiedNotice
                      .replace("{entity}", "{{entity.name}}")
                      .replace("{email}", "{{entity.privacyContactEmail}}"),
                    config.legal.entity,
                    locale,
                  )
                : strings[locale].accountSimplifiedNoticeDraft}{" "}
              <a href={locale === "es" ? "/legal/privacidad" : "/legal/privacy"}>
                {strings[locale].accountLegalPrivacy}
              </a>
              {" · "}
              <a href={locale === "es" ? "/legal/terminos" : "/legal/terms"}>
                {strings[locale].accountLegalTerms}
              </a>
            </p>
          )}
          <p className="signup-divider">
            <span>{t.or}</span>
          </p>
        </div>
      )}
      {account && (
        <>
          <h2>{t.title}</h2>
          <p>{account.email}</p>
          {invitation && (
            <div className="panel">
              <p>
                {preview
                  ? preview.role === "co_owner"
                    ? strings[locale].accountCoOwnerInvited.replace(
                        "{org}",
                        preview.organizationName,
                      )
                    : strings[locale].accountInvitedAs
                        .replace(
                          "{role}",
                          strings[locale][
                            preview.role as "manager" | "cashier" | "server" | "kitchen"
                          ] ?? preview.role,
                        )
                        .replace("{restaurant}", preview.restaurantName)
                  : locale === "es"
                    ? "Tienes una invitación. Acéptala con la cuenta de Google que recibió el enlace."
                    : "You have an invitation. Accept with the Google account the link was intended for."}
              </p>
              {preview && !preview.emailMatches && (
                <p role="alert">{strings[locale].accountInvitationEmailMismatch}</p>
              )}
              {config &&
                config.legal.status === "published" &&
                !!account.legal?.pending.length && (
                  <LegalAcceptance
                    mode="invitation"
                    config={config}
                    locale={locale}
                    onChange={setInviteLegal}
                  />
                )}
              <Button
                disabled={
                  busy ||
                  (config?.legal.status === "published" &&
                    !!account.legal?.pending.length &&
                    !inviteLegal)
                }
                onClick={async () => {
                  setBusy(true);
                  try {
                    await command("invitations/accept", {
                      token: invitation,
                      locale,
                      ...(inviteLegal
                        ? {
                            legalAccepted: {
                              terms: inviteLegal.terms,
                              privacy: inviteLegal.privacy,
                            },
                          }
                        : {}),
                    });
                    sessionStorage.removeItem("gm-invitation");
                    setInvitation("");
                    setPreview(null);
                    await refresh();
                  } catch (error) {
                    setTransitionError(
                      translateError((error as Error).message, locale),
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {locale === "es" ? "Aceptar invitación" : "Accept invitation"}
              </Button>
            </div>
          )}
          {account.restaurants.map((r) => (
            <div className="row between" key={r.id}>
              <div>
                <strong>{r.name}</strong>
                <p className="muted">
                  {r.currency} · {r.timezone}
                </p>
              </div>
              <Button
                disabled={busy || r.activation_pending}
                variant="primary"
                onClick={() => void enter(r.id)}
              >
                {r.activation_pending
                  ? locale === "es"
                    ? "Activación pendiente"
                    : "Activation pending"
                  : t.enter}
              </Button>
            </div>
          ))}
          {!!account.organizations?.length && (
            <OwnerManagement
              locale={locale}
              csrf={account.csrf}
              restaurants={account.restaurants.filter((r) =>
                account.organizations.some((o) => o.id === r.organization_id),
              )}
              roles={Object.fromEntries(
                account.organizations.map((o) => [o.id, o.role]),
              )}
              config={config}
              billingSandbox={billingSandbox}
              refresh={refresh}
            />
          )}
          <AccountCenter
            locale={locale}
            csrf={account.csrf}
            config={config}
            refresh={refresh}
            transferToken={transferToken}
            clearTransferToken={() => {
              sessionStorage.removeItem("gm-transfer");
              setTransferToken("");
            }}
          />
          {config && !config.legal.signupOpen &&
            !account.organizations?.some((o) => o.role === "primary") && (
              <p role="status" className="muted">
                {strings[locale].accountSignupPaused}
              </p>
            )}
          {(!config || config.legal.signupOpen) &&
            !account.organizations?.some((o) => o.role === "primary") && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setBusy(true);
                setFailed(false);
                const [hours, minutes] = String(f.get("cutoff"))
                  .split(":")
                  .map(Number);
                try {
                  const result = await command("signup", {
                    trialRequested:
                      billingSandbox && f.get("trialRequested") === "on",
                    restaurantName: f.get("restaurantName"),
                    currency: f.get("currency"),
                    timezone: f.get("timezone"),
                    cutoff: hours * 60 + minutes,
                    openingDays: f.getAll("openingDays").map(Number),
                    locale,
                    ...(signupLegal ? { legalAccepted: signupLegal } : {}),
                  });
                  await enter(result.tenantId);
                } catch {
                  setFailed(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label={t.name}>
                <input
                  name="restaurantName"
                  maxLength={100}
                  required
                  autoComplete="organization"
                />
              </Field>
              <details open={invalid || undefined}>
                <summary>{t.settings}</summary>
                <Field label={t.currency}>
                  <select name="currency" defaultValue="MXN">
                    <option>MXN</option>
                    <option>USD</option>
                    <option>EUR</option>
                  </select>
                </Field>
                <Field label={t.timezone}>
                  <input
                    name="timezone"
                    defaultValue="America/Mexico_City"
                    required
                    list="owner-timezones"
                  />
                </Field>
                <datalist id="owner-timezones">
                  <option value="America/Mexico_City" />
                  <option value="America/Cancun" />
                  <option value="America/Tijuana" />
                  <option value="America/New_York" />
                  <option value="Europe/Madrid" />
                </datalist>
                <Field label={t.cutoff}>
                  <input
                    name="cutoff"
                    type="time"
                    defaultValue="04:00"
                    required
                  />
                </Field>
                <fieldset>
                  <legend>{t.days}</legend>
                  {t.week.map((name, i) => (
                    <label className="opening-day" key={name}>
                      <input
                        type="checkbox"
                        name="openingDays"
                        value={i + 1}
                        defaultChecked
                      />
                      {name}
                    </label>
                  ))}
                </fieldset>
              </details>
              {billingSandbox ? (
                <label className="opening-day">
                  <input type="checkbox" name="trialRequested" defaultChecked />
                  {locale === "es"
                    ? "Prueba Pro de 14 días sin tarjeta (sandbox). Desmarca para continuar en Free. Si la activación tarda, puedes seguir usando tu restaurante."
                    : "14-day Pro trial without a card (sandbox). Uncheck to continue on Free. You can keep using your restaurant while activation is pending."}
                </label>
              ) : (
                <p className="muted">{t.free}</p>
              )}
              {config && (
                <LegalAcceptance
                  mode="signup"
                  config={config}
                  locale={locale}
                  onChange={setSignupLegal}
                />
              )}
              <Button
                type="submit"
                disabled={busy || !config || !signupLegal}
                variant="primary"
                className="full"
              >
                {busy ? t.busy : t.create}
              </Button>
            </form>
          )}
          <Button
            disabled={busy}
            variant="ghost"
            onClick={async () => {
              setBusy(true);
              try {
                await command("logout", {});
                clearSessionScope();
                await db.cache.delete("session");
                localStorage.setItem(
                  "gm-session-generation",
                  crypto.randomUUID(),
                );
                setAccount(null);
                onAccount(false);
                await onReady();
              } catch {
                setFailed(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.logout}
          </Button>
        </>
      )}
    </section>
  );
}
