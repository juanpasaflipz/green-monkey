// COMPAT SHIM S1 (public ordering Phase A, LD-P2). Account (031) owns these in
// server/account-settings.ts with exactly these signatures (account.md §4.7).
// B3 switches the imports to "./account-settings.js" and deletes this file;
// it never reaches integration/v1.
import type express from "express";
import type { Tx } from "../db.js";

/**
 * Public-ordering interim switch: "true" → true; "false" → false; unset or
 * empty → APP_ENV !== "production"; anything else throws
 * public_ordering_flag_invalid. Read once at module load by each caller.
 */
export function publicOrderingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.PUBLIC_ORDERING_ENABLED?.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (!v) return env.APP_ENV !== "production";
  throw Error("public_ordering_flag_invalid");
}

/** First middleware of the diner router: 404 before any limiter when disabled. */
export function publicOrderingGate(
  env: NodeJS.ProcessEnv = process.env,
): express.RequestHandler {
  return publicOrderingEnabled(env)
    ? (_req, _res, next) => next()
    : (_req, res) => {
        res.status(404).json({ error: "public_ordering_disabled" });
      };
}

/** The restaurant's privacy notice URL; account (031) stores it. None before 031. */
export async function restaurantPrivacyUrl(_tx: Tx): Promise<string | null> {
  return null;
}
