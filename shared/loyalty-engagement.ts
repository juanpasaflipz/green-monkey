import { z } from "zod";
import { id } from "./domain.js";

/** Provider extensions are opt-in; the stamp program remains usable without them. */
export const engagementSettings = z
  .object({
    referralsEnabled: z.boolean().default(false),
    referralBonus: z.number().int().min(1).max(20).default(2),
    smsEnabled: z.boolean().default(false),
    reminderDays: z.number().int().min(1).max(90).default(7),
    walletEnabled: z.boolean().default(false),
    reviewUrl: z
      .union([
        z.literal(""),
        z
          .string()
          .url()
          .max(500)
          .refine((v) => {
            const u = new URL(v);
            return u.protocol === "https:" && !u.username && !u.password;
          }),
      ])
      .default(""),
  })
  .strict();
export type EngagementSettings = z.infer<typeof engagementSettings>;
export const ENGAGEMENT_DEFAULTS = engagementSettings.parse({});
export const saveEngagementInput = engagementSettings.extend({
  operationId: id,
  expectedVersion: z.number().int().min(0),
});
export const referralCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-F0-9]{16}$/);
export const referralInput = z
  .object({
    operationId: id,
    memberId: id,
    code: referralCode,
  })
  .strict();
export const cardCommand = z.object({ operationId: id }).strict();
export const CARD_HEADER = "x-gm-card-token";
export const CARD_TOKEN = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;
export const SCAN_CODE = /^gm-club:([a-f0-9]{32})$/;
export type CardView = {
  restaurantName: string;
  programName: string;
  stamps: number;
  required: number;
  rewards: number;
  rewardDescription: string;
  scanCode: string;
  referralCode: string | null;
  reviewUrl: string;
  marketingOptIn: boolean;
  walletEnabled: boolean;
};
export type MessageKind =
  "welcome" | "stamp" | "reward" | "referral" | "reminder";
export function loyaltyMessage(
  kind: MessageKind,
  data: {
    restaurant: string;
    stamps: number;
    required: number;
    rewards: number;
    reviewUrl: string;
  },
): string {
  const heading: Record<MessageKind, string> = {
    welcome: "¡Bienvenido al club!",
    stamp: "Tu tarjeta se actualizó.",
    reward: "¡Tienes un premio disponible!",
    referral: "¡Recibiste sellos por una recomendación!",
    reminder: "Tienes un premio pendiente de canjear.",
  };
  return `${data.restaurant.slice(0, 80)}: ${heading[kind]} ${Math.max(0, data.stamps)}/${data.required} sellos; ${data.rewards} premios.${data.reviewUrl ? ` Cuéntanos tu experiencia: ${data.reviewUrl}` : ""} Responde STOP para dejar de recibir mensajes.`;
}
