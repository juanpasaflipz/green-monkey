import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lock } from "lucide-react";
import type { Locale, Session } from "../../shared/domain";
import type { TerminalState, TerminalStaff } from "../../shared/access";
import { strings, errorNotice, translateError, type Key } from "../i18n";
import { ApiError, api, holdRequests } from "../api";
import { Button } from "../components/ui";
import {
  drainBeforeLeaving,
  fetchCurrentSession,
  finishPendingLogout,
} from "../access/session";
import {
  allowsContinueOffline,
  inertOutside,
  keepLockOnTop,
} from "../access/lock";
import { PinPad } from "./PinPad";
import "../access/access.css";

export type LockReason = "idle" | "manual" | "renew" | string;

/**
 * The server gave no answer of its own: offline's request() (026) reports a
 * failed fetch, a timeout or a proxy/HTML page as a transient ApiError, not a
 * thrown fetch.
 */
const noAnswer = (e: unknown) => !(e instanceof ApiError) || e.transient;

/**
 * Full-screen lock that keeps the workspace mounted underneath (SEC-6/FOH-7).
 * The same employee's PIN resumes with every unsaved state; another employee's
 * PIN starts their own session. Offline, the PIN cannot be verified, so the
 * current employee may continue with an explicit notice.
 *
 * Only an unlock, a switch or "Salir" ends it (and "Ahora no" for a renewal
 * the cashier started, whose session is still valid). A modal dialog's cancel
 * can be forced through by repeated close requests (Escape, Android back), so
 * the lock does not rely on it: closedby="none" ignores close requests where
 * supported, the Escape keydown is cancelled before it becomes one, any close
 * reopens the dialog at once, everything outside it stays inert, and a dialog
 * opened later is kept below it.
 *
 * While shown and online it re-reads the roster every 20 s, when the tab
 * becomes visible and when a PIN lock it shows runs out, so a manager's unlock
 * elsewhere re-enables the keypad (ACC-FLOOR-3). A request that cannot reach
 * the server is reported with onUnreachable, and App shows the offline lock.
 */
export function LockScreen({
  session,
  reason,
  online,
  locale,
  overlayOpen = false,
  onUnlocked,
  onContinueOffline,
  onDismiss,
  onUnreachable,
  onSignOut,
}: {
  session: Session;
  reason: LockReason;
  /** The server is reachable (App: connected and not found unreachable). */
  online: boolean;
  locale: Locale;
  /** App shows a dialog of the lock's own over it (the "Salir" warnings). */
  overlayOpen?: boolean;
  onUnlocked: (s: Session) => void;
  onContinueOffline: () => void;
  /** Closes a renewal prompt; offered for reason "renew" only. */
  onDismiss: () => void;
  onUnreachable: () => void;
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
  const overlay = useRef(overlayOpen);
  overlay.current = overlayOpen;
  const unreachable = useRef(onUnreachable);
  unreachable.current = onUnreachable;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const blockEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    const reopen = () => {
      if (dialog.isConnected && !dialog.open) dialog.showModal();
    };
    const release = inertOutside(dialog);
    const releaseTop = keepLockOnTop(dialog, () => overlay.current);
    window.addEventListener("keydown", blockEscape, true);
    dialog.addEventListener("close", reopen);
    dialog.showModal();
    return () => {
      dialog.removeEventListener("close", reopen);
      window.removeEventListener("keydown", blockEscape, true);
      releaseTop();
      release();
      dialog.close();
    };
  }, []);
  const refreshTerminal = useCallback(async () => {
    try {
      setTerminal(await api<TerminalState>("/access/terminal"));
    } catch (e) {
      if (noAnswer(e)) unreachable.current();
    }
  }, []);
  useEffect(() => {
    if (!online) return;
    void refreshTerminal();
    const visible = () => {
      if (document.visibilityState === "visible") void refreshTerminal();
    };
    const timer = setInterval(visible, 20_000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [online, refreshTerminal]);
  const self = terminal?.staff?.find((e) => e.id === session.employeeId);
  // The roster entry picked for a switch, kept current by the refreshes.
  const chosen = other
    ? (terminal?.staff?.find((e) => e.id === other.id) ?? other)
    : null;
  const shown = mode === "other" ? chosen : self;
  const shownLockedUntil =
    shown && !shown.hardLocked ? shown.lockedUntil : null;
  useEffect(() => {
    // When the PIN lock on screen runs out, ask again: the keypad re-enables.
    const until = shownLockedUntil ? new Date(shownLockedUntil).getTime() : 0;
    if (!online || until <= Date.now()) return;
    const timer = setTimeout(
      () => void refreshTerminal(),
      Math.min(until - Date.now() + 1000, 2_147_000_000),
    );
    return () => clearTimeout(timer);
  }, [online, shownLockedUntil, refreshTerminal]);
  const shownLocked = Boolean(
    shown &&
    (shown.hardLocked ||
      (shown.lockedUntil &&
        new Date(shown.lockedUntil).getTime() > Date.now())),
  );
  // A Google owner without a PIN re-enters through Google on their own device.
  const googleOnly =
    session.access?.deviceKind === "personal" &&
    session.access.ownerAccount &&
    terminal !== null &&
    !self;
  async function unlock(employeeId: string, secret: string) {
    setBusy(true);
    setError("");
    // A different employee (or a renewal) gets a new gm_session cookie before
    // App knows the new session id; background polls wait until it does.
    const release = holdRequests();
    try {
      await finishPendingLogout();
      await api("/access/pin", { employeeId, secret });
      onUnlocked(await fetchCurrentSession());
    } catch (e) {
      // No answer from the server (router up, internet down): this is the
      // offline lock, with its notice and "Continuar como" (ACC-FLOOR-6).
      if (noAnswer(e)) {
        setError("");
        onUnreachable();
        return;
      }
      const code = (e as ApiError).message;
      setError(errorNotice(e, locale));
      if (["pin_locked", "pin_hard_locked"].includes(code))
        await refreshTerminal();
    } finally {
      release();
      setBusy(false);
    }
  }
  const title =
    reason === "idle" || reason === "manual"
      ? t.accessLockTitle
      : reason === "renew"
        ? t.accessRenewTitle.replace("{name}", session.name)
        : translateError(reason, locale);
  // A direct child of <body>, so making everything else inert leaves it usable.
  return createPortal(
    <dialog
      ref={ref}
      className="lock-screen"
      aria-labelledby={titleId}
      closedby="none"
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
            {allowsContinueOffline(reason) &&
              new Date(session.offlineUntil).getTime() > Date.now() && (
                <Button
                  variant="primary"
                  className="full"
                  onClick={onContinueOffline}
                >
                  {t.accessContinueAs.replace("{name}", session.name)}
                </Button>
              )}
            {reason === "renew" && (
              <Button className="full" onClick={onDismiss}>
                {t.accessNotNow}
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
            {shownLocked && (
              <Button variant="ghost" onClick={() => void refreshTerminal()}>
                {t.accessLockCheckAgain}
              </Button>
            )}
            {reason === "renew" && (
              <Button className="full" disabled={busy} onClick={onDismiss}>
                {t.accessNotNow}
              </Button>
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
                lockedUntil={chosen?.lockedUntil ?? null}
                hardLocked={chosen?.hardLocked ?? false}
                onSubmit={(secret) => unlock(other.id, secret)}
              />
              {shownLocked && (
                <Button variant="ghost" onClick={() => void refreshTerminal()}>
                  {t.accessLockCheckAgain}
                </Button>
              )}
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
    </dialog>,
    document.body,
  );
}
