import { z } from "zod";
import {
  consentInput,
  DomainError,
  guestCapture,
  guestEmail,
  id,
  money,
  type GuestCapture,
  type Label,
} from "./domain.js";

export const marketingChannels = ["email", "sms", "whatsapp"] as const;
export type MarketingChannel = (typeof marketingChannels)[number];
const channelList = z
  .array(z.enum(marketingChannels))
  .min(1)
  .max(3)
  .refine((list) => new Set(list).size === list.length, "duplicate_channel");

/** Dial code assumed for national numbers typed without a country prefix. */
export function dialCode(currency: string) {
  return (
    (
      {
        MXN: "52",
        USD: "1",
        CAD: "1",
        COP: "57",
        ARS: "54",
        CLP: "56",
      } as Record<string, string>
    )[currency] ?? null
  );
}
export function normalizePhone(raw: string, defaultDial: string | null) {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[\s().-]/g, "");
  const value = digits.startsWith("+")
    ? digits
    : digits.startsWith("00")
      ? "+" + digits.slice(2)
      : digits.length === 10 && defaultDial
        ? "+" + defaultDial + digits
        : "+" + digits;
  if (!/^\+[1-9][0-9]{7,14}$/.test(value))
    throw new DomainError("invalid_phone");
  return value;
}
export { guestEmail, consentInput, guestCapture, type GuestCapture };
export const consentWording: Label = {
  es: "Acepto recibir promociones y novedades de este restaurante por el medio seleccionado. Puedo darme de baja en cualquier momento.",
  en: "I agree to receive promotions and news from this restaurant through the selected channel. I can unsubscribe at any time.",
};

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
export type GuestStats = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  locale: "es" | "en";
  optIn: Record<MarketingChannel, boolean>;
  createdAt: number;
  consentAt: number | null;
  visits: number;
  spend: number;
  firstAt: number | null;
  lastAt: number | null;
  lastOrderId: string | null;
  channels: string[];
  modes: string[];
  /** Orders placed inside the automation window being evaluated. */
  visitsInWindow: number;
  feedback: { orderId: string; rating: number; at: number } | null;
};
const DAY = 86_400_000;
export function inSegment(g: GuestStats, s: Segment, now: number) {
  if (s.minVisits !== undefined && g.visits < s.minVisits) return false;
  if (s.maxVisits !== undefined && g.visits > s.maxVisits) return false;
  if (s.minSpend !== undefined && g.spend < s.minSpend) return false;
  if (
    s.minAverageCheck !== undefined &&
    (!g.visits || Math.floor(g.spend / g.visits) < s.minAverageCheck)
  )
    return false;
  if (
    s.visitedWithinDays !== undefined &&
    (g.lastAt === null || g.lastAt < now - s.visitedWithinDays * DAY)
  )
    return false;
  if (
    s.notVisitedForDays !== undefined &&
    g.lastAt !== null &&
    g.lastAt > now - s.notVisitedForDays * DAY
  )
    return false;
  if (
    s.joinedWithinDays !== undefined &&
    g.createdAt < now - s.joinedWithinDays * DAY
  )
    return false;
  if (s.orderedVia && !g.channels.includes(s.orderedVia)) return false;
  if (s.neverOrderedVia && g.channels.includes(s.neverOrderedVia)) return false;
  return true;
}
/** First channel, in the campaign's order, that the guest has opted in to. */
export function reachableChannel(
  g: Pick<GuestStats, "email" | "phone" | "optIn">,
  preferred: readonly MarketingChannel[],
  configured: readonly MarketingChannel[],
): MarketingChannel | null {
  for (const channel of preferred) {
    if (!configured.includes(channel) || !g.optIn[channel]) continue;
    if (channel === "email" ? g.email : g.phone) return channel;
  }
  return null;
}

/** Evaluated in this order; a guest receives at most one automated message per
 * frequency-cap period, so the first match wins. */
export const automationKeys = [
  "welcome",
  "positive_feedback",
  "big_spender",
  "repeat_guest",
  "miss_you",
  "first_online_order",
  "drive_in_store",
  "follow_up",
] as const;
export type AutomationKey = (typeof automationKeys)[number];
/** Listed for parity with the reference product but not offered: it needs a
 * loyalty program, which Green Monkey does not have yet. */
export const unavailableAutomations = [
  { key: "loyalty_enrollment", reason: "loyalty_module_required" },
] as const;
export const automationParams = z
  .object({
    inactiveDays: z.number().int().min(7).max(365).default(30),
    everyVisits: z.number().int().min(2).max(50).default(5),
    averageCheck: money.default(50_000),
    minRating: z.number().int().min(1).max(5).default(4),
  })
  .strict();
export type AutomationParams = z.infer<typeof automationParams>;
export type Window = { start: number; end: number };
const within = (at: number | null, w: Window) =>
  at !== null && at >= w.start && at < w.end;
/**
 * Returns a stable deduplication suffix when the guest qualified for the
 * automation during the window, otherwise null. Qualification is always an
 * event inside the window, so enabling an automation never blasts old guests.
 */
export function qualifies(
  key: AutomationKey,
  g: GuestStats,
  p: AutomationParams,
  w: Window,
): string | null {
  switch (key) {
    case "welcome":
      return within(g.consentAt, w) ? "welcome" : null;
    case "positive_feedback":
      return g.feedback &&
        g.feedback.rating >= p.minRating &&
        within(g.feedback.at, w)
        ? "feedback:" + g.feedback.orderId
        : null;
    case "big_spender":
      return within(g.lastAt, w) &&
        g.visits > 0 &&
        Math.floor(g.spend / g.visits) >= p.averageCheck
        ? "big:" + g.lastOrderId
        : null;
    case "repeat_guest": {
      const milestone = Math.floor(g.visits / p.everyVisits);
      return g.visitsInWindow > 0 &&
        milestone > Math.floor((g.visits - g.visitsInWindow) / p.everyVisits)
        ? "repeat:" + milestone
        : null;
    }
    case "miss_you":
      // The guest crossed the inactivity threshold during this window.
      return g.lastAt !== null && within(g.lastAt + p.inactiveDays * DAY, w)
        ? "miss:" + g.lastOrderId
        : null;
    case "first_online_order":
      return within(g.lastAt, w) &&
        !g.channels.some((c) => c === "qr" || c === "kiosk")
        ? "online"
        : null;
    case "drive_in_store":
      return within(g.lastAt, w) && !g.modes.includes("dine_in")
        ? "instore"
        : null;
    case "follow_up":
      return within(g.lastAt, w) ? "follow:" + g.lastOrderId : null;
  }
}
export const automationCopy: Record<
  AutomationKey,
  { name: Label; subject: Label; body: Label }
> = {
  welcome: {
    name: { es: "Bienvenida", en: "Welcome" },
    subject: {
      es: "¡Bienvenido a {{restaurant}}!",
      en: "Welcome to {{restaurant}}!",
    },
    body: {
      es: "Hola {{name}}, gracias por unirte a {{restaurant}}. Te avisaremos de novedades y promociones.{{offer}}",
      en: "Hi {{name}}, thanks for joining {{restaurant}}. We'll keep you posted on news and offers.{{offer}}",
    },
  },
  positive_feedback: {
    name: { es: "Agradecer opinión positiva", en: "Thank positive feedback" },
    subject: {
      es: "¡Gracias por tu opinión!",
      en: "Thanks for your feedback!",
    },
    body: {
      es: "Hola {{name}}, nos alegra que disfrutaras tu visita a {{restaurant}}. ¿Nos ayudas con una reseña? {{review}}",
      en: "Hi {{name}}, we're glad you enjoyed {{restaurant}}. Would you leave us a review? {{review}}",
    },
  },
  big_spender: {
    name: { es: "Clientes de ticket alto", en: "Big spender" },
    subject: { es: "Un detalle para ti", en: "A little something for you" },
    body: {
      es: "Hola {{name}}, gracias por elegir {{restaurant}}.{{offer}}",
      en: "Hi {{name}}, thank you for choosing {{restaurant}}.{{offer}}",
    },
  },
  repeat_guest: {
    name: { es: "Cliente frecuente", en: "Repeat guest" },
    subject: { es: "¡Gracias por volver!", en: "Thanks for coming back!" },
    body: {
      es: "Hola {{name}}, ya eres de casa en {{restaurant}}. ¡Gracias por tu preferencia!{{offer}}",
      en: "Hi {{name}}, you're a regular at {{restaurant}} now. Thank you!{{offer}}",
    },
  },
  miss_you: {
    name: { es: "Te extrañamos", en: "Miss you" },
    subject: { es: "Te extrañamos", en: "We miss you" },
    body: {
      es: "Hola {{name}}, hace tiempo que no te vemos en {{restaurant}}. ¡Te esperamos pronto!{{offer}}",
      en: "Hi {{name}}, it's been a while since your last visit to {{restaurant}}. See you soon!{{offer}}",
    },
  },
  first_online_order: {
    name: { es: "Impulsar pedidos por QR", en: "Drive QR orders" },
    subject: { es: "Pide desde tu teléfono", en: "Order from your phone" },
    body: {
      es: "Hola {{name}}, la próxima vez en {{restaurant}} pide desde tu teléfono con el código QR, sin filas.{{offer}}",
      en: "Hi {{name}}, next time at {{restaurant}} order from your phone with the QR code and skip the line.{{offer}}",
    },
  },
  drive_in_store: {
    name: { es: "Impulsar visitas en salón", en: "Drive dine-in visits" },
    subject: { es: "Ven a comer con nosotros", en: "Come dine with us" },
    body: {
      es: "Hola {{name}}, gracias por tu pedido. Te invitamos a disfrutar {{restaurant}} en nuestras mesas.{{offer}}",
      en: "Hi {{name}}, thanks for your order. We'd love to host you at a table at {{restaurant}}.{{offer}}",
    },
  },
  follow_up: {
    name: { es: "Seguimiento de visita", en: "Visit follow-up" },
    subject: { es: "Gracias por tu visita", en: "Thanks for your visit" },
    body: {
      es: "Hola {{name}}, gracias por visitar {{restaurant}}. ¡Vuelve pronto!{{offer}}",
      en: "Hi {{name}}, thanks for visiting {{restaurant}}. Come back soon!{{offer}}",
    },
  },
};

const campaignCommon = {
  channels: channelList,
  subject: z.string().trim().max(120).default(""),
  body: z.string().trim().min(1).max(2000),
  promotionId: id.nullable().default(null),
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
        ...campaignCommon,
      })
      .strict()
      .refine(
        (c) => !c.channels.includes("email") || c.subject.length > 0,
        "subject_required",
      ),
  })
  .strict();
export const automationInput = z
  .object({
    operationId: id,
    key: z.enum(automationKeys),
    active: z.boolean(),
    params: automationParams.default({
      inactiveDays: 30,
      everyVisits: 5,
      averageCheck: 50_000,
      minRating: 4,
    }),
    ...campaignCommon,
  })
  .strict()
  .refine(
    (c) => !c.channels.includes("email") || c.subject.length > 0,
    "subject_required",
  );
export const launchInput = z
  .object({
    operationId: id,
    campaignId: id,
    expectedVersion: z.number().int().min(1),
    scheduledAt: z.string().datetime().nullable().default(null),
  })
  .strict();
const https = z
  .string()
  .trim()
  .max(300)
  .regex(/^https:\/\/[^\s]+$/)
  .nullable()
  .default(null);
export const settingsInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(0),
    senderName: z.string().trim().max(60).default(""),
    replyTo: guestEmail.nullable().default(null),
    privacyUrl: https,
    reviewUrl: https,
    frequencyCapDays: z.number().int().min(1).max(365).default(30),
    attributionDays: z.number().int().min(1).max(30).default(7),
    sendHour: z.number().int().min(8).max(20).default(11),
  })
  .strict();

export type MessageVars = {
  name: string;
  restaurant: string;
  code: string | null;
  offerName: string | null;
  review: string | null;
  locale: "es" | "en";
};
/** Substitutes placeholders. Unknown placeholders are left visible on purpose
 * so a typo is caught in preview instead of silently sending blank text. */
export function renderMessage(template: string, v: MessageVars) {
  const offer = v.code
    ? v.locale === "es"
      ? ` Usa el código ${v.code}${v.offerName ? ` (${v.offerName})` : ""} en tu próxima orden.`
      : ` Use code ${v.code}${v.offerName ? ` (${v.offerName})` : ""} on your next order.`
    : "";
  const values: Record<string, string> = {
    name: v.name || (v.locale === "es" ? "qué tal" : "there"),
    restaurant: v.restaurant,
    code: v.code ?? "",
    offer,
    review: v.review ?? "",
  };
  return template
    .replace(/\{\{\s*([a-z]+)\s*\}\}/g, (match, key: string) =>
      key in values ? values[key] : match,
    )
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function emailHtml(
  text: string,
  footer: {
    restaurant: string;
    unsubscribeUrl: string;
    privacyUrl: string | null;
    locale: "es" | "en";
  },
) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  const es = footer.locale === "es";
  return `<!doctype html><html lang="${footer.locale}"><body style="margin:0;background:#f6f7f2;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#17251d"><div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#ffffff;border:1px solid #dce3da;border-radius:12px;padding:24px;font-size:16px;line-height:1.5"><p style="margin:0 0 16px;font-weight:700;color:#166534">${escapeHtml(footer.restaurant)}</p>${paragraphs}</div><p style="font-size:12px;color:#536258;line-height:1.5;margin:16px 8px">${escapeHtml(es ? `Recibes este mensaje porque aceptaste recibir novedades de ${footer.restaurant}.` : `You are receiving this because you agreed to hear from ${footer.restaurant}.`)} <a href="${escapeHtml(footer.unsubscribeUrl)}" style="color:#166534">${es ? "Darme de baja" : "Unsubscribe"}</a>${footer.privacyUrl ? ` · <a href="${escapeHtml(footer.privacyUrl)}" style="color:#166534">${es ? "Aviso de privacidad" : "Privacy notice"}</a>` : ""}</p></div></body></html>`;
}
/** Neutralizes spreadsheet formula injection in exported text fields. */
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
