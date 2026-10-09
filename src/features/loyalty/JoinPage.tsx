/**
 * /club#<token>: the receipt's join page (038 §2.7). Pre-auth and without a service worker (R32):
 * the token stays in the URL fragment and travels only in the x-gm-join-token header. The diner
 * types a phone and a name or nickname, accepts the restaurant's privacy notice (required; the
 * link opens in a new tab) and may opt into promotions (unchecked). Replies carry counts only.
 */
import { useEffect, useState } from "react";
import type { Locale } from "../../../shared/domain";
import {
  JOIN_HEADER,
  SEALED_TOKEN,
  enrollmentIssue,
  type JoinResult,
  type JoinView,
  type LoyaltyCountry,
} from "../../../shared/loyalty";
import { errorText, strings } from "../../i18n";
import { Button, Field } from "../../components/ui";
import { dayText, fill } from "./format";
import "../public/diner.css";
import "./loyalty.css";

const tokenOf = () => {
  const raw = location.hash.replace(/^#/, "");
  return SEALED_TOKEN.test(raw) ? raw : null;
};
const message = (code: string, locale: Locale) =>
  errorText[code]?.[locale === "es" ? 0 : 1] ?? strings[locale].error;

async function call<T>(token: string, body?: unknown): Promise<T> {
  const r = await fetch("/api/club/join", {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", [JOIN_HEADER]: token },
    body: body === undefined ? undefined : JSON.stringify(body),
    referrerPolicy: "no-referrer",
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error === "unauthorized" ? "loyalty_join_unavailable" : (data?.error ?? "error"));
  return data as T;
}

export function JoinPage() {
  const locale: Locale = navigator.language?.startsWith("en") ? "en" : "es";
  const t = strings[locale];
  const [token] = useState(tokenOf);
  const [view, setView] = useState<JoinView | null>(null);
  const [failure, setFailure] = useState("");
  const [country, setCountry] = useState<LoyaltyCountry>("MX");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<JoinResult | null>(null);
  useEffect(() => {
    if (!token) return;
    call<JoinView>(token)
      .then(setView)
      .catch((e) => setFailure(message(e.message, locale)));
  }, [token]);
  if (!token)
    return (
      <main className="diner diner-notice loyalty-join" lang={locale}>
        <h1>{t.loyaltyJoinNoToken}</h1>
      </main>
    );
  if (failure)
    return (
      <main className="diner diner-notice loyalty-join" lang={locale}>
        <h1>{failure}</h1>
      </main>
    );
  if (!view) return <main className="diner" lang={locale}><p role="status">…</p></main>;
  const program = view.programName;
  async function submit() {
    setError("");
    const issue = enrollmentIssue({ phone, country, name, consent: accepted });
    if (issue) {
      setError(message(issue, locale));
      return;
    }
    setBusy(true);
    try {
      setDone(
        await call<JoinResult>(token!, {
          phone,
          country,
          name,
          privacyAccepted: true,
          marketingOptIn: marketing,
        }),
      );
    } catch (e) {
      setError(message((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="diner loyalty-join" lang={locale}>
      <header className="diner-header">
        <div>
          <p className="diner-place">{view.restaurantName}</p>
          <h1>{fill(t.loyaltyJoinTitle, { program })}</h1>
        </div>
      </header>
      <p>
        {fill(t.loyaltyJoinIntro, {
          label: `#${view.orderNumber} · ${dayText(view.businessDate, locale)}`,
          required: view.stampsRequired,
          reward: view.rewardDescription,
        })}
      </p>
      {done ? (
        <p role="status" className="loyalty-join-done">
          {done.pending
            ? t.loyaltyJoinPending
            : fill(t.loyaltyJoinDone, {
                n: done.stampsAdded,
                stamps: done.stamps,
                required: done.required,
              })}
        </p>
      ) : view.linked ? (
        <p role="status">{t.loyaltyJoinAlready}</p>
      ) : (
        <form
          className="loyalty-join-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className="loyalty-country">
            <legend>{t.loyaltyCountry}</legend>
            {(["MX", "US"] as const).map((c) => (
              <label key={c}>
                <input
                  type="radio"
                  name="join-country"
                  checked={country === c}
                  onChange={() => setCountry(c)}
                />
                {c === "MX" ? t.loyaltyCountryMx : t.loyaltyCountryUs}
              </label>
            ))}
          </fieldset>
          <Field label={t.loyaltyPhoneLabel}>
            <input
              inputMode="tel"
              autoComplete="tel-national"
              value={phone}
              maxLength={20}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <Field label={t.loyaltyNameLabel}>
            <input
              autoComplete="nickname"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <p className="muted">{t.loyaltyNicknameHint}</p>
          <label className="check">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>
              {fill(t.loyaltyJoinPrivacy, { restaurant: view.restaurantName })}{" "}
              {view.privacyUrl && (
                <a href={view.privacyUrl} target="_blank" rel="noopener noreferrer">
                  {fill(t.loyaltyJoinNoticeLink, { restaurant: view.restaurantName })}
                </a>
              )}
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
            />
            {t.loyaltyJoinMarketing}
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            {t.loyaltyJoinSubmit}
          </Button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      )}
    </main>
  );
}
export default JoinPage;
