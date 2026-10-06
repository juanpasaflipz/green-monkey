/**
 * Vendor support CLI database suite (account 031, GAP-5): runs the real CLI
 * commands as a temporary gm_support member login against the isolated test
 * target, and proves what that role can and cannot reach.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
  console.log(
    `Support DB passed (${checks} checks): vendor CLI least privilege, unlock, grants, transfers and Free device. Fixtures retained.`,
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
