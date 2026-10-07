import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Field } from "../components/ui";
import { strings, errorNotice, type Key } from "../i18n";
import type { Locale, Session } from "../../shared/domain";
export function RestaurantSettings({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = (key: Key) => strings[locale][key];
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [days, setDays] = useState<number[]>([]);
  useEffect(() => {
    void api("/restaurant")
      .then((r) => {
        setData(r);
        setDays(r.openingDays);
      })
      .catch((e) => setError(errorNotice(e, locale)));
  }, []);
  const editable = session.role === "owner";
  if (!data) return <p role="status">{error || t("loading")}</p>;
  return (
    <section className="panel restaurant-settings">
      <h2>{t("restaurantSettings")}</h2>
      <form
        key={data.version}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setSaved(false);
          const f = new FormData(e.currentTarget);
          const [hour, minute] = String(f.get("cutoff")).split(":").map(Number);
          try {
            const result = await api("/restaurant", {
              operationId: crypto.randomUUID(),
              expectedVersion: data.version,
              name: f.get("name"),
              currency: data.currencyLocked ? data.currency : f.get("currency"),
              timezone: f.get("timezone"),
              cutoff: hour * 60 + minute,
              openingDays: days,
            });
            setData(result);
            setSaved(true);
            window.dispatchEvent(new Event("gm-session-refresh"));
          } catch (e) {
            setError(errorNotice(e, locale));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={!editable || busy}>
          <div className="form-grid">
            <Field label={t("restaurant")}>
              <input
                name="name"
                defaultValue={data.name}
                required
                maxLength={100}
              />
            </Field>
            <Field label={t("currency")}>
              <select
                name="currency"
                defaultValue={data.currency}
                disabled={data.currencyLocked}
              >
                {Intl.supportedValuesOf("currency").map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
              </select>
            </Field>
            <Field label={t("timezone")}>
              <select name="timezone" defaultValue={data.timezone}>
                {[
                  ...new Set([
                    data.timezone,
                    "UTC",
                    ...Intl.supportedValuesOf("timeZone"),
                  ]),
                ].map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </select>
            </Field>
            <Field label={t("businessCutoff")}>
              <input
                name="cutoff"
                type="time"
                required
                defaultValue={`${String(Math.floor(data.cutoff / 60)).padStart(2, "0")}:${String(data.cutoff % 60).padStart(2, "0")}`}
              />
            </Field>
          </div>
          <p className="muted">{t("cutoffHint")}</p>
          {data.currencyLocked && (
            <p className="muted">{t("currencyLocked")}</p>
          )}
          <fieldset>
            <legend>{t("openingDays")}</legend>
            <div className="row wrap">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <label className="option" key={day}>
                  <input
                    type="checkbox"
                    checked={days.includes(day)}
                    onChange={() =>
                      setDays(
                        days.includes(day)
                          ? days.filter((d) => d !== day)
                          : [...days, day].sort(),
                      )
                    }
                  />
                  {new Intl.DateTimeFormat(locale, {
                    weekday: "long",
                    timeZone: "UTC",
                  }).format(new Date(Date.UTC(2024, 0, day)))}
                </label>
              ))}
            </div>
          </fieldset>
          {editable && (
            <Button variant="primary" type="submit">
              {busy ? t("loading") : t("save")}
            </Button>
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {saved && <p role="status">{t("settingsSaved")}</p>}
      </form>
    </section>
  );
}
