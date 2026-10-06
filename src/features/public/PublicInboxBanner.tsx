import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { fill } from "../menu/format";
import { Button } from "../../components/ui";
import "./public.css";

/**
 * Shell banner while online orders wait for staff and Órdenes is not shown
 * (count 0 hides it). A polite live region, never role="status" (LD-P8):
 * other screens assert their own status messages unscoped. The region stays
 * mounted, empty while nothing waits, so screen readers announce the first
 * pending order too (text inserted together with its region is not read).
 */
export function PublicInboxBanner({
  count,
  locale,
  onView,
}: {
  count: number;
  locale: Locale;
  onView: () => void;
}) {
  const t = strings[locale];
  return (
    <div className="public-banner-live" aria-live="polite">
      {count > 0 && (
        <div className="public-banner">
          <p>
            {count === 1
              ? t.publicBannerOne
              : fill(t.publicBannerMany, { n: count })}
          </p>
          <Button variant="primary" onClick={onView}>
            {t.publicBannerView}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The pending count next to a rail or tab label; hidden from the accessible name. */
export function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="nav-badge" aria-hidden="true">
      {count > 99 ? "99+" : count}
    </span>
  );
}
