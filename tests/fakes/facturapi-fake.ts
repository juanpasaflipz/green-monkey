/**
 * Deterministic in-memory fake of the Facturapi API v2 for cfdi (030) tests and local runs.
 *
 * It implements what server/cfdi/facturapi.ts calls, with the documented paths, key types, request
 * fields and GenericError shape (FacturAPI/facturapi-docs openapi_v2.en.yaml and
 * getting-started/errors.mdx at commit 1c2e617):
 *   organizations: POST/GET /organizations, GET /organizations/{id}, GET /organizations/me,
 *     PUT /organizations/{id}/legal, PUT /organizations/{id}/certificate (multipart),
 *     GET /organizations/{id}/apikeys/test, PUT /organizations/{id}/apikeys/live;
 *   invoices: POST/GET /invoices (idempotency_key, external_id search), GET/DELETE /invoices/{id},
 *     PUT /invoices/{id}/status, GET /invoices/{id}/{xml|pdf}, GET /invoices/{id}/cancellation_receipt/
 *     {xml|pdf}, POST /invoices/{id}/email.
 * It is NOT Facturapi: SAT and PAC validations are reduced to the receptor rules cfdi itself
 * applies, the XML/PDF are synthetic (structure of Anexo 20, CFDI 4.0; no real seal), and each
 * concept is stamped with the rounding cfdi assumes (spec §4.3, half up per concept) unless a
 * fault says otherwise. Passing against the fake proves cfdi's own logic, never provider behaviour.
 *
 * Use:
 *   - in process (no sockets): `const fake = createFacturapiFake(); createFacturapiClient({fetch:
 *     fake.fetch, baseUrl: FAKE_BASE_URL})`;
 *   - over HTTP: `npm run dev:facturapi-fake` (127.0.0.1, port FACTURAPI_FAKE_PORT or --port,
 *     default 4799) with FACTURAPI_BASE_URL=http://127.0.0.1:4799/v2 in the worker.
 *
 * Keys: any `sk_user_…` is the platform User key; `sk_test_…`/`sk_live_…` keys are the ones this
 * fake issued for an organization. An unknown `sk_test_…` key gets its own ready "shared
 * sandbox" organization (the FACTURAPI_TEST_KEY setup). Keys containing "revoked" are refused
 * (user_key_invalid / api_key_invalid).
 *
 * Magic values (substring of customer.legal_name, case-insensitive), for browser and DB tests:
 *   FAKE NAME MISMATCH → 400 legal_name_mismatch      FAKE RFC NOT FOUND   → 400 tax_id_not_found
 *   FAKE ZIP MISMATCH  → 400 tax_address_zip_mismatch FAKE REGIME MISMATCH → 400 tax_system_not_allowed_for_tax_id
 *   FAKE PAC REJECT    → 400 invoice_stamping_validation_error (PAC detail)
 *   FAKE STAMP FAILED  → 400 invoice_stamping_failed   FAKE UNAVAILABLE → 503 invoice_stamping_service_unavailable
 *   FAKE RATE LIMIT    → 429 rate_limit_exceeded, Retry-After: 1
 *   FAKE PENDING       → 202 pending, valid at the next read      FAKE PENDING FAILED → 202, then failed
 *   FAKE TIMEOUT       → creates the invoice, then never answers (once per idempotency key)
 *   FAKE LOST RESPONSE → creates the invoice, then drops the connection (once per idempotency key)
 *   FAKE ROUNDING      → stamps IVA truncated per concept (an amount_check "differs" case)
 *   FAKE SIX DECIMALS  → keeps each concept's Base and Importe at 6 decimals (Base = round6(G/(1+r)),
 *                        Importe = round6(Base·r)) and rounds only the comprobante sums: the other
 *                        reading of Facturapi's rounding (decision D18); the stamped totals can then
 *                        differ from cfdi's expected figures by a centavo
 *   FAKE CANCEL PENDING → a cancellation needs receptor acceptance, accepted at the next read
 * Concepts priced at their base (`tax_included: false`, the RESICO ISR retention of LD-16 L9) are
 * stamped as Base = price, IVA = Base × rate and ISR retained = Base × 1.25 %, each rounded half up
 * per concept; the comprobante carries TotalImpuestosRetenidos and Total = SubTotal + traslados −
 * retenciones.
 *   FAKE REJECT CANCEL  → a cancellation needs acceptance and is rejected at the next read
 * An organization name containing FAKE LOST RESPONSE is created and its response dropped; an
 * email whose local part starts with "bounce" fails delivery. Faults that data cannot carry
 * (globals are always PUBLICO EN GENERAL) are queued with `fault()` or POST /__fake/faults. The
 * queued-only fault "conflict" answers POST /invoices with 409 `conflict` (CommonErrorCode) BEFORE
 * the idempotency lookup, as a retry colliding with a first request still in process would; the
 * next request with the same key gets the invoice. On DELETE /invoices/{id}, the queued faults
 * "unavailable" (503 invoice_cancellation_service_unavailable) and "internal_error" (500) leave the
 * invoice untouched, and "cancel_refused" answers 409 invoice_not_cancelable_by_sat (a final
 * refusal).
 *
 * Control API (loopback CLI only, also methods on the fake): POST /__fake/reset,
 * POST /__fake/faults {op, fault, times?, match?}, POST /__fake/organizations/{id}/manifesto,
 * GET /__fake/state.
 */
import {
  createHash,
  createPrivateKey,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  extractTax,
  regimeAllowedFor,
  REGIMEN_FISCAL,
  rfcKind,
} from "../../shared/fiscal";
import { conceptCentavos } from "../../server/cfdi/build";
import { usoCfdiAllowed } from "../../shared/sat";
import {
  cancelQuery,
  invoiceInput,
  legalInput,
  organizationCreateInput,
  type FInvoiceInput,
  type FLegalInput,
} from "../../server/cfdi/facturapi-schema";

export const FAKE_PORT = 4799;
/** Base URL for in-process use (the injected fetch never opens a socket). */
export const FAKE_BASE_URL = `http://127.0.0.1:${FAKE_PORT}/v2`;

export type FakeOp =
  | "organizations.create"
  | "organizations.legal"
  | "organizations.certificate"
  | "invoices.create"
  | "invoices.get"
  | "invoices.cancel"
  | "invoices.email"
  | "invoices.download";
export type FakeFault =
  | "timeout"
  | "lost_response"
  | "unavailable"
  | "internal_error"
  | "rate_limit"
  | "pending"
  | "pending_failed"
  | "stamp_rejected"
  | "stamp_failed"
  | "rounding"
  | "six_decimals"
  | "conflict"
  | "cancel_pending"
  | "cancel_rejected"
  | "cancel_refused"
  | "email_failed";
export type FaultRule = {
  op: FakeOp;
  fault: FakeFault;
  /** How many matching requests it applies to (default 1). */
  times?: number;
  match?: { type?: "I" | "E"; global?: boolean; series?: string };
};

const faultRule = z
  .object({
    op: z.enum([
      "organizations.create",
      "organizations.legal",
      "organizations.certificate",
      "invoices.create",
      "invoices.get",
      "invoices.cancel",
      "invoices.email",
      "invoices.download",
    ]),
    fault: z.enum([
      "timeout",
      "lost_response",
      "unavailable",
      "internal_error",
      "rate_limit",
      "pending",
      "pending_failed",
      "stamp_rejected",
      "stamp_failed",
      "rounding",
      "six_decimals",
      "conflict",
      "cancel_pending",
      "cancel_rejected",
      "cancel_refused",
      "email_failed",
    ]),
    times: z.number().int().min(1).max(10_000).optional(),
    match: z
      .object({
        type: z.enum(["I", "E"]).optional(),
        global: z.boolean().optional(),
        series: z.string().max(25).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type Legal = FLegalInput & { tax_id: string | null };
type Certificate = {
  rfc: string;
  serial: string;
  validFrom: Date;
  validUntil: Date;
  updatedAt: Date;
};
type Org = {
  id: string;
  name: string;
  createdAt: Date;
  shared: boolean;
  legal: Legal | null;
  certificate: Certificate | null;
  manifesto: boolean;
  testKey: string;
  liveKeys: string[];
};
type Concept = {
  item: FInvoiceInput["items"][number];
  gross: number;
  base: number;
  tax: number | null; // null: exento
  rate: string | null;
  /** ISR retained (RESICO, base-priced concepts); 0 otherwise. */
  withheld: number;
  /** six_decimals mode: Base and Importe kept in micro-pesos (6 decimals) in the XML. */
  micro?: { base: bigint; tax: bigint | null };
};
type Invoice = {
  id: string;
  orgId: string;
  livemode: boolean;
  status: "pending" | "valid" | "canceled" | "failed";
  cancellationStatus:
    "none" | "verifying" | "pending" | "accepted" | "rejected" | "expired";
  uuid: string | null;
  series: string;
  folio: number;
  createdAt: Date;
  date: Date;
  stampedAt: Date | null;
  canceledAt: Date | null;
  body: FInvoiceInput;
  concepts: Concept[];
  subtotal: number;
  tax: number;
  /** TotalImpuestosRetenidos (RESICO ISR). */
  withheld: number;
  total: number;
  issuer: { rfc: string; name: string; regime: string };
  /** Reads left before a pending stamp or cancellation resolves. */
  pendingReads: number;
  pendingOutcome: "valid" | "failed" | null;
  cancel: {
    motive: string;
    substitution: string | null;
    requestedAt: Date;
    reads: number;
    outcome: "accepted" | "rejected";
  } | null;
  emails: string[][];
};
export type FakeRequestLog = {
  method: string;
  path: string;
  key: "user" | "test" | "live" | "none";
  status: number | "hang" | "drop";
  idempotencyKey?: string;
};

type Outcome = Response | { kind: "hang" } | { kind: "drop" };

const MARKERS: [string, FakeFault | "name" | "rfc" | "zip" | "regime"][] = [
  ["FAKE NAME MISMATCH", "name"],
  ["FAKE RFC NOT FOUND", "rfc"],
  ["FAKE ZIP MISMATCH", "zip"],
  ["FAKE REGIME MISMATCH", "regime"],
  ["FAKE PAC REJECT", "stamp_rejected"],
  ["FAKE STAMP FAILED", "stamp_failed"],
  ["FAKE UNAVAILABLE", "unavailable"],
  ["FAKE RATE LIMIT", "rate_limit"],
  ["FAKE PENDING FAILED", "pending_failed"],
  ["FAKE PENDING", "pending"],
  ["FAKE TIMEOUT", "timeout"],
  ["FAKE LOST RESPONSE", "lost_response"],
  ["FAKE ROUNDING", "rounding"],
  ["FAKE SIX DECIMALS", "six_decimals"],
  ["FAKE CANCEL PENDING", "cancel_pending"],
  ["FAKE REJECT CANCEL", "cancel_rejected"],
];

/** Spanish and English messages for the documented codes the fake returns. */
const MESSAGES: Record<string, [string, string]> = {
  conflict: [
    "La solicitud no se puede completar por un conflicto.",
    "The request cannot be completed because of a conflict.",
  ],
  api_key_invalid: [
    "La llave de API es inválida.",
    "The provided API key is invalid.",
  ],
  user_key_invalid: [
    "La llave de usuario es inválida.",
    "The provided user key is invalid.",
  ],
  missing_credentials: [
    "No se enviaron credenciales.",
    "The request did not include credentials.",
  ],
  api_key_not_allowed: [
    "Esta llave no puede realizar esta acción.",
    "The API key cannot perform this action.",
  ],
  not_found: [
    "No se encontró el recurso.",
    "The requested resource was not found.",
  ],
  invoice_not_found: [
    "No se encontró la factura.",
    "The invoice was not found.",
  ],
  organization_not_found: [
    "No se encontró la organización.",
    "The organization was not found.",
  ],
  invalid_request: ["La solicitud no es válida.", "The request is invalid."],
  invalid_json: [
    "El cuerpo de la solicitud no es JSON válido.",
    "The request body is not valid JSON.",
  ],
  idempotency_key_in_use: [
    "La llave de idempotencia ya está siendo utilizada por otra solicitud.",
    "The idempotency key is already being used by another request.",
  ],
  rate_limit_exceeded: [
    "Se excedió el límite de solicitudes.",
    "The request exceeded the allowed rate limit.",
  ],
  internal_error: [
    "Ocurrió un error inesperado.",
    "An unexpected internal error occurred.",
  ],
  organization_incomplete: [
    "La organización no está configurada para esta operación.",
    "The organization is not fully configured for this operation.",
  ],
  legal_name_mismatch: [
    "El nombre o razón social no coincide con el RFC en los registros del SAT.",
    "The name or business name does not match the RFC in SAT records.",
  ],
  tax_id_not_found: [
    "El RFC del receptor no existe en la lista de RFC inscritos no cancelados del SAT.",
    "The receiver RFC does not exist in SAT's list of registered, non-cancelled RFCs.",
  ],
  tax_address_zip_mismatch: [
    "El código postal no coincide con el RFC en los registros del SAT.",
    "The fiscal zip code does not match the RFC in SAT records.",
  ],
  tax_system_not_allowed_for_tax_id: [
    "El régimen fiscal no corresponde al RFC en los registros del SAT.",
    "The tax regime is not allowed for the RFC in SAT records.",
  ],
  invoice_stamping_validation_error: [
    "El PAC rechazó la factura.",
    "The invoice failed stamping validation.",
  ],
  invoice_stamping_failed: [
    "No se pudo timbrar la factura.",
    "The invoice could not be stamped.",
  ],
  invoice_stamping_service_unavailable: [
    "El servicio de timbrado no está disponible.",
    "The stamping service is unavailable.",
  ],
  invoice_not_stamped: [
    "La factura no ha sido timbrada.",
    "The invoice has not been stamped.",
  ],
  invoice_not_cancelable: [
    "La factura no se puede cancelar.",
    "The invoice cannot be canceled.",
  ],
  invoice_cancellation_in_progress: [
    "La factura ya tiene una solicitud de cancelación pendiente.",
    "The invoice already has a pending cancellation request.",
  ],
  invoice_not_cancelable_by_sat: [
    "El SAT no permite cancelar esta factura.",
    "SAT does not allow this invoice to be canceled.",
  ],
  invoice_cancellation_service_unavailable: [
    "El servicio de cancelación no está disponible.",
    "The cancellation service is unavailable.",
  ],
  invoice_cancellation_receipt_unavailable: [
    "El acuse de cancelación no está disponible.",
    "The cancellation receipt is not available.",
  ],
  substitution_invoice_required: [
    "Se requiere la factura que sustituye.",
    "A substitution invoice is required.",
  ],
  substitution_invoice_not_found: [
    "No se encontró la factura que sustituye.",
    "The substitution invoice was not found.",
  ],
  substitution_invoice_status_not_allowed: [
    "La factura que sustituye no está vigente.",
    "The substitution invoice status is not valid for this operation.",
  ],
  invoice_email_delivery_failed: [
    "No se pudo enviar la factura por correo.",
    "The invoice could not be sent by email.",
  ],
  invoice_email_recipient_required: [
    "No hay destinatario de correo para la factura.",
    "No email recipient is available for the invoice.",
  ],
  invoice_email_status_not_allowed: [
    "El estado de la factura no permite enviarla por correo.",
    "The invoice status does not allow email delivery.",
  ],
  certificate_files_invalid: [
    "El certificado o la llave privada no son válidos.",
    "The certificate or private key is invalid, incomplete, or damaged.",
  ],
  certificate_files_required: [
    "No se encontraron archivos en la solicitud.",
    "We could not find any files in your request.",
  ],
  certificate_expired: [
    "El certificado está vencido.",
    "The certificate has expired.",
  ],
  certificate_not_yet_valid: [
    "El certificado aún no es válido.",
    "The certificate cannot be used yet.",
  ],
  certificate_previous_rfc_mismatch: [
    "El RFC del certificado no coincide con el certificado anterior.",
    "The certificate RFC does not match the previous certificate.",
  ],
  csd_required: [
    "El certificado no es un CSD. Asegúrate de no enviar una FIEL.",
    "The certificate is not a CSD. Make sure you are not sending a FIEL.",
  ],
  private_key_password_incorrect: [
    "La contraseña de la llave privada es incorrecta.",
    "The private key password is incorrect.",
  ],
  private_key_certificate_mismatch: [
    "La llave privada no corresponde al certificado.",
    "The private key does not match the certificate.",
  ],
};

const PERIODICITY: Record<string, string> = {
  day: "01",
  week: "02",
  fortnight: "03",
  month: "04",
};
const CFDI_NS = "http://www.sat.gob.mx/cfd/4";
const TFD_NS = "http://www.sat.gob.mx/TimbreFiscalDigital";
const TEST_ISSUER = {
  name: "Organización de prueba",
  legal_name: "ESCUELA KEMPER URGATE",
  tax_system: "601",
  tax_id: "EKU9003173C9",
  address: { zip: "42501" },
};

const pesos = (c: number) => (c / 100).toFixed(2);
/** Micro-pesos (1e-6) → centavos, half up. */
const microToCentavos = (m: bigint) => Number((2n * m + 10_000n) / 20_000n);
/** Micro-pesos as a 6-decimal amount: 13793103n → "13.793103". */
const micro6 = (m: bigint) =>
  `${m / 1_000_000n}.${String(m % 1_000_000n).padStart(6, "0")}`;
/** A concept's Base and Importe in micro-pesos (exact for the 2-decimal modes). */
const microOf = (c: Concept) =>
  c.micro ?? {
    base: BigInt(c.base) * 10_000n,
    tax: c.tax === null ? null : BigInt(c.tax) * 10_000n,
  };
/**
 * Comprobante-level traslados, one per tax rate (Anexo 20): the concepts' Base and Importe summed
 * and rounded once to centavos. Exact sums in the 2-decimal modes; in six_decimals mode this is the
 * only rounding, so the comprobante adds up while each concept keeps 6 decimals.
 */
function rateGroups(
  concepts: Concept[],
): { base: number; tax: number | null; rate: string | null }[] {
  const groups = new Map<
    string,
    { base: bigint; tax: bigint | null; rate: string | null }
  >();
  for (const c of concepts) {
    const m = microOf(c);
    const key = c.tax === null ? "exento" : String(c.rate);
    const g = groups.get(key) ?? {
      base: 0n,
      tax: c.tax === null ? null : 0n,
      rate: c.rate,
    };
    g.base += m.base;
    if (g.tax !== null && m.tax !== null) g.tax += m.tax;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    base: microToCentavos(g.base),
    tax: g.tax === null ? null : microToCentavos(g.tax),
    rate: g.rate,
  }));
}
const xmlEscape = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&apos;",
  );

/** SAT serial numbers are the ASCII digits encoded in the X.509 serial's hex. */
function satSerial(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 === 0) {
    const text = Buffer.from(clean, "hex").toString("latin1");
    if (/^\d{1,40}$/.test(text)) return text;
  }
  return clean.toUpperCase();
}

/** Local wall time (no offset) as CFDI 4.0 writes Fecha. */
function cfdiDate(d: Date, timeZone = "America/Mexico_City"): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** A tiny but well-formed single-page PDF (with an xref table) carrying the given lines. */
export function fakePdf(lines: string[]): Uint8Array<ArrayBuffer> {
  const text = lines
    .map(
      (l, i) =>
        `BT /F1 11 Tf 56 ${760 - i * 16} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`,
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

export interface FacturapiFake {
  /** A fetch that answers every request in process (no sockets). */
  fetch: typeof fetch;
  /** The Fetch API handler (Response, or hang/drop for faults). */
  handle(request: Request): Promise<Outcome>;
  fault(rule: FaultRule): void;
  signManifesto(orgId: string): void;
  reset(): void;
  /** Moves the fake clock (only when created with `now`, see options). */
  advance(ms: number): void;
  readonly requests: FakeRequestLog[];
  readonly organizations: ReadonlyMap<string, Readonly<Org>>;
  readonly invoices: ReadonlyMap<string, Readonly<Invoice>>;
  /** Emails sent: invoice id → recipient lists, in order. */
  readonly emails: { invoiceId: string; to: string[] }[];
  state(): Record<string, unknown>;
}

export function createFacturapiFake(
  o: { now?: Date; seed?: string } = {},
): FacturapiFake {
  const seed = o.seed ?? "green-monkey-facturapi-fake";
  let offsetMs = 0;
  const fixed = o.now ? o.now.getTime() : null;
  const now = () => new Date((fixed ?? Date.now()) + offsetMs);

  let counter = 0;
  let organizations = new Map<string, Org>();
  let invoices = new Map<string, Invoice>();
  let keys = new Map<string, { orgId: string; live: boolean }>();
  let folios = new Map<string, number>();
  let faults: (FaultRule & { left: number })[] = [];
  let emails: { invoiceId: string; to: string[] }[] = [];
  let requests: FakeRequestLog[] = [];
  let firedOnce = new Set<string>();

  const next = () => ++counter;
  const hex = (label: string, n: number) =>
    createHash("sha256").update(`${seed}:${label}:${n}`).digest("hex");
  /** 24-hex ids like Facturapi's ObjectIds, deterministic. */
  const objectId = (label: string) => hex(label, next()).slice(0, 24);
  const uuidFor = (label: string) => {
    const h = hex(label, next());
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };

  function reset() {
    counter = 0;
    organizations = new Map();
    invoices = new Map();
    keys = new Map();
    folios = new Map();
    faults = [];
    emails = [];
    requests = [];
    firedOnce = new Set();
    offsetMs = 0;
  }

  function takeFault(
    op: FakeOp,
    body?: FInvoiceInput,
    accept: (fault: FakeFault) => boolean = () => true,
  ): FakeFault | null {
    const i = faults.findIndex(
      (f) =>
        f.op === op &&
        accept(f.fault) &&
        (!f.match?.type || f.match.type === body?.type) &&
        (f.match?.global === undefined ||
          f.match.global === Boolean(body?.global)) &&
        (!f.match?.series || f.match.series === body?.series),
    );
    if (i === -1) return null;
    const f = faults[i];
    if (--f.left <= 0) faults.splice(i, 1);
    return f.fault;
  }

  function marker(text: string | undefined) {
    const upper = (text ?? "").toUpperCase();
    return MARKERS.find(([m]) => upper.includes(m))?.[1] ?? null;
  }

  // ---- responses ----------------------------------------------------------------------------

  const language = new AsyncLocalStorage<"es" | "en">();
  let logCounter = 0;
  function json(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-facturapi-log-id": `log_fake_${String(++logCounter).padStart(6, "0")}`,
        ...headers,
      },
    });
  }
  function error(
    status: number,
    code: string,
    extra: {
      path?: string;
      location?: string;
      errors?: Record<string, unknown>[];
      message?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const message =
      extra.message ??
      MESSAGES[code]?.[language.getStore() === "en" ? 1 : 0] ??
      code;
    return json(
      status,
      {
        ok: false,
        message,
        status,
        code,
        ...(extra.location ? { location: extra.location } : {}),
        ...(extra.path ? { path: extra.path } : {}),
        ...(extra.errors ? { errors: extra.errors } : {}),
      },
      extra.headers,
    );
  }
  /** invalid_request with one documented detail per field (errors.mdx "Input validation"). */
  function invalidFields(
    fields: { path: string; code: string; location?: string }[],
  ) {
    const errors = fields.slice(0, 20).map((f) => ({
      message: `El campo "${f.path}" no es válido.`,
      code: f.code,
      source: "facturapi",
      location: f.location ?? "body",
      path: f.path,
    }));
    return error(400, "invalid_request", {
      message: errors[0]?.message,
      path: errors[0]?.path,
      location: errors[0]?.location,
      errors,
    });
  }
  function invalid(issues: z.core.$ZodIssue[], location = "body") {
    const subcode = (i: z.core.$ZodIssue) =>
      i.code === "unrecognized_keys"
        ? "unknown_field"
        : i.code === "too_big"
          ? "too_large"
          : i.code === "too_small"
            ? "too_small"
            : i.code === "invalid_format"
              ? "invalid_format"
              : i.code === "invalid_type"
                ? "invalid_type"
                : i.code === "invalid_value"
                  ? "not_allowed"
                  : "invalid_value";
    return invalidFields(
      issues.map((i) => ({
        path: [
          ...i.path,
          ...(i.code === "unrecognized_keys" ? [i.keys[0]] : []),
        ].join("."),
        code: subcode(i),
        location,
      })),
    );
  }

  function orgView(org: Org) {
    const legal = org.legal;
    const pending = [
      ...(!legal
        ? [
            {
              type: "legal",
              description: "Completa los datos fiscales de la organización",
            },
          ]
        : []),
      ...(!org.certificate
        ? [
            {
              type: "certificate",
              description: "Sube tu Certificado de Sello Digital (CSD)",
            },
          ]
        : []),
      ...(!org.manifesto
        ? [{ type: "manifiesto", description: "Firma la carta manifiesto" }]
        : []),
    ];
    return {
      id: org.id,
      created_at: org.createdAt.toISOString(),
      timezone: "America/Mexico_City",
      is_production_ready: pending.length === 0,
      pending_steps: pending,
      legal: legal
        ? {
            name: legal.name,
            legal_name: legal.legal_name,
            tax_system: legal.tax_system,
            ...(legal.tax_id ? { tax_id: legal.tax_id } : {}),
            address: legal.address,
          }
        : {
            name: org.name,
            ...(org.certificate ? { tax_id: org.certificate.rfc } : {}),
          },
      certificate: org.certificate
        ? {
            has_certificate: true,
            updated_at: org.certificate.updatedAt.toISOString(),
            expires_at: org.certificate.validUntil.toISOString(),
            serial_number: org.certificate.serial,
          }
        : { has_certificate: false },
    };
  }

  function verificationUrl(inv: Invoice) {
    return (
      "https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?id=" +
      `${inv.uuid}&re=${inv.issuer.rfc}&rr=${inv.body.customer.tax_id}&tt=${(inv.total / 100).toFixed(6)}&fe=RkFLRQ==`
    );
  }

  function invoiceView(inv: Invoice) {
    const stamped = inv.status === "valid" || inv.status === "canceled";
    return {
      id: inv.id,
      created_at: inv.createdAt.toISOString(),
      livemode: inv.livemode,
      status: inv.status,
      cancellation_status: inv.cancellationStatus,
      ...(inv.canceledAt ? { canceled_at: inv.canceledAt.toISOString() } : {}),
      ...(stamped ? { verification_url: verificationUrl(inv) } : {}),
      date: inv.date.toISOString(),
      address: inv.body.address,
      type: inv.body.type,
      customer: {
        legal_name: inv.body.customer.legal_name,
        tax_id: inv.body.customer.tax_id,
        address: { country: "MEX" },
      },
      total: Number((inv.total / 100).toFixed(2)),
      ...(stamped ? { uuid: inv.uuid } : {}),
      folio_number: inv.folio,
      series: inv.series,
      external_id: inv.body.external_id,
      idempotency_key: inv.body.idempotency_key,
      payment_form: inv.body.payment_form,
      items: inv.body.items.map((i) => ({ ...i, discount: 0 })),
      related_documents: inv.body.related_documents ?? [],
      currency: "MXN",
      exchange: 1,
      ...(inv.body.pdf_custom_section
        ? { pdf_custom_section: inv.body.pdf_custom_section }
        : {}),
      ...(stamped && inv.stampedAt
        ? {
            stamp: {
              date: inv.stampedAt.toISOString(),
              sat_cert_number: "30001000000500003456",
              signature: "FAKE",
              sat_signature: "FAKE",
            },
          }
        : {}),
    };
  }

  function xml(inv: Invoice): string {
    const b = inv.body;
    const attrs = (pairs: [string, string | null | undefined][]) =>
      pairs
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}="${xmlEscape(String(v))}"`)
        .join(" ");
    const traslado = (base: string, tax: string | null, rate: string | null) =>
      `<cfdi:Traslado ${attrs([
        ["Base", base],
        ["Impuesto", "002"],
        ["TipoFactor", tax === null ? "Exento" : "Tasa"],
        ["TasaOCuota", rate],
        ["Importe", tax],
      ])}/>`;
    const concepts = inv.concepts
      .map((c) => {
        const qty = c.item.quantity;
        const m = microOf(c);
        // Concept amounts: 2 decimals, or the 6 decimals of the six_decimals mode.
        const amount = (centavos: number, micros: bigint) =>
          c.micro ? micro6(micros) : pesos(centavos);
        // ValorUnitario = Importe / Cantidad at 6 decimals, rounded half up (exact integers).
        const qtyMicros = BigInt(Math.round(qty * 1_000_000));
        const unit = micro6(
          (2n * m.base * 1_000_000n + qtyMicros) / (2n * qtyMicros),
        );
        return (
          `<cfdi:Concepto ${attrs([
            ["ClaveProdServ", c.item.product.product_key],
            ["NoIdentificacion", c.item.product.sku],
            ["Cantidad", String(qty)],
            ["ClaveUnidad", c.item.product.unit_key],
            ["Unidad", c.item.product.unit_name],
            ["Descripcion", c.item.product.description],
            ["ValorUnitario", unit],
            ["Importe", amount(c.base, m.base)],
            ["ObjetoImp", "02"],
          ])}>` +
          `<cfdi:Impuestos><cfdi:Traslados>${traslado(
            amount(c.base, m.base),
            c.tax === null || m.tax === null ? null : amount(c.tax, m.tax),
            c.rate,
          )}</cfdi:Traslados>${
            c.withheld
              ? `<cfdi:Retenciones><cfdi:Retencion ${attrs([
                  ["Base", pesos(c.base)],
                  ["Impuesto", "001"],
                  ["TipoFactor", "Tasa"],
                  ["TasaOCuota", "0.012500"],
                  ["Importe", pesos(c.withheld)],
                ])}/></cfdi:Retenciones>`
              : ""
          }</cfdi:Impuestos></cfdi:Concepto>`
        );
      })
      .join("");
    const anyTaxed = inv.concepts.some((c) => c.tax !== null);
    const related = b.related_documents?.length
      ? b.related_documents
          .map(
            (r) =>
              `<cfdi:CfdiRelacionados TipoRelacion="${r.relationship}">${r.documents
                .map((u) => `<cfdi:CfdiRelacionado UUID="${u.toUpperCase()}"/>`)
                .join("")}</cfdi:CfdiRelacionados>`,
          )
          .join("")
      : "";
    const global = b.global
      ? `<cfdi:InformacionGlobal Periodicidad="${PERIODICITY[b.global.periodicity]}" Meses="${b.global.months}" Año="${b.global.year}"/>`
      : "";
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<cfdi:Comprobante xmlns:cfdi="${CFDI_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="${CFDI_NS} http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd" ${attrs(
        [
          ["Version", "4.0"],
          ["Serie", inv.series],
          ["Folio", String(inv.folio)],
          ["Fecha", cfdiDate(inv.date)],
          ["Sello", "FAKE"],
          ["FormaPago", b.payment_form],
          ["NoCertificado", "30001000000500003416"],
          ["Certificado", "FAKE"],
          ["SubTotal", pesos(inv.subtotal)],
          ["Moneda", "MXN"],
          ["Total", pesos(inv.total)],
          ["TipoDeComprobante", b.type],
          ["Exportacion", "01"],
          ["MetodoPago", b.payment_method],
          ["LugarExpedicion", b.address.zip],
        ],
      )}>` +
      global +
      related +
      `<cfdi:Emisor ${attrs([
        ["Rfc", inv.issuer.rfc],
        ["Nombre", inv.issuer.name],
        ["RegimenFiscal", inv.issuer.regime],
      ])}/>` +
      `<cfdi:Receptor ${attrs([
        ["Rfc", b.customer.tax_id],
        ["Nombre", b.customer.legal_name],
        ["DomicilioFiscalReceptor", b.customer.address.zip],
        ["RegimenFiscalReceptor", b.customer.tax_system],
        ["UsoCFDI", b.use],
      ])}/>` +
      `<cfdi:Conceptos>${concepts}</cfdi:Conceptos>` +
      `<cfdi:Impuestos${inv.withheld ? ` TotalImpuestosRetenidos="${pesos(inv.withheld)}"` : ""}${anyTaxed ? ` TotalImpuestosTrasladados="${pesos(inv.tax)}"` : ""}>${
        inv.withheld
          ? `<cfdi:Retenciones><cfdi:Retencion Impuesto="001" Importe="${pesos(inv.withheld)}"/></cfdi:Retenciones>`
          : ""
      }<cfdi:Traslados>${rateGroups(inv.concepts)
        .map((g) =>
          traslado(pesos(g.base), g.tax === null ? null : pesos(g.tax), g.rate),
        )
        .join("")}</cfdi:Traslados></cfdi:Impuestos>` +
      `<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="${TFD_NS}" ${attrs(
        [
          ["Version", "1.1"],
          ["UUID", inv.uuid?.toUpperCase()],
          ["FechaTimbrado", cfdiDate(inv.stampedAt ?? inv.date)],
          ["RfcProvCertif", "SPR190613I52"],
          ["SelloCFD", "FAKE"],
          ["NoCertificadoSAT", "30001000000500003456"],
          ["SelloSAT", "FAKE"],
        ],
      )}/></cfdi:Complemento>` +
      `</cfdi:Comprobante>\n`
    );
  }

  function acuse(inv: Invoice): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n<Acuse Fecha="${cfdiDate(inv.canceledAt ?? now())}" RfcEmisor="${inv.issuer.rfc}">` +
      `<Folios><UUID>${inv.uuid?.toUpperCase()}</UUID><EstatusUUID>201</EstatusUUID></Folios></Acuse>\n`
    );
  }

  // ---- auth -----------------------------------------------------------------------------------

  type Auth = { kind: "user" } | { kind: "test" | "live"; org: Org };
  function auth(request: Request): Auth | Response {
    const header = request.headers.get("authorization") ?? "";
    const m = /^Bearer (sk_(user|test|live)_[A-Za-z0-9_.-]+)$/.exec(header);
    if (!m) return error(401, "missing_credentials");
    const [, secret, kind] = m;
    if (secret.includes("revoked"))
      return error(
        401,
        kind === "user" ? "user_key_invalid" : "api_key_invalid",
      );
    if (kind === "user") return { kind: "user" };
    const known = keys.get(secret);
    if (known) {
      const org = organizations.get(known.orgId);
      if (!org) return error(401, "api_key_invalid");
      return { kind: known.live ? "live" : "test", org };
    }
    if (kind === "live") return error(401, "api_key_invalid");
    // FACTURAPI_TEST_KEY without an organization here: a ready shared sandbox organization.
    const org: Org = {
      id: objectId("org"),
      name: TEST_ISSUER.name,
      createdAt: now(),
      shared: true,
      legal: { ...TEST_ISSUER },
      certificate: null,
      manifesto: false,
      testKey: secret,
      liveKeys: [],
    };
    organizations.set(org.id, org);
    keys.set(secret, { orgId: org.id, live: false });
    return { kind: "test", org };
  }

  // ---- organizations --------------------------------------------------------------------------

  function newOrg(name: string): Org {
    const id = objectId("org");
    const org: Org = {
      id,
      name,
      createdAt: now(),
      shared: false,
      legal: null,
      certificate: null,
      manifesto: false,
      testKey: `sk_test_fake${id}`,
      liveKeys: [],
    };
    organizations.set(id, org);
    keys.set(org.testKey, { orgId: id, live: false });
    return org;
  }

  async function readJson(request: Request): Promise<unknown | Response> {
    try {
      return await request.json();
    } catch {
      return error(400, "invalid_json");
    }
  }

  async function certificate(org: Org, request: Request): Promise<Response> {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return error(400, "certificate_files_required", { location: "files" });
    }
    const cer = form.get("cer");
    const key = form.get("key");
    const password = form.get("password");
    if (!(cer instanceof Blob) || !(key instanceof Blob))
      return error(400, "certificate_files_required", { location: "files" });
    if (typeof password !== "string")
      return invalidFields([{ path: "password", code: "required" }]);
    const cerBytes = Buffer.from(await cer.arrayBuffer());
    const keyBytes = Buffer.from(await key.arrayBuffer());
    let parsed:
      | {
          rfc: string;
          serial: string;
          validFrom: Date;
          validUntil: Date;
          fiel: boolean;
        }
      | Response;

    const synthetic = /^FAKE-CSD;/.test(cerBytes.toString("latin1"));
    if (synthetic) {
      // Fake-only format for unit tests that cannot build X.509 files:
      //   cer "FAKE-CSD;rfc=…;serial=…;from=ISO;until=ISO[;type=fiel]"  key "FAKE-KEY;serial=…;password=…"
      const fields = (text: string) =>
        Object.fromEntries(
          text
            .trim()
            .split(";")
            .slice(1)
            .map((p) => p.split("=") as [string, string]),
        );
      const c = fields(cerBytes.toString("latin1"));
      const k = fields(keyBytes.toString("latin1"));
      if (
        !c.rfc ||
        !c.serial ||
        !c.from ||
        !c.until ||
        !/^FAKE-KEY;/.test(keyBytes.toString("latin1"))
      )
        return error(400, "certificate_files_invalid", { location: "files" });
      if (k.password !== password)
        return error(400, "private_key_password_incorrect", {
          location: "body",
          path: "password",
        });
      if (k.serial !== c.serial)
        return error(400, "private_key_certificate_mismatch", {
          location: "files",
        });
      parsed = {
        rfc: c.rfc,
        serial: c.serial,
        validFrom: new Date(c.from),
        validUntil: new Date(c.until),
        fiel: c.type === "fiel",
      };
    } else {
      let x509: X509Certificate;
      try {
        x509 = new X509Certificate(cerBytes);
      } catch {
        return error(400, "certificate_files_invalid", { location: "files" });
      }
      let privateKey: KeyObject;
      try {
        privateKey = createPrivateKey(
          keyBytes.subarray(0, 11).toString("latin1") === "-----BEGIN "
            ? { key: keyBytes, passphrase: password }
            : {
                key: keyBytes,
                format: "der",
                type: "pkcs8",
                passphrase: password,
              },
        );
      } catch {
        return error(400, "private_key_password_incorrect", {
          location: "body",
          path: "password",
        });
      }
      if (!x509.checkPrivateKey(privateKey))
        return error(400, "private_key_certificate_mismatch", {
          location: "files",
        });
      // SAT puts "RFC / CURP-RFC" in x500UniqueIdentifier (OID 2.5.4.45).
      const rfc =
        /(?:x500UniqueIdentifier|2\.5\.4\.45)=([A-ZÑ&0-9]{12,13})/.exec(
          x509.subject,
        )?.[1] ?? "";
      parsed = {
        rfc,
        serial: satSerial(x509.serialNumber),
        validFrom: new Date(x509.validFrom),
        validUntil: new Date(x509.validTo),
        fiel: false,
      };
    }
    if (parsed.fiel) return error(400, "csd_required", { location: "files" });
    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(parsed.rfc))
      return error(400, "certificate_invalid", { location: "files" });
    if (parsed.validUntil.getTime() <= now().getTime())
      return error(400, "certificate_expired", { location: "files" });
    if (parsed.validFrom.getTime() > now().getTime())
      return error(400, "certificate_not_yet_valid", { location: "files" });
    if (org.certificate && org.certificate.rfc !== parsed.rfc)
      return error(400, "certificate_previous_rfc_mismatch", {
        location: "files",
      });
    org.certificate = {
      rfc: parsed.rfc,
      serial: parsed.serial,
      validFrom: parsed.validFrom,
      validUntil: parsed.validUntil,
      updatedAt: now(),
    };
    org.legal = org.legal ? { ...org.legal, tax_id: parsed.rfc } : null;
    return json(200, orgView(org));
  }

  // ---- invoices -------------------------------------------------------------------------------

  /** Receptor rules cfdi applies itself (shared/sat.ts), plus the global-invoice node rule. */
  function receptorError(b: FInvoiceInput): Response | null {
    const c = b.customer;
    if (c.tax_id === "XEXX010101000")
      return invalidFields([{ path: "customer.tax_id", code: "not_allowed" }]);
    if (c.tax_id === "XAXX010101000") {
      if (
        c.legal_name !== "PUBLICO EN GENERAL" ||
        c.tax_system !== "616" ||
        b.use !== "S01"
      )
        return invalidFields([{ path: "customer", code: "invalid_value" }]);
      // Anexo 20: InformacionGlobal is required for a público en general ingreso.
      if (b.type === "I" && !b.global)
        return invalidFields([{ path: "global", code: "required" }]);
      return null;
    }
    const kind = rfcKind(c.tax_id);
    if (
      !REGIMEN_FISCAL[c.tax_system] ||
      !kind ||
      !regimeAllowedFor(c.tax_system, kind)
    )
      return error(400, "tax_system_not_allowed_for_tax_id", {
        path: "customer.tax_system",
        location: "body",
      });
    if (!usoCfdiAllowed(c.tax_system, b.use))
      return invalidFields([{ path: "use", code: "not_allowed" }]);
    return null;
  }

  function stamp(inv: Invoice) {
    inv.status = "valid";
    inv.uuid = uuidFor("uuid");
    inv.stampedAt = now();
  }

  /**
   * Concept amounts. "half_up" is the rounding cfdi assumes (spec §4.3); "truncate" is FAKE
   * ROUNDING; "six_decimals" is the other reading of Facturapi's docs (pdf_options.round_unit_price:
   * "keep the 6 decimals in the XML"): Base = round6(gross / (1 + r)) and Importe = round6(Base · r)
   * per concept, and the comprobante rounds only the sums to 2 decimals (decision D18 hypothesis).
   */
  function concepts(
    b: FInvoiceInput,
    mode: "half_up" | "truncate" | "six_decimals",
  ): Concept[] {
    const halfUp = (centavos: number, bps: number) =>
      Math.floor((centavos * bps * 2 + 10000) / 20000);
    return b.items.map((item) => {
      const t = item.product.taxes[0];
      const isr = item.product.taxes[1];
      if (!item.product.tax_included) {
        // Base-priced concept (RESICO retention): Base = price, IVA and ISR on the base.
        const base = conceptCentavos(item);
        const rate = t.factor === "Exento" ? null : Math.round(t.rate * 10000);
        const tax =
          rate === null
            ? null
            : mode === "truncate"
              ? Math.floor((base * rate) / 10000)
              : halfUp(base, rate);
        return {
          item,
          gross: base + (tax ?? 0),
          base,
          tax,
          rate: rate === null ? null : t.rate.toFixed(6),
          withheld: isr ? halfUp(base, 125) : 0,
        };
      }
      const gross = conceptCentavos(item);
      if (t.factor === "Exento")
        return {
          item,
          gross,
          base: gross,
          tax: null,
          rate: null,
          withheld: 0,
          ...(mode === "six_decimals"
            ? { micro: { base: BigInt(gross) * 10_000n, tax: null } }
            : {}),
        };
      const rate = Math.round(t.rate * 10000);
      if (mode === "six_decimals") {
        const d = BigInt(10000 + rate);
        const base6 = (2n * BigInt(gross) * 10_000n * 10_000n + d) / (2n * d);
        const tax6 = (2n * base6 * BigInt(rate) + 10_000n) / 20_000n;
        return {
          item,
          gross,
          base: microToCentavos(base6),
          tax: microToCentavos(tax6),
          rate: t.rate.toFixed(6),
          withheld: 0,
          micro: { base: base6, tax: tax6 },
        };
      }
      const tax =
        mode === "truncate"
          ? Math.floor((gross * rate) / (10000 + rate))
          : extractTax(gross, rate).tax;
      return {
        item,
        gross,
        base: gross - tax,
        tax,
        rate: t.rate.toFixed(6),
        withheld: 0,
      };
    });
  }

  async function createInvoice(
    a: Auth & { kind: "test" | "live" },
    request: Request,
    log: FakeRequestLog,
  ): Promise<Outcome> {
    const raw = await readJson(request);
    if (raw instanceof Response) return raw;
    const key = (raw as { idempotency_key?: unknown } | null)?.idempotency_key;
    if (typeof key === "string") log.idempotencyKey = key;
    const parsed = invoiceInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.issues);
    const b = parsed.data;
    const live = a.kind === "live";
    const org = a.org;

    // A queued "conflict" answers 409 `conflict` (CommonErrorCode) before the idempotency lookup:
    // the shape of a retry that collides with a first request Facturapi is still processing.
    if (takeFault("invoices.create", b, (f) => f === "conflict"))
      return error(409, "conflict");
    // Idempotency: the same key returns the same invoice (this fake answers synchronously, so a
    // key is never "in use"; idempotency_key_in_use is covered by the contract fixtures).
    const idemKey = `${org.id}:${live}:${b.idempotency_key}`;
    const existing = [...invoices.values()].find(
      (i) =>
        i.orgId === org.id &&
        i.livemode === live &&
        i.body.idempotency_key === b.idempotency_key,
    );
    if (existing)
      return json(
        existing.status === "pending" ? 202 : 200,
        invoiceView(existing),
      );

    const fault =
      takeFault("invoices.create", b, (f) => f !== "conflict") ??
      marker(b.customer.legal_name);
    switch (fault) {
      case "name":
        return error(400, "legal_name_mismatch", {
          path: "customer.legal_name",
          location: "body",
        });
      case "rfc":
        return error(400, "tax_id_not_found", {
          path: "customer.tax_id",
          location: "body",
        });
      case "zip":
        return error(400, "tax_address_zip_mismatch", {
          path: "customer.address.zip",
          location: "body",
        });
      case "regime":
        return error(400, "tax_system_not_allowed_for_tax_id", {
          path: "customer.tax_system",
          location: "body",
        });
      case "stamp_rejected":
        return error(400, "invoice_stamping_validation_error", {
          message:
            "CFDI40145: El campo Nombre del receptor no corresponde con el RFC.",
          errors: [
            {
              message:
                "CFDI40145: El campo Nombre del receptor no corresponde con el RFC.",
              code: "CFDI40145",
              source: "sat",
            },
          ],
        });
      case "stamp_failed":
        return error(400, "invoice_stamping_failed");
      case "unavailable":
        return error(503, "invoice_stamping_service_unavailable");
      case "internal_error":
        return error(500, "internal_error");
      case "rate_limit":
        return error(429, "rate_limit_exceeded", {
          headers: { "retry-after": "1" },
        });
    }
    const bad = receptorError(b);
    if (bad) return bad;
    if (!org.legal) return error(400, "organization_incomplete");
    if (live) {
      if (!org.certificate || !org.manifesto)
        return error(400, "organization_incomplete");
      if (org.certificate.validUntil.getTime() <= now().getTime())
        return error(400, "certificate_expired");
    }

    const lines = concepts(
      b,
      fault === "rounding"
        ? "truncate"
        : fault === "six_decimals"
          ? "six_decimals"
          : "half_up",
    );
    // SubTotal = Σ concept Importe and TotalImpuestosTrasladados = Σ comprobante traslados, each
    // rounded once (exact sums in the 2-decimal modes; six_decimals rounds only here).
    const subtotal = microToCentavos(
      lines.reduce((s, c) => s + microOf(c).base, 0n),
    );
    const tax = rateGroups(lines).reduce((s, g) => s + (g.tax ?? 0), 0);
    const withheld = lines.reduce((s, c) => s + c.withheld, 0);
    const folioKey = `${org.id}:${live}:${b.series}`;
    const folio = (folios.get(folioKey) ?? 0) + 1;
    folios.set(folioKey, folio);
    const at = now();
    const inv: Invoice = {
      id: objectId("invoice"),
      orgId: org.id,
      livemode: live,
      status: "pending",
      cancellationStatus: "none",
      uuid: null,
      series: b.series,
      folio,
      createdAt: at,
      date: at,
      stampedAt: null,
      canceledAt: null,
      body: b,
      concepts: lines,
      subtotal,
      tax,
      withheld,
      total: subtotal + tax - withheld,
      issuer: {
        rfc: org.certificate?.rfc ?? org.legal.tax_id ?? TEST_ISSUER.tax_id,
        name: org.legal.legal_name,
        regime: org.legal.tax_system,
      },
      pendingReads: 0,
      pendingOutcome: null,
      cancel: null,
      emails: [],
    };
    invoices.set(inv.id, inv);

    if (fault === "pending" || fault === "pending_failed") {
      inv.pendingReads = 1;
      inv.pendingOutcome = fault === "pending" ? "valid" : "failed";
      return json(202, invoiceView(inv));
    }
    stamp(inv);
    if (
      (fault === "timeout" || fault === "lost_response") &&
      !firedOnce.has(`${fault}:${idemKey}`)
    ) {
      firedOnce.add(`${fault}:${idemKey}`);
      if (fault === "timeout") return { kind: "hang" };
      return { kind: "drop" };
    }
    return json(200, invoiceView(inv));
  }

  /** A read advances pending stamps and cancellations (Facturapi's recovery and SAT acceptance). */
  function advanceOnRead(inv: Invoice) {
    if (inv.status === "pending" && inv.pendingOutcome) {
      if (--inv.pendingReads <= 0) {
        if (inv.pendingOutcome === "valid") stamp(inv);
        else inv.status = "failed";
        inv.pendingOutcome = null;
      }
    }
    if (
      inv.cancel &&
      (inv.cancellationStatus === "pending" ||
        inv.cancellationStatus === "verifying")
    ) {
      if (--inv.cancel.reads <= 0) {
        inv.cancellationStatus = inv.cancel.outcome;
        if (inv.cancel.outcome === "accepted") {
          inv.status = "canceled";
          inv.canceledAt = now();
        }
      }
    }
  }

  function findInvoice(
    a: Auth & { kind: "test" | "live" },
    id: string,
  ): Invoice | Response {
    const inv = invoices.get(id);
    if (!inv || inv.orgId !== a.org.id || inv.livemode !== (a.kind === "live"))
      return error(404, "invoice_not_found");
    return inv;
  }

  function cancelInvoice(
    a: Auth & { kind: "test" | "live" },
    inv: Invoice,
    url: URL,
  ): Response {
    const query = cancelQuery.safeParse(
      Object.fromEntries(
        [...url.searchParams].filter(
          ([k]) => k === "motive" || k === "substitution",
        ),
      ),
    );
    if (!query.success) {
      if (
        url.searchParams.get("motive") === "01" &&
        !url.searchParams.get("substitution")
      )
        return error(400, "substitution_invoice_required", {
          path: "substitution",
          location: "query",
        });
      return invalid(query.error.issues, "query");
    }
    if (inv.status !== "valid") return error(409, "invoice_not_cancelable");
    if (
      inv.cancellationStatus === "pending" ||
      inv.cancellationStatus === "verifying"
    )
      return error(409, "invoice_cancellation_in_progress");
    const q = query.data;
    if (q.motive === "01") {
      const sub = [...invoices.values()].find(
        (i) =>
          i.orgId === a.org.id &&
          i.livemode === inv.livemode &&
          i.uuid?.toLowerCase() === q.substitution?.toLowerCase(),
      );
      if (!sub)
        return error(400, "substitution_invoice_not_found", {
          path: "substitution",
          location: "query",
        });
      if (sub.status !== "valid")
        return error(400, "substitution_invoice_status_not_allowed", {
          path: "substitution",
          location: "query",
        });
    }
    const fault =
      takeFault("invoices.cancel", inv.body) ??
      marker(inv.body.customer.legal_name);
    if (fault === "unavailable")
      return error(503, "invoice_cancellation_service_unavailable");
    if (fault === "internal_error") return error(500, "internal_error");
    if (fault === "cancel_refused")
      return error(409, "invoice_not_cancelable_by_sat");
    // SAT (FAQ cancelación 2026, Q12): no acceptance for público en general, totals up to
    // $1,000.00, egresos, or within 24 h of issuance.
    const needsAcceptance =
      fault === "cancel_pending" ||
      fault === "cancel_rejected" ||
      !(
        inv.body.customer.tax_id === "XAXX010101000" ||
        inv.total <= 100_000 ||
        inv.body.type === "E" ||
        now().getTime() - (inv.stampedAt ?? inv.date).getTime() <= 24 * 3600_000
      );
    inv.cancel = {
      motive: q.motive,
      substitution: q.substitution ?? null,
      requestedAt: now(),
      reads: 1,
      outcome: fault === "cancel_rejected" ? "rejected" : "accepted",
    };
    if (needsAcceptance) inv.cancellationStatus = "pending";
    else {
      inv.status = "canceled";
      inv.cancellationStatus = "accepted";
      inv.canceledAt = now();
    }
    return json(200, invoiceView(inv));
  }

  async function sendEmail(inv: Invoice, request: Request): Promise<Response> {
    let to: string[] = [];
    const text = await request.text();
    if (text) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return error(400, "invalid_json");
      }
      const parsed = z
        .object({
          email: z.union([z.email(), z.array(z.email()).max(10)]).optional(),
        })
        .strict()
        .safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues);
      const e = parsed.data.email;
      to = e === undefined ? [] : Array.isArray(e) ? e : [e];
    }
    if (!to.length && inv.body.customer.email) to = [inv.body.customer.email];
    if (!to.length) return error(400, "invoice_email_recipient_required");
    if (inv.status !== "valid" && inv.status !== "canceled")
      return error(400, "invoice_email_status_not_allowed");
    const fault = takeFault("invoices.email", inv.body);
    if (fault === "email_failed" || to.some((t) => /^bounce/i.test(t)))
      return error(400, "invoice_email_delivery_failed");
    inv.emails.push(to);
    emails.push({ invoiceId: inv.id, to });
    return json(200, { ok: true });
  }

  // ---- router ---------------------------------------------------------------------------------

  async function route(
    request: Request,
    url: URL,
    log: FakeRequestLog,
  ): Promise<Outcome> {
    const path =
      url.pathname.replace(/^\/v2(?=\/)/, "").replace(/\/+$/, "") || "/";
    const method = request.method;

    // Control API.
    if (path.startsWith("/__fake/")) {
      if (method === "POST" && path === "/__fake/reset") {
        reset();
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path === "/__fake/faults") {
        const body = faultRule.safeParse(
          await request.json().catch(() => null),
        );
        if (!body.success) return invalid(body.error.issues);
        fault(body.data);
        return new Response(null, { status: 204 });
      }
      const m = /^\/__fake\/organizations\/([A-Za-z0-9_-]+)\/manifesto$/.exec(
        path,
      );
      if (method === "POST" && m) {
        if (!organizations.has(m[1]))
          return error(404, "organization_not_found");
        signManifesto(m[1]);
        return new Response(null, { status: 204 });
      }
      if (method === "GET" && path === "/__fake/state")
        return json(200, state());
      return error(404, "not_found");
    }

    const a = auth(request);
    if (a instanceof Response) return a;
    log.key = a.kind;
    const userOnly = () =>
      a.kind === "user" ? null : error(403, "api_key_not_allowed");

    // Organizations.
    if (path === "/organizations") {
      const denied = userOnly();
      if (denied) return denied;
      if (method === "POST") {
        const raw = await readJson(request);
        if (raw instanceof Response) return raw;
        const parsed = organizationCreateInput.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error.issues);
        const org = newOrg(parsed.data.name);
        const f =
          takeFault("organizations.create") ??
          (marker(parsed.data.name) === "lost_response"
            ? "lost_response"
            : null);
        if (f === "lost_response") return { kind: "drop" };
        if (f === "unavailable" || f === "internal_error")
          return error(500, "internal_error");
        return json(200, orgView(org));
      }
      if (method === "GET") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
          100,
        );
        const data = [...organizations.values()]
          .filter((o) => !o.shared && o.name.toLowerCase().includes(q))
          .slice(0, limit)
          .map(orgView);
        return json(200, {
          page: 1,
          total_pages: 1,
          total_results: data.length,
          data,
        });
      }
    }
    if (path === "/organizations/me" && method === "GET") {
      if (a.kind === "user") return error(403, "api_key_not_allowed");
      return json(200, orgView(a.org));
    }
    let m =
      /^\/organizations\/([A-Za-z0-9_-]+)(?:\/(legal|certificate|apikeys\/test|apikeys\/live))?$/.exec(
        path,
      );
    if (m) {
      const org = organizations.get(m[1]);
      const own = a.kind !== "user" && a.org.id === m[1];
      if (!org || (a.kind !== "user" && !own))
        return error(404, "organization_not_found");
      const sub = m[2];
      if (!sub && method === "GET") return json(200, orgView(org));
      if (sub === "legal" && method === "PUT") {
        if (a.kind === "test") return error(403, "api_key_not_allowed");
        const raw = await readJson(request);
        if (raw instanceof Response) return raw;
        const parsed = legalInput.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error.issues);
        if (takeFault("organizations.legal"))
          return error(500, "internal_error");
        org.legal = { ...parsed.data, tax_id: org.certificate?.rfc ?? null };
        return json(200, orgView(org));
      }
      if (sub === "certificate" && method === "PUT") {
        if (a.kind === "test") return error(403, "api_key_not_allowed");
        const f = takeFault("organizations.certificate");
        if (f === "unavailable" || f === "internal_error")
          return error(500, "internal_error");
        return certificate(org, request);
      }
      if (sub === "apikeys/test" && method === "GET") {
        const denied = userOnly();
        if (denied) return denied;
        return json(200, org.testKey);
      }
      if (sub === "apikeys/live" && method === "PUT") {
        const denied = userOnly();
        if (denied) return denied;
        const key = `sk_live_fake${org.id}k${org.liveKeys.length + 1}`;
        org.liveKeys.push(key);
        keys.set(key, { orgId: org.id, live: true });
        return json(200, key);
      }
      return error(404, "not_found");
    }

    // Invoices.
    if (path === "/invoices") {
      if (a.kind === "user") return error(403, "api_key_not_allowed");
      if (method === "POST") return createInvoice(a, request, log);
      if (method === "GET") {
        const external = url.searchParams.get("external_id");
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
          100,
        );
        const data = [...invoices.values()]
          .filter(
            (i) =>
              i.orgId === a.org.id &&
              i.livemode === (a.kind === "live") &&
              (external === null || i.body.external_id === external),
          )
          .slice(0, limit);
        data.forEach(advanceOnRead);
        return json(200, {
          page: 1,
          total_pages: data.length ? 1 : 0,
          total_results: data.length,
          data: data.map(invoiceView),
        });
      }
    }
    m =
      /^\/invoices\/([A-Za-z0-9_-]+)(?:\/(status|email|xml|pdf|zip|cancellation_receipt\/xml|cancellation_receipt\/pdf))?$/.exec(
        path,
      );
    if (m) {
      if (a.kind === "user") return error(403, "api_key_not_allowed");
      const inv = findInvoice(a, m[1]);
      if (inv instanceof Response) return inv;
      const sub = m[2];
      if (!sub && method === "GET") {
        if (takeFault("invoices.get", inv.body) === "unavailable")
          return error(503, "internal_error");
        advanceOnRead(inv);
        return json(200, invoiceView(inv));
      }
      if (!sub && method === "DELETE") return cancelInvoice(a, inv, url);
      if (sub === "status" && method === "PUT") {
        advanceOnRead(inv);
        return json(200, invoiceView(inv));
      }
      if (sub === "email" && method === "POST") return sendEmail(inv, request);
      if (
        (sub === "xml" || sub === "pdf" || sub === "zip") &&
        method === "GET"
      ) {
        if (sub === "zip")
          return error(400, "invalid_request", {
            path: "format",
            location: "params",
          });
        if (inv.status !== "valid" && inv.status !== "canceled")
          return error(400, "invoice_not_stamped");
        if (takeFault("invoices.download", inv.body))
          return error(500, "internal_error");
        const bytes =
          sub === "xml"
            ? new TextEncoder().encode(xml(inv))
            : fakePdf([
                `CFDI ${inv.series}-${inv.folio}  (FACTURAPI FAKE, SIN VALIDEZ FISCAL)`,
                `UUID ${inv.uuid?.toUpperCase()}`,
                `Receptor ${inv.body.customer.tax_id}  Total ${pesos(inv.total)}`,
              ]);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type":
              sub === "xml" ? "application/xml" : "application/pdf",
            "content-disposition": `attachment; filename="${inv.id}.${sub}"`,
          },
        });
      }
      if (sub?.startsWith("cancellation_receipt/") && method === "GET") {
        if (!inv.cancel || inv.status !== "canceled")
          return error(400, "invoice_cancellation_receipt_unavailable");
        const isXml = sub.endsWith("xml");
        return new Response(
          isXml
            ? new TextEncoder().encode(acuse(inv))
            : fakePdf([
                `ACUSE DE CANCELACION (FAKE) ${inv.uuid?.toUpperCase()}`,
                `Motivo ${inv.cancel.motive}`,
              ]),
          {
            status: 200,
            headers: {
              "content-type": isXml ? "application/xml" : "application/pdf",
            },
          },
        );
      }
    }
    return error(404, "not_found");
  }

  async function handle(request: Request): Promise<Outcome> {
    const url = new URL(request.url);
    const lang = /^en\b/i.test(request.headers.get("accept-language") ?? "")
      ? "en"
      : "es";
    const log: FakeRequestLog = {
      method: request.method,
      path: url.pathname + url.search,
      key: "none",
      status: 0,
    };
    requests.push(log);
    const outcome = await language.run(lang, () => route(request, url, log));
    log.status = outcome instanceof Response ? outcome.status : outcome.kind;
    return outcome;
  }

  function fault(rule: FaultRule) {
    const parsed = faultRule.parse(rule);
    faults.push({ ...parsed, left: parsed.times ?? 1 });
  }

  function signManifesto(orgId: string) {
    const org = organizations.get(orgId);
    if (!org) throw new Error("unknown organization");
    org.manifesto = true;
  }

  function state() {
    return {
      organizations: [...organizations.values()].map((o) => ({
        id: o.id,
        name: o.name,
        shared: o.shared,
        productionReady: !!(o.legal && o.certificate && o.manifesto),
        hasCertificate: !!o.certificate,
        taxId: o.legal?.tax_id ?? o.certificate?.rfc ?? null,
      })),
      invoices: [...invoices.values()].map((i) => ({
        id: i.id,
        livemode: i.livemode,
        status: i.status,
        cancellationStatus: i.cancellationStatus,
        type: i.body.type,
        series: i.series,
        folio: i.folio,
        uuid: i.uuid,
        externalId: i.body.external_id,
        total: i.total,
        tax: i.tax,
        emails: i.emails,
      })),
      faults: faults.map(({ left, ...f }) => ({ ...f, left })),
      requests: requests.length,
    };
  }

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const signal = init?.signal ?? request.signal;
    if (signal?.aborted) throw signal.reason;
    const outcome = await handle(request);
    if (outcome instanceof Response) return outcome;
    if (outcome.kind === "drop")
      throw new TypeError("fetch failed (fake: connection dropped)");
    return new Promise<Response>((_resolve, reject) => {
      if (!signal)
        return reject(new TypeError("fetch failed (fake: no answer)"));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };

  return {
    fetch: fetchImpl as typeof fetch,
    handle,
    fault,
    signManifesto,
    reset,
    advance(ms: number) {
      offsetMs += ms;
    },
    get requests() {
      return requests;
    },
    get organizations() {
      return organizations as ReadonlyMap<string, Readonly<Org>>;
    },
    get invoices() {
      return invoices as ReadonlyMap<string, Readonly<Invoice>>;
    },
    get emails() {
      return emails;
    },
    state,
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP server (npm run dev:facturapi-fake)
// ---------------------------------------------------------------------------------------------

/** Serves a fake on 127.0.0.1 only. Faults "timeout" hold the request open until the client gives up. */
export function serveFacturapiFake(fake: FacturapiFake, port = FAKE_PORT) {
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = `http://127.0.0.1:${port}${req.url ?? "/"}`;
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const request = new Request(url, {
          method: req.method,
          headers: Object.entries(req.headers).flatMap(([k, v]) =>
            v === undefined
              ? []
              : (Array.isArray(v) ? v : [v]).map(
                  (x) => [k, x] as [string, string],
                ),
          ),
          ...(hasBody
            ? {
                body: Readable.toWeb(req) as ReadableStream,
                duplex: "half" as const,
              }
            : {}),
        } as RequestInit);
        const outcome = await fake.handle(request);
        if (!(outcome instanceof Response)) {
          if (outcome.kind === "drop") req.socket.destroy();
          else {
            const timer = setTimeout(() => req.socket.destroy(), 120_000);
            req.socket.once("close", () => clearTimeout(timer));
          }
          return;
        }
        res.writeHead(outcome.status, Object.fromEntries(outcome.headers));
        res.end(Buffer.from(await outcome.arrayBuffer()));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            status: 500,
            code: "internal_error",
            message: String(e),
          }),
        );
      }
    },
  );
  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function invokedDirectly() {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const flag = process.argv.indexOf("--port");
  const raw =
    flag !== -1 ? process.argv[flag + 1] : process.env.FACTURAPI_FAKE_PORT;
  const port = raw ? Number(raw) : FAKE_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "facturapi_fake_invalid_port",
      }),
    );
    process.exit(2);
  }
  const server = await serveFacturapiFake(createFacturapiFake(), port);
  console.log(
    JSON.stringify({
      level: "info",
      message: "facturapi_fake_listening",
      baseUrl: `http://127.0.0.1:${port}/v2`,
    }),
  );
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
