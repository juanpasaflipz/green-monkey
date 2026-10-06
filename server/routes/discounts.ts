import type express from "express";
import type { PreAuthContext, RouteContext } from "../http.js";
import { managers, type AuthRequest } from "../auth.js";
import { tenant, type Tx } from "../db.js";
import { requireRecentAuth } from "../access.js";
import { verifyApproval } from "../voids.js";
import {
  applyDiscount,
  getMoneyControls,
  reverseDiscount,
  saveMoneyControls,
  type ApprovalContext,
} from "../discounts.js";
import { recordRefund } from "../refunds.js";
import { reviewDrawer } from "../cash.js";
import { DomainError, id, type Session } from "../../shared/domain.js";

/** discounts area routes that must run before authentication (none). */
export function registerPreAuth(_ctx: PreAuthContext) {}

/**
 * The approval step of a discount, reversal or refund, before the command's
 * own transaction (failed PINs must be counted even when the command is
 * refused, so verifyApproval commits on its own). LD-2 and LD-15 Q2:
 * - a body with `approval` (a manager's PIN in ManagerApproval) verifies it:
 *   that PIN is the only one asked, the actor needs no step-up;
 * - a manager or owner acting alone gets the standard step-up
 *   (step_up_required: the client prompts "Confirma con tu PIN" and retries the
 *   identical body) and is the approver of record (LD-16 L3);
 * - staff without an approval: none for a discount (the command decides
 *   whether their limit allows it), approval_required for a reversal or refund.
 * verifyApproval runs without an order id: its pre-check is void-specific
 * (LD-15 Q3).
 */
export async function approvalFor(
  sql: Parameters<typeof verifyApproval>[0],
  s: Session,
  raw: unknown,
  mode: "conditional" | "required",
): Promise<ApprovalContext> {
  if (raw !== undefined && raw !== null)
    return { approverId: await verifyApproval(sql, s, raw) };
  if (managers.includes(s.role)) {
    requireRecentAuth(s);
    return { approverId: s.employeeId };
  }
  if (mode === "required") throw new DomainError("approval_required", 403);
  return { approverId: null };
}

type ApprovedCommand = (
  tx: Tx,
  s: Session,
  req: express.Request,
  a: ApprovalContext,
) => Promise<unknown>;

/**
 * Discounts, refunds and drawer controls (028). The legacy GET /cash,
 * POST /cash/close, GET /cash/history and POST /refunds keep their paths in
 * server/index.ts and delegate to server/cash.ts and server/refunds.ts.
 */
export function register({ app, sql, route }: RouteContext) {
  const approved =
    (mode: "conditional" | "required", run: ApprovedCommand) =>
    async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      try {
        const s = (req as AuthRequest).session;
        const a = await approvalFor(sql, s, req.body?.approval, mode);
        // run has no side effects outside the transaction (tenant() may replay it).
        res.json(await tenant(sql, s.tenantId, (tx) => run(tx, s, req, a)));
      } catch (e) {
        next(e);
      }
    };
  app.post(
    "/api/orders/:id/discounts",
    approved("conditional", (tx, s, req, a) =>
      applyDiscount(tx, s, id.parse(req.params.id), req.body, a),
    ),
  );
  app.post(
    "/api/orders/:id/discounts/:discountId/reverse",
    approved("required", (tx, s, req, a) =>
      reverseDiscount(
        tx,
        s,
        id.parse(req.params.id),
        id.parse(req.params.discountId),
        req.body,
        a,
      ),
    ),
  );
  app.post(
    "/api/orders/:id/refunds",
    approved("required", (tx, s, req, a) =>
      recordRefund(tx, s, id.parse(req.params.id), req.body, a),
    ),
  );
  route("get", "/discounts/controls", (tx, s) => getMoneyControls(tx, s));
  route("post", "/discounts/controls", (tx, s, req) =>
    saveMoneyControls(tx, s, req.body),
  );
  route("post", "/cash/drawers/:id/review", (tx, s, req) =>
    reviewDrawer(tx, s, id.parse(req.params.id), req.body),
  );
}
