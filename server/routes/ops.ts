import type express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { PreAuthContext, RouteContext } from "../http.js";
import {
  clientAddress,
  clientIp,
  ipHash,
  log,
  requestIdOf,
  routeLabel,
} from "../logging.js";
import { opsStatus } from "../ops/status.js";
import { cancelJob, requeueJob } from "../jobs/queue.js";
import { requireRecentAuth } from "../access.js";
import { audit } from "../orders.js";
import { id } from "../../shared/domain.js";

/**
 * Per-IP limiter for the public ops endpoints. Keys on the real client
 * address (trust proxy plus Railway's X-Real-IP), so two clients behind the
 * edge proxy get independent buckets (SEC-1/OPS-3), and answers 429 as JSON.
 */
export function opsLimiter(name: string, limit: number, windowMs = 60_000) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req), 56),
    handler: (req, res) => {
      log.warn("rate_limited", {
        limiter: name,
        route: routeLabel(req),
        ipHash: ipHash(clientIp(req)),
      });
      res
        .status(429)
        .json({ error: "rate_limited", requestId: requestIdOf(req) });
    },
  });
}

function workerUrl(): string | null {
  const value = process.env.WORKER_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** ops area routes that must run before authentication. */
export function registerPreAuth(ctx: PreAuthContext) {
  const { app, sql } = ctx;

  // Public, tenant-free status for uptime checks and the CD smoke (OPS-4).
  app.get(
    "/api/ops/status",
    opsLimiter("ops-status", 60),
    async (_req: express.Request, res: express.Response, next) => {
      try {
        const status = await opsStatus(sql, { workerUrl: workerUrl() });
        res.set("Cache-Control", "no-store");
        res.status(status.ok ? 200 : 503).json(status);
      } catch (error) {
        next(error);
      }
    },
  );

  // The requester's own address as the server sees it (clientAddress), so the
  // CD smoke can prove the edge is a trusted peer and the address is the
  // edge's X-Real-IP (source "x-real-ip"), not the edge hop (LD-46). No
  // headers are echoed.
  app.get(
    "/api/ops/diagnostics/ip",
    opsLimiter("ops-ip", 60),
    (req: express.Request, res: express.Response) => {
      const { ip, peerTrusted, source } = clientAddress(req);
      res.set("Cache-Control", "no-store");
      res.json({ ip, peerTrusted, source });
    },
  );
}

/**
 * ops area authenticated routes; use ctx.route for tenant-scoped handlers.
 *
 * Job controls (PLATFORM-OPS-3, docs/RUNBOOK.md "Jobs"): an owner or manager with a
 * recent PIN or password (step-up) retries a dead job, or cancels a queued, available,
 * blocked or running one (it goes dead with error_code cancelled; a running holder loses
 * its lease). Each writes an audit row (job.requeued, job.cancelled) with the job's kind
 * and its state and error code before the change, in the same transaction (PLAT-HR-6).
 * No screen calls them yet: they are operator API calls. GET /api/jobs lists the
 * tenant's latest jobs.
 */
export function register(ctx: RouteContext) {
  const { route } = ctx;
  route("post", "/jobs/:id/requeue", async (tx, s, req) => {
    requireRecentAuth(s);
    const jobId = id.parse(req.params.id);
    const before = await requeueJob(tx, s, jobId);
    await audit(tx, s, "job.requeued", jobId, before);
    return { ok: true };
  });
  route("post", "/jobs/:id/cancel", async (tx, s, req) => {
    requireRecentAuth(s);
    const jobId = id.parse(req.params.id);
    const before = await cancelJob(tx, s, jobId);
    await audit(tx, s, "job.cancelled", jobId, before);
    return { ok: true };
  });
}
