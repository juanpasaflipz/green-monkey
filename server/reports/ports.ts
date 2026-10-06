// Reports (029): what reports consumes from fiscal (027) and discounts (028), with the exact
// signatures their specs export (fiscal §6.1, discounts §4.2/§4.4, wave2-cross-track C3, C4,
// C10). It is a typed seam, not a stand-in: nothing here implements those functions.
// server/routes/reports.ts builds one ReportsPorts from the real modules once 027 and 028 are
// merged (reports phase B, wave2-cross-track §2); until then the routes that need it are not
// registered. Unit tests pass their own ports.
import type { Tx } from "../db.js";
import type { Session } from "../../shared/domain.js";
import type { FiscalSummary } from "../../shared/fiscal.js";
import type { DateRange } from "../../shared/reports.js";

/** discounts' closeDrawerRow input (reports §4.8, discounts §4.4). */
export type CloseDrawerInput = {
  counted: number;
  reason: string;
  externalReported?: number | null;
};

/**
 * `C` is discounts' MoneyControls; reports never reads its fields, it only hands the value back
 * to canSeeExpected, so the seam stays exact without restating discounts' type.
 */
export type ReportsPorts<C = unknown> = {
  /** fiscal: IVA by business date for any range of at most 31 days (reports chunks longer ones). */
  fiscalSummary(tx: Tx, s: Session, range: DateRange): Promise<FiscalSummary>;
  /** fiscal: paid sales without a ticket (default window: the last 40 business days). */
  missingTicketCount(tx: Tx, range?: DateRange): Promise<number>;
  /** discounts: the location's money controls (defaults when no row exists). */
  moneyControls(tx: Tx): Promise<C>;
  /** discounts (shared): whether a role may see expected cash during the shift. */
  canSeeExpected(role: string, c: C): boolean;
  /**
   * discounts: steps 3–6 of closeCash for an already-locked open drawer row (drawerTotals,
   * the visible-mode reason rule, the update with closed_by and count_mode, audit cash.close
   * with `extra`). Reports' remote close calls it with mode "visible" and {remote: true}.
   */
  closeDrawerRow(
    tx: Tx,
    s: Session,
    d: { id: string },
    p: CloseDrawerInput,
    mode: "blind" | "visible",
    extra?: Record<string, unknown>,
  ): Promise<void>;
};

/** True when the restaurant currency gets fiscal tickets (fiscal issues MXN only). */
export const fiscalCurrency = (currency: string) => currency === "MXN";
