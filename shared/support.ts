/**
 * The "Referencia de soporte" staff read out to support (docs/RUNBOOK.md "Signals"): the
 * first 8 letters and digits of the request id the server logs and returns (the
 * X-Request-Id header and the error body's `requestId`), upper-cased so it reads aloud
 * the same way it is typed. Every server log line that carries a `requestId` also carries
 * this value as `supportRef`, so `@supportRef:<ref>` finds the request in Railway's logs.
 */
export function supportReference(requestId: string): string {
  return requestId
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(0, 8)
    .toUpperCase();
}
