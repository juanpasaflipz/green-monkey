// Reports (029): what reports reads from fiscal (027) and discounts (028), passed into the report
// functions as one object so a DB test can wrap a call (for example to commit a payment between
// two statements of a print, review REPORTS-CORTES-2) or refuse it loudly (a refused request
// must never reach fiscal or discounts). The types are the real functions' types, and
// `reportsPorts` is the object the routes use. The remote close calls discounts' closeDrawerRow
// directly (server/reports/cortes.ts), so the lock-order scanner follows it.
import { fiscalSummary, missingTicketCount } from "../fiscal.js";
import { moneyControls } from "../discounts.js";
import { canSeeExpected } from "../../shared/discounts.js";

export type ReportsPorts = {
  /** fiscal: IVA by business date for any range of at most 31 days (reports chunks longer ones). */
  fiscalSummary: typeof fiscalSummary;
  /** fiscal: paid sales without a ticket (default window: the last 40 business days). */
  missingTicketCount: typeof missingTicketCount;
  /** discounts: the location's money controls (defaults when no row exists). */
  moneyControls: typeof moneyControls;
  /** discounts (shared): whether a role may see expected cash during the shift. */
  canSeeExpected: typeof canSeeExpected;
};

/** The real modules: every report route reads through this object. */
export const reportsPorts: ReportsPorts = {
  fiscalSummary,
  missingTicketCount,
  moneyControls,
  canSeeExpected,
};

/** True when the restaurant currency gets fiscal tickets (fiscal issues MXN only). */
export const fiscalCurrency = (currency: string) => currency === "MXN";
