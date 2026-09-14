import { BrandLogo } from "./components/BrandLogo";
import { useEffect, useState } from "react";
import {
  ShoppingBag,
  ClipboardList,
  LayoutGrid,
  Wallet,
  ChartNoAxesCombined,
  Package,
  Users,
  Settings,
  ChefHat,
  LogOut,
  Wifi,
  WifiOff,
  ArrowRight,
} from "lucide-react";
import type { Session, Locale, Product } from "../shared/domain";
import { strings, translateError, type Key } from "./i18n";
import { api, setSession } from "./api";
import { db, cacheSession, scope, syncPending } from "./offline";
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
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(0);
  const [ownerAccess, setOwnerAccess] = useState(false);
  const t = (key: Key) => strings[locale][key];
  async function load(resetView = true) {
    try {
      const s = await api<Session>("/session");
      setSession(s);
      setActiveSession(s);
      const c = await api<Product[]>("/catalog");
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
    const refreshSession = () => void load(false);
    window.addEventListener("gm-session-refresh", refreshSession);
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("gm-session-refresh", refreshSession);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);
  useEffect(() => {
    if (view === "sell" && session && online)
      void api<Product[]>("/catalog").then((c) => {
        setCatalog(c);
        void cacheSession(session, c);
      });
  }, [view]);
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("gm-locale", locale);
  }, [locale]);
  useEffect(() => {
    if (!session) return;
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
  }, [session, online]);
  if (loading)
    return (
      <div className="login">
        <p>{t("loading")}</p>
      </div>
    );
  if (!session)
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
          {ownerAccess && (
            <Button onClick={() => setLocale(locale === "es" ? "en" : "es")}>
              {locale === "es" ? "English" : "Español"}
            </Button>
          )}
          <OwnerAccess
            locale={locale}
            onReady={load}
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
            ["today", ChartNoAxesCombined],
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
  return (
    <div className="app">
      <header className="topbar">
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
        <div className="scope">
          <strong>{session.restaurant.name}</strong>
          <span>
            {session.name} · {t(session.role as Key)}
          </span>
        </div>
        <div className="top-actions">
          <button
            className={`connection ${online ? "" : "warning"}`}
            aria-label={`${t(online ? "connected" : "offline")}${queued > 0 ? ` · ${queued}` : ""}`}
            onClick={() => setView("sync")}
          >
            {online ? <Wifi size={16} /> : <WifiOff size={16} />}
            <span>
              {t(online ? "connected" : "offline")}
              {queued > 0 ? ` · ${queued}` : ""}
            </span>
          </button>
          <Button
            variant="ghost"
            onClick={() => setLocale(locale === "es" ? "en" : "es")}
          >
            {locale.toUpperCase()}
          </Button>
          <Button
            variant="ghost"
            aria-label={t("logout")}
            onClick={async () => {
              try {
                await api("/logout", {});
                await db.cache.delete("session");
                setActiveSession(null);
                setCatalog([]);
              } catch (e) {
                setError(translateError((e as Error).message, locale));
              }
            }}
          >
            <LogOut size={19} />
          </Button>
        </div>
      </header>
      <nav className="rail" aria-label={t("operation")}>
        {nav.map(([key, Icon]) => {
          const name = key as string;
          const Glyph = Icon as typeof ShoppingBag;
          return (
            <button
              key={name}
              className={
                view === name || (name === "operation" && operational)
                  ? "selected"
                  : ""
              }
              onClick={() => {
                setView(name === "operation" ? "sell" : name);
                setError("");
              }}
              aria-current={
                view === name || (name === "operation" && operational)
                  ? "page"
                  : undefined
              }
            >
              <Glyph size={22} />
              <span>{t(name as Key)}</span>
            </button>
          );
        })}
      </nav>
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
    </div>
  );
}
