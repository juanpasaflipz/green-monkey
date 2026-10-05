import type { PreAuthContext, RouteContext } from "../http.js";
import { id } from "../../shared/domain.js";
import {
  closeCheck,
  listOrders,
  recordPrint,
  tableOccupancy,
  updateOrderNote,
} from "../checks.js";
import { clearStaleRounds, kitchenFeed, recallRound } from "../kitchen.js";

/** service area routes that must run before authentication (none). */
export function registerPreAuth(_ctx: PreAuthContext) {}

/**
 * Front-of-house service: orders and tables lists, check close, note edits,
 * print audit and the kitchen display feed. New paths use the /service prefix
 * so the single-segment /orders/:id and /kitchen/:id routes never capture them.
 */
export function register({ route }: RouteContext) {
  route("get", "/service/orders", (tx, s, req) => listOrders(tx, s, req.query));
  route("get", "/service/tables", (tx, s) => tableOccupancy(tx, s));
  route("post", "/service/orders/:id/close", (tx, s, req) =>
    closeCheck(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/service/orders/:id/note", (tx, s, req) =>
    updateOrderNote(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/service/orders/:id/print", (tx, s, req) =>
    recordPrint(tx, s, id.parse(req.params.id), req.body),
  );
  route("get", "/service/kitchen", (tx, s, req) =>
    kitchenFeed(tx, s, req.query),
  );
  route("post", "/service/kitchen/rounds/:id/recall", (tx, s, req) =>
    recallRound(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/service/kitchen/clear-stale", (tx, s, req) =>
    clearStaleRounds(tx, s, req.body),
  );
}
