import { QRCodeSVG } from "qrcode.react";
import { strings } from "../../i18n";
import { fill } from "../menu/format";

/**
 * A printable ordering card: restaurant, place, the QR code (level M with the
 * 4-module quiet zone) and the two lines a guest needs. Printed copy is always
 * Spanish (customer-facing document), whatever the staff screen's language.
 */
export function QrCard({
  restaurant,
  place,
  url,
  kind,
}: {
  restaurant: string;
  /** "Mesa 4", or the counter/kiosk label. */
  place: string;
  url: string;
  kind: "table" | "counter" | "kiosk";
}) {
  const es = strings.es;
  return (
    <div className="qr-card">
      <p className="qr-card-restaurant">{restaurant}</p>
      <p className="qr-card-place">
        {kind === "table" ? place : es.publicCardTakeaway}
      </p>
      <QRCodeSVG
        className="qr-card-code"
        value={url}
        size={256}
        level="M"
        marginSize={4}
        title={fill(es.publicQrTitle, { place })}
        role="img"
      />
      <p className="qr-card-line">{es.publicCardScan}</p>
      <p className="qr-card-line">{es.publicCardConfirm}</p>
    </div>
  );
}
