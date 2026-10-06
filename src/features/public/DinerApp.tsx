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
import { DinerMenu } from "./DinerMenu";
import { DinerCart } from "./DinerCart";
import { DinerStatus } from "./DinerStatus";
import { DinerNotice } from "./DinerNotice";
import { KioskDone } from "./KioskDone";
import { PrivacyDialog } from "./PrivacyDialog";
import { Button, Modal } from "../../components/ui";
import { PLATFORM_PRIVACY_PATH } from "./dinerRoute";
import "./diner.css";

export type DraftLine = {
  id: string;
  productId: string;
  quantity: number;
  options: string[];
};
export type Draft = { lines: DraftLine[]; name: string; note: string };
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
  const [view, setView] = useState<"menu" | "status" | "kiosk-done">(() =>
    !kiosk && readStored(token).length ? "status" : "menu",
  );
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
  const failures = useRef(0);
  const baseline = useRef<number | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  /** Request outcomes drive the kiosk's offline overlay (never navigator.onLine). */
  const outcome = (e?: unknown) => {
    if (e === undefined) {
      failures.current = 0;
      setOffline(false);
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

  // MENU-R1: polls are spread, skipped while hidden or off the menu, and the
  // revision call also refreshes whether ordering is open.
  const ready = menu !== null;
  useEffect(() => {
    if (!ready) return;
    return watchMenuRevision<PublicMenuView>({
      revision: async () => {
        try {
          const r = await dinerApi.revision(token);
          outcome();
          setOrdering(r.ordering);
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
    () =>
      priceCart(
        draft.lines.map((l) => ({ ...l, note: "" })),
        catalog,
        false,
      ),
    [draft.lines, catalog],
  );

  /** Any cart edit after an unknown outcome starts a new order (new keys). */
  function edit(update: (d: Draft) => Draft) {
    setDraft(update);
    key.current = null;
    setUnknown(null);
    setError("");
  }
  function add(p: Product, options: string[] = []) {
    edit((d) => {
      const same = d.lines.find(
        (l) =>
          l.productId === p.id &&
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

  const header = (
    <header className="diner-header">
      <div>
        <h1>{menu.restaurant.name}</h1>
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
    <main className={"diner" + (kiosk ? " kiosk" : "")} lang={locale}>
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
              onPick={(p) => (pickerNeeded(p) ? setPicker(p) : add(p))}
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
      {idleWarn && (
        <IdleWarning locale={locale} onContinue={() => setIdleWarn(false)} />
      )}
      {offline && (
        <div className="diner-offline" role="alert">
          <p>{t("publicKioskOffline")}</p>
        </div>
      )}
    </main>
  );
}

/** "¿Sigues ahí?": shown 15 s before the kiosk clears the order. */
function IdleWarning({
  locale,
  onContinue,
}: {
  locale: Locale;
  onContinue: () => void;
}) {
  const t = strings[locale];
  const total = (KIOSK_TIMING.resetAfterMs - KIOSK_TIMING.warnAfterMs) / 1000;
  const [seconds, setSeconds] = useState(total);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () =>
        setSeconds(
          Math.max(0, total - Math.floor((Date.now() - started) / 1000)),
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <Modal
      title={t.publicIdleTitle}
      close={onContinue}
      closeLabel={t.publicIdleContinue}
      footer={
        <Button variant="primary" onClick={onContinue}>
          {t.publicIdleContinue}
        </Button>
      }
    >
      <p>{fill(t.publicIdleBody, { seconds })}</p>
    </Modal>
  );
}
