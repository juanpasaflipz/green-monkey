import type express from "express";
import type { PreAuthContext, RouteContext } from "../http.js";
import { managers, operators, permit, type AuthRequest } from "../auth.js";
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
 * (LD-15 Q3). A role that may never discount or refund (kitchen) is refused
 * first, before any PIN is checked or counted (APPROVALS-4): a correct guess
 * must not be told apart from a wrong one.
 */
export async function approvalFor(
  sql: Parameters<typeof verifyApproval>[0],
  s: Session,
  raw: unknown,
  mode: "conditional" | "required",
): Promise<ApprovalContext> {
  permit(s, operators);
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
  a: ApprovalContext,
) => Promise<unknown>;

/**
 * One approved request: the approval step (its own transactions), then the
 * command in its own tenant() transaction. `run` has no side effects outside
 * the transaction (tenant() may replay it).
 */
async function approved(
  sql: Parameters<typeof verifyApproval>[0],
  mode: "conditional" | "required",
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  run: ApprovedCommand,
) {
  try {
    const s = (req as AuthRequest).session;
    const a = await approvalFor(sql, s, req.body?.approval, mode);
    res.json(await tenant(sql, s.tenantId, (tx) => run(tx, s, a)));
  } catch (e) {
    next(e);
  }
}

/**
 * Discounts, refunds and drawer controls (028). The legacy GET /cash,
 * POST /cash/close, GET /cash/history and POST /refunds keep their paths in
 * server/index.ts and delegate to server/cash.ts and server/refunds.ts. Each
 * registration passes its own handler, so the lock-order scanner reads every
 * request as its own transaction.
 */
export function register({ app, sql, route }: RouteContext) {
  app.post("/api/orders/:id/discounts", (req, res, next) =>
    approved(sql, "conditional", req, res, next, (tx, s, a) =>
      applyDiscount(tx, s, id.parse(req.params.id), req.body, a),
    ),
  );
  app.post("/api/orders/:id/discounts/:discountId/reverse", (req, res, next) =>
    approved(sql, "required", req, res, next, (tx, s, a) =>
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
  app.post("/api/orders/:id/refunds", (req, res, next) =>
    approved(sql, "required", req, res, next, (tx, s, a) =>
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
