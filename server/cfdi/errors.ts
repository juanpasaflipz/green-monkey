/**
 * Facturapi failure → what a cfdi job does next (spec §4.8, §2.14). Pure.
 *
 * Root codes come from Facturapi's error reference (FacturAPI/facturapi-docs
 * getting-started/errors.mdx at commit 1c2e617): CommonErrorCode, AuthErrorCode, RequestErrorCode,
 * TaxInfoValidationCode, InvoiceStampingErrorCode, InvoiceDeliveryErrorCode,
 * InvoiceCancellationErrorCode, OrganizationSettingsErrorCode. Tax-information codes can be the
 * root `code` (single issue) or appear in `errors[].code`, so both are read.
 *
 * Every returned `code` is a cfdi_* code (the jobs code regex ^[a-z][a-z0-9_]{1,63}$ and the
 * cfdi_documents.error_code check); `providerCode` keeps Facturapi's own code for events.
 */
import { FacturapiError } from "./facturapi.js";

export type FacturapiFailure = {
  /** Retry the job (same idempotency key). False: permanent for this request. */
  retry: boolean;
  /** Wait before retrying (Retry-After, or 15 s for an in-flight idempotency key). */
  afterMs?: number;
  /** cfdi_* code stored on the document or job. */
  code: string;
  /** Facturapi's human message (≤ 1,000 chars), shown to staff and customers. */
  message?: string;
  /** Request field the error is about (customer.tax_id, customer.legal_name, …). */
  path?: string;
  /**
   * The provider may have acted although we saw no success (timeout, network failure, 5xx, or a
   * 2xx we could not read). A stamping job must first look the invoice up by external_id and
   * must never auto-fail the document or release its claims on such an outcome.
   */
  unknownOutcome: boolean;
  /** Facturapi root code (or http_<status>), for events and logs. */
  providerCode?: string;
};

/** Facturapi codes that are transient by definition. */
const RETRYABLE: Record<string, string> = {
  invoice_stamping_service_unavailable: "cfdi_provider_unavailable",
  invoice_cancellation_service_unavailable: "cfdi_provider_unavailable",
  tax_id_validation_service_unavailable: "cfdi_provider_unavailable",
  internal_error: "cfdi_provider_unavailable",
};

/** In-flight duplicates: the first request is still being processed; retry the same key soon. */
const IN_FLIGHT = new Set(["idempotency_key_in_use", "stamping_in_progress"]);
const IN_FLIGHT_RETRY_MS = 15_000;
const RATE_LIMIT_DEFAULT_MS = 60_000;
/** Retry-After is honoured but bounded so a bad header cannot park a job for days. */
const RATE_LIMIT_MAX_MS = 60 * 60_000;

/** Receptor data rejected against SAT records (TaxInfoValidationCode) → the field to correct. */
const RECEPTOR: Record<string, { code: string; path: string }> = {
  tax_id_not_found: {
    code: "cfdi_receptor_rfc_not_found",
    path: "customer.tax_id",
  },
  legal_name_mismatch: {
    code: "cfdi_receptor_name_mismatch",
    path: "customer.legal_name",
  },
  tax_address_zip_mismatch: {
    code: "cfdi_receptor_zip_mismatch",
    path: "customer.address.zip",
  },
  tax_system_not_allowed_for_tax_id: {
    code: "cfdi_receptor_regime_mismatch",
    path: "customer.tax_system",
  },
  tax_system_not_in_catalog: {
    code: "cfdi_receptor_regime_invalid",
    path: "customer.tax_system",
  },
};

/** CSD upload (OrganizationSettingsErrorCode), spec §4.8.2. */
const CERTIFICATE: Record<string, string> = {
  private_key_password_incorrect: "cfdi_csd_password",
  private_key_certificate_mismatch: "cfdi_csd_key_mismatch",
  certificate_expired: "cfdi_csd_expired",
  certificate_not_yet_valid: "cfdi_csd_not_yet_valid",
  csd_required: "cfdi_csd_is_fiel",
  certificate_files_invalid: "cfdi_csd_invalid",
  certificate_invalid: "cfdi_csd_invalid",
  certificate_file_required: "cfdi_csd_invalid",
  private_key_file_required: "cfdi_csd_invalid",
  certificate_files_required: "cfdi_csd_invalid",
  certificate_previous_rfc_mismatch: "cfdi_csd_rfc_mismatch",
};

/** Everything else that is permanent and worth its own code. */
const PERMANENT: Record<string, string> = {
  // Auth: an organization key revoked or the platform User key invalid (critical alerts).
  api_key_invalid: "cfdi_org_key_invalid",
  user_key_invalid: "cfdi_provider_auth_failed",
  // A generic 401 cannot tell which key failed; a caller that used an organization key treats
  // cfdi_provider_auth_failed like cfdi_org_key_invalid.
  missing_credentials: "cfdi_provider_auth_failed",
  unauthorized: "cfdi_provider_auth_failed",
  forbidden: "cfdi_provider_forbidden",
  api_key_not_allowed: "cfdi_provider_forbidden",
  live_api_key_required: "cfdi_live_key_required",
  // The organization cannot stamp yet (subscription, Carta manifiesto, legal data).
  organization_incomplete: "cfdi_org_not_ready",
  subscription_required: "cfdi_org_not_ready",
  subscription_live_access_required: "cfdi_org_not_ready",
  subscription_active_required: "cfdi_org_not_ready",
  feature_not_available: "cfdi_org_not_ready",
  organization_tax_info_invalid: "cfdi_org_tax_info_invalid",
  organization_not_found: "cfdi_provider_not_found",
  // Stamping.
  invoice_stamping_validation_error: "cfdi_stamping_rejected",
  invoice_stamping_failed: "cfdi_stamping_failed",
  invalid_request: "cfdi_provider_invalid_request",
  invalid_json: "cfdi_provider_invalid_request",
  payload_too_large: "cfdi_provider_invalid_request",
  product_key_not_found: "cfdi_product_key_invalid",
  unit_key_not_found: "cfdi_unit_key_invalid",
  invoice_not_found: "cfdi_provider_not_found",
  not_found: "cfdi_provider_not_found",
  // Cancellation. "in progress" means a request already exists: the cancel job treats it as requested.
  invoice_cancellation_in_progress: "cfdi_cancellation_in_progress",
  invoice_not_cancelable: "cfdi_cancel_rejected_provider",
  invoice_not_cancelable_by_sat: "cfdi_cancel_rejected_provider",
  invoice_cancellation_not_allowed: "cfdi_cancel_rejected_provider",
  invoice_cancellation_failed: "cfdi_cancel_rejected_provider",
  invoice_cancellation_rfc_mismatch: "cfdi_cancel_rejected_provider",
  substitution_invoice_canceled: "cfdi_substitute_invalid",
  substitution_invoice_not_found: "cfdi_substitute_invalid",
  substitution_invoice_required: "cfdi_substitute_invalid",
  substitution_invoice_status_not_allowed: "cfdi_substitute_invalid",
  invoice_cancellation_receipt_unavailable: "cfdi_acuse_unavailable",
  invoice_cancellation_receipt_external: "cfdi_acuse_unavailable",
  // Email delivery (cfdi_documents.email_error).
  invoice_email_delivery_failed: "cfdi_email_delivery_failed",
  invoice_email_recipient_required: "cfdi_email_recipient_required",
  invoice_email_status_not_allowed: "cfdi_email_not_allowed",
};

/** Local failures raised by the client (FacturapiError kinds key and schema). */
const LOCAL: Record<string, string> = {
  cfdi_key_kind: "cfdi_key_kind",
  cfdi_key_prefix: "cfdi_key_prefix",
  cfdi_mode_mismatch: "cfdi_mode_mismatch",
  cfdi_request_invalid: "cfdi_request_invalid",
  cfdi_provider_schema: "cfdi_provider_schema",
  cfdi_provider_response_too_large: "cfdi_provider_schema",
  cfdi_duplicate_external_id: "cfdi_duplicate_external_id",
};

function boundedRetryAfter(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0)
    return RATE_LIMIT_DEFAULT_MS;
  return Math.min(Math.max(ms, 1000), RATE_LIMIT_MAX_MS);
}

/** Classifies anything a Facturapi call can throw. Unknown errors are retried as unknown outcomes. */
export function classifyFacturapiError(e: unknown): FacturapiFailure {
  if (!(e instanceof FacturapiError))
    return { retry: true, code: "cfdi_unexpected_error", unknownOutcome: true };

  const message = e.message ? e.message.slice(0, 1000) : undefined;
  const base = { message, providerCode: e.code };

  switch (e.kind) {
    case "timeout":
      return {
        ...base,
        retry: true,
        code: "cfdi_provider_timeout",
        unknownOutcome: true,
      };
    case "network":
      return {
        ...base,
        retry: true,
        code:
          e.code === "cfdi_request_aborted"
            ? "cfdi_request_aborted"
            : "cfdi_provider_network",
        unknownOutcome: true,
      };
    case "key":
      return {
        ...base,
        retry: false,
        code: "cfdi_key_kind",
        unknownOutcome: false,
      };
    case "schema":
      // A request we refused to send: nothing happened. A 2xx we could not read (or one in the
      // wrong environment): the provider acted, so the outcome must be adopted, never assumed.
      return {
        ...base,
        retry: false,
        code: LOCAL[e.code] ?? "cfdi_provider_schema",
        unknownOutcome:
          e.status >= 200 && e.status < 300
            ? true
            : e.code === "cfdi_mode_mismatch",
      };
    case "http":
      break;
  }

  const details = e.details ?? [];
  const pathOf = (fallback?: string) =>
    e.path ?? details.find((d) => d.path)?.path ?? fallback;

  if (e.status === 429 || e.code === "rate_limit_exceeded")
    return {
      ...base,
      retry: true,
      afterMs: boundedRetryAfter(e.retryAfterMs),
      code: "cfdi_provider_rate_limited",
      unknownOutcome: false,
    };
  if (IN_FLIGHT.has(e.code))
    return {
      ...base,
      retry: true,
      afterMs: IN_FLIGHT_RETRY_MS,
      code: "cfdi_provider_in_progress",
      unknownOutcome: true,
    };
  if (RETRYABLE[e.code])
    return {
      ...base,
      retry: true,
      ...(e.retryAfterMs !== undefined
        ? { afterMs: boundedRetryAfter(e.retryAfterMs) }
        : {}),
      code: RETRYABLE[e.code],
      unknownOutcome: e.status >= 500,
    };

  // Receptor and certificate problems, as the root code or as the first matching detail.
  const receptor =
    RECEPTOR[e.code] ??
    details.map((d) => RECEPTOR[d.code]).find((r) => r !== undefined);
  if (receptor)
    return {
      ...base,
      retry: false,
      code: receptor.code,
      path:
        e.path ??
        details.find((d) => RECEPTOR[d.code] && d.path)?.path ??
        receptor.path,
      unknownOutcome: false,
    };
  const certificate =
    CERTIFICATE[e.code] ??
    details.map((d) => CERTIFICATE[d.code]).find((c) => c !== undefined);
  if (certificate)
    return {
      ...base,
      retry: false,
      code: certificate,
      path: pathOf(),
      unknownOutcome: false,
    };

  if (PERMANENT[e.code])
    return {
      ...base,
      retry: false,
      code: PERMANENT[e.code],
      path: pathOf(),
      unknownOutcome: false,
    };
  // Undocumented codes: a server error (or anything ≥ 500) is transient and its outcome unknown;
  // a client error is permanent.
  if (e.status >= 500 || e.status === 0)
    return {
      ...base,
      retry: true,
      ...(e.retryAfterMs !== undefined
        ? { afterMs: boundedRetryAfter(e.retryAfterMs) }
        : {}),
      code: "cfdi_provider_unavailable",
      unknownOutcome: true,
    };
  if (e.status === 401)
    return {
      ...base,
      retry: false,
      code: "cfdi_provider_auth_failed",
      unknownOutcome: false,
    };
  if (e.status === 408)
    return {
      ...base,
      retry: true,
      code: "cfdi_provider_timeout",
      unknownOutcome: true,
    };
  return {
    ...base,
    retry: false,
    code: "cfdi_provider_rejected",
    path: pathOf(),
    unknownOutcome: false,
  };
}
