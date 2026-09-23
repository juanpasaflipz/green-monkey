import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { Button, Field } from "../components/ui";
import { changeRestaurant, db } from "../offline";
import { clearSessionScope } from "../api";
import { OwnerManagement } from "./OwnerManagement";

type Account = {
  name: string;
  email: string;
  csrf: string;
  organizations: { id: string; name: string }[];
  restaurants: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    activation_pending: boolean;
    free_location: boolean;
    organization_id: string;
  }[];
};
const copy = {
  es: {
    google: "Continuar con Google",
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
  const [authError] = useState(
    new URLSearchParams(location.search).has("auth_error"),
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
      setGoogle(providers.google);
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
      throw Error();
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
      setTransitionError(
        (error as Error).message === "pending_before_switch"
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
  if (loading && !account) return <p role="status">{t.loading}</p>;
  return (
    <section className="owner-access" aria-label={t.title}>
      {authError && (
        <p role="alert" className="error">
          {t.authError}
        </p>
      )}
      {failed && (
        <div role="alert">
          <p className="error">{invalid ? t.invalid : t.error}</p>
          <Button onClick={() => void refresh()}>{t.retry}</Button>
        </div>
      )}
      {transitionError && <p role="alert">{transitionError}</p>}
      {!account && google && (
        <a className="button full" href="/api/auth/google/start">
          {t.google}
        </a>
      )}
      {account && (
        <>
          <h2>{t.title}</h2>
          <p>{account.email}</p>
          {invitation && (
            <div className="panel">
              <p>
                {locale === "es"
                  ? "Tienes una invitación. Acéptala con la cuenta de Google que recibió el enlace."
                  : "You have an invitation. Accept with the Google account the link was intended for."}
              </p>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await command("invitations/accept", { token: invitation });
                    sessionStorage.removeItem("gm-invitation");
                    setInvitation("");
                    await refresh();
                  } catch {
                    setFailed(true);
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
              billingSandbox={billingSandbox}
              refresh={refresh}
            />
          )}
          {!account.organizations?.length && (
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
              <Button
                type="submit"
                disabled={busy}
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
