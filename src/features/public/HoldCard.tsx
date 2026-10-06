import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { ALLERGY_PATTERN } from "../../../shared/service";
import { holdActions, type InboxHold } from "../../../shared/public-ordering";
import { strings, type Key } from "../../i18n";
import { Badge, Button } from "../../components/ui";
import { moneyFormatter } from "../Receipt";
import { fill } from "../menu/format";

export type AcceptBody = {
  target:
    | { kind: "new" }
    | { kind: "append"; orderId: string; expectedVersion: number };
  excludeLineIds: string[];
  priceChangeAcknowledged: boolean;
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
}) {
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const money = moneyFormatter(session.restaurant.currency, locale);
  const open = hold.openChecks.filter((c) => c.checkState === "open");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>(() =>
    open.length === 1 ? open[0].id : "new",
  );
  const [ack, setAck] = useState(false);
  const [more, setMore] = useState(false);
  // A check that left the list (closed, paid) falls back to a new check.
  useEffect(() => {
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
  const actions = holdActions(hold.policy, session.role, current);
  // Paying always opens a new check: the target only matters for accepting.
  const choosesTarget =
    hold.kind === "table" && (actions.accept || actions.override);
  const ready =
    online &&
    !busy &&
    included.length > 0 &&
    current !== null &&
    (!priceChanged || ack);
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
      priceChangeAcknowledged: priceChanged && ack,
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
          {t("publicHoldAge", {
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
            onChange={(e) => setTarget(e.target.value)}
          >
            {open.map((c) => (
              <option key={c.id} value={c.id}>
                {t("publicTargetAppend", {
                  number: c.number,
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
        <Button variant="danger" disabled={!online || busy} onClick={onReject}>
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
