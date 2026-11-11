import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import { requirePro } from "./entitlements.js";
import { guestStats } from "./guests.js";
import { DomainError, type Session } from "../shared/domain.js";
import type { Segment } from "../shared/marketing.js";

type Locale = "es" | "en";
const occasions: { month: number; day: number; es: string; en: string }[] = [
  { month: 1, day: 6, es: "Día de Reyes", en: "Three Kings Day" },
  { month: 2, day: 2, es: "Día de la Candelaria", en: "Candlemas" },
  { month: 2, day: 14, es: "San Valentín", en: "Valentine's Day" },
  { month: 4, day: 30, es: "Día del Niño", en: "Children's Day" },
  { month: 5, day: 10, es: "Día de las Madres", en: "Mother's Day (MX)" },
  { month: 9, day: 15, es: "Noche del Grito", en: "Independence Eve" },
  { month: 11, day: 2, es: "Día de Muertos", en: "Day of the Dead" },
  { month: 12, day: 12, es: "Día de la Virgen", en: "Guadalupe Day" },
  { month: 12, day: 24, es: "Nochebuena", en: "Christmas Eve" },
  { month: 12, day: 31, es: "Fin de año", en: "New Year's Eve" },
];
const weekdayNames = {
  es: [
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
    "domingo",
  ],
  en: [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ],
};
export type Insights = {
  historyDays: number;
  sufficient: boolean;
  weekdays: {
    weekday: number;
    days: number;
    orders: number;
    sales: number;
    average: number;
  }[];
  slowDays: number[];
  topProducts: { name: { es: string; en: string }; quantity: number }[];
  guests: { total: number; reachable: number; lapsed: number; recent: number };
};
/** Aggregates only: nothing here identifies a guest. */
export async function insights(tx: Tx, s: Session): Promise<Insights> {
  const zone = s.restaurant.timezone;
  const since = new Date(Date.now() - 56 * 86_400_000);
  const rows =
    await tx`select extract(isodow from created_at at time zone ${zone})::int as weekday,
      count(distinct (created_at at time zone ${zone})::date)::int as days,
      count(*)::int as orders,coalesce(sum(total),0)::float8 as sales
    from orders where created_at>=${since} group by 1 order by 1`;
  const [span] =
    await tx`select count(distinct (created_at at time zone ${zone})::date)::int as days from orders where created_at>=${since}`;
  const weekdays = rows.map((r) => ({
    weekday: r.weekday as number,
    days: r.days as number,
    orders: r.orders as number,
    sales: r.sales as number,
    average: Math.round(r.sales / r.days),
  }));
  const sufficient =
    span.days >= 14 && weekdays.reduce((a, d) => a + d.orders, 0) >= 30;
  const top =
    await tx`select l.data->'name' as name,sum((l.data->>'quantity')::int)::int as quantity
    from order_lines l join orders o on o.tenant_id=l.tenant_id and o.id=l.order_id
    where o.created_at>=${new Date(Date.now() - 30 * 86_400_000)}
    group by 1 order by 2 desc limit 5`;
  const guests = await guestStats(tx);
  const now = Date.now();
  const reachable = guests.filter(
    (g) => g.optIn.email || g.optIn.sms || g.optIn.whatsapp,
  );
  return {
    historyDays: span.days,
    sufficient,
    weekdays,
    slowDays: sufficient
      ? [...weekdays]
          .filter((d) => d.days >= 2)
          .sort((a, b) => a.average - b.average)
          .slice(0, 2)
          .map((d) => d.weekday)
      : [],
    topProducts: top.map((r) => ({ name: r.name, quantity: r.quantity })),
    guests: {
      total: guests.length,
      reachable: reachable.length,
      lapsed: reachable.filter(
        (g) => g.lastAt !== null && g.lastAt < now - 30 * 86_400_000,
      ).length,
      recent: reachable.filter((g) => g.createdAt > now - 30 * 86_400_000)
        .length,
    },
  };
}
export type Suggestion = {
  date: string;
  reason: "slow_day" | "occasion" | "winback" | "new_guests";
  title: string;
  why: string;
  segment: Segment;
  subject: string;
  body: string;
  social: string;
};
/**
 * A month of campaign ideas built from the restaurant's own slow days, lapsed
 * guests and upcoming dates. Copy comes from fixed templates and is always a
 * draft for a person to edit.
 */
export function monthPlan(
  data: Insights,
  today: Temporal.PlainDate,
  locale: Locale,
): Suggestion[] {
  const es = locale === "es";
  const dish = data.topProducts[0]?.name[locale];
  const out: Suggestion[] = [];
  for (let offset = 2; offset <= 30; offset++) {
    const date = today.add({ days: offset });
    const occasion = occasions.find(
      (o) => o.month === date.month && o.day === date.day,
    );
    if (occasion) {
      const send = date.subtract({ days: 3 });
      out.push({
        date: (Temporal.PlainDate.compare(send, today) > 0
          ? send
          : today.add({ days: 1 })
        ).toString(),
        reason: "occasion",
        title: occasion[locale],
        why: es
          ? `${occasion.es} es el ${date.day}/${date.month}. Avisa con tres días de anticipación.`
          : `${occasion.en} is on ${date.month}/${date.day}. Announce it three days ahead.`,
        segment: {},
        subject: es
          ? `Celebra ${occasion.es} en {{restaurant}}`
          : `Celebrate ${occasion.en} at {{restaurant}}`,
        body: es
          ? `Hola {{name}}, celebra ${occasion.es} con nosotros en {{restaurant}}.{{offer}}`
          : `Hi {{name}}, celebrate ${occasion.en} with us at {{restaurant}}.{{offer}}`,
        social: es
          ? `${occasion.es} se celebra mejor con buena comida. Te esperamos.`
          : `${occasion.en} is better with good food. See you here.`,
      });
    }
  }
  for (const weekday of data.slowDays) {
    let date = today.add({ days: 1 });
    while (date.dayOfWeek !== weekday) date = date.add({ days: 1 });
    for (let n = 0; n < 2; n++, date = date.add({ days: 7 })) {
      const name = weekdayNames[locale][weekday - 1];
      out.push({
        date: date.subtract({ days: 1 }).toString(),
        reason: "slow_day",
        title: es ? `Impulsa el ${name}` : `Boost ${name}`,
        why: es
          ? `El ${name} es de tus días con menos venta en las últimas ocho semanas. Envía la víspera.`
          : `${name} is one of your slowest days over the last eight weeks. Send the day before.`,
        segment: { visitedWithinDays: 90 },
        subject: es
          ? `Este ${name} te esperamos en {{restaurant}}`
          : `See you this ${name} at {{restaurant}}`,
        body: es
          ? `Hola {{name}}, este ${name} ven a {{restaurant}}${dish ? ` por tu ${dish}` : ""}.{{offer}}`
          : `Hi {{name}}, come to {{restaurant}} this ${name}${dish ? ` for your ${dish}` : ""}.{{offer}}`,
        social: es
          ? `¿Plan para el ${name}?${dish ? ` ${dish} recién hecho.` : ""} Te esperamos.`
          : `Plans for ${name}?${dish ? ` Fresh ${dish}.` : ""} See you here.`,
      });
    }
  }
  if (data.guests.lapsed >= 5)
    out.push({
      date: today.add({ days: 2 }).toString(),
      reason: "winback",
      title: es ? "Recupera clientes inactivos" : "Win back lapsed guests",
      why: es
        ? `${data.guests.lapsed} clientes suscritos no han vuelto en 30 días o más.`
        : `${data.guests.lapsed} subscribed guests have not returned in 30+ days.`,
      segment: { notVisitedForDays: 30, minVisits: 1 },
      subject: es
        ? "Te extrañamos en {{restaurant}}"
        : "We miss you at {{restaurant}}",
      body: es
        ? "Hola {{name}}, hace tiempo que no te vemos en {{restaurant}}. ¡Vuelve pronto!{{offer}}"
        : "Hi {{name}}, it's been a while. Come back to {{restaurant}} soon!{{offer}}",
      social: es
        ? "Hace tiempo que no nos visitas. ¡Te extrañamos!"
        : "It's been a while. We miss you!",
    });
  if (data.guests.recent >= 5)
    out.push({
      date: today.add({ days: 5 }).toString(),
      reason: "new_guests",
      title: es
        ? "Segunda visita de clientes nuevos"
        : "Second visit for new guests",
      why: es
        ? `${data.guests.recent} clientes se suscribieron en los últimos 30 días.`
        : `${data.guests.recent} guests subscribed in the last 30 days.`,
      segment: { joinedWithinDays: 30, maxVisits: 1 },
      subject: es
        ? "¿Listo para tu segunda visita?"
        : "Ready for your second visit?",
      body: es
        ? "Hola {{name}}, gracias por conocer {{restaurant}}. Te esperamos de nuevo.{{offer}}"
        : "Hi {{name}}, thanks for trying {{restaurant}}. We'd love to see you again.{{offer}}",
      social: es
        ? "Gracias a quienes nos visitaron por primera vez este mes."
        : "Thanks to everyone who visited for the first time this month.",
    });
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);
}
export async function assistantPlan(tx: Tx, s: Session, locale: Locale) {
  permit(s, managers);
  await requirePro(tx);
  const data = await insights(tx, s);
  const today = Temporal.Now.zonedDateTimeISO(
    s.restaurant.timezone,
  ).toPlainDate();
  return {
    insights: data,
    plan: monthPlan(data, today, locale),
    source: "template",
  };
}

export const draftInput = z
  .object({
    goal: z.string().trim().min(5).max(400),
    format: z.enum(["email", "sms", "whatsapp", "social"]),
    locale: z.enum(["es", "en"]).default("es"),
  })
  .strict();
export const assistantConfigured = (env: NodeJS.ProcessEnv) =>
  env.MARKETING_AI_ENABLED === "true" &&
  !!env.ANTHROPIC_API_KEY &&
  !!env.MARKETING_AI_MODEL;
const reply = z
  .object({
    subject: z.string().max(120).default(""),
    body: z.string().min(1).max(2000),
  })
  .strict();
/**
 * Drafts copy for a person to review. With the AI provider configured the
 * request carries only the restaurant name, best sellers and slow weekdays —
 * never guest data. Without it, a fixed template is returned and labelled so.
 */
export async function assistantContext(
  tx: Tx,
  s: Session,
  raw: unknown,
  env: NodeJS.ProcessEnv,
) {
  permit(s, managers);
  await requirePro(tx);
  const p = draftInput.parse(raw);
  return {
    p,
    restaurant: s.restaurant.name,
    data: assistantConfigured(env) ? await insights(tx, s) : null,
  };
}
/** Runs after the database transaction has ended. */
export async function assistantDraft(
  context: Awaited<ReturnType<typeof assistantContext>>,
  env: NodeJS.ProcessEnv,
  http: typeof fetch = fetch,
) {
  const { p, data } = context;
  const es = p.locale === "es";
  const template = {
    source: "template" as const,
    subject:
      p.format === "email"
        ? es
          ? "Novedades de {{restaurant}}"
          : "News from {{restaurant}}"
        : "",
    body:
      p.format === "social"
        ? p.goal
        : es
          ? `Hola {{name}}, ${p.goal.replace(/\.$/, "")}. Te esperamos en {{restaurant}}.{{offer}}`
          : `Hi {{name}}, ${p.goal.replace(/\.$/, "")}. See you at {{restaurant}}.{{offer}}`,
  };
  if (!data) return template;
  const limits = { email: 900, sms: 240, whatsapp: 500, social: 600 }[p.format];
  const response = await http("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.MARKETING_AI_MODEL,
      max_tokens: 700,
      system:
        'You write short, warm restaurant marketing copy. Reply with one JSON object only: {"subject": string, "body": string}. No markdown. Never invent prices, discounts, dates or claims that were not given. ' +
        (p.format === "social"
          ? "The body is a social post without placeholders."
          : "Use the literal placeholders {{name}} for the guest's first name and {{restaurant}} for the restaurant, and end the body with {{offer}}.") +
        ` Write in ${es ? "Mexican Spanish" : "English"}. Body under ${limits} characters.` +
        (p.format === "email"
          ? " Subject under 60 characters."
          : ' Subject must be "".'),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            goal: p.goal,
            format: p.format,
            restaurant: context.restaurant,
            bestSellers: data.topProducts.map((t) => t.name[p.locale]),
            slowWeekdays: data.slowDays.map(
              (d) => weekdayNames[p.locale][d - 1],
            ),
          }),
        },
      ],
    }),
  });
  if (!response.ok) throw new DomainError("assistant_unavailable", 502);
  const payload = (await response.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text = payload.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    const parsed = reply.parse(
      JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)),
    );
    return { source: "ai" as const, model: env.MARKETING_AI_MODEL, ...parsed };
  } catch {
    throw new DomainError("assistant_unavailable", 502);
  }
}
