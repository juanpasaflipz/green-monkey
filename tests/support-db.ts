/**
 * Vendor support CLI database suite (account 031, GAP-5): runs the real CLI
 * commands as a temporary gm_support member login against the isolated test
 * target, and proves what that role can and cannot reach.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { checkRole, tenant } from "../server/db.js";
import { checkPin, deviceScope, hashSecret } from "../server/access.js";
import { unlockStaff } from "../server/access-staff.js";
import {
  createOwnerRestaurant,
  ownerCookie,
  signInGoogleOwner,
  withOwner,
} from "../server/owner-accounts.js";
import { legalConfig } from "../server/legal.js";
import {
  acceptTransfer,
  cancelTransfer,
} from "../server/ownership-transfer.js";
import { entitlement } from "../server/entitlements.js";
import {
  ANONYMIZED_NAME,
  checkSupportRole,
  parseSupportArgs,
  runSupportCommand,
  validateSupportArgs,
  type SupportIO,
} from "../scripts/support-commands.js";
import { LEGAL_DOCUMENTS } from "../shared/legal.js";
import type { Session } from "../shared/domain.js";

const { runtime, migration } = isolatedTarget(process.env);
const sql = postgres(runtime, { max: 4 }),
  admin = postgres(migration, { max: 1 });
const role = "gm_support_test_" + randomBytes(5).toString("hex");
const password = randomBytes(32).toString("hex");
const database = new URL(migration).pathname.slice(1);
const legal = legalConfig({ LEGAL_UNPUBLISHED_SIGNUP: "allow" });
const ticket = [
  "--operator",
  "Operadora Prueba",
  "--ticket",
  "SUP-1",
  "--reason",
  "Solicitud verificada por teléfono y correo",
];
const printed: string[] = [];
const io: SupportIO = {
  print: (line) => printed.push(line),
  confirm: async () => true,
  appUrl: "https://pos.example.mx",
};
const cli = (support: postgres.Sql, argv: string[]) => {
  const { command, flags } = parseSupportArgs([...argv, ...ticket]);
  return runSupportCommand(support, validateSupportArgs(command, flags), io);
};
let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
const denied = (p: Promise<unknown>) =>
  assert.rejects(p, /permission denied|row-level security/);
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

let support: postgres.Sql | undefined;
try {
  await admin.unsafe(
    `create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls`,
  );
  await admin.unsafe(`grant gm_support to "${role}"`);
  await admin.unsafe(`grant connect on database "${database}" to "${role}"`);
  const url = new URL(runtime);
  url.username = role;
  url.password = password;
  support = postgres(url.href, { max: 2 });

  // Fixture restaurant with an owner, a manager and a cashier.
  const ownerLogin = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: randomUUID(),
    email: `support-owner-${role}@example.com`,
    name: "Dueña Soporte",
  });
  const ownerAccount = ownerCookie(ownerLogin).accountId;
  const { tenantId } = await withOwner(sql, ownerLogin, undefined, (tx, a) =>
    createOwnerRestaurant(
      tx,
      a,
      {
        restaurantName: `Soporte ${role.slice(-6)}`,
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
        openingDays: [1, 2, 3, 4, 5, 6, 7],
      },
      legal,
    ),
  );
  const [r] =
    await admin`select organization_id,name from restaurants where id=${tenantId}`;
  const managerId = randomUUID(),
    cashierId = randomUUID(),
    cashierLogin = "caja-" + role.slice(-6);
  await admin`insert into employees(tenant_id,id,name,login,secret_hash,role,pin_set_at) values
    (${tenantId},${managerId},'Gerente Soporte',${"ger-" + role.slice(-6)},${await hashSecret("246810")},'manager',now()),
    (${tenantId},${cashierId},'Cajera Soporte',${cashierLogin},${await hashSecret("135790")},'cashier',now())`;
  const deviceId = randomUUID();
  await admin`insert into devices(tenant_id,id,name,token_hash,kind,paired_at,token_expires_at)
    values(${tenantId},${deviceId},'Caja soporte',${randomBytes(32).toString("hex")},'terminal',now(),now()+interval '30 days')`;

  await test("1 support: CLI connect refuses runtime, migration, billing and jobs-worker roles; the web's checkRole refuses a gm_support member", async () => {
    assert.equal(await checkSupportRole(support!, {}), role);
    await assert.rejects(checkSupportRole(sql, {}), /support_role_rejected/);
    await assert.rejects(checkSupportRole(admin, {}), /support_role_rejected/);
    // Same login as a configured runtime/migration/billing/worker URL.
    for (const name of [
      "DATABASE_URL",
      "MIGRATION_DATABASE_URL",
      "BILLING_DATABASE_URL",
      "WORKER_DATABASE_URL",
    ])
      await assert.rejects(
        checkSupportRole(support!, { [name]: url.href }),
        /support_role_rejected/,
      );
    // A support login that also holds a capability is refused.
    await admin.unsafe(`grant gm_jobs_worker to "${role}"`);
    await assert.rejects(
      checkSupportRole(support!, {}),
      /support_role_rejected/,
    );
    await admin.unsafe(`revoke gm_jobs_worker from "${role}"`);
    await admin.unsafe(`grant gm_billing_worker to "${role}"`);
    await assert.rejects(
      checkSupportRole(support!, {}),
      /support_role_rejected/,
    );
    await admin.unsafe(`revoke gm_billing_worker from "${role}"`);
    await assert.rejects(checkRole(support!), /must not bypass RLS/);
  });
  await test("2 support: lookup by email logs action and selects no secret columns (permission denied on secret_hash/token_hash)", async () => {
    printed.length = 0;
    await cli(support!, [
      "lookup",
      "--email",
      `support-owner-${role}@example.com`,
    ]);
    assert.ok(printed.some((l) => l.includes(r.name)));
    assert.ok(printed.some((l) => l.includes("Titular: Dueña Soporte")));
    const [logged] =
      await admin`select action,target,organization_id,operator_login,ticket from support_actions
          where organization_id=${r.organization_id} order by created_at desc limit 1`;
    assert.equal(logged.action, "lookup");
    assert.equal(logged.operator_login, role);
    assert.equal(logged.ticket, "SUP-1");
    // DATA-3: the append-only log keeps the searched email as a digest only.
    assert.deepEqual(logged.target, {
      emailSha256: sha256(`support-owner-${role}@example.com`),
    });
    await denied(support!`select secret_hash from employees limit 1`);
    await denied(support!`select token_hash from ownership_transfers limit 1`);
    await denied(
      support!`select secret_hash from account_recovery_codes limit 1`,
    );
    await denied(support!`select token_hash from devices limit 1`);
    await denied(support!`select identity_key from owner_accounts limit 1`);
  });
  await test("3 support: unlock-employee clears every lock (hard lock included) and device throttles, logs before/after and audit by:'support'; the employee signs in again and a manager keeps three unlocks that day", async () => {
    const scope = deviceScope(deviceId);
    await admin`update employees set failed_attempts=100,locked_until='infinity' where id=${cashierId}`;
    await admin`insert into pin_throttles(tenant_id,employee_id,scope,failures,lock_level,locked_until,last_failure_at)
        values(${tenantId},${cashierId},${scope},5,2,now()+interval '1 hour',now())`;
    await cli(support!, [
      "unlock-employee",
      "--tenant",
      tenantId,
      "--login",
      cashierLogin,
    ]);
    const [e] =
      await admin`select failed_attempts,locked_until from employees where id=${cashierId}`;
    assert.deepEqual({ ...e }, { failed_attempts: 0, locked_until: null });
    const [t] =
      await admin`select failures,lock_level,locked_until,last_failure_at from pin_throttles where employee_id=${cashierId}`;
    assert.deepEqual(
      { ...t },
      { failures: 0, lock_level: 0, locked_until: null, last_failure_at: null },
    );
    const [action] =
      await admin`select id,before_state,after_state from support_actions where tenant_id=${tenantId} and action='unlock_employee'`;
    assert.equal(action.before_state.lockedUntil, "infinity");
    assert.equal(action.before_state.failedAttempts, 100);
    assert.equal(action.after_state.failedAttempts, 0);
    const [audit] =
      await admin`select actor_id,detail from audit where tenant_id=${tenantId} and operation='access.employee_unlocked'`;
    assert.equal(audit.actor_id, cashierId);
    assert.equal(audit.detail.support, true);
    assert.equal(audit.detail.by, "support");
    assert.equal(audit.detail.supportActionId, action.id);
    const run = <T>(fn: Parameters<typeof tenant<T>>[2]) =>
      tenant(sql, tenantId, fn);
    assert.equal(
      (
        await run((tx) =>
          checkPin(tx, { employeeId: cashierId }, "135790", scope),
        )
      ).outcome,
      "ok",
    );
    // R-27: a support unlock does not use the manager's daily budget.
    const manager = {
      id: randomUUID(),
      tenantId,
      employeeId: managerId,
      deviceId,
      name: "Gerente",
      role: "manager",
      csrf: "",
      expiresAt: "",
      offlineUntil: "",
      restaurant: {
        name: r.name,
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
      },
    } as Session;
    for (let i = 0; i < 3; i++)
      await run((tx) =>
        unlockStaff(tx, manager, cashierId, { operationId: randomUUID() }),
      );
    await assert.rejects(
      run((tx) =>
        unlockStaff(tx, manager, cashierId, { operationId: randomUUID() }),
      ),
      /unlock_limit/,
    );
  });
  await test("3b support: gm_support cannot UPDATE pin_throttles.scope or employees.secret_hash, cannot touch another tenant's pin_throttles (tenant_scope), and cannot DELETE pin_throttles rows", async () => {
    await denied(
      support!.begin(async (tx) => {
        await tx`select set_config('app.tenant_id',${tenantId},true)`;
        await tx`update pin_throttles set scope='unpaired' where employee_id=${cashierId}`;
      }),
    );
    await denied(
      support!.begin(async (tx) => {
        await tx`select set_config('app.tenant_id',${tenantId},true)`;
        await tx`update employees set secret_hash='x' where id=${cashierId}`;
      }),
    );
    await denied(
      support!.begin(async (tx) => {
        await tx`select set_config('app.tenant_id',${tenantId},true)`;
        await tx`delete from pin_throttles where employee_id=${cashierId}`;
      }),
    );
    // Another tenant's throttles are invisible under tenant_scope.
    await admin`update pin_throttles set failures=3 where employee_id=${cashierId}`;
    const other = await support!.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${randomUUID()},true)`;
      return tx`update pin_throttles set failures=0 where employee_id=${cashierId} returning employee_id`;
    });
    assert.equal(other.length, 0);
    const [still] =
      await admin`select failures from pin_throttles where employee_id=${cashierId}`;
    assert.equal(still.failures, 3);
  });
  await test("3c support: a raw gm_support session cannot write what the CLI does not log in the same transaction: no hard lock, no unlogged unlock, no forged or backdated audit row, no manager-budget rows, no unlogged Free slot move, no stale action reuse (AUTHZ-2, OPS-2)", async () => {
    const asSupport = (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      support!.begin(async (tx) => {
        await tx`select set_config('app.tenant_id',${tenantId},true)`;
        return fn(tx);
      });
    const logged = (
      tx: postgres.TransactionSql,
      action: string,
      target: Record<string, unknown>,
    ) => {
      const id = randomUUID();
      return tx`insert into support_actions(id,operator_login,operator_label,ticket,reason,action,tenant_id,target)
          values(${id},'',${"Operadora Prueba"},${"SUP-3C"},${"Prueba de privilegio mínimo"},${action},${tenantId},${tx.json(target as never)})`.then(
        () => id,
      );
    };
    // A hard lock on every cashier, even with a logged unlock of that one.
    await denied(
      asSupport((tx) => tx`update employees set locked_until='infinity'`),
    );
    await denied(
      asSupport(async (tx) => {
        await logged(tx, "unlock_employee", { employeeId: cashierId });
        await tx`update employees set locked_until='infinity' where id=${cashierId}`;
      }),
    );
    await denied(
      asSupport(
        (tx) =>
          tx`update pin_throttles set failures=50,lock_level=9 where employee_id=${cashierId}`,
      ),
    );
    // An unlock without its action row, or with another employee's.
    await denied(
      asSupport(
        (tx) =>
          tx`update employees set failed_attempts=0,locked_until=null where id=${cashierId}`,
      ),
    );
    await denied(
      asSupport(async (tx) => {
        await logged(tx, "unlock_employee", { employeeId: managerId });
        await tx`update employees set failed_attempts=0,locked_until=null where id=${cashierId}`;
      }),
    );
    // A fabricated audit trail: another operation, a cashier as actor of a
    // manager-budget unlock, a backdated row.
    await denied(
      asSupport(
        (tx) =>
          tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
            values(${tenantId},${randomUUID()},${cashierId},'order.void',${randomUUID()},${tx.json({ amount: 50000 })})`,
      ),
    );
    await denied(
      asSupport(
        (tx) =>
          tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
            values(${tenantId},${randomUUID()},${cashierId},'access.employee_unlocked',${cashierId},${tx.json({ by: "manager" })})`,
      ),
    );
    await denied(
      asSupport(async (tx) => {
        const id = await logged(tx, "unlock_employee", {
          employeeId: cashierId,
        });
        await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail,created_at)
            values(${tenantId},${randomUUID()},${cashierId},'access.employee_unlocked',${cashierId},
              ${tx.json({ by: "support", supportActionId: id })},'2026-10-01 14:00')`;
      }),
    );
    // A Free slot moved without its action row, or to a device it does not name.
    await denied(
      asSupport(
        (tx) => tx`update devices set free_slot=1 where id=${deviceId}`,
      ),
    );
    await denied(
      asSupport(async (tx) => {
        await logged(tx, "set_free_device", { deviceId: randomUUID() });
        await tx`update devices set free_slot=1 where id=${deviceId}`;
      }),
    );
    // An action row from an earlier transaction authorizes nothing later.
    const stale = await asSupport((tx) =>
      logged(tx, "unlock_employee", { employeeId: cashierId }),
    );
    assert.ok(stale);
    await denied(
      asSupport(
        (tx) =>
          tx`update employees set failed_attempts=0,locked_until=null where id=${cashierId}`,
      ),
    );
    await denied(
      asSupport(
        (tx) =>
          tx`insert into restaurant_entitlements(tenant_id,status,access_until,source)
            values(${tenantId},'active',now()+interval '10 days','support')
            on conflict(tenant_id) do update set status='active',access_until=excluded.access_until,source='support'`,
      ),
    );
    // Every tenant-scoped action is shown to that tenant's owners.
    const [shown] =
      await admin`select organization_id from support_actions where id=${stale as string}`;
    assert.equal(shown.organization_id, r.organization_id);
    // The CLI path (log first, then write) still unlocks.
    await admin`update employees set failed_attempts=7 where id=${cashierId}`;
    await cli(support!, [
      "unlock-employee",
      "--tenant",
      tenantId,
      "--login",
      cashierLogin,
    ]);
    const [e] =
      await admin`select failed_attempts from employees where id=${cashierId}`;
    assert.equal(e.failed_attempts, 0);
  });
  await test("4 support: grant-entitlement gives Pro on an unbound tenant; refused for a Stripe-bound tenant and beyond 90 days, also through raw SQL (restrictive policy)", async () => {
    const until = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    await cli(support!, [
      "grant-entitlement",
      "--tenant",
      tenantId,
      "--until",
      until,
    ]);
    const plan = await tenant(sql, tenantId, (tx) => entitlement(tx));
    assert.equal(plan.plan, "pro");
    assert.equal(plan.source, "support");
    // Renewal moves access_until.
    const later = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    await cli(support!, [
      "grant-entitlement",
      "--tenant",
      tenantId,
      "--until",
      later,
    ]);
    const [row] =
      await admin`select access_until,version from restaurant_entitlements where tenant_id=${tenantId}`;
    assert.ok(row.access_until > new Date(Date.now() + 59 * 864e5));
    assert.equal(row.version, 2);
    await assert.rejects(
      support!.begin(async (tx) => {
        await tx`update restaurant_entitlements set access_until=now()+interval '120 days' where tenant_id=${tenantId}`;
      }),
      /row-level security/,
    );
    // A Stripe-bound tenant is refused by the CLI and by the policy.
    await admin`insert into organization_billing(organization_id,subscription_id) values(${r.organization_id},${"sub_" + role.slice(-8)}) on conflict do nothing`;
    await admin`insert into billing_locations(organization_id,tenant_id) values(${r.organization_id},${tenantId})`;
    await assert.rejects(
      cli(support!, [
        "grant-entitlement",
        "--tenant",
        tenantId,
        "--until",
        until,
      ]),
      /support_grant_stripe_bound/,
    );
    await assert.rejects(
      support!`update restaurant_entitlements set access_until=now()+interval '10 days',source='support' where tenant_id=${tenantId}`,
      /row-level security/,
    );
    await admin`delete from billing_locations where tenant_id=${tenantId}`;
    // The binding existed only for this refusal: a retained subscription would
    // make billing-db's reconcile scheduler pick this fixture on later runs.
    await admin`delete from organization_billing where organization_id=${r.organization_id}`;
    await cli(support!, ["end-entitlement", "--tenant", tenantId]);
    assert.equal(
      (await tenant(sql, tenantId, (tx) => entitlement(tx))).plan,
      "free",
    );
    // The row keeps when Pro ended (now, for a live grant), so drawers opened
    // before it finish their shift and none opened on Free continues (ACC-14).
    const [ended] =
      await admin`select status,source,access_until is not null and access_until<=now() as ended
        from restaurant_entitlements where tenant_id=${tenantId}`;
    assert.deepEqual(
      { status: ended.status, source: ended.source, ended: ended.ended },
      { status: "free", source: "support", ended: true },
    );
  });
  await test("5 support: transfer-ownership creates a ≥24 h-hold pending transfer; support cannot complete it (no UPDATE on organizations); the target completes after the hold; the primary can cancel during the hold", async () => {
    const targetEmail = `support-target-${role}@example.com`;
    printed.length = 0;
    const created = (await cli(support!, [
      "transfer-ownership",
      "--organization",
      r.organization_id,
      "--to-email",
      targetEmail,
      "--hold-hours",
      "24",
    ])) as { transferId: string; link: string };
    assert.ok(
      created.link.startsWith("https://pos.example.mx/app?account=1#transfer="),
    );
    const [t] =
      await admin`select initiated_by,previous_owner_stays,available_at,expires_at,support_action_id from ownership_transfers where id=${created.transferId}`;
    assert.equal(t.initiated_by, "support");
    assert.equal(t.previous_owner_stays, false);
    assert.ok(t.available_at.getTime() - Date.now() > 23.9 * 3600_000);
    assert.ok(t.support_action_id);
    await assert.rejects(
      support!`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,initiated_by,support_action_id,previous_owner_stays,available_at,expires_at)
          values(${randomUUID()},${r.organization_id},${ownerAccount},'x@y.mx',${"a".repeat(64)},'support',${t.support_action_id},false,now()+interval '1 hour',now()+interval '2 days')`,
      /row-level security|one_pending_transfer|duplicate key/,
    );
    await denied(
      support!`update organizations set created_by_account=${ownerAccount} where id=${r.organization_id}`,
    );
    const targetLogin = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject: randomUUID(),
      email: targetEmail,
      name: "Nueva Titular",
    });
    const token = created.link.split("#transfer=")[1];
    const accepted = {
      terms: LEGAL_DOCUMENTS.terms.version,
      privacy: LEGAL_DOCUMENTS.privacy.version,
      dpa: LEGAL_DOCUMENTS.dpa.version,
    };
    await assert.rejects(
      withOwner(sql, targetLogin, undefined, (tx, a) =>
        acceptTransfer(tx, a, { token, legalAccepted: accepted }, legal),
      ),
      /transfer_on_hold/,
    );
    // Completes after the hold (test-only: named trigger disabled in one transaction).
    await admin.begin(async (tx) => {
      await tx`alter table ownership_transfers disable trigger ownership_transfer_guard`;
      await tx`update ownership_transfers set available_at=now()-interval '1 minute' where id=${created.transferId}`;
      await tx`alter table ownership_transfers enable trigger ownership_transfer_guard`;
    });
    await withOwner(sql, targetLogin, undefined, (tx, a) =>
      acceptTransfer(tx, a, { token, legalAccepted: accepted }, legal),
    );
    const [org] =
      await admin`select created_by_account from organizations where id=${r.organization_id}`;
    assert.equal(org.created_by_account, ownerCookie(targetLogin).accountId);
    // A second support transfer, canceled by the (new) primary during the hold.
    const second = (await cli(support!, [
      "transfer-ownership",
      "--organization",
      r.organization_id,
      "--to-email",
      `another-${role}@example.com`,
    ])) as { transferId: string };
    await withOwner(sql, targetLogin, undefined, (tx, a) =>
      cancelTransfer(tx, a, { transferId: second.transferId }),
    );
    const [canceled] =
      await admin`select state,canceled_by from ownership_transfers where id=${second.transferId}`;
    assert.deepEqual(
      { ...canceled },
      { state: "canceled", canceled_by: "owner" },
    );
    await assert.rejects(
      cli(support!, ["cancel-transfer", "--transfer", second.transferId]),
      /support_transfer_not_found/,
    );
  });
  await test("6 support: set-free-device moves the slot under the Free-limits lock", async () => {
    await cli(support!, [
      "set-free-device",
      "--tenant",
      tenantId,
      "--device",
      deviceId,
    ]);
    const slots =
      await admin`select id from devices where tenant_id=${tenantId} and free_slot is not null`;
    assert.deepEqual(
      slots.map((s) => s.id),
      [deviceId],
    );
    await assert.rejects(
      cli(support!, [
        "set-free-device",
        "--tenant",
        tenantId,
        "--device",
        randomUUID(),
      ]),
      /support_device_not_found/,
    );
  });
  await test("7 support: support_actions is append-only and operator_login is forced to session_user", async () => {
    const id = randomUUID();
    await support!`insert into support_actions(id,operator_login,operator_label,ticket,reason,action,organization_id)
        values(${id},'someone_else','Operadora Prueba','SUP-2','Prueba de registro forzado','lookup',${r.organization_id})`;
    const [row] =
      await admin`select operator_login from support_actions where id=${id}`;
    assert.equal(row.operator_login, role);
    await denied(
      support!`update support_actions set ticket='x' where id=${id}`,
    );
    await denied(support!`delete from support_actions where id=${id}`);
    await assert.rejects(
      admin`update support_actions set ticket='x' where id=${id}`,
      /append-only/,
    );
  });
  await test("8 support: no SELECT on orders, tenders, sessions, owner_sessions; no DELETE anywhere", async () => {
    for (const table of [
      "orders",
      "tenders",
      "sessions",
      "owner_sessions",
      "order_lines",
      "cash_sessions",
    ])
      await denied(support!.unsafe(`select 1 from ${table} limit 1`));
    const [grants] =
      await admin`select count(*)::int as n from information_schema.role_table_grants
        where grantee='gm_support' and privilege_type in ('DELETE','TRUNCATE')`;
    assert.equal(grants.n, 0);
  });
  // ---- ARCO tooling (LEGAL-5, DATA-1, DATA-2) ------------------------------
  const ownerFixture = async (label: string) => {
    const email = `${label}-${role}@example.com`;
    const subject = randomUUID();
    const login = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject,
      email,
      name: `Cuenta ${label}`,
    });
    return { login, email, subject, id: ownerCookie(login).accountId };
  };
  const ownRestaurant = async (o: { login: string }, name: string) => {
    const { tenantId: t } = await withOwner(sql, o.login, undefined, (tx, a) =>
      createOwnerRestaurant(
        tx,
        a,
        {
          restaurantName: name,
          currency: "MXN",
          timezone: "America/Mexico_City",
          cutoff: 240,
          openingDays: [1, 2, 3, 4, 5, 6, 7],
        },
        legal,
      ),
    );
    const [row] =
      await admin`select organization_id from restaurants where id=${t}`;
    return { tenantId: t, organizationId: row.organization_id as string };
  };
  /** An active co-ownership, inserted as the fixture owner (the lifecycle itself is account-db's). */
  const coOwn = async (
    o: { id: string; email: string },
    org: { tenantId: string; organizationId: string },
    by: string,
  ) => {
    const invitation = randomUUID();
    await admin`insert into restaurant_invitations(id,tenant_id,created_by,email,role,token_hash,accepted_by,accepted_at,employee_id)
        values(${invitation},${org.tenantId},${by},${o.email},'co_owner',${sha256(invitation)},${o.id},now(),${randomUUID()})`;
    await admin`insert into organization_co_owners(id,organization_id,account_id,added_by,source,invitation_id)
        values(${randomUUID()},${org.organizationId},${o.id},${by},'invitation',${invitation})`;
  };
  const accountActions = async (accountId: string, action: string) =>
    admin`select organization_id,target,before_state,after_state from support_actions
      where action=${action} and target->>'accountId'=${accountId} order by organization_id`;
  const textOf = (rows: unknown) => JSON.stringify(rows);

  await test("9 support: lookup by an email that is primary of one organization and co-owner of another writes one row per organization, each visible to that organization's owners, and the DPA line is that organization's (UX-7, AUTHZ-5, LEGAL-9)", async () => {
    const both = await ownerFixture("both");
    const mine = await ownRestaurant(both, `Propia ${role.slice(-6)}`);
    const other = await ownerFixture("other-primary");
    const theirs = await ownRestaurant(other, `Ajena ${role.slice(-6)}`);
    await coOwn(both, theirs, other.id);
    printed.length = 0;
    await cli(support!, ["lookup", "--email", both.email]);
    const rows = await admin`select organization_id,target from support_actions
        where action='lookup' and target->>'emailSha256'=${sha256(both.email)}
        order by organization_id`;
    assert.deepEqual(
      rows.map((x) => x.organization_id).sort(),
      [mine.organizationId, theirs.organizationId].sort(),
    );
    assert.ok(!textOf(rows).includes(both.email));
    // A DPA the person accepted for another organization (as its primary
    // earlier) is not printed as this organization's.
    const [session] =
      await admin`select id from owner_sessions where account_id=${both.id} limit 1`;
    await admin`insert into legal_acceptances(id,account_id,owner_session_id,document,version,content_hash,entity_hash,published,locale,context,organization_id)
        values(${randomUUID()},${both.id},${session.id},'dpa',${LEGAL_DOCUMENTS.dpa.version},${"a".repeat(64)},${"b".repeat(64)},false,'es','transfer',${theirs.organizationId})`;
    printed.length = 0;
    await cli(support!, ["lookup", "--tenant", mine.tenantId]);
    assert.ok(printed.some((l) => l.includes(`Propia ${role.slice(-6)}`)));
    assert.ok(
      !printed.some((l) => l.includes("Aceptó dpa")),
      printed.join("\n"),
    );
    // Each organization's owners read their own row through the console policy.
    for (const org of [mine.organizationId, theirs.organizationId]) {
      const visible = await sql.begin(async (tx) => {
        await tx`select set_config('app.organization_id',${org},true)`;
        return tx`select 1 from support_actions where action='lookup' and organization_id=${org}`;
      });
      assert.ok(visible.length >= 1, org);
    }
  });

  await test("10 support: rectify-account changes the owner's name and email (lookup finds the new address, co-owners see it), logs only digests, and the database refuses an unlogged or different change (LEGAL-5)", async () => {
    const p = await ownerFixture("rectify");
    const org = await ownRestaurant(p, `Rectifica ${role.slice(-6)}`);
    const newEmail = `rectified-${role}@example.com`;
    await cli(support!, [
      "rectify-account",
      "--account",
      p.id,
      "--name",
      "María Rectificada",
      "--email",
      newEmail.toUpperCase(),
    ]);
    const [a] =
      await admin`select email,name,active from owner_accounts where id=${p.id}`;
    assert.deepEqual(
      { ...a },
      {
        email: newEmail,
        name: "María Rectificada",
        active: true,
      },
    );
    const [logged] = await accountActions(p.id, "rectify_account");
    assert.equal(logged.organization_id, org.organizationId);
    assert.equal(logged.after_state.emailSha256, sha256(newEmail));
    assert.ok(!textOf(logged).includes(newEmail));
    assert.ok(!textOf(logged).includes(p.email));
    printed.length = 0;
    await cli(support!, ["lookup", "--email", newEmail]);
    assert.ok(printed.some((l) => l.includes("María Rectificada")));
    // Google sign-in is by subject, so the person still enters.
    await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject: p.subject,
      email: newEmail,
    });
    // Raw writes: none without the same-transaction action, none that differ from it.
    await denied(
      support!`update owner_accounts set name='Otra' where id=${p.id}`,
    );
    await denied(
      support!.begin(async (tx) => {
        await tx`insert into support_actions(id,operator_login,operator_label,ticket,reason,action,target,after_state)
          values(${randomUUID()},'',${"Operadora Prueba"},${"SUP-10"},${"Prueba de rectificación"},'rectify_account',
            ${tx.json({ accountId: p.id })},${tx.json({ emailSha256: sha256(newEmail), nameSha256: sha256("Pepe"), active: true })})`;
        await tx`update owner_accounts set name='Otro nombre' where id=${p.id}`;
      }),
    );
    await denied(
      support!`update owner_accounts set active=false where id=${p.id}`,
    );
  });

  await test("11 support: block-account refuses a co-owner and a primary without --offboarding; blocking ends Google entry; anonymize-account waits for the retention period, then replaces email and name, redacts the account's closed transfers and keeps acceptances by id (DATA-1, DATA-2)", async () => {
    const primary = await ownerFixture("block-primary");
    const org = await ownRestaurant(primary, `Bloqueo ${role.slice(-6)}`);
    const co = await ownerFixture("block-co");
    await coOwn(co, org, primary.id);
    await assert.rejects(
      cli(support!, ["block-account", "--account", co.id]),
      /support_account_is_co_owner/,
    );
    await assert.rejects(
      cli(support!, ["block-account", "--account", primary.id]),
      /support_account_is_primary/,
    );
    // A closed transfer that named the person, and acceptance evidence.
    const transferId = randomUUID();
    await admin`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,initiated_by,
        previous_owner_stays,available_at,expires_at,state,canceled_at,canceled_by)
      values(${transferId},${org.organizationId},${primary.id},${co.email},${sha256(transferId)},'owner',false,
        now()-interval '3 days',now()-interval '1 day','canceled',now()-interval '2 days','owner')`;
    await admin`update organization_co_owners set removed_at=now(),removed_by=${primary.id},removal='removed'
        where account_id=${co.id} and removed_at is null`;
    const [ownerSession] =
      await admin`select id from owner_sessions where account_id=${co.id} limit 1`;
    await admin`insert into legal_acceptances(id,account_id,owner_session_id,document,version,content_hash,entity_hash,published,locale,context)
        values(${randomUUID()},${co.id},${ownerSession.id},'terms',${LEGAL_DOCUMENTS.terms.version},${"a".repeat(64)},${"b".repeat(64)},false,'es','signup')`;
    await cli(support!, ["block-account", "--account", co.id]);
    await assert.rejects(
      withOwner(sql, co.login, undefined, async () => null),
      /unauthorized/,
    );
    await assert.rejects(
      signInGoogleOwner(sql, {
        issuer: "https://accounts.google.com",
        subject: co.subject,
        email: co.email,
      }),
      /unauthorized|signup_paused/,
    );
    await assert.rejects(
      cli(support!, ["anonymize-account", "--account", co.id]),
      /support_retention_not_over/,
    );
    // Five years later (test-only: the block row's time moved back inside one
    // admin transaction with the append-only trigger disabled, LD-12 pattern).
    await admin.begin(async (tx) => {
      await tx`alter table support_actions disable trigger support_actions_append_only`;
      await tx`update support_actions set created_at=now()-interval '5 years 1 day'
          where action='block_account' and target->>'accountId'=${co.id}`;
      await tx`alter table support_actions enable trigger support_actions_append_only`;
    });
    await cli(support!, ["anonymize-account", "--account", co.id]);
    const [a] =
      await admin`select email,name,active from owner_accounts where id=${co.id}`;
    assert.deepEqual(
      { ...a },
      {
        email: "redacted:" + sha256(co.email),
        name: ANONYMIZED_NAME,
        active: false,
      },
    );
    const [t] =
      await admin`select to_email,state,canceled_by from ownership_transfers where id=${transferId}`;
    assert.deepEqual(
      { ...t },
      {
        to_email: "redacted:" + sha256(co.email),
        state: "canceled",
        canceled_by: "owner",
      },
    );
    const [kept] =
      await admin`select count(*)::int as n from legal_acceptances where account_id=${co.id}`;
    assert.equal(kept.n, 1, "acceptance evidence stays, keyed by account id");
    const logged = await accountActions(co.id, "anonymize_account");
    assert.deepEqual(
      logged.map((l) => l.organization_id),
      [org.organizationId],
    );
    assert.ok(!textOf(logged).includes(co.email));
    // The guard still refuses any other change to a closed transfer.
    await assert.rejects(
      admin`update ownership_transfers set to_email='otra@ejemplo.mx' where id=${transferId}`,
      /ownership_transfer_immutable/,
    );
    await assert.rejects(
      cli(support!, ["anonymize-account", "--account", co.id]),
      /support_account_anonymized/,
    );
    // A primary leaving with its organization (offboarding) can be blocked.
    await cli(support!, [
      "block-account",
      "--account",
      primary.id,
      "--offboarding",
    ]);
    const [blocked] =
      await admin`select active from owner_accounts where id=${primary.id}`;
    assert.equal(blocked.active, false);
  });

  await test("12 support: redact-email anonymizes a non-customer's closed transfers at once; refused for an email with an account and while a live transfer to it is pending (DATA-1)", async () => {
    const p = await ownerFixture("redact-primary");
    const org = await ownRestaurant(p, `Redacta ${role.slice(-6)}`);
    const stranger = `maria-${role}@gmail.example.com`;
    const closed = randomUUID();
    await admin`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,initiated_by,
        previous_owner_stays,available_at,expires_at,state,canceled_at,canceled_by)
      values(${closed},${org.organizationId},${p.id},${stranger},${sha256(closed)},'owner',false,
        now()-interval '3 days',now()-interval '1 day','canceled',now()-interval '2 days','owner')`;
    const live = randomUUID();
    await admin`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,initiated_by,
        previous_owner_stays,available_at,expires_at)
      values(${live},${org.organizationId},${p.id},${stranger},${sha256(live)},'owner',false,now(),now()+interval '1 day')`;
    await assert.rejects(
      cli(support!, ["redact-email", "--email", stranger]),
      /support_transfer_pending/,
    );
    await admin`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='owner' where id=${live}`;
    await assert.rejects(
      cli(support!, ["redact-email", "--email", p.email]),
      /support_email_has_account/,
    );
    await cli(support!, ["redact-email", "--email", stranger]);
    const rows =
      await admin`select to_email from ownership_transfers where id in (${closed},${live})`;
    assert.deepEqual(
      rows.map((x) => x.to_email),
      ["redacted:" + sha256(stranger), "redacted:" + sha256(stranger)],
    );
    const [logged] =
      await admin`select organization_id,target from support_actions where action='redact_email'
        and target->'emailSha256s' ? ${sha256(stranger)}`;
    assert.equal(logged.organization_id, org.organizationId);
    assert.ok(!textOf(logged).includes(stranger));
  });
  console.log(
    `Support DB passed (${checks} checks): vendor CLI least privilege (every write bound to a same-transaction action row), unlock, grants, transfers, Free device and the ARCO tools (rectify, block, anonymize, redact). Fixtures retained.`,
  );
} finally {
  await support?.end();
  try {
    await admin.unsafe(
      `revoke connect on database "${database}" from "${role}"`,
    );
    await admin.unsafe(`drop role if exists "${role}"`);
  } catch (error) {
    console.error("support role cleanup failed", (error as Error).message);
  }
  await sql.end();
  await admin.end();
}
