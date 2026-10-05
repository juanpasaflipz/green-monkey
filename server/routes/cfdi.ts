import type { PreAuthContext, RouteContext } from "../http.js";

/** cfdi area routes that must run before authentication. */
export function registerPreAuth(_ctx: PreAuthContext) {}

/** cfdi area authenticated routes; use ctx.route for tenant-scoped handlers. */
export function register(_ctx: RouteContext) {}
