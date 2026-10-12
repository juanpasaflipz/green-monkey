// Kiosk screens around the menu (039, §2.3, §2.10–2.12): the welcome screen, the hidden setup
// form (pairing), "Soy del club" and the accessibility toggles.
import { useRef, useState } from "react";
import type { Locale } from "../../../../shared/domain";
import type { KioskMemberResult } from "../../../../shared/kiosk";
import { typedPhoneDisplay } from "../../../../shared/kiosk";
import { strings } from "../../../i18n";
import { Button, Modal } from "../../../components/ui";
import { fill } from "../../menu/format";
import { guestError } from "../dinerApi";
import { kioskApi } from "./kioskApi";

export type KioskA11y = { large: boolean; reach: boolean };

/** "Toca para ordenar": the first tap also asks for fullscreen (§2.11). */
export function KioskWelcome({
  restaurant,
  locale,
  loyalty,
  onStart,
  onLanguage,
  onAccessibility,
  onMember,
  onSetup,
}: {
  restaurant: string;
  locale: Locale;
  loyalty: boolean;
  onStart: () => void;
  onLanguage: () => void;
  onAccessibility: () => void;
  onMember: () => void;
  onSetup: () => void;
}) {
  const t = strings[locale];
  return (
    <section className="kiosk-welcome">
      <SetupGesture onSetup={onSetup}>
        <h1>{restaurant}</h1>
      </SetupGesture>
      <Button variant="primary" className="kiosk-start" onClick={onStart}>
        {t.kioskTapToOrder}
      </Button>
      <div className="kiosk-welcome-actions">
        <Button onClick={onLanguage} lang={locale === "es" ? "en" : "es"}>
          {t.publicLanguageToggle}
        </Button>
        <Button onClick={onAccessibility}>{t.kioskAccessibility}</Button>
        {loyalty && <Button onClick={onMember}>{t.kioskMember}</Button>}
      </div>
    </section>
  );
}

/** A 3-second press on the restaurant name opens "Configurar este kiosco" (no secret shown). */
export function SetupGesture({
  children,
  onSetup,
}: {
  children: React.ReactNode;
  onSetup: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <div
      className="kiosk-setup-gesture"
      onPointerDown={() => {
        stop();
        timer.current = setTimeout(onSetup, 3000);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {children}
    </div>
  );
}

/** The pairing form: the 8-digit code a manager created in Configuración. */
export function KioskSetup({
  token,
  locale,
  bound,
  onPaired,
  onClose,
}: {
  token: string;
  locale: Locale;
  bound: boolean;
  onPaired: () => void;
  onClose: () => void;
}) {
  const t = strings[locale];
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function pair() {
    setBusy(true);
    setMessage("");
    try {
      const r = await kioskApi.pair(token, code);
      setMessage(fill(t.kioskSetupDone, { label: r.stationLabel }));
      setCode("");
      onPaired();
    } catch (e) {
      setMessage(guestError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t.kioskSetupTitle}
      close={onClose}
      closeLabel={t.kioskSetupClose}
    >
      <p>{bound ? t.kioskSetupBound : t.kioskUnbound}</p>
      <label className="field">
        <span>{t.kioskSetupCode}</span>
        <input
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={code}
          onChange={(e) =>
            setCode(e.target.value.replace(/\D/g, "").slice(0, 8))
          }
        />
      </label>
      <Button
        variant="primary"
        disabled={busy || code.length !== 8}
        onClick={() => void pair()}
      >
        {t.kioskSetupPair}
      </Button>
      {message && <p role="status">{message}</p>}
    </Modal>
  );
}

/**
 * "Soy del club": a 10-digit keypad; the number is never echoed in full and no name is shown
 * (R21). Nothing is created at the kiosk; the member token rides on the order.
 */
export function KioskMember({
  token,
  locale,
  onFound,
  onClose,
}: {
  token: string;
  locale: Locale;
  onFound: (
    memberToken: string,
    found: Extract<KioskMemberResult, { found: true }>,
  ) => void;
  onClose: () => void;
}) {
  const t = strings[locale];
  const [digits, setDigits] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const press = (d: string) => setDigits((x) => (x + d).slice(0, 10));
  async function look() {
    setBusy(true);
    setMessage("");
    try {
      const r = await kioskApi.member(token, digits);
      if (r.found) {
        setMessage(
          fill(t.kioskMemberHello, { n: r.stamps, required: r.required }) +
            (r.rewards > 0 ? " " + t.kioskReward : ""),
        );
        onFound(r.memberToken, r);
      } else setMessage(t.kioskMemberNotFound);
    } catch (e) {
      const code = (e as Error).message;
      setMessage(
        code === "rate_limited" ? t.kioskMemberLimit : guestError(code, locale),
      );
    } finally {
      setBusy(false);
      setDigits("");
    }
  }
  return (
    <Modal title={t.kioskMember} close={onClose} closeLabel={t.kioskSetupClose}>
      <p aria-live="polite" className="kiosk-phone">
        {digits ? typedPhoneDisplay(digits) : t.kioskMemberPhone}
      </p>
      <div
        className="kiosk-keypad"
        role="group"
        aria-label={t.kioskMemberPhone}
      >
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => (
          <Button
            key={d}
            className="kiosk-key"
            onClick={() => press(d)}
            disabled={busy}
          >
            {d}
          </Button>
        ))}
        <Button
          className="kiosk-key"
          onClick={() => setDigits((x) => x.slice(0, -1))}
          disabled={busy}
          aria-label={t.kioskKeyDelete}
        >
          <span aria-hidden="true">⌫</span>
        </Button>
      </div>
      <Button
        variant="primary"
        disabled={busy || digits.length !== 10}
        onClick={() => void look()}
      >
        {t.kioskMemberSearch}
      </Button>
      {message && <p role="status">{message}</p>}
    </Modal>
  );
}

/** "Accesibilidad": large text (125 %) and reach mode (content in the lower two thirds). */
export function KioskAccessibility({
  locale,
  value,
  onChange,
  onClose,
}: {
  locale: Locale;
  value: KioskA11y;
  onChange: (v: KioskA11y) => void;
  onClose: () => void;
}) {
  const t = strings[locale];
  return (
    <Modal
      title={t.kioskAccessibility}
      close={onClose}
      closeLabel={t.kioskSetupClose}
    >
      <label className="kiosk-toggle">
        <input
          type="checkbox"
          checked={value.large}
          onChange={(e) => onChange({ ...value, large: e.target.checked })}
        />
        <span>{t.kioskLargeText}</span>
      </label>
      <label className="kiosk-toggle">
        <input
          type="checkbox"
          checked={value.reach}
          onChange={(e) => onChange({ ...value, reach: e.target.checked })}
        />
        <span>{t.kioskReachMode}</span>
      </label>
    </Modal>
  );
}
