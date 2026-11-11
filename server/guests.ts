import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import { audit, once } from "./orders.js";
import { DomainError, id, type Session } from "../shared/domain.js";
import {
  consentInput,
  consentWording,
  csvCell,
  dialCode,
  guestEmail,
  marketingChannels,
  normalizePhone,
  type GuestCapture,
  type GuestStats,
  type MarketingChannel,
  type Window,
} from "../shared/marketing.js";

type ConsentSource =
  | "pos"
  | "qr"
  | "kiosk"
  | "manager"
  | "import"
  | "unsubscribe_link"
  | "provider";
const column = {
  email: "email_opt_in",
  sms: "sms_opt_in",
  whatsapp: "whatsapp_opt_in",
} as const;
/** Appends consent evidence and updates the current state in one transaction. */
export async function setConsent(
  tx: Tx,
  tenantId: string,
  guestId: string,
  channel: MarketingChannel,
  granted: boolean,
  source: ConsentSource,
  actorId: string | null,
  wording = "",
) {
  const [guest] =
    await tx`select email,phone,email_opt_in,sms_opt_in,whatsapp_opt_in from guests where id=${guestId} for update`;
  if (!guest) throw new DomainError("not_found", 404);
  if (guest[column[channel]] === granted) return false;
  if (granted && !(channel === "email" ? guest.email : guest.phone))
    throw new DomainError("contact_required");
  await tx`insert into guest_consents(tenant_id,id,guest_id,channel,granted,source,wording,actor_id)
    values(${tenantId},${randomUUID()},${guestId},${channel},${granted},${source},${wording},${actorId})`;
  // One statement per channel keeps column names out of dynamic SQL.
  if (channel === "email")
    await tx`update guests set email_opt_in=${granted} where id=${guestId}`;
  else if (channel === "sms")
    await tx`update guests set sms_opt_in=${granted} where id=${guestId}`;
  else
    await tx`update guests set whatsapp_opt_in=${granted} where id=${guestId}`;
  if (granted)
    await tx`update guests set first_consent_at=coalesce(first_consent_at,now()) where id=${guestId}`;
  return true;
}
/**
 * Finds or creates the guest behind an order. Contact details are matched by
 * e-mail first, then phone. Consent is only ever granted here, never revoked.
 */
export async function captureGuest(
  tx: Tx,
  s: Session,
  capture: GuestCapture,
  source: "pos" | "qr" | "kiosk" | "manager",
) {
  const phone = capture.phone
    ? normalizePhone(capture.phone, dialCode(s.restaurant.currency))
    : null;
  const email = capture.email ?? null;
  for (const key of [email, phone].filter(Boolean).sort())
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + ":guest:" + key},0))`;
  const [byEmail] = email
    ? await tx`select * from guests where email=${email} for update`
    : [];
  const [byPhone] = phone
    ? await tx`select * from guests where phone=${phone} for update`
    : [];
  let guest = byEmail ?? byPhone;
  if (!guest) {
    const guestId = randomUUID();
    [guest] =
      await tx`insert into guests(tenant_id,id,name,email,phone,locale,source)
        values(${s.tenantId},${guestId},${capture.name},${email},${phone},${capture.locale},${source}) returning *`;
  } else {
    // Never move a phone or e-mail that already identifies another guest.
    const nextEmail = guest.email ?? (byEmail ? null : email);
    const nextPhone = guest.phone ?? (byPhone ? null : phone);
    [guest] = await tx`update guests set
        name=case when name='' then ${capture.name} else name end,
        email=${nextEmail},phone=${nextPhone}
      where id=${guest.id} returning *`;
  }
  const actor = source === "pos" || source === "manager" ? s.employeeId : null;
  for (const channel of marketingChannels) {
    if (!capture.consent[channel]) continue;
    const address = channel === "email" ? guest.email : guest.phone;
    // Consent applies to the address the guest typed; a different stored
    // address is not silently opted in.
    if (!address || address !== (channel === "email" ? email : phone)) continue;
    await setConsent(
      tx,
      s.tenantId,
      guest.id,
      channel,
      true,
      source,
      actor,
      consentWording[capture.locale],
    );
  }
  return guest.id as string;
}
export async function guestStats(
  tx: Tx,
  window: Window = { start: 0, end: 0 },
  guestId: string | null = null,
): Promise<GuestStats[]> {
  const start = new Date(window.start),
    end = new Date(window.end);
  const rows = await tx`select g.*,
      coalesce(o.visits,0)::int as visits,coalesce(o.spend,0)::float8 as spend,
      o.first_at,o.last_at,o.last_order_id,
      coalesce(o.channels,'{}') as channels,coalesce(o.modes,'{}') as modes,
      coalesce(o.in_window,0)::int as in_window,
      f.order_id as feedback_order,f.rating,f.created_at as feedback_at
    from guests g
    left join lateral (
      select count(*) as visits,sum(total) as spend,min(created_at) as first_at,max(created_at) as last_at,
        (array_agg(id order by created_at desc))[1] as last_order_id,
        array_agg(distinct channel) as channels,array_agg(distinct mode) as modes,
        count(*) filter(where created_at>=${start} and created_at<${end}) as in_window
      from orders where tenant_id=g.tenant_id and guest_id=g.id having count(*)>0
    ) o on true
    left join lateral (
      select f.order_id,f.rating,f.created_at from order_feedback f
        join orders x on x.tenant_id=f.tenant_id and x.id=f.order_id
      where f.tenant_id=g.tenant_id and x.guest_id=g.id order by f.created_at desc limit 1
    ) f on true
    where ${guestId}::uuid is null or g.id=${guestId}::uuid
    order by g.created_at desc,g.id limit 50000`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    locale: r.locale,
    optIn: {
      email: r.email_opt_in,
      sms: r.sms_opt_in,
      whatsapp: r.whatsapp_opt_in,
    },
    createdAt: r.created_at.getTime(),
    consentAt: r.first_consent_at?.getTime() ?? null,
    visits: r.visits,
    spend: r.spend,
    firstAt: r.first_at?.getTime() ?? null,
    lastAt: r.last_at?.getTime() ?? null,
    lastOrderId: r.last_order_id ?? null,
    channels: r.channels,
    modes: r.modes,
    visitsInWindow: r.in_window,
    feedback: r.feedback_order
      ? {
          orderId: r.feedback_order,
          rating: r.rating,
          at: r.feedback_at.getTime(),
        }
      : null,
  }));
}
export async function listGuests(tx: Tx, s: Session, query: string) {
  permit(s, managers);
  const needle = query.trim().toLowerCase().slice(0, 80);
  const all = await guestStats(tx);
  const matched = needle
    ? all.filter((g) =>
        [g.name, g.email ?? "", g.phone ?? ""].some((v) =>
          v.toLowerCase().includes(needle),
        ),
      )
    : all;
  return {
    total: all.length,
    subscribed: Object.fromEntries(
      marketingChannels.map((c) => [c, all.filter((g) => g.optIn[c]).length]),
    ),
    guests: matched.slice(0, 200),
  };
}
export const guestSave = z
  .object({
    operationId: id,
    id: id.nullable().default(null),
    name: z.string().trim().max(80).default(""),
    email: guestEmail.nullable().default(null),
    phone: z.string().trim().min(8).max(24).nullable().default(null),
    locale: z.enum(["es", "en"]).default("es"),
    consent: consentInput,
    /** The manager confirms the guest asked for each newly granted channel. */
    confirmed: z.boolean().default(false),
  })
  .strict()
  .refine((g) => g.email || g.phone, "contact_required");
export async function saveGuest(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = guestSave.parse(raw);
  return once(tx, s, p.operationId, "guest.save", p, async () => {
    const phone = p.phone
      ? normalizePhone(p.phone, dialCode(s.restaurant.currency))
      : null;
    const guestId = p.id ?? randomUUID();
    const [clash] =
      await tx`select id from guests where id<>${guestId} and ((${p.email}::text is not null and email=${p.email}) or (${phone}::text is not null and phone=${phone}))`;
    if (clash) throw new DomainError("guest_exists", 409);
    const [old] = await tx`select * from guests where id=${guestId} for update`;
    if (p.id && !old) throw new DomainError("not_found", 404);
    // Changing an address withdraws consent given for the previous one.
    if (old)
      for (const channel of marketingChannels) {
        const before = channel === "email" ? old.email : old.phone;
        const after = channel === "email" ? p.email : phone;
        if (before !== after)
          await setConsent(
            tx,
            s.tenantId,
            guestId,
            channel,
            false,
            "manager",
            s.employeeId,
          );
      }
    if (old)
      await tx`update guests set name=${p.name},email=${p.email},phone=${phone},locale=${p.locale} where id=${guestId}`;
    else
      await tx`insert into guests(tenant_id,id,name,email,phone,locale,source) values(${s.tenantId},${guestId},${p.name},${p.email},${phone},${p.locale},'manager')`;
    for (const channel of marketingChannels) {
      const [current] =
        await tx`select email_opt_in,sms_opt_in,whatsapp_opt_in from guests where id=${guestId}`;
      if (p.consent[channel] === current[column[channel]]) continue;
      if (p.consent[channel] && !p.confirmed)
        throw new DomainError("consent_confirmation_required");
      await setConsent(
        tx,
        s.tenantId,
        guestId,
        channel,
        p.consent[channel],
        "manager",
        s.employeeId,
        p.consent[channel] ? consentWording[p.locale] : "",
      );
    }
    await audit(tx, s, "guest.saved", guestId, { consent: p.consent });
    return (await guestStats(tx, undefined, guestId))[0];
  });
}
export async function guestConsents(tx: Tx, s: Session, guestId: string) {
  permit(s, managers);
  return tx`select c.channel,c.granted,c.source,c.created_at,e.name as actor
    from guest_consents c left join employees e on e.tenant_id=c.tenant_id and e.id=c.actor_id
    where c.guest_id=${guestId} order by c.created_at desc limit 100`;
}
/** Export is never plan-gated: the restaurant always owns its guest list. */
export async function exportGuests(tx: Tx, s: Session) {
  permit(s, managers);
  const header = [
    "name",
    "email",
    "phone",
    "locale",
    "email_opt_in",
    "sms_opt_in",
    "whatsapp_opt_in",
    "visits",
    "spend_minor",
    "last_visit",
    "created_at",
  ];
  const rows = (await guestStats(tx)).map((g) =>
    [
      g.name,
      g.email,
      g.phone,
      g.locale,
      g.optIn.email,
      g.optIn.sms,
      g.optIn.whatsapp,
      g.visits,
      g.spend,
      g.lastAt ? new Date(g.lastAt).toISOString() : "",
      new Date(g.createdAt).toISOString(),
    ]
      .map(csvCell)
      .join(","),
  );
  await audit(tx, s, "guest.exported", s.tenantId, { count: rows.length });
  return [header.join(","), ...rows].join("\r\n") + "\r\n";
}
export const feedbackInput = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(500).default(""),
  })
  .strict();
export async function recordFeedback(
  tx: Tx,
  tenantId: string,
  orderId: string,
  raw: unknown,
) {
  const p = feedbackInput.parse(raw);
  const [order] = await tx`select id from orders where id=${orderId}`;
  if (!order) throw new DomainError("not_found", 404);
  await tx`insert into order_feedback(tenant_id,order_id,rating,comment) values(${tenantId},${orderId},${p.rating},${p.comment}) on conflict(tenant_id,order_id) do nothing`;
  const [saved] =
    await tx`select rating,comment from order_feedback where order_id=${orderId}`;
  return saved;
}
