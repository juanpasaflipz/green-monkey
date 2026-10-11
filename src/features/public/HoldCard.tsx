import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { ALLERGY_PATTERN } from "../../../shared/service";
import {
  inboxActions,
  kioskChargingExits,
  kioskInboxState,
  type InboxHold,
} from "../../../shared/public-ordering";
import { strings, type Key } from "../../i18n";
import { Badge, Button } from "../../components/ui";
import { moneyFormatter } from "../Receipt";
import { fill } from "../menu/format";
import { currentBusinessDate, orderNumberText } from "../../labels";
import { api } from "../../api";
import { translateError } from "../../i18n";
import { ResolveDialog } from "../payments/ResolveDialog";
import type { AttemptView } from "../../../shared/payments";
import type { RejectReason } from "../../../shared/public-ordering";
import { kioskRejectReason } from "../../../shared/kiosk";

/** The kiosk charge a manager resolves through its hold, with the note (critic R13). */
export type KioskCharge = { attemptId: string; note: string };

const MANAGERS = ["owner", "manager"];

export type AcceptBody = {
  target:
    | { kind: "new" }
    | { kind: "append"; orderId: string; expectedVersion: number };
  excludeLineIds: string[];
  /** The current total this card showed (MONEY-1): the server charges nothing else. */
  acknowledgedTotal: number | null;
  abuseAcknowledged: boolean;
};

/**
 * One held order in Órdenes: the lines with "Incluir" checkboxes and their
 * re-quote, the totals, the target check for table orders, and the actions
 * the policy and role allow. Its choices survive inbox polls (keyed by hold).
 */
export function HoldCard({
  hold,
  session,
  locale,
  online,
  busy,
  error,
  nowMs,
  forceNew,
  onAccept,
  onPay,
  onReject,
  onKioskChanged,
  onKioskAccept,
  onKioskReject,
}: {
  hold: InboxHold;
  session: Session;
  locale: Locale;
  online: boolean;
  busy: boolean;
  error: string;
  nowMs: number;
  /** Set after a target refusal: the card switches to "Cuenta nueva". */
  forceNew: boolean;
  onAccept: (body: AcceptBody) => void;
  onPay: (body: AcceptBody, due: number) => void;
  onReject: () => void;
  /** Kiosk (039): a kiosk charge was cancelled or resolved; the inbox reloads. */
  onKioskChanged?: () => void;
  /** «Aceptar con el pago del kiosco» (critic R13): the rest is collected when above zero. */
  onKioskAccept?: (
    body: AcceptBody,
    charge: KioskCharge,
    rest: number,
  ) => Promise<void>;
  /** «Rechazar y reembolsar» (critic R13). */
  onKioskReject?: (charge: KioskCharge, reason: RejectReason) => Promise<void>;
}) {
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const money = moneyFormatter(session.restaurant.currency, locale);
  const open = hold.openChecks.filter((c) => c.checkState === "open");
  // LD-29 (POL-R2-2): yesterday's open #10 reads "#10 · 5 oct" in "Enviar a".
  const today = open.some((c) => c.businessDate)
    ? currentBusinessDate(session.restaurant)
    : null;
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>(() =>
    open.length === 1 ? open[0].id : "new",
  );
  // Until staff choose a target, the default follows the table's checks: a
  // check opened since (another hold accepted as new) is pre-selected when it
  // is the only one (MONEY-3, spec §2.7).
  const [targetTouched, setTargetTouched] = useState(false);
  const [ack, setAck] = useState(false);
  const [abuseAck, setAbuseAck] = useState(false);
  const [more, setMore] = useState(false);
  // A check that left the list (closed, paid) falls back to a new check.
  useEffect(() => {
    if (!targetTouched && !forceNew) {
      setTarget(open.length === 1 ? open[0].id : "new");
      return;
    }
    if (target !== "new" && !open.some((c) => c.id === target))
      setTarget("new");
  }, [hold.openChecks]);
  useEffect(() => {
    if (forceNew) setTarget("new");
  }, [forceNew]);
  const unavailable = new Set(
    hold.lines.filter((l) => l.issue === "unavailable").map((l) => l.id),
  );
  const isOut = (id: string) => excluded.has(id) || unavailable.has(id);
  const included = hold.lines.filter((l) => !isOut(l.id));
  const quoted = included.reduce((n, l) => n + l.total, 0);
  const current = included.every((l) => l.currentTotal !== null)
    ? included.reduce((n, l) => n + (l.currentTotal ?? 0), 0)
    : null;
  const priceChanged = current !== null && current !== quoted;
  // MONEY-1: an acknowledgement covers exactly the total it was given for; a
  // new price (a poll, an exclusion) needs a new one.
  useEffect(() => setAck(false), [current]);
  const abuse = hold.linkRevoked === "abuse";
  // A kiosk hold the guest has not sent to the counter is pay-first (KIOSK-UX-04, KIOSK-MONEY-3).
  const kioskState = kioskInboxState(hold.kiosk);
  const actions = inboxActions(hold, session.role, current);
  // Paying always opens a new check: the target only matters for accepting.
  const choosesTarget =
    hold.kind === "table" && (actions.accept || actions.override);
  const ready =
    online &&
    !busy &&
    included.length > 0 &&
    current !== null &&
    (!priceChanged || ack) &&
    (!abuse || abuseAck);
  const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
  const body = (forceNewCheck = false): AcceptBody => {
    const check = open.find((c) => c.id === target);
    return {
      target:
        check && !forceNewCheck
          ? {
              kind: "append",
              orderId: check.id,
              expectedVersion: check.version,
            }
          : { kind: "new" },
      excludeLineIds: hold.lines.filter((l) => isOut(l.id)).map((l) => l.id),
      acknowledgedTotal: current,
      abuseAcknowledged: abuse && abuseAck,
    };
  };
  const place =
    hold.kind === "table"
      ? (hold.tableName ?? "")
      : hold.kind === "kiosk"
        ? [
            t("publicKioskNamed", { name: hold.linkLabel }),
            t("publicTakeaway"),
          ].join(" · ")
        : [t("publicTakeaway"), hold.linkLabel].filter(Boolean).join(" · ");
  return (
    <article className="hold-card" aria-label={`${hold.label} · ${place}`}>
      <header className="hold-head">
        <h3>
          <strong>{hold.label}</strong> · {place}
        </h3>
        <p className="muted tiny">
          {minutes(nowMs - Date.parse(hold.createdAt)) === 0
            ? t("publicHoldAgeNow")
            : t("publicHoldAge", {
                n: minutes(nowMs - Date.parse(hold.createdAt)),
              })}
          {" · "}
          {t("publicHoldExpiresIn", {
            n: minutes(Date.parse(hold.expiresAt) - nowMs),
          })}
        </p>
        {hold.policy === "pay_first" && (
          <Badge tone="amber">{t("publicHoldPayFirst")}</Badge>
        )}
      </header>
      {abuse && (
        <div className="hold-abuse">
          <p>{t("publicHoldLinkAbuse")}</p>
          <label className="option">
            <input
              type="checkbox"
              checked={abuseAck}
              disabled={busy}
              onChange={(e) => setAbuseAck(e.target.checked)}
            />
            <span>{t("publicAbuseAck")}</span>
          </label>
        </div>
      )}
      {hold.name && <p className="hold-name">{hold.name}</p>}
      {hold.note && (
        <p
          className={
            "hold-note" + (ALLERGY_PATTERN.test(hold.note) ? " allergy" : "")
          }
        >
          {hold.note}
        </p>
      )}
      <ul className="hold-lines">
        {hold.lines.map((l) => {
          const name = l.name[locale];
          return (
            <li key={l.id} className={isOut(l.id) ? "out" : ""}>
              <label className="option">
                <input
                  type="checkbox"
                  aria-label={t("publicIncludeLine", { name })}
                  checked={!isOut(l.id)}
                  disabled={busy || unavailable.has(l.id)}
                  onChange={(e) =>
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.delete(l.id);
                      else next.add(l.id);
                      return next;
                    })
                  }
                />
                <span className="hold-line-name">
                  {l.quantity} × {name}
                  {l.optionNames.length > 0 && (
                    <small className="muted">
                      {" "}
                      {l.optionNames.map((o) => o[locale]).join(" · ")}
                    </small>
                  )}
                </span>
              </label>
              <span className="hold-line-total">{money(l.total)}</span>
              {l.issue === "unavailable" && (
                <span className="hold-issue">{t("publicLineUnavailable")}</span>
              )}
              {l.issue === "price_changed" && l.currentTotal !== null && (
                <span className="hold-issue">
                  {t("publicLinePrice", { amount: money(l.currentTotal) })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="hold-total">
        <span>{t("publicGuestTotal")}</span>
        <strong>{money(quoted)}</strong>
      </p>
      {priceChanged && (
        <>
          <p className="hold-total">
            <span>{t("publicCurrentTotal")}</span>
            <strong>{money(current)}</strong>
          </p>
          <label className="option">
            <input
              type="checkbox"
              checked={ack}
              disabled={busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>{t("publicPriceAck")}</span>
          </label>
        </>
      )}
      {choosesTarget && (
        <label className="field">
          <span>{t("publicTarget")}</span>
          <select
            value={target}
            disabled={busy}
            onChange={(e) => {
              setTargetTouched(true);
              setTarget(e.target.value);
            }}
          >
            {open.map((c) => (
              <option key={c.id} value={c.id}>
                {t("publicTargetAppend", {
                  number: orderNumberText(c, today, locale),
                  table: hold.tableName ?? "",
                  waiter: c.waiterName,
                })}
              </option>
            ))}
            <option value="new">{t("publicTargetNew")}</option>
          </select>
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {(kioskState === "at_kiosk" ||
        kioskState === "card_unpaid" ||
        kioskState === "claimed") && (
        <p className="hold-kiosk" role="status">
          {t(
            kioskState === "at_kiosk"
              ? "kioskAtKiosk"
              : kioskState === "claimed"
                ? "kioskClaimed"
                : "kioskCardUnpaid",
          )}
        </p>
      )}
      {kioskState === "charging" || kioskState === "review" ? (
        <KioskHoldBlock
          hold={hold}
          session={session}
          locale={locale}
          online={online}
          onChanged={() => onKioskChanged?.()}
          // The resolve dialog shows this total; accepting there acknowledges it (MONEY-1), and
          // the guest already paid, so a code deactivated as abuse since still gets its order.
          total={current}
          onAccept={
            onKioskAccept &&
            ((charge, rest) =>
              onKioskAccept(
                { ...body(true), abuseAcknowledged: abuse },
                charge,
                rest,
              ))
          }
          onReject={onKioskReject}
        />
      ) : (
        <div className="row wrap hold-actions">
          {actions.accept && (
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() => onAccept(body())}
            >
              {included.length < hold.lines.length
                ? t("publicAcceptPartial", {
                    n: included.length,
                    total: hold.lines.length,
                  })
                : t("publicAccept")}
            </Button>
          )}
          {actions.payAndSend && (
            <Button
              variant={actions.accept ? "secondary" : "primary"}
              disabled={!ready}
              onClick={() => onPay(body(true), current ?? quoted)}
            >
              {t("publicPayAndSend")}
            </Button>
          )}
          <Button
            variant="danger"
            disabled={!online || busy}
            onClick={onReject}
          >
            {t("publicReject")}
          </Button>
          {actions.override && (
            <Button
              variant="ghost"
              aria-expanded={more}
              onClick={() => setMore(!more)}
            >
              {t("publicMoreActions", { label: hold.label })}
            </Button>
          )}
        </div>
      )}
      {actions.override && more && (
        <div className="hold-more">
          <Button disabled={!ready} onClick={() => onAccept(body())}>
            {t("publicAcceptOverride")}
          </Button>
        </div>
      )}
    </article>
  );
}

/**
 * Kiosk (039, §2.5, §2.7; critic R12/R13): while the guest pays at the kiosk the card has no
 * accept or reject ("Pagando en el kiosco…"; a manager may cancel the charge). A charge approved
 * without an order is a red card: "Resolver cobro del kiosco" opens payments' resolve dialog. Any
 * operator retries once the order fits again; a manager accepts the hold as the card includes it
 * now with the charge as its payment (a total above the charge collects the rest; one below it is
 * refused, no partial refunds), or rejects it and records the full refund at the provider.
 */
function KioskHoldBlock({
  hold,
  session,
  locale,
  online,
  onChanged,
  total,
  onAccept,
  onReject,
}: {
  hold: InboxHold;
  session: Session;
  locale: Locale;
  online: boolean;
  onChanged: () => void;
  total: number | null;
  onAccept?: (charge: KioskCharge, rest: number) => Promise<void>;
  onReject?: (charge: KioskCharge, reason: RejectReason) => Promise<void>;
}) {
  const t = strings[locale];
  const money = moneyFormatter(session.restaurant.currency, locale);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const k = hold.kiosk!;
  const manager = MANAGERS.includes(session.role);
  async function open() {
    setBusy(true);
    setError("");
    try {
      setAttempt(
        await api<AttemptView>(`/payments/terminal/charges/${k.attemptId}`),
      );
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await api(`/payments/terminal/charges/${k.attemptId}/cancel`, {
        operationId: crypto.randomUUID(),
      });
      onChanged();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  if (k.review)
    return (
      <div className="hold-kiosk hold-kiosk-review" role="alert">
        <p>
          {fill(t.kioskSettleErrorCard, {
            label: hold.label,
            amount: money(k.review.amount),
            terminal: k.review.terminalLabel,
            reason: translateError(k.review.code, locale),
          })}
        </p>
        <Button
          variant="primary"
          disabled={!online || busy}
          onClick={() => void open()}
        >
          {t.kioskResolve}
        </Button>
        {error && <p className="error">{error}</p>}
        {attempt && (
          <ResolveDialog
            attempt={attempt}
            locale={locale}
            money={money}
            manager={manager}
            kiosk={
              onAccept && onReject
                ? {
                    total,
                    accept: (note, rest) =>
                      onAccept({ attemptId: attempt.id, note }, rest),
                    reject: (note) =>
                      onReject(
                        { attemptId: attempt.id, note },
                        kioskRejectReason(k.review?.code ?? null),
                      ),
                  }
                : undefined
            }
            onClose={() => setAttempt(null)}
            onResolved={() => {
              setAttempt(null);
              onChanged();
            }}
          />
        )}
      </div>
    );
  const exits = kioskChargingExits(k, session.role);
  return (
    <div className="hold-kiosk" role="status">
      <p>{t.kioskCharging}</p>
      {exits.cancel && (
        <Button disabled={!online || busy} onClick={() => void cancel()}>
          {t.kioskCancelCharge}
        </Button>
      )}
      {exits.resolve && (
        <Button disabled={!online || busy} onClick={() => void open()}>
          {t.kioskResolve}
        </Button>
      )}
      {error && <p className="error">{error}</p>}
      {attempt && (
        <ResolveDialog
          attempt={attempt}
          locale={locale}
          money={money}
          manager={manager}
          onClose={() => setAttempt(null)}
          onResolved={() => {
            setAttempt(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
