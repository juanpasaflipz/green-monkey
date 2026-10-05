import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Locale } from "../../shared/domain";
import type { TerminalState, TerminalStaff } from "../../shared/access";
import { strings, translateError, type Key } from "../i18n";
import { ApiError, api } from "../api";
import { Button, Field } from "../components/ui";
import { finishPendingLogout } from "../access/session";
import { OwnerAccess } from "./OwnerAccess";
import { PairDevice } from "./PairDevice";
import { PinPad } from "./PinPad";
import "../access/access.css";

/**
 * Signed-out entry: pairing for new browsers, the employee picker and PIN pad
 * on paired devices, the owner's Google entry where allowed, and the demo form
 * only when the server has DEMO_TENANT_ID configured (SEC-4/FOH-2).
 */
export function AccessGate({
  locale,
  setLocale,
  online,
  reason,
  signupFirst,
  onSignedIn,
  onOwnerReady,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** App's connectivity (contract 0.8); the gate refetches when it returns. */
  online: boolean;
  reason?: string;
  signupFirst: boolean;
  onSignedIn: () => Promise<void>;
  onOwnerReady: () => Promise<void>;
}) {
  const t = strings[locale];
  const [state, setState] = useState<TerminalState | null>(null);
  const [failed, setFailed] = useState(false);
  // The last refresh got no answer (router up, internet down): shown as
  // offline rather than as a generic error (ACC-FLOOR-14).
  const [unreachable, setUnreachable] = useState(false);
  const [selected, setSelected] = useState<TerminalStaff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ownerAccount, setOwnerAccount] = useState(false);
  async function refresh() {
    try {
      const next = await api<TerminalState>("/access/terminal");
      setState(next);
      setFailed(false);
      setUnreachable(false);
      setSelected((current) =>
        current
          ? (next.staff?.find((e) => e.id === current.id) ?? null)
          : current,
      );
    } catch (e) {
      setFailed(true);
      setUnreachable(!(e instanceof ApiError));
    }
  }
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, []);
  // On mount and whenever the connection changes: a gate shown after an
  // offline logout fills in by itself when the device reconnects.
  useEffect(() => {
    void refresh();
  }, [online]);
  const offline = !online || unreachable;
  const offlineNotice = offline && (
    <>
      <p role="status" className="warning">
        {t.accessGateOffline}
      </p>
      <p className="muted">{t.accessGateSalesKept}</p>
    </>
  );
  async function signIn(employee: TerminalStaff, secret: string) {
    setBusy(true);
    setError("");
    try {
      await finishPendingLogout();
      await api("/access/pin", { employeeId: employee.id, secret });
      await onSignedIn();
    } catch (e) {
      const code = (e as Error).message;
      setError(translateError(code, locale));
      if (["pin_locked", "pin_hard_locked", "device_revoked"].includes(code))
        await refresh();
      if (code === "employee_unavailable") {
        setSelected(null);
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  const languageToggle = (
    <Button onClick={() => setLocale(locale === "es" ? "en" : "es")}>
      {locale === "es" ? "English" : "Español"}
    </Button>
  );
  if (!state)
    return (
      <div className="access-gate">
        <div className="row between">
          <span />
          {languageToggle}
        </div>
        {failed && offline ? (
          <div>
            {offlineNotice}
            <Button onClick={() => void refresh()}>{t.retry}</Button>
          </div>
        ) : failed ? (
          <div role="alert">
            <p className="error">{translateError("error", locale)}</p>
            <Button onClick={() => void refresh()}>{t.retry}</Button>
          </div>
        ) : (
          <p role="status">{t.loading}</p>
        )}
      </div>
    );
  const reasonText = reason ? translateError(reason, locale) : "";
  const owner = (
    <OwnerAccess
      locale={locale}
      onReady={onOwnerReady}
      onAccount={setOwnerAccount}
    />
  );
  const demo = state.demo && !selected && !ownerAccount && !signupFirst && (
    <DemoSignIn
      locale={locale}
      tenantId={state.demo.tenantId}
      login={state.demo.login}
      onSignedIn={onSignedIn}
    />
  );
  if (!state.paired) {
    const ownerCard = (
      <section className="access-owner" aria-label={t.accessOwnerTitle}>
        {(state.google || signupFirst) && !ownerAccount && (
          <>
            <h2>{t.accessOwnerTitle}</h2>
            <p className="muted">{t.accessOwnerHint}</p>
          </>
        )}
        {owner}
      </section>
    );
    const pair = !ownerAccount && (
      <PairDevice
        locale={locale}
        onPaired={(restaurant) => {
          setNotice(t.accessPairDone.replace("{restaurant}", restaurant));
          void refresh();
        }}
      />
    );
    return (
      <div className="access-gate">
        <div className="row between">
          <span />
          {languageToggle}
        </div>
        {offlineNotice}
        {reasonText && (
          <p role="alert" className="error">
            {reasonText}
          </p>
        )}
        {signupFirst ? ownerCard : pair}
        {signupFirst ? pair : ownerCard}
        {demo}
      </div>
    );
  }
  const staff = state.staff ?? [];
  return (
    <div className="access-gate">
      <div className="row between">
        <div>
          <h2 className="access-restaurant">{state.restaurant?.name}</h2>
          <p className="muted access-device">
            {t.accessDeviceLabel.replace("{name}", state.device?.name ?? "")}
          </p>
        </div>
        {languageToggle}
      </div>
      {notice && <p role="status">{notice}</p>}
      {offlineNotice}
      {reasonText && (
        <p role="alert" className="error">
          {reasonText}
        </p>
      )}
      {!ownerAccount &&
        (selected ? (
          <section className="access-card" aria-label={selected.name}>
            <div className="row between">
              <div>
                <strong>{selected.name}</strong>
                <p className="muted tiny">{t[selected.role as Key]}</p>
              </div>
              <Button
                variant="ghost"
                onClick={() => {
                  setSelected(null);
                  setError("");
                }}
              >
                {t.accessChooseOther}
              </Button>
            </div>
            <PinPad
              key={selected.id}
              employee={selected}
              locale={locale}
              busy={busy}
              error={error}
              lockedUntil={selected.lockedUntil}
              hardLocked={selected.hardLocked}
              onSubmit={(secret) => signIn(selected, secret)}
            />
          </section>
        ) : (
          <section className="access-card" aria-labelledby="who-title">
            <h3 id="who-title">{t.accessWho}</h3>
            {staff.length === 0 ? (
              <p className="muted">{t.accessNoStaff}</p>
            ) : (
              <div className="roster">
                {staff.map((e) => (
                  <button
                    type="button"
                    key={e.id}
                    className="roster-person"
                    onClick={() => {
                      setSelected(e);
                      setError("");
                    }}
                  >
                    <span className="roster-avatar" aria-hidden="true">
                      {e.name
                        .split(/\s+/)
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((w) => w[0]!.toUpperCase())
                        .join("")}
                    </span>
                    <span className="roster-name">{e.name}</span>
                    <span className="roster-role">{t[e.role as Key]}</span>
                    {(e.hardLocked ||
                      (e.lockedUntil &&
                        new Date(e.lockedUntil).getTime() > Date.now())) && (
                      <span className="badge red">{t.accessStaffLocked}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      {state.device?.kind === "terminal" ? (
        <p className="muted access-terminal-note">{t.accessTerminalNoGoogle}</p>
      ) : (
        owner
      )}
      {demo}
      <p className="muted tiny access-footer">{t.accessNotYou}</p>
    </div>
  );
}

/** Local and fictional-staging only: owner login for the configured demo tenant. */
function DemoSignIn({
  locale,
  tenantId,
  login,
  onSignedIn,
}: {
  locale: Locale;
  tenantId: string;
  login: string;
  onSignedIn: () => Promise<void>;
}) {
  const t = strings[locale];
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="access-card demo-sign-in"
      aria-labelledby="demo-title"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        const f = new FormData(e.currentTarget);
        try {
          await finishPendingLogout();
          await api("/login", {
            tenantId,
            login: String(f.get("login") ?? ""),
            secret: String(f.get("secret") ?? ""),
          });
          await onSignedIn();
        } catch (err) {
          setError(translateError((err as Error).message, locale));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 id="demo-title">{t.accessDemoTitle}</h2>
      <Field label={t.user}>
        <input
          name="login"
          autoComplete="username"
          defaultValue={login}
          required
        />
      </Field>
      <Field label={t.secret}>
        <input
          name="secret"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <Button variant="primary" type="submit" className="full" disabled={busy}>
        {t.login}
        <ArrowRight size={20} />
      </Button>
      <p className="muted">{t.demo}</p>
    </form>
  );
}
