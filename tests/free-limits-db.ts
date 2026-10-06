import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import {
  autoAssignFreeSlots,
  freeSelectionMode,
  requireDrawerOpenAllowed,
  sellingAccess,
} from "../server/free-limits.js";
import { setFreeSelectionMode } from "../server/account-settings.js";
import { createOrder, recordPayment, addRound } from "../server/orders.js";
import { createSession } from "../server/access.js";
import { authentication, hash, sign } from "../server/auth.js";
import { legalConfig } from "../server/legal.js";
import { randomBytes } from "node:crypto";
import type { Session } from "../shared/domain.js";
// Legal gating is not under test here (account-db covers it): restaurants are
// created as in CI's DB steps, documents unpublished with signup allowed.
const legal = legalConfig({ LEGAL_UNPUBLISHED_SIGNUP: "allow" });
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
    createOwnerRestaurant(tx, a, input, legal),
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
  const attempts = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      run((tx) => saveEmployee(tx, s, employee())),
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
    createInvitation(
      tx,
      a.id,
      {
        operationId: randomUUID(),
        tenantId,
        email: "free-invite@example.com",
        role: "cashier",
      },
      legal,
    ),
  );
  const guest = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: randomUUID(),
    email: "free-invite@example.com",
  });
  await assert.rejects(
    withOwner(sql, guest, undefined, (tx, a) =>
      acceptInvitation(
        tx,
        a,
        { token: invite.path.split("#invite=")[1] },
        legal,
      ),
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
    createAdditionalLocation(
      tx,
      a,
      {
        ...input,
        sourceTenantId: tenantId,
        operationId: randomUUID(),
      },
      legal,
    ),
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
      saveProduct(
        tx,
        { ...s, deviceId: otherDevice },
        {
          ...productInput,
          operationId: randomUUID(),
          expectedVersion: 1,
          price: 200,
        },
      ),
    ),
    /free_selection_required/,
  );
  await assert.rejects(
    run((tx) => saveEmployee(tx, { ...s, deviceId: otherDevice }, employee())),
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
    selectFreeLocation(tx, a.id, location.tenantId, legal),
  );
  // account (031, GAP-1): the drawer opened above on otherDevice keeps that
  // register selling (drawer continuation) until it closes; without an open
  // drawer only the selected Free location sells.
  assert.equal(
    (await run((tx) => sellingAccess(tx, s.employeeId, otherDevice))).basis,
    "drawer_continuation",
  );
  await admin`update cash_sessions set closed_at=now(),counted=0,expected=0 where id=${drawerId}`;
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
  await planLapse();
  console.log(
    "Free limits DB passed: concurrent device/team caps, invitation cap, owner-role bypass denial, canonical sales/management gates, expiry/replay/payment recovery, owner selection, tenant isolation and single Free location; plan lapse (GAP-1): drawer continuation, automatic Free slots and manual pinning. Synthetic audit fixtures retained.",
  );
} finally {
  await sql.end();
  await admin.end();
}

/**
 * Plan lapse (account 031, GAP-1): a register whose drawer opened during Pro
 * keeps selling after the trial ends, Free slots follow drawer openers in auto
 * mode, and the owner's explicit selection pins manual mode.
 */
async function planLapse() {
  const cookie = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: randomUUID(),
    email: "lapse-owner@example.com",
    name: "Lapse fixture",
  });
  const { tenantId } = await withOwner(sql, cookie, undefined, (tx, a) =>
    createOwnerRestaurant(
      tx,
      a,
      {
        restaurantName: "Lapse fixture",
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
        openingDays: [1, 2, 3, 4, 5, 6, 7],
      },
      legal,
    ),
  );
  const run = <T>(fn: Parameters<typeof tenant<T>>[2]) =>
    tenant(sql, tenantId, fn);
  const [ownerSeat] =
    await admin`select employee_id from owner_memberships where tenant_id=${tenantId}`;
  // The owner's sign-up browser holds the device slot and never opens a drawer.
  const laptop = await withOwner(sql, cookie, undefined, (tx, a) =>
    enterOwnerRestaurant(tx, a.id, tenantId, a.sessionId, ownerBrowserCookie()),
  );
  const devices: Array<{ id: string; token: string }> = [];
  for (let i = 0; i < 3; i++) {
    const d = { id: randomUUID(), token: randomBytes(32).toString("hex") };
    await admin`insert into devices(tenant_id,id,name,token_hash,kind,paired_at,token_expires_at)
      values(${tenantId},${d.id},${"Caja " + (i + 1)},${hash(d.token)},'terminal',now(),now()+interval '30 days')`;
    devices.push(d);
  }
  const staff: Record<string, string> = {};
  for (const [name, role] of [
    ["cook", "kitchen"],
    ["ana", "cashier"],
    ["beto", "cashier"],
    ["caro", "server"],
  ]) {
    staff[name] = randomUUID();
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role,pin_set_at)
      values(${tenantId},${staff[name]},${name},${name + "-" + tenantId.slice(0, 8)},'x:y',${role},now())`;
  }
  // The kitchen and one cashier hold the two employee slots.
  await admin`update employees set free_slot=1 where id=${staff.cook}`;
  await admin`update employees set free_slot=2 where id=${staff.ana}`;
  const session = (
    employeeId: string,
    deviceId: string,
    role: string,
  ): Session => ({
    id: randomUUID(),
    tenantId,
    employeeId,
    deviceId,
    name: role,
    role,
    csrf: "",
    expiresAt: "",
    offlineUntil: "",
    restaurant: {
      name: "Lapse fixture",
      currency: "MXN",
      timezone: "America/Mexico_City",
      cutoff: 240,
    },
  });
  /** POST /cash/open's body (server/index.ts), without the HTTP layer. */
  const openDrawer = (s: Session) =>
    run(async (tx) => {
      await autoAssignFreeSlots(tx, s);
      await requireDrawerOpenAllowed(tx, s);
      const id = randomUUID();
      await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${id},${s.deviceId},${s.employeeId},0)`;
      return id;
    });
  const slots = async () => ({
    device: (
      await admin`select id from devices where tenant_id=${tenantId} and free_slot is not null`
    )[0]?.id,
    employees: Object.fromEntries(
      (
        await admin`select id,free_slot from employees where tenant_id=${tenantId} and free_slot is not null`
      ).map((e) => [e.id, e.free_slot]),
    ),
  });
  const audits = async () =>
    (
      await admin`select count(*)::int as n from audit where tenant_id=${tenantId} and operation='plan.free_slot_auto'`
    )[0].n as number;

  // auto slot: on Free, the first drawer opener claims the slot from a
  // never-used slot device (the owner's sign-up laptop).
  assert.equal((await slots()).device, laptop.device.id);
  const anaOnOne = session(staff.ana, devices[0].id, "cashier");
  const drawerOne = await openDrawer(anaOnOne);
  assert.equal(
    (await slots()).device,
    devices[0].id,
    "auto slot: on Free, first drawer opener claims slot from a never-used slot device",
  );
  // ...and never takes it away again from a device that has opened a drawer.
  await assert.rejects(
    openDrawer(session(staff.ana, devices[1].id, "cashier")),
    /free_selection_required/,
  );
  assert.equal((await slots()).device, devices[0].id);
  await admin`update cash_sessions set closed_at=now(),counted=0,expected=0 where id=${drawerOne}`;

  // During Pro the device slot follows the latest drawer opener, and openers
  // get employee slots, kitchen holders evicted first.
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${tenantId},'trialing',now()+interval '2 days','fixture')`;
  const betoOnTwo = session(staff.beto, devices[1].id, "cashier");
  const drawerTwo = await openDrawer(betoOnTwo);
  let now = await slots();
  assert.equal(
    now.device,
    devices[1].id,
    "auto slot: during Pro the device slot follows the latest drawer opener",
  );
  assert.equal(now.employees[staff.beto], 1, "kitchen holder evicted first");
  assert.equal(now.employees[staff.cook], undefined);
  assert.equal(now.employees[staff.ana], 2);
  const caroOnThree = session(staff.caro, devices[2].id, "server");
  await openDrawer(caroOnThree);
  now = await slots();
  assert.equal(now.employees[staff.caro], 2, "oldest drawer opener evicted");
  assert.equal(now.employees[staff.ana], undefined);
  // I-13: an opener that already holds both slots writes nothing.
  await admin`update cash_sessions set closed_at=now(),counted=0,expected=0 where device_id=${devices[2].id} and closed_at is null`;
  const before = await audits();
  const caroAgain = await openDrawer(caroOnThree);
  assert.equal(await audits(), before, "no write when nothing moves");
  await admin`update cash_sessions set closed_at=now(),counted=0,expected=0 where id=${caroAgain}`;

  // A product so the open register can keep selling.
  const productId = randomUUID();
  const ownerOnTwo = session(ownerSeat.employee_id, devices[1].id, "owner");
  await run((tx) =>
    saveProduct(tx, ownerOnTwo, {
      operationId: randomUUID(),
      id: productId,
      name: { es: "Taco", en: "Taco" },
      category: { es: "Tacos", en: "Tacos" },
      price: 2500,
      available: true,
      station: "kitchen",
      expectedVersion: 0,
      cost: null,
      recipe: [],
    }),
  );
  const line = () => ({
    id: randomUUID(),
    productId,
    quantity: 1,
    options: [],
    note: "",
  });

  // R-25 / Q5: a selling session renews its offline window; under drawer
  // continuation it never does.
  const sessionCookie = await run(async (tx) => {
    const created = await createSession(tx, {
      employeeId: staff.beto,
      deviceId: devices[1].id,
    });
    return { id: created.id, tenantId, token: created.token };
  });
  const authenticate = async () => {
    await admin`update sessions set last_seen_at=now()-interval '1 hour' where id=${sessionCookie.id}`;
    // Bring the window near its end (test-only: one admin transaction with the
    // evidence trigger disabled, LD-12 pattern).
    await admin.begin(async (tx) => {
      await tx`alter table offline_leases disable trigger offline_leases_immutable`;
      await tx`alter table offline_lease_renewals disable trigger offline_lease_renewals_immutable`;
      await tx`update offline_leases set valid_until=now()+interval '30 minutes' where session_id=${sessionCookie.id}`;
      await tx`update offline_lease_renewals set valid_until=now()+interval '30 minutes' where session_id=${sessionCookie.id}`;
      await tx`alter table offline_lease_renewals enable trigger offline_lease_renewals_immutable`;
      await tx`alter table offline_leases enable trigger offline_leases_immutable`;
    });
    const req: any = {
      method: "GET",
      headers: {},
      cookies: {
        gm_session: sign(sessionCookie),
        gm_device: sign({
          id: devices[1].id,
          tenantId,
          token: devices[1].token,
        }),
      },
    };
    await new Promise<void>((resolve, reject) =>
      authentication(sql)(req, { clearCookie() {} } as any, (e?: unknown) =>
        e ? reject(e) : resolve(),
      ),
    );
    return req.session as Session;
  };
  const renewals = async () =>
    (
      await admin`select count(*)::int as n from offline_lease_renewals where session_id=${sessionCookie.id}`
    )[0].n as number;
  await authenticate();
  assert.equal(
    await renewals(),
    1,
    "a selling session renews its offline window",
  );
  await authenticate();
  assert.equal(await renewals(), 2, "and keeps renewing it while in contact");

  // The trial ends while drawer two is open.
  await admin`update restaurant_entitlements set access_until=now()-interval '1 second' where tenant_id=${tenantId}`;
  const lapsed = await authenticate();
  assert.equal(lapsed.sellingAllowed, true);
  assert.equal(
    await renewals(),
    2,
    "a continuation session does not append offline_lease_renewals",
  );
  const access = await run((tx) =>
    sellingAccess(tx, staff.beto, devices[1].id),
  );
  assert.equal(access.basis, "drawer_continuation");
  assert.ok(access.continuationUntil);
  // lapse: the register whose drawer opened during Pro keeps taking orders
  // and rounds after the trial ended, until the drawer closes.
  const order = await run((tx) =>
    createOrder(tx, betoOnTwo, {
      operationId: randomUUID(),
      lines: [line()],
      mode: "takeaway",
      tableId: null,
      name: "Para llevar",
      note: "",
      channel: "pos",
    }),
  );
  const withRound = await run((tx) =>
    addRound(tx, betoOnTwo, order.id, {
      operationId: randomUUID(),
      lines: [line()],
      mode: "takeaway",
      expectedVersion: order.version,
    }),
  );
  assert.equal(withRound.lines.length, 2);
  // R-26: no new drawer under continuation: free_selection_required, not 500.
  await assert.rejects(openDrawer(betoOnTwo), /free_selection_required/);
  // lapse: an unselected device without an open drawer cannot start sales.
  await assert.rejects(
    run((tx) =>
      createOrder(tx, session(staff.ana, devices[0].id, "cashier"), {
        operationId: randomUUID(),
        lines: [line()],
        mode: "takeaway",
        tableId: null,
        name: "No",
        note: "",
        channel: "pos",
      }),
    ),
    /free_selection_required/,
  );
  // Continuation ends 16 h after the drawer opened...
  await admin`update cash_sessions set opened_at=now()-interval '17 hours' where id=${drawerTwo}`;
  assert.equal(
    (await run((tx) => sellingAccess(tx, staff.beto, devices[1].id))).basis,
    "none",
  );
  // ...and when the drawer closes; cash/open is then denied too.
  await admin`update cash_sessions set opened_at=now(),closed_at=now(),counted=0,expected=0 where id=${drawerTwo}`;
  assert.equal(
    await run((tx) => sellingAllowed(tx, staff.beto, devices[1].id)),
    false,
  );
  await assert.rejects(openDrawer(betoOnTwo), /free_selection_required/);

  // Manual mode: the owner's explicit selection pins slots; back-to-auto resumes.
  const ownerOnLaptop = session(
    ownerSeat.employee_id,
    laptop.device.id,
    "owner",
  );
  await run((tx) =>
    saveFreeSelection(tx, ownerOnLaptop, {
      deviceId: devices[2].id,
      employeeIds: [staff.ana],
    }),
  );
  assert.equal(await run((tx) => freeSelectionMode(tx)), "manual");
  await admin`update restaurant_entitlements set access_until=now()+interval '1 day' where tenant_id=${tenantId}`;
  await openDrawer(betoOnTwo);
  assert.equal(
    (await slots()).device,
    devices[2].id,
    "auto slot: manual mode never moves",
  );
  await admin`update cash_sessions set closed_at=now(),counted=0,expected=0 where device_id=${devices[1].id} and closed_at is null`;
  const back = (await run((tx) =>
    setFreeSelectionMode(tx, ownerOnLaptop, {
      operationId: randomUUID(),
      mode: "auto",
    }),
  )) as { mode: string };
  assert.equal(back.mode, "auto");
  await openDrawer(betoOnTwo);
  assert.equal((await slots()).device, devices[1].id, "back-to-auto resumes");
}
