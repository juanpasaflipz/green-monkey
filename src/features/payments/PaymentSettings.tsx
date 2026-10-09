import { useEffect, useMemo, useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Product,
  type Session,
} from "../../../shared/domain";
import { parseMoneyInput } from "../../../shared/service";
import {
  bpToPercent,
  PAYMENTS_LIMITS,
  percentToBp,
  PLATFORMS,
  type PaymentSettingsView,
  type PlatformCode,
  type TerminalKind,
} from "../../../shared/payments";
import { api } from "../../api";
import { Button, Field } from "../../components/ui";
import { strings, errorNotice, type Key } from "../../i18n";
import { PLATFORM_KEYS } from "./PlatformFields";
import { PROVIDER_NAMES, ProviderAccounts } from "./ProviderAccounts";
import "./payments.css";

const KIND_KEYS: Record<string, Key> = {
  manual: "payTerminalKindManual",
  mercadopago_point: "payTerminalKindMp",
  clip_pinpad: "payTerminalKindClip",
};

/**
 * Configuración → "Pagos con tarjeta y plataformas" (payments 037, critic R26: after Descuentos
 * y corte de caja). Managers add, rename and archive card terminals with their fee, turn the
 * delivery platforms on with their estimated commission, set each product's price per platform
 * (LD-72) and this device's default terminal. Writes need a recent PIN (the server asks; api()
 * prompts and retries). P2: the Mercado Pago and Clip accounts (ProviderAccounts), and a found
 * device added as an integrated terminal.
 */
export function PaymentSettings({
  session,
  locale,
  online,
  navigate,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  /** "Cobro de prueba" opens Venta. */
  navigate?: (view: string) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const scale = 10 ** exponent;
  const money = (n: number) =>
    new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
      style: "currency",
      currency: session.restaurant.currency,
    }).format(n / scale);
  const [view, setView] = useState<PaymentSettingsView | null>(null);
  const [catalog, setCatalog] = useState<Product[]>([]);
  // PAYMENTS-UX-6: one status or error at a time, shown under the section that was saved (and
  // naming the field at fault), not at the end of a long price table.
  type Section = "load" | "terminals" | "device" | "platforms" | "prices";
  const [note, setNote] = useState<{
    section: Section;
    status?: string;
    error?: string;
    field?: string;
  } | null>(null);
  const setError = (error: string, section: Section = "load", field?: string) =>
    setNote(error ? { section, error, field } : null);
  const setStatus = (status: string, section: Section) =>
    setNote(status ? { section, status } : null);
  const [busy, setBusy] = useState(false);
  // PAYMENTS-UX-5: typed but unsaved platform and price edits survive another section's save and
  // a reconnect.
  const [platformsDirty, setPlatformsDirty] = useState(false);
  const [pricesDirty, setPricesDirty] = useState(false);
  // New or edited terminal.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [fee, setFee] = useState("");
  // P2: a new terminal on a device the provider listed (null = a manual terminal).
  const [device, setDevice] = useState<{
    kind: TerminalKind;
    providerDeviceId: string;
  } | null>(null);
  // Platforms: enabled + commission text per platform.
  // LD-75: platforms are off until the owner turns them on.
  const [platformForm, setPlatformForm] = useState<
    Record<PlatformCode, { enabled: boolean; commission: string }>
  >(
    () =>
      Object.fromEntries(
        PLATFORMS.map((p) => [p, { enabled: false, commission: "" }]),
      ) as Record<PlatformCode, { enabled: boolean; commission: string }>,
  );
  // Prices: typed text per product:platform.
  const [priceTexts, setPriceTexts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");

  /**
   * Reads the settings and the catalog. The platform and price forms take the server's values
   * only where nothing unsaved is typed, unless `saved` says that section was just saved.
   */
  async function load(saved?: Section) {
    try {
      const [v, products] = await Promise.all([
        api<PaymentSettingsView>("/payments/settings"),
        api<Product[]>("/catalog"),
      ]);
      setView(v);
      setCatalog(products);
      if (!platformsDirty || saved === "platforms") {
        setPlatformForm(
          Object.fromEntries(
            v.platforms.map((p) => [
              p.platform,
              { enabled: p.enabled, commission: bpToPercent(p.commissionBp) },
            ]),
          ) as Record<PlatformCode, { enabled: boolean; commission: string }>,
        );
        setPlatformsDirty(false);
      }
      if (!pricesDirty || saved === "prices") {
        setPriceTexts(
          Object.fromEntries(
            v.prices
              .filter((p) => p.price !== null)
              .map((p) => [
                `${p.productId}:${p.platform}`,
                (p.price! / scale).toFixed(exponent),
              ]),
          ),
        );
        setPricesDirty(false);
      }
      if (!saved) setNote(null);
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  useEffect(() => {
    // A reconnect re-reads, keeping whatever is typed and unsaved (PAYMENTS-UX-5).
    if (online) void load();
  }, [session.id, online]);

  const enabledPlatforms = useMemo(
    () => (view?.platforms ?? []).filter((p) => p.enabled),
    [view],
  );
  const products = useMemo(
    () =>
      catalog.filter(
        (p) =>
          !p.openAmount &&
          (!query.trim() ||
            p.name[locale].toLowerCase().includes(query.trim().toLowerCase())),
      ),
    [catalog, query, locale],
  );

  async function run(
    section: Section,
    fn: () => Promise<PaymentSettingsView | void>,
  ) {
    setBusy(true);
    setNote(null);
    try {
      const next = await fn();
      if (next) setView(next);
      await load(section);
      setStatus(t("paySaved"), section);
    } catch (e) {
      setError(errorNotice(e, locale), section);
    } finally {
      setBusy(false);
    }
  }
  function saveTerminal() {
    let feeBp: number | null;
    try {
      feeBp = percentToBp(fee, PAYMENTS_LIMITS.feeBpMax);
    } catch {
      setError(
        `${t("payFeeRate")}: ${t("payInvalidPercent")}`,
        "terminals",
        "fee",
      );
      return;
    }
    const current = view?.terminals.find((x) => x.id === editing);
    void run("terminals", async () => {
      await api<PaymentSettingsView>("/payments/terminals", {
        operationId: crypto.randomUUID(),
        ...(current
          ? {
              terminalId: current.id,
              expectedVersion: current.version,
              kind: current.kind,
              ...(current.providerDeviceId
                ? { providerDeviceId: current.providerDeviceId }
                : {}),
              active: current.active,
            }
          : device
            ? { kind: device.kind, providerDeviceId: device.providerDeviceId }
            : { kind: "manual" }),
        name: name.trim(),
        feeBp,
      });
      setEditing(null);
      setDevice(null);
      setName("");
      setFee("");
    });
  }
  function savePlatforms() {
    const platforms: {
      platform: PlatformCode;
      enabled: boolean;
      commissionBp: number | null;
      expectedVersion: number;
    }[] = [];
    for (const p of view?.platforms ?? []) {
      const form = platformForm[p.platform];
      let commissionBp: number | null;
      try {
        commissionBp = percentToBp(
          form.commission,
          PAYMENTS_LIMITS.commissionBpMax,
        );
      } catch {
        setError(
          `${t("payCommission")} · ${t(PLATFORM_KEYS[p.platform])}: ${t("payInvalidPercent")}`,
          "platforms",
          `commission:${p.platform}`,
        );
        return;
      }
      platforms.push({
        platform: p.platform,
        enabled: form.enabled,
        commissionBp,
        expectedVersion: p.version,
      });
    }
    void run("platforms", () =>
      api("/payments/platforms", {
        operationId: crypto.randomUUID(),
        platforms,
      }),
    );
  }
  function savePrices() {
    if (!view) return;
    const prices: {
      productId: string;
      platform: PlatformCode;
      price: number | null;
      expectedVersion: number;
    }[] = [];
    for (const product of catalog)
      for (const p of enabledPlatforms) {
        const key = `${product.id}:${p.platform}`;
        const row = view.prices.find(
          (x) => x.productId === product.id && x.platform === p.platform,
        );
        const typed = priceTexts[key]?.trim() ?? "";
        let price: number | null = null;
        if (typed)
          try {
            price = parseMoneyInput(typed, exponent);
          } catch {
            setError(
              `${product.name[locale]} · ${t(PLATFORM_KEYS[p.platform])}: ${t("payInvalidPrice")}`,
              "prices",
              `price:${key}`,
            );
            return;
          }
        if ((row?.price ?? null) === price) continue;
        prices.push({
          productId: product.id,
          platform: p.platform,
          price,
          expectedVersion: row?.version ?? 0,
        });
      }
    if (!prices.length) {
      setPricesDirty(false);
      setStatus(t("paySaved"), "prices");
      return;
    }
    void run("prices", async () => {
      for (let i = 0; i < prices.length; i += 400)
        await api("/payments/platform-prices", {
          operationId: crypto.randomUUID(),
          prices: prices.slice(i, i + 400),
        });
    });
  }
  async function setDefault(terminalId: string | null) {
    await run("device", () =>
      api(`/payments/devices/${session.deviceId}/terminal`, {
        operationId: crypto.randomUUID(),
        terminalId,
      }),
    );
  }

  /** The status or error of one section, under its own button (PAYMENTS-UX-6). */
  const notice = (section: Section) =>
    note?.section !== section ? null : note.error ? (
      <p className="error" role="alert" id={`payments-${section}-error`}>
        {note.error}
      </p>
    ) : (
      <p className="notice" role="status">
        {note.status}
      </p>
    );
  /** aria-invalid and aria-describedby for the field an error names. */
  const invalid = (section: Section, field: string) =>
    note?.section === section && note.error && note.field === field
      ? {
          "aria-invalid": true as const,
          "aria-describedby": `payments-${section}-error`,
        }
      : {};
  if (!view)
    return (
      <section className="panel payment-settings">
        <h2>{t("paySettingsTitle")}</h2>
        {note?.error ? notice("load") : <p>{t("loading")}</p>}
      </section>
    );
  const active = view.terminals.filter((x) => !x.archivedAt);
  const thisDevice = view.devices.find((d) => d.id === session.deviceId);
  return (
    <section className="panel payment-settings">
      <h2>{t("paySettingsTitle")}</h2>
      <p className="muted">{t("paySettingsHint")}</p>

      <h3>{t("payTerminals")}</h3>
      {view.terminals.length ? (
        <div
          className="data-table"
          role="region"
          aria-label={t("payTerminals")}
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>{t("payTerminalName")}</th>
                <th>{t("payTerminalKind")}</th>
                <th>{t("payFeeRate")}</th>
                <th>{t("payTerminalState")}</th>
                <th>{t("payDefaultOn")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.terminals.map((x) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td>{t(KIND_KEYS[x.kind] ?? "payTerminalKindManual")}</td>
                  <td>
                    {x.feeBp === null ? "—" : `${bpToPercent(x.feeBp)} %`}
                  </td>
                  <td>
                    {x.archivedAt
                      ? t("payTerminalArchived")
                      : x.active
                        ? t("payTerminalActive")
                        : t("payTerminalInactive")}
                  </td>
                  <td>{x.defaultOn.join(", ")}</td>
                  <td>
                    {!x.archivedAt && (
                      <div className="row wrap">
                        <Button
                          disabled={busy || !online}
                          onClick={() => {
                            setEditing(x.id);
                            setName(x.name);
                            setFee(bpToPercent(x.feeBp));
                          }}
                        >
                          {t("payEditTerminal")}
                        </Button>
                        <Button
                          disabled={busy || !online}
                          onClick={() => {
                            if (
                              !window.confirm(
                                t("payArchiveTerminalConfirm").replace(
                                  "{name}",
                                  x.name,
                                ),
                              )
                            )
                              return;
                            void run("terminals", () =>
                              api(`/payments/terminals/${x.id}/archive`, {
                                operationId: crypto.randomUUID(),
                                expectedVersion: x.version,
                              }),
                            );
                          }}
                        >
                          {t("payArchiveTerminal")}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">{t("payTerminalsEmpty")}</p>
      )}
      <div className="payment-terminal-form row wrap">
        <Field label={t("payTerminalNameField")}>
          <input
            value={name}
            maxLength={40}
            disabled={busy || !online}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t("payFeeRate")}>
          <input
            inputMode="decimal"
            value={fee}
            placeholder="1.75"
            disabled={busy || !online}
            {...invalid("terminals", "fee")}
            onChange={(e) => setFee(e.target.value)}
          />
        </Field>
        <Button
          variant="primary"
          disabled={busy || !online || !name.trim()}
          onClick={saveTerminal}
        >
          {editing ? t("paySaveTerminal") : t("payAddTerminal")}
        </Button>
        {(editing || device) && (
          <Button
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setDevice(null);
              setName("");
              setFee("");
            }}
          >
            {t("cancel")}
          </Button>
        )}
      </div>
      {device && !editing && (
        <p className="muted" role="status">
          {t(KIND_KEYS[device.kind])} · {device.providerDeviceId}
        </p>
      )}
      {notice("terminals")}
      <p className="muted tiny">
        {t("payFeeRateHint")} {t("payIntegratedHint")}
      </p>
      {thisDevice && active.length > 0 && (
        <Field label={t("payDeviceDefault")}>
          <select
            value={thisDevice.terminalId ?? ""}
            disabled={busy || !online}
            onChange={(e) => void setDefault(e.target.value || null)}
          >
            <option value="">{t("payNoDefault")}</option>
            {active.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {notice("device")}

      <ProviderAccounts
        session={session}
        locale={locale}
        online={online}
        onAddTerminal={(kind, providerDeviceId) => {
          setEditing(null);
          setDevice({ kind, providerDeviceId });
          setName(
            `${PROVIDER_NAMES[kind === "clip_pinpad" ? "clip" : "mercadopago"]} ${providerDeviceId.slice(-4)}`,
          );
          setFee("");
        }}
        onTestCharge={navigate ? () => navigate("sell") : undefined}
      />

      <h3>{t("payPlatforms")}</h3>
      <p className="muted">{t("payPlatformsHint")}</p>
      <div className="payment-platforms">
        {view.platforms.map((p) => (
          <div className="row wrap" key={p.platform}>
            <label className="option">
              <input
                type="checkbox"
                checked={platformForm[p.platform]?.enabled ?? false}
                disabled={busy || !online}
                onChange={(e) => {
                  setPlatformsDirty(true);
                  setPlatformForm((f) => ({
                    ...f,
                    [p.platform]: {
                      ...f[p.platform],
                      enabled: e.target.checked,
                    },
                  }));
                }}
              />
              {t(PLATFORM_KEYS[p.platform])}
            </label>
            <Field
              label={`${t("payCommission")} · ${t(PLATFORM_KEYS[p.platform])}`}
            >
              <input
                inputMode="decimal"
                value={platformForm[p.platform]?.commission ?? ""}
                placeholder="30"
                disabled={busy || !online}
                {...invalid("platforms", `commission:${p.platform}`)}
                onChange={(e) => {
                  setPlatformsDirty(true);
                  setPlatformForm((f) => ({
                    ...f,
                    [p.platform]: {
                      ...f[p.platform],
                      commission: e.target.value,
                    },
                  }));
                }}
              />
            </Field>
          </div>
        ))}
      </div>
      <p className="muted tiny">{t("payCommissionHint")}</p>
      <Button disabled={busy || !online} onClick={savePlatforms}>
        {t("paySavePlatforms")}
      </Button>
      {notice("platforms")}

      <h3>{t("payPlatformPrices")}</h3>
      <p className="muted">{t("payPlatformPricesHint")}</p>
      {!enabledPlatforms.length ? (
        <p className="muted">{t("payPlatformPricesNone")}</p>
      ) : !catalog.length ? (
        // PAYMENTS-UX-16: platforms are on but the menu has no products yet.
        <p className="muted">{t("payPlatformPricesNoProducts")}</p>
      ) : (
        <>
          <Field label={t("payPlatformPricesSearch")}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
          {/* A scrolling region is keyboard-reachable (axe scrollable-region-focusable). */}
          <div
            className="data-table payment-prices"
            role="region"
            aria-label={t("payPlatformPrices")}
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>{t("product")}</th>
                  <th>{t("payPosPrice")}</th>
                  {enabledPlatforms.map((p) => (
                    <th key={p.platform}>{t(PLATFORM_KEYS[p.platform])}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>{product.name[locale]}</td>
                    <td>{money(product.price)}</td>
                    {enabledPlatforms.map((p) => {
                      const key = `${product.id}:${p.platform}`;
                      return (
                        <td key={p.platform}>
                          <input
                            inputMode="decimal"
                            aria-label={`${product.name[locale]} · ${t(PLATFORM_KEYS[p.platform])}`}
                            value={priceTexts[key] ?? ""}
                            placeholder={(product.price / scale).toFixed(
                              exponent,
                            )}
                            disabled={busy || !online}
                            {...invalid("prices", `price:${key}`)}
                            onChange={(e) => {
                              setPricesDirty(true);
                              setPriceTexts((x) => ({
                                ...x,
                                [key]: e.target.value,
                              }));
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button disabled={busy || !online} onClick={savePrices}>
            {t("paySavePrices")}
          </Button>
          {notice("prices")}
        </>
      )}
      {notice("load")}
    </section>
  );
}
