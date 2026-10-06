import { useState, type ReactNode } from "react";
import {
  currencyExponent,
  type Locale,
  type Session,
} from "../../../shared/domain";
import { parseMoneyInput } from "../../../shared/service";
import { api } from "../../api";
import { Button, Field, Modal } from "../../components/ui";
import { strings, translateError, type Key } from "../../i18n";
import { fill } from "../discounts/format";
import { DrawerReviewDialog } from "./DrawerReviewDialog";
import "./cash.css";

/** The drawer as GET /cash returns it (server/cash.ts CashView). */
export type DrawerView = {
  id: string;
  opened_at: string;
  closed_at: string | null;
  opening: number;
  visibility: "full" | "blind";
  canClose: boolean;
  blindClose: boolean;
  openedByName: string;
  closedByName: string | null;
  countMode: "blind" | "visible" | null;
  external: {
    sales: number;
    tips: number;
    refunds: number;
    net: number;
    count: number;
    reported: number | null;
    difference: number | null;
    late: number;
  };
  paymentCount: number;
  expected: number | null;
  closedExpected: number | null;
  counted: number | null;
  discrepancy: number | null;
  cash: {
    sales: number;
    tips: number;
    refunds: number;
    movements: number;
    expected: number;
  } | null;
  tenders: any[];
  refunds: any[];
  movements: any[];
  review: { note: string; reviewerName: string; at: string } | null;
};

/**
 * Drawer close (§2.7): count → confirm → result, one operation id per dialog.
 * In blind mode (the default) expected cash is never shown before the count
 * is saved and no explanation is required; a role that may see expected cash
 * sees the difference afterwards, others only "Corte registrado". The
 * pending-local-sales guard (offline) runs before the request.
 */
export function DrawerCloseDialog({
  session,
  locale,
  money,
  drawer,
  notice,
  beforeClose,
  close,
  closed,
}: {
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  drawer: DrawerView;
  notice?: ReactNode;
  beforeClose?: () => Promise<string | null>;
  close: () => void;
  closed: () => void | Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const manager = ["owner", "manager"].includes(session.role);
  const visible = !drawer.blindClose && drawer.visibility === "full";
  const [operationId] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState<"count" | "confirm" | "result">("count");
  const [countedText, setCountedText] = useState("");
  const [terminalText, setTerminalText] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DrawerView | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewed, setReviewed] = useState(false);

  let counted: number | null = null;
  let terminal: number | null = null;
  // UI-12: each money field has its own error, linked to it.
  let countedError = "";
  let terminalError = "";
  try {
    counted = countedText.trim()
      ? parseMoneyInput(countedText, exponent)
      : null;
  } catch {
    countedError = t("discountsCloseCountInvalid");
  }
  try {
    terminal = terminalText.trim()
      ? parseMoneyInput(terminalText, exponent)
      : null;
  } catch {
    terminalError = `${t("discountsCloseTerminal")}: ${translateError("invalid_amount", locale)}`;
  }
  const inputError = countedError || terminalError;
  const visibleDifference =
    visible && counted !== null && drawer.expected !== null
      ? counted - drawer.expected
      : 0;

  async function save() {
    if (counted === null) return;
    setError("");
    const blocked = (await beforeClose?.()) ?? null;
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy(true);
    try {
      const view = await api<DrawerView>("/cash/close", {
        operationId,
        counted,
        reason: reason.trim(),
        ...(terminal !== null ? { externalReported: terminal } : {}),
      });
      setResult(view);
      setStep("result");
    } catch (e) {
      setError(translateError((e as Error).message, locale));
      setStep("count");
    } finally {
      setBusy(false);
    }
  }

  const difference = (n: number) =>
    `${money(n)} · ${t(
      n > 0
        ? "discountsCloseOver"
        : n < 0
          ? "discountsCloseShort"
          : "discountsCloseExact",
    )}`;

  if (step === "result" && result) {
    const full = result.visibility === "full" && result.counted !== null;
    const cashDifference =
      full && result.closedExpected !== null
        ? result.counted! - result.closedExpected
        : 0;
    return (
      <Modal
        title={t("discountsCloseResultTitle")}
        close={() => void closed()}
        closeLabel={t("close")}
      >
        {full ? (
          <dl className="cash-figures">
            <dt>{t("discountsDrawerExpected")}</dt>
            <dd>{money(result.closedExpected ?? 0)}</dd>
            <dt>{t("discountsCloseCountedRow")}</dt>
            <dd>{money(result.counted ?? 0)}</dd>
            <dt>{t("discountsCloseCashDifference")}</dt>
            <dd>{difference(cashDifference)}</dd>
            <dt>{t("discountsCloseTerminalNet")}</dt>
            <dd>{money(result.external.net)}</dd>
            {result.external.reported !== null && (
              <>
                <dt>{t("discountsCloseTerminalReported")}</dt>
                <dd>{money(result.external.reported)}</dd>
                <dt>{t("discountsCloseTerminalDifference")}</dt>
                <dd>{difference(result.external.difference ?? 0)}</dd>
              </>
            )}
          </dl>
        ) : (
          <p role="status">
            <strong>{t("discountsCloseResultTitle")}.</strong>{" "}
            {t("discountsCloseResultBlind")}
          </p>
        )}
        {reviewed && (
          <p className="notice" role="status">
            {t("discountsOpDrawerReviewed")}
          </p>
        )}
        <div className="row wrap">
          {full && cashDifference !== 0 && manager && !reviewed && (
            <Button onClick={() => setReviewing(true)}>
              {t("discountsCloseExplainNow")}
            </Button>
          )}
          <Button variant="primary" onClick={() => void closed()}>
            {t("discountsCloseDone")}
          </Button>
        </div>
        {reviewing && (
          <DrawerReviewDialog
            drawerId={result.id}
            session={session}
            locale={locale}
            money={money}
            figures={{
              expected: result.closedExpected ?? 0,
              counted: result.counted ?? 0,
            }}
            close={() => setReviewing(false)}
            saved={() => {
              setReviewing(false);
              setReviewed(true);
            }}
          />
        )}
      </Modal>
    );
  }

  return (
    <Modal title={t("closeDrawer")} close={close} closeLabel={t("close")}>
      {step === "count" ? (
        <form
          className="cash-close"
          onSubmit={(e) => {
            e.preventDefault();
            if (counted === null || inputError) return;
            if (
              visible &&
              visibleDifference !== 0 &&
              reason.trim().length < 3
            ) {
              setError(translateError("reason_required", locale));
              return;
            }
            setError("");
            setStep("confirm");
          }}
        >
          <h3>{t("discountsCloseCountTitle")}</h3>
          {visible && drawer.expected !== null ? (
            <p>
              {fill(t("discountsCloseVisibleExpected"), {
                amount: money(drawer.expected),
              })}
            </p>
          ) : (
            <p className="muted">{t("discountsCloseBlindHint")}</p>
          )}
          {notice}
          <Field label={t("counted")}>
            <input
              inputMode="decimal"
              required
              value={countedText}
              aria-invalid={!!countedError || undefined}
              aria-describedby={
                countedError ? "close-counted-error" : undefined
              }
              onChange={(e) => setCountedText(e.target.value)}
            />
          </Field>
          <Field label={t("discountsCloseTerminal")}>
            <input
              inputMode="decimal"
              value={terminalText}
              aria-invalid={!!terminalError || undefined}
              aria-describedby={
                terminalError ? "close-terminal-error" : undefined
              }
              onChange={(e) => setTerminalText(e.target.value)}
            />
          </Field>
          <Field label={visible ? t("reason") : t("discountsCloseComment")}>
            <textarea
              value={reason}
              maxLength={300}
              required={visible && visibleDifference !== 0}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {countedError && (
            <p className="error" role="alert" id="close-counted-error">
              {countedError}
            </p>
          )}
          {terminalError && (
            <p className="error" role="alert" id="close-terminal-error">
              {terminalError}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row wrap">
            <Button onClick={close}>{t("discountsCancel")}</Button>
            <Button
              variant="primary"
              type="submit"
              disabled={counted === null || !!inputError}
            >
              {t("discountsCloseContinue")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="cash-close">
          <p>
            {fill(t("discountsCloseConfirm"), { amount: money(counted ?? 0) })}
          </p>
          {notice}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row wrap">
            <Button disabled={busy} onClick={() => setStep("count")}>
              {t("discountsCloseBack")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {t("discountsCloseSubmit")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
