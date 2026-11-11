import { useEffect, useState, type ReactNode } from "react";
import {
  currencyExponent,
  minor,
  type Locale,
  type Session,
} from "../../shared/domain";
import type { Offer } from "../../shared/offers";
import type {
  GuestStats,
  MarketingChannel,
  Segment,
} from "../../shared/marketing";
import { api } from "../api";
import { translateError } from "../i18n";
import { mt, type MarketingKey } from "../i18n-marketing";
import { Badge, Button, Empty, Field, Modal } from "../components/ui";
import { OffersManager } from "./Offers";

const tabs = [
  "promotions",
  "guests",
  "campaigns",
  "automations",
  "performance",
  "assistant",
  "settings",
] as const;
type Tab = (typeof tabs)[number];
const channelNames = ["email", "whatsapp", "sms"] as const;
type Overview = {
  plan: "free" | "pro";
  channels: Record<MarketingChannel, { enabled: boolean; reason?: string }>;
  assistant: boolean;
  settings: {
    version: number;
    senderName: string;
    replyTo: string | null;
    privacyUrl: string | null;
    reviewUrl: string | null;
    frequencyCapDays: number;
    attributionDays: number;
    sendHour: number;
  };
};
type Seed = { name: string; subject: string; body: string; segment: Segment };
type Shared = {
  session: Session;
  locale: Locale;
  t: (k: MarketingKey) => string;
  money: (n: number) => string;
  fail: (e: unknown) => void;
  overview: Overview;
};
const toggle = <T,>(list: T[], item: T) =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
const number = (value: string) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Manager workspace: promotions for everyone; guest marketing for Pro. */
export function Marketing({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = mt(locale);
  const exponent = currencyExponent(session.restaurant.currency);
  const scale = 10 ** exponent;
  const money = (n: number) =>
    new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
      style: "currency",
      currency: session.restaurant.currency,
    }).format(n / scale);
  const [tab, setTab] = useState<Tab>("promotions");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [seed, setSeed] = useState<Seed | null>(null);
  const fail = (e: unknown) =>
    setError(translateError((e as Error).message, locale));
  const reload = () =>
    api<Overview>("/marketing/overview").then(setOverview).catch(fail);
  useEffect(() => {
    void reload();
  }, []);
  const shared: Shared | null = overview && {
    session,
    locale,
    t,
    money,
    fail,
    overview,
  };
  const pro = overview?.plan === "pro";
  return (
    <>
      <nav
        className="operations-tabs marketing-tabs"
        aria-label={t("marketing")}
      >
        {tabs.map((key) => (
          <button
            key={key}
            className={tab === key ? "selected" : ""}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => {
              setTab(key);
              setError("");
            }}
          >
            {t(key)}
          </button>
        ))}
      </nav>
      <div className="section-title">
        <div>
          <span className="eyebrow">{session.restaurant.name}</span>
          <h1>{t("marketing")}</h1>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tab === "promotions" && (
        <OffersManager
          locale={locale}
          money={money}
          parseAmount={(s) => minor(s, exponent)}
          scale={scale}
          exponent={exponent}
        />
      )}
      {shared && tab === "guests" && <Guests {...shared} />}
      {shared && tab !== "promotions" && tab !== "guests" && !pro && (
        <p className="warning" role="status">
          {t("proOnly")}
        </p>
      )}
      {shared && pro && tab === "campaigns" && (
        <Campaigns {...shared} seed={seed} clearSeed={() => setSeed(null)} />
      )}
      {shared && pro && tab === "automations" && <Automations {...shared} />}
      {shared && pro && tab === "performance" && <Performance {...shared} />}
      {shared && pro && tab === "assistant" && (
        <Assistant
          {...shared}
          use={(next) => {
            setSeed(next);
            setTab("campaigns");
          }}
        />
      )}
      {shared && tab === "settings" && (
        <MarketingSettings {...shared} reload={reload} />
      )}
    </>
  );
}

function Channels({
  t,
  value,
  onChange,
  overview,
}: Pick<Shared, "t" | "overview"> & {
  value: MarketingChannel[];
  onChange: (next: MarketingChannel[]) => void;
}) {
  return (
    <fieldset>
      <legend>{t("channels")}</legend>
      <div className="row wrap">
        {channelNames.map((channel) => (
          <label className="selection-check labelled" key={channel}>
            <input
              type="checkbox"
              checked={value.includes(channel)}
              onChange={() => onChange(toggle(value, channel))}
            />
            {t(channel)}
            {value.includes(channel) && ` (${value.indexOf(channel) + 1})`}
            {!overview.channels[channel].enabled && (
              <Badge tone="amber">{t("channelDisabled")}</Badge>
            )}
          </label>
        ))}
      </div>
      <p className="tiny muted">{t("channelOrder")}</p>
    </fieldset>
  );
}
function Copy({
  t,
  channels,
  subject,
  body,
  setSubject,
  setBody,
}: Pick<Shared, "t"> & {
  channels: MarketingChannel[];
  subject: string;
  body: string;
  setSubject: (s: string) => void;
  setBody: (s: string) => void;
}) {
  return (
    <>
      {channels.includes("email") && (
        <Field label={t("subject")}>
          <input
            value={subject}
            maxLength={120}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>
      )}
      <Field label={t("message")}>
        <textarea
          rows={5}
          value={body}
          maxLength={2000}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <p className="tiny muted">{t("placeholders")}</p>
    </>
  );
}
function OfferSelect({
  t,
  value,
  onChange,
  fail,
}: Pick<Shared, "t" | "fail"> & {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [offers, setOffers] = useState<Offer[]>([]);
  useEffect(() => {
    void api<Offer[]>("/offers")
      .then((list) => setOffers(list.filter((o) => o.code && o.active)))
      .catch(fail);
  }, []);
  return (
    <Field label={t("attachOffer")}>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{t("none")}</option>
        {offers.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} · {o.code}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Guests({ t, locale, money, fail, session }: Shared) {
  const [data, setData] = useState<{
    total: number;
    subscribed: Record<string, number>;
    guests: GuestStats[];
  } | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<any>(null);
  const [history, setHistory] = useState<any[] | null>(null);
  const [error, setError] = useState("");
  const load = (q = query) =>
    api("/guests?q=" + encodeURIComponent(q))
      .then(setData)
      .catch(fail);
  useEffect(() => {
    const timer = setTimeout(() => void load(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const open = (g?: GuestStats) => {
    setError("");
    setHistory(null);
    setEditing({
      id: g?.id ?? null,
      name: g?.name ?? "",
      email: g?.email ?? "",
      phone: g?.phone ?? "",
      locale: g?.locale ?? "es",
      consent: g?.optIn ?? { email: false, sms: false, whatsapp: false },
      confirmed: false,
    });
    if (g)
      void api(`/guests/${g.id}/consents`)
        .then(setHistory)
        .catch(() => {});
  };
  async function save() {
    try {
      await api("/guests", {
        operationId: crypto.randomUUID(),
        ...editing,
        email: editing.email.trim() || null,
        phone: editing.phone.trim() || null,
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }
  const date = (at: number | null) =>
    at
      ? new Date(at).toLocaleDateString(locale, {
          timeZone: session.restaurant.timezone,
        })
      : t("never");
  return (
    <>
      <div className="row between wrap">
        <input
          className="marketing-search"
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="row">
          <a className="button secondary" href="/api/guests.csv" download>
            {t("exportCsv")}
          </a>
          <Button variant="primary" onClick={() => open()}>
            {t("newGuest")}
          </Button>
        </div>
      </div>
      {data && (
        <p className="summary-copy">
          {t("guests")}: {data.total} ·{" "}
          {channelNames
            .map((c) => `${t(c)}: ${data.subscribed[c] ?? 0}`)
            .join(" · ")}
        </p>
      )}
      {data && !data.guests.length ? (
        <Empty title={t("noGuests")} detail={t("noGuestsHint")} />
      ) : (
        <div className="data-table">
          <table>
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("email")}</th>
                <th>{t("phone")}</th>
                <th>{t("subscribedTo")}</th>
                <th>{t("visits")}</th>
                <th>{t("spend")}</th>
                <th>{t("lastVisit")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.guests.map((g) => (
                <tr key={g.id}>
                  <td>{g.name || "—"}</td>
                  <td>{g.email ?? "—"}</td>
                  <td>{g.phone ?? "—"}</td>
                  <td>
                    {channelNames.filter((c) => g.optIn[c]).length
                      ? channelNames
                          .filter((c) => g.optIn[c])
                          .map((c) => (
                            <Badge key={c} tone="green">
                              {t(c)}
                            </Badge>
                          ))
                      : t("notSubscribed")}
                  </td>
                  <td>{g.visits}</td>
                  <td>{money(g.spend)}</td>
                  <td>{date(g.lastAt)}</td>
                  <td>
                    <Button onClick={() => open(g)}>{t("editGuest")}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal
          title={t(editing.id ? "editGuest" : "newGuest")}
          close={() => setEditing(null)}
          closeLabel={t("close")}
        >
          <div className="form-grid">
            <Field label={t("name")}>
              <input
                value={editing.name}
                maxLength={80}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </Field>
            <Field label={t("language")}>
              <select
                value={editing.locale}
                onChange={(e) =>
                  setEditing({ ...editing, locale: e.target.value })
                }
              >
                <option value="es">Español</option>
                <option value="en">English</option>
              </select>
            </Field>
            <Field label={t("email")}>
              <input
                type="email"
                value={editing.email}
                onChange={(e) =>
                  setEditing({ ...editing, email: e.target.value })
                }
              />
            </Field>
            <Field label={t("phone")}>
              <input
                type="tel"
                value={editing.phone}
                onChange={(e) =>
                  setEditing({ ...editing, phone: e.target.value })
                }
              />
            </Field>
          </div>
          <fieldset>
            <legend>{t("subscribedTo")}</legend>
            <div className="row wrap">
              {channelNames.map((c) => (
                <label className="selection-check labelled" key={c}>
                  <input
                    type="checkbox"
                    checked={editing.consent[c]}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        consent: { ...editing.consent, [c]: e.target.checked },
                      })
                    }
                  />
                  {t(c)}
                </label>
              ))}
            </div>
            <label className="selection-check labelled">
              <input
                type="checkbox"
                checked={editing.confirmed}
                onChange={(e) =>
                  setEditing({ ...editing, confirmed: e.target.checked })
                }
              />
              {t("consentConfirm")}
            </label>
          </fieldset>
          {history && history.length > 0 && (
            <>
              <h3>{t("consentHistory")}</h3>
              {history.map((h, i) => (
                <p className="tiny" key={i}>
                  {new Date(h.created_at).toLocaleString(locale)} ·{" "}
                  {t(h.channel)} · {t(h.granted ? "granted" : "revoked")} ·{" "}
                  {h.source}
                  {h.actor ? ` · ${h.actor}` : ""}
                </p>
              ))}
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button
            variant="primary"
            className="full"
            disabled={!editing.email.trim() && !editing.phone.trim()}
            onClick={() => void save()}
          >
            {t("save")}
          </Button>
        </Modal>
      )}
    </>
  );
}

const stateTone: Record<string, string> = {
  draft: "neutral",
  scheduled: "amber",
  sending: "amber",
  sent: "green",
  cancelled: "red",
};
const segmentFields = [
  "minVisits",
  "maxVisits",
  "visitedWithinDays",
  "notVisitedForDays",
  "joinedWithinDays",
] as const;
function Campaigns({
  seed,
  clearSeed,
  ...shared
}: Shared & { seed: Seed | null; clearSeed: () => void }) {
  const { t, locale, fail, overview } = shared;
  const [list, setList] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [sending, setSending] = useState<any>(null);
  const [when, setWhen] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api("/marketing/campaigns").then(setList).catch(fail);
  const open = (c?: any) => {
    setError("");
    setPreview(null);
    setEditing({
      id: c?.id ?? crypto.randomUUID(),
      version: c?.version ?? 0,
      name: c?.name ?? "",
      channels: c?.channels ?? ["email"],
      subject: c?.subject ?? "",
      body: c?.body ?? "",
      segment: c?.segment ?? {},
      promotionId: c?.promotionId ?? null,
    });
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!seed) return;
    open({ ...seed, version: 0, id: crypto.randomUUID() });
    clearSeed();
  }, [seed]);
  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    wrap(async () => {
      const { version, ...campaign } = editing;
      await api("/marketing/campaigns", {
        operationId: crypto.randomUUID(),
        expectedVersion: version,
        campaign,
      });
      setEditing(null);
      await load();
    });
  const launch = (scheduled: boolean) =>
    wrap(async () => {
      await api("/marketing/campaigns/launch", {
        operationId: crypto.randomUUID(),
        campaignId: sending.id,
        expectedVersion: sending.version,
        scheduledAt: scheduled ? new Date(when).toISOString() : null,
      });
      setSending(null);
      await load();
    });
  const blocked = (channels: MarketingChannel[]) =>
    channels.some((c) => !overview.channels[c].enabled);
  return (
    <>
      <div className="row between">
        <h2>{t("campaigns")}</h2>
        <Button variant="primary" onClick={() => open()}>
          {t("newCampaign")}
        </Button>
      </div>
      {error && !editing && !sending && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list && !list.length && (
        <Empty title={t("noCampaigns")} detail={t("noCampaignsHint")} />
      )}
      <div className="stock-grid">
        {list?.map((c) => (
          <article className="panel" key={c.id}>
            <div className="row between">
              <h3>{c.name}</h3>
              <Badge tone={stateTone[c.state]}>
                {t(c.state as MarketingKey)}
              </Badge>
            </div>
            <p className="tiny muted">
              {c.channels.map((x: MarketingChannel) => t(x)).join(" → ")}
              {c.scheduledAt && c.state === "scheduled"
                ? ` · ${new Date(c.scheduledAt).toLocaleString(locale)}`
                : ""}
            </p>
            {c.state !== "draft" && (
              <p className="tiny">
                {t("delivered")}: {c.messages.sent} · {t("queued")}:{" "}
                {c.messages.queued} · {t("failed")}: {c.messages.failed} ·{" "}
                {t("suppressed")}: {c.messages.suppressed}
                {c.messages.uncertain
                  ? ` · ${t("uncertain")}: ${c.messages.uncertain}`
                  : ""}
              </p>
            )}
            <div className="row wrap">
              {c.state === "draft" && (
                <>
                  <Button onClick={() => open(c)}>{t("editCampaign")}</Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setError("");
                      setWhen("");
                      setSending(c);
                    }}
                  >
                    {t("sendNow")} / {t("schedule")}
                  </Button>
                </>
              )}
              {["scheduled", "sending"].includes(c.state) && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void wrap(async () => {
                      await api("/marketing/campaigns/cancel", {
                        operationId: crypto.randomUUID(),
                        campaignId: c.id,
                      });
                      await load();
                    })
                  }
                >
                  {t("cancelSend")}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <Modal
          wide
          title={t(editing.version ? "editCampaign" : "newCampaign")}
          close={() => !busy && setEditing(null)}
          closeLabel={t("close")}
        >
          <Field label={t("name")}>
            <input
              value={editing.name}
              maxLength={80}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </Field>
          <Channels
            {...shared}
            value={editing.channels}
            onChange={(channels) => setEditing({ ...editing, channels })}
          />
          <Copy
            t={t}
            channels={editing.channels}
            subject={editing.subject}
            body={editing.body}
            setSubject={(subject) => setEditing({ ...editing, subject })}
            setBody={(body) => setEditing({ ...editing, body })}
          />
          <OfferSelect
            t={t}
            fail={fail}
            value={editing.promotionId}
            onChange={(promotionId) => setEditing({ ...editing, promotionId })}
          />
          <fieldset>
            <legend>{t("audience")}</legend>
            <p className="tiny muted">{t("audienceAll")}</p>
            <div className="form-grid">
              {segmentFields.map((key) => (
                <Field key={key} label={`${t(key)} (${t("optional")})`}>
                  <input
                    inputMode="numeric"
                    value={editing.segment[key] ?? ""}
                    onChange={(e) => {
                      const { [key]: _old, ...rest } = editing.segment;
                      const n = number(e.target.value);
                      setEditing({
                        ...editing,
                        segment: n === undefined ? rest : { ...rest, [key]: n },
                      });
                      setPreview(null);
                    }}
                  />
                </Field>
              ))}
            </div>
            <Button
              disabled={busy || !editing.channels.length}
              onClick={() =>
                void wrap(async () =>
                  setPreview(
                    await api("/marketing/audience", {
                      segment: editing.segment,
                      channels: editing.channels,
                    }),
                  ),
                )
              }
            >
              {t("preview")}
            </Button>
            {preview && (
              <p role="status">
                {t("matching")}: {preview.matching} · {t("reachable")}:{" "}
                <strong>{preview.reachable}</strong> (
                {channelNames
                  .map((c) => `${t(c)}: ${preview.byChannel[c]}`)
                  .join(" · ")}
                )
              </p>
            )}
          </fieldset>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button
            variant="primary"
            className="full"
            disabled={
              busy ||
              !editing.name.trim() ||
              !editing.body.trim() ||
              !editing.channels.length ||
              (editing.channels.includes("email") && !editing.subject.trim())
            }
            onClick={() => void save()}
          >
            {t("save")}
          </Button>
        </Modal>
      )}
      {sending && (
        <Modal
          title={`${t("confirmSend")}: ${sending.name}`}
          close={() => !busy && setSending(null)}
          closeLabel={t("close")}
        >
          <p>{t("confirmSendHint")}</p>
          {blocked(sending.channels) && (
            <p className="warning" role="status">
              {t("channelDisabled")}:{" "}
              {sending.channels
                .filter((c: MarketingChannel) => !overview.channels[c].enabled)
                .map((c: MarketingChannel) => t(c))
                .join(", ")}
              . {t("channelsHint")}
            </p>
          )}
          <Field label={`${t("scheduleAt")} (${t("optional")})`}>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </Field>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <Button
              disabled={busy || !when || blocked(sending.channels)}
              onClick={() => void launch(true)}
            >
              {t("schedule")}
            </Button>
            <Button
              variant="primary"
              disabled={busy || blocked(sending.channels)}
              onClick={() => void launch(false)}
            >
              {t("sendNow")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

const paramFor: Record<
  string,
  "inactiveDays" | "everyVisits" | "averageCheck" | "minRating" | null
> = {
  welcome: null,
  positive_feedback: "minRating",
  big_spender: "averageCheck",
  repeat_guest: "everyVisits",
  miss_you: "inactiveDays",
  first_online_order: null,
  drive_in_store: null,
  follow_up: null,
};
function Automations(shared: Shared) {
  const { t, locale, fail, session } = shared;
  const [data, setData] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState("");
  const exponent = currencyExponent(session.restaurant.currency);
  const load = () => api("/marketing/automations").then(setData).catch(fail);
  useEffect(() => {
    void load();
  }, []);
  const save = async (a: any, active: boolean) => {
    setError("");
    try {
      await api("/marketing/automations", {
        operationId: crypto.randomUUID(),
        key: a.key,
        active,
        channels: a.channels,
        subject: a.subject,
        body: a.body,
        params: a.params,
        promotionId: a.promotionId,
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  };
  const open = (a: any) => {
    setError("");
    setEditing(
      a.configured
        ? a
        : {
            ...a,
            subject: a.defaults.subject[locale],
            body: a.defaults.body[locale],
          },
    );
  };
  const param = editing ? paramFor[editing.key] : null;
  return (
    <>
      <h2>{t("automations")}</h2>
      <p className="summary-copy">{t("automationHint")}</p>
      {error && !editing && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="stock-grid">
        {data?.automations.map((a: any) => (
          <article className="panel" key={a.key}>
            <div className="row between">
              <h3>{a.name[locale]}</h3>
              <Badge tone={a.active ? "green" : "neutral"}>
                {t(a.active ? "active" : "inactive")}
              </Badge>
            </div>
            <p className="tiny muted">
              {a.channels.map((c: MarketingChannel) => t(c)).join(" → ")}
              {a.messages ? ` · ${t("delivered")}: ${a.messages.sent}` : ""}
            </p>
            <div className="row wrap">
              <Button onClick={() => open(a)}>{t("configure")}</Button>
              {a.configured && (
                <Button
                  variant={a.active ? "secondary" : "primary"}
                  onClick={() => void save(a, !a.active)}
                >
                  {t(a.active ? "turnOff" : "turnOn")}
                </Button>
              )}
            </div>
          </article>
        ))}
        {data?.unavailable.map((u: any) => (
          <article className="panel" key={u.key}>
            <div className="row between">
              <h3>{t(u.key as MarketingKey)}</h3>
              <Badge tone="amber">{t("unavailable")}</Badge>
            </div>
            <p className="tiny muted">{t(u.reason as MarketingKey)}</p>
          </article>
        ))}
      </div>
      {editing && (
        <Modal
          wide
          title={editing.name[locale]}
          close={() => setEditing(null)}
          closeLabel={t("close")}
        >
          <Channels
            {...shared}
            value={editing.channels}
            onChange={(channels) => setEditing({ ...editing, channels })}
          />
          <Copy
            t={t}
            channels={editing.channels}
            subject={editing.subject}
            body={editing.body}
            setSubject={(subject) => setEditing({ ...editing, subject })}
            setBody={(body) => setEditing({ ...editing, body })}
          />
          {param && (
            <Field label={t(param)}>
              <input
                inputMode="decimal"
                defaultValue={
                  param === "averageCheck"
                    ? (editing.params[param] / 10 ** exponent).toFixed(exponent)
                    : editing.params[param]
                }
                onChange={(e) => {
                  try {
                    const value =
                      param === "averageCheck"
                        ? minor(e.target.value, exponent)
                        : number(e.target.value);
                    if (value !== undefined)
                      setEditing({
                        ...editing,
                        params: { ...editing.params, [param]: value },
                      });
                  } catch {
                    /* Keep the last valid value while typing. */
                  }
                }}
              />
            </Field>
          )}
          <OfferSelect
            t={t}
            fail={fail}
            value={editing.promotionId}
            onChange={(promotionId) => setEditing({ ...editing, promotionId })}
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <Button
              disabled={!editing.channels.length || !editing.body.trim()}
              onClick={() => void save(editing, false)}
            >
              {t("save")} · {t("inactive")}
            </Button>
            <Button
              variant="primary"
              disabled={
                !editing.channels.length ||
                !editing.body.trim() ||
                (editing.channels.includes("email") && !editing.subject.trim())
              }
              onClick={() => void save(editing, true)}
            >
              {t("save")} · {t("turnOn")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Breakdown({
  title,
  rows,
  money,
  t,
  label,
}: Pick<Shared, "money" | "t"> & {
  title: string;
  rows: { label: string; orders: number; sales: number }[];
  label?: (key: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.sales));
  return (
    <section className="panel">
      <h2>{title}</h2>
      {rows.length ? (
        rows.map((r) => (
          <div className="bar-row" key={r.label}>
            <span>{label ? label(r.label) : r.label}</span>
            <div className="bar" aria-hidden="true">
              <i style={{ width: `${(r.sales / max) * 100}%` }} />
            </div>
            <strong>
              {money(r.sales)} · {r.orders}
            </strong>
          </div>
        ))
      ) : (
        <p className="muted">{t("noResults")}</p>
      )}
    </section>
  );
}
function Performance({ t, money, fail }: Shared) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    void api("/marketing/performance?days=" + days)
      .then(setData)
      .catch(fail);
  }, [days]);
  return (
    <>
      <div className="row between">
        <h2>{t("performance")}</h2>
        <Field label={t("period")}>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[7, 14, 30, 90].map((n) => (
              <option key={n} value={n}>
                {t(`days${n}` as MarketingKey)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="summary-copy">{t("attributionHint")}</p>
      {data && (
        <>
          <div className="metric-grid">
            {(
              [
                ["attributedSales", money(data.attributedSales)],
                ["attributedOrders", data.attributedOrders],
                ["averageOrder", money(data.averageOrder)],
                ["messagesSent", data.messages.sent],
              ] as [MarketingKey, ReactNode][]
            ).map(([key, value]) => (
              <div className="metric" key={key}>
                <span>{t(key)}</span>
                <strong>{value}</strong>
                <small>
                  {key === "messagesSent"
                    ? `${t("failed")}: ${data.messages.failed} · ${t("suppressed")}: ${data.messages.suppressed}`
                    : `${t("attributionWindow")}: ${data.attributionDays}`}
                </small>
              </div>
            ))}
          </div>
          <section className="panel">
            <h2>{t("byCampaign")}</h2>
            {data.byCampaign.length ? (
              <div className="data-table">
                <table>
                  <thead>
                    <tr>
                      <th>{t("name")}</th>
                      <th>{t("messagesSent")}</th>
                      <th>{t("orders")}</th>
                      <th>{t("sales")}</th>
                      <th>{t("codeRedemptions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byCampaign.map((c: any) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>{c.sent}</td>
                        <td>{c.orders}</td>
                        <td>{money(c.sales)}</td>
                        <td>
                          {c.codeRedemptions}
                          {c.codeDiscount ? ` (−${money(c.codeDiscount)})` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">{t("noResults")}</p>
            )}
          </section>
          <div className="insight-grid">
            <Breakdown
              t={t}
              money={money}
              title={t("byDay")}
              rows={data.byDay}
            />
            <Breakdown
              t={t}
              money={money}
              title={t("bySource")}
              rows={data.byOrderSource}
              label={(k) =>
                k in { pos: 1, qr: 1, kiosk: 1 } ? t(k as MarketingKey) : k
              }
            />
            <Breakdown
              t={t}
              money={money}
              title={t("byGuestType")}
              rows={data.byGuestType}
              label={(k) => t(k as MarketingKey)}
            />
          </div>
        </>
      )}
    </>
  );
}

const networks = ["instagram", "facebook", "tiktok", "google"] as const;
function Assistant({
  t,
  locale,
  fail,
  overview,
  use,
}: Shared & { use: (seed: Seed) => void }) {
  const [plan, setPlan] = useState<any>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [goal, setGoal] = useState("");
  const [format, setFormat] = useState("email");
  const [draft, setDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [network, setNetwork] =
    useState<(typeof networks)[number]>("instagram");
  const loadPosts = () => api("/marketing/social").then(setPosts).catch(fail);
  useEffect(() => {
    void api("/marketing/plan?locale=" + locale)
      .then(setPlan)
      .catch(fail);
    void loadPosts();
  }, [locale]);
  const savePost = (body: string, plannedFor: string | null, extra = {}) =>
    api("/marketing/social", {
      operationId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      network,
      body,
      plannedFor,
      ...extra,
    })
      .then(loadPosts)
      .catch(fail);
  return (
    <>
      <h2>{t("monthPlan")}</h2>
      <p className="summary-copy">{t("monthPlanHint")}</p>
      {plan && !plan.insights.sufficient && (
        <p className="warning" role="status">
          {t("insufficientHistory")}
        </p>
      )}
      <div className="stock-grid">
        {plan?.plan.map((s: any, i: number) => (
          <article className="panel" key={i}>
            <div className="row between">
              <h3>{s.title}</h3>
              <Badge>{s.date}</Badge>
            </div>
            <p className="tiny muted">{s.why}</p>
            <p>{s.body}</p>
            <div className="row wrap">
              <Button
                variant="primary"
                onClick={() =>
                  use({
                    name: `${s.title} · ${s.date}`,
                    subject: s.subject,
                    body: s.body,
                    segment: s.segment,
                  })
                }
              >
                {t("useAsCampaign")}
              </Button>
              <Button onClick={() => void savePost(s.social, s.date)}>
                {t("saveSocial")}
              </Button>
            </div>
          </article>
        ))}
      </div>
      <section className="panel">
        <h2>{t("draftWithAssistant")}</h2>
        <Badge tone={overview.assistant ? "green" : "amber"}>
          {t(overview.assistant ? "sourceAi" : "sourceTemplate")}
        </Badge>
        <Field label={t("goal")}>
          <textarea
            rows={2}
            value={goal}
            maxLength={400}
            placeholder={t("goalHint")}
            onChange={(e) => setGoal(e.target.value)}
          />
        </Field>
        <div className="form-grid">
          <Field label={t("format")}>
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              {["email", "whatsapp", "sms", "social"].map((f) => (
                <option key={f} value={f}>
                  {t(f as MarketingKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("network")}>
            <select
              value={network}
              onChange={(e) => setNetwork(e.target.value as typeof network)}
            >
              {networks.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button
          variant="primary"
          disabled={busy || goal.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            try {
              setDraft(await api("/marketing/draft", { goal, format, locale }));
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("generate")}
        </Button>
        {draft && (
          <div className="assistant-draft">
            <Badge tone={draft.source === "ai" ? "green" : "amber"}>
              {t(draft.source === "ai" ? "sourceAi" : "sourceTemplate")}
            </Badge>
            {draft.subject && <strong>{draft.subject}</strong>}
            <p>{draft.body}</p>
            <div className="row wrap">
              {format === "social" ? (
                <Button onClick={() => void savePost(draft.body, null)}>
                  {t("saveSocial")}
                </Button>
              ) : (
                <Button
                  onClick={() =>
                    use({
                      name: goal.slice(0, 80),
                      subject: draft.subject,
                      body: draft.body,
                      segment: {},
                    })
                  }
                >
                  {t("useAsCampaign")}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
      <h2>{t("socialPosts")}</h2>
      <p className="summary-copy">{t("socialHint")}</p>
      <div className="stock-grid">
        {posts.map((p) => (
          <article className="panel" key={p.id}>
            <div className="row between">
              <Badge>{p.network}</Badge>
              <span className="tiny muted">{p.plannedFor ?? ""}</span>
            </div>
            <p>{p.body}</p>
            <div className="row wrap">
              <Button
                onClick={() => void navigator.clipboard?.writeText(p.body)}
              >
                {t("copy")}
              </Button>
              {p.state === "draft" && (
                <Button
                  onClick={() =>
                    void api("/marketing/social", {
                      operationId: crypto.randomUUID(),
                      id: p.id,
                      network: p.network,
                      body: p.body,
                      plannedFor: p.plannedFor,
                      state: "posted",
                    })
                      .then(loadPosts)
                      .catch(fail)
                  }
                >
                  {t("markPosted")}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() =>
                  void api("/marketing/social", {
                    operationId: crypto.randomUUID(),
                    id: p.id,
                    network: p.network,
                    body: p.body,
                    plannedFor: p.plannedFor,
                    state: "discarded",
                  })
                    .then(loadPosts)
                    .catch(fail)
                }
              >
                {t("discard")}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function MarketingSettings({
  t,
  overview,
  locale,
  reload,
}: Shared & { reload: () => Promise<unknown> }) {
  const [form, setForm] = useState(overview.settings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const pro = overview.plan === "pro";
  const text = (key: "senderName" | "replyTo" | "privacyUrl" | "reviewUrl") => (
    <Field label={t(key)}>
      <input
        value={form[key] ?? ""}
        onChange={(e) => {
          setSaved(false);
          setForm({ ...form, [key]: e.target.value });
        }}
      />
    </Field>
  );
  const numeric = (
    key: "frequencyCapDays" | "attributionDays" | "sendHour",
    label: MarketingKey,
  ) => (
    <Field label={t(label)}>
      <input
        inputMode="numeric"
        value={form[key]}
        onChange={(e) => {
          setSaved(false);
          setForm({ ...form, [key]: number(e.target.value) ?? 0 });
        }}
      />
    </Field>
  );
  return (
    <>
      <h2>{t("channels")}</h2>
      <p className="summary-copy">{t("channelsHint")}</p>
      <div className="stock-grid">
        {channelNames.map((c) => (
          <div className="panel" key={c}>
            <div className="row between">
              <h3>{t(c)}</h3>
              <Badge tone={overview.channels[c].enabled ? "green" : "amber"}>
                {overview.channels[c].enabled
                  ? t("enabled")
                  : t(`reason_${overview.channels[c].reason}` as MarketingKey)}
              </Badge>
            </div>
          </div>
        ))}
      </div>
      {pro && (
        <section className="panel">
          <h2>{t("settings")}</h2>
          <div className="form-grid">
            {text("senderName")}
            {text("replyTo")}
            {text("privacyUrl")}
            {text("reviewUrl")}
            {numeric("frequencyCapDays", "frequencyCap")}
            {numeric("attributionDays", "attributionWindow")}
            {numeric("sendHour", "sendHour")}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button
            variant="primary"
            onClick={async () => {
              setError("");
              try {
                const { version, ...rest } = form;
                const next = await api<Overview["settings"]>(
                  "/marketing/settings",
                  {
                    operationId: crypto.randomUUID(),
                    expectedVersion: version,
                    ...rest,
                    replyTo: rest.replyTo?.trim() || null,
                    privacyUrl: rest.privacyUrl?.trim() || null,
                    reviewUrl: rest.reviewUrl?.trim() || null,
                  },
                );
                setForm(next);
                setSaved(true);
                await reload();
              } catch (e) {
                setError(translateError((e as Error).message, locale));
              }
            }}
          >
            {t("save")}
          </Button>{" "}
          <span className="tiny muted" aria-live="polite">
            {saved ? t("saved") : ""}
          </span>
        </section>
      )}
    </>
  );
}
