import type { PreAuthContext, RouteContext } from "../http.js";

/** account area routes that must run before authentication. */
export function registerPreAuth(_ctx: PreAuthContext) {}

/** account area authenticated routes; use ctx.route for tenant-scoped handlers. */
export function register(_ctx: RouteContext) {}
