// The kiosk's checkout (039, §2.3–2.7, LD-72): "¿Para aquí o para llevar?", the order, then the
// payment: card on the terminal next to the kiosk (charging, approved, declined, still on the
// reader, approved without an order) or "Pagar en caja" (the code screen). The kitchen gets the
// order only when the card is approved (or at the counter, when staff accept it).
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Locale } from "../../../../shared/domain";
import type { DinerHoldView } from "../../../../shared/public-ordering";
import {
  KIOSK_IDLE,
  idleDeadline,
  payButtons,
  type KioskCheckoutView,
  type KioskMenuBlock,
} from "../../../../shared/kiosk";
import { strings } from "../../../i18n";
import { ApiError } from "../../../api";
import { Button } from "../../../components/ui";
import { fill, moneyFormatter } from "../../menu/format";
import { guestError } from "../dinerApi";
import { KioskDone } from "../KioskDone";
import { createIdleController } from "../kioskIdle";
import { IdleWarning } from "../IdleWarning";
import { kioskApi, type KioskOrderBody } from "./kioskApi";

export type KioskStep =
  | "fulfillment"
  | "submitting"
  | "pay"
  | "charging"
  | "declined"
  | "unavailable"
  | "still"
  | "askCounter"
  | "paid"
  | "paidNoOrder"
  | "counter";

/**
 * The next screen for a checkout read while charging (pure; tests/kiosk.test.ts). An attempt that
 * ended without money, on either terminal screen, offers retry, «Pagar en caja» or cancel again
 * (KIOSK-UX-03): nothing can still be taken, and a walk-away from there cancels the hold.
 */
export function stepFor(
  view: KioskCheckoutView,
  _current: KioskStep,
): KioskStep | null {
  if (view.paid) return "paid";
  if (view.paidNoOrder) return "paidNoOrder";
  const s = view.payment.state;
  if (s === "declined" || s === "cancelled" || s === "expired")
    return "declined";
  return null;
}

/**
 * The exits of the terminal screens (KIOSK-UX-03; pure, tests/kiosk.test.ts), following payments'
 * cancel rules: «Cancelar cobro» on «Sigue las instrucciones en la terminal» after
 * KIOSK_IDLE.cancelOfferMs, only while the attempt is live and no cancel was requested (payments
 * withdraws it only when the provider confirms: Clip's withdraw, MP's cancel). «Pedir ayuda en
 * caja» once a cancel was requested and the reader may still take the card. It leads to «Pregunta
 * en caja por tu pedido K-14» and never cancels the hold: the inbox keeps a hold with a live
 * attempt past its expiry, and a late approval still becomes the order (critic R12).
 */
export function terminalExits(
  step: KioskStep,
  view: KioskCheckoutView | null,
  cancelOffered: boolean,
): { cancel: boolean; help: boolean } {
  if (step === "still") return { cancel: false, help: true };
  if (step !== "charging" || view?.payment.state !== "pending")
    return { cancel: false, help: false };
  const requested = view.payment.cancelRequested;
  return { cancel: cancelOffered && !requested, help: requested };
}

/** The screen after the kiosk asked payments to cancel (pure): null keeps polling. */
export function afterCancel(
  outcome: "withdrawn" | "in_progress" | "already_final" | "pending_cancel",
): KioskStep | null {
  if (outcome === "withdrawn") return "declined";
  // Approved, declined or settled meanwhile: the next sync shows it.
  if (outcome === "already_final") return null;
  // The reader holds it (cancel there) or the worker is still asking the provider.
  return "still";
}

/**
 * Whether the kiosk cancels the hold when it resets from this screen (KIOSK-MONEY-3, KIOSK-UX-04;
 * pure, tests/kiosk.test.ts): from the pay, declined or unavailable screens, a hold that is still
 * pending and unpaid with no attempt live or approved (the guest walked away from the card
 * checkout). Never once the guest chose «Pagar en caja» (the counter's hold now), and never
 * while payments may still take or has taken the card (the server refuses those too).
 */
export function cancelsOnReset(
  step: KioskStep,
  view: KioskCheckoutView | null,
): boolean {
  if (step !== "pay" && step !== "declined" && step !== "unavailable")
    return false;
  if (!view || view.holdState !== "pending") return false;
  if (view.paid || view.paidNoOrder || view.paymentChoice === "counter")
    return false;
  return ["none", "declined", "cancelled", "expired"].includes(
    view.payment.state,
  );
}

/**
 * The idle timers of a checkout screen (§2.12; pure, tests/kiosk.test.ts). «¿Para aquí o para
 * llevar?», pay, declined and unavailable ask «¿Sigues ahí?» 25 s before their 120 s reset
 * (KIOSK-UX-05, WCAG 2.2.1), like the menu with a cart; the done screens reset without asking;
 * charging, «La terminal sigue procesando» and the counter code have their own clocks.
 */
export function checkoutIdle(step: KioskStep): {
  warnAt: number | null;
  resetAt: number | null;
} {
  if (
    step === "pay" ||
    step === "fulfillment" ||
    step === "declined" ||
    step === "unavailable"
  )
    return idleDeadline("pay", { cartEmpty: false });
  if (step === "paid") return idleDeadline("done_paid", { cartEmpty: true });
  if (step === "paidNoOrder" || step === "askCounter")
    return idleDeadline("done_counter", { cartEmpty: true });
  return { warnAt: null, resetAt: null };
}

/**
 * Whether «Soy del club» is offered (KIOSK-UX-02; pure, tests/kiosk.test.ts). The member token
 * travels only in the body of the one submit (critic R20: one kiosk member route, no attach to a
 * placed hold), so the button shows on the menu and on «¿Para aquí o para llevar?», never once
 * the hold is placed: a lookup there would succeed and never reach the order.
 */
export function memberLookupOpen(
  view: "menu" | "status" | "kiosk-done" | "checkout",
  step: KioskStep | null,
): boolean {
  if (view === "menu") return true;
  return view === "checkout" && step === "fulfillment";
}

type Props = {
  token: string;
  locale: Locale;
  currency: string;
  kiosk: KioskMenuBlock;
  body: Omit<KioskOrderBody, "operationId" | "statusKey" | "fulfillment">;
  onDone: () => void;
  onBack: () => void;
  /** A domain refusal of the order (price changed, unavailable, closed): back to the cart. */
  onRefused: (message: string, code: string) => void;
  announce: (text: string) => void;
  /** The current screen, for the header's «Soy del club» (memberLookupOpen). */
  onStep?: (step: KioskStep) => void;
};

export function KioskCheckout(p: Props) {
  const t = strings[p.locale];
  const money = moneyFormatter(p.locale, p.currency);
  const [step, setStep] = useState<KioskStep>(
    p.kiosk.askFulfillment ? "fulfillment" : "submitting",
  );
  const [hold, setHold] = useState<DinerHoldView | null>(null);
  const [view, setView] = useState<KioskCheckoutView | null>(null);
  const [counterOnly, setCounterOnly] = useState(false);
  const [member, setMember] = useState(false);
  const [failedOnce, setFailedOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  // KIOSK-UX-03: «Cancelar cobro» shows after a while; the reader refused the cancel.
  const [cancelOffered, setCancelOffered] = useState(false);
  const [onTerminal, setOnTerminal] = useState(false);
  const [idleWarn, setIdleWarn] = useState(false);
  const keys = useRef({ operationId: crypto.randomUUID(), statusKey: "" });
  const fulfillment = useRef<"here" | "to_go">("to_go");
  const chargeOp = useRef<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const onStep = p.onStep;
  useEffect(() => onStep?.(step), [step, onStep]);
  const say = (text: string) => p.announce(text);
  const label = view?.label ?? hold?.label ?? "";
  // The latest checkout read, for the idle reset (its effect runs per screen, not per poll).
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  }, [view]);

  async function submit(f: "here" | "to_go") {
    fulfillment.current = f;
    setStep("submitting");
    setBusy(true);
    setError("");
    keys.current.statusKey ||= newKey();
    try {
      const r = await kioskApi.submit(p.token, {
        ...p.body,
        ...keys.current,
        fulfillment: f,
      });
      setHold(r.hold);
      setView(r.checkout);
      setMember(r.member);
      if (r.checkout.holdState === "accepted") {
        setStep("paid");
        say(fill(t.kioskPaid, { label: r.checkout.label }));
      } else if (r.counterOnly || !p.kiosk.card) {
        setCounterOnly(true);
        // The server marks a counter-only hold «Pagar en caja» itself; a kiosk whose state said
        // no card while the server could take one says so, so the inbox shows a normal card.
        if (!r.counterOnly && r.checkout.paymentChoice !== "counter")
          void kioskApi
            .counter(p.token, keys.current.statusKey)
            .catch(() => {});
        toCounterScreen(r.hold);
      } else setStep("pay");
    } catch (e) {
      const code = (e as Error).message;
      if (e instanceof ApiError && e.transient) {
        // The order may have arrived: the same keys are sent again on retry.
        setError(guestError(code, p.locale));
        setStep(p.kiosk.askFulfillment ? "fulfillment" : "submitting");
      } else p.onRefused(guestError(code, p.locale), code);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (step === "submitting" && !hold && !busy && !error) void submit("to_go");
  }, []);

  function toCounterScreen(h: DinerHoldView) {
    say(
      fill(strings[p.locale].publicKioskSentAnnounce, {
        label: h.label,
        instructions:
          h.policy === "pay_first"
            ? strings[p.locale].publicKioskPayAtCounter
            : strings[p.locale].publicKioskGoToCounter,
      }),
    );
    setStep("counter");
  }

  async function chooseCounter() {
    setBusy(true);
    try {
      await kioskApi.counter(p.token, keys.current.statusKey);
      toCounterScreen(hold!);
    } catch (e) {
      setError(guestError((e as Error).message, p.locale));
    } finally {
      setBusy(false);
    }
  }
  async function cancelOrder() {
    setBusy(true);
    try {
      await kioskApi.cancel(p.token, keys.current.statusKey);
    } catch {
      // Nothing to undo: the hold expires on its own.
    } finally {
      setBusy(false);
      p.onDone();
    }
  }

  function cancelOutcome(outcome: Parameters<typeof afterCancel>[0]) {
    const next = afterCancel(outcome);
    if (outcome === "in_progress") setOnTerminal(true);
    if (next === "declined") setFailedOnce(true);
    if (next) setStep(next);
  }
  async function cancelCharge() {
    setBusy(true);
    setError("");
    try {
      const c = await kioskApi.cancelCharge(p.token, keys.current.statusKey);
      setView(c.checkout);
      cancelOutcome(c.outcome);
    } catch (e) {
      setError(guestError((e as Error).message, p.locale));
    } finally {
      setBusy(false);
    }
  }

  async function payByCard() {
    setBusy(true);
    setError("");
    chargeOp.current = crypto.randomUUID();
    setCancelOffered(false);
    setOnTerminal(false);
    try {
      const v = await kioskApi.charge(
        p.token,
        keys.current.statusKey,
        chargeOp.current,
      );
      setView(v);
      setStep("charging");
      say(
        fill(t.kioskFollowTerminal, {
          amount: money(v.payment.amount ?? v.total),
        }),
      );
    } catch (e) {
      const code = (e as Error).message;
      if (code === "kiosk_charge_pending") setStep("charging");
      else if (code === "public_price_changed" || code === "unavailable") {
        await kioskApi.cancel(p.token, keys.current.statusKey).catch(() => {});
        p.onRefused(t.kioskPriceChanged, code);
      } else {
        setFailedOnce(true);
        setError(
          code === "kiosk_terminal_busy"
            ? t.kioskTerminalBusy
            : code === "kiosk_charge_attempts"
              ? guestError(code, p.locale)
              : t.kioskTerminalUnavailable,
        );
        setStep("unavailable");
      }
    } finally {
      setBusy(false);
    }
  }

  // Charging: sync every 2 s (each sync lets payments settle an approved charge); after 3 minutes
  // ask payments to cancel; a charge the reader still holds gets 2 more minutes, then the guest is
  // sent to the counter (the charge still settles server-side if it is paid later).
  useEffect(() => {
    if (step !== "charging" && step !== "still") return;
    const started = Date.now();
    let failures = 0;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const v = await kioskApi.sync(p.token, keys.current.statusKey);
        if (!live.current) return;
        failures = 0;
        setOffline(false);
        setView(v);
        const next = stepFor(v, step);
        if (next) {
          if (next === "declined") {
            setFailedOnce(true);
            say(t.kioskDeclined);
          }
          if (next === "paid") say(fill(t.kioskPaid, { label: v.label }));
          setStep(next);
          return;
        }
        const waited = Date.now() - started;
        if (
          step === "charging" &&
          waited >= KIOSK_IDLE.chargeTimeoutMs &&
          !cancelled
        ) {
          cancelled = true;
          const c = await kioskApi
            .cancelCharge(p.token, keys.current.statusKey)
            .catch(() => null);
          if (c) cancelOutcome(c.outcome);
          else setStep("still");
        }
        if (step === "still" && waited >= KIOSK_IDLE.inProgressExtraMs)
          setStep("askCounter");
      } catch {
        failures += 1;
        if (failures >= 2) setOffline(true);
      }
    }, KIOSK_IDLE.pollMs);
    return () => clearInterval(timer);
  }, [step]);

  // «Cancelar cobro» after a while on the charging screen (KIOSK-UX-03).
  useEffect(() => {
    if (step !== "charging") return;
    const offer = setTimeout(
      () => setCancelOffered(true),
      KIOSK_IDLE.cancelOfferMs,
    );
    return () => clearTimeout(offer);
  }, [step]);

  // Screens that end on their own; the checkout screens ask «¿Sigues ahí?» first (KIOSK-UX-05).
  useEffect(() => {
    const { warnAt, resetAt } = checkoutIdle(step);
    if (resetAt === null) return;
    // The guest walked away from the card checkout: the hold is cancelled, so staff never see an
    // unpaid order to send to the kitchen (KIOSK-MONEY-3). Best effort: one that stays expires.
    const onReset = () => {
      if (cancelsOnReset(step, latest.current))
        void kioskApi.cancel(p.token, keys.current.statusKey).catch(() => {});
      p.onDone();
    };
    const c = createIdleController({
      warnAfterMs: warnAt,
      resetAfterMs: resetAt,
      onWarn: () => setIdleWarn(true),
      onReset,
    });
    const activity = () => c.activity();
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    return () => {
      c.dispose();
      setIdleWarn(false);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, [step]);

  const exits = terminalExits(step, view, cancelOffered);
  const helpButton = exits.help && (
    <Button
      className="kiosk-choice"
      disabled={busy}
      onClick={() => setStep("askCounter")}
    >
      {t.kioskAskHelp}
    </Button>
  );
  const buttons = payButtons({
    selfCheckout: p.kiosk.selfCheckout,
    card: p.kiosk.card && !counterOnly,
    paymentMode: p.kiosk.paymentMode,
    attempts: view?.payment.attempts ?? 0,
    failedOnce,
  });
  const total = money(view?.total ?? p.body.expectedTotal);

  if (step === "counter" && hold)
    return (
      <KioskDone
        hold={hold}
        locale={p.locale}
        currency={p.currency}
        member={member}
        onReset={p.onDone}
      />
    );
  return (
    <section className="kiosk-checkout" aria-live="off">
      {offline && (step === "charging" || step === "still") && (
        <p className="kiosk-banner" role="alert">
          {fill(t.kioskOfflineCharging, { label })}
        </p>
      )}
      {error && step !== "unavailable" && (
        <p className="kiosk-banner" role="alert">
          {error}
        </p>
      )}
      {step === "fulfillment" && (
        <>
          <h2 className="kiosk-title">{t.kioskFulfillmentTitle}</h2>
          <div className="kiosk-choices">
            <Button
              variant="primary"
              className="kiosk-choice"
              disabled={busy}
              onClick={() => void submit("here")}
            >
              {t.kioskForHere}
            </Button>
            <Button
              variant="primary"
              className="kiosk-choice"
              disabled={busy}
              onClick={() => void submit("to_go")}
            >
              {t.kioskToGo}
            </Button>
          </div>
          <Button className="kiosk-back" disabled={busy} onClick={p.onBack}>
            {t.kioskBack}
          </Button>
        </>
      )}
      {step === "submitting" && (
        <p role="status" className="kiosk-title">
          {t.loading}
        </p>
      )}
      {(step === "pay" || step === "declined" || step === "unavailable") && (
        <>
          <h2 className="kiosk-title">
            {step === "declined"
              ? view?.payment.state === "cancelled"
                ? t.kioskChargeCancelled
                : t.kioskDeclined
              : step === "unavailable"
                ? error || t.kioskTerminalUnavailable
                : t.kioskPayTitle}
          </h2>
          <p className="kiosk-total">
            {label} · {fill(t.kioskTotal, { amount: total })}
          </p>
          <div className="kiosk-choices">
            {buttons.card &&
              (step !== "unavailable" || error === t.kioskTerminalBusy) && (
                <Button
                  variant="primary"
                  className="kiosk-choice"
                  disabled={busy}
                  onClick={() => void payByCard()}
                >
                  {step === "pay" ? t.kioskPayCard : t.kioskTryAgain}
                </Button>
              )}
            {(buttons.counter || step !== "pay") && (
              <Button
                className="kiosk-choice"
                disabled={busy}
                onClick={() => void chooseCounter()}
              >
                {t.kioskPayCounter}
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            className="kiosk-back"
            disabled={busy}
            onClick={() => void cancelOrder()}
          >
            {t.kioskCancelOrder}
          </Button>
        </>
      )}
      {step === "charging" && (
        <>
          <div className="kiosk-charging" role="status">
            <h2 className="kiosk-title">
              {fill(t.kioskFollowTerminal, {
                amount: money(view?.payment.amount ?? view?.total ?? 0),
              })}
            </h2>
            <p className="kiosk-code-small">{label}</p>
          </div>
          {exits.cancel && (
            <Button
              className="kiosk-choice"
              disabled={busy}
              onClick={() => void cancelCharge()}
            >
              {t.kioskCancelCharge}
            </Button>
          )}
          {helpButton}
        </>
      )}
      {step === "still" && (
        <>
          <h2 className="kiosk-title" role="status">
            {fill(t.kioskTerminalStill, { label })}
          </h2>
          {onTerminal && (
            <p className="kiosk-total">{t.kioskCancelOnTerminal}</p>
          )}
          {helpButton}
        </>
      )}
      {step === "askCounter" && (
        <>
          <h2 className="kiosk-title">{fill(t.kioskAskCounter, { label })}</h2>
          <Button variant="primary" className="kiosk-new" onClick={p.onDone}>
            {t.kioskNewOrder}
          </Button>
        </>
      )}
      {step === "paidNoOrder" && (
        <>
          <h2 className="kiosk-code">{label}</h2>
          <p className="kiosk-instructions">
            {fill(t.kioskPaidNoOrder, { label })}
          </p>
          <Button variant="primary" className="kiosk-new" onClick={p.onDone}>
            {t.kioskNewOrder}
          </Button>
        </>
      )}
      {step === "paid" && view && (
        <KioskPaid view={view} locale={p.locale} onDone={p.onDone} />
      )}
      {idleWarn && (
        <IdleWarning
          locale={p.locale}
          seconds={
            (KIOSK_IDLE.payResetMs - KIOSK_IDLE.payWarnAfterMs) / 1000
          }
          onContinue={() => setIdleWarn(false)}
        />
      )}
    </section>
  );
}

/**
 * "¡Pagado!": the order number, the folio and self-invoice QR, and the club. The code and folio,
 * the QRs side by side, then «Nuevo pedido»; in landscape with a QR, two columns (code on the
 * left, QRs and «Nuevo pedido» on the right), so it fits 1280×800 and 800×1280 with «Texto
 * grande» on (KIOSK-UX-08).
 */
function KioskPaid({
  view,
  locale,
  onDone,
}: {
  view: KioskCheckoutView;
  locale: Locale;
  onDone: () => void;
}) {
  const t = strings[locale];
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const invoice = view.selfInvoiceCode;
  const join = !view.loyalty && view.joinOffer ? view.joinOffer : null;
  return (
    <div className={"kiosk-paid" + (invoice || join ? " kiosk-paid-qr" : "")}>
      <div className="kiosk-paid-main">
        <h2 className="kiosk-title">
          {fill(t.kioskPaid, { label: view.label })}
        </h2>
        <p className="kiosk-code">{view.label}</p>
        {view.folio && <p>{fill(t.kioskFolio, { folio: view.folio })}</p>}
        {view.loyalty?.member && (
          <p className="kiosk-club">
            {fill(t.kioskStampEarned, {
              earned: view.loyalty.stampsEarned,
              n: view.loyalty.stamps,
              required: view.loyalty.required,
            })}
            {view.loyalty.rewards > 0 && <span> {t.kioskReward}</span>}
          </p>
        )}
      </div>
      {(invoice || join) && (
        <div className="kiosk-paid-qrs">
          {invoice && (
            <figure className="kiosk-qr">
              <QRCodeSVG
                value={`${origin}/f/${invoice}`}
                size={160}
                role="img"
                aria-label={fill(t.kioskInvoiceQr, { folio: view.folio ?? "" })}
              />
              <figcaption>
                {fill(t.kioskInvoiceQr, { folio: view.folio ?? "" })}
              </figcaption>
            </figure>
          )}
          {join && (
            <figure className="kiosk-qr">
              <QRCodeSVG
                value={join.url}
                size={160}
                role="img"
                aria-label={t.kioskJoinPitch}
              />
              <figcaption>{t.kioskJoinPitch}</figcaption>
            </figure>
          )}
        </div>
      )}
      <div className="kiosk-paid-end">
        <p className="muted">{t.kioskPrintedTicket}</p>
        <Button variant="primary" className="kiosk-new" onClick={onDone}>
          {t.kioskNewOrder}
        </Button>
      </div>
    </div>
  );
}

/** 16 random bytes, base64url: the hold's status key. */
function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
