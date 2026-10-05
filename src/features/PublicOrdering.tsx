import { BrandLogo } from "../components/BrandLogo";
import { useEffect, useState } from "react";
import { api } from "../api";
import { strings, translateError, type Key } from "../i18n";
import { Button, Field, Badge } from "../components/ui";
import { ModifierPicker } from "../components/ModifierPicker";
import { orderable, pickerNeeded } from "../../shared/menu";
import { moneyFormatter } from "./menu/format";
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
  const [picker, setPicker] = useState<Product | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
        }));
        setResult(null);
        setPicker(null);
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
  const lines = data ? quote(draft.lines, data.catalog) : [];
  const total = lines.reduce((a, l) => a + l.total, 0);
  function add(p: Product, selection: { options: string[] } = { options: [] }) {
    setDraft((d) => ({
      ...d,
      lines: [
        ...d.lines,
        {
          id: crypto.randomUUID(),
          productId: p.id,
          quantity: 1,
          options: selection.options,
          note: "",
        },
      ],
    }));
    setPicker(null);
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
            <div className="large-money">{m(total)}</div>
            <p>{t("payAtCounter")}</p>
            <Button
              variant="primary"
              disabled={!lines.length || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setResult(await api("/public/" + token + "/orders", draft));
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
    </div>
  );
}
