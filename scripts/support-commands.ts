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
  "rectify-account",
  "block-account",
  "anonymize-account",
  "redact-email",
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
  "rectify-account",
  "block-account",
  "anonymize-account",
  "redact-email",
]);
/** Pilot grants (D21): at most 90 days ahead; the database allows 92 for the 04:00 local end. */
export const MAX_GRANT_DAYS = 90;
export const MIN_HOLD_HOURS = 24;
export const DEFAULT_HOLD_HOURS = 72;
/**
 * ARCO cancellation (LFPDPPP Art. 2-III, 24): an owner account stays blocked
 * this long before anonymize-account may run, the longest retention its
 * records carry: the subscription's fiscal records (CFF Art. 30, five years)
 * and the contract evidence of its legal acceptances (Código de Comercio
 * Art. 49, ten years, kept by account id after anonymization).
 */
export const BLOCK_YEARS_BEFORE_ANONYMIZATION = 5;

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
  | {
      command: "rectify-account";
      account: string;
      name: string | null;
      email: string | null;
    }
  | { command: "block-account"; account: string; offboarding: boolean }
  | { command: "anonymize-account"; account: string }
  | { command: "redact-email"; email: string }
  | { command: "actions"; organization: string; limit: number };
export type Operator = { label: string; ticket: string; reason: string };

function text(flags: SupportFlags, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || !v.trim())
    throw new SupportError(`support_flag_required_${name.replace(/-/g, "_")}`);
  return v.trim();
}
function emailFlag(flags: SupportFlags, name: string) {
  const v = text(flags, name).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || v.length > 254)
    throw new SupportError("support_argument_invalid");
  return v;
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
      const toEmail = emailFlag(flags, "to-email");
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
    case "rectify-account": {
      const name = flags.name === undefined ? null : text(flags, "name");
      const newEmail =
        flags.email === undefined ? null : emailFlag(flags, "email");
      if (name === null && newEmail === null)
        throw new SupportError("support_rectify_nothing");
      if (name !== null && (name.length < 1 || name.length > 200))
        throw new SupportError("support_argument_invalid");
      request = {
        command: "rectify-account",
        account: uuid(flags, "account"),
        name,
        email: newEmail,
      };
      break;
    }
    case "block-account":
      request = {
        command: "block-account",
        account: uuid(flags, "account"),
        offboarding: flags.offboarding === true,
      };
      break;
    case "anonymize-account":
      if (flags.yes !== undefined)
        throw new SupportError("support_yes_not_allowed");
      request = {
        command: "anonymize-account",
        account: uuid(flags, "account"),
      };
      break;
    case "redact-email":
      request = { command: "redact-email", email: emailFlag(flags, "email") };
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
/** An https origin (loopback allowed only over https, as the acceptance run serves). */
export function supportLinkOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (u.hostname === "localhost") return null;
    return u.origin;
  } catch {
    return null;
  }
}
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
          await tx`select id,name,role,failed_attempts,locked_until from employees where login=${r.login}`;
        if (!e) throw new SupportError("support_employee_not_found");
        return { t, e };
      });
      await confirmName(
        io,
        yes,
        [
          `Desbloquear a ${before.e.name} (${r.login}, rol ${before.e.role}) en ${before.t.name}.`,
          ...(lockText(before.e.locked_until) === "infinity"
            ? [
                "Bloqueo permanente (solo la persona titular lo quita): confirma que lo pide la persona titular o un copropietario de la consulta (lookup).",
              ]
            : []),
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
        // Logged first: the database accepts the writes below only with this
        // transaction's action row for this employee (AUTHZ-2, OPS-2).
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
        // Mirrors access's clearLocks(): the global counter and lock (the
        // 'infinity' hard lock included) and every device throttle.
        await tx`update employees set failed_attempts=0,locked_until=null where id=${e.id}`;
        await tx`update pin_throttles set failures=0,lock_level=0,locked_until=null,last_failure_at=null
          where employee_id=${e.id}`;
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
        const [end] =
          await tx`select (${r.until}::date + time '04:00') at time zone ${t.timezone} as access_until`;
        const id = await logAction(tx, operator, "grant_entitlement", {
          organizationId: t.organization_id,
          tenantId: t.id,
          target: { until: r.until },
          before: before ?? null,
          after: {
            status: "active",
            access_until: end.access_until,
            source: "support",
          },
        });
        const [after] =
          await tx`insert into restaurant_entitlements(tenant_id,status,access_until,source)
          values(${r.tenant},'active',${end.access_until},'support')
          on conflict(tenant_id) do update set status='active',access_until=excluded.access_until,
            source='support',version=restaurant_entitlements.version+1,updated_at=now()
          returning status,access_until,source`;
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
          await tx`select status,access_until,source,least(access_until,now()) as ends
            from restaurant_entitlements where tenant_id=${r.tenant} and source in ('support','fixture')`;
        if (!before) throw new SupportError("support_grant_not_found");
        const id = await logAction(tx, operator, "end_entitlement", {
          organizationId: t.organization_id,
          tenantId: t.id,
          target: {},
          before: {
            status: before.status,
            access_until: before.access_until,
            source: before.source,
          },
          after: {
            status: "free",
            accessUntil: (before.ends as Date | null)?.toISOString() ?? null,
            source: "support",
          },
        });
        // access_until keeps when Pro ended (now, or the grant's own earlier
        // end): drawers opened before it finish their shift and no drawer
        // opened on Free gains drawer continuation (GAP-1, ACC-14).
        const rows =
          await tx`update restaurant_entitlements set status='free',access_until=least(access_until,now()),
            source='support',version=version+1,updated_at=now()
          where tenant_id=${r.tenant} and source in ('support','fixture') returning status,access_until`;
        if (!rows.length) throw new SupportError("support_grant_not_found");
        return { supportActionId: id };
      });
    }
    case "transfer-ownership": {
      // The link is printed once: never on a missing, plain-http or local
      // origin a support workstation's .env might carry (OPS-5).
      if (!supportLinkOrigin(io.appUrl))
        throw new SupportError("support_app_url_required");
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
        // Logged first (AUTHZ-2): the insert and the expired-row cleanup need
        // this transaction's action row. The target email is stored as a
        // digest (DATA-3): support_actions is append-only.
        const actionId = await logAction(tx, operator, "transfer_ownership", {
          organizationId: o.id,
          target: { toEmailSha256: hash(r.toEmail), holdHours: r.holdHours },
        });
        await tx`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='support'
          where organization_id=${r.organization} and state='pending' and expires_at<=now()`;
        const [pending] =
          await tx`select 1 from ownership_transfers where organization_id=${r.organization} and state='pending'`;
        if (pending) throw new SupportError("support_transfer_pending");
        const transferId = randomUUID();
        const token = transferId + "." + randomBytes(32).toString("hex");
        await tx`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,initiated_by,
            support_action_id,previous_owner_stays,available_at,expires_at)
          values(${transferId},${o.id},${o.created_by_account},${r.toEmail},${hash(token)},'support',${actionId},false,
            now()+make_interval(hours=>${r.holdHours}),now()+make_interval(hours=>${r.holdHours})+interval '7 days')`;
        const link = `${supportLinkOrigin(io.appUrl)}/app?account=1#transfer=${token}`;
        io.print(
          "Enlace (envíalo solo al correo verificado; no se volverá a mostrar):",
        );
        io.print(link);
        return { transferId, supportActionId: actionId, link };
      });
    }
    case "cancel-transfer":
      return transaction(sql, async (tx) => {
        const [t] =
          await tx`select organization_id from ownership_transfers where id=${r.transfer} and state='pending'`;
        if (!t) throw new SupportError("support_transfer_not_found");
        const id = await logAction(tx, operator, "cancel_transfer", {
          organizationId: t.organization_id,
          target: { transferId: r.transfer },
        });
        const rows =
          await tx`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='support'
          where id=${r.transfer} and state='pending' returning organization_id`;
        if (!rows.length) throw new SupportError("support_transfer_not_found");
        return { supportActionId: id };
      });
    case "rectify-account":
      return rectifyAccount(sql, r, operator, yes, io);
    case "block-account":
      return blockAccount(sql, r, operator, yes, io);
    case "anonymize-account":
      return anonymizeAccount(sql, r, operator, io);
    case "redact-email":
      return redactEmail(sql, r, operator, yes, io);
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
        const id = await logAction(tx, operator, "set_free_device", {
          organizationId: t.organization_id,
          tenantId: t.id,
          target: { deviceId: r.device },
          before: { deviceId: before?.id ?? null },
          after: { deviceId: r.device },
        });
        await tx`update devices set free_slot=null where free_slot is not null`;
        const moved =
          await tx`update devices set free_slot=1 where id=${r.device} and active returning id`;
        if (!moved.length) throw new SupportError("support_device_not_found");
        return { supportActionId: id };
      });
    }
  }
}

type AccountRow = {
  id: string;
  email: string;
  name: string;
  active: boolean;
  created_at: Date;
};
async function accountRow(tx: Tx, id: string): Promise<AccountRow> {
  const [a] =
    await tx`select id,email,name,active,created_at from owner_accounts where id=${id}`;
  if (!a) throw new SupportError("support_account_not_found");
  return a as AccountRow;
}
/** Organizations where the account is primary or an active co-owner. */
async function accountOrganizations(tx: Tx, accountId: string) {
  const primary =
    await tx`select id,name from organizations where created_by_account=${accountId} order by name`;
  const coOwner = await tx`select o.id,o.name from organization_co_owners c
      join organizations o on o.id=c.organization_id
    where c.account_id=${accountId} and c.removed_at is null order by o.name`;
  return {
    primary: primary as unknown as Array<{ id: string; name: string }>,
    coOwner: coOwner as unknown as Array<{ id: string; name: string }>,
  };
}
/** The digests the owner_accounts policy compares (support_actions keeps no plaintext). */
const accountState = (a: { email: string; name: string; active: boolean }) => ({
  emailSha256: hash(a.email),
  nameSha256: hash(a.name),
  active: a.active,
});
/**
 * One action row per organization involved, so each organization's owners see
 * it in «Acciones de soporte»; a single organization-less row when none is.
 */
async function logForOrganizations(
  tx: Tx,
  operator: Operator,
  action: string,
  organizations: string[],
  o: { target: Record<string, unknown>; before?: unknown; after?: unknown },
): Promise<string[]> {
  const ids: string[] = [];
  for (const organizationId of organizations.length
    ? [...new Set(organizations)]
    : [null])
    ids.push(await logAction(tx, operator, action, { ...o, organizationId }));
  return ids;
}
export const ANONYMIZED_NAME = "Cuenta anonimizada";
const redacted = (email: string) => "redacted:" + hash(email);

async function rectifyAccount(
  sql: postgres.Sql,
  r: Extract<SupportRequest, { command: "rectify-account" }>,
  operator: Operator,
  yes: boolean,
  io: SupportIO,
) {
  const a0 = await transaction(sql, (tx) => accountRow(tx, r.account));
  if (a0.email.startsWith("redacted:"))
    throw new SupportError("support_account_anonymized");
  await confirmName(
    io,
    yes,
    [
      `Rectificar la cuenta ${a0.id} (ARCO, artículo 23):`,
      `  nombre: ${a0.name} → ${r.name ?? a0.name}`,
      `  correo: ${a0.email} → ${r.email ?? a0.email}`,
      "El inicio de sesión con Google no cambia (se identifica por la cuenta de Google, no por el correo).",
    ],
    a0.email,
  );
  return transaction(sql, async (tx) => {
    const a = await accountRow(tx, r.account);
    const after = {
      email: r.email ?? a.email,
      name: r.name ?? a.name,
      active: a.active,
    };
    const orgs = await accountOrganizations(tx, a.id);
    const ids = await logForOrganizations(
      tx,
      operator,
      "rectify_account",
      [...orgs.primary, ...orgs.coOwner].map((o) => o.id),
      {
        target: { accountId: a.id },
        before: accountState(a),
        after: accountState(after),
      },
    );
    await tx`update owner_accounts set email=${after.email},name=${after.name} where id=${a.id}`;
    io.print(
      `Listo: cuenta rectificada (${ids.length} registro(s) de soporte).`,
    );
    return { supportActionIds: ids };
  });
}

async function blockAccount(
  sql: postgres.Sql,
  r: Extract<SupportRequest, { command: "block-account" }>,
  operator: Operator,
  yes: boolean,
  io: SupportIO,
) {
  const check = async (tx: Tx) => {
    const a = await accountRow(tx, r.account);
    if (!a.active) throw new SupportError("support_account_already_blocked");
    const orgs = await accountOrganizations(tx, a.id);
    // Seats end through the co-owner lifecycle first (the primary removes
    // them, or they leave): blocking never strands an owner seat.
    if (orgs.coOwner.length)
      throw new SupportError("support_account_is_co_owner");
    // A primary is blocked only when the organization itself leaves
    // (offboarding); otherwise the business transfers ownership first.
    if (orgs.primary.length && !r.offboarding)
      throw new SupportError("support_account_is_primary");
    return { a, orgs };
  };
  const { a: a0, orgs: o0 } = await transaction(sql, check);
  await confirmName(
    io,
    yes,
    [
      `Bloquear la cuenta ${a0.id} <${a0.email}> (cancelación ARCO, bloqueo):`,
      "  deja de poder entrar con Google y sus sesiones de cuenta y del punto de venta terminan;",
      "  sus datos se conservan bloqueados durante el plazo legal y después se anonimizan (anonymize-account).",
      ...o0.primary.map(
        (o) =>
          `  Titular de ${o.name}: baja de la organización (--offboarding).`,
      ),
    ],
    a0.email,
  );
  return transaction(sql, async (tx) => {
    const { a, orgs } = await check(tx);
    const ids = await logForOrganizations(
      tx,
      operator,
      "block_account",
      orgs.primary.map((o) => o.id),
      {
        target: { accountId: a.id, offboarding: r.offboarding },
        before: accountState(a),
        after: accountState({ ...a, active: false }),
      },
    );
    await tx`update owner_accounts set active=false where id=${a.id}`;
    io.print(
      `Listo: cuenta bloqueada. Anonimízala con anonymize-account a partir del ${new Date(Date.now() + BLOCK_YEARS_BEFORE_ANONYMIZATION * 365.25 * 864e5).toISOString().slice(0, 10)}.`,
    );
    return { supportActionIds: ids };
  });
}

/**
 * Closes expired pending transfers addressed to the emails (cancel branch),
 * then replaces each closed transfer's target email by its digest (the one
 * change ownership_transfer_guard allows). Pending live transfers stay.
 */
async function redactTransfers(
  tx: Tx,
  emails: string[],
  accountId: string | null,
) {
  await tx`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='support'
    where state='pending' and expires_at<=now()
      and (to_email = any(${emails}::text[]) or to_account_id=${accountId})`;
  const rows =
    await tx`update ownership_transfers set to_email='redacted:' || encode(sha256(convert_to(to_email,'UTF8')),'hex')
    where state<>'pending' and to_email not like 'redacted:%'
      and (to_email = any(${emails}::text[]) or to_account_id=${accountId})
    returning id`;
  return rows.length;
}
async function transferOrganizations(
  tx: Tx,
  emails: string[],
  accountId: string | null,
) {
  const rows =
    await tx`select distinct organization_id,to_email,state,expires_at>now() as live from ownership_transfers
    where to_email not like 'redacted:%'
      and (to_email = any(${emails}::text[]) or to_account_id=${accountId})`;
  return rows as unknown as Array<{
    organization_id: string;
    to_email: string;
    state: string;
    live: boolean;
  }>;
}

async function anonymizeAccount(
  sql: postgres.Sql,
  r: Extract<SupportRequest, { command: "anonymize-account" }>,
  operator: Operator,
  io: SupportIO,
) {
  const check = async (tx: Tx) => {
    const a = await accountRow(tx, r.account);
    if (a.email.startsWith("redacted:"))
      throw new SupportError("support_account_anonymized");
    if (a.active) throw new SupportError("support_account_not_blocked");
    const [blocked] = await tx`select min(created_at) as at,
          min(created_at) <= now() - make_interval(years=>${BLOCK_YEARS_BEFORE_ANONYMIZATION}) as over
        from support_actions where action='block_account' and target->>'accountId'=${a.id}`;
    if (!blocked?.at) throw new SupportError("support_account_not_blocked");
    if (!blocked.over) throw new SupportError("support_retention_not_over");
    const transfers = await transferOrganizations(tx, [a.email], a.id);
    if (transfers.some((t) => t.state === "pending" && t.live))
      throw new SupportError("support_transfer_pending");
    return { a, transfers };
  };
  const { a: a0, transfers: t0 } = await transaction(sql, check);
  await confirmName(
    io,
    false,
    [
      `Anonimizar la cuenta ${a0.id} <${a0.email}> (cancelación ARCO, supresión):`,
      `  correo y nombre → valores no identificables; ${t0.length} transferencia(s) con su correo → huella sha256.`,
      "  Se conservan, ligados solo al identificador de la cuenta: aceptaciones legales (evidencia del contrato), eventos de cuenta y registros fiscales.",
    ],
    a0.email,
  );
  return transaction(sql, async (tx) => {
    const { a, transfers } = await check(tx);
    const emails = [...new Set([a.email, ...transfers.map((t) => t.to_email)])];
    const after = {
      email: redacted(a.email),
      name: ANONYMIZED_NAME,
      active: false,
    };
    const ids = await logForOrganizations(
      tx,
      operator,
      "anonymize_account",
      transfers.map((t) => t.organization_id),
      {
        target: { accountId: a.id, emailSha256s: emails.map(hash) },
        before: accountState(a),
        after: accountState(after),
      },
    );
    await tx`update owner_accounts set email=${after.email},name=${after.name} where id=${a.id}`;
    const count = await redactTransfers(tx, emails, a.id);
    io.print(
      `Listo: cuenta anonimizada; ${count} transferencia(s) anonimizada(s).`,
    );
    return { supportActionIds: ids, transfersRedacted: count };
  });
}

/** ARCO cancellation for someone who never had an account (a transfer target, for example). */
async function redactEmail(
  sql: postgres.Sql,
  r: Extract<SupportRequest, { command: "redact-email" }>,
  operator: Operator,
  yes: boolean,
  io: SupportIO,
) {
  const check = async (tx: Tx) => {
    const [account] =
      await tx`select id from owner_accounts where lower(email)=${r.email}`;
    if (account) throw new SupportError("support_email_has_account");
    const transfers = await transferOrganizations(tx, [r.email], null);
    if (transfers.some((t) => t.state === "pending" && t.live))
      throw new SupportError("support_transfer_pending");
    return transfers;
  };
  const t0 = await transaction(sql, check);
  await confirmName(
    io,
    yes,
    [
      `Anonimizar ${r.email} en ${t0.length} transferencia(s) cerrada(s) (cancelación ARCO).`,
    ],
    r.email,
  );
  return transaction(sql, async (tx) => {
    const transfers = await check(tx);
    const ids = await logForOrganizations(
      tx,
      operator,
      "redact_email",
      transfers.map((t) => t.organization_id),
      { target: { emailSha256s: [hash(r.email)] } },
    );
    const count = await redactTransfers(tx, [r.email], null);
    io.print(`Listo: ${count} transferencia(s) anonimizada(s).`);
    return { supportActionIds: ids, transfersRedacted: count };
  });
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
    // The primary's terms and privacy, and this organization's DPA (LEGAL-9).
    const legal =
      await tx`select distinct on (document) document,version,accepted_at from legal_acceptances
      where account_id=${o.created_by_account}
        and (organization_id is null or organization_id=${o.id})
      order by document,accepted_at desc`;
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
  // One row per organization shown, so each one's owners see that support read
  // it (UX-7, AUTHZ-5, LEGAL-9); an email is stored as its digest (DATA-3):
  // support_actions is append-only and may outlive the person's data.
  const target =
    r.by === "email" ? { emailSha256: hash(r.value) } : { [r.by]: r.value };
  if (r.by === "tenant" && organizations.length)
    await logAction(tx, operator, "lookup", { tenantId: r.value, target });
  else
    await logForOrganizations(
      tx,
      operator,
      "lookup",
      organizations.map((o) => o.id),
      { target },
    );
  return result;
}
