/**
 * The "Referencia de soporte" staff read out to support (docs/RUNBOOK.md "Signals"): the
 * first 8 letters and digits of the request id the server logs and returns (the
 * X-Request-Id header and the error body's `requestId`), upper-cased so it reads aloud
 * the same way it is typed. Every server log line that carries a `requestId` also carries
 * this value as `supportRef`, so `@supportRef:<ref>` finds the request in Railway's logs.
 *
 * A request id is not always hex (requestIdOf accepts any well-formed
 * X-Railway-Request-Id), so the letters a listener confuses with digits are folded
 * the way Crockford's base32 reads them: O is written 0, I and L are written 1
 * (POLISH-UX-4). The screen and the logs use this same function, so a reference
 * never shows O, I or L, and what the cashier reads is what support types.
 */
export function supportReference(requestId: string): string {
  return requestId
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(0, 8)
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}
