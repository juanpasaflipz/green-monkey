// Configuración → Pedidos en línea → "Kiosco de autoservicio" (039, §2.2–2.3, §2.11): how the
// kiosk takes payment, the para aquí question, suggestions and the club; per kiosk station its
// card reader and receiving till, tablet pairing and unpairing; the cart suggestions. Owners and
// managers; saves ask for a recent PIN (api() prompts), unpairing does not.
import { useEffect, useState } from "react";
import type { Locale, Product, Session } from "../../../shared/domain";
import type {
  KioskPaymentMode,
  KioskSettingsView,
  KioskStationView,
} from "../../../shared/kiosk";
import { strings, translateError, type Key } from "../../i18n";
import { api } from "../../api";
import { Button, Modal } from "../../components/ui";
import { fill } from "../menu/format";

const MANAGERS = ["owner", "manager"];

export function KioskSettings({
  session,
  locale,
  online,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
}) {
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const [view, setView] = useState<KioskSettingsView | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState<KioskSettingsView["settings"] | null>(null);
  const [cart, setCart] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [code, setCode] = useState<{ station: string; code: string } | null>(
    null,
  );
  const canEdit = MANAGERS.includes(session.role);
  async function load() {
    try {
      const v = await api<KioskSettingsView>("/kiosk/settings");
      setView(v);
      setForm(v.settings);
      setCart(v.cartSuggestions.productIds);
      const catalog = await api<Product[]>("/catalog").catch(
        () => [] as Product[],
      );
      setProducts(catalog.filter((p) => !p.archived && !p.openAmount));
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }
  useEffect(() => {
    if (canEdit) void load();
  }, []);
  if (!canEdit || !view || !form) return null;
  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      if (ok) setMessage(ok);
      await load();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    run(
      () =>
        api("/kiosk/settings", {
          operationId: crypto.randomUUID(),
          expectedVersion: view.settings.version,
          paymentMode: form.paymentMode,
          askFulfillment: form.askFulfillment,
          suggestions: form.suggestions,
          loyaltyAtKiosk: form.loyaltyAtKiosk,
        }),
      t("kioskSaved"),
    );
  const saveCart = () =>
    run(
      () =>
        api("/kiosk/cart-suggestions", {
          operationId: crypto.randomUUID(),
          expectedVersion: view.cartSuggestions.version,
          productIds: cart,
        }),
      t("kioskSaved"),
    );
  const modes: [KioskPaymentMode, Key][] = [
    ["counter", "kioskPaymentCounter"],
    ["card_and_counter", "kioskPaymentCardAndCounter"],
    ["card_first", "kioskPaymentCardFirst"],
  ];
  return (
    <section
      className="settings-section kiosk-settings"
      aria-labelledby="kiosk-settings-title"
    >
      <h3 id="kiosk-settings-title">{t("kioskSettingsTitle")}</h3>
      <p className="muted">{t("kioskSettingsIntro")}</p>
      {!view.selfCheckoutEnabled && (
        <p className="warning">{t("kioskSelfCheckoutOff")}</p>
      )}
      <fieldset>
        <legend>{t("kioskPaymentMode")}</legend>
        {modes.map(([value, key]) => (
          <label className="option" key={value}>
            <input
              type="radio"
              name="kiosk-payment-mode"
              checked={form.paymentMode === value}
              disabled={busy || !online}
              onChange={() => setForm({ ...form, paymentMode: value })}
            />
            <span>{t(key)}</span>
          </label>
        ))}
      </fieldset>
      {(
        [
          ["askFulfillment", "kioskAskFulfillment"],
          ["suggestions", "kioskSuggestionsToggle"],
          ...(view.loyaltyAvailable
            ? ([["loyaltyAtKiosk", "kioskLoyaltyToggle"]] as const)
            : []),
        ] as const
      ).map(([field, key]) => (
        <label className="option" key={field}>
          <input
            type="checkbox"
            checked={form[field]}
            disabled={busy || !online}
            onChange={(e) => setForm({ ...form, [field]: e.target.checked })}
          />
          <span>{t(key)}</span>
        </label>
      ))}
      <Button
        variant="primary"
        disabled={busy || !online}
        onClick={() => void save()}
      >
        {t("kioskSaveSettings")}
      </Button>
      {view.stations.length === 0 && (
        <p className="muted">{t("kioskNoStations")}</p>
      )}
      {view.stations.map((st) => (
        <StationRow
          key={st.id}
          station={st}
          view={view}
          locale={locale}
          busy={busy || !online}
          onSave={(terminalId, registerDeviceId) =>
            run(
              () =>
                api(`/kiosk/stations/${st.id}`, {
                  operationId: crypto.randomUUID(),
                  expectedVersion: st.version,
                  terminalId,
                  registerDeviceId,
                }),
              t("kioskSaved"),
            )
          }
          onPair={() =>
            run(async () => {
              const r = await api<{ code: string }>(
                `/kiosk/stations/${st.id}/pairing`,
                {},
              );
              setCode({ station: st.label, code: r.code });
            })
          }
          onUnpair={() =>
            run(() =>
              api(`/kiosk/devices/${st.device!.id}/revoke`, {
                operationId: crypto.randomUUID(),
              }),
            )
          }
        />
      ))}
      {form.suggestions && products.length > 0 && (
        <fieldset>
          <legend>{t("kioskCartSuggestions")}</legend>
          <div className="kiosk-settings-products">
            {products.map((p) => (
              <label className="option" key={p.id}>
                <input
                  type="checkbox"
                  checked={cart.includes(p.id)}
                  disabled={busy || (!cart.includes(p.id) && cart.length >= 6)}
                  onChange={(e) =>
                    setCart(
                      e.target.checked
                        ? [...cart, p.id]
                        : cart.filter((x) => x !== p.id),
                    )
                  }
                />
                <span>{p.name[locale]}</span>
              </label>
            ))}
          </div>
          <Button disabled={busy || !online} onClick={() => void saveCart()}>
            {t("kioskSaveSettings")}
          </Button>
        </fieldset>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {code && (
        <Modal
          title={t("kioskPairTablet")}
          close={() => setCode(null)}
          closeLabel={t("close")}
        >
          <p className="kiosk-pair-code">
            {fill(strings[locale].kioskPairCode, {
              code: `${code.code.slice(0, 4)} ${code.code.slice(4)}`,
            })}
          </p>
        </Modal>
      )}
    </section>
  );
}

function StationRow({
  station,
  view,
  locale,
  busy,
  onSave,
  onPair,
  onUnpair,
}: {
  station: KioskStationView;
  view: KioskSettingsView;
  locale: Locale;
  busy: boolean;
  onSave: (terminalId: string | null, registerDeviceId: string | null) => void;
  onPair: () => void;
  onUnpair: () => void;
}) {
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const [terminal, setTerminal] = useState(station.terminalId ?? "");
  const [till, setTill] = useState(station.registerDeviceId ?? "");
  const tillName = view.tills.find((x) => x.id === till)?.name ?? "";
  const d = station.device;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale === "es" ? "es-MX" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  const seen = d?.lastSeenAt ? Date.now() - Date.parse(d.lastSeenAt) : null;
  return (
    <div className="kiosk-station" aria-label={station.label}>
      <h4>{station.label || "—"}</h4>
      <label className="field">
        <span>{t("kioskStationTerminal")}</span>
        <select
          value={terminal}
          disabled={busy}
          onChange={(e) => setTerminal(e.target.value)}
        >
          <option value="">{t("kioskStationNoTerminal")}</option>
          {view.terminals
            .filter((x) => x.integrated)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        <span>{t("kioskStationTill")}</span>
        <select
          value={till}
          disabled={busy}
          onChange={(e) => setTill(e.target.value)}
        >
          <option value="">{t("kioskStationNoTill")}</option>
          {view.tills.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      {till && (
        <p className="muted">{t("kioskTillClosedHint", { till: tillName })}</p>
      )}
      <Button
        disabled={busy}
        onClick={() => onSave(terminal || null, till || null)}
      >
        {t("kioskSaveStation")}
      </Button>
      <p className="muted">
        {!d
          ? t("kioskNoTablet")
          : d.state === "pending"
            ? t("kioskPairPending", {
                time: d.pairingExpiresAt ? time(d.pairingExpiresAt) : "",
              })
            : seen !== null && seen > 5 * 60_000
              ? t("kioskSilentSince", { time: time(d.lastSeenAt!) })
              : t("kioskLastSeen", {
                  ago:
                    seen === null
                      ? "—"
                      : `${Math.max(1, Math.round(seen / 60_000))} min`,
                  build: d.build ?? "—",
                })}
      </p>
      <div className="row wrap">
        <Button disabled={busy} onClick={onPair}>
          {t("kioskPairTablet")}
        </Button>
        {d && (
          <Button variant="ghost" disabled={busy} onClick={onUnpair}>
            {t("kioskUnpair")}
          </Button>
        )}
      </div>
    </div>
  );
}
