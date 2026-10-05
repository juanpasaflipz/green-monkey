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
  Wifi,
  WifiOff,
  ArrowRight,
  ChevronDown,
} from "lucide-react";
import type { Session, Locale, Product } from "../shared/domain";
import { strings, translateError, type Key } from "./i18n";
import { api, setSession, clearSessionScope } from "./api";
import { db, cacheSession, scope, syncPending } from "./offline";
import { Button, Field } from "./components/ui";
import { Selling } from "./features/Selling";
import { MenuArea, SetupNav, setupViews } from "./features/menu/MenuArea";
import { menuBaseline, watchMenuRevision } from "./features/menu/freshness";
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
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(0);
  const [ownerAccess, setOwnerAccess] = useState(false);
  const [showAccount, setShowAccount] = useState(
    new URLSearchParams(location.search).has("account") ||
      location.hash.startsWith("#invite="),
  );
  const [sessionChanged, setSessionChanged] = useState(false);
  const t = (key: Key) => strings[locale][key];
  async function load(resetView = true) {
    try {
      const s = await api<Session>("/session");
      setSession(s);
      const c = await api<Product[]>("/catalog");
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
  useEffect(() => {
    if (!session || sessionChanged) return;
    const s = session;
    const poll = async () => {
      if (navigator.onLine) await syncPending(s);
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
              await load();
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
                await load();
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
              key={view}
              view={view}
              session={session}
              locale={locale}
              navigate={setView}
            />
          ))}
      </main>
    </div>
  );
}
