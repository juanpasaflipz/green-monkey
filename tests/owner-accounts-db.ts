import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { connect, checkRole } from "../server/db.js";
import { authentication, sign } from "../server/auth.js";
import {
  signInGoogleOwner,
  withOwner,
  createOwnerRestaurant,
  enterOwnerRestaurant,
  ownerCookie,
  accountScope,
} from "../server/owner-accounts.js";

const { runtime, migration } = isolatedTarget(process.env);
const sql = connect(runtime),
  admin = postgres(migration, { max: 1 });
const subjects = [randomUUID(), randomUUID()];
const accountIds: string[] = [];
try {
  await checkRole(sql);
  const cookies = [];
  for (const subject of subjects) {
    const cookie = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject,
      email: "same-email@example.com",
      name: "Fictional test owner",
    });
    cookies.push(cookie);
    accountIds.push(ownerCookie(cookie).accountId);
  }
  assert.notEqual(
    accountIds[0],
    accountIds[1],
    "equal email does not merge identity",
  );
  const repeat = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: subjects[0],
    email: "changed@example.com",
    name: null,
  });
  assert.equal(
    ownerCookie(repeat).accountId,
    accountIds[0],
    "subject remains stable",
  );
  assert.equal((await sql`select * from owner_accounts`).length, 0);
  assert.equal((await sql`select * from owner_memberships`).length, 0);
  const a = await withOwner(sql, cookies[0], undefined, async (_tx, a) => a);
  await assert.rejects(
    withOwner(sql, cookies[0], "wrong", async () => true),
    /forbidden/,
  );
  const input = {
    restaurantName: "Fictional signup restaurant",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
    openingDays: [1, 2, 3, 4, 5, 6, 7],
  };
  const created = await Promise.all(
    Array.from({ length: 4 }, () =>
      withOwner(sql, cookies[0], a.csrf, (tx, account) =>
        createOwnerRestaurant(tx, account, input),
      ),
    ),
  );
  const tenantId = created[0].tenantId;
  assert.ok(created.every((x) => x.tenantId === tenantId));
  assert.equal(
    created.filter((x) => x.created).length,
    1,
    "concurrent signup creates only once",
  );
  await assert.rejects(
    withOwner(sql, cookies[1], undefined, (tx, account) =>
      enterOwnerRestaurant(tx, account.id, tenantId, account.sessionId),
    ),
    /forbidden/,
  );
  const bRestaurants = await accountScope(
    sql,
    accountIds[1],
    async (tx) => tx`select id from restaurants`,
  );
  assert.equal(bRestaurants.length, 0, "other account cannot read restaurant");
  const entry = await withOwner(sql, cookies[0], a.csrf, (tx, account) =>
    enterOwnerRestaurant(tx, account.id, tenantId, account.sessionId),
  );
  assert.equal(entry.session.tenantId, tenantId);
  const authenticate = () =>
    new Promise<void>((resolve, reject) => {
      void authentication(sql)(
        {
          method: "GET",
          cookies: {
            gm_session: sign(entry.session),
            gm_device: sign(entry.device),
          },
          headers: {},
        } as any,
        { clearCookie() {} } as any,
        (error?: unknown) => (error ? reject(error) : resolve()),
      );
    });
  await authenticate();
  // Google entry creates a personal device and a session capped by the owner session.
  const [entered] = await admin`select d.kind,
      s.absolute_expires_at<=o.expires_at and o.expires_at-s.absolute_expires_at<interval '1 millisecond' as capped
    from sessions s join devices d on d.tenant_id=s.tenant_id and d.id=s.device_id
    join owner_sessions o on o.id=s.owner_session_id where s.id=${entry.session.id}`;
  assert.deepEqual(entered, { kind: "personal", capped: true });
  const [counts] =
    await admin`select (select count(*)::int from employees where tenant_id=${tenantId}) as employees,(select count(*)::int from audit where tenant_id=${tenantId}) as audit,(select count(*)::int from restaurant_entitlements where tenant_id=${tenantId}) as entitlements`;
  assert.deepEqual(
    counts,
    { employees: 1, audit: 1, entitlements: 0 },
    "signup grants Free, not simulated Stripe trial",
  );
  await admin`update employees set active=false where tenant_id=${tenantId}`;
  await assert.rejects(
    withOwner(sql, cookies[0], a.csrf, (tx, account) =>
      enterOwnerRestaurant(tx, account.id, tenantId, account.sessionId),
    ),
    /forbidden/,
  );
  await admin`update employees set active=true where tenant_id=${tenantId}`;
  await withOwner(sql, cookies[0], a.csrf, async (tx, account) => {
    await tx`update owner_sessions set revoked=true where id=${account.sessionId}`;
  });
  await assert.rejects(
    withOwner(sql, cookies[0], undefined, async () => true),
    /unauthorized/,
  );
  await assert.rejects(
    authenticate(),
    /unauthorized/,
    "revoked owner session invalidates its POS session",
  );
  assert.equal(
    (await sql`select * from owner_accounts`).length,
    0,
    "transaction context resets",
  );
  console.log(
    "Owner DB checks passed: subject identity, email non-merging, RLS, CSRF, four-way signup, membership denial, owner entry, Free default, staff revocation and logout.",
  );
} finally {
  for (const accountId of accountIds) {
    const rows =
      await admin`select tenant_id from owner_memberships where account_id=${accountId}`;
    for (const row of rows) {
      await admin`delete from signup_billing_intents where tenant_id=${row.tenant_id}`;
      await admin`delete from audit where tenant_id=${row.tenant_id}`;
      await admin`delete from pin_throttles where tenant_id=${row.tenant_id}`;
      await admin`delete from sessions where tenant_id=${row.tenant_id}`;
      await admin`delete from devices where tenant_id=${row.tenant_id}`;
      await admin`delete from owner_memberships where tenant_id=${row.tenant_id}`;
      await admin`delete from employees where tenant_id=${row.tenant_id}`;
      await admin`delete from restaurants where id=${row.tenant_id}`;
    }
    await admin`delete from organizations where created_by_account=${accountId}`;
    await admin`delete from owner_sessions where account_id=${accountId}`;
    await admin`delete from owner_accounts where id=${accountId}`;
  }
  await sql.end();
  await admin.end();
}
