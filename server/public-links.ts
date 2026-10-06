// Public ordering links and settings (032): create, replace and deactivate
// QR/kiosk links, the per-restaurant policies and the pause switch.
// Lock order (docs/PUBLIC_ORDERING.md "Lock order"): link writes take the
// tenant's public-links advisory key, then dining_tables FOR SHARE (sorted),
// then link rows FOR UPDATE; settings writes take the settings row (LO-3).
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { audit, once } from "./orders.js";
import { managers, operators, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { entitlement, requirePro } from "./entitlements.js";
import { activeTables } from "./floor.js";
import {
  forgetLinkHash,
  linkHash,
  linkRef,
  newPublicToken,
} from "./public-tokens.js";
import { DomainError, type Session } from "../shared/domain.js";
import {
  ORDERING_DEFAULTS,
  PUBLIC_LIMITS,
  linkCreateInput,
  linkPath,
  linkRevokeInput,
  pauseInput,
  settingsInput,
  tableLinksInput,
  type HoldPolicy,
  type LinkKind,
  type PublicLinkView,
  type PublicLinksResponse,
  type PublicSettingsView,
  type RevealedLink,
} from "../shared/public-ordering.js";

/**
 * True when an operator session on a shared terminal was seen in the last 5
 * minutes (sessions.last_seen_at is touched at most once a minute by any
 * authenticated request). Legacy device rows without a kind are inferred as
 * access does. A fragment for one statement inside a tenant transaction.
 */
export function staffOnlineSql(tx: Tx) {
  return tx`exists(select 1 from sessions x
    join employees e on e.tenant_id=x.tenant_id and e.id=x.employee_id
    join devices d on d.tenant_id=x.tenant_id and d.id=x.device_id
    where x.ended_at is null and not x.revoked and x.expires_at>now()
      and x.last_seen_at>now()-make_interval(secs=>${PUBLIC_LIMITS.staffOnlineSeconds})
      and e.active and e.role in ('owner','manager','cashier','server')
      and d.active and coalesce(d.kind, case when d.name='Owner browser' then 'personal' else 'terminal' end)='terminal')`;
}

/**
 * LO-3: serializes every link write of the tenant (caps, one active link per
 * table). Class 924 makes it an LO-3 area key for the lock-order ratchet
 * (class 0 would read as an LO-1 operation key).
 */
export async function lockLinks(tx: Tx) {
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id')||':public-links',924))`;
}

type LinkRow = {
  id: string;
  kind: LinkKind;
  channel: "qr" | "kiosk";
  table_id: string | null;
  label: string;
  token_hash: string;
  created_at: Date;
  revoked_at: Date | null;
  table_name: string | null;
  table_archived: boolean | null;
  created_by_name: string;
  last_hold_at: Date | null;
  pending_holds: number;
};

function toView(r: LinkRow): PublicLinkView {
  return {
    id: r.id,
    kind: r.kind,
    channel: r.channel,
    tableId: r.table_id,
    tableName: r.table_name,
    tableArchived: r.table_archived === true,
    label: r.label,
    ref: linkRef(r.token_hash),
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    lastHoldAt: r.last_hold_at ? r.last_hold_at.toISOString() : null,
    pendingHolds: r.pending_holds,
  };
}

const linkRows = (tx: Tx, where: ReturnType<Tx>) =>
  tx<
    LinkRow[]
  >`select l.id,l.kind,l.channel,l.table_id,l.label,l.token_hash,l.created_at,l.revoked_at,
      t.name as table_name,(t.archived_at is not null) as table_archived,e.name as created_by_name,
      (select max(h.created_at) from public_order_holds h where h.tenant_id=l.tenant_id and h.link_id=l.id) as last_hold_at,
      (select count(*)::int from public_order_holds h where h.tenant_id=l.tenant_id and h.link_id=l.id
         and h.state='pending' and h.expires_at>now() and h.created_at>now()-interval '2 hours') as pending_holds
    from public_links l
    left join dining_tables t on t.tenant_id=l.tenant_id and t.id=l.table_id
    join employees e on e.tenant_id=l.tenant_id and e.id=l.created_by
    where ${where}
    order by l.revoked_at nulls first,l.created_at desc,l.id`;

async function linkView(tx: Tx, linkId: string): Promise<PublicLinkView> {
  const [r] = await linkRows(tx, tx`l.id=${linkId}`);
  if (!r) throw new DomainError("not_found", 404);
  return toView(r);
}

/** Origin of APP_URL when it is an http(s) URL; the client falls back to location.origin. */
function baseUrl(): string | null {
  const value = process.env.APP_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** Inserts one link and returns it with its plaintext token (never persisted). */
async function insertLink(
  tx: Tx,
  s: Session,
  link: {
    kind: LinkKind;
    tableId: string | null;
    label: string;
    replacesId?: string | null;
  },
): Promise<RevealedLink> {
  const token = newPublicToken();
  const id = randomUUID();
  const channel = link.kind === "kiosk" ? "kiosk" : "qr";
  await tx`insert into public_links(tenant_id,id,token_hash,kind,channel,table_id,label,created_by,replaces_id)
    values(${s.tenantId},${id},${linkHash(token)},${link.kind},${channel},${link.tableId},${link.label},
      ${s.employeeId},${link.replacesId ?? null})`;
  return {
    ...(await linkView(tx, id)),
    token,
    path: linkPath(link.kind, token),
    baseUrl: baseUrl(),
  };
}

/** Revokes one active link row (the caller holds lockLinks); returns false if it was already revoked. */
export async function revokeLinkRow(
  tx: Tx,
  s: Session,
  linkId: string,
  reason: "revoked" | "rotated" | "abuse",
): Promise<boolean> {
  const [row] = await tx`update public_links
    set revoked_at=now(),revoked_by=${s.employeeId},revoke_reason=${reason}
    where id=${linkId} and revoked_at is null
    returning token_hash,kind,table_id`;
  if (!row) return false;
  // In-memory and idempotent: safe in a replayed tenant() body (rule 0.7). A
  // rollback only costs the next diner request one lookup, because the cache
  // never extends a link's validity (linkContext re-reads revoked_at).
  forgetLinkHash(row.token_hash);
  if (reason !== "rotated")
    await audit(tx, s, "public.link_revoked", linkId, {
      ref: linkRef(row.token_hash),
      kind: row.kind,
      tableId: row.table_id,
      reason,
    });
  return true;
}

/** Managers: active links, links revoked in the last 30 days, and the tables. */
export async function listLinks(
  tx: Tx,
  s: Session,
): Promise<PublicLinksResponse> {
  permit(s, managers);
  const links = await linkRows(
    tx,
    tx`(l.revoked_at is null or l.revoked_at>now()-interval '30 days')`,
  );
  const active = await activeTables(tx);
  const archivedWithLink = await tx`select t.id,t.name,a.name as area_name
    from dining_tables t left join dining_areas a on a.tenant_id=t.tenant_id and a.id=t.area_id
    where t.archived_at is not null and exists(select 1 from public_links l
      where l.tenant_id=t.tenant_id and l.table_id=t.id and l.revoked_at is null)
    order by t.name,t.id`;
  return {
    links: links.map(toView),
    tables: [
      ...active.map((t) => ({
        id: t.id as string,
        name: t.name as string,
        areaName: (t.area_name as string | null) ?? null,
        archived: false,
      })),
      ...archivedWithLink.map((t) => ({
        id: t.id as string,
        name: t.name as string,
        areaName: (t.area_name as string | null) ?? null,
        archived: true,
      })),
    ],
  };
}

/**
 * Creates one table, counter or kiosk link. Not wrapped in once(): the result
 * carries the plaintext token, and operations.result would persist it (the
 * same reasoning as access's createPairingCode). Throws before writing, so the
 * step-up prompt's retry of the identical body is safe.
 */
export async function createLink(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<RevealedLink> {
  permit(s, managers);
  requireRecentAuth(s);
  const p = linkCreateInput.parse(raw);
  await requirePro(tx);
  await lockLinks(tx);
  if (p.kind === "table") {
    const [t] =
      await tx`select id from dining_tables where id=${p.tableId} and archived_at is null for share`;
    if (!t) throw new DomainError("invalid_table", 400);
    const [existing] =
      await tx`select 1 from public_links where kind='table' and table_id=${p.tableId} and revoked_at is null`;
    if (existing) throw new DomainError("public_link_exists", 409);
  } else {
    const [n] =
      await tx`select count(*)::int as n from public_links where kind=${p.kind} and revoked_at is null`;
    if (n.n >= PUBLIC_LIMITS.activeLinks[p.kind])
      throw new DomainError("public_link_limit", 409);
  }
  const link = await insertLink(tx, s, {
    kind: p.kind,
    tableId: p.kind === "table" ? p.tableId : null,
    label: p.kind === "table" ? "" : p.label,
  });
  await audit(tx, s, "public.link_created", link.id, {
    kind: link.kind,
    tableId: link.tableId,
    ref: link.ref,
  });
  return link;
}

/** Replaces one active link with a new token (same kind, table and label). */
async function rotateRow(
  tx: Tx,
  s: Session,
  old: {
    id: string;
    kind: LinkKind;
    table_id: string | null;
    label: string;
    token_hash: string;
  },
): Promise<RevealedLink> {
  await revokeLinkRow(tx, s, old.id, "rotated");
  const link = await insertLink(tx, s, {
    kind: old.kind,
    tableId: old.table_id,
    label: old.label,
    replacesId: old.id,
  });
  await audit(tx, s, "public.link_rotated", link.id, {
    from: linkRef(old.token_hash),
    to: link.ref,
    tableId: old.table_id,
  });
  return link;
}

/**
 * Bulk table codes: creates a link for every listed table without one and,
 * with replaceExisting, replaces the others. Not once() (tokens).
 */
export async function createTableLinks(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<{
  created: RevealedLink[];
  skipped: { tableId: string; tableName: string }[];
}> {
  permit(s, managers);
  requireRecentAuth(s);
  const p = tableLinksInput.parse(raw);
  await requirePro(tx);
  await lockLinks(tx);
  const ids = [...new Set(p.tableIds)].sort();
  const tables =
    await tx`select id,name from dining_tables where id=any(${tx.array(ids)}::uuid[]) and archived_at is null order by id for share`;
  if (tables.length !== ids.length) throw new DomainError("invalid_table", 400);
  const existing = new Map(
    (
      await tx`select id,kind,table_id,label,token_hash from public_links
        where kind='table' and revoked_at is null and table_id=any(${tx.array(ids)}::uuid[])
        order by id for update`
    ).map((r) => [r.table_id as string, r]),
  );
  const order = (await activeTables(tx)).map((t) => t.id as string);
  const wanted = new Set(ids);
  const created: RevealedLink[] = [];
  const skipped: { tableId: string; tableName: string }[] = [];
  for (const tableId of order.filter((t) => wanted.has(t))) {
    const prior = existing.get(tableId);
    if (prior && !p.replaceExisting) {
      skipped.push({
        tableId,
        tableName: tables.find((t) => t.id === tableId)!.name as string,
      });
      continue;
    }
    if (prior) {
      created.push(
        await rotateRow(tx, s, prior as Parameters<typeof rotateRow>[2]),
      );
      continue;
    }
    const link = await insertLink(tx, s, { kind: "table", tableId, label: "" });
    await audit(tx, s, "public.link_created", link.id, {
      kind: link.kind,
      tableId,
      ref: link.ref,
    });
    created.push(link);
  }
  return { created, skipped };
}

/**
 * "Reemplazar": the old token stops working at once; pending holds of the old
 * link stay valid and their status pages keep working (status lookups accept
 * revoked links).
 */
export async function rotateLink(
  tx: Tx,
  s: Session,
  linkId: string,
): Promise<RevealedLink> {
  permit(s, managers);
  requireRecentAuth(s);
  await requirePro(tx);
  await lockLinks(tx);
  const [peek] = await tx`select table_id from public_links where id=${linkId}`;
  if (peek?.table_id) {
    const [t] =
      await tx`select id from dining_tables where id=${peek.table_id} and archived_at is null for share`;
    if (!t) throw new DomainError("invalid_table", 400);
  }
  const [old] =
    await tx`select id,kind,table_id,label,token_hash from public_links where id=${linkId} and revoked_at is null for update`;
  if (!old) throw new DomainError("not_found", 404);
  return rotateRow(tx, s, old as Parameters<typeof rotateRow>[2]);
}

/**
 * "Desactivar": no step-up and no plan check, so the abuse response is
 * instant and always possible. Idempotent through once().
 */
export async function revokeLink(
  tx: Tx,
  s: Session,
  linkId: string,
  raw: unknown,
): Promise<PublicLinkView> {
  permit(s, managers);
  const p = linkRevokeInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "public.link.revoke",
    { linkId, ...p },
    async () => {
      await lockLinks(tx);
      const [row] =
        await tx`select id from public_links where id=${linkId} for update`;
      if (!row) throw new DomainError("not_found", 404);
      await revokeLinkRow(tx, s, linkId, "revoked");
      return linkView(tx, linkId);
    },
  );
}

type SettingsRow = {
  paused: boolean;
  table_policy: HoldPolicy;
  counter_policy: HoldPolicy;
  hold_minutes: number;
  max_order_total: number;
  version: number;
  staff_online: boolean;
};

/** Operators: the policies, the pause switch and whether ordering is open now (≤ 3 statements). */
export async function orderingSettings(
  tx: Tx,
  s: Session,
): Promise<PublicSettingsView> {
  permit(s, operators);
  const [r] = await tx<SettingsRow[]>`select
      coalesce(p.paused,false) as paused,
      coalesce(p.table_policy,${ORDERING_DEFAULTS.tablePolicy}) as table_policy,
      coalesce(p.counter_policy,${ORDERING_DEFAULTS.counterPolicy}) as counter_policy,
      coalesce(p.hold_minutes,${ORDERING_DEFAULTS.holdMinutes}) as hold_minutes,
      coalesce(p.max_order_total,${ORDERING_DEFAULTS.maxOrderTotal}) as max_order_total,
      coalesce(p.version,0) as version,
      ${staffOnlineSql(tx)} as staff_online
    from (select 1) one left join public_ordering_settings p on true`;
  const pro = (await entitlement(tx)).plan === "pro";
  const reason = !pro
    ? "plan"
    : r.paused
      ? "paused"
      : !r.staff_online
        ? "no_staff"
        : null;
  return {
    available: true,
    pro,
    canEdit: managers.includes(s.role),
    canPause: operators.includes(s.role),
    paused: r.paused,
    acceptingNow: reason === null,
    reason,
    tablePolicy: r.table_policy,
    counterPolicy: r.counter_policy,
    holdMinutes: r.hold_minutes,
    maxOrderTotal: r.max_order_total,
    version: r.version,
    limits: { ...PUBLIC_LIMITS.activeLinks },
  };
}

/** Managers with a recent PIN on shared terminals: policies, hold time and maximum. */
export async function saveOrderingSettings(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<PublicSettingsView> {
  permit(s, managers);
  requireRecentAuth(s);
  const p = settingsInput.parse(raw);
  return once(tx, s, p.operationId, "public.settings", p, async () => {
    await requirePro(tx);
    const [row] =
      await tx`select table_policy,counter_policy,hold_minutes,max_order_total,version
        from public_ordering_settings for update`;
    if ((row?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("settings_changed", 409);
    // The WHERE closes the race of two first saves (no row to lock yet).
    const [saved] =
      await tx`insert into public_ordering_settings(tenant_id,table_policy,counter_policy,
        hold_minutes,max_order_total,version,updated_at,updated_by)
      values(${s.tenantId},${p.tablePolicy},${p.counterPolicy},${p.holdMinutes},${p.maxOrderTotal},1,now(),${s.employeeId})
      on conflict (tenant_id) do update set table_policy=excluded.table_policy,
        counter_policy=excluded.counter_policy,hold_minutes=excluded.hold_minutes,
        max_order_total=excluded.max_order_total,version=public_ordering_settings.version+1,
        updated_at=now(),updated_by=excluded.updated_by
      where public_ordering_settings.version=${p.expectedVersion}
      returning version`;
    if (!saved) throw new DomainError("settings_changed", 409);
    const before = {
      tablePolicy: row?.table_policy ?? ORDERING_DEFAULTS.tablePolicy,
      counterPolicy: row?.counter_policy ?? ORDERING_DEFAULTS.counterPolicy,
      holdMinutes: row?.hold_minutes ?? ORDERING_DEFAULTS.holdMinutes,
      maxOrderTotal: row?.max_order_total ?? ORDERING_DEFAULTS.maxOrderTotal,
    };
    const after = {
      tablePolicy: p.tablePolicy,
      counterPolicy: p.counterPolicy,
      holdMinutes: p.holdMinutes,
      maxOrderTotal: p.maxOrderTotal,
    };
    await audit(tx, s, "public.settings_saved", s.tenantId, {
      changed: Object.fromEntries(
        (Object.keys(after) as (keyof typeof after)[])
          .filter((k) => before[k] !== after[k])
          .map((k) => [k, { from: before[k], to: after[k] }]),
      ),
      version: saved.version,
    });
    return orderingSettings(tx, s);
  });
}

/** Any operator, no PIN: pause or resume online ordering. */
export async function setPaused(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<PublicSettingsView> {
  permit(s, operators);
  const p = pauseInput.parse(raw);
  return once(tx, s, p.operationId, "public.pause", p, async () => {
    await tx`select 1 from public_ordering_settings for update`;
    await tx`insert into public_ordering_settings(tenant_id,paused,updated_at,updated_by)
      values(${s.tenantId},${p.paused},now(),${s.employeeId})
      on conflict (tenant_id) do update set paused=excluded.paused,
        version=public_ordering_settings.version+1,updated_at=now(),updated_by=excluded.updated_by`;
    if (p.paused) await audit(tx, s, "public.paused", s.tenantId, {});
    else await audit(tx, s, "public.resumed", s.tenantId, {});
    return orderingSettings(tx, s);
  });
}
