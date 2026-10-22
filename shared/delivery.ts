import { z } from "zod";

export const deliveryProvider = z.enum(["uber_eats", "rappi", "didi_food"]);
export type DeliveryProvider = z.infer<typeof deliveryProvider>;
export const DELIVERY_NAMES: Record<DeliveryProvider, string> = {
  uber_eats: "Uber Eats",
  rappi: "Rappi",
  didi_food: "DiDi Food",
};
export const DELIVERY_CONSENT = "delivery-reports-v1";
export const deliveryStore = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  reportLabel: z.string().min(1).max(500).optional(),
});
export type DeliveryStore = z.infer<typeof deliveryStore>;
export type DeliveryState =
  | "disconnected"
  | "preparing"
  | "awaiting_login"
  | "verifying"
  | "choose_store"
  | "syncing"
  | "connected"
  | "attention"
  | "disconnecting";
export interface DeliveryConnection {
  provider: DeliveryProvider;
  state: DeliveryState;
  stores: DeliveryStore[];
  store: DeliveryStore | null;
  lastSyncedAt: string | null;
  errorCode: string | null;
  loginExpiresAt: string | null;
  generation: number;
}
export interface DeliveryDay {
  provider: DeliveryProvider;
  day: string;
  orderCount: number;
  gross: number;
  adjusted: number;
  payout: number | null;
  currency: string;
  updatedAt: string;
}
export interface DeliveryView {
  available: DeliveryProvider[];
  pro: boolean;
  connections: DeliveryConnection[];
  days: DeliveryDay[];
  issues?: { provider: DeliveryProvider; day: string; errorCode: string }[];
}
export const deliveryCommand = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("connect"),
    consent: z.literal(DELIVERY_CONSENT),
  }),
  z.object({
    action: z.literal("verify"),
    generation: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("select"),
    generation: z.number().int().nonnegative(),
    storeId: z.string().min(1).max(200),
  }),
  z.object({ action: z.literal("disconnect") }),
]);

/** Never accept arbitrary redirects or an attacker-controlled live browser host. */
export function validDeliveryLiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        "www.browserbase.com",
        "browserbase.com",
        "debug.browserbase.com",
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
