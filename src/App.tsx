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
  ChevronDown,
} from "lucide-react";
import type { Session, Locale, Product } from "../shared/domain";
import { strings, translateError, type Key } from "./i18n";
import { api, setSession, clearSessionScope } from "./api";
import { db, cacheSession, scope } from "./offline";
import {
  getConnectivitySnapshot,
  probeNow,
  serverNow,
  useConnectivity,
} from "./connectivity";
import { useOfflineQueue } from "./offline-queue";
import { ensureDevicePrefix } from "./offline-records";
import { requestPersistence } from "./storage-persistence";
import { ConnectionPill } from "./features/offline/ConnectionPill";
import { ConnectionBanner } from "./features/offline/ConnectionBanner";
import { UpdatePrompt } from "./features/offline/UpdatePrompt";
import { OfflineLoginNotice } from "./features/offline/OfflineLoginNotice";
import { LocalKitchenTickets } from "./features/offline/LocalKitchenTickets";
import { Button, Modal } from "./components/ui";
import { Selling } from "./features/Selling";
import { MenuArea, SetupNav, setupViews } from "./features/menu/MenuArea";
import { menuBaseline, watchMenuRevision } from "./features/menu/freshness";
import { Operations } from "./features/Operations";
import { OwnerAccess } from "./features/OwnerAccess";
import {
  ApiError,
  blockedReason,
  registerSoftUnlockCheck,
  registerStepUpHandler,
  requestsBlocked,
} from "./api";
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
  settleRejectedSession,
  startHeartbeat,
  unsyncedFor,
} from "./access/session";
import {
  LOCK_KEY,
  allowsContinueOffline,
  forgetLock,
  idleElsewhereWait,
  idleLock,
  lockFromOtherTab,
  nextLock,
  noteActivity,
  rememberLock,
  remembered,
  restoredLock,
} from "./access/lock";
import "./access/access.css";
import { installFiscalReceipt } from "./features/fiscal/FiscalReceipt";
import {
  clearFiscalContext,
  prefetchFiscalContext,
} from "./features/fiscal/context";
// fiscal (027): the fiscal header and footer of every receipt (service's slots).
installFiscalReceipt();
type StepUpRequest = {
  sessionId: string;
  resolve: () => void;
  reject: (e: unknown) => void;
};
export default function App() {
  const [locale, setLocale] = useState<Locale>(
    localStorage.getItem("gm-locale") === "en" ? "en" : "es",
  );
  const [session, setActiveSession] = useState<Session | null>(null);
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("sell");
  const net = useConnectivity();
  const online = net.canUseServer;
  const [error, setError] = useState("");
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const [, setOwnerAccess] = useState(false);
  const [showAccount, setShowAccount] = useState(
    new URLSearchParams(location.search).has("account") ||
      location.hash.startsWith("#invite="),
  );
  const [sessionChanged, setSessionChanged] = useState(false);
  const [lock, setLock] = useState<null | { reason: string }>(null);
  // "Continuar como" offline: unlocked without a PIN until the server is
  // reachable again or the offline window ends (contract 8.2), then locked
  // again with the same reason.
  const [softUnlocked, setSoftUnlocked] = useState<string | null>(null);
  // Whether the server answers, from offline's heartbeat (contract §0.8,
  // LD-10 B6): the lock and its soft unlock follow the server itself, not the
  // "Trabajar sin conexión" preference (`online` = canUseServer), so manual
  // offline mode never stands in for an unreachable server (ACC-R-2).
  const reachable = net.serverReachable;
  // A pending "Confirma con tu PIN", for the session whose command asked for it.
  const [stepUpRequest, setStepUpRequest] = useState<null | StepUpRequest>(
    null,
  );
  const stepUpRef = useRef<StepUpRequest | null>(null);
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
  /**
   * Cancels a pending step-up (ACC-20): after a switch, a sign-out or a new
   * sign-in, the next person must never confirm the previous one's command.
   */
  function cancelStepUp() {
    const pending = stepUpRef.current;
    stepUpRef.current = null;
    setStepUpRequest(null);
    pending?.reject(new ApiError("step_up_cancelled", 403));
  }
  /**
   * Offline restore: only a cached session whose offline window is still open,
   * and never unlocked (access A1): a remembered lock comes back with it.
   */
  async function restoreCached() {
    const cached = (await db.cache.get("session"))?.value as
      Session | undefined;
    if (cached && Date.parse(cached.offlineUntil) > serverNow()) {
      resumeLock(cached);
      setActiveSession(cached);
      setSession(cached);
      // fiscal (027): the issuer data of offline receipts (Dexie copy offline).
      if (cached.role !== "kitchen") void prefetchFiscalContext(cached);
      setCatalog((await db.cache.get(scope(cached) + ":catalog"))?.value ?? []);
    }
  }
  /**
   * `signedIn`: right after an explicit sign-in (PIN, demo form or owner
   * access), the server session is always read, even in manual offline mode;
   * manual mode only skips the startup check (OFF-R16).
   */
  async function load(resetView = true, signedIn = false) {
    await finishPendingLogout();
    // Never restore a session while a logout is still pending (SEC-6).
    if (localStorage.getItem(LOGOUT_PENDING_KEY)) {
      setActiveSession(null);
      setCatalog([]);
      setLoading(false);
      return;
    }
    if (getConnectivitySnapshot().manual && !signedIn) {
      await restoreCached();
      setLoading(false);
      return;
    }
    try {
      const s = await api<Session>("/session");
      // The home view is set in the same render as the session, so an owner
      // never mounts Selling for an instant (its effects would fetch tables,
      // the drawer and the open-orders snapshot for a view nobody sees).
      if (resetView)
        setView(
          s.role === "kitchen"
            ? "kitchen"
            : s.role === "owner"
              ? "today"
              : "sell",
        );
      setSession(s);
      const c = await api<Product[]>("/catalog");
      resumeLock(s);
      setActiveSession(s);
      setCatalog(c);
      await cacheSession(s, c);
      // fiscal (027): receipts and the product editor read the fiscal context.
      clearFiscalContext();
      if (s.role !== "kitchen") void prefetchFiscalContext(s);
      void requestPersistence();
      void ensureDevicePrefix(s);
    } catch (e) {
      setActiveSession(null);
      setCatalog([]);
      // A session the server rejected never comes back unlocked from the cache.
      if (e instanceof ApiError && e.status === 401)
        await settleRejectedSession(e.message);
      // OFF-1: any transient failure (network, timeout, 5xx), not only a
      // browser that reports itself offline, falls back to the cached session.
      // Never right after a sign-in: the cached session may be another
      // employee's, and sales would be recorded under that person (OFF-R16).
      if (signedIn) setError(translateError((e as Error).message, locale));
      else if ((e instanceof ApiError && e.transient) || !navigator.onLine)
        await restoreCached();
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
    if (reason) setLock((current) => nextLock(current, reason));
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
    return () => {
      window.removeEventListener("gm-session-refresh", refreshSession);
      window.removeEventListener("gm-session-changed", changed);
      window.removeEventListener("storage", changedElsewhere);
    };
  }, []);
  useEffect(() => {
    // Catalog freshness (FOH-8): poll the menu revision while selling so
    // 86'd items leave the grid without a view change; refetch on focus and
    // whenever another feature dispatches "gm-menu-refresh". Only the catalog
    // cache entry is written: the "session" entry belongs to load() and
    // access's heartbeat (D15), and this effect's copy may be stale.
    if (view !== "sell" || !session || !online) return;
    const key = scope(session);
    return watchMenuRevision({
      revision: async () =>
        (await api<{ revision: number }>("/menu/revision")).revision,
      catalog: () => api<Product[]>("/catalog"),
      apply: async (c) => {
        setCatalog(c);
        await db.cache.put({ id: key + ":catalog", value: c });
      },
      baseline: menuBaseline(key),
      win: window,
      doc: document,
    });
  }, [view, session?.id, online]);
  useEffect(() => {
    let current = true;
    if (view === "sell" && session && online)
      void api<Product[]>("/catalog")
        .then((c) => {
          if (!current) return;
          setCatalog(c);
          // A session 401 meanwhile must not put that session back in the cache.
          if (!requestsBlocked()) void cacheSession(session, c);
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
      // Also on a cold start: a revoked session leaves the offline cache, and
      // a deactivated employee cannot keep selling offline from it.
      void settleRejectedSession(code);
      if (!sessionRef.current) return;
      if (code === "device_revoked" || code === "device_not_paired") {
        cancelStepUp();
        clearSessionScope();
        setLock(null);
        setActiveSession(null);
        setCatalog([]);
        setGateReason(code);
      } else {
        // The server's reason replaces an idle, manual or renew lock (and
        // ends a soft unlock), so no offline "Continuar como" remains for a
        // session it rejected; nothing replaces it but a PIN (ACC-18).
        setSoftUnlocked(null);
        setLock((current) => nextLock(current, code));
      }
    };
    window.addEventListener("gm-unauthorized", unauthorized);
    registerStepUpHandler(
      (sessionId) =>
        new Promise<void>((resolve, reject) => {
          // One prompt at a time: a newer request replaces an older one.
          stepUpRef.current?.reject(new ApiError("step_up_cancelled", 403));
          const request = { sessionId, resolve, reject };
          stepUpRef.current = request;
          setStepUpRequest(request);
        }),
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
    // A renewal prompt left on screen still auto-locks (its "Ahora no" must
    // not outlive the auto-lock, ACC-FLOOR-6).
    Boolean(session) && (!lock || lock.reason === "renew") && !sessionChanged,
    () => {
      // Another tab of this session still in use defers the lock (ACC-21).
      const s = sessionRef.current;
      const seconds = s?.access?.idleLockSeconds;
      const wait = s && seconds ? idleElsewhereWait(s.id, seconds) : 0;
      if (wait > 0) return wait;
      setLock(idleLock);
    },
    () => {
      if (sessionRef.current) noteActivity(sessionRef.current.id);
    },
  );
  useEffect(() => {
    // Remembered until a PIN unlock, a new sign-in or a sign-out (SEC-6);
    // a renewal prompt is this tab's own and is not.
    if (session && lock && remembered(lock.reason))
      rememberLock(session.id, lock.reason);
  }, [session?.id, lock?.reason]);
  useEffect(() => {
    // A lock in another tab of the same session locks this tab too (SEC-6),
    // except an idle one: each tab judges idleness itself (ACC-21).
    const lockedElsewhere = (event: StorageEvent) => {
      const s = sessionRef.current;
      const reason =
        event.key === LOCK_KEY && s
          ? lockFromOtherTab(event.newValue, s.id)
          : null;
      if (!reason) return;
      setSoftUnlocked(null);
      setLock((current) => nextLock(current, reason));
    };
    window.addEventListener("storage", lockedElsewhere);
    return () => window.removeEventListener("storage", lockedElsewhere);
  }, []);
  useEffect(() => {
    // The offline soft unlock ends when the server is reachable again or the
    // offline window ends; the same lock comes back.
    if (
      softUnlocked &&
      session &&
      (reachable || new Date(session.offlineUntil).getTime() <= now)
    ) {
      const reason = softUnlocked;
      setSoftUnlocked(null);
      setLock((current) => nextLock(current, reason));
    }
  }, [softUnlocked, reachable, now, session?.offlineUntil]);
  useEffect(() => {
    // A soft unlock over a real lock never works online (ACC-R-2): before any
    // call, ask the server; if it answers, the same lock comes back at once
    // and the call is refused unsent. A renewal prompt's soft unlock is not a
    // lock (the session is valid), so its calls go through.
    if (!softUnlocked || softUnlocked === "renew") return;
    const reason = softUnlocked;
    registerSoftUnlockCheck(async () => {
      // Offline's probe (contract §0.8). Its mode needs two answers in a row
      // to turn "online", so the question here is whether the server answered
      // at all since this call asked (the probe, or any other request).
      const asked = Date.now();
      await probeNow();
      const net = getConnectivitySnapshot();
      if (!net.serverReachable && (net.lastContactAt ?? 0) < asked)
        return false;
      setSoftUnlocked(null);
      setLock((current) => nextLock(current, reason));
      return true;
    });
    return () => registerSoftUnlockCheck(null);
  }, [softUnlocked]);
  useEffect(() => {
    // Whatever replaced or ended the session, its pending step-up goes (ACC-20).
    if (stepUpRef.current && stepUpRef.current.sessionId !== session?.id)
      cancelStepUp();
  }, [session?.id]);
  useEffect(() => {
    if (!session || sessionChanged) return;
    // Keeps the sliding expiry and renewed offline window current (OFF-3);
    // only the "session" cache entry is written (D15).
    return startHeartbeat(
      (s) => {
        // A reply sent before a session 401 seen meanwhile neither unblocks
        // requests nor puts the rejected session back in the cache.
        if (requestsBlocked()) return;
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
    // A logout the server has not confirmed yet ends as soon as it answers,
    // also in manual offline mode (the server is reachable there).
    if (reachable) void finishPendingLogout();
  }, [reachable]);
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("gm-locale", locale);
  }, [locale]);
  const { queued, oldestUnresolvedAt } = useOfflineQueue(
    session && !sessionChanged ? session : null,
  );
  useEffect(() => {
    if (!session || sessionChanged) return;
    // A session 401 always shows its lock: if nothing shows one while calls
    // are blocked, put it back (ACC-FLOOR-2). Sync runs in useOfflineQueue; a
    // call refused while blocked is classified as auth there, never as a
    // conflict (OFF-7).
    const poll = () => {
      const rejected = blockedReason();
      if (rejected) {
        setSoftUnlocked(null);
        setLock((current) => nextLock(current, rejected));
      }
    };
    poll();
    const timer = setInterval(poll, 10000);
    return () => clearInterval(timer);
  }, [session, sessionChanged]);
  async function ownerReady() {
    cancelStepUp();
    setLeaving(null);
    setSoftUnlocked(null);
    setLock(null);
    clearSessionScope();
    setActiveSession(null);
    setCatalog([]);
    setLoading(true);
    setShowAccount(false);
    setGateReason("");
    history.replaceState(null, "", "/app");
    await load(true, true);
  }
  /**
   * Flow H: sync first, warn about unsent sales or a missing connection, then
   * end the server session. Signing out always succeeds locally (SEC-6/OFF-7).
   */
  async function signOut(force = false) {
    const s = session;
    if (!s) return;
    if (!force) {
      // "Sin conexión" means the server does not answer, not the "Trabajar
      // sin conexión" preference: in manual mode the next employee can sign
      // in and queued sales still sync (OFF-R16).
      if (!reachable) {
        setLeaving({ kind: "offline" });
        return;
      }
      // A session the server already ended cannot sync; only count.
      const left =
        lock && !["idle", "manual", "renew"].includes(lock.reason)
          ? await unsyncedFor(s)
          : await drainBeforeLeaving(s, reachable);
      if (left.sales > 0 || left.payment) {
        setLeaving({ kind: "pending", ...left });
        return;
      }
    }
    setLeaving(null);
    cancelStepUp();
    await serverSignOut(s.id);
    await db.cache.delete("session");
    clearSessionScope();
    localStorage.setItem("gm-session-generation", crypto.randomUUID());
    forgetLock();
    setSoftUnlocked(null);
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
          <OfflineLoginNotice locale={locale} />
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
              // Sign-in needs the server, not the selling preference (OFF-R16).
              online={reachable}
              reason={gateReason}
              signupFirst={new URLSearchParams(location.search).has("signup")}
              onSignedIn={async () => {
                // The PIN just entered supersedes any remembered lock, logout
                // or step-up of the previous session.
                clearPendingLogout();
                forgetLock();
                cancelStepUp();
                setSoftUnlocked(null);
                setLock(null);
                setGateReason("");
                await load(true, true);
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
              view === name ||
              (name === "operation" && operational) ||
              (name === "inventory" && setupViews.includes(view));
            return (
              <button
                key={name}
                className={current ? "selected" : ""}
                onClick={() => {
                  setView(
                    name === "operation"
                      ? "sell"
                      : name === "inventory"
                        ? "menu"
                        : name,
                  );
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
          <ConnectionPill
            locale={locale}
            queued={queued}
            onOpen={() => setView("sync")}
          />
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
            onClick={() => setLock((current) => nextLock(current, "manual"))}
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
          (management && (operational || setupViews.includes(view))
            ? " with-subnav"
            : "")
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
        {management && setupViews.includes(view) && (
          <SetupNav view={view} setView={setView} locale={locale} />
        )}
        <ConnectionBanner
          session={session}
          locale={locale}
          queued={queued}
          oldestUnresolvedAt={oldestUnresolvedAt}
          onOpenSync={() => setView("sync")}
          onOpenTickets={() => setTicketsOpen(true)}
        />
        <UpdatePrompt locale={locale} session={session} />
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
            <Button
              onClick={() => setLock((current) => nextLock(current, "renew"))}
            >
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
        {view !== "sell" &&
          (["menu", "stock", "floor"].includes(view) ? (
            <MenuArea
              key={`${scope(session)}:${view}`}
              view={view}
              session={session}
              locale={locale}
              online={online}
              navigate={setView}
            />
          ) : (
            <Operations
              key={`${scope(session)}:${view}`}
              view={view}
              session={session}
              locale={locale}
              online={online}
              navigate={setView}
            />
          ))}
      </main>
      {ticketsOpen && (
        <LocalKitchenTickets
          session={session}
          locale={locale}
          close={() => setTicketsOpen(false)}
        />
      )}
      {lock && (
        <LockScreen
          session={session}
          reason={lock.reason}
          online={reachable}
          locale={locale}
          overlayOpen={Boolean(leaving)}
          onUnreachable={() => void probeNow()}
          onDismiss={() => {
            // Only a renewal the cashier started; the session is still valid.
            // A pending offline soft unlock keeps its own re-lock.
            if (lock.reason !== "renew") return;
            setLock(null);
          }}
          onUnlocked={(s) => {
            const sameEmployee = scope(s) === scope(session);
            setSession(s);
            clearPendingLogout();
            forgetLock();
            setSoftUnlocked(null);
            noteActivity(s.id, true);
            if (s.id !== session.id) {
              // The previous session's prompts and warnings are not the new one's.
              cancelStepUp();
              setLeaving(null);
              localStorage.setItem("gm-session-generation", crypto.randomUUID());
            }
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
            // Never past a lock the server imposed (ACC-18), nor while a
            // session 401 blocks calls (ACC-FLOOR-2).
            if (!allowsContinueOffline(lock.reason) || requestsBlocked()) return;
            // The lock stays remembered: a reload or the server answering
            // again asks for the PIN again. An earlier soft unlock keeps its
            // reason, so a renewal prompt never turns an idle re-lock into one
            // that offers "Ahora no".
            const reason = lock.reason;
            setSoftUnlocked((current) => current ?? reason);
            setLock(null);
          }}
          onSignOut={() => void signOut()}
        />
      )}
      {/* Never over the lock, and only for the session that asked (ACC-20). */}
      {stepUpRequest && !lock && stepUpRequest.sessionId === session.id && (
        <StepUpDialog
          session={session}
          locale={locale}
          onConfirmed={() => {
            stepUpRef.current = null;
            stepUpRequest.resolve();
            setStepUpRequest(null);
          }}
          onCancel={cancelStepUp}
          onSessionEnded={(error) => {
            const pending = stepUpRef.current;
            stepUpRef.current = null;
            setStepUpRequest(null);
            pending?.reject(error);
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
              {/* Already locked: a lock the server imposed must keep its
                  reason, so no manual lock is offered over it (ACC-18). */}
              {leaving.kind === "offline" && !lock && (
                <Button
                  onClick={() => {
                    setLeaving(null);
                    setLock((current) => nextLock(current, "manual"));
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
