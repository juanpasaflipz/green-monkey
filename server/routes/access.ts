import type { PreAuthContext, RouteContext } from "../http.js";

/** access area routes that must run before authentication. */
export function registerPreAuth(_ctx: PreAuthContext) {}

/** access area authenticated routes; use ctx.route for tenant-scoped handlers. */
export function register(_ctx: RouteContext) {}
