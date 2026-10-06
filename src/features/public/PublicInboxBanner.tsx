import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { fill } from "../menu/format";
import { Button } from "../../components/ui";
import "./public.css";

/**
 * Shell banner while online orders wait for staff and Órdenes is not shown.
 * A polite live region, never role="status" (LD-P8): other screens assert
 * their own status messages unscoped.
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
    <div className="public-banner" aria-live="polite">
      <p>
        {count === 1
          ? t.publicBannerOne
          : fill(t.publicBannerMany, { n: count })}
      </p>
      <Button variant="primary" onClick={onView}>
        {t.publicBannerView}
      </Button>
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
