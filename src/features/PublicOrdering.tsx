import { BrandLogo } from "../components/BrandLogo";
import { currencyExponent } from "../../shared/domain";
import { useEffect, useState } from "react";
import { api } from "../api";
import { strings, translateError, type Key } from "../i18n";
import { Button, Field, Modal, Badge } from "../components/ui";
import { mt } from "../i18n-marketing";
import type { QuotePreview } from "./Offers";
import { emptyGuest, Feedback, GuestFields, guestPayload } from "./GuestPages";
import {
  quote,
  type Product,
  type OrderInput,
  type Locale,
} from "../../shared/domain";
export function PublicOrdering() {
  const [, channel, token] = location.pathname.split("/");
  const [locale, setLocale] = useState<Locale>("es");
  const t = (k: Key) => strings[locale][k];
  const [data, setData] = useState<any>(null);
  const [draft, setDraft] = useState<OrderInput>({
    operationId: crypto.randomUUID(),
    lines: [],
    mode: "takeaway",
    tableId: null,
    name: "",
    note: "",
    channel: channel as "qr" | "kiosk",
  });
  const [product, setProduct] = useState<Product | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [guest, setGuest] = useState(emptyGuest);
  const [preview, setPreview] = useState<{
    key: string;
    quote: QuotePreview;
  } | null>(null);
  const tm = mt(locale);
  const previewKey = JSON.stringify([draft.lines, draft.code ?? null]);
  useEffect(() => {
    if (!draft.lines.length) return;
    let live = true;
    const timer = setTimeout(() => {
      void api<QuotePreview>("/public/" + token + "/quote", draft)
        .then((q) => live && setPreview({ key: previewKey, quote: q }))
        .catch(() => live && setPreview(null));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [previewKey, token]);
  useEffect(() => {
    void api("/public/" + token + "/catalog")
      .then(setData)
      .catch((e) => setError(translateError(e.message, locale)));
  }, [token]);
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
          code: undefined,
        }));
        setCode("");
        setGuest(emptyGuest());
        setResult(null);
        setProduct(null);
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
  const m = (n: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: data?.restaurant.currency ?? "MXN",
    }).format(n / 10 ** currencyExponent(data?.restaurant.currency ?? "MXN"));
  const lines = data ? quote(draft.lines, data.catalog) : [];
  const offers =
    draft.lines.length && preview?.key === previewKey ? preview.quote : null;
  const total = offers ? offers.total : lines.reduce((a, l) => a + l.total, 0);
  const codeStatus = offers?.code?.status;
  function add(p: Product, options: string[]) {
    setDraft((d) => ({
      ...d,
      lines: [
        ...d.lines,
        {
          id: crypto.randomUUID(),
          productId: p.id,
          quantity: 1,
          options,
          note: "",
        },
      ],
    }));
    setProduct(null);
  }
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
                setError(translateError((e as Error).message, locale));
              }
            }}
          >
            {t("reload")}
          </Button>
          <p>
            {t(result.order.paid >= result.order.total ? "paid" : "unpaid")}
          </p>
          <Feedback locale={locale} receiptToken={result.receiptToken} />
        </section>
      ) : (
        <>
          <div className="product-grid">
            {data?.catalog.map((p: Product) => (
              <Button
                key={p.id}
                disabled={!p.available}
                onClick={() => {
                  if (p.groups.some((g) => g.min > 0)) {
                    setProduct(p);
                    setSelected([]);
                  } else add(p, []);
                }}
              >
                {p.name[locale]} · {m(p.price)}
              </Button>
            ))}
          </div>
          <section className="panel">
            <h2>{t("order")}</h2>
            {lines.map((l) => (
              <div className="report-row" key={l.id}>
                <span>{l.name[locale]}</span>
                <strong>{m(l.total)}</strong>
                <Button
                  aria-label={t("remove")}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      lines: d.lines.filter((x) => x.id !== l.id),
                    }))
                  }
                >
                  −
                </Button>
              </div>
            ))}
            <Field label={t("name")}>
              <input
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
              />
            </Field>
            {draft.code ? (
              <div className="row between">
                <span>
                  {tm("promoCode")}: <strong>{draft.code}</strong>
                </span>
                <Button
                  aria-label={`${tm("remove")} ${tm("promoCode")}`}
                  onClick={() => setDraft((d) => ({ ...d, code: undefined }))}
                >
                  {tm("remove")}
                </Button>
              </div>
            ) : (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = code.trim().toUpperCase();
                  if (!/^[A-Z0-9]{3,24}$/.test(next)) return;
                  setDraft((d) => ({ ...d, code: next }));
                  setCode("");
                  setError("");
                }}
              >
                <Field label={tm("promoCode")}>
                  <input
                    value={code}
                    maxLength={24}
                    autoCapitalize="characters"
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                  />
                </Field>
                <Button type="submit" disabled={code.trim().length < 3}>
                  {tm("apply")}
                </Button>
              </form>
            )}
            {codeStatus && (
              <p
                role="status"
                className={codeStatus === "applied" ? "muted" : "error"}
              >
                {tm(
                  codeStatus === "applied"
                    ? "codeApplied"
                    : codeStatus === "invalid"
                      ? "codeInvalid"
                      : codeStatus === "superseded"
                        ? "codeSuperseded"
                        : "codeNotEligible",
                )}
              </p>
            )}
            {offers && offers.discount > 0 && (
              <>
                <div className="row between">
                  <span>{tm("subtotal")}</span>
                  <span>{m(offers.subtotal)}</span>
                </div>
                {offers.applied.map((a, i) => (
                  <div className="row between" key={i}>
                    <span>{a.name}</span>
                    <span>−{m(a.amount)}</span>
                  </div>
                ))}
              </>
            )}
            <GuestFields
              locale={locale}
              value={guest}
              onChange={setGuest}
              selfService
            />
            <div className="large-money">{m(total)}</div>
            <p>{t("payAtCounter")}</p>
            <Button
              variant="primary"
              disabled={!lines.length || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const contact = guestPayload(
                    { ...guest, name: draft.name },
                    locale,
                  );
                  setResult(
                    await api("/public/" + token + "/orders", {
                      ...draft,
                      ...(contact ? { guest: contact } : {}),
                    }),
                  );
                  setGuest(emptyGuest());
                } catch (e) {
                  setError(translateError((e as Error).message, locale));
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
      {product && (
        <Modal
          title={product.name[locale]}
          close={() => setProduct(null)}
          closeLabel={t("close")}
        >
          {product.groups.map((g) => (
            <fieldset key={g.id}>
              <legend>
                {g.name[locale]} · {g.min}–{g.max}
              </legend>
              {g.options.map((o) => (
                <label className="option" key={o.id}>
                  <input
                    type={g.max === 1 ? "radio" : "checkbox"}
                    name={g.id}
                    disabled={!o.available}
                    checked={selected.includes(o.id)}
                    onChange={() =>
                      setSelected((old) =>
                        g.max === 1
                          ? [
                              ...old.filter(
                                (id) => !g.options.some((o) => o.id === id),
                              ),
                              o.id,
                            ]
                          : old.includes(o.id)
                            ? old.filter((id) => id !== o.id)
                            : [...old, o.id],
                      )
                    }
                  />
                  {o.name[locale]} {m(o.price)}
                </label>
              ))}
            </fieldset>
          ))}
          <Button
            variant="primary"
            disabled={product.groups.some((g) => {
              const n = selected.filter((id) =>
                g.options.some((o) => o.id === id),
              ).length;
              return n < g.min || n > g.max;
            })}
            onClick={() => add(product, selected)}
          >
            {t("add")}
          </Button>
        </Modal>
      )}
    </div>
  );
}
