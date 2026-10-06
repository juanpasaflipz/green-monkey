import { useState } from "react";
import type { Locale } from "../../../shared/domain";
import type { RevealedLink } from "../../../shared/public-ordering";
import { strings } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { printDocument, readPrintSettings } from "../../print";
import { QrCard } from "./QrCard";

/** The full link of a freshly created or replaced code. */
export const linkUrl = (l: RevealedLink) =>
  (l.baseUrl ?? location.origin) + l.path;

/** Prints `copies` cards of each link, one card per print section. */
export function printCards(
  links: RevealedLink[],
  restaurant: string,
  copies = 1,
) {
  const cards = links.flatMap((l) =>
    Array.from({ length: copies }, (_, i) => (
      <QrCard
        key={l.id + ":" + i}
        restaurant={restaurant}
        place={l.kind === "table" ? (l.tableName ?? "") : l.label}
        url={linkUrl(l)}
        kind={l.kind}
      />
    )),
  );
  return printDocument(cards, readPrintSettings().paper);
}

/** Copies, "Imprimir" and "Copiar enlace" for a revealed link. */
export function RevealControls({
  link,
  restaurant,
  locale,
}: {
  link: RevealedLink;
  restaurant: string;
  locale: Locale;
}) {
  const t = strings[locale];
  const [copies, setCopies] = useState(1);
  const [copied, setCopied] = useState(false);
  const url = linkUrl(link);
  return (
    <>
      <Field label={t.publicLinkUrl}>
        <input readOnly value={url} onFocus={(e) => e.target.select()} />
      </Field>
      <div className="row wrap">
        {link.kind !== "kiosk" && (
          <>
            <label className="field inline">
              <span>{t.publicCopies}</span>
              <select
                value={copies}
                onChange={(e) => setCopies(Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              onClick={() => void printCards([link], restaurant, copies)}
            >
              {t.publicPrint}
            </Button>
          </>
        )}
        <Button
          onClick={() => {
            void navigator.clipboard
              ?.writeText(url)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {t.publicCopyLink}
        </Button>
      </div>
      <p className="muted" aria-live="polite">
        {copied ? t.publicCopied : ""}
      </p>
    </>
  );
}

/**
 * Shows a new link once: its card or QR, the link, copy and print. The token
 * lives only in this dialog's props and is dropped when it closes; it is never
 * stored on the device.
 */
export function LinkRevealDialog({
  link,
  restaurant,
  locale,
  onClose,
}: {
  link: RevealedLink;
  restaurant: string;
  locale: Locale;
  onClose: () => void;
}) {
  const t = strings[locale];
  return (
    <Modal title={t.publicRevealTitle} close={onClose} closeLabel={t.close}>
      <p className="warning-panel">{t.publicRevealOnce}</p>
      {link.kind === "kiosk" && <p>{t.publicKioskInstructions}</p>}
      <div className="qr-preview">
        <QrCard
          restaurant={restaurant}
          place={link.kind === "table" ? (link.tableName ?? "") : link.label}
          url={linkUrl(link)}
          kind={link.kind}
        />
      </div>
      <RevealControls link={link} restaurant={restaurant} locale={locale} />
    </Modal>
  );
}
