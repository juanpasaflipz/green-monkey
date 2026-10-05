/**
 * Facturapi API v2 HTTP client (cfdi 030, spec §4.3). No SDK: Node 24 fetch/FormData/Blob, with
 * an injectable `fetch` so contract tests and the fake (tests/fakes/facturapi-fake.ts) never touch
 * the network.
 *
 * Paths, key types and shapes follow the official OpenAPI v2 (FacturAPI/facturapi-docs
 * `website/openapi_v2.en.yaml`, commit 1c2e617, 2026-09-19; security schemes SecretUserKey /
 * SecretTestKey / SecretLiveKey) and the official Node SDK (Context7 /facturapi/facturapi-node:
 * `organizations.uploadCertificate` multipart `cer` as cer.cer, `key` as key.key, `password`;
 * `FacturapiError` fields; `x-facturapi-log-id`). Errors follow guides/getting-started/errors.mdx
 * (stable root `code`, `errors[]` details, `Accept-Language`, `Retry-After`, `X-Facturapi-Log-Id`).
 *
 * Strict sandbox/live separation:
 *   - every call checks the key kind against the endpoint (user keys manage organizations; test
 *     and live keys issue invoices) and the secret's prefix against its declared kind, BEFORE any
 *     request is made (FacturapiError kind "key", code cfdi_key_kind);
 *   - every invoice response must have livemode === (key kind is "live"), else cfdi_mode_mismatch;
 *   - the base URL is the official one or a loopback host (the dev/test fake), nothing else.
 *
 * The client never logs and never puts a secret in an error message. Callers log
 * {op, status, code, logId} only (server/logging.ts redact() also masks provider keys).
 */
import { z } from "zod";
import { buildInfo } from "../build-info.js";
import {
  apiKeyResponse,
  cancelQuery,
  emailInput,
  errorResponse,
  invoiceInput,
  invoiceResponse,
  legalInput,
  okResponse,
  organizationCreateInput,
  organizationResponse,
  PROVIDER_ID,
  searchResult,
  type FInvoice,
  type FInvoiceInput,
  type FLegalInput,
  type FOrganization,
} from "./facturapi-schema.js";

export type { FInvoice, FInvoiceInput, FLegalInput, FOrganization };

export const FACTURAPI_BASE_URL = "https://www.facturapi.io/v2";

export type FacturapiKeyKind = "user" | "test" | "live";
export type FacturapiKey = { kind: FacturapiKeyKind; secret: string };

export interface FacturapiOptions {
  /** Defaults to FACTURAPI_BASE_URL in the environment, else the official URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Accept-Language for Facturapi-defined messages (errors.mdx); Spanish by default. */
  locale?: "es" | "en";
  userAgent?: string;
  /** Tests only: shorter timeouts. Production uses 15 s, and 30 s for stamping, cancel and CSD. */
  timeouts?: { standardMs: number; longMs: number };
}

export type FacturapiErrorKind =
  "http" | "network" | "timeout" | "schema" | "key";
export type FacturapiErrorDetail = {
  code: string;
  message: string;
  source: "facturapi" | "sat" | "pac";
  path?: string;
};

export class FacturapiError extends Error {
  constructor(
    public kind: FacturapiErrorKind,
    /** HTTP status; 0 when no response was received or nothing was sent. */
    public status: number,
    /** Facturapi root `code`, or a cfdi_* code for local failures, or http_<status>. */
    public code: string,
    message: string,
    public details: FacturapiErrorDetail[] = [],
    public path?: string,
    public logId?: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "FacturapiError";
  }
}

export type FacturapiCertificateFiles = {
  cer: Uint8Array;
  key: Uint8Array;
  password: string;
};
export type FacturapiCancelQuery = {
  motive: "01" | "02" | "03" | "04";
  substitution?: string;
};

export interface FacturapiClient {
  /** POST /organizations (user). No idempotency key exists: callers search by name first. */
  createOrganization(
    k: FacturapiKey,
    body: { name: string },
  ): Promise<FOrganization>;
  /** GET /organizations?q=&limit=50 (user). */
  listOrganizations(k: FacturapiKey, q: string): Promise<FOrganization[]>;
  /** GET /organizations/{id} (user). */
  getOrganization(k: FacturapiKey, orgId: string): Promise<FOrganization>;
  /** GET /organizations/me (test | live): the organization the key belongs to. */
  me(k: FacturapiKey): Promise<FOrganization>;
  /** PUT /organizations/{id}/legal (user | live). */
  updateLegal(
    k: FacturapiKey,
    orgId: string,
    body: FLegalInput,
  ): Promise<FOrganization>;
  /** PUT /organizations/{id}/certificate (user | live), multipart cer (cer.cer), key (key.key), password. */
  uploadCertificate(
    k: FacturapiKey,
    orgId: string,
    f: FacturapiCertificateFiles,
  ): Promise<FOrganization>;
  /** GET /organizations/{id}/apikeys/test (user) → the organization's sk_test_ key. */
  getTestApiKey(k: FacturapiKey, orgId: string): Promise<string>;
  /** PUT /organizations/{id}/apikeys/live (user) → a NEW sk_live_ key (older keys stay valid). */
  createLiveApiKey(k: FacturapiKey, orgId: string): Promise<string>;
  /** POST /invoices (test | live). 202 = accepted with status "pending" (recovery in progress). */
  createInvoice(
    k: FacturapiKey,
    body: FInvoiceInput,
    signal?: AbortSignal,
  ): Promise<{ httpStatus: 200 | 202; invoice: FInvoice }>;
  /** GET /invoices/{id} (test | live). */
  getInvoice(
    k: FacturapiKey,
    id: string,
    signal?: AbortSignal,
  ): Promise<FInvoice>;
  /** GET /invoices?external_id= (exact match, documented) → the invoice to adopt, or null. */
  findInvoiceByExternalId(
    k: FacturapiKey,
    externalId: string,
    signal?: AbortSignal,
  ): Promise<FInvoice | null>;
  /** DELETE /invoices/{id}?motive=&substitution= (test | live). */
  cancelInvoice(
    k: FacturapiKey,
    id: string,
    q: FacturapiCancelQuery,
    signal?: AbortSignal,
  ): Promise<FInvoice>;
  /** PUT /invoices/{id}/status (test | live): asks SAT for the current status. */
  refreshInvoiceStatus(
    k: FacturapiKey,
    id: string,
    signal?: AbortSignal,
  ): Promise<FInvoice>;
  /** GET /invoices/{id}/{xml|pdf} (test | live). */
  download(
    k: FacturapiKey,
    id: string,
    format: "xml" | "pdf",
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  /** GET /invoices/{id}/cancellation_receipt/{xml|pdf} (test | live): the cancellation acuse. */
  downloadCancellationReceipt(
    k: FacturapiKey,
    id: string,
    format: "xml" | "pdf",
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  /** POST /invoices/{id}/email {email: [...≤10]} (test | live). */
  sendByEmail(
    k: FacturapiKey,
    id: string,
    emails: string[],
    signal?: AbortSignal,
  ): Promise<void>;
}

const KEY_PREFIX: Record<FacturapiKeyKind, string> = {
  user: "sk_user_",
  test: "sk_test_",
  live: "sk_live_",
};
/** Header-safe secret: the documented prefix, then token characters only. */
const SECRET = /^sk_(user|test|live)_[A-Za-z0-9_.-]{1,500}$/;
const STANDARD_TIMEOUT_MS = 15_000;
const LONG_TIMEOUT_MS = 30_000;
/** JSON responses are small; 5 MB leaves room for a 5,000-item invoice echo. */
const MAX_JSON_BYTES = 5 * 1024 * 1024;
/** Matches the cfdi_files content cap (20 MB). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_MESSAGE = 1000;

/** Which secret a key kind must carry; also used by callers that unseal stored keys. */
export function keyKindOf(secret: string): FacturapiKeyKind | null {
  const m = SECRET.exec(secret);
  return m ? (m[1] as FacturapiKeyKind) : null;
}

/**
 * Every invoice response passes through this: a test document must come back livemode false and
 * a live document livemode true, or the two environments are mixed (permanent schema error).
 */
export function assertLivemode(
  invoice: Pick<FInvoice, "livemode">,
  mode: "test" | "live",
) {
  if (invoice.livemode !== (mode === "live"))
    throw new FacturapiError(
      "schema",
      0,
      "cfdi_mode_mismatch",
      `invoice livemode ${String(invoice.livemode)} does not match ${mode} mode`,
    );
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The official base URL, or an http(s) URL on a loopback host (the fake in development and tests).
 * server/cfdi/config.ts additionally restricts the override to APP_ENV development/test.
 */
export function resolveBaseUrl(value: string | undefined): string {
  const raw = (value ?? "").trim() || FACTURAPI_BASE_URL;
  if (raw === FACTURAPI_BASE_URL) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("cfdi_base_url_not_allowed");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !isLoopback(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("cfdi_base_url_not_allowed");
  return url.href.replace(/\/+$/, "");
}

function keyError(message: string) {
  return new FacturapiError("key", 0, "cfdi_key_kind", message);
}

/** Refuses a key whose kind is not allowed here or whose secret does not carry its kind's prefix. */
function requireKey(
  k: FacturapiKey,
  allowed: FacturapiKeyKind[],
  op: string,
): string {
  if (!k || typeof k.secret !== "string" || !allowed.includes(k.kind))
    throw keyError(`${op} requires a ${allowed.join(" or ")} key`);
  if (
    keyKindOf(k.secret) !== k.kind ||
    !k.secret.startsWith(KEY_PREFIX[k.kind])
  )
    throw keyError(
      `${op}: the secret does not match its declared ${k.kind} kind`,
    );
  return k.secret;
}

function pathId(id: string, what: string): string {
  if (typeof id !== "string" || !PROVIDER_ID.test(id))
    throw new FacturapiError(
      "schema",
      0,
      "cfdi_request_invalid",
      `invalid ${what} id`,
    );
  return encodeURIComponent(id);
}

function requestInvalid<T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Paths only: values may hold personal data (RFC, names, emails).
  const where = parsed.error.issues
    .slice(0, 5)
    .map((i) => i.path.join(".") || "(root)")
    .join(", ");
  throw new FacturapiError(
    "schema",
    0,
    "cfdi_request_invalid",
    `${what} is invalid at ${where}`,
  );
}

function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d{1,6}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) : text;
}

const SOURCES = new Set(["facturapi", "sat", "pac"]);

async function readLimited(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new FacturapiError(
      "schema",
      response.status,
      "cfdi_provider_response_too_large",
      `response larger than ${limit} bytes`,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new FacturapiError(
        "schema",
        response.status,
        "cfdi_provider_response_too_large",
        `response larger than ${limit} bytes`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** A non-2xx response as FacturapiError (documented GenericError; anything else → http_<status>). */
async function httpError(response: Response): Promise<FacturapiError> {
  const logId = response.headers.get("x-facturapi-log-id") ?? undefined;
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  let body: z.infer<typeof errorResponse> | null = null;
  try {
    const bytes = await readLimited(response, MAX_ERROR_BYTES);
    const parsed = errorResponse.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (parsed.success) body = parsed.data;
  } catch {
    body = null;
  }
  const code =
    body?.code && /^[A-Za-z0-9_.-]{1,100}$/.test(body.code)
      ? body.code
      : `http_${response.status}`;
  const details: FacturapiErrorDetail[] = (body?.errors ?? [])
    .slice(0, 50)
    .map((d) => ({
      code: d.code ?? "",
      message: truncate(d.message ?? ""),
      source: (SOURCES.has(d.source ?? "")
        ? d.source
        : "facturapi") as FacturapiErrorDetail["source"],
      ...(d.path ? { path: d.path } : {}),
    }));
  const message = truncate(
    body?.message?.trim() || `Facturapi HTTP ${response.status}`,
  );
  const path = body?.path ?? details.find((d) => d.path)?.path;
  return new FacturapiError(
    "http",
    response.status,
    code,
    message,
    details,
    path ?? undefined,
    logId,
    retryAfterMs,
  );
}

type Call = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  key: string;
  json?: unknown;
  form?: FormData;
  query?: Record<string, string | undefined>;
  long?: boolean;
  binary?: boolean;
  signal?: AbortSignal;
};

/** Creates a client. Options are read once; the environment default is FACTURAPI_BASE_URL. */
export function createFacturapiClient(
  o: FacturapiOptions = {},
): FacturapiClient {
  const baseUrl = resolveBaseUrl(o.baseUrl ?? process.env.FACTURAPI_BASE_URL);
  const request = o.fetch ?? fetch;
  const locale = o.locale ?? "es";
  const timeouts = o.timeouts ?? {
    standardMs: STANDARD_TIMEOUT_MS,
    longMs: LONG_TIMEOUT_MS,
  };
  let userAgent = o.userAgent;
  const agent = () => (userAgent ??= `green-monkey/${buildInfo().version}`);

  type Sent = {
    response: Response;
    failed: (error: unknown) => FacturapiError;
  };

  async function send(c: Call): Promise<Sent> {
    const url = new URL(baseUrl + c.path);
    for (const [name, value] of Object.entries(c.query ?? {}))
      if (value !== undefined) url.searchParams.set(name, value);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${c.key}`,
      Accept: c.binary ? "*/*" : "application/json",
      "Accept-Language": locale,
      "User-Agent": agent(),
    };
    // fetch sets the multipart boundary itself; JSON bodies declare their type.
    if (c.json !== undefined) headers["Content-Type"] = "application/json";
    const timeout = AbortSignal.timeout(
      c.long ? timeouts.longMs : timeouts.standardMs,
    );
    const signal = c.signal ? AbortSignal.any([c.signal, timeout]) : timeout;
    // The same signal also bounds reading the body, so aborts mid-body classify the same way.
    const failed = (error: unknown): FacturapiError =>
      error instanceof FacturapiError
        ? error
        : timeout.aborted
          ? new FacturapiError(
              "timeout",
              0,
              "cfdi_provider_timeout",
              "Facturapi did not answer in time",
            )
          : c.signal?.aborted
            ? new FacturapiError(
                "network",
                0,
                "cfdi_request_aborted",
                "request aborted",
              )
            : new FacturapiError(
                "network",
                0,
                "cfdi_provider_network",
                "network error reaching Facturapi",
              );
    let response: Response;
    try {
      response = await request(url.href, {
        method: c.method,
        headers,
        redirect: "error",
        signal,
        ...(c.json !== undefined ? { body: JSON.stringify(c.json) } : {}),
        ...(c.form ? { body: c.form } : {}),
      });
    } catch (error) {
      throw failed(error);
    }
    if (!response.ok) {
      const error = await httpError(response).catch(failed);
      throw error;
    }
    return { response, failed };
  }

  function schemaError(
    status: number,
    issues: z.core.$ZodIssue[],
  ): FacturapiError {
    // Paths only: values may hold personal data.
    const where = issues
      .slice(0, 5)
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    return new FacturapiError(
      "schema",
      status,
      "cfdi_provider_schema",
      `unexpected Facturapi response at ${where}`,
    );
  }

  async function json<T>(
    c: Call,
    schema: z.ZodType<T>,
  ): Promise<{ status: number; data: T }> {
    const { response, failed } = await send(c);
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder().decode(await readLimited(response, MAX_JSON_BYTES)),
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new FacturapiError(
          "schema",
          response.status,
          "cfdi_provider_schema",
          "Facturapi response is not JSON",
        );
      throw failed(error);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw schemaError(response.status, parsed.error.issues);
    return { status: response.status, data: parsed.data };
  }

  async function bytes(c: Call): Promise<Uint8Array> {
    const { response, failed } = await send({ ...c, binary: true });
    let body: Uint8Array;
    try {
      body = await readLimited(response, MAX_FILE_BYTES);
    } catch (error) {
      throw failed(error);
    }
    if (!body.byteLength)
      throw new FacturapiError(
        "schema",
        response.status,
        "cfdi_provider_schema",
        "empty file",
      );
    return body;
  }

  /** Invoice responses are checked against the key's environment (strict separation). */
  function checked(k: FacturapiKey, invoice: FInvoice): FInvoice {
    assertLivemode(invoice, k.kind === "live" ? "live" : "test");
    return invoice;
  }

  const organizations = searchResult(organizationResponse);
  const invoices = searchResult(invoiceResponse);
  const INVOICE_KEYS: FacturapiKeyKind[] = ["test", "live"];

  return {
    async createOrganization(k, body) {
      const key = requireKey(k, ["user"], "createOrganization");
      const input = requestInvalid(
        organizationCreateInput,
        body,
        "organization",
      );
      return (
        await json(
          { method: "POST", path: "/organizations", key, json: input },
          organizationResponse,
        )
      ).data;
    },

    async listOrganizations(k, q) {
      const key = requireKey(k, ["user"], "listOrganizations");
      const query = requestInvalid(z.string().max(200), q, "search");
      return (
        await json(
          {
            method: "GET",
            path: "/organizations",
            key,
            query: { q: query, limit: "50" },
          },
          organizations,
        )
      ).data.data;
    },

    async getOrganization(k, orgId) {
      const key = requireKey(k, ["user"], "getOrganization");
      return (
        await json(
          {
            method: "GET",
            path: `/organizations/${pathId(orgId, "organization")}`,
            key,
          },
          organizationResponse,
        )
      ).data;
    },

    async me(k) {
      const key = requireKey(k, ["test", "live"], "me");
      return (
        await json(
          { method: "GET", path: "/organizations/me", key },
          organizationResponse,
        )
      ).data;
    },

    async updateLegal(k, orgId, body) {
      const key = requireKey(k, ["user", "live"], "updateLegal");
      const input = requestInvalid(legalInput, body, "legal data");
      return (
        await json(
          {
            method: "PUT",
            path: `/organizations/${pathId(orgId, "organization")}/legal`,
            key,
            json: input,
          },
          organizationResponse,
        )
      ).data;
    },

    async uploadCertificate(k, orgId, f) {
      const key = requireKey(k, ["user", "live"], "uploadCertificate");
      if (
        !(f?.cer instanceof Uint8Array) ||
        !(f.key instanceof Uint8Array) ||
        !f.cer.byteLength ||
        !f.key.byteLength ||
        typeof f.password !== "string" ||
        !f.password.length ||
        f.password.length > 256
      )
        throw new FacturapiError(
          "schema",
          0,
          "cfdi_request_invalid",
          "certificate files are invalid",
        );
      const form = new FormData();
      // Field names and file names as the official SDK sends them.
      form.append("cer", new Blob([new Uint8Array(f.cer)]), "cer.cer");
      form.append("key", new Blob([new Uint8Array(f.key)]), "key.key");
      form.append("password", f.password);
      return (
        await json(
          {
            method: "PUT",
            path: `/organizations/${pathId(orgId, "organization")}/certificate`,
            key,
            form,
            long: true,
          },
          organizationResponse,
        )
      ).data;
    },

    async getTestApiKey(k, orgId) {
      const key = requireKey(k, ["user"], "getTestApiKey");
      const secret = (
        await json(
          {
            method: "GET",
            path: `/organizations/${pathId(orgId, "organization")}/apikeys/test`,
            key,
          },
          apiKeyResponse,
        )
      ).data;
      if (keyKindOf(secret) !== "test")
        throw new FacturapiError(
          "schema",
          200,
          "cfdi_key_prefix",
          "the test key has no sk_test_ prefix",
        );
      return secret;
    },

    async createLiveApiKey(k, orgId) {
      const key = requireKey(k, ["user"], "createLiveApiKey");
      const secret = (
        await json(
          {
            method: "PUT",
            path: `/organizations/${pathId(orgId, "organization")}/apikeys/live`,
            key,
          },
          apiKeyResponse,
        )
      ).data;
      if (keyKindOf(secret) !== "live")
        throw new FacturapiError(
          "schema",
          200,
          "cfdi_key_prefix",
          "the live key has no sk_live_ prefix",
        );
      return secret;
    },

    async createInvoice(k, body, signal) {
      const key = requireKey(k, INVOICE_KEYS, "createInvoice");
      const input = requestInvalid(invoiceInput, body, "invoice");
      const { status, data } = await json(
        {
          method: "POST",
          path: "/invoices",
          key,
          json: input,
          long: true,
          signal,
        },
        invoiceResponse,
      );
      const invoice = checked(k, data);
      if (status === 202 && invoice.status !== "pending")
        throw new FacturapiError(
          "schema",
          202,
          "cfdi_provider_schema",
          "202 without status pending",
        );
      return { httpStatus: status === 202 ? 202 : 200, invoice };
    },

    async getInvoice(k, id, signal) {
      const key = requireKey(k, INVOICE_KEYS, "getInvoice");
      return checked(
        k,
        (
          await json(
            {
              method: "GET",
              path: `/invoices/${pathId(id, "invoice")}`,
              key,
              signal,
            },
            invoiceResponse,
          )
        ).data,
      );
    },

    async findInvoiceByExternalId(k, externalId, signal) {
      const key = requireKey(k, INVOICE_KEYS, "findInvoiceByExternalId");
      const external = requestInvalid(
        z.string().uuid(),
        externalId,
        "external_id",
      );
      const found = (
        await json(
          {
            method: "GET",
            path: "/invoices",
            key,
            query: { external_id: external, limit: "10" },
            signal,
          },
          invoices,
        )
      ).data.data
        .filter((i) => i.external_id === external)
        .map((i) => checked(k, i));
      // Stamped CFDIs first (valid, or canceled later), then one still in 202 recovery, then the
      // rest (failed, draft). Two stamped CFDIs for one document must never be hidden.
      const stamped = found.filter(
        (i) => i.status === "valid" || i.status === "canceled",
      );
      if (stamped.length > 1)
        throw new FacturapiError(
          "schema",
          200,
          "cfdi_duplicate_external_id",
          `${stamped.length} stamped invoices share one external_id`,
        );
      return (
        stamped[0] ??
        found.find((i) => i.status === "pending") ??
        found[0] ??
        null
      );
    },

    async cancelInvoice(k, id, q, signal) {
      const key = requireKey(k, INVOICE_KEYS, "cancelInvoice");
      const query = requestInvalid(cancelQuery, q, "cancellation");
      return checked(
        k,
        (
          await json(
            {
              method: "DELETE",
              path: `/invoices/${pathId(id, "invoice")}`,
              key,
              query: { motive: query.motive, substitution: query.substitution },
              long: true,
              signal,
            },
            invoiceResponse,
          )
        ).data,
      );
    },

    async refreshInvoiceStatus(k, id, signal) {
      const key = requireKey(k, INVOICE_KEYS, "refreshInvoiceStatus");
      return checked(
        k,
        (
          await json(
            {
              method: "PUT",
              path: `/invoices/${pathId(id, "invoice")}/status`,
              key,
              signal,
            },
            invoiceResponse,
          )
        ).data,
      );
    },

    async download(k, id, format, signal) {
      const key = requireKey(k, INVOICE_KEYS, "download");
      const f = requestInvalid(z.enum(["xml", "pdf"]), format, "format");
      return bytes({
        method: "GET",
        path: `/invoices/${pathId(id, "invoice")}/${f}`,
        key,
        signal,
      });
    },

    async downloadCancellationReceipt(k, id, format, signal) {
      const key = requireKey(k, INVOICE_KEYS, "downloadCancellationReceipt");
      const f = requestInvalid(z.enum(["xml", "pdf"]), format, "format");
      return bytes({
        method: "GET",
        path: `/invoices/${pathId(id, "invoice")}/cancellation_receipt/${f}`,
        key,
        signal,
      });
    },

    async sendByEmail(k, id, emails, signal) {
      const key = requireKey(k, INVOICE_KEYS, "sendByEmail");
      const input = requestInvalid(emailInput, { email: emails }, "email");
      await json(
        {
          method: "POST",
          path: `/invoices/${pathId(id, "invoice")}/email`,
          key,
          json: input,
          signal,
        },
        okResponse,
      );
    },
  };
}
