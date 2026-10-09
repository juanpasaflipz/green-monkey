/**
 * The one HTTP client of the payments provider adapters (spec §4.0 import rule 3: the adapters
 * import nothing from server/ but this file). Global fetch with a per-call timeout joined to the
 * job's abort signal; JSON bodies; every failure becomes a ProviderError carrying a stable code
 * and never the response body, a header or a credential (spec §9.4: nothing provider-shaped is
 * logged raw).
 */

/** A provider call failure. `code` is one of this area's error codes; `providerCode` is the
 *  provider's own short code, sanitized to ^[a-z0-9_]{1,64}$ (or null). */
export class ProviderError extends Error {
  constructor(
    public code: string,
    public status: number | null,
    public providerCode: string | null = null,
    /** True when the same request may be sent again (network, 5xx, 429). */
    public retryable = false,
    /** A 429's suggested wait. */
    public retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "ProviderError";
  }
}

export type HttpResponse = {
  status: number;
  /** Parsed JSON, or null when the body is empty or not JSON. */
  body: unknown;
};

/** Default timeout of a provider call (spec §4.7: 15 s). */
export const PROVIDER_TIMEOUT_MS = 15_000;

/** A provider's short error code, lower-cased and reduced to [a-z0-9_]; null when unusable. */
export function sanitizeCode(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return s.length >= 2 ? s : null;
}

export async function providerRequest(o: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(o.url, {
      method: o.method,
      headers: {
        Accept: "application/json",
        ...(o.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...o.headers,
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal,
      redirect: "error",
    });
  } catch {
    // Timeout, abort, DNS, TLS or connection failure: the request may or may not have arrived.
    throw new ProviderError("payments_provider_unreachable", null, null, true);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ProviderError(
      "payments_provider_unreachable",
      res.status,
      null,
      true,
    );
  }
  let body: unknown = null;
  if (text)
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  return { status: res.status, body };
}

/** 429 and 5xx as retryable ProviderErrors (the caller maps 4xx itself). */
export function transientError(r: HttpResponse): ProviderError | null {
  if (r.status === 429)
    return new ProviderError(
      "payments_provider_rate_limited",
      429,
      null,
      true,
      3500,
    );
  if (r.status >= 500)
    return new ProviderError(
      "payments_provider_unreachable",
      r.status,
      null,
      true,
    );
  return null;
}

/** Decimal pesos ("236.00", "236.5", 236.5) to integer minor units, rounded half-up to the
 *  centavo; null when not a non-negative amount. */
export function decimalToMinor(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d{1,9}(\.\d+)?$/.test(value.trim()))
    return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return null;
  return Math.round(n * 100);
}

/** Integer minor units to the decimal pesos number Clip expects (20050 -> 200.5). */
export function minorToPesos(minor: number): number {
  return Math.round(minor) / 100;
}
