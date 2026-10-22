import type { Tx } from "../db.js";
import { permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { entitlement, requirePro } from "../entitlements.js";
import { queueDelivery } from "./queue.js";
import { audit } from "../orders.js";
import { DomainError, type Session } from "../../shared/domain.js";
import {
  deliveryCommand,
  deliveryProvider,
  deliveryStore,
  validDeliveryLiveUrl,
  type DeliveryView,
} from "../../shared/delivery.js";

export async function deliveryView(tx: Tx, s: Session): Promise<DeliveryView> {
  permit(s, ["owner", "manager"]);
  const [platform] =
    await tx`select available from delivery_platform where id=1 and updated_at>now()-interval '2 minutes'`;
  const rows = await tx`select * from delivery_connections order by provider`;
  const days =
    await tx`select d.*,d.day::text as day_text from delivery_daily_reports d join delivery_connections c
    on c.tenant_id=d.tenant_id and c.provider=d.provider and c.store_uuid=d.store_id
    order by day desc,provider limit 21`;
  return {
    issues: (
      await tx`select a.provider,a.day::text as day,a.error_code from delivery_day_attempts a
      join delivery_connections c on c.tenant_id=a.tenant_id and c.provider=a.provider and (c.generation::text || ':' || c.store_id)=a.store_id
      where a.error_code is not null order by a.day desc limit 30`
    ).map((r) => ({
      provider: r.provider,
      day: r.day,
      errorCode: r.error_code,
    })),
    available: platform?.available ?? [],
    pro: (await entitlement(tx)).plan === "pro",
    connections: rows.map((r) => ({
      provider: r.provider,
      state: r.state,
      generation: r.generation,
      stores: r.stores,
      store: r.store_id ? { id: r.store_id, name: r.store_name } : null,
      lastSyncedAt: r.last_synced_at?.toISOString() ?? null,
      errorCode: r.error_code,
      loginExpiresAt: r.login_expires_at?.toISOString() ?? null,
    })),
    days: days.map((r) => ({
      provider: r.provider,
      day: r.day_text,
      orderCount: r.order_count,
      gross: Number(r.gross),
      adjusted: Number(r.adjusted),
      payout: r.payout === null ? null : Number(r.payout),
      currency: r.currency,
      updatedAt: r.updated_at.toISOString(),
    })),
  };
}

export async function deliveryAction(
  tx: Tx,
  s: Session,
  rawProvider: unknown,
  raw: unknown,
) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
  const provider = deliveryProvider.parse(rawProvider),
    input = deliveryCommand.parse(raw);
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + ":delivery:" + provider},941))`;
  await tx`insert into delivery_connections(tenant_id,provider) values(${s.tenantId},${provider}) on conflict do nothing`;
  const [row] =
    await tx`select * from delivery_connections where provider=${provider} for update`;
  if (input.action !== "disconnect") {
    await requirePro(tx);
    const [ready] =
      await tx`select 1 from delivery_platform where id=1 and ${provider}=any(available) and updated_at>now()-interval '2 minutes'`;
    if (!ready) throw new DomainError("delivery_unavailable", 503);
  }
  if (input.action === "connect") {
    // Repeated taps do not create a second paid browser session.
    if (
      [
        "preparing",
        "awaiting_login",
        "verifying",
        "choose_store",
        "syncing",
        "disconnecting",
      ].includes(row.state)
    )
      throw new DomainError("delivery_busy", 409);
    const generation = row.generation + 1;
    await tx`update delivery_connections set generation=${generation},state='preparing',
      consent_version=${input.consent},consent_at=now(),consent_by=${s.employeeId},
      store_uuid=null,login_url=null,login_expires_at=null,error_code=null,updated_at=now() where provider=${provider}`;
    await queueDelivery(tx, s.tenantId, provider, generation, "connect");
    await queueDelivery(
      tx,
      s.tenantId,
      provider,
      generation,
      "maintain",
      new Date(Date.now() + 86400000),
    );
  } else if (input.action === "disconnect") {
    if (
      row.state === "disconnected" ||
      (row.state === "disconnecting" && !row.error_code)
    )
      return deliveryView(tx, s);
    const generation = row.generation + 1;
    await tx`update delivery_connections set generation=${generation},state='disconnecting',login_url=null,
      login_expires_at=null,error_code=null,updated_at=now() where provider=${provider}`;
    await queueDelivery(tx, s.tenantId, provider, generation, "disconnect");
  } else {
    if (row.generation !== input.generation)
      throw new DomainError("delivery_stale", 409);
    if (input.action === "verify") {
      if (
        row.state !== "awaiting_login" ||
        !row.login_expires_at ||
        row.login_expires_at <= new Date()
      )
        throw new DomainError("delivery_login_expired", 409);
      if (row.consent_by !== s.employeeId)
        throw new DomainError("forbidden", 403);
      await tx`update delivery_connections set state='verifying',updated_at=now() where provider=${provider}`;
      await queueDelivery(tx, s.tenantId, provider, row.generation, "verify");
    } else {
      if (row.state !== "choose_store")
        throw new DomainError("delivery_stale", 409);
      const store = deliveryStore
        .array()
        .parse(row.stores)
        .find((x) => x.id === input.storeId);
      if (!store) throw new DomainError("delivery_store_invalid", 400);
      await tx`update delivery_connections set store_id=${store.id},store_name=${store.name},state='syncing',
        store_uuid=case when store_id=${store.id} then store_uuid else null end,
        login_url=null,login_expires_at=null,updated_at=now() where provider=${provider}`;
      await queueDelivery(
        tx,
        s.tenantId,
        provider,
        row.generation,
        "sync",
        new Date(Date.now() + 10000),
      );
    }
  }
  await audit(tx, s, "delivery_" + input.action, provider, { provider });
  return deliveryView(tx, s);
}

export async function deliveryLogin(tx: Tx, s: Session, rawProvider: unknown) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
  const provider = deliveryProvider.parse(rawProvider);
  const [r] =
    await tx`select login_url from delivery_connections where provider=${provider}
    and consent_by=${s.employeeId} and state='awaiting_login' and login_expires_at>now()`;
  if (!r?.login_url || !validDeliveryLiveUrl(r.login_url))
    throw new DomainError("delivery_login_expired", 409);
  return { url: r.login_url as string };
}
