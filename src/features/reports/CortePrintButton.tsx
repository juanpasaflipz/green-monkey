import { useId, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { strings } from "../../i18n";
import { Button } from "../../components/ui";
import { CortePreview } from "./CortePreview";

/**
 * Opens the corte preview of one drawer (Corte X, Imprimir corte Z, comprobante de conteo).
 * Discounts' DrawerPanel `actions` slot, DrawerCloseDialog's result step and the CashHistory rows
 * render it. Offline it is disabled with a visible reason it is described by (acceptance A13.8).
 */
export function CortePrintButton({
  session,
  locale,
  drawerId,
  label,
  variant = "ghost",
  online = true,
}: {
  session: Session;
  locale: Locale;
  drawerId: string;
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  online?: boolean;
}) {
  const t = strings[locale];
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        disabled={!online}
        aria-describedby={online ? undefined : reasonId}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      {!online && (
        <span className="muted report-offline-reason" id={reasonId}>
          {t.reportsOffline}
        </span>
      )}
      {open && (
        <CortePreview
          session={session}
          locale={locale}
          target={{ kind: "drawer", drawerId }}
          close={() => setOpen(false)}
          online={online}
        />
      )}
    </>
  );
}
