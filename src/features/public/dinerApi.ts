// The diner page's calls to /api/public. Tokens travel only in headers; a
// diner page never calls setSession, so no staff session or tenant header is
// ever sent from it.
import { api, ApiError } from "../../api";
import { translateError, strings } from "../../i18n";
import type { Locale } from "../../../shared/domain";
import {
  LINK_HEADER,
  STATUS_HEADER,
  type DinerHoldView,
  type OrderingState,
  type PublicMenuView,
} from "../../../shared/public-ordering";

export type DinerOrderBody = {
  operationId: string;
  statusKey: string;
  lines: {
    id: string;
    productId: string;
    quantity: number;
    options: string[];
  }[];
  name: string;
  note: string;
  expectedTotal: number;
};

const linkHeaders = (token: string) => ({ [LINK_HEADER]: token });
const holdHeaders = (token: string, key: string) => ({
  [LINK_HEADER]: token,
  [STATUS_HEADER]: key,
});

export const dinerApi = {
  menu: (token: string) =>
    api<PublicMenuView>("/public/menu", undefined, {
      headers: linkHeaders(token),
    }),
  revision: (token: string) =>
    api<{ revision: number; ordering: OrderingState }>(
      "/public/revision",
      undefined,
      { headers: linkHeaders(token) },
    ),
  /** Idempotent: the body carries the diner's operationId and status key. */
  submit: (token: string, body: DinerOrderBody) =>
    api<DinerHoldView>("/public/orders", body, {
      headers: linkHeaders(token),
      idempotent: true,
    }),
  status: (token: string, key: string) =>
    api<DinerHoldView>("/public/status", undefined, {
      headers: holdHeaders(token, key),
    }),
  cancel: (token: string, key: string) =>
    api<DinerHoldView>(
      "/public/status/cancel",
      {},
      { headers: holdHeaders(token, key), idempotent: true },
    ),
};

/** 16 random bytes, base64url (22 characters): the diner's status key. */
export function newStatusKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Codes after which the page shows a full-page notice instead of the menu. */
export function noticeFor(code: string): "invalid" | "unavailable" | null {
  if (code === "public_link_invalid") return "invalid";
  if (code === "pro_required" || code === "public_ordering_disabled")
    return "unavailable";
  return null;
}

/** A transient failure: the request may not have reached the restaurant. */
export const isTransient = (e: unknown) => e instanceof ApiError && e.transient;

/** Diner wording for an error code (account's guest copy for "not available"). */
export function guestError(code: string, locale: Locale): string {
  if (code === "pro_required" || code === "public_ordering_disabled")
    return strings[locale].accountGuestOrderingUnavailable;
  if (code === "rate_limited") return strings[locale].publicRateLimited;
  if (
    code === "network_unavailable" ||
    code === "request_timeout" ||
    code === "server_unavailable" ||
    code === "invalid_response"
  )
    return strings[locale].publicNetwork;
  return translateError(code, locale);
}
