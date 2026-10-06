/**
 * Vendor support CLI commands (account 031, GAP-5). Never imported by server/:
 * the CLI runs on an operator workstation with SUPPORT_DATABASE_URL, a login
 * that is a member of the gm_support capability role (column-scoped grants and
 * RLS policies in migrations/031_account.sql), never a Railway variable.
 *
 * Every command runs in one transaction (lock_timeout 5 s, statement_timeout
 * 10 s) and writes one support_actions row the restaurant owners see in their
 * account console. Mutating commands print the change first and need the
 * restaurant or organization name typed back (transfer-ownership never
 * accepts --yes; set-free-device also needs the device id retyped).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Tx } from "../server/db.js";

export const SUPPORT_COMMANDS = [
  "lookup",
  "unlock-employee",
  "grant-entitlement",
  "end-entitlement",
  "transfer-ownership",
  "cancel-transfer",
  "set-free-device",
  "actions",
] as const;
export type SupportCommand = (typeof SUPPORT_COMMANDS)[number];
export const MUTATING: ReadonlySet<SupportCommand> = new Set([
  "unlock-employee",
  "grant-entitlement",
  "end-entitlement",
  "transfer-ownership",
  "cancel-transfer",
  "set-free-device",
]);
/** Pilot grants (D21): at most 90 days ahead; the database allows 92 for the 04:00 local end. */
export const MAX_GRANT_DAYS = 90;
export const MIN_HOLD_HOURS = 24;
export const DEFAULT_HOLD_HOURS = 72;

export class SupportError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "SupportError";
  }
}

export type SupportFlags = Record<string, string | true>;
/** --name value, --name=value and boolean --flag. */
export function parseSupportArgs(argv: readonly string[]): {
  command: string;
  flags: SupportFlags;
} {
  const [command = "", ...rest] = argv;
  const flags: SupportFlags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--"))
      throw new SupportError("support_argument_invalid");
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[name] = inline;
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--"))
      flags[name] = rest[++i];
    else flags[name] = true;
  }
  return { command, flags };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type SupportRequest =
  | {
      command: "lookup";
      by: "email" | "tenant" | "organization";
      value: string;
    }
  | { command: "unlock-employee"; tenant: string; login: string }
  | { command: "grant-entitlement"; tenant: string; until: string }
  | { command: "end-entitlement"; tenant: string }
  | {
      command: "transfer-ownership";
      organization: string;
      toEmail: string;
      holdHours: number;
    }
  | { command: "cancel-transfer"; transfer: string }
  | { command: "set-free-device"; tenant: string; device: string }
  | { command: "actions"; organization: string; limit: number };
export type Operator = { label: string; ticket: string; reason: string };

function text(flags: SupportFlags, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || !v.trim())
    throw new SupportError(`support_flag_required_${name.replace(/-/g, "_")}`);
  return v.trim();
}
function uuid(flags: SupportFlags, name: string) {
  const v = text(flags, name);
  if (!UUID.test(v)) throw new SupportError("support_argument_invalid");
  return v.toLowerCase();
}

/**
 * Validates a command line without touching the database. Every command
 * (lookup included) is ticketed: --operator, --ticket and --reason.
 */
export function validateSupportArgs(
  command: string,
  flags: SupportFlags,
  now: Date = new Date(),
): { request: SupportRequest; operator: Operator; yes: boolean } {
  if (!(SUPPORT_COMMANDS as readonly string[]).includes(command))
    throw new SupportError("support_command_unknown");
  const operator = {
    label: text(flags, "operator"),
    ticket: text(flags, "ticket"),
    reason: text(flags, "reason"),
  };
  if (operator.label.length < 2 || operator.label.length > 80)
    throw new SupportError("support_operator_invalid");
  if (operator.ticket.length < 3 || operator.ticket.length > 100)
    throw new SupportError("support_ticket_invalid");
  if (operator.reason.length < 10 || operator.reason.length > 500)
    throw new SupportError("support_reason_invalid");
  const yes = flags.yes === true;
  let request: SupportRequest;
  switch (command as SupportCommand) {
    case "lookup": {
      const options = (["email", "tenant", "organization"] as const).filter(
        (k) => flags[k] !== undefined,
      );
      if (options.length !== 1)
        throw new SupportError("support_lookup_one_key");
      const by = options[0];
      const value =
        by === "email" ? text(flags, "email").toLowerCase() : uuid(flags, by);
      request = { command: "lookup", by, value };
      break;
    }
    case "unlock-employee":
      request = {
        command: "unlock-employee",
        tenant: uuid(flags, "tenant"),
        login: text(flags, "login"),
      };
      break;
    case "grant-entitlement": {
      const until = text(flags, "until");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until)))
        throw new SupportError("support_argument_invalid");
      const days = (Date.parse(until + "T23:59:59Z") - now.getTime()) / 864e5;
      if (days <= 0) throw new SupportError("support_grant_in_past");
      if (days > MAX_GRANT_DAYS)
        throw new SupportError("support_grant_too_long");
      request = {
        command: "grant-entitlement",
        tenant: uuid(flags, "tenant"),
        until,
      };
      break;
    }
    case "end-entitlement":
      request = { command: "end-entitlement", tenant: uuid(flags, "tenant") };
      break;
    case "transfer-ownership": {
      if (flags.yes !== undefined)
        throw new SupportError("support_yes_not_allowed");
      const hold =
        flags["hold-hours"] === undefined
          ? DEFAULT_HOLD_HOURS
          : Number(text(flags, "hold-hours"));
      if (!Number.isInteger(hold) || hold < MIN_HOLD_HOURS || hold > 24 * 30)
        throw new SupportError("support_hold_too_short");
      const toEmail = text(flags, "to-email").toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail) || toEmail.length > 254)
        throw new SupportError("support_argument_invalid");
      request = {
        command: "transfer-ownership",
        organization: uuid(flags, "organization"),
        toEmail,
        holdHours: hold,
      };
      break;
    }
    case "cancel-transfer":
      request = {
        command: "cancel-transfer",
        transfer: uuid(flags, "transfer"),
      };
      break;
    case "set-free-device":
      request = {
        command: "set-free-device",
        tenant: uuid(flags, "tenant"),
        device: uuid(flags, "device"),
      };
      break;
    case "actions": {
      const limit =
        flags.limit === undefined ? 50 : Number(text(flags, "limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new SupportError("support_argument_invalid");
      request = {
        command: "actions",
        organization: uuid(flags, "organization"),
        limit,
      };
      break;
    }
  }
  return { request, operator, yes };
}

/**
 * Refuses any login that is not a plain gm_support member: no superuser,
 * BYPASSRLS, CREATEROLE or CREATEDB, no billing or jobs capability, no owned
 * tables, and never the runtime, migration, billing or worker login.
 */
export async function checkSupportRole(
  sql: postgres.Sql,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const [r] =
    await sql`select current_user as login, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
      pg_has_role(current_user,'gm_support','member') as support,
      coalesce(to_regrole('gm_billing_worker') is not null and pg_has_role(current_user,'gm_billing_worker','member'),false) as billing,
      coalesce(to_regrole('gm_jobs_worker') is not null and pg_has_role(current_user,'gm_jobs_worker','member'),false) as jobs,
      (select count(*)::int from pg_tables where tableowner=current_user) as owned
    from pg_roles where rolname=current_user`;
  const others = [
    env.DATABASE_URL,
    env.MIGRATION_DATABASE_URL,
    env.BILLING_DATABASE_URL,
    env.WORKER_DATABASE_URL,
  ]
    .filter((u): u is string => Boolean(u))
    .map((u) => {
      try {
        return decodeURIComponent(new URL(u).username);
      } catch {
        return "";
      }
    });
  if (
    !r ||
    !r.support ||
    r.rolsuper ||
    r.rolbypassrls ||
    r.rolcreaterole ||
    r.rolcreatedb ||
    r.billing ||
    r.jobs ||
    r.owned > 0 ||
    others.includes(r.login)
  )
    throw new SupportError("support_role_rejected");
  return r.login as string;
}

export type SupportIO = {
  print(line: string): void;
  /** Resolves true only when the operator typed `expected` exactly. */
  confirm(prompt: string, expected: string): Promise<boolean>;
  appUrl?: string;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** An employees.locked_until value: null, an instant, or the 'infinity' hard lock. */
const lockText = (l: Date | null) =>
  l === null
    ? null
    : Number.isFinite(l.getTime())
      ? l.toISOString()
      : "infinity";

async function transaction<T>(
  sql: postgres.Sql,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    return fn(tx);
  })) as T;
}
async function logAction(
  tx: Tx,
  operator: Operator,
  action: string,
  o: {
    organizationId?: string | null;
    tenantId?: string | null;
    target: Record<string, unknown>;
    before?: unknown;
    after?: unknown;
  },
): Promise<string> {
  const id = randomUUID();
  await tx`insert into support_actions(id,operator_login,operator_label,ticket,reason,action,organization_id,tenant_id,target,before_state,after_state)
    values(${id},'',${operator.label},${operator.ticket},${operator.reason},${action},
      ${o.organizationId ?? null},${o.tenantId ?? null},${tx.json(o.target as never)},
      ${o.before === undefined ? null : tx.json(o.before as never)},
      ${o.after === undefined ? null : tx.json(o.after as never)})`;
  return id;
}
async function tenantRow(tx: Tx, tenantId: string) {
  const [r] =
    await tx`select id,organization_id,name,timezone from restaurants where id=${tenantId}`;
  if (!r) throw new SupportError("support_tenant_not_found");
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  return r as {
    id: string;
    organization_id: string;
    name: string;
    timezone: string;
  };
}
async function confirmName(
  io: SupportIO,
  yes: boolean,
  summary: string[],
  name: string,
) {
  for (const line of summary) io.print(line);
  if (yes) return;
  if (!(await io.confirm(`Escribe "${name}" para confirmar: `, name)))
    throw new SupportError("support_not_confirmed");
}

/** Runs one validated command. Read-only state for the confirmation, then one mutating transaction. */
export async function runSupportCommand(
  sql: postgres.Sql,
  v: { request: SupportRequest; operator: Operator; yes: boolean },
  io: SupportIO,
): Promise<unknown> {
  const { request: r, operator, yes } = v;
  switch (r.command) {
    case "lookup":
      return transaction(sql, (tx) => lookup(tx, r, operator, io));
    case "actions":
      return transaction(sql, async (tx) => {
        const rows =
          await tx`select created_at,operator_login,operator_label,ticket,action,tenant_id,target
          from support_actions where organization_id=${r.organization}
          order by created_at desc limit ${r.limit}`;
        await logAction(tx, operator, "lookup", {
          organizationId: r.organization,
          target: { actions: r.organization },
        });
        for (const a of rows)
          io.print(
            `${(a.created_at as Date).toISOString()}  ${a.action}  ${a.ticket}  ${a.operator_label} (${a.operator_login})`,
          );
        return rows;
      });
    case "unlock-employee": {
      const before = await transaction(sql, async (tx) => {
        const t = await tenantRow(tx, r.tenant);
        const [e] =
          await tx`select id,name,failed_attempts,locked_until from employees where login=${r.login}`;
        if (!e) throw new SupportError("support_employee_not_found");
        return { t, e };
      });
      await confirmName(
        io,
        yes,
        [
          `Desbloquear a ${before.e.name} (${r.login}) en ${before.t.name}.`,
          `Intentos fallidos ${before.e.failed_attempts} → 0; bloqueo ${lockText(before.e.locked_until) ?? "ninguno"} → ninguno; bloqueos por dispositivo → 0.`,
        ],
        before.t.name,
      );
      return transaction(sql, async (tx) => {
        const t = await tenantRow(tx, r.tenant);
        const [e] =
          await tx`select id,name,failed_attempts,locked_until from employees where login=${r.login}`;
        if (!e) throw new SupportError("support_employee_not_found");
        const [throttles] =
          await tx`select count(*)::int as count,coalesce(max(lock_level),0)::int as max_level
            from pin_throttles where employee_id=${e.id} and (failures>0 or lock_level>0 or locked_until is not null)`;
        // Mirrors access's clearLocks(): the global counter and lock (the
        // 'infinity' hard lock included) and every device throttle.
        await tx`update employees set failed_attempts=0,locked_until=null where id=${e.id}`;
        await tx`update pin_throttles set failures=0,lock_level=0,locked_until=null,last_failure_at=null
          where employee_id=${e.id}`;
        const actionId = await logAction(tx, operator, "unlock_employee", {
          organizationId: t.organization_id,
          tenantId: t.id,
          target: { login: r.login, employeeId: e.id },
          before: {
            failedAttempts: e.failed_attempts,
            lockedUntil: lockText(e.locked_until),
            lockedDevices: throttles.count,
            maxLockLevel: throttles.max_level,
          },
          after: { failedAttempts: 0, lockedUntil: null, lockedDevices: 0 },
        });
        // No support employee exists: the unlocked employee is the audit actor,
        // detail.support marks the real source; by:"support" keeps the
        // manager's daily unlock budget untouched (R-27).
        await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
          values(${t.id},${randomUUID()},${e.id},'access.employee_unlocked',${e.id},
            ${tx.json({ name: e.name, support: true, by: "support", supportActionId: actionId, ticket: operator.ticket })})`;
        io.print(`Listo: ${e.name} puede volver a entrar con su PIN.`);
        return { employeeId: e.id, supportActionId: actionId };
      });
    }
    case "grant-entitlement": {
      const t0 = await transaction(sql, async (tx) => {
        const t = await tenantRow(tx, r.tenant);
        const [bound] =
          await tx`select 1 from billing_locations where tenant_id=${r.tenant}`;
        if (bound) throw new SupportError("support_grant_stripe_bound");
        const [e] =
          await tx`select status,access_until,source from restaurant_entitlements where tenant_id=${r.tenant}`;
        return { t, e };
      });
      await confirmName(
        io,
        yes,
        [
          `Pro otorgado por soporte en ${t0.t.name} hasta el ${r.until} a las 04:00 (${t0.t.timezone}).`,
          `Antes: ${t0.e ? `${t0.e.status} (${t0.e.source}) hasta ${t0.e.access_until?.toISOString?.() ?? "—"}` : "sin registro (Free)"}.`,
        ],
        t0.t.name,
      );
      return transaction(sql, async (tx) => {
        const t = await tenantRow(tx, r.tenant);
        const [bound] =
          await tx`select 1 from billing_locations where tenant_id=${r.tenant}`;
        if (bound) throw new SupportError("support_grant_stripe_bound");
        const [before] =
          await tx`select status,access_until,source from restaurant_entitlements where tenant_id=${r.tenant}`;
        const [after] =
          await tx`insert into restaurant_entitlements(tenant_id,status,access_until,source)
          values(${r.tenant},'active',(${r.until}::date + time '04:00') at time zone ${t.timezone},'support')
          on conflict(tenant_id) do update set status='active',access_until=excluded.access_until,
            source='support',version=restaurant_entitlements.version+1,updated_at=now()
          returning status,access_until,source`;
        const id = await logAction(tx, operator, "grant_entitlement", {
          organizationId: t.organization_id,
          tenantId: t.id,
          target: { until: r.until },
          before: before ?? null,
          after,
        });
        io.print(
          `Listo: Pro hasta ${(after.access_until as Date).toISOString()} (renovable antes de esa fecha).`,
        );
        return { supportActionId: id, accessUntil: after.access_until };
      });
    }
    case "end-entitlement": {
      const t0 = await transaction(sql, (tx) => tenantRow(tx, r.tenant));
      await confirmName(
        io,
        yes,
        [
          `Terminar el Pro otorgado por soporte en ${t0.name}: pasa a Free ahora.`,
        ],
        t0.name,
      );
      return transaction(sql, async (tx) => {
        const t = await tenantRow(tx, r.tenant);
        const [before] =
          await tx`select status,access_until,source from restaurant_entitlements where tenant_id=${r.tenant}`;
        // access_until keeps when Pro ended (now, or the grant's own earlier
        // end): drawers opened before it finish their shift and no drawer
        // opened on Free gains drawer continuation (GAP-1, ACC-14).
        const rows =
          await tx`update restaurant_entitlements set status='free',access_until=least(access_until,now()),
            source='support',version=version+1,updated_at=now()
          where tenant_id=${r.tenant} and source in ('support','fixture') returning status,access_until`;
        if (!rows.length) throw new SupportError("support_grant_not_found");
        const id = await logAction(tx, operator, "end_entitlement", {
          organizationId: t.organization_id,
          tenantId: t.id,
          target: {},
          before,
          after: {
            status: "free",
            accessUntil: (rows[0].access_until as Date).toISOString(),
            source: "support",
          },
        });
        return { supportActionId: id };
      });
    }
    case "transfer-ownership": {
      const org0 = await transaction(sql, async (tx) => {
        const [o] =
          await tx`select id,name,created_by_account from organizations where id=${r.organization}`;
        if (!o?.created_by_account)
          throw new SupportError("support_organization_not_found");
        const [pending] =
          await tx`select 1 from ownership_transfers where organization_id=${r.organization} and state='pending' and expires_at>now()`;
        if (pending) throw new SupportError("support_transfer_pending");
        return o;
      });
      await confirmName(
        io,
        false,
        [
          `Transferencia de ${org0.name} hacia ${r.toEmail}.`,
          `Se podrá completar en ${r.holdHours} h; la persona titular verá un aviso y puede cancelarla.`,
        ],
        org0.name,
      );
      return transaction(sql, async (tx) => {
        const [o] =
          await tx`select id,name,created_by_account from organizations where id=${r.organization}`;
        await tx`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='support'
          where organization_id=${r.organization} and state='pending' and expires_at<=now()`;
        const [pending] =
          await tx`select 1 from ownership_transfers where organization_id=${r.organization} and state='pending'`;
        if (pending) throw new SupportError("support_transfer_pending");
        const actionId = await logAction(tx, operator, "transfer_ownership", {
          organizationId: o.id,
          target: { toEmail: r.toEmail, holdHours: r.holdHours },
        });
        const transferId = randomUUID();
        const token = transferId + "." + randomBytes(32).toString("hex");
        await tx`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,initiated_by,
            support_action_id,previous_owner_stays,available_at,expires_at)
          values(${transferId},${o.id},${o.created_by_account},${r.toEmail},${hash(token)},'support',${actionId},false,
            now()+make_interval(hours=>${r.holdHours}),now()+make_interval(hours=>${r.holdHours})+interval '7 days')`;
        const link = `${(io.appUrl ?? "").replace(/\/$/, "")}/app?account=1#transfer=${token}`;
        io.print(
          "Enlace (envíalo solo al correo verificado; no se volverá a mostrar):",
        );
        io.print(link);
        return { transferId, supportActionId: actionId, link };
      });
    }
    case "cancel-transfer":
      return transaction(sql, async (tx) => {
        const rows =
          await tx`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='support'
          where id=${r.transfer} and state='pending' returning organization_id`;
        if (!rows.length) throw new SupportError("support_transfer_not_found");
        const id = await logAction(tx, operator, "cancel_transfer", {
          organizationId: rows[0].organization_id,
          target: { transferId: r.transfer },
        });
        return { supportActionId: id };
      });
    case "set-free-device": {
      const t0 = await transaction(sql, async (tx) => {
        const t = await tenantRow(tx, r.tenant);
        const [d] =
          await tx`select id,name,active from devices where id=${r.device}`;
        if (!d?.active) throw new SupportError("support_device_not_found");
        const [slot] =
          await tx`select id,name from devices where free_slot is not null`;
        return { t, d, slot };
      });
      await confirmName(
        io,
        yes,
        [
          `Dispositivo Free de ${t0.t.name}: ${t0.slot?.name ?? "ninguno"} → ${t0.d.name}.`,
        ],
        t0.t.name,
      );
      if (
        !(await io.confirm(
          `Escribe el ID del dispositivo (${r.device}): `,
          r.device,
        ))
      )
        throw new SupportError("support_not_confirmed");
      return transaction(sql, async (tx) => {
        const t = await tenantRow(tx, r.tenant);
        // The Free-limits key (lockFreeLimits, LO-3 920).
        await tx`select pg_advisory_xact_lock(hashtextextended(${r.tenant},920))`;
        const [before] =
          await tx`select id from devices where free_slot is not null`;
        await tx`update devices set free_slot=null where free_slot is not null`;
        const moved =
          await tx`update devices set free_slot=1 where id=${r.device} and active returning id`;
        if (!moved.length) throw new SupportError("support_device_not_found");
        const id = await logAction(tx, operator, "set_free_device", {
          organizationId: t.organization_id,
          tenantId: t.id,
          target: { deviceId: r.device },
          before: { deviceId: before?.id ?? null },
          after: { deviceId: r.device },
        });
        return { supportActionId: id };
      });
    }
  }
}

async function lookup(
  tx: Tx,
  r: Extract<SupportRequest, { command: "lookup" }>,
  operator: Operator,
  io: SupportIO,
) {
  let organizations: Array<{
    id: string;
    name: string;
    created_by_account: string | null;
  }>;
  if (r.by === "email") {
    organizations =
      await tx`select distinct o.id,o.name,o.created_by_account from owner_accounts a
        left join organization_co_owners c on c.account_id=a.id and c.removed_at is null
        join organizations o on o.created_by_account=a.id or o.id=c.organization_id
      where lower(a.email)=${r.value} order by o.name`;
  } else if (r.by === "tenant") {
    organizations =
      await tx`select o.id,o.name,o.created_by_account from restaurants t
      join organizations o on o.id=t.organization_id where t.id=${r.value}`;
  } else
    organizations =
      await tx`select id,name,created_by_account from organizations where id=${r.value}`;
  const result = [];
  for (const o of organizations) {
    const [primary] = o.created_by_account
      ? await tx`select email,name from owner_accounts where id=${o.created_by_account}`
      : [];
    const coOwners =
      await tx`select a.email,c.added_at from organization_co_owners c
        join owner_accounts a on a.id=c.account_id
      where c.organization_id=${o.id} and c.removed_at is null order by c.added_at`;
    const [billing] =
      await tx`select subscription_id from organization_billing where organization_id=${o.id}`;
    const [transfer] =
      await tx`select id,initiated_by,to_email,available_at,expires_at from ownership_transfers
      where organization_id=${o.id} and state='pending' and expires_at>now()`;
    const legal =
      await tx`select distinct on (document) document,version,accepted_at from legal_acceptances
      where account_id=${o.created_by_account} order by document,accepted_at desc`;
    const locations =
      await tx`select id,name,activation_pending,free_location from restaurants
      where organization_id=${o.id} order by name`;
    const tenants: any[] = [];
    for (const l of locations) {
      await tx`select set_config('app.tenant_id',${l.id},true)`;
      const [e] =
        await tx`select status,access_until,source from restaurant_entitlements where tenant_id=${l.id}`;
      const [locked] = await tx`select count(*)::int as n from employees
        where locked_until>now()
           or id in (select employee_id from pin_throttles where locked_until>now())`;
      tenants.push({ ...l, entitlement: e ?? null, lockedEmployees: locked.n });
    }
    result.push({
      organization: o,
      primary,
      coOwners,
      billing,
      transfer,
      legal,
      tenants,
    });
    io.print(`Organización ${o.name} (${o.id})`);
    io.print(
      `  Titular: ${primary ? `${primary.name} <${primary.email}>` : "—"}`,
    );
    for (const c of coOwners) io.print(`  Copropietario: ${c.email}`);
    io.print(
      `  Stripe: ${billing?.subscription_id ? `sí (${billing.subscription_id})` : "no"}`,
    );
    if (transfer)
      io.print(
        `  Transferencia pendiente (${transfer.initiated_by}) a ${transfer.to_email}, desde ${(transfer.available_at as Date).toISOString()}`,
      );
    for (const d of legal)
      io.print(
        `  Aceptó ${d.document} ${d.version} el ${(d.accepted_at as Date).toISOString()}`,
      );
    for (const t of tenants)
      io.print(
        `  Sucursal ${t.name} (${t.id})${t.free_location ? " · Free" : ""}${t.activation_pending ? " · activación pendiente" : ""} · plan ${t.entitlement ? `${t.entitlement.status}/${t.entitlement.source} hasta ${t.entitlement.access_until?.toISOString?.() ?? "—"}` : "Free"} · empleados bloqueados ${t.lockedEmployees}`,
      );
  }
  if (!organizations.length) io.print("Sin resultados.");
  await logAction(tx, operator, "lookup", {
    organizationId: organizations.length === 1 ? organizations[0].id : null,
    tenantId: r.by === "tenant" ? r.value : null,
    target: { [r.by]: r.value },
  });
  return result;
}
