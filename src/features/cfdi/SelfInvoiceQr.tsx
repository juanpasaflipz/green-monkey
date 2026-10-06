/**
 * The self-invoicing QR printed on the ticket (spec §2.12): error correction M, a 2-module margin,
 * sized in millimetres by cfdi.css (20 mm at 58 mm paper, 24 mm at 80 mm). qrcode.react 4.2.0
 * (`QRCodeSVG`, `level`, `marginSize`, `title`; Context7 /zpao/qrcode.react), added by the lead
 * (LD-4).
 */
import { QRCodeSVG } from "qrcode.react";

export function SelfInvoiceQr({
  value,
  title,
}: {
  value: string;
  title: string;
}) {
  return (
    <QRCodeSVG
      className="cfdi-qr"
      value={value}
      level="M"
      marginSize={2}
      size={96}
      title={title}
    />
  );
}
