// Kiosk diner commands (039; specs/kiosk-w4.md §4.2–§4.3; critic R12, R20–R24). Each runs inside
// tenant(sql, link.tenantId, fn) and has no outside side effects (the router logs and sets the
// cookie). The device binding is an HttpOnly cookie whose secret is stored only as a hash; it is
// required to take a card payment, look up a club member and send heartbeats. Without it the kiosk
// still takes orders exactly as before 039: holds paid and accepted at the counter.
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Tx } from "./db.js";
import {
  DomainError,
  sum,
  type Product,
  type Session,
} from "../shared/domain.js";
import { audit } from "./orders.js";
import { catalog, publicCatalog } from "./menu-read.js";
import { staffOnlineSql } from "./public-links.js";
import { statusHash } from "./public-tokens.js";
import { placeHold, type HoldRow } from "./public-diner.js";
import { fiscalTicketIdentity } from "./fiscal-read.js";
import { selfInvoiceOffered } from "./cfdi/store.js";
import { liveAttemptForHold } from "./payments/guards.js";
import {
  loyaltyKioskConfig,
  lookupMemberForKiosk,
  memberFromToken,
} from "./loyalty/kiosk.js";
import { orderLoyaltyView } from "./loyalty/ledger.js";
import { joinUrlForOrder } from "./loyalty/links.js";
import { kioskSelfCheckoutEnabled, menuPhotosEnabled } from "./kiosk-config.js";
import {
  canonicalRequest,
  holdExpiryGraceSeconds,
  holdLabel,
} from "../shared/public-ordering.js";
import { PAYMENTS_LIMITS } from "../shared/payments.js";
import {
  KIOSK_COOKIE_REFRESH_DAYS,
  KIOSK_LIMITS,
  kioskHeartbeatInput,
  kioskMemberInput,
  kioskOrderInput,
  kioskPairInput,
  kioskPaymentState,
  type KioskCheckoutView,
  type KioskMenuBlock,
  type KioskMemberResult,
  type KioskPaymentMode,
  type KioskSubmitResult,
} from "../shared/kiosk.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
/** sha256('gm-kiosk-device-v1:' || secret): the only stored form of the device cookie. */
export const deviceSecretHash = (secret: string) =>
  sha("gm-kiosk-device-v1:" + secret);
/** sha256('gm-kiosk-pair-v1:' || stationId || ':' || code): the only stored form of a code. */
export const pairingCodeHash = (stationId: string, code: string) =>
  sha(`gm-kiosk-pair-v1:${stationId}:${code}`);
/** 16 CSPRNG bytes, base64url (the link token's shape, so limiters can scope by it). */
export const newDeviceSecret = () => randomBytes(16).toString("base64url");
const SECRET = /^[A-Za-z0-9_-]{22}$/;
export const wellFormedSecret = (v: unknown): v is string =>
  typeof v === "string" && SECRET.test(v);

export type KioskStation = {
  id: string;
  terminal_id: string | null;
  register_device_id: string | null;
  archived_at: Date | null;
  version: number;
};
export type KioskDevice = { id: string; station_id: string };

/** The kiosk link's station (null for a kiosk link created before 039 and not yet replaced). */
export async function linkStation(
  tx: Tx,
  linkId: string,
): Promise<{ station: KioskStation | null; label: string; kind: string }> {
  const [r] =
    await tx`select l.kind,l.label,s.id,s.terminal_id,s.register_device_id,s.archived_at,s.version
    from public_links l left join kiosk_stations s on s.tenant_id=l.tenant_id and s.id=l.station_id
    where l.id=${linkId}`;
  if (!r) throw new DomainError("public_link_invalid", 404);
  return {
    kind: r.kind as string,
    label: r.label as string,
    station: r.id
      ? {
          id: r.id as string,
          terminal_id: r.terminal_id as string | null,
          register_device_id: r.register_device_id as string | null,
          archived_at: r.archived_at as Date | null,
          version: r.version as number,
        }
      : null,
  };
}

/** The paired, unrevoked device of this station whose secret the cookie carries, or null. */
export async function boundDevice(
  tx: Tx,
  station: KioskStation | null,
  secret: string | null,
): Promise<KioskDevice | null> {
  if (!station || station.archived_at || !wellFormedSecret(secret)) return null;
  const hash = deviceSecretHash(secret);
  const [d] = await tx<(KioskDevice & { secret_hash: string })[]>`
    select id,station_id,secret_hash from kiosk_devices
    where secret_hash=${hash} and revoked_at is null and paired_at is not null`;
  if (!d || d.station_id !== station.id) return null;
  // Constant-time confirmation of the indexed match (defence in depth).
  return timingSafeEqual(Buffer.from(d.secret_hash), Buffer.from(hash))
    ? { id: d.id, station_id: d.station_id }
    : null;
}

type Settings = {
  payment_mode: KioskPaymentMode;
  ask_fulfillment: boolean;
  suggestions: boolean;
  loyalty_at_kiosk: boolean;
  version: number;
};
export async function kioskSettingsRow(tx: Tx): Promise<Settings> {
  const [r] = await tx<
    Settings[]
  >`select payment_mode,ask_fulfillment,suggestions,loyalty_at_kiosk,version
    from kiosk_settings`;
  return (
    r ?? {
      payment_mode: "counter",
      ask_fulfillment: true,
      suggestions: true,
      loyalty_at_kiosk: false,
      version: 0,
    }
  );
}

export type KioskState = {
  settings: Settings;
  station: KioskStation | null;
  device: KioskDevice | null;
  label: string;
  tillOpen: boolean;
  orderingOpen: boolean;
  selfCheckout: boolean;
  card: boolean;
  counterOnly: KioskSubmitResult["counterOnly"];
  terminal: { id: string; provider: string } | null;
};

/**
 * Whether this kiosk may take the payment itself (§2.1, computed, never stored): the ops switch,
 * public ordering open for the link (not paused, a staff terminal seen in 5 minutes), a bound
 * device of this link's station and the receiving till's open drawer. Card additionally needs an
 * integrated, active terminal on the station (critic R14) whose provider is configured, and a
 * payment mode other than counter. Plain reads only.
 */
export async function kioskState(
  tx: Tx,
  linkId: string,
  secret: string | null,
): Promise<KioskState> {
  const { station, label, kind } = await linkStation(tx, linkId);
  if (kind !== "kiosk") throw new DomainError("public_link_invalid", 404);
  const settings = await kioskSettingsRow(tx);
  const device = await boundDevice(tx, station, secret);
  const [r] = await tx`select
      coalesce((select paused from public_ordering_settings),false) as paused,
      ${staffOnlineSql(tx)} as staff_online,
      exists(select 1 from cash_sessions where device_id=${station?.register_device_id ?? null}
        and closed_at is null) as till_open,
      (select json_build_object('id',t.id,'kind',t.kind,'provider',
          case t.kind when 'mercadopago_point' then 'mercadopago' when 'clip_pinpad' then 'clip' end,
          'ready', t.active and t.archived_at is null and t.kind <> 'manual'
            and exists(select 1 from payments_platform p where p.id=1 and
              (case t.kind when 'mercadopago_point' then 'mercadopago' else 'clip' end)=any(p.providers))
            and exists(select 1 from payment_provider_accounts a where a.state='active' and
              a.provider=(case t.kind when 'mercadopago_point' then 'mercadopago' else 'clip' end)))
        from payment_terminals t where t.id=${station?.terminal_id ?? null}) as terminal`;
  const tillOpen = !!r.till_open;
  const orderingOpen = !r.paused && !!r.staff_online;
  const flag = kioskSelfCheckoutEnabled();
  const counterOnly: KioskState["counterOnly"] = !flag
    ? "disabled"
    : !device
      ? "unbound"
      : !tillOpen
        ? "till_closed"
        : settings.payment_mode === "counter"
          ? "mode"
          : !r.terminal?.ready
            ? "no_terminal"
            : null;
  const selfCheckout = flag && !!device && tillOpen && orderingOpen;
  return {
    settings,
    station,
    device,
    label,
    tillOpen,
    orderingOpen,
    selfCheckout,
    card: selfCheckout && counterOnly === null,
    counterOnly,
    terminal: r.terminal?.ready
      ? { id: r.terminal.id as string, provider: r.terminal.provider as string }
      : null,
  };
}

const popularCache = new Map<string, { at: number; ids: string[] }>();
/**
 * "Lo más pedido a esta hora" (§2.8): the 6 products sold most within ±2 h of now over the last
 * 30 business days, cached per restaurant for 15 minutes. One bounded statement over the
 * orders(tenant_id, business_date, …) index.
 */
async function popular(tx: Tx, tenantId: string, timezone: string) {
  const hit = popularCache.get(tenantId);
  if (hit && Date.now() - hit.at < KIOSK_LIMITS.popularCacheMs) return hit.ids;
  const rows = await tx`select l.product_id,sum((l.data->>'quantity')::int) as n
    from orders o join order_lines l on l.tenant_id=o.tenant_id and l.order_id=o.id
    where o.business_date>=(now() at time zone ${timezone})::date-${KIOSK_LIMITS.popularDays}::int
      and o.state<>'cancelled'
      and abs(extract(epoch from ((o.created_at at time zone ${timezone})::time
        -(now() at time zone ${timezone})::time)))<=${KIOSK_LIMITS.popularWindowHours * 3600}
    group by l.product_id order by n desc, l.product_id limit 12`;
  const ids = rows.map((r) => r.product_id as string);
  popularCache.set(tenantId, { at: Date.now(), ids });
  return ids;
}
/** Test hook: the popular cache is per process. */
export const forgetPopular = () => popularCache.clear();

/** GET /api/public/kiosk/state: the kiosk block of the menu (§4.2; its own route: cookie path). */
export async function kioskMenuBlock(
  tx: Tx,
  linkId: string,
  secret: string | null,
): Promise<KioskMenuBlock> {
  const st = await kioskState(tx, linkId, secret);
  const [t] =
    await tx`select id,timezone from restaurants where id=current_setting('app.tenant_id')::uuid`;
  const sellable = new Set(
    ((await publicCatalog(tx)) as Product[])
      .filter((p) => p.available)
      .map((p) => p.id),
  );
  const rows = st.settings.suggestions
    ? await tx`select scope,source_product_id,product_ids from menu_suggestions`
    : [];
  const keep = (ids: string[]) => ids.filter((id) => sellable.has(id));
  const byProduct: Record<string, string[]> = {};
  let cart: string[] = [];
  for (const r of rows) {
    const ids = keep(r.product_ids as string[]);
    if (r.scope === "cart") cart = ids;
    else if (sellable.has(r.source_product_id as string) && ids.length)
      byProduct[r.source_product_id as string] = ids;
  }
  const loyalty =
    st.settings.loyalty_at_kiosk && st.device
      ? await loyaltyKioskConfig(tx)
      : null;
  return {
    bound: !!st.device,
    selfCheckout: st.selfCheckout,
    card: st.card,
    paymentMode: st.settings.payment_mode,
    askFulfillment: st.settings.ask_fulfillment,
    suggestions: {
      cart,
      byProduct,
      popular:
        st.settings.suggestions && !cart.length
          ? keep(await popular(tx, t.id as string, t.timezone as string)).slice(
              0,
              KIOSK_LIMITS.shownSuggestions,
            )
          : [],
    },
    loyalty: loyalty
      ? {
          enabled: true,
          stampsRequired: loyalty.stampsRequired,
          reward: loyalty.rewardLabel,
        }
      : null,
    stationLabel: st.label,
  };
}

type CheckoutRow = {
  hold_id: string;
  station_id: string;
  device_id: string | null;
  payment_choice: "card" | "counter" | null;
  attempt_id: string | null;
  attempt_count: number;
  loyalty_member_id: string | null;
};

/** A kiosk hold by the diner's status key, through the link it was sent from (active or not). */
async function kioskHoldByKey(tx: Tx, linkId: string, statusKey: string) {
  if (!SECRET.test(statusKey))
    throw new DomainError("public_hold_not_found", 404);
  const grace = holdExpiryGraceSeconds("pay_first");
  const [h] = await tx<(HoldRow & { expired: boolean })[]>`select h.*,
      (h.state='pending' and h.expires_at<=now()-make_interval(secs=>${grace}::int)) as expired
    from public_order_holds h
    where h.status_key_hash=${statusHash(statusKey)} and h.link_id=${linkId} and h.channel='kiosk'`;
  if (!h) throw new DomainError("public_hold_not_found", 404);
  const [c] = await tx<
    CheckoutRow[]
  >`select * from kiosk_checkouts where hold_id=${h.id}`;
  if (!c) throw new DomainError("public_hold_not_found", 404);
  return { h, c };
}

/** The same, locked (LO-2b: the hold, then its checkout), with the exact expiry. */
async function lockKioskHold(tx: Tx, linkId: string, statusKey: string) {
  if (!SECRET.test(statusKey))
    throw new DomainError("public_hold_not_found", 404);
  const [h] = await tx<(HoldRow & { expired: boolean })[]>`select h.*,
      (h.state='pending' and h.expires_at<=now()) as expired
    from public_order_holds h
    where h.status_key_hash=${statusHash(statusKey)} and h.link_id=${linkId} and h.channel='kiosk'
    for update`;
  if (!h) throw new DomainError("public_hold_not_found", 404);
  const [c] = await tx<
    CheckoutRow[]
  >`select * from kiosk_checkouts where hold_id=${h.id} for update`;
  if (!c) throw new DomainError("public_hold_not_found", 404);
  return { h, c };
}

/**
 * GET /api/public/kiosk/checkout (read-only, critic R24): the hold, its latest attempt as the
 * diner may see it, and once paid the order number, folio, self-invoice code (LD-41: the kiosk
 * diner is the payer of a one-diner check) and club progress or join offer. At most 7
 * statements.
 */
export async function kioskCheckout(
  tx: Tx,
  linkId: string,
  statusKey: string,
): Promise<KioskCheckoutView> {
  const { h, c } = await kioskHoldByKey(tx, linkId, statusKey);
  return checkoutView(tx, h, c);
}

async function checkoutView(
  tx: Tx,
  h: HoldRow & { expired: boolean },
  c: CheckoutRow,
): Promise<KioskCheckoutView> {
  const [a] = c.attempt_id
    ? await tx`select state,amount,cancel_requested_at,error_code from payment_attempts where id=${c.attempt_id}`
    : [];
  const view: KioskCheckoutView = {
    label: holdLabel("kiosk", h.number),
    holdState: h.state === "pending" && h.expired ? "expired" : h.state,
    orderNumber: null,
    total: h.quoted_total,
    paymentChoice: c.payment_choice,
    payment: {
      state: kioskPaymentState(a?.state as string | undefined),
      attempts: c.attempt_count,
      cancelRequested: !!a?.cancel_requested_at,
      amount: (a?.amount as number | undefined) ?? null,
    },
    paid: false,
    // Only a review is "paid, no order". 'approved' is the short step before payments_settle or
    // the next sync creates the order, so the kiosk keeps polling through it (KIOSK-MONEY-2).
    paidNoOrder: a?.state === "review",
    folio: null,
    selfInvoiceCode: null,
    loyalty: null,
    joinOffer: null,
  };
  if (h.state !== "accepted" || !h.order_id) return view;
  view.paidNoOrder = false;
  const [o] = await tx`select o.number,o.total,
      coalesce((select sum(t.amount) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),0)::int as paid
    from orders o where o.id=${h.order_id}`;
  view.orderNumber = o.number as number;
  view.total = o.total as number;
  view.paid = (o.paid as number) >= (o.total as number);
  const ticket = view.paid ? await fiscalTicketIdentity(tx, h.order_id) : null;
  if (ticket) {
    view.folio = ticket.folio;
    view.selfInvoiceCode = (await selfInvoiceOffered(tx))
      ? ticket.selfInvoiceCode
      : null;
  }
  const settings = await kioskSettingsRow(tx);
  if (settings.loyalty_at_kiosk && (await loyaltyKioskConfig(tx))) {
    const l = await orderLoyaltyView(tx, h.order_id);
    view.loyalty = l.member
      ? {
          member: true,
          stampsEarned: l.earned,
          stamps: l.member.stamps,
          required: l.member.required,
          rewards: l.member.rewards,
        }
      : null;
    if (!l.member && view.paid)
      view.joinOffer = await joinUrlForOrder(tx, h.order_id);
  }
  return view;
}

/**
 * POST /api/public/kiosk/orders: the diner's order becomes a pending kiosk hold (submitHold's
 * checks, caps and churn under key 925) with its checkout, in one transaction. "Para aquí" makes
 * a dine-in hold without a table when the kiosk asks. The member token is kept only from a bound
 * device of this station (R22); an expired one is dropped silently. Idempotent on operationId.
 */
export async function kioskSubmit(
  tx: Tx,
  linkId: string,
  raw: unknown,
  secret: string | null,
): Promise<KioskSubmitResult & { zeroTotal: boolean; holdId: string }> {
  const p = kioskOrderInput.parse(raw);
  const st = await kioskState(tx, linkId, secret);
  const { fulfillment, memberToken, ...order } = p;
  const mode =
    st.settings.ask_fulfillment && fulfillment === "here"
      ? "dine_in"
      : "takeaway";
  let memberId: string | null = null;
  if (memberToken && st.device && st.station && st.settings.loyalty_at_kiosk) {
    try {
      const [t] = await tx`select current_setting('app.tenant_id') as id`;
      memberId = await memberFromToken(tx, memberToken, {
        tenantId: t.id as string,
        stationId: st.station.id,
      });
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
    }
  }
  const placed = await placeHold(
    tx,
    linkId,
    order,
    canonicalRequest({ kiosk: 1, ...p }),
    {
      mode,
      kind: "kiosk",
      afterInsert: async (hold) => {
        // A pre-039 kiosk link has no station: its holds stay counter holds, as before 039.
        if (!st.station) return;
        // A kiosk that cannot take the card sends the guest to the counter at once: the hold is
        // a «Pagar en caja» hold from the start, a normal inbox card (KIOSK-UX-04).
        await tx`insert into kiosk_checkouts(tenant_id,hold_id,station_id,device_id,fire_operation_id,
            loyalty_member_id,payment_choice)
          values(current_setting('app.tenant_id')::uuid,${hold.id},${st.station.id},${st.device?.id ?? null},
            ${randomUUID()},${memberId},${st.card ? null : "counter"})`;
      },
    },
  );
  const [c] = await tx<
    CheckoutRow[]
  >`select * from kiosk_checkouts where hold_id=${placed.hold.id}`;
  const checkout = c
    ? await checkoutView(tx, { ...placed.hold, expired: false }, c)
    : null;
  return {
    hold: placed.view,
    checkout: checkout ?? {
      label: holdLabel("kiosk", placed.hold.number),
      holdState: placed.hold.state,
      orderNumber: null,
      total: placed.hold.quoted_total,
      paymentChoice: null,
      payment: {
        state: "none",
        attempts: 0,
        cancelRequested: false,
        amount: null,
      },
      paid: false,
      paidNoOrder: false,
      folio: null,
      selfInvoiceCode: null,
      loyalty: null,
      joinOffer: null,
    },
    counterOnly: c
      ? st.card
        ? null
        : (st.counterOnly ?? "unbound")
      : "unbound",
    member: !!c?.loyalty_member_id,
    // From the hold's current state, not from `created` (KIOSK-CONCURRENCY-3): a replay of a
    // submit whose zero-total accept failed (a 500 the kiosk retries with the same keys) runs it
    // again; kioskAccept is idempotent on the checkout's fire_operation_id (spec §4.3).
    zeroTotal:
      placed.hold.state === "pending" &&
      !!c &&
      st.selfCheckout &&
      placed.hold.quoted_total === 0,
    holdId: placed.hold.id,
  };
}

/**
 * POST /api/public/kiosk/counter: "Pagar en caja". The hold becomes a normal inbox card under the
 * counter policy. Refused while a card attempt may still be taken (kiosk_charge_pending).
 */
export async function kioskCounter(
  tx: Tx,
  linkId: string,
  statusKey: string,
): Promise<KioskCheckoutView> {
  const { h, c } = await lockKioskHold(tx, linkId, statusKey);
  if (h.state !== "pending") return checkoutView(tx, h, c);
  const live = await liveAttemptForHold(tx, h.id);
  if (live) throw new DomainError("kiosk_charge_pending", 409);
  if (c.payment_choice !== "counter") {
    await tx`update kiosk_checkouts set payment_choice='counter',updated_at=now() where hold_id=${h.id}`;
    c.payment_choice = "counter";
  }
  return checkoutView(tx, h, c);
}

/**
 * POST /api/public/kiosk/pair: claims the station's pending pairing code. Every failure (wrong,
 * expired, used, exhausted, no pending code) is one answer (kiosk_pairing_invalid, no oracle); a
 * wrong code counts towards the 5 tries, committed with the refusal. Returns the new secret for
 * the router's Set-Cookie.
 */
export async function claimPairing(
  tx: Tx,
  linkId: string,
  raw: unknown,
): Promise<{ ok: true; secret: string; stationLabel: string } | { ok: false }> {
  const p = kioskPairInput.parse(raw);
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':public-op:'||${p.operationId},0))`;
  const { station, label } = await linkStation(tx, linkId);
  if (!station || station.archived_at) return { ok: false };
  const [d] = await tx`select id,pairing_code_hash,pairing_attempts,
      pairing_expires_at>clock_timestamp() as fresh
    from kiosk_devices
    where station_id=${station.id} and revoked_at is null and paired_at is null for update`;
  if (!d || !d.fresh || d.pairing_attempts >= KIOSK_LIMITS.pairingTries)
    return { ok: false };
  const expected = Buffer.from(d.pairing_code_hash as string);
  const given = Buffer.from(pairingCodeHash(station.id, p.code));
  if (!timingSafeEqual(expected, given)) {
    await tx`update kiosk_devices set pairing_attempts=pairing_attempts+1 where id=${d.id}`;
    return { ok: false };
  }
  const secret = newDeviceSecret();
  await tx`update kiosk_devices set secret_hash=${deviceSecretHash(secret)},paired_at=now(),
      pairing_code_hash=null,pairing_expires_at=null
    where id=${d.id}`;
  const [who] =
    await tx`select tenant_id,created_by from kiosk_devices where id=${d.id}`;
  await audit(
    tx,
    { tenantId: who.tenant_id, employeeId: who.created_by } as Session,
    "kiosk.device_paired",
    d.id as string,
    { stationId: station.id, via: { kind: "kiosk", stationId: station.id } },
  );
  return { ok: true, secret, stationLabel: label };
}

/** POST /api/public/kiosk/heartbeat: one bounded UPDATE (at most once per 50 s per device). */
export async function kioskHeartbeat(
  tx: Tx,
  linkId: string,
  raw: unknown,
  secret: string | null,
): Promise<{ refreshCookie: boolean }> {
  const p = kioskHeartbeatInput.parse(raw);
  const { station } = await linkStation(tx, linkId);
  const device = await boundDevice(tx, station, secret);
  if (!device) throw new DomainError("kiosk_device_required", 403);
  await tx`update kiosk_devices set last_seen_at=now(),build=${p.build},viewport=${p.viewport}
    where id=${device.id} and revoked_at is null
      and (last_seen_at is null or last_seen_at<now()-make_interval(secs=>${KIOSK_LIMITS.heartbeatWriteSeconds}))`;
  // KIOSK-SECURITY-3: the route re-sends the cookie of a binding past KIOSK_COOKIE_REFRESH_DAYS.
  const [d] = await tx<{ old: boolean }[]>`
    select paired_at<now()-make_interval(days=>${KIOSK_COOKIE_REFRESH_DAYS}) as old
    from kiosk_devices where id=${device.id}`;
  return { refreshCookie: d?.old === true };
}

/**
 * POST /api/public/kiosk/member: "Soy del club" (critic R20–R22). Device required; nothing is
 * created; counts and a masked phone only (no name). Only when the club is on for the restaurant
 * and at the kiosk.
 */
export async function kioskMember(
  tx: Tx,
  linkId: string,
  raw: unknown,
  secret: string | null,
): Promise<KioskMemberResult> {
  const p = kioskMemberInput.parse(raw);
  const st = await kioskState(tx, linkId, secret);
  if (!st.device || !st.station)
    throw new DomainError("kiosk_device_required", 403);
  if (!st.settings.loyalty_at_kiosk)
    throw new DomainError("loyalty_disabled", 409);
  return lookupMemberForKiosk(
    tx,
    { phone: p.phone, country: p.country },
    { stationId: st.station.id },
  );
}

/** The kiosk diner may only touch a checkout of a bound device's station (charge, sync, cancel). */
export async function requireDevice(
  tx: Tx,
  linkId: string,
  secret: string | null,
): Promise<{ station: KioskStation; device: KioskDevice; state: KioskState }> {
  const st = await kioskState(tx, linkId, secret);
  if (!st.device || !st.station)
    throw new DomainError("kiosk_device_required", 403);
  return { station: st.station, device: st.device, state: st };
}

/** Exposed for the charge module: the hold and checkout by status key, locked (LO-2b). */
export { kioskHoldByKey, lockKioskHold, checkoutView };

/** The provider minimum the kiosk checks before starting (payments' MP minimum). */
export const kioskMinimum = (provider: string) =>
  provider === "mercadopago" ? PAYMENTS_LIMITS.mpMinAmount : 1;

/** Sum of a hold's priced lines (the diner's quote). */
export const quotedOf = (h: HoldRow) => sum(h.priced.map((l) => l.total));

export { catalog, menuPhotosEnabled };
