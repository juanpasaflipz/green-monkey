import { BrandLogo } from "./components/BrandLogo";
import { useEffect, useRef, useState } from "react";
import {
  ShoppingBag,
  ClipboardList,
  LayoutGrid,
  Wallet,
  ChartNoAxesCombined,
  House,
  Package,
  Users,
  Lock,
  Settings,
  ChefHat,
  LogOut,
  Wifi,
  WifiOff,
  ChevronDown,
} from "lucide-react";
import type { Session, Locale, Product } from "../shared/domain";
import { strings, type Key } from "./i18n";
import { api, setSession, clearSessionScope } from "./api";
import { db, cacheSession, scope, syncPending } from "./offline";
import { Button, Modal } from "./components/ui";
import { Selling } from "./features/Selling";
import { Operations } from "./features/Operations";
import { OwnerAccess } from "./features/OwnerAccess";
import { ApiError, registerStepUpHandler, requestsBlocked } from "./api";
import { AccessGate } from "./features/AccessGate";
import { LockScreen } from "./features/LockScreen";
import { StepUpDialog } from "./features/StepUpDialog";
import { useIdleLock } from "./access/idle";
import {
  LOGOUT_PENDING_KEY,
  clearPendingLogout,
  drainBeforeLeaving,
  finishPendingLogout,
  serverSignOut,
  startHeartbeat,
  unsyncedFor,
} from "./access/session";
import {
  forgetLock,
  noteActivity,
  rememberLock,
  restoredLock,
} from "./access/lock";
import "./access/access.css";
export default function App() {
  const [locale, setLocale] = useState<Locale>(
    localStorage.getItem("gm-locale") === "en" ? "en" : "es",
  );
  const [session, setActiveSession] = useState<Session | null>(null);
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("sell");
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(0);
  const [, setOwnerAccess] = useState(false);
  const [showAccount, setShowAccount] = useState(
    new URLSearchParams(location.search).has("account") ||
      location.hash.startsWith("#invite="),
  );
  const [sessionChanged, setSessionChanged] = useState(false);
  const [lock, setLock] = useState<null | { reason: string }>(null);
  // "Continuar como" offline: unlocked without a PIN until the connection or
  // the offline window ends (contract 8.2), then locked again.
  const [softUnlocked, setSoftUnlocked] = useState(false);
  const [stepUpRequest, setStepUpRequest] = useState<null | {
    resolve: () => void;
    reject: (e: unknown) => void;
  }>(null);
  const [gateReason, setGateReason] = useState("");
  const [leaving, setLeaving] = useState<
    | null
    | { kind: "offline" }
    | { kind: "pending"; sales: number; payment: boolean }
  >(null);
  const [now, setNow] = useState(() => Date.now());
  const sessionRef = useRef<Session | null>(null);
  const onlineRef = useRef(online);
  const t = (key: Key) => strings[locale][key];
  async function load(resetView = true) {
    await finishPendingLogout();
    // Never restore a session while a logout is still pending (SEC-6).
    if (localStorage.getItem(LOGOUT_PENDING_KEY)) {
      setActiveSession(null);
      setCatalog([]);
      setLoading(false);
      return;
    }
    try {
      const s = await api<Session>("/session");
      setSession(s);
      const c = await api<Product[]>("/catalog");
      resumeLock(s);
      setActiveSession(s);
      setCatalog(c);
      await cacheSession(s, c);
      if (resetView)
        setView(
          s.role === "kitchen"
            ? "kitchen"
            : s.role === "owner"
              ? "today"
              : "sell",
        );
    } catch {
      setActiveSession(null);
      setCatalog([]);
      if (!navigator.onLine) {
        const cached = await db.cache.get("session");
        if (cached && new Date(cached.value.offlineUntil) > new Date()) {
          resumeLock(cached.value);
          setActiveSession(cached.value);
          setSession(cached.value);
          setCatalog(
            (await db.cache.get(scope(cached.value) + ":catalog"))?.value ?? [],
          );
        }
      }
    } finally {
      setLoading(false);
    }
  }
  /**
   * A reload, a reopened tab or an offline restore never opens a locked
   * session unlocked (SEC-6): the remembered lock, or a pause longer than the
   * auto-lock, starts the restored session behind the lock screen.
   */
  function resumeLock(s: Session) {
    const reason = restoredLock(s);
    if (reason) setLock({ reason });
    else noteActivity(s.id, true);
  }
  useEffect(() => {
    void load();
    const changed = () => setSessionChanged(true);
    const changedElsewhere = (event: StorageEvent) => {
      if (event.key === "gm-session-generation") changed();
    };
    window.addEventListener("gm-session-changed", changed);
    window.addEventListener("storage", changedElsewhere);
    const refreshSession = () => void load(false);
    window.addEventListener("gm-session-refresh", refreshSession);
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("gm-session-refresh", refreshSession);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
      window.removeEventListener("gm-session-changed", changed);
      window.removeEventListener("storage", changedElsewhere);
    };
  }, []);
  useEffect(() => {
    let current = true;
    if (view === "sell" && session && online)
      void api<Product[]>("/catalog")
        .then((c) => {
          if (!current) return;
          setCatalog(c);
          void cacheSession(session, c);
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [view, session?.id, online]);
  useEffect(() => {
    sessionRef.current = session;
    onlineRef.current = online;
  }, [session, online]);
  useEffect(() => {
    // A session 401 locks the screen with its reason; a device 401 unpairs (FOH-7).
    const unauthorized = (event: Event) => {
      const code = (event as CustomEvent<string>).detail;
      if (!sessionRef.current) return;
      if (code === "device_revoked" || code === "device_not_paired") {
        void db.cache.delete("session");
        clearSessionScope();
        setLock(null);
        setActiveSession(null);
        setCatalog([]);
        setGateReason(code);
        forgetLock();
      } else {
        // A deactivated employee must not keep selling offline from the cache.
        if (code === "session_revoked") void db.cache.delete("session");
        setLock((current) => current ?? { reason: code });
      }
    };
    window.addEventListener("gm-unauthorized", unauthorized);
    registerStepUpHandler(
      () =>
        new Promise<void>((resolve, reject) =>
          setStepUpRequest({ resolve, reject }),
        ),
    );
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.removeEventListener("gm-unauthorized", unauthorized);
      registerStepUpHandler(null);
      clearInterval(tick);
    };
  }, []);
  useIdleLock(
    session?.access?.idleLockSeconds ?? null,
    Boolean(session) && !lock && !sessionChanged,
    () => setLock({ reason: "idle" }),
    () => {
      if (sessionRef.current) noteActivity(sessionRef.current.id);
    },
  );
  useEffect(() => {
    // Remembered until a PIN unlock, a new sign-in or a sign-out (SEC-6).
    if (session && lock) rememberLock(session.id, lock.reason);
  }, [session?.id, lock?.reason]);
  useEffect(() => {
    // The offline soft unlock ends with the connection or the offline window.
    if (
      softUnlocked &&
      session &&
      (online || new Date(session.offlineUntil).getTime() <= now)
    ) {
      setSoftUnlocked(false);
      setLock({ reason: "idle" });
    }
  }, [softUnlocked, online, now, session?.offlineUntil]);
  useEffect(() => {
    if (!session || sessionChanged) return;
    // Keeps the sliding expiry and renewed offline window current (OFF-3);
    // only the "session" cache entry is written (D15).
    return startHeartbeat(
      (s) => {
        setSession(s);
        void db.cache.put({ id: "session", value: s });
        setActiveSession((current) =>
          current &&
          current.id === s.id &&
          JSON.stringify([
            current.offlineUntil,
            current.expiresAt,
            current.access,
            current.sellingAllowed,
          ]) !==
            JSON.stringify([
              s.offlineUntil,
              s.expiresAt,
              s.access,
              s.sellingAllowed,
            ])
            ? s
            : current,
        );
      },
      () => onlineRef.current,
    );
  }, [session?.id, sessionChanged]);
  useEffect(() => {
    if (online) void finishPendingLogout();
  }, [online]);
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("gm-locale", locale);
  }, [locale]);
  useEffect(() => {
    if (!session || sessionChanged) return;
    const s = session;
    const poll = async () => {
      // Blocked calls would count as sync attempts and push queued sales
      // toward conflict (OFF-7); offline carries this rule at merge.
      if (navigator.onLine && !requestsBlocked()) await syncPending(s);
      setQueued(
        (await db.pending.where("scope").equals(scope(s)).toArray()).filter(
          (p) => p.status !== "synced",
        ).length,
      );
    };
    void poll();
    const timer = setInterval(() => void poll(), 10000);
    return () => clearInterval(timer);
  }, [session, online, sessionChanged]);
  async function ownerReady() {
    clearSessionScope();
    setActiveSession(null);
    setCatalog([]);
    setLoading(true);
    setShowAccount(false);
    setGateReason("");
    history.replaceState(null, "", "/app");
    await load();
  }
  /**
   * Flow H: sync first, warn about unsent sales or a missing connection, then
   * end the server session. Signing out always succeeds locally (SEC-6/OFF-7).
   */
  async function signOut(force = false) {
    const s = session;
    if (!s) return;
    if (!force) {
      if (!online) {
        setLeaving({ kind: "offline" });
        return;
      }
      // A session the server already ended cannot sync; only count.
      const left =
        lock && !["idle", "manual", "renew"].includes(lock.reason)
          ? await unsyncedFor(s)
          : await drainBeforeLeaving(s, online);
      if (left.sales > 0 || left.payment) {
        setLeaving({ kind: "pending", ...left });
        return;
      }
    }
    setLeaving(null);
    await serverSignOut(s.id);
    await db.cache.delete("session");
    clearSessionScope();
    localStorage.setItem("gm-session-generation", crypto.randomUUID());
    forgetLock();
    setSoftUnlocked(false);
    setLock(null);
    setActiveSession(null);
    setCatalog([]);
  }
  if (loading)
    return (
      <div className="login">
        <p>{t("loading")}</p>
      </div>
    );
  if (sessionChanged)
    return (
      <div className="login">
        <div className="login-form">
          <p role="alert">
            {locale === "es"
              ? "La sesión cambió en otra pestaña. Recarga para continuar en el restaurante activo."
              : "The session changed in another tab. Reload to continue in the active restaurant."}
          </p>
          <Button onClick={() => location.reload()}>
            {locale === "es" ? "Recargar" : "Reload"}
          </Button>
        </div>
      </div>
    );
  if (!session || showAccount)
    return (
      <div className="login">
        <div className="login-art">
          <div className="brand">
            <BrandLogo />
          </div>
          <h1>{t("loginTitle")}</h1>
          <p>{t("accessArtHint")}</p>
          <div className="login-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="login-form">
          {session ? (
            <>
              <Button onClick={() => setShowAccount(false)}>
                {locale === "es" ? "Volver al restaurante" : "Back to restaurant"}
              </Button>
              <Button onClick={() => setLocale(locale === "es" ? "en" : "es")}>
                {locale === "es" ? "English" : "Español"}
              </Button>
              <OwnerAccess
                locale={locale}
                onReady={ownerReady}
                onAccount={setOwnerAccess}
              />
            </>
          ) : (
            <AccessGate
              locale={locale}
              setLocale={setLocale}
              online={online}
              reason={gateReason}
              signupFirst={new URLSearchParams(location.search).has("signup")}
              onSignedIn={async () => {
                // The PIN just entered supersedes any remembered lock or logout.
                clearPendingLogout();
                forgetLock();
                setGateReason("");
                await load();
              }}
              onOwnerReady={ownerReady}
            />
          )}
        </div>
      </div>
    );
  const management = ["owner", "manager"].includes(session.role);
  const absoluteEnd = session.access?.absoluteExpiresAt
    ? new Date(session.access.absoluteExpiresAt).getTime()
    : null;
  const expiring =
    absoluteEnd !== null && absoluteEnd - now <= 30 * 60_000;
  const nav =
    session.role === "kitchen"
      ? [["kitchen", ChefHat]]
      : management
        ? [
            ["today", House],
            ["operation", ShoppingBag],
            ["inventory", Package],
            ["finance", ChartNoAxesCombined],
            ["team", Users],
            ["settings", Settings],
          ]
        : [
            ["sell", ShoppingBag],
            ["orders", ClipboardList],
            ["tables", LayoutGrid],
            ["cash", Wallet],
          ];
  const operational = ["sell", "orders", "tables", "cash", "kitchen"].includes(
    view,
  );
  const initials = session.restaurant.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView(session.role === "kitchen" ? "kitchen" : "sell");
          }}
        >
          <BrandLogo />
        </a>
        <nav className="rail" aria-label={t("operation")}>
          {nav.map(([key, Icon]) => {
            const name = key as string;
            const Glyph = Icon as typeof ShoppingBag;
            const current =
              view === name || (name === "operation" && operational);
            return (
              <button
                key={name}
                className={current ? "selected" : ""}
                onClick={() => {
                  setView(name === "operation" ? "sell" : name);
                  setError("");
                }}
                aria-current={current ? "page" : undefined}
              >
                <Glyph size={20} strokeWidth={current ? 2.4 : 2} />
                <span>{t(name as Key)}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <header className="topbar">
        <div className="scope">
          <span className="store-avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="store-text">
            <strong>{session.restaurant.name}</strong>
            <span>
              {session.name} · {t(session.role as Key)}
            </span>
          </span>
          {management && session.access?.deviceKind !== "terminal" && (
            <Button
              variant="ghost"
              className="store-switch"
              aria-label={
                locale === "es" ? "Cambiar restaurante" : "Switch restaurant"
              }
              onClick={() => setShowAccount(true)}
            >
              <ChevronDown size={18} />
            </Button>
          )}
        </div>
        <div className="top-actions">
          <button
            className={`connection ${online ? "" : "warning"}`}
            aria-label={`${t(online ? "connected" : "offline")}${queued > 0 ? ` · ${queued}` : ""}`}
            onClick={() => setView("sync")}
          >
            <span className="status-dot" aria-hidden="true" />
            {online ? <Wifi size={16} /> : <WifiOff size={16} />}
            <span>
              {t(online ? "connected" : "offline")}
              {queued > 0 ? ` · ${queued}` : ""}
            </span>
          </button>
          <Button
            variant="ghost"
            className="round"
            onClick={() => setLocale(locale === "es" ? "en" : "es")}
          >
            {locale.toUpperCase()}
          </Button>
          <Button
            variant="ghost"
            className="round"
            aria-label={t("accessLockNow")}
            onClick={() => setLock({ reason: "manual" })}
          >
            <Lock size={18} />
          </Button>
          <Button
            variant="ghost"
            className="round"
            aria-label={t("logout")}
            onClick={() => void signOut()}
          >
            <LogOut size={18} />
          </Button>
        </div>
      </header>
      <main
        className={
          (view === "sell" ? "selling-main" : "workspace") +
          (management && operational ? " with-subnav" : "")
        }
      >
        {management && operational && (
          <nav className="operations-tabs" aria-label={t("operation")}>
            {(["sell", "orders", "tables", "cash", "kitchen"] as const).map(
              (key) => (
                <button
                  key={key}
                  className={view === key ? "selected" : ""}
                  onClick={() => setView(key)}
                  aria-current={view === key ? "page" : undefined}
                >
                  {t(key)}
                </button>
              ),
            )}
          </nav>
        )}
        {expiring && (
          <div role="status" className="expiry-banner">
            <p>
              {t("accessExpiryWarning")
                .replace("{name}", session.name)
                .replace(
                  "{time}",
                  new Date(session.access!.absoluteExpiresAt!).toLocaleTimeString(
                    locale === "es" ? "es-MX" : "en-US",
                    { hour: "2-digit", minute: "2-digit" },
                  ),
                )}
            </p>
            <Button onClick={() => setLock({ reason: "renew" })}>
              {t("accessRenew")}
            </Button>
          </div>
        )}
        {session.sellingAllowed === false && (
          <p role="status" className="warning">
            {locale === "es"
              ? "Free: esta sucursal, dispositivo o empleado no está seleccionado para iniciar ventas. El propietario puede cambiar la selección en Cuenta y Configuración. Puedes terminar cobros y consultar registros."
              : "Free: this location, device or employee is not selected to start sales. The owner can change selections in Account and Settings. You can finish payments and view records."}
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div hidden={view !== "sell"} key={scope(session)}>
          <Selling
            session={session}
            catalog={catalog}
            locale={locale}
            online={online}
            active={view === "sell"}
            navigate={setView}
          />
        </div>
        {view !== "sell" && (
          <Operations
            key={`${scope(session)}:${view}`}
            view={view}
            session={session}
            locale={locale}
            navigate={setView}
          />
        )}
      </main>
      {lock && (
        <LockScreen
          session={session}
          reason={lock.reason}
          online={online}
          locale={locale}
          onUnlocked={(s) => {
            const sameEmployee = scope(s) === scope(session);
            setSession(s);
            clearPendingLogout();
            forgetLock();
            setSoftUnlocked(false);
            noteActivity(s.id, true);
            if (s.id !== session.id)
              localStorage.setItem("gm-session-generation", crypto.randomUUID());
            void db.cache.put({ id: "session", value: s });
            setLock(null);
            setActiveSession(s);
            if (!sameEmployee) {
              setView(
                s.role === "kitchen"
                  ? "kitchen"
                  : s.role === "owner"
                    ? "today"
                    : "sell",
              );
              void api<Product[]>("/catalog")
                .then((c) => {
                  setCatalog(c);
                  return cacheSession(s, c);
                })
                .catch(() => {});
            }
          }}
          onContinueOffline={() => {
            // The lock stays remembered: a reload or the connection returning
            // asks for the PIN again.
            setSoftUnlocked(true);
            setLock(null);
          }}
          onSignOut={() => void signOut()}
        />
      )}
      {stepUpRequest && (
        <StepUpDialog
          session={session}
          locale={locale}
          onConfirmed={() => {
            stepUpRequest.resolve();
            setStepUpRequest(null);
          }}
          onCancel={() => {
            stepUpRequest.reject(new ApiError("step_up_cancelled", 403));
            setStepUpRequest(null);
          }}
        />
      )}
      {leaving && (
        <Modal
          title={
            leaving.kind === "offline"
              ? t("accessOfflineLogoutTitle")
              : t("accessPendingTitle")
          }
          close={() => setLeaving(null)}
          closeLabel={t("close")}
          footer={
            <div className="row wrap">
              <Button variant="primary" onClick={() => setLeaving(null)}>
                {t("accessStay")}
              </Button>
              {leaving.kind === "offline" && (
                <Button
                  onClick={() => {
                    setLeaving(null);
                    setLock({ reason: "manual" });
                  }}
                >
                  {t("accessLockNow")}
                </Button>
              )}
              <Button variant="danger" onClick={() => void signOut(true)}>
                {t("accessLeaveAnyway")}
              </Button>
            </div>
          }
        >
          {leaving.kind === "offline" ? (
            <p>{t("accessOfflineLogoutBody")}</p>
          ) : (
            <>
              <p>
                {t("accessPendingBody")
                  .replace("{n}", String(leaving.sales))
                  .replace("{name}", session.name)}
              </p>
              {leaving.payment && <p>{t("accessPendingPayment")}</p>}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
