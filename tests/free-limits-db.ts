import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { tenant } from "../server/db.js";
import {
  signInGoogleOwner,
  withOwner,
  createOwnerRestaurant,
  enterOwnerRestaurant,
  ownerBrowserCookie,
} from "../server/owner-accounts.js";
import {
  createInvitation,
  acceptInvitation,
  createAdditionalLocation,
  selectFreeLocation,
} from "../server/owner-management.js";
import { saveEmployee, saveProduct, receive } from "../server/management.js";
import {
  freeSelection,
  saveFreeSelection,
  sellingAllowed,
} from "../server/free-limits.js";
import { createOrder, recordPayment } from "../server/orders.js";
import { hash, sign } from "../server/auth.js";
import { pinSignIn } from "../server/access.js";
import type { Session } from "../shared/domain.js";
import { noRetries } from "./db-retries.js";
const { runtime, migration } = isolatedTarget(process.env),
  sql = postgres(runtime, { max: 8 }),
  admin = postgres(migration, { max: 1 });
try {
  const cookie = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: randomUUID(),
    email: "free-owner@example.com",
    name: "Free limits fixture",
  });
  const owner = await withOwner(sql, cookie, undefined, async (_tx, a) => a);
  const input = {
    restaurantName: "Free limits fixture",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
    openingDays: [1, 2, 3, 4, 5],
  };
  const { tenantId } = await withOwner(sql, cookie, undefined, (tx, a) =>
    createOwnerRestaurant(tx, a, input),
  );
  const entries = await Promise.all(
    Array.from({ length: 4 }, () =>
      withOwner(sql, cookie, undefined, (tx, a) =>
        enterOwnerRestaurant(
          tx,
          a.id,
          tenantId,
          a.sessionId,
          ownerBrowserCookie(),
        ),
      ),
    ),
  );
  const [member] =
    await admin`select employee_id from owner_memberships where tenant_id=${tenantId}`;
  const s: Session = {
    id: entries[0].session.id,
    tenantId,
    employeeId: member.employee_id,
    deviceId: entries[0].device.id,
    name: owner.name,
    role: "owner",
    csrf: "",
    expiresAt: "",
    offlineUntil: "",
    restaurant: {
      name: input.restaurantName,
      currency: "MXN",
      timezone: input.timezone,
      cutoff: 240,
    },
  };
  const run = <T>(fn: Parameters<typeof tenant<T>>[2]) =>
    tenant(sql, tenantId, fn);
  const selected = await run((tx) => freeSelection(tx, s));
  assert.equal(
    selected.devices.filter((d) => d.free_slot).length,
    1,
    "concurrent pairing selects one device",
  );
  s.deviceId = selected.devices.find((d) => d.free_slot)!.id;
  const employee = () => ({
    operationId: randomUUID(),
    id: randomUUID(),
    name: "Named employee",
    login: randomUUID(),
    role: "cashier",
    secret: "123456",
    active: true,
  });
  const attempts = await noRetries("free-limit employee saves", () =>
    Promise.allSettled(
      Array.from({ length: 6 }, () =>
        run((tx) => saveEmployee(tx, s, employee())),
      ),
    ),
  );
  assert.equal(
    attempts.filter((r) => r.status === "fulfilled").length,
    2,
    "concurrent team cap",
  );
  assert.ok(
    attempts
      .filter((r) => r.status === "rejected")
      .every((r) => r.reason.message === "free_team_limit"),
  );
  await assert.rejects(
    run((tx) => saveEmployee(tx, s, { ...employee(), role: "owner" })),
    /owner_role_reserved/,
  );
  const invite = await withOwner(sql, cookie, undefined, (tx, a) =>
    createInvitation(tx, a.id, {
      operationId: randomUUID(),
      tenantId,
      email: "free-invite@example.com",
      role: "cashier",
    }),
  );
  const guest = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: randomUUID(),
    email: "free-invite@example.com",
  });
  await assert.rejects(
    withOwner(sql, guest, undefined, (tx, a) =>
      acceptInvitation(tx, a, { token: invite.path.split("#invite=")[1] }),
    ),
    /free_team_limit/,
  );
  const productId = randomUUID();
  const productInput = {
    operationId: randomUUID(),
    id: productId,
    name: { es: "Prueba", en: "Test" },
    category: { es: "Prueba", en: "Test" },
    price: 100,
    available: true,
    station: "kitchen" as const,
    expectedVersion: 0,
    cost: null,
    recipe: [],
  };
  await run((tx) => saveProduct(tx, s, productInput));
  const body = {
    operationId: randomUUID(),
    lines: [
      { id: randomUUID(), productId, quantity: 1, options: [], note: "" },
    ],
    mode: "takeaway",
    tableId: null,
    name: "Free limits",
    note: "",
    channel: "pos",
  };
  const order = await run((tx) => createOrder(tx, s, body));
  const otherDevice = selected.devices.find((d) => d.id !== s.deviceId)!.id;
  await assert.rejects(
    run((tx) =>
      createOrder(
        tx,
        { ...s, deviceId: otherDevice },
        { ...body, operationId: randomUUID(), channel: "offline" },
      ),
    ),
    /free_selection_required/,
  );
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${tenantId},'trialing',now()+interval '1 day','fixture')`;
  await run((tx) => saveEmployee(tx, s, employee()));
  const before = await run((tx) =>
    createOrder(
      tx,
      { ...s, deviceId: otherDevice },
      {
        ...body,
        operationId: randomUUID(),
        lines: body.lines.map((l) => ({ ...l, id: randomUUID() })),
      },
    ),
  );
  const location = await withOwner(sql, cookie, undefined, (tx, a) =>
    createAdditionalLocation(tx, a, {
      ...input,
      sourceTenantId: tenantId,
      operationId: randomUUID(),
    }),
  );
  await admin`update restaurants set activation_pending=false where id=${location.tenantId}`;
  await admin`update restaurant_entitlements set access_until=now()-interval '1 second' where tenant_id=${tenantId}`;
  assert.equal(
    await run((tx) => sellingAllowed(tx, s.employeeId, otherDevice)),
    false,
  );
  assert.equal(
    (
      await run((tx) =>
        saveProduct(tx, { ...s, deviceId: otherDevice }, productInput),
      )
    ).id,
    productId,
    "accepted management replay survives downgrade",
  );
  await assert.rejects(
    run((tx) =>
      saveProduct(tx, { ...s, deviceId: otherDevice }, {
        ...productInput,
        operationId: randomUUID(),
        expectedVersion: 1,
        price: 200,
      }),
    ),
    /free_selection_required/,
  );
  await assert.rejects(
    run((tx) =>
      saveEmployee(tx, { ...s, deviceId: otherDevice }, employee()),
    ),
    /free_selection_required/,
  );
  assert.equal(
    (await run((tx) => createOrder(tx, s, body))).id,
    order.id,
    "accepted replay survives downgrade",
  );
  await assert.rejects(
    run((tx) =>
      receive(tx, s, {
        operationId: randomUUID(),
        supplierId: randomUUID(),
        stockId: randomUUID(),
        quantity: "1",
        cost: 1,
        expiresOn: null,
        reason: "test",
      }),
    ),
    /pro_required/,
  );
  const drawerId = randomUUID();
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${drawerId},${otherDevice},${s.employeeId},0)`;
  const paid = await run((tx) =>
    recordPayment(tx, { ...s, deviceId: otherDevice }, before.id, {
      operationId: randomUUID(),
      amount: 100,
      received: 100,
      tip: 0,
      method: "cash",
    }),
  );
  assert.equal(
    paid.paid,
    100,
    "downgrade still permits collecting existing order",
  );
  const staff = (await run((tx) => freeSelection(tx, s))).employees;
  await run((tx) =>
    saveFreeSelection(tx, s, {
      deviceId: otherDevice,
      employeeIds: [staff[1].id, staff[2].id],
    }),
  );
  assert.equal(
    await run((tx) => sellingAllowed(tx, s.employeeId, otherDevice)),
    true,
  );
  assert.equal(
    await run((tx) => sellingAllowed(tx, s.employeeId, s.deviceId)),
    false,
  );
  // PLATFORM-LOCKS-6: an employee save and a Free selection touching the same
  // slotted employee take the free-limits key (LO-3) before the employee row in
  // both commands, so they serialize instead of deadlocking.
  const [slotted] =
    await admin`select id,name,login from employees where id=${staff[1].id}`;
  const seller = { ...s, deviceId: otherDevice };
  for (let i = 0; i < 10; i++)
    await noRetries("employee save vs Free selection", () =>
      Promise.all([
        run((tx) =>
          saveEmployee(tx, seller, {
            operationId: randomUUID(),
            id: slotted.id,
            name: slotted.name,
            login: slotted.login,
            role: "cashier",
            secret: "123456",
            active: true,
          }),
        ),
        run((tx) =>
          saveFreeSelection(tx, s, {
            deviceId: otherDevice,
            employeeIds: [staff[1].id, staff[2].id],
          }),
        ),
      ]),
    );
  // PLAT-HR-9: the exact LOCKS-6 cycle. A PIN sign-in on the slotted device locks the
  // employee row (PIN counters) and creates a session (selectFirstDevice, sellingAllowed);
  // saveFreeSelection holds the free-limits key while it updates every slotted device
  // and employee. Both take 920 first, so they serialize and tenant() retries nothing.
  const terminal = {
    id: otherDevice,
    tenantId,
    token: randomBytes(32).toString("hex"),
  };
  await admin`update devices set token_hash=${hash(terminal.token)},
      token_expires_at=now()+interval '1 day' where id=${otherDevice}`;
  const signIn = () => {
    const res = {
      cookie: () => {},
      clearCookie: () => {},
    };
    return pinSignIn(
      sql,
      {
        cookies: { gm_device: sign(terminal) },
        body: { employeeId: slotted.id, secret: "123456" },
        headers: {},
        method: "POST",
      } as never,
      res as never,
    );
  };
  for (let i = 0; i < 10; i++) {
    const [signedIn] = await noRetries("PIN sign-in vs Free selection", () =>
      Promise.all([
        signIn(),
        run((tx) =>
          saveFreeSelection(tx, s, {
            deviceId: otherDevice,
            employeeIds: [staff[1].id, staff[2].id],
          }),
        ),
      ]),
    );
    assert.equal(typeof signedIn.sessionId, "string");
  }
  await assert.rejects(
    run((tx) =>
      saveFreeSelection(
        tx,
        { ...s, role: "manager" },
        { deviceId: otherDevice, employeeIds: [] },
      ),
    ),
    /forbidden/,
  );
  await assert.rejects(
    run((tx) =>
      saveFreeSelection(tx, s, { deviceId: randomUUID(), employeeIds: [] }),
    ),
    /invalid_selection/,
  );
  await withOwner(sql, cookie, undefined, (tx, a) =>
    selectFreeLocation(tx, a.id, location.tenantId),
  );
  assert.equal(
    await run((tx) => sellingAllowed(tx, s.employeeId, otherDevice)),
    false,
    "only selected Free location sells",
  );
  assert.equal(
    (await run((tx) => freeSelection(tx, s))).employees.length,
    3,
    "downgrade retains all named staff",
  );
  assert.equal(
    (await sql`select * from devices`).length,
    0,
    "missing scope fails closed",
  );
  console.log(
    "Free limits DB passed: concurrent device/team caps, invitation cap, owner-role bypass denial, canonical sales/management gates, expiry/replay/payment recovery, owner selection, tenant isolation and single Free location. Synthetic audit fixtures retained.",
  );
} finally {
  await sql.end();
  await admin.end();
}
