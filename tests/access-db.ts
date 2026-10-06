import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import {
  authentication,
  hash,
  password,
  sign,
  verify,
} from "../server/auth.js";
import {
  checkPin,
  createSession,
  idleLockDefault,
  deviceScope,
  endSession,
  isTerminalRequest,
  legacyLogin,
  loadDevice,
  pinSignIn,
  requireRecentAuth,
  signOut,
  stepUp,
  terminalState,
  touchSession,
} from "../server/access.js";
import {
  cancelPairingCode,
  createPairingCode,
  generatePairingCode,
  pairingHash,
  redeemPairingCode,
} from "../server/access-pairing.js";
import { revokeDevice } from "../server/access-devices.js";
import {
  createStaff,
  listStaff,
  pinFingerprint,
  resetStaffPin,
  setStaffActive,
  unlockStaff,
  updateStaff,
} from "../server/access-staff.js";
import { leaseCovers, renewOfflineLease } from "../server/offline-leases.js";
import { synchronizeOffline } from "../server/offline-sync.js";
import { verifyApproval, voidLines } from "../server/voids.js";
import { createOrder, recordPayment } from "../server/orders.js";
import {
  paymentRecoveryStatus,
  retryPaymentRecovery,
} from "../server/payment-recovery.js";
import { saveEmployee, saveProduct } from "../server/management.js";
import {
  createOwnerRestaurant,
  enterOwnerRestaurant,
  ownerBrowserCookie,
  signInGoogleOwner,
  withOwner,
} from "../server/owner-accounts.js";
import type { Session } from "../shared/domain.js";
import { effectiveIdleLock, type SessionAccess } from "../shared/access.js";

const { runtime, migration } = isolatedTarget(process.env);
const sql = connect(runtime),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);

const organizationId = randomUUID(),
  tenantId = randomUUID(),
  otherTenantId = randomUUID();
const ownerId = randomUUID(),
  managerId = randomUUID(),
  cashierId = randomUUID(),
  kitchenId = randomUUID(),
  secondOwnerId = randomUUID();
const OWNER_SECRET = "owner-fixture-secret",
  MANAGER_PIN = "246810",
  CASHIER_PIN = "135790",
  KITCHEN_PIN = "112233";
const restaurant = {
  name: "Access fixture",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
  configVersion: 1,
};
const accountIds: string[] = [];
/** Restaurants created through the Google signup path (cleaned up with the fixture). */
const signupTenants: string[] = [];

type Cookie = { id: string; tenantId: string; token: string };
/** A paired device; expiresInHours null = legacy row without a server-side expiry. */
async function device(
  name: string,
  o: { kind?: string | null; tenant?: string; expiresInHours?: number | null } = {},
): Promise<Cookie> {
  const c = {
    id: randomUUID(),
    tenantId: o.tenant ?? tenantId,
    token: randomBytes(32).toString("hex"),
  };
  const hours = o.expiresInHours === undefined ? 720 : o.expiresInHours;
  await admin`insert into devices(tenant_id,id,name,token_hash,kind,paired_at,token_expires_at)
    values(${c.tenantId},${c.id},${name},${hash(c.token)},${o.kind === undefined ? "terminal" : o.kind},now(),
      case when ${hours}::int is null then null else now()+make_interval(hours=>${hours}::int) end)`;
  return c;
}
const run = <T>(fn: (tx: Tx) => Promise<T>) => tenant(sql, tenantId, fn);
const base = {
  csrf: "fixture",
  expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
  offlineUntil: new Date(Date.now() + 4 * 3600_000).toISOString(),
  offlineLeaseVersion: 1,
  restaurant,
};
function as(
  employeeId: string,
  role: string,
  deviceId: string,
  access?: Partial<SessionAccess>,
  id = randomUUID(),
): Session {
  return {
    ...base,
    id,
    tenantId,
    employeeId,
    deviceId,
    role,
    name: role,
    ...(access
      ? {
          access: {
            absoluteExpiresAt: null,
            authenticatedAt: new Date().toISOString(),
            deviceName: "Fixture",
            deviceKind: "terminal",
            idleLockSeconds: 180,
            ownerAccount: false,
            ...access,
          },
        }
      : {}),
  } as Session;
}
type Stub = {
  cookies: Map<string, string>;
  cleared: string[];
};
function stubRes(): Stub & {
  cookie(n: string, v: string): void;
  clearCookie(n: string): void;
} {
  const out = {
    cookies: new Map<string, string>(),
    cleared: [] as string[],
    cookie(n: string, v: string) {
      out.cookies.set(n, v);
    },
    clearCookie(n: string) {
      out.cleared.push(n);
    },
  };
  return out;
}
function req(cookies: Record<string, string>, body: unknown = {}) {
  return { cookies, body, headers: {}, method: "POST" } as any;
}
function parseSigned(value: string): Cookie {
  return verify(value) as Cookie;
}
/** Runs authentication() with stub request/response; resolves the Session or rejects with its error. */
function authenticate(cookies: Record<string, string>) {
  const res = stubRes();
  const request = { method: "GET", cookies, headers: {} } as any;
  return new Promise<{ session: Session; res: typeof res }>(
    (resolve, reject) => {
      void authentication(sql)(request, res as any, (error?: unknown) =>
        error ? reject(error) : resolve({ session: request.session, res }),
      );
    },
  );
}
async function rejects(promise: Promise<unknown>, code: string | RegExp) {
  await assert.rejects(promise, (e: any) => {
    if (code instanceof RegExp) assert.match(`${e.code} ${e.message}`, code);
    else assert.equal(e.code ?? e.message, code);
    return true;
  });
}
async function sessionRow(id: string) {
  const [row] = await admin`select * from sessions where id=${id}`;
  return row;
}
async function clearThrottles(employeeId: string) {
  await admin`delete from pin_throttles where employee_id=${employeeId}`;
  await admin`update employees set failed_attempts=0,locked_until=null where id=${employeeId}`;
}
/** Signs in with a PIN on a device through the real route function. */
async function pin(
  terminal: Cookie,
  employeeId: string,
  secret: string,
  session?: string,
) {
  const res = stubRes();
  const result = await pinSignIn(
    sql,
    req(
      {
        gm_device: sign(terminal),
        ...(session ? { gm_session: session } : {}),
      },
      { employeeId, secret },
    ),
    res as any,
  );
  return { ...result, res, cookie: res.cookies.get("gm_session") ?? session! };
}

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}

try {
  await admin`insert into organizations(id,name) values(${organizationId},'Access fixture')`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values(${tenantId},${organizationId},${restaurant.name},'MXN','America/Mexico_City',240,true),
          (${otherTenantId},${organizationId},'Access fixture B','MXN','America/Mexico_City',240,false)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${tenantId},'active',now()+interval '1 day','fixture')`;
  for (const [id, role, login, secret] of [
    [ownerId, "owner", `owner-${ownerId.slice(0, 8)}`, OWNER_SECRET],
    [managerId, "manager", `mgr-${managerId.slice(0, 8)}`, MANAGER_PIN],
    [cashierId, "cashier", `cash-${cashierId.slice(0, 8)}`, CASHIER_PIN],
    [kitchenId, "kitchen", `kit-${kitchenId.slice(0, 8)}`, KITCHEN_PIN],
    [secondOwnerId, "owner", `own2-${secondOwnerId.slice(0, 8)}`, OWNER_SECRET],
  ])
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role,pin_set_at)
      values(${tenantId},${id},${role + " fixture"},${login},${password(secret)},${role},now())`;
  const owner = as(ownerId, "owner", randomUUID());
  const terminalA = await device("Caja A");
  const terminalB = await device("Caja B");

  await test("new tables force RLS and gm_app has no DELETE; pairing codes are UPDATE-only on transition columns", async () => {
    const tables = ["pin_throttles", "device_pairing_codes", "offline_lease_renewals"];
    const rows =
      await admin`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ${admin(tables)}`;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.relrowsecurity, true, row.relname);
      assert.equal(row.relforcerowsecurity, true, row.relname);
    }
    const [p] = await admin`select
        has_table_privilege('gm_app','pin_throttles','DELETE') as throttle_delete,
        has_table_privilege('gm_app','pin_throttles','UPDATE') as throttle_update,
        has_table_privilege('gm_app','device_pairing_codes','DELETE') as code_delete,
        has_table_privilege('gm_app','device_pairing_codes','UPDATE') as code_update,
        has_column_privilege('gm_app','device_pairing_codes','consumed_at','UPDATE') as consume,
        has_column_privilege('gm_app','device_pairing_codes','cancelled_by','UPDATE') as cancel,
        has_column_privilege('gm_app','device_pairing_codes','code_hash','UPDATE') as rehash,
        has_column_privilege('gm_app','device_pairing_codes','expires_at','UPDATE') as extend,
        has_table_privilege('gm_app','offline_lease_renewals','DELETE') as renewal_delete,
        has_table_privilege('gm_app','offline_lease_renewals','UPDATE') as renewal_update,
        has_table_privilege('gm_app','offline_lease_renewals','INSERT') as renewal_insert`;
    assert.deepEqual(p, {
      throttle_delete: false,
      throttle_update: true,
      code_delete: false,
      code_update: false,
      consume: true,
      cancel: true,
      rehash: false,
      extend: false,
      renewal_delete: false,
      renewal_update: false,
      renewal_insert: true,
    });
  });

  await test("ACC-R6-6: sessions are indexed per employee and per device (staff list, device list, revoke paths)", async () => {
    const indexes = await admin`select indexname,indexdef from pg_indexes
      where schemaname='public' and tablename='sessions' and indexname in ('sessions_by_employee','sessions_by_device')
      order by indexname`;
    assert.deepEqual(
      indexes.map((i) => [i.indexname, /\(tenant_id, (\w+)\)$/.exec(i.indexdef)?.[1]]),
      [
        ["sessions_by_device", "device_id"],
        ["sessions_by_employee", "employee_id"],
      ],
    );
  });

  await test("pairing code redeems once, atomically, and only by its exact hash (GAP-2/SEC-5)", async () => {
    const code = await run((tx) =>
      createPairingCode(tx, owner, { deviceName: "Caja doble" }),
    );
    assert.match(code.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const results = await Promise.allSettled([
      redeemPairingCode(sql, { code: code.code }, null),
      redeemPairingCode(sql, { code: code.code.toLowerCase() }, null),
      redeemPairingCode(sql, { code: code.code.replace("-", " ") }, null),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.equal(ok.length, 1);
    for (const r of results)
      if (r.status === "rejected")
        assert.equal((r.reason as any).code, "pairing_code_invalid");
    const devices =
      await admin`select kind,paired_by,token_expires_at>now()+interval '29 days' as fresh from devices where tenant_id=${tenantId} and name='Caja doble'`;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].kind, "terminal");
    assert.equal(devices[0].paired_by, ownerId);
    assert.equal(devices[0].fresh, true);
    await rejects(
      redeemPairingCode(sql, { code: code.code }, null),
      "pairing_code_invalid",
    );
    const paired = (ok[0] as PromiseFulfilledResult<any>).value;
    assert.equal(paired.restaurant, restaurant.name);
    assert.equal(
      (await run((tx) => loadDevice(tx, paired.device)))?.kind,
      "terminal",
    );
  });

  await test("A11: a code dies with its creator's access or manager role; deactivation cancels the creator's open codes", async () => {
    const creatorId = randomUUID();
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role,pin_set_at)
      values(${tenantId},${creatorId},'Gerente saliente',${"mgr-out-" + creatorId.slice(0, 8)},${password("975319")},'manager',now())`;
    const creator = as(creatorId, "manager", terminalA.id, {});
    const first = await run((tx) =>
      createPairingCode(tx, creator, { deviceName: "Código saliente 1" }),
    );
    const second = await run((tx) =>
      createPairingCode(tx, creator, { deviceName: "Código saliente 2" }),
    );
    // Deactivation by the owner cancels every open code the manager created.
    await run((tx) =>
      setStaffActive(tx, as(ownerId, "owner", terminalA.id, {}), creatorId, {
        operationId: randomUUID(),
        active: false,
      }),
    );
    const codes =
      await admin`select cancelled_by from device_pairing_codes where id in (${first.id},${second.id})`;
    assert.deepEqual(
      codes.map((c) => c.cancelled_by),
      [ownerId, ownerId],
    );
    for (const code of [first.code, second.code])
      await rejects(
        redeemPairingCode(sql, { code }, null),
        "pairing_code_invalid",
      );
    // A code whose creator lost the manager role some other way is refused too.
    await admin`update employees set active=true,deactivated_at=null where id=${creatorId}`;
    const third = await run((tx) =>
      createPairingCode(tx, creator, { deviceName: "Código saliente 3" }),
    );
    await admin`update employees set role='cashier' where id=${creatorId}`;
    await rejects(
      redeemPairingCode(sql, { code: third.code }, null),
      "pairing_code_invalid",
    );
    const [devices] =
      await admin`select count(*)::int as n from devices where tenant_id=${tenantId} and name like 'Código saliente%'`;
    assert.equal(devices.n, 0);
    await admin`update employees set active=false where id=${creatorId}`;
  });

  await test("expired and cancelled codes are rejected with the same error", async () => {
    const expired = generatePairingCode();
    await admin`insert into device_pairing_codes(tenant_id,id,code_hash,device_name,created_by,created_at,expires_at)
      values(${tenantId},${randomUUID()},${pairingHash(expired)},'Vencido',${ownerId},now()-interval '20 minutes',now()-interval '10 minutes')`;
    await rejects(
      redeemPairingCode(sql, { code: expired }, null),
      "pairing_code_invalid",
    );
    const cancelled = await run((tx) =>
      createPairingCode(tx, owner, { deviceName: "Cancelado" }),
    );
    await run((tx) => cancelPairingCode(tx, owner, cancelled.id, {}));
    await rejects(
      run((tx) => cancelPairingCode(tx, owner, cancelled.id, {})),
      "pairing_code_unavailable",
    );
    await rejects(
      redeemPairingCode(sql, { code: cancelled.code }, null),
      "pairing_code_invalid",
    );
    await rejects(
      redeemPairingCode(sql, { code: generatePairingCode() }, null),
      "pairing_code_invalid",
    );
    await rejects(
      redeemPairingCode(sql, { code: "UUUU-UUUU" }, null),
      "pairing_code_invalid",
    );
    const [devices] =
      await admin`select count(*)::int as n from devices where tenant_id=${tenantId} and name in ('Vencido','Cancelado')`;
    assert.equal(devices.n, 0);
  });

  await test("pairing codes are invisible across tenants and without the hash GUC", async () => {
    const code = await run((tx) =>
      createPairingCode(tx, owner, { deviceName: "Invisible" }),
    );
    const canonical = code.code.replace("-", "");
    const other = await tenant(
      sql,
      otherTenantId,
      (tx) => tx`select id from device_pairing_codes where id=${code.id}`,
    );
    assert.equal(other.length, 0);
    const none = await sql.begin(
      (tx) => (tx as unknown as Tx)`select id from device_pairing_codes`,
    );
    assert.equal(none.length, 0);
    const wrong = await sql.begin(async (raw) => {
      const tx = raw as unknown as Tx;
      await tx`select set_config('app.pairing_code_hash',${pairingHash(generatePairingCode())},true)`;
      return tx`select id from device_pairing_codes`;
    });
    assert.equal(wrong.length, 0);
    const exact = await sql.begin(async (raw) => {
      const tx = raw as unknown as Tx;
      await tx`select set_config('app.pairing_code_hash',${pairingHash(canonical)},true)`;
      return tx`select id from device_pairing_codes`;
    });
    assert.deepEqual(
      exact.map((r) => r.id),
      [code.id],
    );
    await run((tx) => cancelPairingCode(tx, owner, code.id, {}));
  });

  await test("no plaintext code is stored in device_pairing_codes, operations or audit", async () => {
    const code = await run((tx) =>
      createPairingCode(tx, owner, { deviceName: "Sin texto" }),
    );
    const plain = code.code.replace("-", "");
    for (const needle of [plain, code.code]) {
      const [hits] = await admin`select
          (select count(*) from device_pairing_codes c where c.tenant_id=${tenantId} and row_to_json(c)::text like ${"%" + needle + "%"})::int as codes,
          (select count(*) from operations o where o.tenant_id=${tenantId} and row_to_json(o)::text like ${"%" + needle + "%"})::int as operations,
          (select count(*) from audit a where a.tenant_id=${tenantId} and row_to_json(a)::text like ${"%" + needle + "%"})::int as audit`;
      assert.deepEqual(hits, { codes: 0, operations: 0, audit: 0 });
    }
    const [created] =
      await admin`select detail from audit where tenant_id=${tenantId} and operation='access.pairing_code_created' and entity_id=${code.id}`;
    assert.equal(created.detail.deviceName, "Sin texto");
    await run((tx) => cancelPairingCode(tx, owner, code.id, {}));
  });

  await test("pairing-code transition trigger rejects re-consumption and field edits", async () => {
    const consumed = await run((tx) =>
      createPairingCode(tx, owner, { deviceName: "Transición" }),
    );
    const paired = await redeemPairingCode(sql, { code: consumed.code }, null);
    await rejects(
      admin`update device_pairing_codes set consumed_at=now() where id=${consumed.id}`,
      /device_pairing_code_immutable/,
    );
    await rejects(
      admin`update device_pairing_codes set cancelled_at=now(),cancelled_by=${ownerId},consumed_at=null,device_id=null where id=${consumed.id}`,
      /device_pairing_code_immutable/,
    );
    const open = await run((tx) =>
      createPairingCode(tx, owner, { deviceName: "Abierto" }),
    );
    await rejects(
      admin`update device_pairing_codes set device_name='Otro' where id=${open.id}`,
      /device_pairing_code_immutable/,
    );
    await rejects(
      admin`update device_pairing_codes set expires_at=expires_at+interval '1 minute' where id=${open.id}`,
      /device_pairing_code_immutable/,
    );
    await rejects(
      run(
        (tx) =>
          tx`update device_pairing_codes set code_hash='x' where id=${open.id}`,
      ),
      /permission denied/,
    );
    await rejects(
      run((tx) => tx`delete from device_pairing_codes where id=${open.id}`),
      /permission denied/,
    );
    await run((tx) => cancelPairingCode(tx, owner, open.id, {}));
    assert.ok(paired.device.id);
  });

  await test("SEC-2 regression: login without a paired device for a non-demo tenant never changes PIN counters", async () => {
    assert.notEqual(process.env.DEMO_TENANT_ID, tenantId);
    const before =
      await admin`select failed_attempts,locked_until from employees where id=${managerId}`;
    const [throttles] =
      await admin`select count(*)::int as n from pin_throttles where employee_id=${managerId}`;
    for (const cookies of [
      {},
      { gm_device: sign(await device("Otra sucursal", { tenant: otherTenantId })) },
    ])
      for (let i = 0; i < 6; i++)
        await rejects(
          legacyLogin(
            sql,
            req(cookies, {
              tenantId,
              login: `mgr-${managerId.slice(0, 8)}`,
              secret: "000000",
            }),
            stubRes() as any,
          ),
          "device_not_paired",
        );
    const after =
      await admin`select failed_attempts,locked_until from employees where id=${managerId}`;
    assert.deepEqual(after, before);
    const [now] =
      await admin`select count(*)::int as n from pin_throttles where employee_id=${managerId}`;
    assert.equal(now.n, throttles.n);
  });

  await test("SEC-2: a lock on device A does not block the same employee on device B", async () => {
    await clearThrottles(cashierId);
    const scopeA = deviceScope(terminalA.id);
    for (let i = 1; i <= 4; i++)
      assert.equal(
        (await run((tx) => checkPin(tx, { employeeId: cashierId }, "999999", scopeA)))
          .outcome,
        "invalid",
      );
    assert.equal(
      (await run((tx) => checkPin(tx, { employeeId: cashierId }, "999999", scopeA)))
        .outcome,
      "locked",
    );
    // A locked scope refuses even the right PIN, without evaluating it.
    assert.equal(
      (await run((tx) => checkPin(tx, { employeeId: cashierId }, CASHIER_PIN, scopeA)))
        .outcome,
      "locked",
    );
    await rejects(pin(terminalA, cashierId, CASHIER_PIN), "pin_locked");
    const onB = await pin(terminalB, cashierId, CASHIER_PIN);
    assert.equal(onB.reused, false);
    const [row] =
      await admin`select failures,lock_level,locked_until>now() as locked from pin_throttles where employee_id=${cashierId} and scope=${scopeA}`;
    assert.deepEqual(row, { failures: 0, lock_level: 1, locked: true });
  });

  await test("SEC-2: manager unlock and PIN reset clear every lock", async () => {
    const manager = as(managerId, "manager", terminalA.id);
    for (const scope of [deviceScope(terminalA.id), deviceScope(terminalB.id)])
      for (let i = 0; i < 5; i++)
        await run((tx) => checkPin(tx, { employeeId: cashierId }, "999999", scope));
    await run((tx) =>
      unlockStaff(tx, manager, cashierId, { operationId: randomUUID() }),
    );
    const [unlocked] =
      await admin`select count(*)::int as n from pin_throttles where employee_id=${cashierId} and (locked_until is not null or failures>0)`;
    assert.equal(unlocked.n, 0);
    assert.equal(
      (await run((tx) =>
        checkPin(tx, { employeeId: cashierId }, CASHIER_PIN, deviceScope(terminalA.id)),
      )).outcome,
      "ok",
    );
    for (let i = 0; i < 5; i++)
      await run((tx) =>
        checkPin(tx, { employeeId: cashierId }, "999999", deviceScope(terminalB.id)),
      );
    await run((tx) =>
      resetStaffPin(tx, owner, cashierId, {
        operationId: randomUUID(),
        pin: "975310",
      }),
    );
    assert.equal(
      (await run((tx) =>
        checkPin(tx, { employeeId: cashierId }, "975310", deviceScope(terminalB.id)),
      )).outcome,
      "ok",
    );
    await run((tx) =>
      resetStaffPin(tx, owner, cashierId, {
        operationId: randomUUID(),
        pin: CASHIER_PIN,
      }),
    );
  });

  await test("hard lock after 100 consecutive failures refuses even the correct PIN until unlocked", async () => {
    await clearThrottles(kitchenId);
    await admin`update employees set failed_attempts=99 where id=${kitchenId}`;
    const scope = deviceScope(terminalB.id);
    assert.equal(
      (await run((tx) => checkPin(tx, { employeeId: kitchenId }, "000000", scope)))
        .outcome,
      "hard_locked",
    );
    assert.equal(
      (await run((tx) => checkPin(tx, { employeeId: kitchenId }, KITCHEN_PIN, scope)))
        .outcome,
      "hard_locked",
    );
    assert.equal(
      (await run((tx) =>
        checkPin(tx, { employeeId: kitchenId }, KITCHEN_PIN, deviceScope(terminalA.id)),
      )).outcome,
      "hard_locked",
    );
    await rejects(pin(terminalA, kitchenId, KITCHEN_PIN), "pin_hard_locked");
    await run((tx) =>
      unlockStaff(tx, owner, kitchenId, { operationId: randomUUID() }),
    );
    assert.equal(
      (await run((tx) => checkPin(tx, { employeeId: kitchenId }, KITCHEN_PIN, scope)))
        .outcome,
      "ok",
    );
  });

  await test("A5: managers unlock only cashiers, servers and kitchen staff, never a hard lock or the failure counter, 3 times a day; the owner unlocks anyone", async () => {
    const manager = as(managerId, "manager", terminalA.id, {});
    const ownerOnTerminal = as(ownerId, "owner", terminalA.id, {});
    const unlock = (by: Session, employeeId: string) =>
      run((tx) => unlockStaff(tx, by, employeeId, { operationId: randomUUID() }));
    // Owners and managers: owner only.
    for (const employeeId of [ownerId, secondOwnerId, managerId])
      await rejects(unlock(manager, employeeId), "unlock_owner_only");
    // A fresh server: wrong PINs lock it on this device and count globally.
    const serverId = randomUUID(),
      serverPin = "860244";
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role,pin_set_at)
      values(${tenantId},${serverId},'Mesero A5',${"srv-" + serverId.slice(0, 8)},${password(serverPin)},'server',now())`;
    const scope = deviceScope(terminalA.id);
    for (let i = 0; i < 5; i++)
      await run((tx) => checkPin(tx, { employeeId: serverId }, "000000", scope));
    await unlock(manager, serverId);
    const [afterManager] = await admin`select e.failed_attempts,e.locked_until,
        (select count(*)::int from pin_throttles t where t.employee_id=e.id and (t.locked_until is not null or t.failures>0)) as throttled
      from employees e where e.id=${serverId}`;
    assert.deepEqual(
      { ...afterManager },
      { failed_attempts: 5, locked_until: null, throttled: 0 },
      "a manager clears the device locks but keeps the consecutive-failure counter",
    );
    const [audited] =
      await admin`select detail->>'by' as by from audit where entity_id=${serverId} and operation='access.employee_unlocked'`;
    assert.equal(audited.by, "manager");
    // At most 3 manager unlocks of one employee per rolling day.
    await unlock(manager, serverId);
    await unlock(manager, serverId);
    await rejects(unlock(manager, serverId), "unlock_limit");
    // The counter keeps running to the hard lock, which a manager cannot clear.
    await admin`update employees set failed_attempts=99 where id=${serverId}`;
    assert.equal(
      (await run((tx) => checkPin(tx, { employeeId: serverId }, "000000", scope)))
        .outcome,
      "hard_locked",
    );
    await rejects(unlock(manager, serverId), /unlock_owner_only|unlock_limit/);
    await admin`delete from audit where entity_id=${serverId}`;
    await rejects(unlock(manager, serverId), "unlock_owner_only");
    // The owner clears everything, the hard lock included, without a daily limit.
    await unlock(ownerOnTerminal, serverId);
    const [afterOwner] =
      await admin`select failed_attempts,locked_until from employees where id=${serverId}`;
    assert.deepEqual({ ...afterOwner }, { failed_attempts: 0, locked_until: null });
    assert.equal(
      (await run((tx) => checkPin(tx, { employeeId: serverId }, serverPin, scope)))
        .outcome,
      "ok",
    );
    for (let i = 0; i < 4; i++) await unlock(ownerOnTerminal, serverId);
    await unlock(ownerOnTerminal, managerId);
    await unlock(ownerOnTerminal, secondOwnerId);
  });

  await test("A5: void approvals check the order before any PIN, and one session's rejected approvals are capped per minute", async () => {
    await clearThrottles(managerId);
    await clearThrottles(secondOwnerId);
    const cashier = as(cashierId, "cashier", terminalB.id, {});
    // A made-up order: refused before the PIN is evaluated or counted.
    await rejects(
      verifyApproval(
        sql,
        cashier,
        { employeeId: managerId, secret: "000000" },
        randomUUID(),
      ),
      "not_found",
    );
    const [untouched] =
      await admin`select failed_attempts from employees where id=${managerId}`;
    assert.equal(untouched.failed_attempts, 0);
    // Ten rejected approvals in a minute, then the session is refused outright.
    for (let i = 0; i < 10; i++)
      await rejects(
        verifyApproval(sql, cashier, {
          employeeId: i % 2 ? managerId : secondOwnerId,
          secret: "000000",
        }),
        /approval_denied|pin_locked/,
      );
    const counters = async () =>
      (
        await admin`select sum(failed_attempts)::int as n from employees where id in (${managerId},${secondOwnerId})`
      )[0].n;
    const before = await counters();
    await rejects(
      verifyApproval(sql, cashier, { employeeId: managerId, secret: MANAGER_PIN }),
      "too_many_attempts",
    );
    assert.equal(await counters(), before, "a capped request never reaches checkPin");
    // Another session on the device is not affected by this session's cap.
    assert.equal(
      await verifyApproval(sql, as(cashierId, "cashier", terminalA.id, {}), {
        employeeId: managerId,
        secret: MANAGER_PIN,
      }),
      managerId,
    );
    await clearThrottles(managerId);
    await clearThrottles(secondOwnerId);
  });

  await test("approval attempts spend the approver's attempts on the session's device only", async () => {
    await clearThrottles(managerId);
    const cashier = as(cashierId, "cashier", terminalA.id, {});
    for (let i = 0; i < 4; i++)
      await rejects(
        verifyApproval(sql, cashier, { employeeId: managerId, secret: "000000" }),
        "approval_denied",
      );
    await rejects(
      verifyApproval(sql, cashier, { employeeId: managerId, secret: "000000" }),
      "pin_locked",
    );
    await rejects(
      verifyApproval(sql, cashier, { employeeId: managerId, secret: MANAGER_PIN }),
      "pin_locked",
    );
    const scopes =
      await admin`select scope from pin_throttles where employee_id=${managerId} and locked_until>now()`;
    assert.deepEqual(
      scopes.map((r) => r.scope),
      [deviceScope(terminalA.id)],
    );
    const elsewhere = as(cashierId, "cashier", terminalB.id, {});
    assert.equal(
      await verifyApproval(sql, elsewhere, {
        employeeId: managerId,
        secret: MANAGER_PIN,
      }),
      managerId,
    );
    // A non-manager's correct PIN is still denied.
    await rejects(
      verifyApproval(sql, elsewhere, { employeeId: cashierId, secret: CASHIER_PIN }),
      "approval_denied",
    );
    await clearThrottles(managerId);
  });

  await test("manager self-approval on a terminal requires a recent PIN; a Google-entered session on a personal device does not (SEC-6/A4)", async () => {
    const stale = new Date(Date.now() - 3600_000).toISOString();
    const terminal = as(managerId, "manager", terminalA.id, {
      authenticatedAt: stale,
    });
    await rejects(verifyApproval(sql, terminal, undefined), "approval_required");
    const fresh = as(managerId, "manager", terminalA.id, {});
    assert.equal(await verifyApproval(sql, fresh, undefined), managerId);
    const personal = as(managerId, "manager", terminalA.id, {
      deviceKind: "personal",
      ownerAccount: true,
      authenticatedAt: stale,
    });
    assert.equal(await verifyApproval(sql, personal, undefined), managerId);
    // A PIN session on a legacy "Owner browser" device (023 made every one of
    // them personal, shared tablets included) gets no exemption (A4).
    const pinOnPersonal = as(managerId, "manager", terminalA.id, {
      deviceKind: "personal",
      ownerAccount: false,
      authenticatedAt: stale,
    });
    await rejects(
      verifyApproval(sql, pinOnPersonal, undefined),
      "approval_required",
    );
    assert.throws(() => requireRecentAuth(pinOnPersonal), /step_up_required/);
    const internal = as(managerId, "manager", terminalA.id);
    assert.equal(await verifyApproval(sql, internal, undefined), managerId);
    // Confirming with one's own PIN refreshes the session's authentication time.
    const signed = await pin(terminalA, managerId, MANAGER_PIN);
    await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${signed.sessionId}`;
    const self = as(managerId, "manager", terminalA.id, { authenticatedAt: stale }, signed.sessionId);
    assert.equal(
      await verifyApproval(sql, self, { employeeId: managerId, secret: MANAGER_PIN }),
      managerId,
    );
    const row = await sessionRow(signed.sessionId);
    assert.ok(Date.now() - row.authenticated_at.getTime() < 60_000);
  });

  await test("FOH-7: touch slides expires_at up to absolute_expires_at and never beyond", async () => {
    const created = await run((tx) =>
      createSession(tx, { employeeId: cashierId, deviceId: terminalB.id }),
    );
    const row = await sessionRow(created.id);
    const absoluteHours = (row.absolute_expires_at - row.created_at) / 3600_000;
    assert.ok(Math.abs(absoluteHours - 16) < 0.01);
    assert.ok(Math.abs((row.expires_at - row.created_at) / 3600_000 - 8) < 0.01);
    assert.ok(Math.abs((row.offline_until - row.created_at) / 3600_000 - 4) < 0.01);
    const touch = async () => {
      const [r] = await admin`select s.*,e.role,l.selling_authorized as lease_selling from sessions s
        join employees e on e.id=s.employee_id left join offline_leases l on l.session_id=s.id where s.id=${created.id}`;
      return run((tx) => touchSession(tx, r as any, false));
    };
    await admin`update sessions set last_seen_at=now()-interval '2 minutes',expires_at=now()+interval '1 minute',
      absolute_expires_at=now()+interval '5 hours' where id=${created.id}`;
    const capped = await touch();
    const afterCap = await sessionRow(created.id);
    assert.equal(afterCap.expires_at.getTime(), afterCap.absolute_expires_at.getTime());
    assert.equal(capped.expiresAt.getTime(), afterCap.expires_at.getTime());
    await admin`update sessions set last_seen_at=now()-interval '2 minutes',expires_at=now()+interval '1 minute',
      absolute_expires_at=now()+interval '15 hours' where id=${created.id}`;
    await touch();
    const slid = await sessionRow(created.id);
    const hours = (slid.expires_at.getTime() - Date.now()) / 3600_000;
    assert.ok(hours > 7.9 && hours <= 8.01, String(hours));
    // A second request within a minute does not write.
    await admin`update sessions set expires_at=now()+interval '2 hours' where id=${created.id}`;
    await touch();
    const unchanged = await sessionRow(created.id);
    assert.ok((unchanged.expires_at.getTime() - Date.now()) / 3600_000 < 2.01);
    // Legacy sessions without an absolute cap keep their fixed expiry.
    await admin`update sessions set absolute_expires_at=null,last_seen_at=null where id=${created.id}`;
    await touch();
    const legacy = await sessionRow(created.id);
    assert.equal(legacy.last_seen_at, null);
    await run((tx) => endSession(tx, created.id, "logout"));
  });

  await test("FOH-7: an expired absolute cap yields session_expired; ended yields session_ended; revoked yields session_revoked; revoked device yields device_revoked", async () => {
    const terminal = await device("Diagnóstico");
    const cookies = async () => {
      const s = await pin(terminal, cashierId, CASHIER_PIN);
      return { gm_device: sign(terminal), gm_session: s.cookie, id: s.sessionId };
    };
    const live = await cookies();
    const ok = await authenticate(live);
    assert.equal(ok.session.access?.deviceKind, "terminal");
    assert.equal(ok.session.access?.deviceName, "Diagnóstico");
    // Default auto-lock (ACCESS_IDLE_LOCK_DEFAULT_SECONDS, 0 in test envs)...
    assert.equal(
      ok.session.access?.idleLockSeconds,
      effectiveIdleLock(null, "cashier", "terminal", idleLockDefault()),
    );
    assert.ok(ok.session.access?.absoluteExpiresAt);
    // ...and an explicit device setting always wins.
    await admin`update devices set idle_lock_seconds=180 where id=${terminal.id}`;
    const locked = await authenticate(live);
    assert.equal(locked.session.access?.idleLockSeconds, 180);
    await admin`update devices set idle_lock_seconds=null where id=${terminal.id}`;
    await admin`update sessions set expires_at=now()-interval '1 minute',absolute_expires_at=now()-interval '1 minute' where id=${live.id}`;
    await rejects(authenticate(live), "session_expired");
    const ended = await cookies();
    await signOut(sql, req({ gm_session: ended.gm_session }), stubRes() as any);
    const failed = authenticate(ended);
    await rejects(failed, "session_ended");
    const revoked = await cookies();
    await admin`update sessions set revoked=true where id=${revoked.id}`;
    await rejects(authenticate(revoked), "session_revoked");
    const missing = { gm_device: sign(terminal) };
    await rejects(authenticate(missing), "unauthorized");
    await rejects(authenticate({}), "device_not_paired");
    const gone = await cookies();
    await admin`update devices set active=false,revoked_at=now(),revoked_reason='revoked' where id=${terminal.id}`;
    const res = await authenticate(gone).then(
      () => null,
      (e) => e,
    );
    assert.equal(res?.code, "device_revoked");
  });

  // Offline sales recorded under a session, synchronized by a later session.
  const productId = randomUUID();
  await run((tx) =>
    saveProduct(tx, as(ownerId, "owner", terminalA.id), {
      operationId: randomUUID(),
      id: productId,
      name: { es: "Acceso", en: "Access" },
      category: { es: "Pruebas", en: "Tests" },
      price: 100,
      available: true,
      station: "kitchen",
      expectedVersion: 0,
      cost: null,
      recipe: [],
    }),
  );
  const offlineSale = (sessionId: string, drawerId: string, recordedAt: Date) => ({
    operationId: randomUUID(),
    order: {
      operationId: randomUUID(),
      lines: [
        { id: randomUUID(), productId, quantity: 1, options: [], note: "" },
      ],
      mode: "takeaway" as const,
      tableId: null,
      name: "Access offline",
      note: "",
      channel: "pos" as const,
    },
    expectedTotal: 100,
    received: 100,
    tip: 0,
    recordedAt: recordedAt.toISOString(),
    sessionId,
    cashSessionId: drawerId,
  });

  await test("OFF-3: renewal appends an immutable row, sync accepts a sale recorded after the base lease but inside the renewal, and rejects one outside every window", async () => {
    const terminal = await device("Renovación");
    const sessionId = randomUUID(),
      drawerId = randomUUID();
    await admin`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,created_at,last_seen_at,authenticated_at,
        expires_at,absolute_expires_at,offline_until,selling_authorized)
      values(${tenantId},${sessionId},${cashierId},${terminal.id},${hash(randomUUID())},'x',now()-interval '6 hours',now(),now()-interval '6 hours',
        now()+interval '8 hours',now()+interval '10 hours',now()-interval '3 hours',true)`;
    await admin`insert into offline_leases(tenant_id,session_id,employee_id,device_id,contract_version,issued_at,valid_until,selling_authorized,plan,configuration_version,restaurant_snapshot)
      select ${tenantId},${sessionId},${cashierId},${terminal.id},1,now()-interval '6 hours',now()-interval '3 hours',true,'pro',config_version,
        jsonb_build_object('name',name,'currency',currency,'timezone',timezone,'cutoff',cutoff) from restaurants where id=${tenantId}`;
    await admin`insert into offline_lease_renewals(tenant_id,session_id,sequence,issued_at,valid_until)
      values(${tenantId},${sessionId},1,now()-interval '2 hours',now()+interval '30 minutes')`;
    await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
      values(${tenantId},${drawerId},${terminal.id},${cashierId},0,now()-interval '7 hours')`;
    const renewed = await run((tx) =>
      renewOfflineLease(tx, sessionId, new Date(Date.now() + 10 * 3600_000)),
    );
    assert.ok(renewed);
    assert.ok(Math.abs(renewed!.getTime() - Date.now() - 4 * 3600_000) < 60_000);
    const renewals =
      await admin`select sequence from offline_lease_renewals where session_id=${sessionId} order by sequence`;
    assert.deepEqual(
      renewals.map((r) => r.sequence),
      [1, 2],
    );
    // Not renewed again while the window has more than 3 h 45 min left.
    assert.equal(
      await run((tx) =>
        renewOfflineLease(tx, sessionId, new Date(Date.now() + 10 * 3600_000)),
      ),
      null,
    );
    await rejects(
      run(
        (tx) =>
          tx`update offline_lease_renewals set valid_until=now() where session_id=${sessionId}`,
      ),
      /permission denied|offline_evidence_immutable/,
    );
    await rejects(
      admin`update offline_lease_renewals set valid_until=now() where session_id=${sessionId}`,
      /offline_evidence_immutable/,
    );
    const inside = new Date(Date.now() - 90 * 60_000);
    const gap = new Date(Date.now() - 150 * 60_000);
    assert.equal(await run((tx) => leaseCovers(tx, sessionId, inside)), true);
    assert.equal(await run((tx) => leaseCovers(tx, sessionId, gap)), false);
    const s = as(cashierId, "cashier", terminal.id, {}, randomUUID());
    const synced = await run((tx) =>
      synchronizeOffline(tx, s, offlineSale(sessionId, drawerId, inside)),
    );
    assert.equal(synced.total, 100);
    await rejects(
      run((tx) =>
        synchronizeOffline(tx, s, offlineSale(sessionId, drawerId, gap)),
      ),
      "offline_context_invalid",
    );
  });

  await test("OFF-3: renewal is capped by the session's absolute expiry and skipped for non-selling roles", async () => {
    const terminal = await device("Tope");
    const cashier = await run((tx) =>
      createSession(tx, { employeeId: cashierId, deviceId: terminal.id }),
    );
    const cap = new Date(Date.now() + 3600_000);
    await admin`update sessions set absolute_expires_at=${cap},expires_at=least(expires_at,${cap}) where id=${cashier.id}`;
    // The base lease already reaches 4 h; a renewal never exceeds the cap.
    const renewed = await run((tx) => renewOfflineLease(tx, cashier.id, cap));
    assert.equal(renewed, null);
    const kitchen = await run((tx) =>
      createSession(tx, { employeeId: kitchenId, deviceId: terminal.id }),
    );
    const [row] = await admin`select s.*,e.role,l.selling_authorized as lease_selling from sessions s
      join employees e on e.id=s.employee_id left join offline_leases l on l.session_id=s.id where s.id=${kitchen.id}`;
    await admin`update sessions set last_seen_at=now()-interval '2 minutes' where id=${kitchen.id}`;
    await run((tx) => touchSession(tx, { ...(row as any), last_seen_at: null }, true));
    const [kitchenRenewals] =
      await admin`select count(*)::int as n from offline_lease_renewals where session_id=${kitchen.id}`;
    assert.equal(kitchenRenewals.n, 0);
    // A session near its cap renews only up to the cap.
    const near = randomUUID();
    await admin`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,created_at,last_seen_at,authenticated_at,
        expires_at,absolute_expires_at,offline_until,selling_authorized)
      values(${tenantId},${near},${cashierId},${terminal.id},${hash(randomUUID())},'x',now()-interval '15 hours',now()-interval '2 minutes',now(),
        now()+interval '50 minutes',now()+interval '50 minutes',now()-interval '1 hour',true)`;
    await admin`insert into offline_leases(tenant_id,session_id,employee_id,device_id,contract_version,issued_at,valid_until,selling_authorized,plan,configuration_version,restaurant_snapshot)
      select ${tenantId},${near},${cashierId},${terminal.id},1,now()-interval '5 hours',now()-interval '1 hour',true,'pro',config_version,'{}'::jsonb from restaurants where id=${tenantId}`;
    const [nearRow] = await admin`select s.*,e.role,l.selling_authorized as lease_selling from sessions s
      join employees e on e.id=s.employee_id left join offline_leases l on l.session_id=s.id where s.id=${near}`;
    const touched = await run((tx) => touchSession(tx, nearRow as any, true));
    const [renewal] =
      await admin`select valid_until from offline_lease_renewals where session_id=${near}`;
    assert.equal(renewal.valid_until.getTime(), nearRow.absolute_expires_at.getTime());
    assert.equal(touched.offlineUntil.getTime(), nearRow.absolute_expires_at.getTime());
  });

  await test("ACC-FLOOR-1: a payment attempt left by an ended or expired session of the same employee and device is retried by the next session; a live, revoked or other employee's session goes to review", async () => {
    const terminal = await device("Cobro pendiente");
    const cookieFor = (c: { id: string; token: string }) => ({
      gm_device: sign(terminal),
      gm_session: sign({ id: c.id, tenantId, token: c.token }),
    });
    const newSession = async (employeeId = cashierId) => {
      const created = await run((tx) =>
        createSession(tx, { employeeId, deviceId: terminal.id }),
      );
      return {
        ...created,
        session: (await authenticate(cookieFor(created))).session,
      };
    };
    const original = await newSession();
    const drawerId = randomUUID();
    await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
      values(${tenantId},${drawerId},${terminal.id},${cashierId},0,now())`;
    const order = await run((tx) =>
      createOrder(tx, original.session, {
        operationId: randomUUID(),
        lines: [
          { id: randomUUID(), productId, quantity: 2, options: [], note: "" },
        ],
        mode: "takeaway",
        tableId: null,
        name: "Cobro pendiente",
        note: "",
        channel: "pos",
      }),
    );
    const attempt = (sessionId: string, employeeId = cashierId) => ({
      formatVersion: 1 as const,
      tenantId,
      employeeId,
      deviceId: terminal.id,
      sessionId,
      cashSessionId: drawerId,
      orderId: order.id,
      createdAt: new Date().toISOString(),
      payload: {
        operationId: randomUUID(),
        amount: 100,
        tip: 0,
        received: 100,
        method: "cash" as const,
        externalConfirmed: false,
        reference: "",
      },
    });
    const status = (s: Session, a: ReturnType<typeof attempt>) =>
      run((tx) => paymentRecoveryStatus(tx, s, a));
    const next = await newSession();
    // The original session is still live: another session may not retry it.
    const pending = attempt(original.id);
    assert.equal((await status(next.session, pending)).retryAllowed, false);
    // Ended normally (logout, renewal, PIN after session_ended): retried once.
    await run((tx) => endSession(tx, original.id, "logout"));
    assert.equal((await status(next.session, pending)).retryAllowed, true);
    const paid = await run((tx) =>
      retryPaymentRecovery(tx, next.session, pending),
    );
    assert.equal(paid.paid, 100);
    assert.equal((await status(next.session, pending)).state, "committed");
    // Expired at the absolute cap without an end: also the same line.
    const expired = await newSession();
    await admin`update sessions set expires_at=now()-interval '1 second' where id=${expired.id}`;
    assert.equal((await status(next.session, attempt(expired.id))).retryAllowed, true);
    // Revoked (deactivation or unpaired device): review only.
    const revoked = await newSession();
    await run((tx) => endSession(tx, revoked.id, "employee_deactivated", true));
    await rejects(
      run((tx) => retryPaymentRecovery(tx, next.session, attempt(revoked.id))),
      "payment_review_required",
    );
    // Another employee on the same device never retries a cashier's attempt.
    const manager = await newSession(managerId);
    const ended = await newSession();
    await run((tx) => endSession(tx, ended.id, "switched"));
    assert.equal((await status(manager.session, attempt(ended.id))).retryAllowed, false);
  });

  await test("ACC-R-5: a void approval needs an open order with an unpaid unit before any PIN is checked", async () => {
    await clearThrottles(managerId);
    const terminal = await device("Aprobación de anulación");
    const signedIn = await pin(terminal, cashierId, CASHIER_PIN);
    const { session } = await authenticate({
      gm_device: sign(terminal),
      gm_session: signedIn.cookie,
    });
    await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
      values(${tenantId},${randomUUID()},${terminal.id},${cashierId},0,now())`;
    // Dine-in at a table: at balance zero the check stays "paid" (service 024),
    // so the fully paid order still reaches the unpaid-units rule instead of
    // check_closed (a paid takeaway check closes).
    const tableId = randomUUID();
    await admin`insert into dining_tables(tenant_id,id,name) values(${tenantId},${tableId},'Mesa anulación')`;
    const newOrder = (table: string | null = null) =>
      run((tx) =>
        createOrder(tx, session, {
          operationId: randomUUID(),
          lines: [
            { id: randomUUID(), productId, quantity: 1, options: [], note: "" },
          ],
          mode: table ? "dine_in" : "takeaway",
          tableId: table,
          name: "Anulación",
          note: "",
          channel: "pos",
        }),
      );
    const wrong = { employeeId: managerId, secret: "000000" };
    const failures = async () =>
      (await admin`select failed_attempts from employees where id=${managerId}`)[0]
        .failed_attempts;
    // An open order with an unpaid unit: the PIN is checked and a wrong one counts.
    const open = await newOrder(tableId);
    await rejects(verifyApproval(sql, session, wrong, open.id), "approval_denied");
    assert.equal(await failures(), 1);
    // Fully paid: refused before the PIN, which is neither checked nor counted.
    await run((tx) =>
      recordPayment(tx, session, open.id, {
        operationId: randomUUID(),
        amount: 100,
        tip: 0,
        received: 100,
        method: "cash",
        externalConfirmed: false,
        reference: "",
      }),
    );
    await rejects(verifyApproval(sql, session, wrong, open.id), "void_exceeds_unpaid");
    await rejects(
      verifyApproval(sql, session, { employeeId: managerId, secret: MANAGER_PIN }, open.id),
      "void_exceeds_unpaid",
    );
    // Closed (here cancelled): refused before the PIN as well, with the code
    // voidLines gives it (assertCheckWritable: check_closed since service 024).
    const closed = await newOrder();
    await admin`update orders set state='cancelled' where id=${closed.id}`;
    await rejects(verifyApproval(sql, session, wrong, closed.id), "check_closed");
    assert.equal(await failures(), 1);
    // The right PIN on an order that can still be voided approves.
    const voidable = await newOrder();
    assert.equal(
      await verifyApproval(sql, session, { employeeId: managerId, secret: MANAGER_PIN }, voidable.id),
      managerId,
    );
    await clearThrottles(managerId);
  });

  await test("ACC-R6-1: a lost-response retry of a void that cancelled the order or voided its last unpaid unit returns the stored result, once", async () => {
    await clearThrottles(managerId);
    const terminal = await device("Reintento de anulación");
    const signedIn = await pin(terminal, cashierId, CASHIER_PIN);
    const { session } = await authenticate({
      gm_device: sign(terminal),
      gm_session: signedIn.cookie,
    });
    await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
      values(${tenantId},${randomUUID()},${terminal.id},${cashierId},0,now())`;
    // The split case is dine-in at a table so its check stays "paid" at
    // balance zero and a further void reaches the unpaid-units rule (service 024).
    const tableId = randomUUID();
    await admin`insert into dining_tables(tenant_id,id,name) values(${tenantId},${tableId},'Mesa reintento')`;
    const newOrder = (quantity: number, table: string | null = null) =>
      run((tx) =>
        createOrder(tx, session, {
          operationId: randomUUID(),
          lines: [
            { id: randomUUID(), productId, quantity, options: [], note: "" },
          ],
          mode: table ? "dine_in" : "takeaway",
          tableId: table,
          name: "Reintento",
          note: "",
          channel: "pos",
        }),
      );
    const approval = { employeeId: managerId, secret: MANAGER_PIN };
    const body = (o: { id: string; version: number; lines: { id: string }[] }, quantity: number) => ({
      operationId: randomUUID(),
      expectedVersion: o.version,
      lines: [{ lineId: o.lines[0].id, quantity }],
      reason: "Cliente se fue",
      stockDisposition: "no_return",
      approval,
    });
    // Exactly what POST /api/orders/:id/voids does with one request body.
    const send = async (orderId: string, b: ReturnType<typeof body>) => {
      const approverId = await verifyApproval(sql, session, b.approval, orderId, b);
      return run((tx) => voidLines(tx, session, orderId, b, approverId));
    };
    const voidRows = async (orderId: string) =>
      (await admin`select count(*)::int as n from line_voids where order_id=${orderId}`)[0].n;

    // Every unit of a one-line order: the void cancels the order.
    const whole = await newOrder(1);
    const cancel = body(whole, 1);
    const first = await send(whole.id, cancel);
    assert.equal(first.state, "cancelled");
    // The replay is once()'s stored result, read back from jsonb.
    const stored = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    const replay = await send(whole.id, cancel);
    assert.deepEqual(replay, stored(first));
    assert.equal(await voidRows(whole.id), 1);
    // Only that exact void replays: a new void, or the same operationId with
    // another body, is still refused by the order check before the PIN
    // (the fully voided check is closed: check_closed since service 024).
    await rejects(send(whole.id, body(whole, 1)), "check_closed");
    await rejects(send(whole.id, { ...cancel, reason: "Otro motivo" }), "check_closed");

    // The last unpaid unit while the other unit is paid.
    const split = await newOrder(2, tableId);
    const paid = await run((tx) =>
      recordPayment(tx, session, split.id, {
        operationId: randomUUID(),
        amount: 100,
        tip: 0,
        received: 100,
        method: "cash",
        externalConfirmed: false,
        reference: "",
      }),
    );
    const last = body(paid, 1);
    const voided = await send(split.id, last);
    assert.equal(voided.total, voided.paid);
    assert.equal(
      voided.paymentUnits!.some((u) => u.paid === 0),
      false,
    );
    assert.deepEqual(await send(split.id, last), stored(voided));
    assert.equal(await voidRows(split.id), 1);
    await rejects(send(split.id, body(voided, 1)), "void_exceeds_unpaid");
    await clearThrottles(managerId);
  });

  await test("OFF-7 regression: logout ends without revoking and the same employee's new session on the same device syncs the queued sale", async () => {
    const terminal = await device("Cambio de turno");
    const first = await pin(terminal, cashierId, CASHIER_PIN);
    const drawerId = randomUUID();
    await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
      values(${tenantId},${drawerId},${terminal.id},${cashierId},0,now()-interval '1 minute')`;
    const sale = offlineSale(first.sessionId, drawerId, new Date());
    await signOut(
      sql,
      req({ gm_session: first.cookie, gm_device: sign(terminal) }),
      stubRes() as any,
    );
    const ended = await sessionRow(first.sessionId);
    assert.equal(ended.end_reason, "logout");
    assert.equal(ended.revoked, false);
    const second = await pin(terminal, cashierId, CASHIER_PIN, first.cookie);
    assert.notEqual(second.sessionId, first.sessionId);
    const { session } = await authenticate({
      gm_device: sign(terminal),
      gm_session: second.cookie,
    });
    const synced = await run((tx) => synchronizeOffline(tx, session, sale));
    assert.equal(synced.total, 100);
    // Logout is idempotent and never fails without a session.
    await signOut(sql, req({}), stubRes() as any);
    await signOut(sql, req({ gm_session: "garbage" }), stubRes() as any);
  });

  await test("ACC-FLOOR-5: a remembered logout names its session and never ends the session signed in since", async () => {
    const terminal = await device("Salida pendiente");
    const a = await pin(terminal, cashierId, CASHIER_PIN);
    // Cashier A left offline; manager B signs in by PIN before it is finished.
    const b = await pin(terminal, managerId, MANAGER_PIN, a.cookie);
    assert.equal((await sessionRow(a.sessionId)).end_reason, "switched");
    const late = stubRes();
    await signOut(
      sql,
      req({ gm_session: b.cookie, gm_device: sign(terminal) }, { sessionId: a.sessionId }),
      late as any,
    );
    const kept = await sessionRow(b.sessionId);
    assert.equal(kept.ended_at, null);
    assert.deepEqual(late.cleared, [], "B's cookie stays");
    // The same request naming the cookie's own session ends it as before.
    const own = stubRes();
    await signOut(
      sql,
      req({ gm_session: b.cookie, gm_device: sign(terminal) }, { sessionId: b.sessionId }),
      own as any,
    );
    assert.equal((await sessionRow(b.sessionId)).end_reason, "logout");
    assert.deepEqual(own.cleared, ["gm_session"]);
    // An unusable body is ignored rather than refused: logout always succeeds.
    await signOut(sql, req({}, { sessionId: "not-a-uuid" }), stubRes() as any);
  });

  await test("OFF-7: name edit keeps sessions; role change and PIN reset end without revoking; deactivation revokes", async () => {
    const terminal = await device("Ciclo de vida");
    const staff = await run((tx) =>
      createStaff(tx, owner, {
        operationId: randomUUID(),
        name: "Ciclo",
        role: "cashier",
        pin: "424242",
      }),
    );
    const s1 = await pin(terminal, staff.id, "424242");
    await run((tx) =>
      updateStaff(tx, owner, staff.id, {
        operationId: randomUUID(),
        name: "Ciclo renombrado",
        role: "cashier",
      }),
    );
    assert.equal((await sessionRow(s1.sessionId)).ended_at, null);
    await run((tx) =>
      updateStaff(tx, owner, staff.id, {
        operationId: randomUUID(),
        name: "Ciclo renombrado",
        role: "server",
      }),
    );
    let row = await sessionRow(s1.sessionId);
    assert.equal(row.end_reason, "role_changed");
    assert.equal(row.revoked, false);
    const s2 = await pin(terminal, staff.id, "424242");
    await run((tx) =>
      resetStaffPin(tx, owner, staff.id, {
        operationId: randomUUID(),
        pin: "434343",
      }),
    );
    row = await sessionRow(s2.sessionId);
    assert.equal(row.end_reason, "pin_reset");
    assert.equal(row.revoked, false);
    const s3 = await pin(terminal, staff.id, "434343");
    await run((tx) =>
      setStaffActive(tx, owner, staff.id, {
        operationId: randomUUID(),
        active: false,
      }),
    );
    row = await sessionRow(s3.sessionId);
    assert.equal(row.end_reason, "employee_deactivated");
    assert.equal(row.revoked, true);
    // Sessions that had already ended normally are revoked too.
    assert.equal((await sessionRow(s1.sessionId)).revoked, true);
    await rejects(pin(terminal, staff.id, "434343"), "employee_unavailable");
    const [e] =
      await admin`select active,deactivated_at is not null as stamped,free_slot from employees where id=${staff.id}`;
    assert.deepEqual(e, { active: false, stamped: true, free_slot: null });
    await run((tx) =>
      setStaffActive(tx, owner, staff.id, {
        operationId: randomUUID(),
        active: true,
      }),
    );
    const [back] =
      await admin`select active,deactivated_at from employees where id=${staff.id}`;
    assert.deepEqual(back, { active: true, deactivated_at: null });
  });

  await test("SEC-5: revoking a device revokes its sessions, clears its Free slot and blocks authentication", async () => {
    const terminal = await device("Robada");
    await admin`update devices set free_slot=null where tenant_id=${tenantId}`;
    const s = await pin(terminal, cashierId, CASHIER_PIN);
    const [slot] = await admin`select free_slot from devices where id=${terminal.id}`;
    assert.equal(slot.free_slot, 1);
    await run((tx) =>
      revokeDevice(tx, owner, terminal.id, { operationId: randomUUID() }),
    );
    const [d] =
      await admin`select active,free_slot,revoked_reason,revoked_by from devices where id=${terminal.id}`;
    assert.deepEqual(d, {
      active: false,
      free_slot: null,
      revoked_reason: "revoked",
      revoked_by: ownerId,
    });
    const row = await sessionRow(s.sessionId);
    assert.equal(row.revoked, true);
    assert.equal(row.end_reason, "device_revoked");
    await rejects(
      authenticate({ gm_device: sign(terminal), gm_session: s.cookie }),
      "device_revoked",
    );
    await rejects(pin(terminal, cashierId, CASHIER_PIN), "device_revoked");
    // Open drawers need an explicit acknowledgement.
    const drawerDevice = await device("Con caja");
    await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${randomUUID()},${drawerDevice.id},${cashierId},0)`;
    await rejects(
      run((tx) =>
        revokeDevice(tx, owner, drawerDevice.id, { operationId: randomUUID() }),
      ),
      "open_drawer_ack_required",
    );
    await run((tx) =>
      revokeDevice(tx, owner, drawerDevice.id, {
        operationId: randomUUID(),
        acknowledgeOpenDrawer: true,
      }),
    );
    // Managers cannot revoke personal devices.
    const personal = await device("Owner browser", { kind: "personal" });
    await rejects(
      run((tx) =>
        revokeDevice(tx, as(managerId, "manager", terminalA.id), personal.id, {
          operationId: randomUUID(),
        }),
      ),
      "forbidden",
    );
  });

  await test("SEC-5: an expired device token blocks authentication; PIN sign-in renews token_expires_at", async () => {
    const terminal = await device("Vence", { expiresInHours: 24 });
    const s = await pin(terminal, cashierId, CASHIER_PIN);
    const [renewed] =
      await admin`select token_expires_at>now()+interval '29 days' as renewed from devices where id=${terminal.id}`;
    assert.equal(renewed.renewed, true);
    await admin`update devices set token_expires_at=now()-interval '1 minute' where id=${terminal.id}`;
    await rejects(
      authenticate({ gm_device: sign(terminal), gm_session: s.cookie }),
      "device_revoked",
    );
    await rejects(pin(terminal, cashierId, CASHIER_PIN), "device_revoked");
    await rejects(
      legacyLogin(
        sql,
        req({ gm_device: sign(terminal) }, {
          tenantId,
          login: `cash-${cashierId.slice(0, 8)}`,
          secret: CASHIER_PIN,
        }),
        stubRes() as any,
      ),
      "device_revoked",
    );
  });

  await test("SEC-3: only owners create/edit/deactivate/reset; managers unlock; self-disable, owner deactivation and owner assignment are refused", async () => {
    const manager = as(managerId, "manager", terminalA.id);
    await rejects(
      run((tx) =>
        createStaff(tx, manager, {
          operationId: randomUUID(),
          name: "No",
          role: "cashier",
          pin: "123123",
        }),
      ),
      "forbidden",
    );
    for (const [path, body] of [
      [updateStaff, { operationId: randomUUID(), name: "X", role: "cashier" }],
      [setStaffActive, { operationId: randomUUID(), active: false }],
      [resetStaffPin, { operationId: randomUUID(), pin: "123123" }],
    ] as const)
      await rejects(
        run((tx) => (path as any)(tx, manager, cashierId, body)),
        "forbidden",
      );
    await run((tx) =>
      unlockStaff(tx, manager, cashierId, { operationId: randomUUID() }),
    );
    await rejects(
      run((tx) =>
        unlockStaff(tx, as(cashierId, "cashier", terminalA.id), managerId, {
          operationId: randomUUID(),
        }),
      ),
      "forbidden",
    );
    await rejects(
      run((tx) =>
        setStaffActive(tx, owner, ownerId, {
          operationId: randomUUID(),
          active: false,
        }),
      ),
      "self_disable",
    );
    await rejects(
      run((tx) =>
        setStaffActive(tx, owner, secondOwnerId, {
          operationId: randomUUID(),
          active: false,
        }),
      ),
      "owner_cannot_be_deactivated",
    );
    await rejects(
      run((tx) =>
        updateStaff(tx, owner, cashierId, {
          operationId: randomUUID(),
          name: "Cajero",
          role: "owner",
        }),
      ),
      "owner_role_locked",
    );
    await rejects(
      run((tx) =>
        updateStaff(tx, owner, secondOwnerId, {
          operationId: randomUUID(),
          name: "Dueño",
          role: "manager",
        }),
      ),
      "owner_role_locked",
    );
    await rejects(
      run((tx) =>
        updateStaff(tx, owner, ownerId, {
          operationId: randomUUID(),
          name: "Yo",
          role: "manager",
        }),
      ),
      "self_role_change",
    );
    await rejects(
      run((tx) =>
        resetStaffPin(tx, owner, cashierId, {
          operationId: randomUUID(),
          pin: "12ab56",
        }),
      ),
      "pin_invalid_format",
    );
    await rejects(
      run((tx) =>
        updateStaff(tx, owner, randomUUID(), {
          operationId: randomUUID(),
          name: "Nadie",
          role: "cashier",
        }),
      ),
      "employee_not_found",
    );
    // On a terminal, staff commands need a fresh PIN (step-up).
    await rejects(
      run((tx) =>
        createStaff(
          tx,
          as(ownerId, "owner", terminalA.id, {
            authenticatedAt: new Date(Date.now() - 3600_000).toISOString(),
          }),
          {
            operationId: randomUUID(),
            name: "Tarde",
            role: "cashier",
            pin: "123123",
          },
        ),
      ),
      "step_up_required",
    );
  });

  await test("createStaff generates unique logins and never stores the PIN in operations", async () => {
    const pins = ["987123", "987456"];
    const ops = [randomUUID(), randomUUID()];
    const rows = [];
    for (let i = 0; i < 2; i++)
      rows.push(
        await run((tx) =>
          createStaff(tx, owner, {
            operationId: ops[i],
            name: "María José Núñez",
            role: "cashier",
            pin: pins[i],
          }),
        ),
      );
    const logins = rows.map((r) => r.login);
    assert.equal(logins[0].startsWith("maria-jose-nunez"), true);
    assert.notEqual(logins[0], logins[1]);
    assert.match(logins[1], /^maria-jose-nunez(-\d+)?-\d+$/);
    const replay = await run((tx) =>
      createStaff(tx, owner, {
        operationId: ops[0],
        name: "María José Núñez",
        role: "cashier",
        pin: pins[0],
      }),
    );
    assert.equal(replay.id, rows[0].id);
    for (const [i, op] of ops.entries()) {
      const [row] =
        await admin`select hash,result::text as result from operations where id=${op}`;
      assert.equal(row.result.includes(pins[i]), false);
      // No "pin" key (the access kind value "pin" is fine).
      assert.doesNotMatch(row.result, /"pin"\s*:/);
      assert.notEqual(row.hash, hash(JSON.stringify({ pin: pins[i] })));
    }
    const [audit] =
      await admin`select count(*)::int as n from audit where tenant_id=${tenantId} and (detail::text like ${"%" + pins[0] + "%"} or detail::text like ${"%" + pins[1] + "%"})`;
    assert.equal(audit.n, 0);
    await rejects(
      run((tx) =>
        createStaff(tx, owner, {
          operationId: randomUUID(),
          name: "Duplicado",
          role: "cashier",
          pin: "555666",
          login: logins[0],
        }),
      ),
      "login_taken",
    );
    const account = await run((tx) =>
      createStaff(tx, owner, {
        operationId: randomUUID(),
        name: "Account Test",
        role: "kitchen",
        pin: "555777",
      }),
    );
    assert.equal(account.login.startsWith("account-"), false);
    for (const r of [...rows, account])
      await run((tx) =>
        setStaffActive(tx, owner, r.id, {
          operationId: randomUUID(),
          active: false,
        }),
      );
  });

  await test("invited Google employee deactivation blocks enterOwnerRestaurant", async () => {
    const identity = {
      issuer: "https://accounts.google.com",
      subject: randomUUID(),
      email: "invited-member@example.com",
      name: "Invited fixture",
    };
    const cookie = await signInGoogleOwner(sql, identity);
    const account = await withOwner(sql, cookie, undefined, async (_tx, a) => a);
    accountIds.push(account.id);
    const memberId = randomUUID();
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role)
      values(${tenantId},${memberId},'Invited fixture',${"account-" + account.id},${password(randomUUID())},'manager')`;
    await admin`insert into owner_memberships(account_id,tenant_id,employee_id) values(${account.id},${tenantId},${memberId})`;
    const entered = await withOwner(sql, cookie, undefined, (tx, a) =>
      enterOwnerRestaurant(tx, a.id, tenantId, a.sessionId, ownerBrowserCookie()),
    );
    const [personal] =
      await admin`select kind,paired_by from devices where id=${entered.device.id}`;
    assert.deepEqual(personal, { kind: "personal", paired_by: memberId });
    const [ownerSession] =
      await admin`select s.absolute_expires_at<=o.expires_at
          and o.expires_at-s.absolute_expires_at<interval '1 millisecond' as capped
        from sessions s join owner_sessions o on o.id=s.owner_session_id where s.id=${entered.session.id}`;
    assert.equal(ownerSession.capped, true);
    await run((tx) =>
      setStaffActive(tx, owner, memberId, {
        operationId: randomUUID(),
        active: false,
      }),
    );
    assert.equal((await sessionRow(entered.session.id)).revoked, true);
    // The Google sign-in that entered the member's own device ends with that
    // device (ACC-R6-2); a new Google sign-in is refused: the member is inactive.
    await rejects(
      withOwner(sql, cookie, undefined, (tx, a) =>
        enterOwnerRestaurant(tx, a.id, tenantId, a.sessionId, ownerBrowserCookie()),
      ),
      "unauthorized",
    );
    const again = await signInGoogleOwner(sql, identity);
    await rejects(
      withOwner(sql, again, undefined, (tx, a) =>
        enterOwnerRestaurant(tx, a.id, tenantId, a.sessionId, ownerBrowserCookie()),
      ),
      "forbidden",
    );
  });

  await test("ACC-R6-2: deactivation unpairs the member's personal device, which then loads no roster and signs no colleague in by PIN; terminals they paired stay paired and are listed; the legacy team save does the same", async () => {
    const cookie = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject: randomUUID(),
      email: "fired-member@example.com",
      name: "Fired fixture",
    });
    const account = await withOwner(sql, cookie, undefined, async (_tx, a) => a);
    accountIds.push(account.id);
    const memberId = randomUUID();
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role)
      values(${tenantId},${memberId},'Fired fixture',${"account-" + account.id},${password(randomUUID())},'manager')`;
    await admin`insert into owner_memberships(account_id,tenant_id,employee_id) values(${account.id},${tenantId},${memberId})`;
    const enter = () =>
      withOwner(sql, cookie, undefined, (tx, a) =>
        enterOwnerRestaurant(tx, a.id, tenantId, a.sessionId, ownerBrowserCookie()),
      );
    const entered = await enter();
    const phone = entered.device;
    // A terminal the member paired with a code (redeem records the code's creator).
    const tablet = await device("Caja del responsable");
    await admin`update devices set paired_by=${memberId} where id=${tablet.id}`;
    const gate = (c: Cookie) =>
      terminalState(sql, req({ gm_device: sign(c) }), stubRes() as any);
    const member = async () =>
      (await run((tx) => listStaff(tx, owner))).find((r) => r.id === memberId)!;

    // Before: the member's phone shows the roster and signs a colleague in.
    assert.equal((await gate(phone)).paired, true);
    const colleague = await pin(phone, cashierId, CASHIER_PIN);
    const listed = await member();
    assert.deepEqual(
      listed.pairedDevices.map((d) => `${d.kind}:${d.id}`).sort(),
      [`personal:${phone.id}`, `terminal:${tablet.id}`].sort(),
    );

    await run((tx) =>
      setStaffActive(tx, owner, memberId, { operationId: randomUUID(), active: false }),
    );
    const [retired] = await admin`select active,revoked_reason,revoked_by,
        revoked_at is not null as stamped,free_slot from devices where id=${phone.id}`;
    assert.deepEqual(retired, {
      active: false,
      revoked_reason: "revoked",
      revoked_by: ownerId,
      stamped: true,
      free_slot: null,
    });
    // The colleague's session on that phone is revoked; the phone is unpaired.
    assert.equal((await sessionRow(colleague.sessionId)).revoked, true);
    await rejects(
      authenticate({ gm_device: sign(phone), gm_session: colleague.cookie }),
      "device_revoked",
    );
    const after = await gate(phone);
    assert.equal(after.paired, false);
    assert.equal(after.staff, undefined);
    await rejects(pin(phone, cashierId, CASHIER_PIN), "device_revoked");
    await rejects(pin(phone, managerId, MANAGER_PIN), "device_revoked");
    // The Google sign-in that entered it is over as well.
    await rejects(enter(), "unauthorized");
    const [audited] = await admin`select detail from audit
      where entity_id=${phone.id} and operation='access.device_revoked'`;
    assert.equal(audited.detail.reason, "employee_deactivated");
    assert.equal(audited.detail.employeeId, memberId);
    const [offboarded] = await admin`select detail from audit
      where entity_id=${memberId} and operation='access.employee_deactivated'`;
    assert.equal(offboarded.detail.personalDevices, 1);
    // The terminal they paired keeps working and stays listed for review.
    assert.equal((await gate(tablet)).paired, true);
    const onTablet = await pin(tablet, cashierId, CASHIER_PIN);
    assert.equal(onTablet.reused, false);
    assert.deepEqual(
      (await member()).pairedDevices.map((d) => d.id),
      [tablet.id],
    );

    // The legacy team save retires a deactivated employee's personal device too.
    const legacyId = randomUUID();
    const legacy = {
      id: legacyId,
      name: "Legacy personal fixture",
      login: `legacy-p-${legacyId.slice(0, 8)}`,
      role: "cashier",
      secret: "864209",
    };
    const ownerOnTerminal = as(ownerId, "owner", terminalA.id, {});
    await run((tx) =>
      saveEmployee(tx, ownerOnTerminal, {
        operationId: randomUUID(),
        ...legacy,
        active: true,
      }),
    );
    const laptop = await device("Owner browser", { kind: "personal" });
    await admin`update devices set paired_by=${legacyId} where id=${laptop.id}`;
    assert.equal((await gate(laptop)).paired, true);
    await run((tx) =>
      saveEmployee(tx, ownerOnTerminal, {
        operationId: randomUUID(),
        ...legacy,
        active: false,
      }),
    );
    assert.equal((await gate(laptop)).paired, false);
    await rejects(pin(laptop, cashierId, CASHIER_PIN), "device_revoked");
  });

  await test("revoked personal device: its Google sign-ins end, an older sign-in cannot pair the browser again, a new one gets a fresh owner-browser mapping (A6)", async () => {
    const identity = {
      issuer: "https://accounts.google.com",
      subject: randomUUID(),
      email: "owner-browser@example.com",
      name: "Owner browser fixture",
    };
    const cookie = await signInGoogleOwner(sql, identity);
    // A second sign-in of the same Google account from before the revocation
    // that never entered this device (a fresher gm_account in that browser).
    const older = await signInGoogleOwner(sql, identity);
    const account = await withOwner(sql, cookie, undefined, async (_tx, a) => a);
    accountIds.push(account.id);
    await admin`insert into owner_memberships(account_id,tenant_id,employee_id) values(${account.id},${tenantId},${secondOwnerId})`;
    const browser = ownerBrowserCookie();
    const enter = (
      c: string,
      b: ReturnType<typeof ownerBrowserCookie>,
    ) =>
      withOwner(sql, c, undefined, (tx, a) =>
        enterOwnerRestaurant(tx, a.id, tenantId, a.sessionId, b),
      );
    const first = await enter(cookie, browser);
    const again = await enter(cookie, browser);
    assert.equal(again.device.id, first.device.id);
    const revoked = await run((tx) =>
      revokeDevice(tx, owner, first.device.id, { operationId: randomUUID() }),
    );
    assert.equal(revoked.status, "revoked");
    // The Google sign-in that entered the stolen device is over.
    await rejects(enter(cookie, browser), "unauthorized");
    await rejects(enter(cookie, ownerBrowserCookie()), "unauthorized");
    const [audited] =
      await admin`select detail->>'ownerSessions' as n from audit where entity_id=${first.device.id} and operation='access.device_revoked'`;
    assert.equal(audited.n, "1");
    // A sign-in from before the revocation cannot replace the device.
    await rejects(enter(older, browser), "owner_reauth_required");
    // A new Google sign-in may: the stale mapping is reset, then a new device.
    const renewed = await signInGoogleOwner(sql, identity);
    await rejects(enter(renewed, browser), "owner_browser_reset");
    const laptop = ownerBrowserCookie();
    const fresh = await enter(renewed, laptop);
    assert.notEqual(fresh.device.id, first.device.id);
    const [d] = await admin`select kind,active from devices where id=${fresh.device.id}`;
    assert.deepEqual(d, { kind: "personal", active: true });
    // An expired (not revoked) device still resets without a new sign-in.
    await admin`update devices set token_expires_at=now()-interval '1 minute' where id=${fresh.device.id}`;
    await rejects(enter(older, laptop), "owner_browser_reset");
  });

  await test("legacy rows: NULL kind infers personal for 'Owner browser'; NULL token_expires_at is valid", async () => {
    const personal = await device("Owner browser", {
      kind: null,
      expiresInHours: null,
    });
    const terminal = await device("POS", { kind: null, expiresInHours: null });
    assert.equal((await run((tx) => loadDevice(tx, personal)))?.kind, "personal");
    assert.equal((await run((tx) => loadDevice(tx, terminal)))?.kind, "terminal");
    assert.equal(await isTerminalRequest(sql, { gm_device: sign(personal) }), false);
    assert.equal(await isTerminalRequest(sql, { gm_device: sign(terminal) }), true);
    assert.equal(await isTerminalRequest(sql, {}), false);
    assert.equal(await isTerminalRequest(sql, { gm_device: "forged.value" }), false);
    // The GAP-2 guards fail closed: a failed device lookup throws (refusal)
    // instead of answering "not a terminal" (A3).
    const down = {
      begin: () => Promise.reject(new Error("database unavailable")),
    } as unknown as postgres.Sql;
    assert.equal(await isTerminalRequest(down, { gm_device: sign(terminal) }), false);
    await rejects(
      isTerminalRequest(down, { gm_device: sign(terminal) }, true),
      /database unavailable/,
    );
    const s = await pin(terminal, cashierId, CASHIER_PIN);
    const { session } = await authenticate({
      gm_device: sign(terminal),
      gm_session: s.cookie,
    });
    assert.equal(session.access?.deviceKind, "terminal");
    const [stamped] =
      await admin`select token_expires_at is not null as stamped from devices where id=${terminal.id}`;
    assert.equal(stamped.stamped, true);
  });

  await test("PIN sign-in reuses the same employee's live session and switches between employees", async () => {
    const terminal = await device("Reuso");
    const first = await pin(terminal, cashierId, CASHIER_PIN);
    const same = await pin(terminal, cashierId, CASHIER_PIN, first.cookie);
    assert.equal(same.reused, true);
    assert.equal(same.sessionId, first.sessionId);
    assert.equal(same.res.cookies.has("gm_session"), false);
    const other = await pin(terminal, managerId, MANAGER_PIN, first.cookie);
    assert.equal(other.reused, false);
    assert.equal((await sessionRow(first.sessionId)).end_reason, "switched");
    // Too close to the absolute cap: a new session replaces the old one.
    await admin`update sessions set absolute_expires_at=now()+interval '20 minutes',expires_at=now()+interval '20 minutes' where id=${other.sessionId}`;
    const renewed = await pin(terminal, managerId, MANAGER_PIN, other.cookie);
    assert.equal(renewed.reused, false);
    assert.equal((await sessionRow(other.sessionId)).end_reason, "replaced");
    assert.equal(parseSigned(renewed.cookie).id, renewed.sessionId);
  });

  await test("SEC-6: the legacy team save needs a recent PIN on terminals and keys its PIN fingerprint", async () => {
    const employeeId = randomUUID();
    const secret = "975310";
    const body = (operationId: string, active = true) => ({
      operationId,
      id: employeeId,
      name: "Legacy fixture",
      login: `legacy-${employeeId.slice(0, 8)}`,
      role: "cashier",
      secret,
      active,
    });
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const stale = as(ownerId, "owner", terminalA.id, { authenticatedAt: hourAgo });
    await rejects(
      run((tx) => saveEmployee(tx, stale, body(randomUUID()))),
      "step_up_required",
    );
    const [absent] =
      await admin`select count(*)::int as n from employees where id=${employeeId}`;
    assert.equal(absent.n, 0);
    const op = randomUUID();
    await run((tx) => saveEmployee(tx, as(ownerId, "owner", terminalA.id, {}), body(op)));
    const [created] =
      await admin`select pin_set_at is not null as pin from employees where id=${employeeId}`;
    assert.equal(created.pin, true);
    // operations.hash must not be a plain SHA-256 chain over a 6-digit PIN.
    const [row] = await admin`select hash,result::text as result from operations where id=${op}`;
    assert.notEqual(row.hash, hash(JSON.stringify({ ...body(op), secret: hash(secret) })));
    assert.equal(row.hash, hash(JSON.stringify({ ...body(op), secret: pinFingerprint(secret) })));
    assert.equal(row.result.includes(secret), false);
    // Google-entered sessions on a personal device are exempt from step-up,
    // as for the Equipo commands; a PIN session on that device is not (A4).
    const phone = await device("Owner browser", { kind: "personal" });
    await rejects(
      run((tx) =>
        saveEmployee(
          tx,
          as(ownerId, "owner", phone.id, {
            deviceKind: "personal",
            ownerAccount: false,
            authenticatedAt: hourAgo,
          }),
          body(randomUUID(), false),
        ),
      ),
      "step_up_required",
    );
    await run((tx) =>
      saveEmployee(
        tx,
        as(ownerId, "owner", phone.id, {
          deviceKind: "personal",
          ownerAccount: true,
          authenticatedAt: hourAgo,
        }),
        body(randomUUID(), false),
      ),
    );
    const [inactive] =
      await admin`select active from employees where id=${employeeId}`;
    assert.equal(inactive.active, false);
  });

  await test("decision 11: a Google-signup owner sets their own PIN on their phone, then appears on the terminal roster, signs in and steps up with it", async () => {
    const cookie = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject: randomUUID(),
      email: "signup-owner@example.com",
      name: "Signup owner fixture",
    });
    const account = await withOwner(sql, cookie, undefined, async (_tx, a) => a);
    accountIds.push(account.id);
    const signup = await withOwner(sql, cookie, account.csrf, (tx, a) =>
      createOwnerRestaurant(tx, a, {
        restaurantName: "Signup access fixture",
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
        openingDays: [1, 2, 3, 4, 5, 6, 7],
      }),
    );
    signupTenants.push(signup.tenantId);
    // The owner enters from their own phone (personal device, Google session).
    const entered = await withOwner(sql, cookie, undefined, (tx, a) =>
      enterOwnerRestaurant(tx, a.id, signup.tenantId, a.sessionId, ownerBrowserCookie()),
    );
    const phoneCookies = {
      gm_device: sign(entered.device),
      gm_session: sign(entered.session),
    };
    const phone = (await authenticate(phoneCookies)).session;
    assert.equal(phone.role, "owner");
    assert.equal(phone.access?.deviceKind, "personal");
    assert.equal(phone.access?.ownerAccount, true);
    const ownerEmployee = phone.employeeId;
    const [login] =
      await admin`select login,pin_set_at from employees where id=${ownerEmployee}`;
    assert.equal(login.login, `account-${account.id}`);
    assert.equal(login.pin_set_at, null);
    // A terminal paired with a code made on the phone.
    const code = await tenant(sql, signup.tenantId, (tx) =>
      createPairingCode(tx, phone, { deviceName: "Caja signup" }),
    );
    const terminal = (await redeemPairingCode(sql, { code: code.code }, null)).device;
    const roster = async () =>
      (
        await terminalState(sql, req({ gm_device: sign(terminal) }), stubRes() as any)
      ).staff ?? [];
    // 1. Without a PIN the Google owner is not on the terminal roster.
    assert.equal((await roster()).some((e) => e.id === ownerEmployee), false);
    // 2. "Mi PIN para terminales compartidas" from the phone keeps the phone session.
    const ownPin = "864213";
    const saved = await tenant(sql, signup.tenantId, (tx) =>
      resetStaffPin(tx, phone, ownerEmployee, {
        operationId: randomUUID(),
        pin: ownPin,
      }),
    );
    assert.equal(saved.access, "google_and_pin");
    const kept = await sessionRow(entered.session.id);
    assert.equal(kept.ended_at, null);
    assert.equal(kept.end_reason, null);
    assert.equal(kept.revoked, false);
    assert.equal((await authenticate(phoneCookies)).session.id, entered.session.id);
    // 3. The owner now appears on the roster and signs in by PIN on the terminal.
    assert.equal((await roster()).some((e) => e.id === ownerEmployee), true);
    const signedIn = await pin(terminal, ownerEmployee, ownPin);
    assert.equal(signedIn.reused, false);
    const terminalCookies = {
      gm_device: sign(terminal),
      gm_session: signedIn.cookie,
    };
    const onTerminal = (await authenticate(terminalCookies)).session;
    assert.equal(onTerminal.role, "owner");
    assert.equal(onTerminal.access?.deviceKind, "terminal");
    assert.equal(onTerminal.access?.ownerAccount, false);
    // The terminal sign-in does not end the phone session.
    assert.equal((await sessionRow(entered.session.id)).ended_at, null);
    // 4. Step-up on the terminal works with the same PIN.
    await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${onTerminal.id}`;
    const stale = (await authenticate(terminalCookies)).session;
    assert.throws(() => requireRecentAuth(stale), /step_up_required/);
    await rejects(stepUp(sql, stale, { secret: "000000" }), "invalid_pin");
    await stepUp(sql, stale, { secret: ownPin });
    const fresh = (await authenticate(terminalCookies)).session;
    requireRecentAuth(fresh);
    // 5. A4: the step-up and auto-lock exemption follows how the session was
    // entered. On the same personal device, the Google session never locks
    // and needs no step-up; a PIN session there gets both.
    const idleDefault = process.env.ACCESS_IDLE_LOCK_DEFAULT_SECONDS;
    process.env.ACCESS_IDLE_LOCK_DEFAULT_SECONDS = "180";
    try {
      await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${entered.session.id}`;
      const google = (await authenticate(phoneCookies)).session;
      assert.equal(google.access?.idleLockSeconds, null);
      requireRecentAuth(google);
      const pinOnPhone = await pin(entered.device, ownerEmployee, ownPin);
      const phonePinCookies = {
        gm_device: sign(entered.device),
        gm_session: pinOnPhone.cookie,
      };
      const pinSession = (await authenticate(phonePinCookies)).session;
      assert.equal(pinSession.access?.deviceKind, "personal");
      assert.equal(pinSession.access?.ownerAccount, false);
      assert.equal(pinSession.access?.idleLockSeconds, 180);
      await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${pinSession.id}`;
      const agedPin = (await authenticate(phonePinCookies)).session;
      assert.throws(() => requireRecentAuth(agedPin), /step_up_required/);
    } finally {
      if (idleDefault === undefined)
        delete process.env.ACCESS_IDLE_LOCK_DEFAULT_SECONDS;
      else process.env.ACCESS_IDLE_LOCK_DEFAULT_SECONDS = idleDefault;
    }
  });

  await test("an ended session is never revived: touch and PIN reuse re-check ended_at under the row lock", async () => {
    const terminal = await device("Carrera");
    // touchSession with a row read before a concurrent end.
    const touched = await pin(terminal, cashierId, CASHIER_PIN);
    const [before] = await admin`select s.*,e.role,l.selling_authorized as lease_selling from sessions s
      join employees e on e.id=s.employee_id left join offline_leases l on l.session_id=s.id where s.id=${touched.sessionId}`;
    await admin`update sessions set last_seen_at=now()-interval '2 minutes' where id=${touched.sessionId}`;
    await run((tx) => endSession(tx, touched.sessionId, "ended_by_manager"));
    await run((tx) => touchSession(tx, before as any, true));
    const afterTouch = await sessionRow(touched.sessionId);
    assert.ok(afterTouch.expires_at.getTime() <= Date.now());
    assert.equal(afterTouch.end_reason, "ended_by_manager");
    // PIN reuse racing a manager's end: the end commits while the reuse waits.
    const first = await pin(terminal, cashierId, CASHIER_PIN);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => (locked = resolve));
    // A second connection holds the row lock while admin observes the wait.
    const manager = postgres(migration, { max: 1 });
    let result: Awaited<ReturnType<typeof pin>>;
    try {
      const ending = manager.begin(async (tx) => {
        await tx`select id from sessions where id=${first.sessionId} for update`;
        locked();
        await held;
        await tx`update sessions set ended_at=now(),end_reason='ended_by_manager',
            expires_at=least(expires_at,now()) where id=${first.sessionId}`;
      });
      await rowLocked;
      const again = pin(terminal, cashierId, CASHIER_PIN, first.cookie);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [w] =
          await admin`select count(*)::int as n from pg_locks where not granted`;
        waiting = w.n > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      release();
      await ending;
      result = await again;
      assert.equal(waiting, true, "the PIN reuse must wait for the session row lock");
    } finally {
      release();
      await manager.end();
    }
    assert.equal(result.reused, false);
    assert.notEqual(result.sessionId, first.sessionId);
    const ended = await sessionRow(first.sessionId);
    assert.equal(ended.end_reason, "ended_by_manager");
    assert.ok(ended.expires_at.getTime() <= Date.now());
  });

  await test("migration 023 backfills legacy devices when applied by an owner without BYPASSRLS, and keeps FORCE RLS (OPS-R2/ACC-19)", async () => {
    // A scratch database owned by a role like a Neon owner: no superuser, no
    // BYPASSRLS. FORCE RLS applies to it, so an unwrapped backfill would
    // update no rows and leave legacy devices with no credential expiry.
    const suffix = randomBytes(4).toString("hex");
    const role = `gm_access_owner_${suffix}`,
      secret = randomBytes(16).toString("hex"),
      database = `green_monkey_access_mig_${suffix}_test`;
    const scratch = (asOwner: boolean) => {
      const u = new URL(migration);
      u.pathname = "/" + database;
      if (asOwner) {
        u.username = role;
        u.password = secret;
      }
      return u.href;
    };
    await admin.unsafe(
      `create role "${role}" login password '${secret}' nosuperuser nocreatedb nocreaterole nobypassrls`,
    );
    await admin.unsafe(`create database "${database}" owner "${role}"`);
    const owner = postgres(scratch(true), { max: 1, onnotice: () => {} }),
      inspector = postgres(scratch(false), { max: 1, onnotice: () => {} });
    try {
      const apply = (file: string) =>
        owner.begin((tx) => tx.unsafe(readFileSync(`migrations/${file}`, "utf8")));
      const files = readdirSync("migrations")
        .filter((n) => n.endsWith(".sql"))
        .sort();
      assert.ok(files.includes("023_access.sql"));
      for (const file of files.filter((n) => n < "023_access.sql"))
        await apply(file);
      const [who] = await owner`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      assert.deepEqual(
        { ...who },
        { rolsuper: false, rolbypassrls: false },
      );
      // Revision 022 rows in two tenants (the superuser inspector is exempt from RLS).
      const org = randomUUID(),
        tenants = [randomUUID(), randomUUID()];
      await inspector`insert into organizations(id,name) values(${org},'Backfill fixture')`;
      for (const [i, id] of tenants.entries())
        await inspector`insert into restaurants(id,organization_id,name) values(${id},${org},${"Backfill " + i})`;
      for (const [tenant, name, active] of [
        [tenants[0], "Owner browser", true],
        [tenants[0], "Caja 1", true],
        [tenants[1], "Caja 2", true],
        [tenants[1], "Caja vieja", false],
      ] as const)
        await inspector`insert into devices(tenant_id,id,name,token_hash,active)
          values(${tenant},${randomUUID()},${name},${"legacy-" + randomUUID()},${active})`;
      const [visible] = await owner`select count(*)::int as n from devices`;
      assert.equal(visible.n, 0, "FORCE RLS hides every device from the owner");
      await apply("023_access.sql");
      const rows = await inspector`
        select name, kind, token_expires_at from devices order by name`;
      assert.deepEqual(
        rows.map((r) => [r.name, r.kind, r.token_expires_at !== null]),
        [
          ["Caja 1", "terminal", true],
          ["Caja 2", "terminal", true],
          ["Caja vieja", "terminal", false],
          ["Owner browser", "personal", true],
        ],
      );
      for (const r of rows.filter((r) => r.token_expires_at))
        assert.ok(
          Math.abs(r.token_expires_at.getTime() - Date.now() - 30 * 86_400_000) <
            3_600_000,
          "active legacy devices get the 30-day credential expiry",
        );
      const [forced] = await inspector`
        select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.devices'::regclass`;
      assert.deepEqual(
        { ...forced },
        { relrowsecurity: true, relforcerowsecurity: true },
        "FORCE RLS is restored in the same migration",
      );
    } finally {
      await owner.end();
      await inspector.end();
      await admin.unsafe(`drop database if exists "${database}" with (force)`);
      await admin.unsafe(`drop role if exists "${role}"`);
    }
  });

  console.log(`${checks} access checks passed`);
} finally {
  // discounts (028): refunds and cash_sessions refuse DELETE for every role
  // (money records are never deleted, LD-15 Q4 (A)). This disposable-database
  // cleanup disables those named triggers inside the same transaction as the
  // deletes (LD-12 pattern, LD-16 L5 FK order), so no other session ever sees
  // them off and a failed cleanup rolls the switch back with the deletes.
  const moneyTriggers = [
    ["refund_units", "refund_units_immutable"],
    ["refund_lines", "refund_lines_no_delete"],
    ["refunds", "refunds_immutable"],
    ["refund_batches", "refund_batches_immutable"],
    ["discount_allocations", "discount_allocations_immutable"],
    ["discounts", "discounts_no_delete"],
    ["cash_count_reviews", "cash_count_reviews_immutable"],
    ["cash_sessions", "cash_sessions_closed_immutable"],
  ];
  await admin.begin(async (tx) => {
    for (const [table, trigger] of moneyTriggers)
      await tx.unsafe(`alter table ${table} disable trigger ${trigger}`);
    for (const id of [tenantId, otherTenantId, ...signupTenants]) {
      for (const table of [
        // discounts (028), in FK order before the wave-1 lists (LD-16 L5).
        "refund_units",
        "refund_lines",
        "refunds",
        "refund_batches",
        "discount_allocations",
        "discounts",
        "cash_count_reviews",
        // offline (026): OFF-3 and OFF-7 sync through offline's record path,
        // whose evidence rows reference orders, tenders, rounds, devices and
        // employees (contracts §5.2 rule 3: offline's tables go first).
        "offline_kitchen_reviews",
        "offline_sync_records",
        "offline_archives",
        "signup_billing_intents",
        "pin_throttles",
        "device_pairing_codes",
        "offline_lease_renewals",
        "line_voids",
        "tender_allocations",
        "tenders",
        "rounds",
        "order_lines",
        "jobs",
        "operations",
        "audit",
        "orders",
        "order_numbers",
        "cash_movements",
        "cash_sessions",
        "recipe_versions",
        // menu (025): the legacy product save now bumps menu_state and files
        // the product under a menu category.
        "menu_state",
        "menu_categories",
        "modifier_groups",
        "catalog",
        "offline_leases",
        "sessions",
        "owner_browser_devices",
        "devices",
        "owner_memberships",
        "employees",
        "restaurant_entitlements",
        "kitchen_feed_versions",
        "dining_tables",
        // menu (025): after dining_tables, which reference their area.
        "dining_areas",
      ])
        await tx.unsafe(`delete from ${table} where tenant_id=$1`, [id]);
      await tx`delete from restaurants where id=${id}`;
    }
    for (const [table, trigger] of moneyTriggers)
      await tx.unsafe(`alter table ${table} enable trigger ${trigger}`);
  });
  await admin`delete from organizations where id=${organizationId}`;
  for (const accountId of accountIds) {
    await admin`delete from organizations where created_by_account=${accountId}`;
    await admin`delete from owner_sessions where account_id=${accountId}`;
    await admin`delete from owner_accounts where id=${accountId}`;
  }
  await sql.end();
  await admin.end();
}
