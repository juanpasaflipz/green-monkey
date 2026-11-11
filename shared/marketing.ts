import { z } from "zod";
import { id, money } from "./domain.js";

/** Members have a phone only, so marketing reaches them by SMS or WhatsApp. */
export const marketingChannels = ["sms", "whatsapp"] as const;
export type MarketingChannel = (typeof marketingChannels)[number];
const channelList = z
  .array(z.enum(marketingChannels))
  .min(1)
  .max(2)
  .refine((list) => new Set(list).size === list.length);

export const marketingSettings = z
  .object({
    /** Master switch: nothing is queued or sent while false. */
    enabled: z.boolean().default(false),
    /** Minimum days between automated messages to one member. */
    frequencyCapDays: z.number().int().min(1).max(365).default(30),
    attributionDays: z.number().int().min(1).max(30).default(7),
    /** Local hour after which the daily automations are evaluated. */
    sendHour: z.number().int().min(9).max(19).default(11),
  })
  .strict();
export type MarketingSettings = z.infer<typeof marketingSettings>;
export const MARKETING_DEFAULTS = marketingSettings.parse({});
export const saveMarketingSettingsInput = marketingSettings.extend({
  operationId: id,
  expectedVersion: z.number().int().min(0),
});

export const segmentInput = z
  .object({
    minVisits: z.number().int().min(0).max(100000).optional(),
    maxVisits: z.number().int().min(0).max(100000).optional(),
    minSpend: money.optional(),
    minAverageCheck: money.optional(),
    visitedWithinDays: z.number().int().min(1).max(730).optional(),
    notVisitedForDays: z.number().int().min(1).max(730).optional(),
    joinedWithinDays: z.number().int().min(1).max(730).optional(),
    orderedVia: z.enum(["pos", "qr", "kiosk"]).optional(),
    neverOrderedVia: z.enum(["pos", "qr", "kiosk"]).optional(),
  })
  .strict();
export type Segment = z.infer<typeof segmentInput>;
/** One club member as marketing sees it. Carries no phone and no name. */
export type MemberStats = {
  id: string;
  joinedAt: number;
  /** Opted in and confirmed the current phone (double opt-in). */
  confirmed: boolean;
  visits: number;
  spend: number;
  lastAt: number | null;
  lastOrderId: string | null;
  channels: string[];
  modes: string[];
  /** Orders placed inside the automation window being evaluated. */
  visitsInWindow: number;
};
const DAY = 86_400_000;
export function inSegment(m: MemberStats, s: Segment, now: number) {
  if (s.minVisits !== undefined && m.visits < s.minVisits) return false;
  if (s.maxVisits !== undefined && m.visits > s.maxVisits) return false;
  if (s.minSpend !== undefined && m.spend < s.minSpend) return false;
  if (
    s.minAverageCheck !== undefined &&
    (!m.visits || Math.floor(m.spend / m.visits) < s.minAverageCheck)
  )
    return false;
  if (
    s.visitedWithinDays !== undefined &&
    (m.lastAt === null || m.lastAt < now - s.visitedWithinDays * DAY)
  )
    return false;
  if (
    s.notVisitedForDays !== undefined &&
    m.lastAt !== null &&
    m.lastAt > now - s.notVisitedForDays * DAY
  )
    return false;
  if (
    s.joinedWithinDays !== undefined &&
    m.joinedAt < now - s.joinedWithinDays * DAY
  )
    return false;
  if (s.orderedVia && !m.channels.includes(s.orderedVia)) return false;
  if (s.neverOrderedVia && m.channels.includes(s.neverOrderedVia)) return false;
  return true;
}
/** First channel, in the campaign's order, that can send right now. */
export function pickChannel(
  preferred: readonly MarketingChannel[],
  configured: readonly MarketingChannel[],
): MarketingChannel | null {
  return preferred.find((c) => configured.includes(c)) ?? null;
}

/**
 * Evaluated in this order; a member receives at most one automated message per
 * frequency-cap period, so the first match wins. The club already sends its own
 * welcome, stamp and reward messages; "invite to the club" has nobody to write
 * to (non-members have no contact), and review requests are never conditioned
 * on a rating, so none of those is an automation here.
 */
export const automationKeys = [
  "big_spender",
  "repeat_guest",
  "miss_you",
  "drive_qr",
  "drive_dine_in",
  "follow_up",
] as const;
export type AutomationKey = (typeof automationKeys)[number];
export const automationParams = z
  .object({
    inactiveDays: z.number().int().min(7).max(365).default(30),
    everyVisits: z.number().int().min(2).max(50).default(5),
    averageCheck: money.default(50_000),
  })
  .strict();
export type AutomationParams = z.infer<typeof automationParams>;
export type Window = { start: number; end: number };
const within = (at: number | null, w: Window) =>
  at !== null && at >= w.start && at < w.end;
/**
 * Returns a stable deduplication suffix when the member qualified during the
 * window, otherwise null. Qualification is always an event inside the window,
 * so switching an automation on never writes to members about old visits.
 */
export function qualifies(
  key: AutomationKey,
  m: MemberStats,
  p: AutomationParams,
  w: Window,
): string | null {
  switch (key) {
    case "big_spender":
      return within(m.lastAt, w) &&
        m.visits > 0 &&
        Math.floor(m.spend / m.visits) >= p.averageCheck
        ? "big:" + m.lastOrderId
        : null;
    case "repeat_guest": {
      const milestone = Math.floor(m.visits / p.everyVisits);
      return m.visitsInWindow > 0 &&
        milestone > Math.floor((m.visits - m.visitsInWindow) / p.everyVisits)
        ? "repeat:" + milestone
        : null;
    }
    case "miss_you":
      // The member crossed the inactivity threshold during this window.
      return m.lastAt !== null && within(m.lastAt + p.inactiveDays * DAY, w)
        ? "miss:" + (m.lastOrderId ?? m.lastAt)
        : null;
    case "drive_qr":
      return within(m.lastAt, w) &&
        !m.channels.some((c) => c === "qr" || c === "kiosk")
        ? "qr"
        : null;
    case "drive_dine_in":
      return within(m.lastAt, w) && !m.modes.includes("dine_in")
        ? "dinein"
        : null;
    case "follow_up":
      return within(m.lastAt, w) ? "follow:" + m.lastOrderId : null;
  }
}
type Label = { es: string; en: string };
export const automationCopy: Record<
  AutomationKey,
  { name: Label; body: string }
> = {
  big_spender: {
    name: { es: "Clientes de ticket alto", en: "Big spender" },
    body: "Hola {{name}}, gracias por elegir {{restaurant}}. ¡Te esperamos pronto!",
  },
  repeat_guest: {
    name: { es: "Cliente frecuente", en: "Repeat guest" },
    body: "Hola {{name}}, ya eres de casa en {{restaurant}}. ¡Gracias por tu preferencia!",
  },
  miss_you: {
    name: { es: "Te extrañamos", en: "Miss you" },
    body: "Hola {{name}}, hace tiempo que no te vemos en {{restaurant}}. ¡Te esperamos pronto!",
  },
  drive_qr: {
    name: { es: "Impulsar pedidos por QR", en: "Drive QR orders" },
    body: "Hola {{name}}, la próxima vez en {{restaurant}} pide desde tu teléfono con el código QR.",
  },
  drive_dine_in: {
    name: { es: "Impulsar visitas en salón", en: "Drive dine-in visits" },
    body: "Hola {{name}}, gracias por tu pedido. Te invitamos a disfrutar {{restaurant}} en nuestras mesas.",
  },
  follow_up: {
    name: { es: "Seguimiento de visita", en: "Visit follow-up" },
    body: "Hola {{name}}, gracias por visitar {{restaurant}}. ¡Vuelve pronto!",
  },
};

const copy = {
  channels: channelList,
  body: z.string().trim().min(1).max(600),
};
export const campaignInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0),
    campaign: z
      .object({
        id,
        name: z.string().trim().min(1).max(80),
        segment: segmentInput.default({}),
        ...copy,
      })
      .strict(),
  })
  .strict();
export const automationInput = z
  .object({
    operationId: id,
    key: z.enum(automationKeys),
    active: z.boolean(),
    params: automationParams.default(automationParams.parse({})),
    ...copy,
  })
  .strict();
export const launchInput = z
  .object({
    operationId: id,
    campaignId: id,
    expectedVersion: z.number().int().min(1),
    scheduledAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export const audienceInput = z
  .object({ segment: segmentInput.default({}) })
  .strict();

/** Sent as a header from the page's URL fragment, never in a path or query. */
export const CONFIRM_HEADER = "x-gm-marketing-token";
export const CONFIRM_TOKEN =
  /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;

const STOP = " Responde STOP para dejar de recibir mensajes.";
/**
 * Substitutes placeholders. Unknown ones stay visible on purpose, so a typo is
 * caught in the preview instead of sending blank text.
 */
export function renderMarketing(
  template: string,
  v: { name: string; restaurant: string },
) {
  const values: Record<string, string> = {
    name: v.name.trim().split(/\s+/)[0] || "qué tal",
    restaurant: v.restaurant.slice(0, 80),
  };
  return template
    .replace(/\{\{\s*([a-z]+)\s*\}\}/g, (match, key: string) =>
      key in values ? values[key] : match,
    )
    .replace(/\s+/g, " ")
    .trim();
}
export const smsText = (
  template: string,
  v: { name: string; restaurant: string },
) => renderMarketing(template, v) + STOP;
export const confirmationText = (restaurant: string, link: string) =>
  `${restaurant.slice(0, 80)}: confirma que quieres recibir promociones aquí: ${link} Si no lo pediste, ignora este mensaje.` +
  STOP;
