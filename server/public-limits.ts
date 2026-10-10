// In-memory per-IP limits for the public diner router (032). They are a first
// filter per web replica (replicas: 1); the binding abuse controls are the
// database caps inside submitHold.
import { createHash } from "node:crypto";
import type express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clientIp, ipHash, log, requestIdOf, routeLabel } from "./logging.js";
import { PUBLIC_TOKEN } from "../shared/public-ordering.js";

/** Requests per minute. */
export const PUBLIC_RATES = {
  /** Menu loads per IP (raised from menu's 30: a full room on one Wi-Fi refetches together). */
  menuPerIp: 60,
  /** Requests with a missing or malformed token: their own bucket (ABUSE-3). */
  malformedPerIp: 30,
  /** Order submissions per IP (MENU-R6's own order budget). */
  submitPerIp: 30,
  cancelPerIp: 30,
  /** MENU-R3 ceiling: every revision poll of one IP, whatever its token. */
  revisionPerIp: 240,
  statusPerIp: 240,
  /** MENU-R1: revision polls per (IP, link). */
  revisionPerIpLink: 20,
  /** Submits and cancels per (IP, link). */
  writePerIpLink: 10,
  /** Status polls per (IP, status key); the page polls at most 12 a minute. */
  statusPerIpKey: 30,
} as const;

const digest = (v: string) =>
  createHash("sha256").update(v).digest("base64url").slice(0, 22);
/**
 * A scope value becomes part of a key only when it is a well-formed token;
 * anything else shares one "-" bucket per IP, so a client cannot mint keys
 * (MENU-R3). Well-formed random tokens are still bounded by the per-IP
 * ceilings, and malformed ones never reach the database.
 */
export const scopeKey = (v: string) => (PUBLIC_TOKEN.test(v) ? digest(v) : "-");
/** The limiter key for one client network (IPv6 per /56) and optional scope. */
export function publicKey(ip: string, scope?: string): string {
  return (
    ipKeyGenerator(ip, 56) + (scope === undefined ? "" : ":" + scopeKey(scope))
  );
}

/**
 * ops' opsLimiter pattern (the real client address from clientIp, /56 IPv6
 * grouping, a JSON 429 with the request id and a rate_limited log line) with
 * an optional per-token scope. Create limiters per router instance.
 */
export function publicLimiter(
  name: string,
  o: {
    limit: number;
    windowMs?: number;
    scope?: (req: express.Request) => string;
    /**
     * A key that replaces the network-and-scope one when it returns a string (a kiosk device's
     * own bucket on any network, KIOSK-SECURITY-1); undefined falls back to publicKey.
     */
    key?: (req: express.Request) => string | undefined;
    /** Requests that do not count towards this limiter (express-rate-limit `skip`). */
    skip?: (req: express.Request, res: express.Response) => boolean;
  },
) {
  return rateLimit({
    windowMs: o.windowMs ?? 60_000,
    limit: o.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
      o.key?.(req) ?? publicKey(clientIp(req), o.scope?.(req)),
    skip: o.skip ?? (() => false),
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
