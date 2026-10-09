/**
 * Clientes (038 §2.9): owners and managers. A searchable list (name or phone, 50 per page,
 * keyset) and the member's detail: card, history, orders, consent; Editar datos (rectification),
 * Ajustar sellos o premios, Imprimir datos del cliente (ARCO access) and Eliminar datos del cliente
 * (ARCO cancellation). Every write asks for step-up on a shared terminal (the server decides).
 */
import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  ADJUST_REASONS,
  formatPhone,
  phoneCountry,
  type LoyaltyCountry,
  type MemberDetail,
  type MemberListRow,
} from "../../../shared/loyalty";
import { errorNotice, type Key } from "../../i18n";
import { dateTime } from "../../datetime";
import { printDocument } from "../../print";
import { Button, Field, Modal } from "../../components/ui";
import { loyaltyApi } from "./loyaltyApi";
import {
  consentChannelLabel,
  dayText,
  fill,
  ledgerKindLabel,
  money,
  rewardsText,
  stampsText,
  tr,
  viaLabel,
} from "./format";
import "./loyalty.css";

export function Members({
  session,
  locale,
  online,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
}) {
  const t = tr(locale);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"" | "rewards" | "imported">("");
  const [rows, setRows] = useState<MemberListRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = async (more = false) => {
    setError("");
    try {
      const r = await loyaltyApi.list({
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(filter ? { filter } : {}),
        ...(more && cursor ? { cursor } : {}),
      });
      setRows((prev) => (more ? [...prev, ...r.rows] : r.rows));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  };
  useEffect(() => {
    if (online && !open) void load();
  }, [online, filter, open]);
  const tz = session.restaurant.timezone;
  if (open)
    return (
      <MemberDetailView
        session={session}
        locale={locale}
        online={online}
        memberId={open}
        onBack={() => setOpen(null)}
      />
    );
  return (
    <section className="panel loyalty-members" aria-labelledby="loyalty-members-title">
      <h1 id="loyalty-members-title">{t("loyaltyMembersTitle")}</h1>
      {!online && <p className="muted">{t("loyaltyOfflineHint")}</p>}
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <Field label={t("loyaltyMembersSearch")}>
          <input value={q} maxLength={60} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <Field label={t("loyaltyFilterAll")}>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="">{t("loyaltyFilterAll")}</option>
            <option value="rewards">{t("loyaltyFilterRewards")}</option>
            <option value="imported">{t("loyaltyFilterImported")}</option>
          </select>
        </Field>
        <Button type="submit" disabled={!online}>
          {t("loyaltySearch")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="muted">{t("loyaltyEmpty")}</p>
      ) : (
        <div className="table-scroll">
          <table className="loyalty-table">
            <thead>
              <tr>
                <th scope="col">{t("loyaltyColName")}</th>
                <th scope="col">{t("loyaltyColPhone")}</th>
                <th scope="col">{t("loyaltyColStamps")}</th>
                <th scope="col">{t("loyaltyColRewards")}</th>
                <th scope="col">{t("loyaltyColLastVisit")}</th>
                <th scope="col">{t("loyaltyColSince")}</th>
                <th scope="col">
                  <span className="sr-only">{t("loyaltyOpen")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.maskedPhone}</td>
                  <td className={m.stamps < 0 ? "loyalty-negative" : ""}>{stampsText(m, locale)}</td>
                  <td>{m.rewards}</td>
                  <td>{m.lastVisitAt ? dateTime(m.lastVisitAt, tz, locale) : "—"}</td>
                  <td>{dateTime(m.joinedAt, tz, locale).slice(0, 10)}</td>
                  <td>
                    <Button onClick={() => setOpen(m.id)} aria-label={`${t("loyaltyOpen")} ${m.name}`}>
                      {t("loyaltyOpen")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <Button onClick={() => void load(true)} disabled={!online}>
          {t("loyaltyMore")}
        </Button>
      )}
    </section>
  );
}

const ADJUST_LABEL: Record<(typeof ADJUST_REASONS)[number], Key> = {
  correction: "loyaltyAdjustReasonCorrection",
  goodwill: "loyaltyAdjustReasonGoodwill",
  pos_lite_balance: "loyaltyAdjustReasonPosLite",
  other: "loyaltyAdjustReasonOther",
};

function MemberDetailView({
  session,
  locale,
  online,
  memberId,
  onBack,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  memberId: string;
  onBack: () => void;
}) {
  const t = tr(locale);
  const [m, setM] = useState<MemberDetail | null>(null);
  const [dialog, setDialog] = useState<"edit" | "adjust" | "delete" | null>(null);
  const [error, setError] = useState("");
  const tz = session.restaurant.timezone;
  const currency = session.restaurant.currency;
  useEffect(() => {
    loyaltyApi
      .member(memberId)
      .then(setM)
      .catch((e) => setError(errorNotice(e, locale)));
  }, [memberId]);
  const act = async (fn: () => Promise<MemberDetail>) => {
    setError("");
    try {
      setM(await fn());
      setDialog(null);
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  };
  if (!m)
    return (
      <section className="panel">
        <Button onClick={onBack}>{t("loyaltyBack")}</Button>
        {error && <p role="alert" className="error">{error}</p>}
      </section>
    );
  return (
    <section className="panel loyalty-member" aria-labelledby="loyalty-member-name">
      <Button onClick={onBack}>{t("loyaltyBack")}</Button>
      <h1 id="loyalty-member-name">{m.deleted ? t("loyaltyDeleted") : m.name}</h1>
      {!m.deleted && <p>{formatPhone(m.phone)}</p>}
      <p className="muted">
        {fill(t("loyaltyMemberJoined"), {
          date: dateTime(m.joinedAt, tz, locale).slice(0, 10),
          via: viaLabel(m.joinedVia, locale),
        })}
      </p>
      <p className="muted">
        {fill(t("loyaltyConsentLine"), {
          channel: consentChannelLabel(m.consentChannel, locale),
          date: dateTime(m.consentAt, tz, locale),
        })}
        {m.joinedByName ? fill(t("loyaltyConsentBy"), { name: m.joinedByName }) : ""}
      </p>
      {!m.deleted && (
        <label className="check">
          <input
            type="checkbox"
            checked={m.marketingOptIn}
            disabled={!online}
            onChange={(e) =>
              void act(() =>
                loyaltyApi.update(m.id, {
                  expectedVersion: m.version,
                  marketingOptIn: e.target.checked,
                }),
              )
            }
          />
          {t("loyaltyMarketingToggle")}
        </label>
      )}
      <div className="loyalty-card" aria-label={t("loyaltyCard")}>
        <p>
          <strong>{fill(t("loyaltyCardProgress"), { stamps: m.stamps, required: m.required })}</strong>
          {m.stamps < 0 ? ` · ${t("loyaltyPendingAdjust")}` : ""}
        </p>
        <div className="loyalty-dots" aria-hidden="true">
          {Array.from({ length: m.required }, (_, i) => (
            <span key={i} className={i < m.stamps ? "on" : ""} />
          ))}
        </div>
        <p>{m.rewards > 0 ? rewardsText(m.rewards, locale) : "—"}</p>
        <p className="muted">{fill(t("loyaltyLifetime"), { n: m.lifetimeStamps })}</p>
        <p className="muted">
          {fill(t("loyaltyRewardsTotals"), { earned: m.rewardsEarned, redeemed: m.rewardsRedeemed })}
        </p>
        {m.legacy && (
          <p className="muted">
            {fill(t("loyaltyLegacyLine"), {
              visits: m.legacy.visits,
              spend: money(m.legacy.spend, locale, currency),
            })}
          </p>
        )}
      </div>
      {!m.deleted && (
        <div className="row wrap">
          <Button onClick={() => setDialog("edit")} disabled={!online}>
            {t("loyaltyEdit")}
          </Button>
          <Button onClick={() => setDialog("adjust")} disabled={!online}>
            {t("loyaltyAdjust")}
          </Button>
          <Button
            onClick={async () => {
              try {
                const sheet = await loyaltyApi.sheet(m.id);
                await printDocument(<MemberSheet m={sheet} locale={locale} tz={tz} currency={currency} />);
              } catch (e) {
                setError(errorNotice(e, locale));
              }
            }}
            disabled={!online}
          >
            {t("loyaltyPrintData")}
          </Button>
          <Button variant="danger" onClick={() => setDialog("delete")} disabled={!online}>
            {t("loyaltyDelete")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <h2 id="loyalty-member-history">{t("loyaltyHistory")}</h2>
      <ul className="loyalty-history" aria-labelledby="loyalty-member-history">
        {m.history.map((h) => (
          <li key={h.id}>
            <span>{dateTime(h.createdAt, tz, locale)}</span>{" "}
            <strong>{ledgerKindLabel(h.kind, locale)}</strong>{" "}
            {h.stampsDelta !== 0 && <span>{(h.stampsDelta > 0 ? "+" : "") + h.stampsDelta}</span>}{" "}
            {h.rewardsDelta !== 0 && (
              <span>
                {(h.rewardsDelta > 0 ? "+" : "") + h.rewardsDelta} {t("loyaltyColRewards").toLowerCase()}
              </span>
            )}{" "}
            {h.orderNumber !== null && (
              <span className="muted">
                #{h.orderNumber} · {h.orderBusinessDate ? dayText(h.orderBusinessDate, locale) : ""}
              </span>
            )}{" "}
            {h.actorName && <span className="muted">· {h.actorName}</span>}
            {h.note && <span className="muted"> · {h.note}</span>}
          </li>
        ))}
      </ul>
      <h2 id="loyalty-member-orders">{t("loyaltyOrders")}</h2>
      <ul className="loyalty-history" aria-labelledby="loyalty-member-orders">
        {m.orders.map((o) => (
          <li key={o.orderId}>
            {fill(t("loyaltyOrderLine"), {
              n: o.number,
              date: dayText(o.businessDate, locale),
              total: money(o.total, locale, currency),
              stamps: o.stamps,
            })}
          </li>
        ))}
      </ul>
      {dialog === "edit" && (
        <EditMemberDialog
          m={m}
          locale={locale}
          onClose={() => setDialog(null)}
          onSave={(body) => act(() => loyaltyApi.update(m.id, { expectedVersion: m.version, ...body }))}
        />
      )}
      {dialog === "adjust" && (
        <AdjustDialog
          locale={locale}
          onClose={() => setDialog(null)}
          onSave={(body) => act(() => loyaltyApi.adjust(m.id, body))}
        />
      )}
      {dialog === "delete" && (
        <DeleteMemberDialog
          locale={locale}
          onClose={() => setDialog(null)}
          onConfirm={() => act(() => loyaltyApi.remove(m.id, m.version))}
        />
      )}
    </section>
  );
}

function EditMemberDialog({
  m,
  locale,
  onClose,
  onSave,
}: {
  m: MemberDetail;
  locale: Locale;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = tr(locale);
  const [name, setName] = useState(m.name);
  const [country, setCountry] = useState<LoyaltyCountry>(m.phone ? phoneCountry(m.phone) : "MX");
  const [phone, setPhone] = useState(m.phone ? m.phone.replace(/^\+(52|1)/, "") : "");
  return (
    <Modal
      title={t("loyaltyEdit")}
      close={onClose}
      closeLabel={t("loyaltyClose")}
      footer={
        <div className="row wrap">
          <Button onClick={onClose}>{t("loyaltyCancel")}</Button>
          <Button
            variant="primary"
            onClick={() => void onSave({ name, phone, country })}
          >
            {t("loyaltySave")}
          </Button>
        </div>
      }
    >
      <Field label={t("loyaltyNameLabel")}>
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </Field>
      <fieldset className="loyalty-country">
        <legend>{t("loyaltyCountry")}</legend>
        {(["MX", "US"] as const).map((c) => (
          <label key={c}>
            <input type="radio" name="edit-country" checked={country === c} onChange={() => setCountry(c)} />
            {t(c === "MX" ? "loyaltyCountryMx" : "loyaltyCountryUs")}
          </label>
        ))}
      </fieldset>
      <Field label={t("loyaltyPhoneLabel")}>
        <input inputMode="numeric" value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value)} />
      </Field>
    </Modal>
  );
}

function AdjustDialog({
  locale,
  onClose,
  onSave,
}: {
  locale: Locale;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = tr(locale);
  const [stamps, setStamps] = useState("0");
  const [rewards, setRewards] = useState("0");
  const [reason, setReason] = useState<(typeof ADJUST_REASONS)[number]>("correction");
  const [note, setNote] = useState("");
  return (
    <Modal
      title={t("loyaltyAdjust")}
      close={onClose}
      closeLabel={t("loyaltyClose")}
      footer={
        <div className="row wrap">
          <Button onClick={onClose}>{t("loyaltyCancel")}</Button>
          <Button
            variant="primary"
            disabled={note.trim().length < 3 || (Number(stamps) === 0 && Number(rewards) === 0)}
            onClick={() =>
              void onSave({ stamps: Number(stamps), rewards: Number(rewards), reason, note: note.trim() })
            }
          >
            {t("loyaltyConfirm")}
          </Button>
        </div>
      }
    >
      <Field label={t("loyaltyAdjustStamps")}>
        <input type="number" min={-50} max={50} value={stamps} onChange={(e) => setStamps(e.target.value)} />
      </Field>
      <Field label={t("loyaltyAdjustRewards")}>
        <input type="number" min={-5} max={5} value={rewards} onChange={(e) => setRewards(e.target.value)} />
      </Field>
      <Field label={t("loyaltyAdjustReason")}>
        <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
          {ADJUST_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(ADJUST_LABEL[r])}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("loyaltyAdjustNote")}>
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function DeleteMemberDialog({
  locale,
  onClose,
  onConfirm,
}: {
  locale: Locale;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = tr(locale);
  const [typed, setTyped] = useState("");
  return (
    <Modal
      title={t("loyaltyDelete")}
      close={onClose}
      closeLabel={t("loyaltyClose")}
      footer={
        <div className="row wrap">
          <Button onClick={onClose}>{t("loyaltyCancel")}</Button>
          <Button variant="danger" disabled={typed !== "ELIMINAR"} onClick={() => void onConfirm()}>
            {t("loyaltyDelete")}
          </Button>
        </div>
      }
    >
      <p>{t("loyaltyDeleteConfirm")}</p>
      <Field label={t("loyaltyDeleteType")}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </Field>
    </Modal>
  );
}

/** The printable ARCO access sheet: every stored field, consent and history. */
export function MemberSheet({
  m,
  locale,
  tz,
  currency,
}: {
  m: MemberDetail;
  locale: Locale;
  tz: string;
  currency: string;
}) {
  const t = tr(locale);
  return (
    <div className="loyalty-sheet">
      <h1>{t("loyaltySheetTitle")}</h1>
      <dl>
        <dt>{t("loyaltyColName")}</dt>
        <dd>{m.name}</dd>
        <dt>{t("loyaltyColPhone")}</dt>
        <dd>{formatPhone(m.phone)}</dd>
        <dt>{t("loyaltyColSince")}</dt>
        <dd>
          {dateTime(m.joinedAt, tz, locale)} · {viaLabel(m.joinedVia, locale)}
        </dd>
        <dt>{t("loyaltyNoticeQrTitle")}</dt>
        <dd>
          {fill(t("loyaltyConsentLine"), {
            channel: consentChannelLabel(m.consentChannel, locale),
            date: dateTime(m.consentAt, tz, locale),
          })}
          {m.consentNoticeUrl ? ` · ${m.consentNoticeUrl}` : ""}
        </dd>
        <dt>{t("loyaltyMarketingToggle")}</dt>
        <dd>{m.marketingOptIn ? "✓" : "—"}</dd>
        <dt>{t("loyaltyCard")}</dt>
        <dd>
          {fill(t("loyaltyCardProgress"), { stamps: m.stamps, required: m.required })} ·{" "}
          {rewardsText(m.rewards, locale)}
        </dd>
        {m.legacy && (
          <>
            <dt>POS Lite</dt>
            <dd>
              {fill(t("loyaltyLegacyLine"), {
                visits: m.legacy.visits,
                spend: money(m.legacy.spend, locale, currency),
              })}
            </dd>
          </>
        )}
      </dl>
      <h2>{t("loyaltyHistory")}</h2>
      <ul>
        {m.history.map((h) => (
          <li key={h.id}>
            {dateTime(h.createdAt, tz, locale)} · {ledgerKindLabel(h.kind, locale)} · {h.stampsDelta} /{" "}
            {h.rewardsDelta}
            {h.orderNumber !== null ? ` · #${h.orderNumber}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
