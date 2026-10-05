import type { PreAuthContext, RouteContext } from "../http.js";

/** reports area routes that must run before authentication. */
export function registerPreAuth(_ctx: PreAuthContext) {}

/** reports area authenticated routes; use ctx.route for tenant-scoped handlers. */
export function register(_ctx: RouteContext) {}
