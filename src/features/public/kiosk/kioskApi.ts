// The kiosk's calls to /api/public/kiosk (039). The link token travels in a header; the device
// binding is the HttpOnly gm_kiosk cookie the browser sends on this path by itself (the page
// never sees it).
import { api } from "../../../api";
import { LINK_HEADER, STATUS_HEADER } from "../../../../shared/public-ordering";
import type {
  KioskCheckoutView,
  KioskMemberResult,
  KioskMenuBlock,
  KioskSubmitResult,
} from "../../../../shared/kiosk";

const h = (token: string, key?: string) => ({
  [LINK_HEADER]: token,
  ...(key ? { [STATUS_HEADER]: key } : {}),
});

export type KioskOrderBody = {
  operationId: string;
  statusKey: string;
  lines: {
    id: string;
    productId: string;
    quantity: number;
    options: string[];
    origin?: "suggestion";
  }[];
  name: string;
  note: string;
  expectedTotal: number;
  fulfillment: "here" | "to_go";
  memberToken?: string;
};

export const kioskApi = {
  state: (token: string) =>
    api<KioskMenuBlock>("/public/kiosk/state", undefined, {
      headers: h(token),
    }),
  submit: (token: string, body: KioskOrderBody) =>
    api<KioskSubmitResult>("/public/kiosk/orders", body, {
      headers: h(token),
      idempotent: true,
    }),
  charge: (token: string, statusKey: string, operationId: string) =>
    api<KioskCheckoutView>(
      "/public/kiosk/charge",
      { operationId, statusKey },
      { headers: h(token), idempotent: true },
    ),
  cancelCharge: (token: string, statusKey: string) =>
    api<{
      outcome: "withdrawn" | "in_progress" | "already_final" | "pending_cancel";
      checkout: KioskCheckoutView;
    }>(
      "/public/kiosk/charge/cancel",
      { operationId: crypto.randomUUID(), statusKey },
      { headers: h(token), idempotent: true },
    ),
  counter: (token: string, statusKey: string) =>
    api<KioskCheckoutView>(
      "/public/kiosk/counter",
      { statusKey },
      { headers: h(token) },
    ),
  cancel: (token: string, statusKey: string) =>
    api<KioskCheckoutView>(
      "/public/kiosk/cancel",
      { statusKey },
      { headers: h(token) },
    ),
  checkout: (token: string, statusKey: string) =>
    api<KioskCheckoutView>("/public/kiosk/checkout", undefined, {
      headers: h(token, statusKey),
    }),
  sync: (token: string, statusKey: string) =>
    api<KioskCheckoutView>(
      "/public/kiosk/checkout/sync",
      { statusKey },
      { headers: h(token) },
    ),
  member: (token: string, phone: string) =>
    api<KioskMemberResult>(
      "/public/kiosk/member",
      { phone, country: "MX" },
      { headers: h(token) },
    ),
  pair: (token: string, code: string) =>
    api<{ stationLabel: string }>(
      "/public/kiosk/pair",
      { operationId: crypto.randomUUID(), code },
      { headers: h(token) },
    ),
  heartbeat: (
    token: string,
    build: string,
    viewport: "landscape" | "portrait",
  ) =>
    api<void>(
      "/public/kiosk/heartbeat",
      { build, viewport },
      { headers: h(token) },
    ),
};
