import { MemberCardControl } from "./Engagement";
import { api } from "../../api";
/**
 * "Cliente del club" (038 §2.5): find a member by phone (or by name, ≥ 3 letters, masked phones)
 * and "Usar"; or enroll them with the staff attestation that they heard the privacy notice
 * (the read-aloud script and the notice as a QR are on screen; the marketing opt-in starts
 * unchecked). Online only; "Sin club" closes without a member.
 */
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Locale } from "../../../shared/domain";
import {
  enrollmentIssue,
  parsePhone,
  type LoyaltyClubView,
  type LoyaltyCountry,
  type MemberSummary,
} from "../../../shared/loyalty";
import { errorNotice } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { loyaltyApi } from "./loyaltyApi";
import { fill, rewardsText, stampsText, tr } from "./format";
import "./loyalty.css";

export function LoyaltyLookupDialog({
  locale,
  club,
  online,
  onUse,
  onClose,
}: {
  locale: Locale;
  club: LoyaltyClubView;
  online: boolean;
  onUse: (m: MemberSummary) => void;
  onClose: () => void;
}) {
  const t = tr(locale);
  const [scan, setScan] = useState("");
  const [country, setCountry] = useState<LoyaltyCountry>("MX");
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<MemberSummary | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<MemberSummary[] | null>(null);
  const [name, setName] = useState("");
  const [referral, setReferral] = useState("");
  const [consent, setConsent] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The phone field takes the focus once the dialog is open: React focuses autoFocus inputs
  // during layout, before Modal's showModal(), which then focuses the close button
  // (LOYALTY-UX-10). This parent effect runs after Modal's.
  const phoneRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => phoneRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  };
  const find = () =>
    run(async () => {
      if (!parsePhone(phone, country)) throw new Error("loyalty_invalid_phone");
      setResult(await loyaltyApi.lookup(phone, country));
    });
  const search = () =>
    run(async () => {
      setMatches(query.trim().length >= 3 ? await loyaltyApi.search(query) : []);
    });
  const enroll = () =>
    run(async () => {
      const issue = enrollmentIssue({ phone, country, name, consent });
      if (issue) throw new Error(issue);
      const r = await loyaltyApi.enroll({
        phone,
        country,
        name,
        consent,
        marketingOptIn: marketing,
        ...(referral.trim() ? { referralCode: referral.trim() } : {}),
      });
      onUse(r.member);
    });
  const row = (m: MemberSummary) => (
    <li key={m.id} className="loyalty-member-row">
      <div>
        <strong>
          {fill(t("loyaltyFound"), {
            name: m.firstName,
            stamps: m.stamps,
            required: m.required,
          })}
        </strong>
        <span className="muted">
          {m.maskedPhone} · {stampsText(m, locale)}
          {m.rewards > 0 ? ` · ${rewardsText(m.rewards, locale)}` : ""}
        </span>
      </div>
      <Button
        variant="primary"
        onClick={() => onUse(m)}
        disabled={!online}
        aria-label={fill(t("loyaltyUseMember"), { name: m.firstName, phone: m.maskedPhone })}
      >
        {t("loyaltyUse")}
      </Button>
    </li>
  );
  return (
    <Modal
      title={t("loyaltyLookupTitle")}
      close={onClose}
      closeLabel={t("loyaltyClose")}
      footer={
        <Button onClick={onClose}>{t("loyaltySkip")}</Button>
      }
    >
      {!online && (
        <p role="status" className="muted">
          {t("loyaltyOfflineHint")}
        </p>
      )}
      <form
        className="loyalty-lookup"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <fieldset className="loyalty-country">
          <legend>{t("loyaltyCountry")}</legend>
          {(["MX", "US"] as const).map((c) => (
            <label key={c}>
              <input
                type="radio"
                name="loyalty-country"
                checked={country === c}
                onChange={() => setCountry(c)}
              />
              {t(c === "MX" ? "loyaltyCountryMx" : "loyaltyCountryUs")}
            </label>
          ))}
        </fieldset>
        <Field label={t("loyaltyPhoneLabel")}>
          <input
            ref={phoneRef}
            inputMode="numeric"
            autoComplete="off"
            value={phone}
            maxLength={20}
            onChange={(e) => {
              setPhone(e.target.value);
              setResult(undefined);
            }}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !online}>
          {t("loyaltySearchPhone")}
        </Button>
      </form>
      {result && <ul className="loyalty-results">{row(result)}</ul>}
      {result === null && (
        <section className="loyalty-enroll" aria-label={t("loyaltyEnrollTitle")}>
          <p role="status">{t("loyaltyNotFound")}</p>
          <h3>{t("loyaltyEnrollTitle")}</h3>
          <Field label={t("loyaltyNameLabel")}>
            <input
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <p className="muted">{t("loyaltyNicknameHint")}</p>
          <Field label={locale === "es" ? "Código de recomendación (opcional)" : "Referral code (optional)"}>
            <input value={referral} maxLength={16} onChange={e => setReferral(e.target.value.toUpperCase())} />
          </Field>
          <p className="loyalty-script">{t("loyaltyConsentScript")}</p>
          {club.privacyUrl && (
            <Button variant="ghost" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr}>
              {t("loyaltyShowNoticeQr")}
            </Button>
          )}
          {showQr && club.privacyUrl && (
            <figure className="loyalty-notice-qr">
              <QRCodeSVG
                value={club.privacyUrl}
                size={168}
                level="M"
                marginSize={4}
                title={t("loyaltyNoticeQrTitle")}
                role="img"
              />
              <figcaption>{t("loyaltyNoticeQrTitle")}</figcaption>
            </figure>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            {t("loyaltyConsentStaff")}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
            />
            {t("loyaltyMarketingOptIn")}
          </label>
          <Button
            variant="primary"
            onClick={() => void enroll()}
            disabled={busy || !online || !consent || !name.trim()}
          >
            {t("loyaltyRegister")}
          </Button>
        </section>
      )}
      <form
        className="loyalty-lookup"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Field label={t("loyaltySearchName")}>
          <input
            value={query}
            maxLength={60}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy || !online || query.trim().length < 3}>
          {t("loyaltySearchByName")}
        </Button>
        <p className="muted">{t("loyaltySearchNameHint")}</p>
      </form>
      {matches && (
        matches.length ? (
          <ul className="loyalty-results">{matches.map(row)}</ul>
        ) : (
          <p role="status">{t("loyaltyNoResults")}</p>
        )
      )}
      <Field label={locale === "es" ? "Escanear QR de tarjeta" : "Scan card QR"}>
        <input value={scan} placeholder="gm-club:…" disabled={!online || busy} onChange={e => setScan(e.target.value)} onKeyDown={e => { if(e.key === "Enter") { e.preventDefault(); void run(async () => { const m = await api<MemberSummary | null>("/loyalty/members/scan", {code: scan}); setResult(m); setScan(""); }); } }} />
      </Field>
      <Button disabled={!online || busy || !scan} onClick={() => void run(async () => {setResult(await api<MemberSummary | null>("/loyalty/members/scan", {code: scan}));setScan("");})}>{locale === "es" ? "Buscar tarjeta" : "Find card"}</Button>
      {result && <MemberCardControl memberId={result.id} locale={locale} online={online} />}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}
