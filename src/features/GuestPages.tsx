import { useEffect, useState } from "react";
import type { Locale, OrderInput } from "../../shared/domain";
import { api } from "../api";
import { mt } from "../i18n-marketing";
import { BrandLogo } from "../components/BrandLogo";
import { Button, Field } from "../components/ui";

type Capture = NonNullable<OrderInput["guest"]>;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Returns the guest block for an order, or undefined when nothing usable was
 * typed. Consent is only sent for a channel whose address is present. */
export function guestPayload(
  g: GuestDraft,
  locale: Locale,
): Capture | undefined {
  const email = emailPattern.test(g.email.trim()) ? g.email.trim() : undefined;
  const phone =
    g.phone.replace(/\D/g, "").length >= 8 ? g.phone.trim() : undefined;
  if (!email && !phone) return undefined;
  return {
    name: g.name.trim(),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    locale,
    consent: {
      email: !!email && g.consent.email,
      sms: !!phone && g.consent.sms,
      whatsapp: !!phone && g.consent.whatsapp,
    },
  };
}
export type GuestDraft = {
  name: string;
  email: string;
  phone: string;
  consent: { email: boolean; sms: boolean; whatsapp: boolean };
};
export const emptyGuest = (): GuestDraft => ({
  name: "",
  email: "",
  phone: "",
  consent: { email: false, sms: false, whatsapp: false },
});
/** Contact and opt-in fields shared by the register, QR and kiosk. Every box
 * starts unticked: consent is an explicit action. */
export function GuestFields({
  locale,
  value,
  onChange,
  selfService,
}: {
  locale: Locale;
  value: GuestDraft;
  onChange: (next: GuestDraft) => void;
  selfService: boolean;
}) {
  const t = mt(locale);
  const consent = (channel: keyof GuestDraft["consent"], label: string) => (
    <label className="selection-check labelled">
      <input
        type="checkbox"
        checked={value.consent[channel]}
        onChange={(e) =>
          onChange({
            ...value,
            consent: { ...value.consent, [channel]: e.target.checked },
          })
        }
      />
      {label}
    </label>
  );
  return (
    <fieldset className="guest-fields">
      <legend>{t(selfService ? "guestOptInTitle" : "customer")}</legend>
      <p className="tiny muted">
        {t(selfService ? "guestOptInHint" : "customerHint")}
      </p>
      <div className="form-grid">
        <Field label={t("email")}>
          <input
            type="email"
            autoComplete="email"
            value={value.email}
            onChange={(e) => onChange({ ...value, email: e.target.value })}
          />
        </Field>
        <Field label={t("phone")}>
          <input
            type="tel"
            autoComplete="tel"
            value={value.phone}
            onChange={(e) => onChange({ ...value, phone: e.target.value })}
          />
        </Field>
      </div>
      {value.email.trim() && consent("email", t("guestOptInEmail"))}
      {value.phone.trim() && consent("whatsapp", t("guestOptInWhatsapp"))}
      {value.phone.trim() && consent("sms", t("guestOptInSms"))}
    </fieldset>
  );
}

export function Feedback({
  locale,
  receiptToken,
}: {
  locale: Locale;
  receiptToken: string;
}) {
  const t = mt(locale);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);
  if (done) return <p role="status">{t("thanksFeedback")}</p>;
  return (
    <fieldset className="guest-fields">
      <legend>{t("rateVisit")}</legend>
      <div className="row" role="radiogroup" aria-label={t("rateVisit")}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={String(n)}
            className={"rating" + (n <= rating ? " selected" : "")}
            onClick={() => setRating(n)}
          >
            ★
          </button>
        ))}
      </div>
      <Field label={t("comment")}>
        <input
          value={comment}
          maxLength={500}
          onChange={(e) => setComment(e.target.value)}
        />
      </Field>
      <Button
        disabled={!rating}
        onClick={() =>
          void api(`/public/receipt/${receiptToken}/feedback`, {
            rating,
            comment,
          })
            .then(() => setDone(true))
            .catch(() => setDone(true))
        }
      >
        {t("send")}
      </Button>
    </fieldset>
  );
}

/** Public page behind every message's unsubscribe link. */
export function Unsubscribe() {
  const token = location.pathname.split("/")[2] ?? "";
  const [locale, setLocale] = useState<Locale>(
    navigator.language.startsWith("en") ? "en" : "es",
  );
  const t = mt(locale);
  const [state, setState] = useState<
    | { kind: "loading" | "invalid" | "done" }
    | {
        kind: "ready";
        restaurant: string;
        channel: string;
        subscribed: boolean;
      }
  >({ kind: "loading" });
  useEffect(() => {
    void api("/guest/unsubscribe/" + token)
      .then((d) => setState({ kind: "ready", ...d }))
      .catch(() => setState({ kind: "invalid" }));
  }, [token]);
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
      <section className="panel">
        <h1>{t("unsubscribeTitle")}</h1>
        {state.kind === "invalid" && <p role="alert">{t("invalidLink")}</p>}
        {state.kind === "done" && <p role="status">{t("unsubscribeDone")}</p>}
        {state.kind === "ready" &&
          (state.subscribed ? (
            <>
              <p>
                {t("unsubscribeQuestion")} <strong>{state.restaurant}</strong> (
                {t(state.channel as "email" | "sms" | "whatsapp")})?
              </p>
              <Button
                variant="primary"
                onClick={() =>
                  void api("/guest/unsubscribe/" + token, {})
                    .then(() => setState({ kind: "done" }))
                    .catch(() => setState({ kind: "invalid" }))
                }
              >
                {t("unsubscribeConfirm")}
              </Button>
            </>
          ) : (
            <p role="status">{t("unsubscribeAlready")}</p>
          ))}
      </section>
    </div>
  );
}
