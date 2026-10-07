import { useId } from "react";
import type { Locale } from "../../shared/domain";
import { strings } from "../i18n";
import { Button } from "../components/ui";

/** "1 producto" / "3 productos" ("1 item" / "3 items"): a parked cart's line count. */
export function draftItemsText(n: number, locale: Locale): string {
  const t = strings[locale];
  return (n === 1 ? t.serviceDraftItemsOne : t.serviceDraftItems).replace(
    "{n}",
    String(n),
  );
}

/**
 * How Borradores names a parked cart: "#12 · ronda sin enviar · Mesa 4 · 3 productos" for
 * a round parked for an order (its label: "#12", "B-07", "B-07 → #142", dated for another
 * business day), else "Mesa 4 · 3 productos".
 */
export function draftEntryText(
  entry: { label: string | null; name: string; lines: number },
  locale: Locale,
): string {
  const t = strings[locale];
  return (
    (entry.label
      ? t.serviceDraftRound.replace("{order}", entry.label) + " · "
      : "") +
    `${entry.name || t.order} · ${draftItemsText(entry.lines, locale)}`
  );
}

/**
 * A parked cart whose order no longer exists anywhere (LD-13 addendum): one card with
 * its text, why it is gone and its only action. The discard button names its draft and
 * is described by the reason (LD-48, POLISH-UX-5), so a screen reader that lands on it
 * when the entry turns gone hears why. `data-draft-entry` lets Selling move the focus
 * to the next entry after a discard.
 */
export function DraftGoneEntry({
  draftId,
  text,
  locale,
  autoFocus,
  onDiscard,
}: {
  draftId: string;
  text: string;
  locale: Locale;
  autoFocus: boolean;
  /** Receives the dialog the entry is in, where the focus goes next. */
  onDiscard: (dialog: HTMLElement | null) => void;
}) {
  const t = strings[locale];
  const reason = useId();
  return (
    <div className="draft-gone" data-draft-entry={draftId}>
      <p>{text}</p>
      <p className="warning-panel" role="status" id={reason}>
        {t.serviceDraftOrderGone}
      </p>
      <Button
        aria-label={`${t.serviceDraftDiscard}: ${text}`}
        aria-describedby={reason}
        autoFocus={autoFocus}
        onClick={(e) => onDiscard(e.currentTarget.closest("dialog"))}
      >
        {t.serviceDraftDiscard}
      </Button>
    </div>
  );
}
