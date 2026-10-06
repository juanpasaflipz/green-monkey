import { BrandLogo } from "../components/BrandLogo";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { strings, translateError, type Key } from "../i18n";
import { Button, Field, Badge } from "../components/ui";
import { ModifierPicker } from "../components/ModifierPicker";
import { orderable, pickerNeeded } from "../../shared/menu";
import { moneyFormatter } from "./menu/format";
import { CATALOG_ERRORS, priceCart } from "./menu/cart";
import {
  MENU_REFRESH_EVENT,
  PUBLIC_MENU_POLL,
  advanceBaseline,
  watchMenuRevision,
} from "./menu/freshness";
import { UnavailableLines } from "./menu/UnavailableLines";
import {
  type Product,
  type OrderInput,
  type Locale,
} from "../../shared/domain";

type PublicCatalog = {
  restaurant: {
    name: string;
    currency: string;
    /** account (031): the restaurant's own privacy notice for diners. */
    privacyNoticeUrl?: string | null;
  };
  /** Menu revision the catalog includes (read before it). */
  revision?: number;
  catalog: Product[];
};
/** Codes that mean "no online ordering here now" for a diner (account 031). */
const ORDERING_UNAVAILABLE = new Set([
  "pro_required",
  "public_ordering_disabled",
]);
/** Diner-facing error text: never the staff wording about plans. */
function guestError(code: string, locale: Locale) {
  return ORDERING_UNAVAILABLE.has(code)
    ? strings[locale].accountGuestOrderingUnavailable
    : translateError(code, locale);
}
/** Refetch the catalog now (after a catalog error and on each kiosk reset). */
const refreshCatalog = () =>
  window.dispatchEvent(new Event(MENU_REFRESH_EVENT));

export function PublicOrdering() {
  const [, channel, token] = location.pathname.split("/");
  const [locale, setLocale] = useState<Locale>("es");
  const t = (k: Key) => strings[locale][k];
  const [data, setData] = useState<PublicCatalog | null>(null);
  const [draft, setDraft] = useState<OrderInput>({
    operationId: crypto.randomUUID(),
    lines: [],
    mode: "takeaway",
    tableId: null,
    name: "",
    note: "",
    channel: channel as "qr" | "kiosk",
  });
  const [picker, setPicker] = useState<Product | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const baseline = useRef<number | null>(null);
  // MENU-R1: a page showing its sent order no longer polls.
  const sent = useRef(false);
  useEffect(() => {
    sent.current = result !== null;
  }, [result]);
  useEffect(() => {
    void api<PublicCatalog>("/public/" + token + "/catalog")
      .then((d) => {
        advanceBaseline(baseline, d.revision);
        setData(d);
      })
      .catch((e) => {
        if (ORDERING_UNAVAILABLE.has(e.message)) setUnavailable(true);
        setError(guestError(e.message, locale));
      });
  }, [token]);
  // OWNER-2: a kiosk or a table's QR page stays open for hours. Poll the menu
  // revision about every minute and when the page becomes visible again, and
  // refetch the catalog when it moved, so an 86 or a price change reaches
  // the customer before they order. MENU-R1: diners share the venue's IP, so
  // a hidden page or one showing its sent order does not poll, polls are
  // spread (PUBLIC_MENU_POLL), and every catalog payload moves the baseline
  // so a refetch after an error or a kiosk reset is not repeated by the poll.
  const ready = data !== null;
  useEffect(() => {
    if (!ready) return;
    return watchMenuRevision<PublicCatalog>({
      revision: async () =>
        (await api<{ revision: number }>("/public/" + token + "/revision"))
          .revision,
      catalog: () => api<PublicCatalog>("/public/" + token + "/catalog"),
      apply: (d) => {
        advanceBaseline(baseline, d.revision);
        setData(d);
      },
      baseline: {
        get: () => baseline.current,
        set: (revision) => advanceBaseline(baseline, revision),
      },
      win: window,
      doc: document,
      ...PUBLIC_MENU_POLL,
      active: () => document.visibilityState === "visible" && !sent.current,
    });
  }, [token, ready]);
  useEffect(() => {
    if (channel !== "kiosk") return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setDraft((d) => ({
          ...d,
          operationId: crypto.randomUUID(),
          lines: [],
          name: "",
          note: "",
        }));
        setResult(null);
        setPicker(null);
        // The next customer starts clean, on the current menu.
        setError("");
        refreshCatalog();
      }, 90000);
    };
    reset();
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [channel]);
  // Same es-MX / en-US currency format as the POS and the picker.
  const m = moneyFormatter(locale, data?.restaurant.currency ?? "MXN");
  // Per line: one product 86'd after it was added never blanks the order.
  const cart = priceCart(draft.lines, data?.catalog ?? [], false);
  const lines = cart.lines.flatMap((l) => (l.priced ? [l.priced] : []));
  const total = cart.total;
  function setLines(
    update: (lines: OrderInput["lines"]) => OrderInput["lines"],
  ) {
    setDraft((d) => ({ ...d, lines: update(d.lines) }));
    setError("");
  }
  function add(p: Product, selection: { options: string[] } = { options: [] }) {
    setLines((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        productId: p.id,
        quantity: 1,
        options: selection.options,
        note: "",
      },
    ]);
    setPicker(null);
  }
  const remove = (id: string) =>
    setLines((current) => current.filter((x) => x.id !== id));
  // Ordering is off (production default until wave 3) or the restaurant has no
  // Pro: the diner sees only where to order instead (§2.15).
  if (unavailable)
    return (
      <div className="public-ordering">
        <header className="row between">
          <div className="brand">
            <BrandLogo />
          </div>
          <Button onClick={() => setLocale(locale === "es" ? "en" : "es")}>
            {locale === "es" ? "English" : "Español"}
          </Button>
        </header>
        <p role="alert">{t("accountGuestOrderingUnavailable")}</p>
      </div>
    );
  return (
    <div className="public-ordering">
      <header className="row between">
        <div className="brand">
          <BrandLogo />
        </div>
        <Button onClick={() => setLocale(locale === "es" ? "en" : "es")}>
          {locale === "es" ? "English" : "Español"}
        </Button>
      </header>
      <h1>{data?.restaurant.name ?? t("loading")}</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result ? (
        <section className="panel">
          <h2>#{result.order.number}</h2>
          <Badge tone="green">{t("sent")}</Badge>{" "}
          <Badge tone="amber">{t("unpaid")}</Badge>
          <p>{t("payAtCounter")}</p>
          <Button
            onClick={async () => {
              try {
                setResult({
                  ...result,
                  order: await api("/public/receipt/" + result.receiptToken),
                });
              } catch (e) {
                setError(guestError((e as Error).message, locale));
              }
            }}
          >
            {t("reload")}
          </Button>
          <p>
            {t(result.order.paid >= result.order.total ? "paid" : "unpaid")}
          </p>
        </section>
      ) : (
        <>
          <div className="product-grid">
            {data?.catalog.map((p: Product) => (
              <Button
                key={p.id}
                disabled={!orderable(p)}
                onClick={() => (pickerNeeded(p) ? setPicker(p) : add(p))}
              >
                {p.name[locale]} ·{" "}
                {p.openAmount ? t("menuOpenPriceBadge") : m(p.price)}
                {!orderable(p) && ` · ${t("menuSoldOut")}`}
              </Button>
            ))}
          </div>
          <section className="panel">
            <h2>{t("order")}</h2>
            {lines.map((l) => (
              <div className="report-row" key={l.id}>
                <span>
                  {l.name[locale]}
                  {l.optionNames.length > 0 && (
                    <small className="public-line-options">
                      {l.optionNames.map((o) => o[locale]).join(" · ")}
                    </small>
                  )}
                </span>
                <strong>{m(l.total)}</strong>
                <Button
                  aria-label={`${t("remove")} ${l.name[locale]}`}
                  onClick={() => remove(l.id)}
                >
                  −
                </Button>
              </div>
            ))}
            <UnavailableLines
              lines={cart.lines}
              catalog={data?.catalog ?? []}
              locale={locale}
              onRemove={remove}
            />
            <Field label={t("accountGuestNameLabel")}>
              <input
                value={draft.name}
                aria-describedby="guest-name-hint"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
              />
            </Field>
            <p id="guest-name-hint" className="muted">
              {t("accountGuestNameHint")}{" "}
              {data?.restaurant.privacyNoticeUrl ? (
                <a
                  href={data.restaurant.privacyNoticeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("accountGuestPrivacyLink").replace(
                    "{restaurant}",
                    data.restaurant.name,
                  )}
                </a>
              ) : (
                t("accountGuestNoNotice")
              )}
            </p>
            <div className="large-money">{m(total)}</div>
            <p>{t("payAtCounter")}</p>
            <Button
              variant="primary"
              disabled={!draft.lines.length || busy || cart.blocked}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  setResult(await api("/public/" + token + "/orders", draft));
                } catch (e) {
                  const code = (e as Error).message;
                  setError(guestError(code, locale));
                  // The menu changed under the order: refetch it so the
                  // stale line is marked with "Quitar".
                  if (CATALOG_ERRORS.has(code)) refreshCatalog();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("send")}
            </Button>
          </section>
        </>
      )}
      {picker && (
        <ModifierPicker
          product={picker}
          locale={locale}
          currency={data?.restaurant.currency ?? "MXN"}
          canOpen={false}
          onConfirm={(selection) => add(picker, selection)}
          onClose={() => setPicker(null)}
        />
      )}
      <footer className="public-ordering-footer">
        <a href="/legal/privacidad#restaurantes">
          {t("accountGuestPlatformPrivacy")}
        </a>
      </footer>
    </div>
  );
}
