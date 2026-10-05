import { BrandLogo } from "./components/BrandLogo";
import { useEffect, useState } from "react";
import {
  ShoppingBag,
  ClipboardList,
  LayoutGrid,
  Wallet,
  ChartNoAxesCombined,
  House,
  Package,
  Users,
  Settings,
  ChefHat,
  LogOut,
  ArrowRight,
  ChevronDown,
} from "lucide-react";
import type { Session, Locale, Product } from "../shared/domain";
import { strings, translateError, type Key } from "./i18n";
import { api, ApiError, setSession, clearSessionScope } from "./api";
import { db, cacheSession, scope } from "./offline";
import {
  getConnectivitySnapshot,
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
import { Button, Field } from "./components/ui";
import { Selling } from "./features/Selling";
import { Operations } from "./features/Operations";
import { OwnerAccess } from "./features/OwnerAccess";
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
  const [ownerAccess, setOwnerAccess] = useState(false);
  const [showAccount, setShowAccount] = useState(
    new URLSearchParams(location.search).has("account") ||
      location.hash.startsWith("#invite="),
  );
  const [sessionChanged, setSessionChanged] = useState(false);
  const t = (key: Key) => strings[locale][key];
  /** Offline restore: only a cached session whose offline window is still open. */
  async function restoreCached() {
    const cached = (await db.cache.get("session"))?.value as
      Session | undefined;
    if (cached && Date.parse(cached.offlineUntil) > serverNow()) {
      setActiveSession(cached);
      setSession(cached);
      setCatalog((await db.cache.get(scope(cached) + ":catalog"))?.value ?? []);
    }
  }
  /**
   * `signedIn`: right after an explicit sign-in (login form or owner access),
   * the server session is always read, even in manual offline mode; manual
   * mode only skips the startup check (OFF-R16).
   */
  async function load(resetView = true, signedIn = false) {
    if (getConnectivitySnapshot().manual && !signedIn) {
      await restoreCached();
      setLoading(false);
      return;
    }
    try {
      const s = await api<Session>("/session");
      setSession(s);
      const c = await api<Product[]>("/catalog");
      setActiveSession(s);
      setCatalog(c);
      await cacheSession(s, c);
      void requestPersistence();
      void ensureDevicePrefix(s);
      if (resetView)
        setView(
          s.role === "kitchen"
            ? "kitchen"
            : s.role === "owner"
              ? "today"
              : "sell",
        );
    } catch (e) {
      setActiveSession(null);
      setCatalog([]);
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
    document.documentElement.lang = locale;
    localStorage.setItem("gm-locale", locale);
  }, [locale]);
  const { queued, oldestUnresolvedAt } = useOfflineQueue(
    session && !sessionChanged ? session : null,
  );
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
          <p>{t("loginHint")}</p>
          <div className="login-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="login-form">
          <OfflineLoginNotice locale={locale} />
          {session && (
            <Button onClick={() => setShowAccount(false)}>
              {locale === "es" ? "Volver al restaurante" : "Back to restaurant"}
            </Button>
          )}
          {ownerAccess && (
            <Button onClick={() => setLocale(locale === "es" ? "en" : "es")}>
              {locale === "es" ? "English" : "Español"}
            </Button>
          )}
          <OwnerAccess
            locale={locale}
            onReady={async () => {
              clearSessionScope();
              setActiveSession(null);
              setCatalog([]);
              setLoading(true);
              setShowAccount(false);
              history.replaceState(null, "", "/app");
              await load(true, true);
            }}
            onAccount={setOwnerAccess}
          />
          <form
            hidden={ownerAccess}
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              const f = new FormData(e.currentTarget);
              try {
                await api("/login", Object.fromEntries(f));
                await load(true, true);
              } catch (err) {
                setError(translateError((err as Error).message, locale));
              }
            }}
          >
            <div className="row between">
              <h2>{t("login")}</h2>
              <Button
                onClick={() => setLocale(locale === "es" ? "en" : "es")}
                type="button"
              >
                {locale === "es" ? "English" : "Español"}
              </Button>
            </div>
            <Field label={t("restaurant")}>
              <input
                name="tenantId"
                defaultValue="10000000-0000-4000-8000-000000000001"
                required
              />
            </Field>
            <Field label={t("user")}>
              <input
                name="login"
                autoComplete="username"
                defaultValue="owner"
                required
              />
            </Field>
            <Field label={t("secret")}>
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
            <Button variant="primary" type="submit">
              {t("login")}
              <ArrowRight size={20} />
            </Button>
            <p className="muted">{t("demo")}</p>
          </form>
        </div>
      </div>
    );
  const management = ["owner", "manager"].includes(session.role);
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
          {management && (
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
            aria-label={t("logout")}
            onClick={async () => {
              try {
                await api("/logout", {});
                await db.cache.delete("session");
                clearSessionScope();
                localStorage.setItem(
                  "gm-session-generation",
                  crypto.randomUUID(),
                );
                setActiveSession(null);
                setCatalog([]);
              } catch (e) {
                setError(translateError((e as Error).message, locale));
              }
            }}
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
        <ConnectionBanner
          session={session}
          locale={locale}
          queued={queued}
          oldestUnresolvedAt={oldestUnresolvedAt}
          onOpenSync={() => setView("sync")}
          onOpenTickets={() => setTicketsOpen(true)}
        />
        <UpdatePrompt locale={locale} session={session} />
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
        <div hidden={view !== "sell"}>
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
            key={view}
            view={view}
            session={session}
            locale={locale}
            navigate={setView}
          />
        )}
      </main>
      {ticketsOpen && (
        <LocalKitchenTickets
          session={session}
          locale={locale}
          close={() => setTicketsOpen(false)}
        />
      )}
    </div>
  );
}
