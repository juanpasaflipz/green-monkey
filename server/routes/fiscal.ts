import type { PreAuthContext, RouteContext } from "../http.js";
import {
  fiscalContextView,
  fiscalRangeQuery,
  fiscalSummary,
  getFiscalProfile,
  listTickets,
  repairMissingTickets,
  saveFiscalProfile,
} from "../fiscal.js";

/** fiscal area routes that must run before authentication (none: self-invoicing is cfdi 030). */
export function registerPreAuth(_ctx: PreAuthContext) {}

/**
 * Fiscal profile, context for receipts, ticket register, IVA summary and missing-ticket
 * repair (docs/FISCAL.md). Every route runs in one tenant transaction through ctx.route; POSTs
 * pass the CSRF middleware and are idempotent per operationId.
 */
export function register({ route }: RouteContext) {
  route("get", "/fiscal/context", (tx, s) => fiscalContextView(tx, s));
  route("get", "/fiscal/profile", (tx, s) => getFiscalProfile(tx, s));
  route("post", "/fiscal/profile", (tx, s, req) =>
    saveFiscalProfile(tx, s, req.body),
  );
  route("get", "/fiscal/tickets", (tx, s, req) =>
    listTickets(tx, s, req.query),
  );
  route("get", "/fiscal/summary", (tx, s, req) =>
    fiscalSummary(tx, s, fiscalRangeQuery.parse(req.query)),
  );
  route("post", "/fiscal/tickets/repair", (tx, s, req) =>
    repairMissingTickets(tx, s, req.body),
  );
}
