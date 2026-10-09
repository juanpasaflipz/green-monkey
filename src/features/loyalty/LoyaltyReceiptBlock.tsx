/**
 * The club block printed on a receipt (038 §2.7), after the footer (Receipt.tsx setReceiptExtra).
 * A linked order prints its member's counts (no name, no phone: receipts are left on tables); an
 * unlinked one within its window prints the join QR to {origin}/club#<token>. Never on a pre-bill
 * or an offline receipt (the token is minted by the server). Printed text is Spanish (fiscal D10).
 * Pure render from the per-order cache that Vender, Detalle and Mesas fill before printing.
 */
import { QRCodeSVG } from "qrcode.react";
import type { ReceiptSlot } from "../Receipt";
import type { ReceiptLoyaltyView } from "../../../shared/loyalty";
import { useLoyaltyReceipt } from "./loyaltyApi";
import "./loyalty.css";

/** Printed strings: Spanish constants (fiscal D10). */
export const RECEIPT_TEXT = {
  join: (program: string) =>
    `Únete a ${program}: escanea y suma tus sellos de esta compra.`,
  rule: (n: number, reward: string) => `Con ${n} sellos: ${reward}.`,
  progress: (program: string, x: number, n: number) => `${program}: ${x} de ${n} sellos`,
  rewards: (n: number, reward: string) =>
    n === 1
      ? `1 premio disponible: ${reward}`
      : `${n} premios disponibles: ${reward}`,
};

export function LoyaltyReceiptBlock({
  view,
  origin,
}: {
  view: ReceiptLoyaltyView | null;
  origin: string;
}) {
  if (!view || view.kind === "none") return null;
  if (view.kind === "member")
    return (
      <div className="loyalty-receipt-block" lang="es">
        <p>
          <strong>{RECEIPT_TEXT.progress(view.programName, view.stamps, view.required)}</strong>
        </p>
        {view.rewards > 0 && <p>{RECEIPT_TEXT.rewards(view.rewards, view.rewardDescription)}</p>}
      </div>
    );
  return (
    <div className="loyalty-receipt-block" lang="es">
      <QRCodeSVG
        value={`${origin}/club#${view.token}`}
        size={112}
        level="M"
        marginSize={2}
        title={RECEIPT_TEXT.join(view.programName)}
        role="img"
      />
      <div>
        <p>
          <strong>{RECEIPT_TEXT.join(view.programName)}</strong>
        </p>
        <p>{RECEIPT_TEXT.rule(view.stampsRequired, view.rewardDescription)}</p>
      </div>
    </div>
  );
}

function CachedBlock({ orderId }: { orderId: string }) {
  const view = useLoyaltyReceipt(orderId);
  return <LoyaltyReceiptBlock view={view} origin={location.origin} />;
}

/** The receipt slot: receipts only (never a pre-bill "cuenta" or an offline receipt). */
export const loyaltyReceiptExtra: ReceiptSlot = (p) =>
  p.kind === "receipt" && p.order.version ? <CachedBlock orderId={p.order.id} /> : null;
