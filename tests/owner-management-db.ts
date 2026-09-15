import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import {
  signInGoogleOwner,
  withOwner,
  ownerCookie,
  createOwnerRestaurant,
  enterOwnerRestaurant,
  ownerBrowserCookie,
} from "../server/owner-accounts.js";
import {
  createAdditionalLocation,
  createInvitation,
  acceptInvitation,
  revokeInvitation,
  listInvitations,
} from "../server/owner-management.js";
import { authentication, sign } from "../server/auth.js";
const { runtime, migration } = isolatedTarget(process.env),
  sql = postgres(runtime, { max: 5 }),
  admin = postgres(migration, { max: 1 });
const accounts: string[] = [],
  tenants: string[] = [],
  subjects = [randomUUID(), randomUUID(), randomUUID()];
const input = {
  restaurantName: "Location qualification",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
  openingDays: [1, 2, 3, 4, 5],
};
try {
  const cookies = [];
  for (let i = 0; i < 3; i++) {
    const cookie = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject: subjects[i],
      email: i === 1 ? "invited@example.com" : "owner" + i + "@example.com",
      name: "Location fixture " + i,
    });
    cookies.push(cookie);
    accounts.push(ownerCookie(cookie).accountId);
  }
  const a = await withOwner(sql, cookies[0], undefined, async (_tx, a) => a);
  const first = await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
    createOwnerRestaurant(tx, a, input),
  );
  tenants.push(first.tenantId);
  const additional = {
    ...input,
    restaurantName: "Second location",
    operationId: randomUUID(),
    sourceTenantId: first.tenantId,
  };
  await assert.rejects(
    withOwner(sql, cookies[0], a.csrf, (tx, a) =>
      createAdditionalLocation(tx, a, additional),
    ),
    /pro_required/,
  );
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${first.tenantId},'trialing',now()+interval '3 days','fixture')`;
  const locations = await Promise.all(
    Array.from({ length: 4 }, () =>
      withOwner(sql, cookies[0], a.csrf, (tx, a) =>
        createAdditionalLocation(tx, a, additional),
      ),
    ),
  );
  assert.equal(new Set(locations.map((l) => l.tenantId)).size, 1);
  tenants.push(locations[0].tenantId);
  await assert.rejects(
    withOwner(sql, cookies[0], a.csrf, (tx, a) =>
      createAdditionalLocation(tx, a, {
        ...additional,
        restaurantName: "Changed",
      }),
    ),
    /operation_conflict/,
  );
  await assert.rejects(
    withOwner(sql, cookies[2], undefined, (tx, a) =>
      createAdditionalLocation(tx, a, {
        ...additional,
        operationId: randomUUID(),
      }),
    ),
    /forbidden/,
  );
  const original = await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
    createOwnerRestaurant(tx, a, input),
  );
  assert.equal(
    original.tenantId,
    first.tenantId,
    "signup still returns original location",
  );
  const root = ownerBrowserCookie();
  const entry = await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
    enterOwnerRestaurant(tx, a.id, first.tenantId, a.sessionId, root),
  );
  await assert.rejects(
    withOwner(sql, cookies[0], a.csrf, (tx, a) =>
      enterOwnerRestaurant(tx, a.id, tenants[1], a.sessionId, root),
    ),
    /location_billing_pending/,
  );
  await assert.rejects(
    sql`update restaurants set activation_pending=false where id=${tenants[1]}`,
    /permission denied/,
  );
  await admin`update restaurants set activation_pending=false where id=${tenants[1]}`;
  const second = await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
    enterOwnerRestaurant(tx, a.id, tenants[1], a.sessionId, root),
  );
  const back = await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
    enterOwnerRestaurant(tx, a.id, first.tenantId, a.sessionId, root),
  );
  assert.equal(entry.device.id, back.device.id);
  assert.equal(entry.device.token, back.device.token);
  assert.notEqual(entry.device.id, second.device.id);
  await assert.rejects(
    new Promise<void>(
      (resolve, reject) =>
        void authentication(sql)(
          {
            method: "GET",
            cookies: {
              gm_session: sign(second.session),
              gm_device: sign(second.device),
            },
            headers: {
              "x-session-id": entry.session.id,
              "x-tenant-id": first.tenantId,
            },
          } as any,
          {} as any,
          (error?: unknown) => (error ? reject(error) : resolve()),
        ),
    ),
    /session_changed/,
  );
  const inviteBody = {
    operationId: randomUUID(),
    tenantId: first.tenantId,
    email: "invited@example.com",
    role: "manager",
  };
  const invitation = await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
    createInvitation(tx, a.id, inviteBody),
  );
  const token = invitation.path.split("#invite=")[1];
  assert.equal(
    (
      await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
        createInvitation(tx, a.id, inviteBody),
      )
    ).path,
    invitation.path,
    "lost create response returns same link",
  );
  await assert.rejects(
    withOwner(sql, cookies[2], undefined, (tx, a) =>
      acceptInvitation(tx, a, { token }),
    ),
    /invitation_unavailable/,
  );
  await assert.rejects(
    withOwner(sql, cookies[2], undefined, (tx, a) =>
      listInvitations(tx, a.id, first.tenantId),
    ),
    /forbidden/,
  );
  const changed = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: subjects[1],
    email: "changed@example.com",
    name: "Changed fixture",
  });
  await assert.rejects(
    withOwner(sql, changed, undefined, (tx, a) =>
      acceptInvitation(tx, a, { token }),
    ),
    /invitation_unavailable/,
    "stored account email is not fresh provider proof",
  );
  const accepts = await Promise.all(
    Array.from({ length: 4 }, () =>
      withOwner(sql, cookies[1], undefined, (tx, a) =>
        acceptInvitation(tx, a, { token }),
      ),
    ),
  );
  assert.ok(accepts.every((r) => r.tenantId === first.tenantId));
  const manager = await withOwner(sql, cookies[1], undefined, (tx, a) =>
    enterOwnerRestaurant(
      tx,
      a.id,
      first.tenantId,
      a.sessionId,
      ownerBrowserCookie(),
    ),
  );
  const [employee] =
    await admin`select role from employees where tenant_id=${first.tenantId} and id=(select employee_id from owner_memberships where account_id=${accounts[1]} and tenant_id=${first.tenantId})`;
  assert.equal(employee.role, "manager");
  assert.equal(manager.session.tenantId, first.tenantId);
  const own = await withOwner(sql, cookies[1], undefined, (tx, a) =>
    createOwnerRestaurant(tx, a, input),
  );
  tenants.push(own.tenantId);
  assert.notEqual(
    own.tenantId,
    first.tenantId,
    "invited account can create its own original restaurant",
  );
  const revoked = await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
    createInvitation(tx, a.id, { ...inviteBody, operationId: randomUUID() }),
  );
  await withOwner(sql, cookies[0], a.csrf, (tx, a) =>
    revokeInvitation(tx, a.id, revoked.id),
  );
  await assert.rejects(
    withOwner(sql, cookies[1], undefined, (tx, a) =>
      acceptInvitation(tx, a, { token: revoked.path.split("#invite=")[1] }),
    ),
    /invitation_unavailable/,
  );
  assert.equal((await sql`select * from restaurant_invitations`).length, 0);
  assert.equal((await sql`select * from owner_browser_devices`).length, 0);
  console.log(
    "Owner management DB passed: Pro gate, four-way location retry, pending activation, original signup identity, persistent browser devices, stale-tab rejection, invitation ownership/fresh-email/retry/revocation, manager entry and independent owner signup.",
  );
} finally {
  for (const tenant of tenants) {
    for (const table of [
      "restaurant_invitations",
      "owner_location_commands",
      "owner_browser_devices",
      "signup_billing_intents",
      "restaurant_entitlements",
      "audit",
      "sessions",
      "devices",
      "owner_memberships",
      "employees",
    ])
      await admin.unsafe(`delete from ${table} where tenant_id=$1`, [tenant]);
    await admin`delete from restaurants where id=${tenant}`;
  }
  for (const account of accounts) {
    await admin`delete from organizations where created_by_account=${account}`;
    await admin`delete from owner_sessions where account_id=${account}`;
    await admin`delete from owner_accounts where id=${account}`;
  }
  await sql.end();
  await admin.end();
}
