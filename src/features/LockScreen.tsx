import { useEffect, useId, useRef, useState } from "react";
import { Lock } from "lucide-react";
import type { Locale, Session } from "../../shared/domain";
import type { TerminalState, TerminalStaff } from "../../shared/access";
import { strings, translateError, type Key } from "../i18n";
import { api } from "../api";
import { Button } from "../components/ui";
import {
  drainBeforeLeaving,
  fetchCurrentSession,
  finishPendingLogout,
} from "../access/session";
import { PinPad } from "./PinPad";
import "../access/access.css";

export type LockReason = "idle" | "manual" | "renew" | string;

/**
 * Full-screen lock that keeps the workspace mounted underneath (SEC-6/FOH-7).
 * The same employee's PIN resumes with every unsaved state; another employee's
 * PIN starts their own session. Offline, the PIN cannot be verified, so the
 * current employee may continue with an explicit notice.
 */
export function LockScreen({
  session,
  reason,
  online,
  locale,
  onUnlocked,
  onContinueOffline,
  onSignOut,
}: {
  session: Session;
  reason: LockReason;
  online: boolean;
  locale: Locale;
  onUnlocked: (s: Session) => void;
  onContinueOffline: () => void;
  onSignOut: () => void;
}) {
  const t = strings[locale];
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [terminal, setTerminal] = useState<TerminalState | null>(null);
  const [mode, setMode] = useState<"self" | "roster" | "pending" | "other">(
    "self",
  );
  const [other, setOther] = useState<TerminalStaff | null>(null);
  const [pending, setPending] = useState({ sales: 0, payment: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  useEffect(() => {
    if (online)
      void api<TerminalState>("/access/terminal")
        .then(setTerminal)
        .catch(() => setTerminal(null));
  }, [online]);
  const self = terminal?.staff?.find((e) => e.id === session.employeeId);
  // A Google owner without a PIN re-enters through Google on their own device.
  const googleOnly =
    session.access?.deviceKind === "personal" &&
    session.access.ownerAccount &&
    terminal !== null &&
    !self;
  async function unlock(employeeId: string, secret: string) {
    setBusy(true);
    setError("");
    try {
      await finishPendingLogout();
      await api("/access/pin", { employeeId, secret });
      onUnlocked(await fetchCurrentSession());
    } catch (e) {
      const code = (e as Error).message;
      setError(translateError(code, locale));
      if (["pin_locked", "pin_hard_locked"].includes(code))
        setTerminal(await api<TerminalState>("/access/terminal"));
    } finally {
      setBusy(false);
    }
  }
  const title =
    reason === "idle" || reason === "manual"
      ? t.accessLockTitle
      : reason === "renew"
        ? t.accessRenewTitle.replace("{name}", session.name)
        : translateError(reason, locale);
  return (
    <dialog
      ref={ref}
      className="lock-screen"
      aria-labelledby={titleId}
      onCancel={(e) => e.preventDefault()}
    >
      <div className="lock-body">
        <Lock size={28} aria-hidden="true" />
        <h2 id={titleId}>{title}</h2>
        <p className="muted">
          {session.restaurant.name}
          {session.access ? ` · ${session.access.deviceName}` : ""}
        </p>
        {!online ? (
          <>
            <p className="lock-person">
              <strong>{session.name}</strong> · {t[session.role as Key]}
            </p>
            <p role="status">
              {t.accessOfflineUnlockHint.replace("{name}", session.name)}
            </p>
            {(reason === "idle" || reason === "manual") &&
              new Date(session.offlineUntil).getTime() > Date.now() && (
              <Button
                variant="primary"
                className="full"
                onClick={onContinueOffline}
              >
                {t.accessContinueAs.replace("{name}", session.name)}
              </Button>
            )}
            <Button
              className="full"
              disabled
              aria-describedby={`${titleId}-offline`}
            >
              {t.accessSwitchUser}
            </Button>
            <p id={`${titleId}-offline`} className="muted tiny">
              {t.accessSwitchOffline}
            </p>
          </>
        ) : mode === "self" ? (
          <>
            <p className="lock-person">
              <strong>{session.name}</strong> · {t[session.role as Key]}
            </p>
            {googleOnly ? (
              <a className="button primary full" href="/api/auth/google/start">
                {t.accessGoogleAgain}
              </a>
            ) : (
              <PinPad
                employee={session}
                locale={locale}
                busy={busy}
                error={error}
                lockedUntil={self?.lockedUntil ?? null}
                hardLocked={self?.hardLocked ?? false}
                onSubmit={(secret) => unlock(session.employeeId, secret)}
              />
            )}
            <Button
              className="full"
              disabled={busy}
              onClick={async () => {
                setError("");
                const left = await drainBeforeLeaving(session, online);
                setPending(left);
                setMode(left.sales > 0 || left.payment ? "pending" : "roster");
              }}
            >
              {t.accessSwitchUser}
            </Button>
          </>
        ) : mode === "pending" ? (
          <section aria-labelledby={`${titleId}-pending`}>
            <h3 id={`${titleId}-pending`}>{t.accessPendingTitle}</h3>
            <p>
              {t.accessPendingBody
                .replace("{n}", String(pending.sales))
                .replace("{name}", session.name)}
            </p>
            {pending.payment && <p>{t.accessPendingPayment}</p>}
            <div className="row wrap">
              <Button variant="primary" onClick={() => setMode("self")}>
                {t.accessStay}
              </Button>
              <Button onClick={() => setMode("roster")}>
                {t.accessSwitchAnyway}
              </Button>
            </div>
          </section>
        ) : mode === "roster" ? (
          <>
            <h3>{t.accessWho}</h3>
            <div className="roster">
              {(terminal?.staff ?? []).map((e) => (
                <button
                  type="button"
                  key={e.id}
                  className="roster-person"
                  onClick={() => {
                    setOther(e);
                    setError("");
                    setMode(e.id === session.employeeId ? "self" : "other");
                  }}
                >
                  <span className="roster-name">{e.name}</span>
                  <span className="roster-role">{t[e.role as Key]}</span>
                </button>
              ))}
            </div>
            <Button variant="ghost" onClick={() => setMode("self")}>
              {t.back}
            </Button>
          </>
        ) : (
          other && (
            <>
              <p className="lock-person">
                <strong>{other.name}</strong> · {t[other.role as Key]}
              </p>
              <PinPad
                key={other.id}
                employee={other}
                locale={locale}
                busy={busy}
                error={error}
                lockedUntil={other.lockedUntil}
                hardLocked={other.hardLocked}
                onSubmit={(secret) => unlock(other.id, secret)}
              />
              <Button variant="ghost" onClick={() => setMode("roster")}>
                {t.accessChooseOther}
              </Button>
            </>
          )
        )}
        <Button variant="ghost" className="lock-sign-out" onClick={onSignOut}>
          {t.logout}
        </Button>
      </div>
    </dialog>
  );
}
