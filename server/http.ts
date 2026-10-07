import type express from "express";
import type postgres from "postgres";
import { tenant, type Tx } from "./db.js";
import type { AuthRequest } from "./auth.js";
import type { Session } from "../shared/domain.js";

export type RouteHandler = (
  tx: Tx,
  s: Session,
  req: express.Request,
) => Promise<unknown>;

/** Registers an authenticated JSON route that runs inside one tenant transaction. */
export type Route = (
  method: "get" | "post",
  path: string,
  fn: RouteHandler,
) => void;

/** Routes registered after authentication: `route` scopes every call to the session tenant. */
export interface RouteContext {
  app: express.Express;
  sql: postgres.Sql;
  route: Route;
}

/** Routes registered before authentication (login, pairing, public pages). */
export interface PreAuthContext {
  app: express.Express;
  sql: postgres.Sql;
}

export function makeRoute(app: express.Express, sql: postgres.Sql): Route {
  return (method, path, fn) =>
    app[method]("/api" + path, async (req, res, next) => {
      try {
        res.json(
          await tenant(sql, (req as AuthRequest).session.tenantId, (tx) =>
            fn(tx, (req as AuthRequest).session, req),
          ),
        );
      } catch (e) {
        next(e);
      }
    });
}

/**
 * Express `trust proxy` value. Railway's edge proxy connects from 100.0.0.0/8;
 * trusting only that subnet (and loopback) never honours a client's own
 * forwarding headers. Behind the edge req.ip is the edge hop, not the client:
 * the client address is clientIp() in server/logging.ts, which takes the
 * edge's X-Real-IP from a trusted peer (LD-46).
 */
export function trustProxy(env: NodeJS.ProcessEnv): string | number | boolean {
  const value = env.TRUST_PROXY?.trim();
  if (!value)
    return env.NODE_ENV === "production" ? "loopback, 100.0.0.0/8" : false;
  if (value === "false") return false;
  if (value === "true")
    throw Error("TRUST_PROXY=true trusts any client header; list subnets");
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
