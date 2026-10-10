import { useEffect, useMemo, useRef, useState } from "react";
import type { Locale, Product } from "../../../shared/domain";
import {
  KIOSK_TIMING,
  type DinerHoldView,
  type OrderingState,
  type PublicMenuView,
} from "../../../shared/public-ordering";
import { strings, type Key } from "../../i18n";
import { ApiError } from "../../api";
import { ModifierPicker } from "../../components/ModifierPicker";
import { pickerNeeded } from "../../../shared/menu";
import { CATALOG_ERRORS, priceCart } from "../menu/cart";
import { fill } from "../menu/format";
import {
  MENU_REFRESH_EVENT,
  PUBLIC_MENU_POLL,
  advanceBaseline,
  watchMenuRevision,
} from "../menu/freshness";
import {
  dinerApi,
  guestError,
  isTransient,
  newStatusKey,
  noticeFor,
  type DinerOrderBody,
} from "./dinerApi";
import { useKioskIdle } from "./kioskIdle";
import { IdleWarning } from "./IdleWarning";
import { DinerMenu } from "./DinerMenu";
import { DinerCart } from "./DinerCart";
import { DinerStatus } from "./DinerStatus";
import { DinerNotice } from "./DinerNotice";
import { KioskDone } from "./KioskDone";
import { PrivacyDialog } from "./PrivacyDialog";
import { Button } from "../../components/ui";
import { PLATFORM_PRIVACY_PATH } from "./dinerRoute";
import {
  KIOSK_LIMITS,
  pickSuggestions,
  type KioskMenuBlock,
} from "../../../shared/kiosk";
import { orderable } from "../../../shared/menu";
import { kioskApi } from "./kiosk/kioskApi";
import {
  KioskCheckout,
  memberLookupOpen,
  type KioskStep,
} from "./kiosk/KioskCheckout";
import {
  KioskAccessibility,
  KioskMember,
  KioskSetup,
  KioskWelcome,
  SetupGesture,
  type KioskA11y,
} from "./kiosk/KioskScreens";
import { KioskProductSheet, SuggestionStrip } from "./kiosk/KioskProduct";
import {
  enterFullscreen,
  keepAwake,
  viewportClass,
  watchDevice,
} from "./kiosk/kioskDevice";
import "./diner.css";

export type DraftLine = {
  id: string;
  productId: string;
  quantity: number;
  options: string[];
  /** Kiosk (039): added from a suggestion (report attribution only). */
  origin?: "suggestion";
};
export type Draft = { lines: DraftLine[]; name: string; note: string };
/**
 * The cart's lines as the menu prices them: a kiosk line's `origin` is report attribution the
 * server keeps on the hold, not part of a priced line (quote's line input is strict, so a
 * suggestion line would read as invalid and block the cart). Diner lines carry no note.
 */
export const cartInputs = (lines: DraftLine[]) =>
  lines.map(({ origin: _origin, ...l }) => ({ ...l, note: "" }));
/** A diner's own order on this phone (QR only, sessionStorage). */
export type StoredHold = {
  key: string;
  label: string;
  at: number;
  lines: Omit<DraftLine, "id">[];
};
const emptyDraft = (): Draft => ({ lines: [], name: "", note: "" });
const MAX_QUANTITY = 20;
const STORED_HOLDS = 5;
/** A kiosk whose first menu load failed retries on its own (UX-14). */
const KIOSK_LOAD_RETRY_MS = 20_000;

function storageKey(token: string) {
  return "gm-public-holds:" + token.slice(0, 8);
}
function readStored(token: string): StoredHold[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey(token)) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter(
          (h): h is StoredHold =>
            !!h && typeof h.key === "string" && typeof h.label === "string",
        )
      : [];
  } catch {
    return [];
  }
}
function writeStored(token: string, holds: StoredHold[]) {
  try {
    sessionStorage.setItem(
      storageKey(token),
      JSON.stringify(holds.slice(0, STORED_HOLDS)),
    );
  } catch {
    /* Private mode or full storage: the status still shows until reload. */
  }
}

/**
 * The diner page: loading → menu (or a full-page notice) → status (QR) or
 * the kiosk's done screen. Online only: no local queue and no service
 * worker; failures are detected from request outcomes only.
 */
export function DinerApp({
  channel,
  token,
}: {
  channel: "qr" | "kiosk";
  token: string;
}) {
  const kiosk = channel === "kiosk";
  const [locale, setLocale] = useState<Locale>("es");
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const [menu, setMenu] = useState<PublicMenuView | null>(null);
  const [ordering, setOrdering] = useState<OrderingState | null>(null);
  const [notice, setNotice] = useState<"invalid" | "unavailable" | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const key = useRef<{ operationId: string; statusKey: string } | null>(null);
  const [unknown, setUnknown] = useState<DinerOrderBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<Product | null>(null);
  // A reload of a QR page returns to this phone's latest order.
  const [view, setView] = useState<
    "menu" | "status" | "kiosk-done" | "checkout"
  >(() => (!kiosk && readStored(token).length ? "status" : "menu"));
  const [holds, setHolds] = useState<StoredHold[]>(() =>
    kiosk ? [] : readStored(token),
  );
  const [current, setCurrent] = useState<string | null>(() =>
    kiosk ? null : (readStored(token)[0]?.key ?? null),
  );
  const [done, setDone] = useState<DinerHoldView | null>(null);
  const [offline, setOffline] = useState(false);
  const [idleWarn, setIdleWarn] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [privacy, setPrivacy] = useState(false);
  // The code stopped working on a submit: the page keeps the menu and the
  // cart and says so next to "Ver mis pedidos" (UX-1).
  const [submitInvalid, setSubmitInvalid] = useState(false);
  // Focus moves to the status heading after a user action switched to it (UX-6).
  const [focusStatus, setFocusStatus] = useState(false);
  const [loadFailures, setLoadFailures] = useState(0);
  // Kiosk self-checkout (039): the station's state, the welcome screen of a bound tablet, the
  // hidden setup form, the club lookup, accessibility, and the product sheet.
  const [kioskState, setKioskState] = useState<KioskMenuBlock | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [setup, setSetup] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  // The member the guest identified (KIOSK-UX-02: the token and the masked phone of the chip).
  const [member, setMember] = useState<{
    token: string;
    maskedPhone: string;
  } | null>(null);
  const memberToken = member?.token ?? null;
  const [checkoutStep, setCheckoutStep] = useState<KioskStep | null>(null);
  const [a11yOpen, setA11yOpen] = useState(false);
  const [a11y, setA11y] = useState<KioskA11y>({ large: false, reach: false });
  const [sheet, setSheet] = useState<Product | null>(null);
  const failures = useRef(0);
  const baseline = useRef<number | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const noticeRef = useRef(notice);
  noticeRef.current = notice;

  /** Request outcomes drive the kiosk's offline overlay (never navigator.onLine). */
  const outcome = (e?: unknown) => {
    if (e === undefined) {
      failures.current = 0;
      setOffline(false);
      // "Not available" (the kill switch, a Pro lapse) is recoverable: any
      // successful call means ordering is back. "invalid" stays: a revoked
      // or replaced code never returns (PUBLIC-UX-1).
      setNotice((n) => (n === "unavailable" ? null : n));
      return;
    }
    if (isTransient(e)) {
      failures.current++;
      if (kiosk && failures.current >= 2) setOffline(true);
      return;
    }
    const n = e instanceof ApiError ? noticeFor(e.message) : null;
    if (n) setNotice(n);
  };

  async function loadMenu() {
    try {
      const m = await dinerApi.menu(token);
      outcome();
      advanceBaseline(baseline, m.revision);
      setMenu(m);
      setOrdering(m.ordering);
      setLoadError("");
      return m;
    } catch (e) {
      outcome(e);
      if (!noticeFor((e as Error).message)) {
        setLoadError(guestError((e as Error).message, locale));
        if (isTransient(e)) setLoadFailures((n) => n + 1);
      }
      throw e;
    }
  }
  useEffect(() => {
    void loadMenu().catch(() => {});
  }, [token]);
  async function loadKioskState(first = false) {
    try {
      const k = await kioskApi.state(token);
      setKioskState(k);
      if (first && k.bound) setWelcome(true);
    } catch {
      // Unknown: the kiosk keeps working as a counter-only kiosk.
    }
  }
  useEffect(() => {
    if (!kiosk) return;
    void loadKioskState(true);
    const timer = setInterval(
      () => void loadKioskState(),
      KIOSK_LIMITS.heartbeatMs,
    );
    return () => clearInterval(timer);
  }, [kiosk, token]);
  const bound = !!kioskState?.bound;
  const idleRef = useRef(true);
  idleRef.current = welcome && draft.lines.length === 0;
  // A bound tablet: heartbeat and new-build reload every minute, and a wake lock while visible.
  useEffect(() => {
    if (!kiosk || !bound) return;
    const stopWatch = watchDevice({
      everyMs: KIOSK_LIMITS.heartbeatMs,
      beat: () =>
        kioskApi.heartbeat(
          token,
          (
            (import.meta as unknown as { env?: Record<string, string> }).env
              ?.VITE_BUILD_ID ?? "local"
          ).slice(0, 40),
          viewportClass(window.innerWidth, window.innerHeight),
        ),
      idle: () => idleRef.current,
      reload: () => window.location.reload(),
    });
    const stopAwake = keepAwake(() => true);
    return () => {
      stopWatch();
      stopAwake();
    };
  }, [kiosk, bound, token]);
  // A kiosk that powered on before the network keeps trying until the menu
  // loads, without anyone tapping "Reintentar" (UX-14).
  useEffect(() => {
    if (!kiosk || menu || !loadFailures) return;
    const timer = setTimeout(
      () => void loadMenu().catch(() => {}),
      KIOSK_LOAD_RETRY_MS,
    );
    return () => clearTimeout(timer);
  }, [kiosk, menu, loadFailures]);
  // A kiosk that booted while ordering was not available (the kill switch, a
  // Pro lapse) has no menu and so no revision poll: it keeps asking for the
  // menu until ordering is back (PUBLIC-UX-1).
  useEffect(() => {
    if (!kiosk || menu || notice !== "unavailable") return;
    const timer = setInterval(
      () => void loadMenu().catch(() => {}),
      KIOSK_LOAD_RETRY_MS,
    );
    return () => clearInterval(timer);
  }, [kiosk, menu, notice]);

  // MENU-R1: polls are spread, skipped while hidden or off the menu, and the
  // revision call also refreshes whether ordering is open.
  const ready = menu !== null;
  useEffect(() => {
    if (!ready) return;
    return watchMenuRevision<PublicMenuView>({
      revision: async () => {
        try {
          const r = await dinerApi.revision(token);
          // Back from "not available": the notice clears and the catalog is
          // fetched again, whatever the revision says (PUBLIC-UX-1).
          const recovered = noticeRef.current === "unavailable";
          outcome();
          setOrdering(r.ordering);
          if (recovered) window.dispatchEvent(new Event(MENU_REFRESH_EVENT));
          return r.revision;
        } catch (e) {
          outcome(e);
          throw e;
        }
      },
      catalog: () => loadMenu(),
      apply: () => {},
      baseline: {
        get: () => baseline.current,
        set: (revision) => advanceBaseline(baseline, revision),
      },
      win: window,
      doc: document,
      ...PUBLIC_MENU_POLL,
      active: () =>
        document.visibilityState === "visible" && viewRef.current === "menu",
    });
  }, [token, ready]);

  const catalog = menu?.catalog ?? [];
  const cart = useMemo(
    () => priceCart(cartInputs(draft.lines), catalog, false),
    [draft.lines, catalog],
  );

  /** Any cart edit after an unknown outcome starts a new order (new keys). */
  function edit(update: (d: Draft) => Draft) {
    setDraft(update);
    key.current = null;
    setUnknown(null);
    setError("");
  }
  function add(p: Product, options: string[] = [], origin?: "suggestion") {
    setSheet(null);
    edit((d) => {
      const same = d.lines.find(
        (l) =>
          l.productId === p.id &&
          l.origin === origin &&
          l.options.length === options.length &&
          l.options.every((o, i) => o === options[i]),
      );
      return {
        ...d,
        lines: same
          ? d.lines.map((l) =>
              l === same
                ? { ...l, quantity: Math.min(MAX_QUANTITY, l.quantity + 1) }
                : l,
            )
          : [
              ...d.lines,
              {
                id: crypto.randomUUID(),
                productId: p.id,
                quantity: 1,
                options,
                ...(origin ? { origin } : {}),
              },
            ],
      };
    });
    setPicker(null);
  }
  const setQuantity = (id: string, quantity: number) =>
    edit((d) => ({
      ...d,
      lines:
        quantity <= 0
          ? d.lines.filter((l) => l.id !== id)
          : d.lines.map((l) =>
              l.id === id
                ? { ...l, quantity: Math.min(MAX_QUANTITY, quantity) }
                : l,
            ),
    }));

  const refreshCatalog = () =>
    window.dispatchEvent(new Event(MENU_REFRESH_EVENT));

  async function send(body: DinerOrderBody) {
    setBusy(true);
    setError("");
    try {
      const hold = await dinerApi.submit(token, body);
      outcome();
      key.current = null;
      setUnknown(null);
      // UX-6: the confirmation is announced from the page's persistent live
      // region (a sheet that closes or a region inserted already filled is
      // not read).
      if (kiosk) {
        setAnnounce(
          fill(strings[locale].publicKioskSentAnnounce, {
            label: hold.label,
            instructions:
              hold.policy === "pay_first"
                ? strings[locale].publicKioskPayAtCounter
                : strings[locale].publicKioskGoToCounter,
          }),
        );
        setDone(hold);
        setView("kiosk-done");
      } else {
        setAnnounce(
          fill(strings[locale].publicSentAnnounce, { label: hold.label }),
        );
        setFocusStatus(true);
        const next = [
          {
            key: body.statusKey,
            label: hold.label,
            at: Date.now(),
            lines: draft.lines.map(({ productId, quantity, options }) => ({
              productId,
              quantity,
              options,
            })),
          },
          ...holds.filter((h) => h.key !== body.statusKey),
        ].slice(0, STORED_HOLDS);
        writeStored(token, next);
        setHolds(next);
        setCurrent(body.statusKey);
        setView("status");
      }
      setDraft(emptyDraft());
    } catch (e) {
      const code = (e as Error).message;
      // A code replaced since the menu loaded: keep the menu and the cart and
      // say so in place, with the way to this phone's orders (UX-1).
      if (code === "public_link_invalid" && !kiosk && holds.length) {
        setSubmitInvalid(true);
        setNotice("invalid");
        key.current = null;
        setError(guestError(code, locale));
        return;
      }
      outcome(e);
      if (isTransient(e)) {
        // The order may have arrived: the same body (same keys) is retried.
        setUnknown(body);
        return;
      }
      key.current = null;
      setError(guestError(code, locale));
      if (CATALOG_ERRORS.has(code) || code === "public_price_changed")
        refreshCatalog();
      if (
        code === "public_ordering_paused" ||
        code === "public_table_unavailable"
      )
        void dinerApi
          .revision(token)
          .then((r) => setOrdering(r.ordering))
          .catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  function submit() {
    if (kiosk && kioskState) {
      // Kiosk (039): "¿Para aquí o para llevar?" and the payment happen in the checkout.
      setError("");
      setView("checkout");
      return;
    }
    key.current ??= {
      operationId: crypto.randomUUID(),
      statusKey: newStatusKey(),
    };
    void send({
      ...key.current,
      lines: draft.lines,
      name: draft.name.trim(),
      note: draft.note.trim(),
      expectedTotal: cart.total,
    });
  }

  /** The next kiosk customer starts clean, on the current menu, in Spanish. */
  function resetKiosk() {
    key.current = null;
    setUnknown(null);
    setDraft(emptyDraft());
    setPicker(null);
    setIdleWarn(false);
    setPrivacy(false);
    setDone(null);
    setError("");
    setLocale("es");
    setView("menu");
    setSheet(null);
    setSetup(false);
    setMemberOpen(false);
    setMember(null);
    setCheckoutStep(null);
    setA11yOpen(false);
    setA11y({ large: false, reach: false });
    setWelcome(bound);
    window.scrollTo({ top: 0 });
    refreshCatalog();
    setAnnounce(strings.es.publicKioskReset);
  }
  useKioskIdle(
    kiosk && view === "menu" && !notice,
    {
      warnAfterMs: KIOSK_TIMING.warnAfterMs,
      resetAfterMs: KIOSK_TIMING.resetAfterMs,
    },
    {
      dirty: () => draft.lines.length > 0 || picker !== null,
      onWarn: () => setIdleWarn(true),
      onReset: resetKiosk,
    },
  );

  /** Back to the menu with the hold's items in the cart (rejected or expired). */
  function restore(hold: StoredHold | undefined) {
    edit(() => ({
      ...emptyDraft(),
      lines: (hold?.lines ?? []).map((l) => ({
        ...l,
        id: crypto.randomUUID(),
      })),
    }));
    setFocusStatus(false);
    setView("menu");
  }

  // A replaced or deactivated QR still shows this phone's orders (status
  // lookups accept the old code); its menu is gone, also when this page had
  // loaded it before the code was replaced (a later poll says so).
  const ownOrders = notice === "invalid" && !kiosk && !!current;
  // A poll that finds the code gone switches to this phone's orders; a
  // submit that does keeps the menu (the cart says so, UX-1).
  useEffect(() => {
    if (ownOrders && !submitInvalid) setView("status");
  }, [ownOrders]);
  const showOrders = () => {
    setFocusStatus(true);
    setView("status");
  };
  const toMenu = () => {
    setFocusStatus(false);
    setView("menu");
  };
  const statusOnly = ownOrders && view === "status";
  const keepMenu = submitInvalid && view === "menu" && !!menu;
  if (notice && !statusOnly && !keepMenu)
    return (
      <DinerNotice
        kind={notice}
        locale={locale}
        onShowOrders={ownOrders ? showOrders : undefined}
      />
    );
  if (statusOnly)
    return (
      <main className="diner" lang={locale}>
        <p className="diner-closed" role="alert">
          {t("publicInvalidOwnOrders")}
        </p>
        <DinerStatus
          focusHeading={focusStatus}
          token={token}
          locale={locale}
          menu={null}
          statusKey={current!}
          holds={holds}
          onSelect={setCurrent}
          onForget={(k) => {
            const next = holds.filter((h) => h.key !== k);
            writeStored(token, next);
            setHolds(next);
            setCurrent(next[0]?.key ?? null);
          }}
          onNewOrder={toMenu}
          onRestore={toMenu}
        />
      </main>
    );
  if (!menu)
    return (
      <main className="diner" lang={locale}>
        {loadError ? (
          <div className="diner-notice">
            <p role="alert">{loadError}</p>
            <Button onClick={() => void loadMenu().catch(() => {})}>
              {t("publicRetry")}
            </Button>
          </div>
        ) : (
          <p role="status" className="diner-loading">
            {t("loading")}
          </p>
        )}
      </main>
    );

  const inCart = new Set(draft.lines.map((l) => l.productId));
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const sellable = new Set(catalog.filter(orderable).map((p) => p.id));
  const cartSuggestions = kioskState
    ? pickSuggestions(
        kioskState.suggestions.cart.length
          ? kioskState.suggestions.cart
          : kioskState.suggestions.popular,
        { inCart, sellable },
      ).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    : [];
  const pickKiosk = (p: Product) => {
    if (
      p.image ||
      p.description?.es ||
      (kioskState?.suggestions.byProduct[p.id]?.length ?? 0) > 0
    )
      setSheet(p);
    else if (pickerNeeded(p)) setPicker(p);
    else add(p);
  };
  const title = <h1>{menu.restaurant.name}</h1>;
  const header = (
    <header className="diner-header">
      <div>
        {kiosk ? (
          <SetupGesture onSetup={() => setSetup(true)}>{title}</SetupGesture>
        ) : (
          title
        )}
        <p className="diner-place">
          {menu.link.kind === "table"
            ? t("publicOrderingFor", { table: menu.link.tableName ?? "" })
            : [t("publicTakeaway"), menu.link.label]
                .filter(Boolean)
                .join(" · ")}
        </p>
      </div>
      <div className="diner-header-actions">
        {/* UX-2: a diner browsing the menu again gets back to their orders. */}
        {!kiosk && view === "menu" && holds.length > 0 && (
          <Button className="diner-your-orders" onClick={showOrders}>
            {t("publicYourOrdersButton", {
              labels: holds.map((h) => h.label).join(", "),
            })}
          </Button>
        )}
        {kiosk && bound && (
          <Button onClick={() => setA11yOpen(true)}>
            {t("kioskAccessibility")}
          </Button>
        )}
        {kiosk &&
          kioskState?.loyalty &&
          memberLookupOpen(view, view === "checkout" ? checkoutStep : null) && (
            <Button onClick={() => setMemberOpen(true)}>
              {t("kioskMember")}
            </Button>
          )}
        <Button
          className="diner-language"
          onClick={() => setLocale(locale === "es" ? "en" : "es")}
          lang={locale === "es" ? "en" : "es"}
        >
          {t("publicLanguageToggle")}
        </Button>
      </div>
    </header>
  );

  return (
    <main
      className={
        "diner" +
        (kiosk ? " kiosk" : "") +
        (a11y.large ? " kiosk-large" : "") +
        (a11y.reach ? " kiosk-reach" : "")
      }
      lang={locale}
    >
      {view !== "menu" && header}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {view === "status" && current ? (
        <DinerStatus
          focusHeading={focusStatus}
          token={token}
          locale={locale}
          menu={menu}
          statusKey={current}
          holds={holds}
          onSelect={setCurrent}
          onForget={(k) => {
            const next = holds.filter((h) => h.key !== k);
            writeStored(token, next);
            setHolds(next);
            setCurrent(next[0]?.key ?? null);
            if (!next.length) setView("menu");
          }}
          onNewOrder={toMenu}
          onRestore={(k) => restore(holds.find((h) => h.key === k))}
        />
      ) : kiosk && welcome && view === "menu" ? (
        <KioskWelcome
          restaurant={menu.restaurant.name}
          locale={locale}
          loyalty={!!kioskState?.loyalty}
          onStart={() => {
            enterFullscreen();
            setWelcome(false);
          }}
          onLanguage={() => setLocale(locale === "es" ? "en" : "es")}
          onAccessibility={() => setA11yOpen(true)}
          onMember={() => setMemberOpen(true)}
          onSetup={() => setSetup(true)}
        />
      ) : view === "checkout" && kioskState ? (
        <KioskCheckout
          token={token}
          locale={locale}
          currency={menu.restaurant.currency}
          kiosk={kioskState}
          body={{
            lines: draft.lines,
            name: draft.name.trim(),
            note: draft.note.trim(),
            expectedTotal: cart.total,
            ...(memberToken ? { memberToken } : {}),
          }}
          announce={setAnnounce}
          onStep={setCheckoutStep}
          onDone={resetKiosk}
          onBack={() => setView("menu")}
          onRefused={(message, code) => {
            setView("menu");
            setError(message);
            if (
              CATALOG_ERRORS.has(code) ||
              code === "public_price_changed" ||
              code === "unavailable"
            )
              refreshCatalog();
          }}
        />
      ) : view === "kiosk-done" && done ? (
        <KioskDone
          hold={done}
          locale={locale}
          currency={menu.restaurant.currency}
          onReset={resetKiosk}
        />
      ) : (
        <div className="diner-layout">
          {/* The header sits in the menu column, so the side cart starts at
              the top of the page and fits the viewport (UX-4). */}
          <div className="diner-main">
            {header}
            <DinerMenu
              menu={menu}
              ordering={ordering ?? menu.ordering}
              locale={locale}
              kiosk={kiosk}
              onPick={(p) =>
                kiosk ? pickKiosk(p) : pickerNeeded(p) ? setPicker(p) : add(p)
              }
            />
          </div>
          <DinerCart
            menu={menu}
            ordering={ordering ?? menu.ordering}
            locale={locale}
            draft={draft}
            cart={cart}
            busy={busy}
            error={error}
            unknown={!!unknown}
            kiosk={kiosk}
            invalid={submitInvalid}
            onShowOrders={submitInvalid ? showOrders : undefined}
            onPrivacy={() => setPrivacy(true)}
            onQuantity={setQuantity}
            onName={(name) => edit((d) => ({ ...d, name }))}
            onNote={(note) => edit((d) => ({ ...d, note }))}
            onSend={submit}
            onRetry={() => unknown && void send(unknown)}
            onEditAnyway={() => {
              key.current = null;
              setUnknown(null);
              setError("");
            }}
            extra={
              <>
                {kiosk && member && (
                  <p className="kiosk-member-chip" role="status">
                    {t("kioskMemberChip", { phone: member.maskedPhone })}
                  </p>
                )}
                {kiosk && kioskState?.suggestions && draft.lines.length > 0 ? (
                  <SuggestionStrip
                    title={
                      kioskState.suggestions.cart.length
                        ? t("kioskAnythingElse")
                        : t("kioskPopularNow")
                    }
                    products={cartSuggestions}
                    locale={locale}
                    currency={menu.restaurant.currency}
                    onAdd={(p) =>
                      pickerNeeded(p) ? setPicker(p) : add(p, [], "suggestion")
                    }
                  />
                ) : null}
              </>
            }
          />
        </div>
      )}
      <footer className="diner-footer">
        {/* PRIVACY-2/UX-5: a kiosk never navigates away from /kiosk#token;
            a phone opens the notice in a new tab and keeps its order. */}
        {kiosk ? (
          <button
            type="button"
            className="diner-link"
            onClick={() => setPrivacy(true)}
          >
            {strings[locale].accountGuestPlatformPrivacy}
          </button>
        ) : (
          <a
            href={PLATFORM_PRIVACY_PATH}
            target="_blank"
            rel="noopener noreferrer"
          >
            {strings[locale].accountGuestPlatformPrivacy}
          </a>
        )}
      </footer>
      {privacy && (
        <PrivacyDialog
          locale={locale}
          restaurant={menu.restaurant.name}
          privacyNoticeUrl={menu.restaurant.privacyNoticeUrl}
          onClose={() => setPrivacy(false)}
        />
      )}
      {picker && (
        <ModifierPicker
          product={picker}
          locale={locale}
          currency={menu.restaurant.currency}
          canOpen={false}
          onConfirm={(selection) => add(picker, selection.options)}
          onClose={() => setPicker(null)}
        />
      )}
      {sheet && (
        <KioskProductSheet
          product={sheet}
          catalog={catalog}
          suggestions={kioskState?.suggestions.byProduct[sheet.id] ?? []}
          inCart={inCart}
          locale={locale}
          currency={menu.restaurant.currency}
          onAdd={(p, origin) => add(p, [], origin)}
          onPick={(p) => {
            setSheet(null);
            setPicker(p);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {setup && (
        <KioskSetup
          token={token}
          locale={locale}
          bound={bound}
          onPaired={() => void loadKioskState(true)}
          onClose={() => setSetup(false)}
        />
      )}
      {memberOpen && (
        <KioskMember
          token={token}
          locale={locale}
          onFound={(token, found) =>
            setMember({ token, maskedPhone: found.maskedPhone })
          }
          onClose={() => setMemberOpen(false)}
        />
      )}
      {a11yOpen && (
        <KioskAccessibility
          locale={locale}
          value={a11y}
          onChange={setA11y}
          onClose={() => setA11yOpen(false)}
        />
      )}
      {idleWarn && (
        <IdleWarning
          locale={locale}
          seconds={
            (KIOSK_TIMING.resetAfterMs - KIOSK_TIMING.warnAfterMs) / 1000
          }
          onContinue={() => setIdleWarn(false)}
        />
      )}
      {offline && (
        <div className="diner-offline" role="alert">
          <p>{t("publicKioskOffline")}</p>
        </div>
      )}
    </main>
  );
}
