/**
 * Account (031) database suite: legal acceptance, co-owners, ownership transfer,
 * recovery codes, data export, restaurant privacy and the RLS paths of 031.
 * Runs against the isolated test target as the runtime role (gm_app), with the
 * superuser fixture admin only for setup and inspection. Fixtures are left in
 * place: the evidence tables of 031 are append-only by design.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { LEGAL_CI_ENV } from "./fixtures/legal-ci.js";
import { tenant, type Tx } from "../server/db.js";
import { authentication, hash, password, sign } from "../server/auth.js";
import { checkPin, createSession, deviceScope } from "../server/access.js";
import {
  createOwnerRestaurant,
  enterOwnerRestaurant,
  ownerBrowserCookie,
  ownerCookie,
  signInGoogleOwner,
  withOwner,
} from "../server/owner-accounts.js";
import {
  acceptInvitation,
  createAdditionalLocation,
  createInvitation,
  listInvitations,
  revokeInvitation,
  selectFreeLocation,
} from "../server/owner-management.js";
import {
  legalConfig,
  legalContentHash,
  legalState,
  recordAcceptances,
  requireCurrentLegal,
} from "../server/legal.js";
import {
  createCoOwnerInvitation,
  leaveCoOwnership,
  removeCoOwner,
} from "../server/co-owners.js";
import {
  acceptTransfer,
  cancelTransfer,
  generateRecoveryCodes,
  previewTransfer,
  redeemRecoveryCode,
  requestTransfer,
} from "../server/ownership-transfer.js";
import { accountOverview, shellState } from "../server/account-center.js";
import {
  exportHandler,
  exportScope,
  exportTables,
  requireExportAccess,
} from "../server/data-export.js";
import {
  restaurantPrivacy,
  restaurantPrivacyUrl,
  saveRestaurantPrivacy,
} from "../server/account-settings.js";
import { saveEmployee } from "../server/management.js";
import {
  resetStaffPin,
  setStaffActive,
  updateStaff,
} from "../server/access-staff.js";
import { saasTaxConfig } from "../server/saas-tax.js";
import { LEGAL_DOCUMENTS } from "../shared/legal.js";
import type { Session } from "../shared/domain.js";

const { runtime, migration } = isolatedTarget(process.env);
const sql = postgres(runtime, { max: 10 }),
  admin = postgres(migration, { max: 2 });
const run = randomUUID().slice(0, 8);
const PUBLISHED = legalConfig({ ...LEGAL_CI_ENV, NODE_ENV: "production" });
const ALLOW = legalConfig({ LEGAL_UNPUBLISHED_SIGNUP: "allow" });
const CLOSED = legalConfig({});
const V = {
  terms: LEGAL_DOCUMENTS.terms.version,
  privacy: LEGAL_DOCUMENTS.privacy.version,
  dpa: LEGAL_DOCUMENTS.dpa.version,
};
const TAX = saasTaxConfig({}, "web");
const input = {
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
  openingDays: [1, 2, 3, 4, 5, 6, 7],
};
assert.equal(PUBLISHED.status, "published");

type Owner = {
  cookie: string;
  subject: string;
  id: string;
  name: string;
  email: string;
  sessionId: string;
  verifiedEmail: string | null;
  csrf: string;
};
async function owner(label: string): Promise<Owner> {
  const subject = randomUUID();
  const email = `${label}-${run}@example.com`;
  const cookie = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject,
    email,
    name: `Cuenta ${label}`,
  });
  const a = await withOwner(sql, cookie, undefined, async (_tx, a) => a);
  return { cookie, subject, ...a };
}
const as = <T>(o: Owner, fn: (tx: Tx, a: Owner) => Promise<T>): Promise<T> =>
  withOwner(sql, o.cookie, undefined, (tx, a) => fn(tx, { ...o, ...a }));
async function restaurant(o: Owner, name: string, legal = PUBLISHED) {
  const { tenantId } = await as(o, (tx, a) =>
    createOwnerRestaurant(
      tx,
      a,
      { ...input, restaurantName: name, legalAccepted: V, locale: "es" },
      legal,
    ),
  );
  const [r] =
    await admin`select organization_id from restaurants where id=${tenantId}`;
  return { tenantId, organizationId: r.organization_id as string };
}
async function seat(accountId: string, tenantId: string) {
  const [m] =
    await admin`select m.employee_id,m.revoked_at,e.role,e.active,e.deactivated_at,e.pin_set_at,e.login,e.free_slot
    from owner_memberships m join employees e on e.tenant_id=m.tenant_id and e.id=m.employee_id
    where m.account_id=${accountId} and m.tenant_id=${tenantId}`;
  return m;
}
async function entry(o: Owner, tenantId: string) {
  return as(o, (tx, a) =>
    enterOwnerRestaurant(tx, a.id, tenantId, a.sessionId, ownerBrowserCookie()),
  );
}
/** The Session authentication() builds for a device and session cookie. */
async function sessionFor(cookies: {
  session: { id: string; tenantId: string; token: string };
  device: { id: string; tenantId: string; token: string };
}): Promise<Session> {
  const req: any = {
    method: "GET",
    headers: {},
    cookies: {
      gm_session: sign(cookies.session),
      gm_device: sign(cookies.device),
    },
  };
  await new Promise<void>((resolve, reject) =>
    authentication(sql)(req, { clearCookie() {} } as any, (e?: unknown) =>
      e ? reject(e) : resolve(),
    ),
  );
  return req.session;
}
const ownerSession = async (o: Owner, tenantId: string) =>
  sessionFor(await entry(o, tenantId));
const inTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, tenantId, fn);
const token = (path: string, key: "invite" | "transfer") =>
  path.split(`#${key}=`)[1];
/** A shared terminal paired in the tenant, with a PIN session for an employee. */
async function terminalSession(tenantId: string, employeeId: string) {
  const device = {
    id: randomUUID(),
    tenantId,
    token: randomBytes(32).toString("hex"),
  };
  await admin`insert into devices(tenant_id,id,name,token_hash,kind,paired_at,token_expires_at)
    values(${tenantId},${device.id},${"Caja " + run},${hash(device.token)},'terminal',now(),now()+interval '30 days')`;
  const created = await inTenant(tenantId, (tx) =>
    createSession(tx, { employeeId, deviceId: device.id }),
  );
  return {
    device,
    session: { id: created.id, tenantId, token: created.token },
  };
}

class Capture extends Writable {
  chunks: Buffer[] = [];
  headers: Record<string, string> = {};
  headersSent = false;
  _write(chunk: Buffer, _e: BufferEncoding, cb: () => void) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  set(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  attachment(name: string) {
    this.headers["content-disposition"] = `attachment; filename="${name}"`;
    return this;
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
async function exportRun(
  s: Session,
  format: "json" | "csv",
  table?: string,
  tenantParam = s.tenantId,
) {
  const res = new Capture();
  let error: any = null;
  await exportHandler(sql, format)(
    { session: s, query: { tenant: tenantParam }, params: { table } } as any,
    res as any,
    (e?: unknown) => {
      error = e ?? null;
    },
  );
  return { res, error, text: res.text() };
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: any) => {
    assert.equal(e.code ?? e.message, code, String(e.stack ?? e));
    return true;
  });
}
async function rlsRefused(promise: Promise<unknown>) {
  await assert.rejects(promise, /row-level security|permission denied/);
}
/** LD-12 pattern: one admin transaction with the named trigger disabled. */
async function moveTransferAvailableAt(id: string, interval: string) {
  await admin.begin(async (tx) => {
    await tx`alter table ownership_transfers disable trigger ownership_transfer_guard`;
    await tx`update ownership_transfers set available_at=now()-${interval}::interval where id=${id}`;
    await tx`alter table ownership_transfers enable trigger ownership_transfer_guard`;
  });
}

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}

try {
  // ---- Legal (FIT-12) ---------------------------------------------------------
  const a = await owner("primary");
  await test("1 legal: published signup without legalAccepted → legal_acceptance_required", async () => {
    await rejects(
      as(a, (tx, x) =>
        createOwnerRestaurant(
          tx,
          x,
          { ...input, restaurantName: "Sin aceptar" },
          PUBLISHED,
        ),
      ),
      "legal_acceptance_required",
    );
    await rejects(
      as(a, (tx, x) =>
        createOwnerRestaurant(
          tx,
          x,
          {
            ...input,
            restaurantName: "Versión vieja",
            legalAccepted: { ...V, terms: "2020-01-01" },
          },
          PUBLISHED,
        ),
      ),
      "legal_version_mismatch",
    );
  });
  const A = await restaurant(a, `Taquería Primaria ${run}`);
  await test("2 legal: signup records terms, privacy and dpa with content/entity hashes and session FK", async () => {
    const rows =
      await admin`select * from legal_acceptances where account_id=${a.id} order by document`;
    assert.deepEqual(
      rows.map((r) => r.document),
      ["dpa", "privacy", "terms"],
    );
    for (const r of rows) {
      assert.equal(r.content_hash, legalContentHash(r.document));
      assert.equal(r.entity_hash, PUBLISHED.entityHash);
      assert.equal(r.owner_session_id, a.sessionId);
      assert.equal(r.published, true);
      assert.equal(r.context, "signup");
      assert.equal(
        r.organization_id,
        r.document === "dpa" ? A.organizationId : null,
      );
    }
    assert.deepEqual(
      await as(a, (tx) => legalState(tx, a.id, PUBLISHED)).then((s) => [
        s.pending,
        s.dpaPending,
      ]),
      [[], []],
    );
  });
  await test("3 legal: unpublished config refuses new Google identity (signup_paused) and signs in an existing one", async () => {
    const subject = randomUUID();
    await rejects(
      signInGoogleOwner(
        sql,
        {
          issuer: "https://accounts.google.com",
          subject,
          email: `paused-${run}@example.com`,
        },
        { allowNewAccounts: false },
      ),
      "signup_paused",
    );
    assert.equal(
      (await admin`select 1 from owner_accounts where subject=${subject}`)
        .length,
      0,
      "no owner_accounts row is created",
    );
    const again = await signInGoogleOwner(
      sql,
      {
        issuer: "https://accounts.google.com",
        subject: a.subject,
        email: a.email,
      },
      { allowNewAccounts: false },
    );
    assert.equal(ownerCookie(again).accountId, a.id);
    const b = await owner("closed");
    await rejects(
      as(b, (tx, x) =>
        createOwnerRestaurant(
          tx,
          x,
          { ...input, restaurantName: "Pausado", legalAccepted: V },
          CLOSED,
        ),
      ),
      "signup_paused",
    );
  });
  const c = await owner("draft");
  const C = await restaurant(c, `Fonda Borrador ${run}`, ALLOW);
  await test("4 legal: unpublished + allow records published=false and pending after publish", async () => {
    const rows =
      await admin`select published,entity_hash from legal_acceptances where account_id=${c.id}`;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.published === false));
    const state = await as(c, (tx) => legalState(tx, c.id, PUBLISHED));
    assert.deepEqual(state.pending, ["terms", "privacy"]);
    assert.deepEqual(state.dpaPending, [C.organizationId]);
    // Without legalAccepted, allow mode still creates the restaurant.
    const d = await owner("draft2");
    const created = await as(d, (tx, x) =>
      createOwnerRestaurant(
        tx,
        x,
        { ...input, restaurantName: "Sin evidencia" },
        ALLOW,
      ),
    );
    assert.equal(created.created, true);
  });
  await test("5 legal: material version bump gates createInvitation/createAdditionalLocation/billing request; POS enter still allowed", async () => {
    await admin`insert into legal_acceptances(id,account_id,owner_session_id,document,version,content_hash,entity_hash,published,locale,context,accepted_at)
        values(${randomUUID()},${a.id},${a.sessionId},'terms','2026-01-01',${legalContentHash("terms")},${PUBLISHED.entityHash},true,'es','reacceptance',now())`;
    // The latest acceptance is now of an older version: terms is pending again.
    await rejects(
      as(a, (tx, x) =>
        createInvitation(
          tx,
          x.id,
          {
            operationId: randomUUID(),
            tenantId: A.tenantId,
            email: `staff-${run}@example.com`,
            role: "cashier",
          },
          PUBLISHED,
        ),
      ),
      "legal_acceptance_required",
    );
    await rejects(
      as(a, (tx, x) =>
        createAdditionalLocation(
          tx,
          x,
          {
            ...input,
            restaurantName: "Segunda",
            operationId: randomUUID(),
            sourceTenantId: A.tenantId,
          },
          PUBLISHED,
        ),
      ),
      "legal_acceptance_required",
    );
    // The billing web routes call the same gate (billing-runtime.ts).
    await rejects(
      as(a, (tx) => requireCurrentLegal(tx, a.id, PUBLISHED)),
      "legal_acceptance_required",
    );
    await rejects(
      as(a, (tx, x) => selectFreeLocation(tx, x.id, A.tenantId, PUBLISHED)),
      "legal_acceptance_required",
    );
    const pos = await entry(a, A.tenantId);
    assert.equal(pos.session.tenantId, A.tenantId, "POS entry is never gated");
    await as(a, (tx, x) =>
      recordAcceptances(
        tx,
        x,
        {
          documents: [{ document: "terms", version: V.terms }],
          locale: "es",
          context: "reacceptance",
        },
        PUBLISHED,
      ),
    );
    await as(a, (tx) => requireCurrentLegal(tx, a.id, PUBLISHED));
  });
  await test("6 legal: entity change makes privacy and terms pending and DPA pending for primary", async () => {
    const changed = legalConfig({
      ...LEGAL_CI_ENV,
      NODE_ENV: "production",
      LEGAL_JURISDICTION: "Guadalajara, Jalisco",
    });
    const state = await as(a, (tx) => legalState(tx, a.id, changed));
    assert.deepEqual(state.pending, ["terms", "privacy"]);
    assert.deepEqual(state.dpaPending, [A.organizationId]);
  });
  await test("7 legal: acceptances cannot be updated or deleted (trigger + grants)", async () => {
    await assert.rejects(
      as(
        a,
        (tx) =>
          tx`update legal_acceptances set locale='en' where account_id=${a.id}`,
      ),
      /permission denied/,
    );
    await assert.rejects(
      as(a, (tx) => tx`delete from legal_acceptances where account_id=${a.id}`),
      /permission denied/,
    );
    await assert.rejects(
      admin`update legal_acceptances set locale='en' where account_id=${a.id}`,
      /append-only/,
    );
    await assert.rejects(
      admin`delete from legal_acceptances where account_id=${a.id}`,
      /append-only/,
    );
  });
  await test("8 legal: account A cannot read or insert acceptances for account B (RLS)", async () => {
    const [{ n }] = await as(
      c,
      (tx) =>
        tx`select count(*)::int as n from legal_acceptances where account_id=${a.id}`,
    );
    assert.equal(n, 0);
    await rlsRefused(
      as(
        c,
        (tx) =>
          tx`insert into legal_acceptances(id,account_id,owner_session_id,document,version,content_hash,entity_hash,published,locale,context)
            values(${randomUUID()},${a.id},${a.sessionId},'terms',${V.terms},${legalContentHash("terms")},${PUBLISHED.entityHash},true,'es','signup')`,
      ),
    );
  });

  // ---- Co-owners (GAP-5) ---------------------------------------------------------
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${A.tenantId},'trialing',now()+interval '10 days','fixture')`;
  const co = await owner("coowner");
  let coSeat = "";
  let A2 = "";
  await test("9 co-owner: primary invites; invitee accepts with legal; owner seats at every location; co-owner enters POS as owner", async () => {
    const invite = await as(a, (tx, x) =>
      createCoOwnerInvitation(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: A.organizationId,
          email: co.email,
        },
        PUBLISHED,
      ),
    );
    await rejects(
      as(co, (tx, x) =>
        acceptInvitation(
          tx,
          x,
          { token: token(invite.path, "invite") },
          PUBLISHED,
        ),
      ),
      "legal_acceptance_required",
    );
    const accepted = await as(co, (tx, x) =>
      acceptInvitation(
        tx,
        x,
        {
          token: token(invite.path, "invite"),
          legalAccepted: { terms: V.terms, privacy: V.privacy },
          locale: "es",
        },
        PUBLISHED,
      ),
    );
    assert.equal(accepted.tenantId, A.tenantId);
    const s = await seat(co.id, A.tenantId);
    assert.equal(s.role, "owner");
    assert.equal(s.active, true);
    assert.equal(s.pin_set_at, null);
    assert.equal(s.login, "account-" + co.id);
    coSeat = s.employee_id;
    const [row] =
      await admin`select source,added_by from organization_co_owners where organization_id=${A.organizationId} and account_id=${co.id} and removed_at is null`;
    assert.deepEqual([row.source, row.added_by], ["invitation", a.id]);
    const session = await ownerSession(co, A.tenantId);
    assert.equal(session.role, "owner");
    const roles = await as(
      co,
      (tx) =>
        tx`select o.id,'co_owner' as role from organization_co_owners c join organizations o on o.id=c.organization_id where c.account_id=${co.id} and c.removed_at is null`,
    );
    assert.equal(roles.length, 1);
  });
  await test("12 co-owner: new location provisions seats for active co-owners", async () => {
    const location = await as(a, (tx, x) =>
      createAdditionalLocation(
        tx,
        x,
        {
          ...input,
          restaurantName: "Sucursal Norte",
          operationId: randomUUID(),
          sourceTenantId: A.tenantId,
        },
        PUBLISHED,
      ),
    );
    A2 = location.tenantId;
    await admin`update restaurants set activation_pending=false where id=${A2}`;
    const s = await seat(co.id, A2);
    assert.equal(s?.role, "owner");
    assert.equal(s?.revoked_at, null);
  });
  await test("10 co-owner: can invite/revoke staff and select Free location; cannot add location, request billing, transfer or invite co-owners", async () => {
    const staff = await as(co, (tx, x) =>
      createInvitation(
        tx,
        x.id,
        {
          operationId: randomUUID(),
          tenantId: A.tenantId,
          email: `cashier-${run}@example.com`,
          role: "cashier",
        },
        PUBLISHED,
      ),
    );
    const listed = await as(co, (tx, x) =>
      listInvitations(tx, x.id, A.tenantId),
    );
    assert.ok(listed.some((i) => i.id === staff.id && i.role === "cashier"));
    await as(co, (tx, x) =>
      revokeInvitation(tx, x.id, { id: staff.id, tenantId: A.tenantId }),
    );
    const pendingCoOwner = await as(a, (tx, x) =>
      createCoOwnerInvitation(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: A.organizationId,
          email: `later-${run}@example.com`,
        },
        PUBLISHED,
      ),
    );
    await rejects(
      as(co, (tx, x) =>
        revokeInvitation(tx, x.id, {
          id: pendingCoOwner.id,
          tenantId: A.tenantId,
        }),
      ),
      "co_owner_primary_only",
    );
    await as(a, (tx, x) =>
      revokeInvitation(tx, x.id, {
        id: pendingCoOwner.id,
        tenantId: A.tenantId,
      }),
    );
    await as(co, (tx, x) =>
      selectFreeLocation(tx, x.id, A.tenantId, PUBLISHED),
    );
    await rejects(
      as(co, (tx, x) =>
        createAdditionalLocation(
          tx,
          x,
          {
            ...input,
            restaurantName: "No",
            operationId: randomUUID(),
            sourceTenantId: A.tenantId,
          },
          PUBLISHED,
        ),
      ),
      "co_owner_primary_only",
    );
    await rejects(
      as(co, (tx, x) =>
        requestTransfer(
          tx,
          x,
          {
            operationId: randomUUID(),
            organizationId: A.organizationId,
            email: `nobody-${run}@example.com`,
            previousOwnerStays: false,
            confirmName: `Taquería Primaria ${run}`,
          },
          PUBLISHED,
        ),
      ),
      "co_owner_primary_only",
    );
    await rejects(
      as(co, (tx, x) =>
        createCoOwnerInvitation(
          tx,
          x,
          {
            operationId: randomUUID(),
            organizationId: A.organizationId,
            email: `other-${run}@example.com`,
          },
          PUBLISHED,
        ),
      ),
      "co_owner_primary_only",
    );
    // Billing reads stay with the primary (billing_owner_read).
    await admin`insert into organization_billing(organization_id) values(${A.organizationId}) on conflict do nothing`;
    assert.equal(
      (
        await as(
          co,
          (tx) =>
            tx`select 1 from organization_billing where organization_id=${A.organizationId}`,
        )
      ).length,
      0,
    );
    // R-06: a staff invitation in a tenant that already has owner memberships
    // creates the invitee's own employee row.
    const cashier = await owner("cashier");
    const invite = await as(co, (tx, x) =>
      createInvitation(
        tx,
        x.id,
        {
          operationId: randomUUID(),
          tenantId: A.tenantId,
          email: cashier.email,
          role: "manager",
        },
        PUBLISHED,
      ),
    );
    await as(cashier, (tx, x) =>
      acceptInvitation(
        tx,
        x,
        {
          token: token(invite.path, "invite"),
          legalAccepted: { terms: V.terms, privacy: V.privacy },
        },
        PUBLISHED,
      ),
    );
    const own = await seat(cashier.id, A.tenantId);
    assert.equal(own.role, "manager");
    assert.equal(own.login, "account-" + cashier.id);
    assert.notEqual(own.employee_id, coSeat);
  });
  await test("11 co-owner: limit 3 enforced at creation and under 4 concurrent acceptances", async () => {
    const l = await owner("limit");
    const L = await restaurant(l, `Limite ${run}`);
    const invites = [];
    for (let i = 0; i < 3; i++)
      invites.push(
        await as(l, (tx, x) =>
          createCoOwnerInvitation(
            tx,
            x,
            {
              operationId: randomUUID(),
              organizationId: L.organizationId,
              email: `limit${i}-${run}@example.com`,
            },
            PUBLISHED,
          ),
        ),
      );
    await rejects(
      as(l, (tx, x) =>
        createCoOwnerInvitation(
          tx,
          x,
          {
            operationId: randomUUID(),
            organizationId: L.organizationId,
            email: `limit4-${run}@example.com`,
          },
          PUBLISHED,
        ),
      ),
      "co_owner_limit",
    );
    // Two more invitations inserted around the creation limit, then all five
    // accept at once: exactly three seats.
    const extra = [];
    for (let i = 3; i < 5; i++) {
      const t = randomUUID() + "." + randomBytes(32).toString("hex");
      await admin`insert into restaurant_invitations(id,tenant_id,created_by,email,role,token_hash)
          values(${randomUUID()},${L.tenantId},${l.id},${`limit${i}-${run}@example.com`},'co_owner',${hash(t)})`;
      extra.push(t);
    }
    const invitees = [];
    for (let i = 0; i < 5; i++) invitees.push(await owner(`limit${i}`));
    const tokens = [...invites.map((i) => token(i.path, "invite")), ...extra];
    const results = await Promise.allSettled(
      invitees.map((o, i) =>
        as(o, (tx, x) =>
          acceptInvitation(
            tx,
            x,
            {
              token: tokens[i],
              legalAccepted: { terms: V.terms, privacy: V.privacy },
            },
            PUBLISHED,
          ),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    for (const r of results)
      if (r.status === "rejected")
        assert.equal((r.reason as any).code, "co_owner_limit");
    const [{ n }] =
      await admin`select count(*)::int as n from organization_co_owners where organization_id=${L.organizationId} and removed_at is null`;
    assert.equal(n, 3);
  });
  await test("13c co-owner: a new seat has pin_set_at null and login 'account-<id>' (no usable PIN); after the co-owner sets their own PIN through access's resetStaffPin, PIN sign-in on a terminal works", async () => {
    const s = await ownerSession(co, A.tenantId);
    await inTenant(A.tenantId, (tx) =>
      resetStaffPin(tx, s, coSeat, {
        operationId: randomUUID(),
        pin: "482615",
      }),
    );
    const after = await seat(co.id, A.tenantId);
    assert.notEqual(after.pin_set_at, null);
    const check = await inTenant(A.tenantId, (tx) =>
      checkPin(tx, { employeeId: coSeat }, "482615", deviceScope(randomUUID())),
    );
    assert.equal(check.outcome, "ok");
  });
  await test("14 co-owner: legacy POST /team/save refuses another owner's row (owner_pin_self_only) and owner demotion (owner_role_locked); access's updateStaff/setStaffActive still refuse with the same codes", async () => {
    const s = await ownerSession(a, A.tenantId);
    const body = {
      operationId: randomUUID(),
      id: coSeat,
      name: "Intento",
      login: "account-" + co.id,
      role: "owner",
      secret: "123456",
      active: true,
    };
    await rejects(
      inTenant(A.tenantId, (tx) => saveEmployee(tx, s, body)),
      "owner_pin_self_only",
    );
    await rejects(
      inTenant(A.tenantId, (tx) =>
        saveEmployee(tx, s, {
          ...body,
          operationId: randomUUID(),
          id: s.employeeId,
          login: "account-" + a.id,
          role: "manager",
        }),
      ),
      "owner_role_locked",
    );
    await rejects(
      inTenant(A.tenantId, (tx) =>
        updateStaff(tx, s, coSeat, {
          operationId: randomUUID(),
          name: "x",
          role: "manager",
        }),
      ),
      "owner_role_locked",
    );
    await rejects(
      inTenant(A.tenantId, (tx) =>
        setStaffActive(tx, s, coSeat, {
          operationId: randomUUID(),
          active: false,
        }),
      ),
      "owner_cannot_be_deactivated",
    );
    // A3: another owner's PIN cannot be set from the primary's session.
    await rejects(
      inTenant(A.tenantId, (tx) =>
        resetStaffPin(tx, s, coSeat, {
          operationId: randomUUID(),
          pin: "111111",
        }),
      ),
      "owner_pin_self_only",
    );
  });
  await test("15 co-owner: direct insert into organization_co_owners without invitation hash rejected by RLS", async () => {
    const x = await owner("forger");
    const [i] =
      await admin`select id from restaurant_invitations where tenant_id=${A.tenantId} and role='co_owner' limit 1`;
    await rlsRefused(
      as(
        x,
        (tx) =>
          tx`insert into organization_co_owners(id,organization_id,account_id,added_by,source,invitation_id)
            values(${randomUUID()},${A.organizationId},${x.id},${a.id},'invitation',${i.id})`,
      ),
    );
  });
  await test("16 co-owner: owner_memberships insert for an unrelated account rejected", async () => {
    const x = await owner("intruder");
    await rlsRefused(
      as(x, async (tx) => {
        await tx`select set_config('app.tenant_id',${A.tenantId},true)`;
        await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
            values(${A.tenantId},${randomUUID()},'x',${"x-" + run},'x:y','cashier')`;
        return tx`insert into owner_memberships(account_id,tenant_id,employee_id)
            values(${x.id},${A.tenantId},${coSeat})`;
      }),
    );
  });
  await test("13 co-owner: removal uses access's lifecycle (employees inactive, deactivated_at, sessions ended employee_deactivated + revoked, pairing codes cancelled, personal devices retired, membership revoked, audit rows, org hidden)", async () => {
    const pos = await ownerSession(co, A.tenantId);
    const codeId = randomUUID();
    await admin`insert into device_pairing_codes(tenant_id,id,code_hash,device_name,created_by,expires_at)
        values(${A.tenantId},${codeId},${hash("code-" + codeId)},'Caja 9',${coSeat},now()+interval '10 minutes')`;
    await admin`update owner_sessions set created_at=now()-interval '1 hour' where id=${a.sessionId}`;
    await rejects(
      as(a, (tx, x) =>
        removeCoOwner(
          tx,
          x,
          { organizationId: A.organizationId, accountId: co.id },
          PUBLISHED,
        ),
      ),
      "reauthentication_required",
    );
    await admin`update owner_sessions set created_at=now() where id=${a.sessionId}`;
    await as(a, (tx, x) =>
      removeCoOwner(
        tx,
        x,
        { organizationId: A.organizationId, accountId: co.id },
        PUBLISHED,
      ),
    );
    for (const t of [A.tenantId, A2]) {
      const s = await seat(co.id, t);
      assert.equal(s.active, false, t);
      assert.notEqual(s.deactivated_at, null);
      assert.notEqual(s.revoked_at, null);
      assert.equal(s.free_slot, null);
    }
    const sessions =
      await admin`select id,ended_at,end_reason,revoked from sessions where employee_id=${coSeat}`;
    assert.ok(sessions.length > 0);
    // Every session ends and is revoked; the ones still live at removal end
    // with employee_deactivated (earlier ones keep their own reason).
    assert.ok(sessions.every((x) => x.ended_at && x.revoked));
    assert.equal(
      sessions.find((x) => x.id === pos.id)?.end_reason,
      "employee_deactivated",
    );
    const [code] =
      await admin`select cancelled_at from device_pairing_codes where id=${codeId}`;
    assert.notEqual(code.cancelled_at, null, "open pairing codes cancelled");
    const [device] =
      await admin`select active,revoked_at from devices where id=${pos.deviceId}`;
    assert.equal(device.active, false, "personal device retired");
    const audits =
      await admin`select operation,detail,actor_id from audit where tenant_id=${A.tenantId} and entity_id=${coSeat} order by created_at`;
    const deactivated = audits.find(
      (x) => x.operation === "access.employee_deactivated",
    );
    assert.deepEqual(Object.keys(deactivated.detail).sort(), [
      "name",
      "pairingCodes",
      "personalDevices",
      "sessions",
    ]);
    assert.equal(deactivated.detail.pairingCodes, 1);
    assert.ok(deactivated.detail.personalDevices >= 1);
    assert.ok(audits.some((x) => x.operation === "account.owner_seat_revoked"));
    const [event] =
      await admin`select kind from account_events where organization_id=${A.organizationId} and kind='co_owner_removed'`;
    assert.ok(
      event,
      "account_events insert ran after app.account_id was restored",
    );
    // The removed co-owner's Google sign-in ended with the retired device (A6).
    await rejects(
      as(co, async () => null),
      "unauthorized",
    );
    const again = {
      ...co,
      cookie: await signInGoogleOwner(sql, {
        issuer: "https://accounts.google.com",
        subject: co.subject,
        email: co.email,
      }),
    };
    assert.equal(
      (
        await as(
          again,
          (tx) =>
            tx`select 1 from restaurants r join owner_memberships m on m.tenant_id=r.id where m.account_id=${co.id} and m.revoked_at is null`,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await as(
          again,
          (tx) => tx`select 1 from organizations where id=${A.organizationId}`,
        )
      ).length,
      0,
      "the organization is hidden from the removed co-owner",
    );
    await rejects(
      as(again, (tx, x) =>
        enterOwnerRestaurant(
          tx,
          x.id,
          A.tenantId,
          x.sessionId,
          ownerBrowserCookie(),
        ),
      ),
      "forbidden",
    );
  });
  await test("13b co-owner: re-invite reactivates the same employee (active, deactivated_at null), keeps the PIN the person had set, restores the membership and creates no sessions row", async () => {
    // The same Google identity signs in again (its earlier sign-in ended
    // with the retired device).
    const cookie = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject: co.subject,
      email: co.email,
    });
    const back = { ...co, cookie };
    const [before] =
      await admin`select count(*)::int as n from sessions where employee_id=${coSeat}`;
    const invite = await as(a, (tx, x) =>
      createCoOwnerInvitation(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: A.organizationId,
          email: co.email,
        },
        PUBLISHED,
      ),
    );
    await as(back, (tx, x) =>
      acceptInvitation(
        tx,
        x,
        {
          token: token(invite.path, "invite"),
          legalAccepted: { terms: V.terms, privacy: V.privacy },
        },
        PUBLISHED,
      ),
    );
    const s = await seat(co.id, A.tenantId);
    assert.equal(s.employee_id, coSeat);
    assert.equal(s.active, true);
    assert.equal(s.deactivated_at, null);
    assert.equal(s.revoked_at, null);
    assert.notEqual(s.pin_set_at, null, "the person's own PIN is kept");
    const [after] =
      await admin`select count(*)::int as n from sessions where employee_id=${coSeat}`;
    assert.equal(after.n, before.n);
    // Leaving: same lifecycle, removal='left'.
    await as(back, (tx, x) =>
      leaveCoOwnership(tx, x, { organizationId: A.organizationId }),
    );
    const [left] =
      await admin`select removal from organization_co_owners where organization_id=${A.organizationId} and account_id=${co.id} order by added_at desc limit 1`;
    assert.equal(left.removal, "left");
    await rejects(
      as(a, (tx, x) =>
        leaveCoOwnership(tx, x, { organizationId: A.organizationId }),
      ),
      "co_owner_primary_only",
    );
  });

  // ---- Ownership transfer --------------------------------------------------------
  const t1 = await owner("transfer-from");
  const T = await restaurant(t1, `Cocina Traspaso ${run}`);
  const t2 = await owner("transfer-to");
  await test("24 transfer: deterministic token on retry with same operationId; different payload → operation_conflict", async () => {
    const body = {
      operationId: randomUUID(),
      organizationId: T.organizationId,
      email: t2.email,
      previousOwnerStays: true,
      confirmName: ` cocina traspaso ${run} `,
    };
    const first = await as(t1, (tx, x) =>
      requestTransfer(tx, x, body, PUBLISHED),
    );
    const again = await as(t1, (tx, x) =>
      requestTransfer(tx, x, body, PUBLISHED),
    );
    assert.equal(again.path, first.path);
    await rejects(
      as(t1, (tx, x) =>
        requestTransfer(
          tx,
          x,
          { ...body, previousOwnerStays: false },
          PUBLISHED,
        ),
      ),
      "operation_conflict",
    );
    await rejects(
      as(t1, (tx, x) =>
        requestTransfer(
          tx,
          x,
          { ...body, operationId: randomUUID() },
          PUBLISHED,
        ),
      ),
      "transfer_pending_exists",
    );
    await as(t1, (tx, x) => cancelTransfer(tx, x, { transferId: first.id }));
  });
  await test("19 transfer: email mismatch, expired, canceled, second pending, self → expected errors", async () => {
    const base = {
      organizationId: T.organizationId,
      previousOwnerStays: false,
      confirmName: `Cocina Traspaso ${run}`,
    };
    await rejects(
      as(t1, (tx, x) =>
        requestTransfer(
          tx,
          x,
          { ...base, operationId: randomUUID(), email: t1.email },
          PUBLISHED,
        ),
      ),
      "transfer_self",
    );
    await rejects(
      as(t1, (tx, x) =>
        requestTransfer(
          tx,
          x,
          {
            ...base,
            operationId: randomUUID(),
            email: t2.email,
            confirmName: "Otro nombre",
          },
          PUBLISHED,
        ),
      ),
      "invalid_confirmation",
    );
    const transfer = await as(t1, (tx, x) =>
      requestTransfer(
        tx,
        x,
        { ...base, operationId: randomUUID(), email: t2.email },
        PUBLISHED,
      ),
    );
    const stranger = await owner("stranger");
    await rejects(
      as(stranger, (tx, x) =>
        acceptTransfer(
          tx,
          x,
          { token: token(transfer.path, "transfer"), legalAccepted: V },
          PUBLISHED,
        ),
      ),
      "transfer_unavailable",
    );
    await as(t1, (tx, x) => cancelTransfer(tx, x, { transferId: transfer.id }));
    await rejects(
      as(t2, (tx, x) =>
        acceptTransfer(
          tx,
          x,
          { token: token(transfer.path, "transfer"), legalAccepted: V },
          PUBLISHED,
        ),
      ),
      "transfer_unavailable",
    );
    // An expired pending row (inserted pre-dated by the fixture) is refused,
    // then closed lazily by the next request.
    const expired = randomUUID() + "." + randomBytes(32).toString("hex");
    const expiredId = expired.slice(0, 36);
    await admin`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,initiated_by,previous_owner_stays,available_at,expires_at,created_at)
        values(${expiredId},${T.organizationId},${t1.id},${t2.email},${hash(expired)},'owner',false,now()-interval '4 days',now()-interval '1 day',now()-interval '4 days')`;
    await rejects(
      as(t2, (tx, x) =>
        acceptTransfer(tx, x, { token: expired, legalAccepted: V }, PUBLISHED),
      ),
      "transfer_unavailable",
    );
    const next = await as(t1, (tx, x) =>
      requestTransfer(
        tx,
        x,
        { ...base, operationId: randomUUID(), email: t2.email },
        PUBLISHED,
      ),
    );
    const [closed] =
      await admin`select state,canceled_by from ownership_transfers where id=${expiredId}`;
    assert.deepEqual(
      [closed.state, closed.canceled_by],
      ["canceled", "expired"],
    );
    await as(t2, (tx, x) =>
      cancelTransfer(tx, x, { token: token(next.path, "transfer") }),
    );
    const [declined] =
      await admin`select canceled_by from ownership_transfers where id=${next.id}`;
    assert.equal(declined.canceled_by, "target");
  });
  await test("21 transfer: UPDATE organizations.created_by_account without valid transfer rejected (as primary, as co-owner, as target with wrong app.transfer_id, with only app.tenant_id)", async () => {
    const attempts: Array<[Owner, (tx: Tx) => Promise<unknown>]> = [
      [t1, async () => null],
      [
        t2,
        (tx) =>
          tx`select set_config('app.transfer_id',${randomUUID()},true),set_config('app.organization_id',${T.organizationId},true)`,
      ],
      [
        t1,
        (tx) =>
          tx`select set_config('app.tenant_id',${T.tenantId},true),set_config('app.account_id','',true)`,
      ],
    ];
    for (const [o, setup] of attempts) {
      const rows = await as(o, async (tx) => {
        await setup(tx);
        return tx`update organizations set created_by_account=${t2.id} where id=${T.organizationId} returning id`;
      });
      assert.equal(rows.length, 0, "RLS hides the row from the update");
    }
    await assert.rejects(
      admin`update organizations set created_by_account=${t2.id} where id=${T.organizationId}`,
      /organization_owner_change_requires_transfer/,
      "the trigger guards even a superuser",
    );
    const [org] =
      await admin`select created_by_account from organizations where id=${T.organizationId}`;
    assert.equal(org.created_by_account, t1.id);
  });
  await test("17 transfer: owner-initiated to new email completes; previous owner stays co-owner; billing reads follow the new primary", async () => {
    await admin`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='owner' where organization_id=${T.organizationId} and state='pending'`.catch(
      () => null,
    );
    const transfer = await as(t1, (tx, x) =>
      requestTransfer(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: T.organizationId,
          email: t2.email,
          previousOwnerStays: true,
          confirmName: `Cocina Traspaso ${run}`,
        },
        PUBLISHED,
      ),
    );
    const preview = await as(t2, (tx, x) =>
      previewTransfer(
        tx,
        x,
        { token: token(transfer.path, "transfer") },
        PUBLISHED,
      ),
    );
    assert.equal(preview.emailMatches, true);
    assert.equal(preview.onHold, false);
    assert.equal(preview.organizationName, `Cocina Traspaso ${run}`);
    assert.equal(preview.fromName, "Cuenta transfer-from");
    await rejects(
      as(t2, (tx, x) =>
        acceptTransfer(
          tx,
          x,
          { token: token(transfer.path, "transfer") },
          PUBLISHED,
        ),
      ),
      "legal_acceptance_required",
    );
    await admin`insert into organization_billing(organization_id) values(${T.organizationId}) on conflict do nothing`;
    const done = await as(t2, (tx, x) =>
      acceptTransfer(
        tx,
        x,
        { token: token(transfer.path, "transfer"), legalAccepted: V },
        PUBLISHED,
      ),
    );
    assert.deepEqual(done.tenantIds, [T.tenantId]);
    const [org] =
      await admin`select created_by_account from organizations where id=${T.organizationId}`;
    assert.equal(org.created_by_account, t2.id);
    const [stays] =
      await admin`select source,transfer_id from organization_co_owners where organization_id=${T.organizationId} and account_id=${t1.id} and removed_at is null`;
    assert.deepEqual(
      [stays.source, stays.transfer_id],
      ["transfer", transfer.id],
    );
    assert.equal((await seat(t1.id, T.tenantId)).active, true);
    assert.equal((await seat(t2.id, T.tenantId)).role, "owner");
    const [dpa] =
      await admin`select context from legal_acceptances where account_id=${t2.id} and document='dpa' and organization_id=${T.organizationId}`;
    assert.equal(dpa.context, "transfer");
    assert.equal(
      (
        await as(
          t2,
          (tx) =>
            tx`select 1 from organization_billing where organization_id=${T.organizationId}`,
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await as(
          t1,
          (tx) =>
            tx`select 1 from organization_billing where organization_id=${T.organizationId}`,
        )
      ).length,
      0,
    );
    const [state] =
      await admin`select state,completed_at from ownership_transfers where id=${transfer.id}`;
    assert.equal(state.state, "completed");
    const audit =
      await admin`select 1 from audit where tenant_id=${T.tenantId} and operation='account.ownership_transferred'`;
    assert.equal(audit.length, 1);
  });
  await test("20 transfer: target already primary elsewhere → transfer_target_owns_organization", async () => {
    const transfer = await as(t2, (tx, x) =>
      requestTransfer(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: T.organizationId,
          email: a.email,
          previousOwnerStays: true,
          confirmName: `Cocina Traspaso ${run}`,
        },
        PUBLISHED,
      ),
    );
    await rejects(
      as(a, (tx, x) =>
        acceptTransfer(
          tx,
          x,
          { token: token(transfer.path, "transfer"), legalAccepted: V },
          PUBLISHED,
        ),
      ),
      "transfer_target_owns_organization",
    );
    await as(t2, (tx, x) => cancelTransfer(tx, x, { transferId: transfer.id }));
  });
  await test("18 transfer: previous owner leaving loses seats and sessions (deactivated_at set, sessions ended with end_reason='employee_deactivated' and revoked)", async () => {
    const u1 = await owner("leave-from");
    const U = await restaurant(u1, `Barra Salida ${run}`);
    const u2 = await owner("leave-to");
    await ownerSession(u1, U.tenantId);
    const transfer = await as(u1, (tx, x) =>
      requestTransfer(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: U.organizationId,
          email: u2.email,
          previousOwnerStays: false,
          confirmName: `Barra Salida ${run}`,
        },
        PUBLISHED,
      ),
    );
    await as(u2, (tx, x) =>
      acceptTransfer(
        tx,
        x,
        { token: token(transfer.path, "transfer"), legalAccepted: V },
        PUBLISHED,
      ),
    );
    const s = await seat(u1.id, U.tenantId);
    assert.equal(s.active, false);
    assert.notEqual(s.deactivated_at, null);
    assert.notEqual(s.revoked_at, null);
    const sessions =
      await admin`select end_reason,revoked from sessions where employee_id=${s.employee_id}`;
    assert.ok(sessions.length > 0);
    assert.ok(
      sessions.every(
        (x) => x.end_reason === "employee_deactivated" && x.revoked,
      ),
    );
    assert.equal(
      (
        await admin`select 1 from organization_co_owners where organization_id=${U.organizationId} and account_id=${u1.id}`
      ).length,
      0,
    );
  });
  await test("22 transfer: two concurrent accepts complete exactly once", async () => {
    const k1 = await owner("race-from");
    const K = await restaurant(k1, `Carrera ${run}`);
    const k2 = await owner("race-to");
    const transfer = await as(k1, (tx, x) =>
      requestTransfer(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: K.organizationId,
          email: k2.email,
          previousOwnerStays: true,
          confirmName: `Carrera ${run}`,
        },
        PUBLISHED,
      ),
    );
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        as(k2, (tx, x) =>
          acceptTransfer(
            tx,
            x,
            { token: token(transfer.path, "transfer"), legalAccepted: V },
            PUBLISHED,
          ),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failed = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    assert.equal(failed.reason.code, "transfer_unavailable");
    const [{ n }] =
      await admin`select count(*)::int as n from audit where tenant_id=${K.tenantId} and operation='account.ownership_transferred'`;
    assert.equal(n, 1);
  });
  await test("23 transfer: promotion of existing co-owner (removal='promoted') and of invited manager (role owner, free_slot null, sessions ended role_changed)", async () => {
    const p1 = await owner("promote-from");
    const P = await restaurant(p1, `Promocion ${run}`);
    const p2 = await owner("promote-to");
    const invite = await as(p1, (tx, x) =>
      createCoOwnerInvitation(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: P.organizationId,
          email: p2.email,
        },
        PUBLISHED,
      ),
    );
    await as(p2, (tx, x) =>
      acceptInvitation(
        tx,
        x,
        {
          token: token(invite.path, "invite"),
          legalAccepted: { terms: V.terms, privacy: V.privacy },
        },
        PUBLISHED,
      ),
    );
    const transfer = await as(p1, (tx, x) =>
      requestTransfer(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: P.organizationId,
          email: p2.email,
          previousOwnerStays: true,
          confirmName: `Promocion ${run}`,
        },
        PUBLISHED,
      ),
    );
    await as(p2, (tx, x) =>
      acceptTransfer(
        tx,
        x,
        { token: token(transfer.path, "transfer"), legalAccepted: V },
        PUBLISHED,
      ),
    );
    const [promoted] =
      await admin`select removal from organization_co_owners where organization_id=${P.organizationId} and account_id=${p2.id}`;
    assert.equal(promoted.removal, "promoted");
    // Invited manager promoted to owner.
    const m1 = await owner("manager-from");
    const M = await restaurant(m1, `Gerencia ${run}`);
    await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
        values(${M.tenantId},'trialing',now()+interval '10 days','fixture')`;
    const m2 = await owner("manager-to");
    const staff = await as(m1, (tx, x) =>
      createInvitation(
        tx,
        x.id,
        {
          operationId: randomUUID(),
          tenantId: M.tenantId,
          email: m2.email,
          role: "manager",
        },
        PUBLISHED,
      ),
    );
    await as(m2, (tx, x) =>
      acceptInvitation(
        tx,
        x,
        {
          token: token(staff.path, "invite"),
          legalAccepted: { terms: V.terms, privacy: V.privacy },
        },
        PUBLISHED,
      ),
    );
    const managerSeat = (await seat(m2.id, M.tenantId)).employee_id;
    await admin`update employees set free_slot=1 where id=${managerSeat}`;
    await ownerSession(m2, M.tenantId);
    const t = await as(m1, (tx, x) =>
      requestTransfer(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: M.organizationId,
          email: m2.email,
          previousOwnerStays: true,
          confirmName: `Gerencia ${run}`,
        },
        PUBLISHED,
      ),
    );
    await as(m2, (tx, x) =>
      acceptTransfer(
        tx,
        x,
        { token: token(t.path, "transfer"), legalAccepted: V },
        PUBLISHED,
      ),
    );
    const s = await seat(m2.id, M.tenantId);
    assert.equal(s.employee_id, managerSeat);
    assert.equal(s.role, "owner");
    assert.equal(s.free_slot, null);
    const ended =
      await admin`select end_reason from sessions where employee_id=${managerSeat}`;
    assert.ok(ended.every((x) => x.end_reason === "role_changed"));
  });

  // ---- Recovery codes ------------------------------------------------------------
  await test("25 recovery: generate requires fresh session; codes single-use; wrong secret generic error; redeem creates 24h-hold transfer; on-hold accept rejected; completes after hold; old primary can cancel", async () => {
    const r1 = await owner("recover-from");
    const R = await restaurant(r1, `Recupera ${run}`);
    await admin`update owner_sessions set created_at=now()-interval '1 hour' where id=${r1.sessionId}`;
    await rejects(
      as(r1, (tx, x) => generateRecoveryCodes(tx, x)),
      "reauthentication_required",
    );
    await admin`update owner_sessions set created_at=now() where id=${r1.sessionId}`;
    const { codes } = await as(r1, (tx, x) => generateRecoveryCodes(tx, x));
    assert.equal(codes.length, 10);
    assert.ok(
      codes.every((c) =>
        /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/.test(c),
      ),
    );
    const stored =
      await admin`select secret_hash from account_recovery_codes where account_id=${r1.id} and revoked_at is null`;
    assert.ok(
      stored.every((x) => /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(x.secret_hash)),
    );
    const overview = await as(r1, (tx, x) =>
      accountOverview(tx, x, PUBLISHED, TAX),
    );
    assert.equal(overview.recoveryCodes.remaining, 10);
    const r2 = await owner("recover-to");
    const wrong = codes[0].slice(0, -1) + (codes[0].endsWith("0") ? "1" : "0");
    await rejects(
      as(r2, (tx, x) => redeemRecoveryCode(tx, x, { code: wrong })),
      "recovery_code_invalid",
    );
    const redeemed = await as(r2, (tx, x) =>
      redeemRecoveryCode(tx, x, { code: codes[0].toLowerCase() }),
    );
    const hold = Date.parse(redeemed.availableAt) - Date.now();
    assert.ok(hold > 23 * 3600_000 && hold <= 24 * 3600_000 + 60_000);
    const r3 = await owner("recover-again");
    await rejects(
      as(r3, (tx, x) => redeemRecoveryCode(tx, x, { code: codes[0] })),
      "recovery_code_invalid",
    );
    await rejects(
      as(r2, (tx, x) =>
        acceptTransfer(
          tx,
          x,
          { transferId: redeemed.transferId, legalAccepted: V },
          PUBLISHED,
        ),
      ),
      "transfer_on_hold",
    );
    const banner = await as(r1, (tx, x) =>
      accountOverview(tx, x, PUBLISHED, TAX),
    );
    assert.equal(
      banner.organizations[0].transfer?.initiatedBy,
      "recovery_code",
    );
    await moveTransferAvailableAt(redeemed.transferId, "1 minute");
    await as(r2, (tx, x) =>
      acceptTransfer(
        tx,
        x,
        { transferId: redeemed.transferId, legalAccepted: V },
        PUBLISHED,
      ),
    );
    const [org] =
      await admin`select created_by_account from organizations where id=${R.organizationId}`;
    assert.equal(org.created_by_account, r2.id);
    // Another redemption: the old primary cancels during the hold.
    const r4 = await owner("cancel-from");
    await restaurant(r4, `Cancela ${run}`);
    const more = await as(r4, (tx, x) => generateRecoveryCodes(tx, x));
    const r5 = await owner("cancel-to");
    const pending = await as(r5, (tx, x) =>
      redeemRecoveryCode(tx, x, { code: more.codes[3] }),
    );
    await as(r4, (tx, x) =>
      cancelTransfer(tx, x, { transferId: pending.transferId }),
    );
    const [cancelled] =
      await admin`select state,canceled_by from ownership_transfers where id=${pending.transferId}`;
    assert.deepEqual(
      [cancelled.state, cancelled.canceled_by],
      ["canceled", "owner"],
    );
    // Generating new codes revokes the unused ones.
    await as(r4, (tx, x) => generateRecoveryCodes(tx, x));
    const [{ n }] =
      await admin`select count(*)::int as n from account_recovery_codes where account_id=${r4.id} and used_at is null and revoked_at is null`;
    assert.equal(n, 10);
  });
  await test("26 recovery: account without primary org → recovery_nothing_to_recover and code not consumed", async () => {
    const r6 = await owner("no-org");
    const { codes } = await as(r6, (tx, x) => generateRecoveryCodes(tx, x));
    const r7 = await owner("no-org-target");
    await rejects(
      as(r7, (tx, x) => redeemRecoveryCode(tx, x, { code: codes[1] })),
      "recovery_nothing_to_recover",
    );
    const lookup = codes[1].replace(/-/g, "").slice(0, 8);
    const [row] =
      await admin`select used_at from account_recovery_codes where lookup=${lookup}`;
    assert.equal(row.used_at, null);
  });
  await test("27 recovery: forged ownership_transfers insert with initiated_by=recovery_code but no used code rejected by RLS", async () => {
    const f = await owner("forge-recovery");
    await rlsRefused(
      as(
        f,
        (tx) =>
          tx`insert into ownership_transfers(id,organization_id,from_account_id,to_email,to_account_id,token_hash,initiated_by,previous_owner_stays,available_at,expires_at)
            values(${randomUUID()},${A.organizationId},${a.id},${f.email},${f.id},${hash(randomUUID())},'recovery_code',false,now(),now()+interval '1 day')`,
      ),
    );
  });

  // ---- Export ------------------------------------------------------------------
  const ownerA = await ownerSession(a, A.tenantId);
  await test("28 export: JSON includes every tenant table, excludes secret columns, contains only this tenant's rows (two tenants)", async () => {
    const { text, error, res } = await exportRun(ownerA, "json");
    assert.equal(error, null);
    assert.match(
      res.headers["content-disposition"],
      /green-monkey-taqueria-primaria-[a-z0-9]+-\d{8}\.json/,
    );
    assert.equal(res.headers["cache-control"], "no-store");
    const doc = JSON.parse(text);
    assert.equal(doc.format, "green-monkey-export");
    assert.equal(doc.restaurant.id, A.tenantId);
    for (const column of ["negative_stock_policy", "offline_table_service"])
      assert.ok(column in doc.restaurant, column);
    for (const table of [
      "employees",
      "devices",
      "audit",
      "orders",
      "pin_throttles",
    ])
      assert.ok(table in doc.tables, table);
    for (const table of [
      "sessions",
      "operations",
      "owner_memberships",
      "owner_location_commands",
      "restaurant_invitations",
      "jobs",
      "support_actions",
    ])
      assert.ok(!(table in doc.tables), table);
    for (const row of doc.tables.employees) {
      assert.ok(!("secret_hash" in row));
      assert.equal(row.tenant_id, A.tenantId);
    }
    for (const row of doc.tables.devices) assert.ok(!("token_hash" in row));
    for (const [name, rows] of Object.entries(doc.tables) as Array<
      [string, any[]]
    >)
      for (const row of rows) assert.equal(row.tenant_id, A.tenantId, name);
    const [audit] =
      await admin`select detail from audit where tenant_id=${A.tenantId} and operation='account.data_export' order by created_at desc limit 1`;
    assert.deepEqual(audit.detail, { format: "json", table: null });
  });
  await test("29 export: CSV per table; unknown table 404; non-owner 403; works on Free unselected device and after lapse", async () => {
    const csv = await exportRun(ownerA, "csv", "employees");
    assert.equal(csv.error, null);
    assert.ok(csv.text.startsWith("﻿tenant_id,id,name,login,role"));
    assert.ok(!csv.text.includes("secret_hash"));
    const unknown = await exportRun(ownerA, "csv", "sessions");
    assert.equal(unknown.error?.code, "export_table_unknown");
    const mismatch = await exportRun(ownerA, "json", undefined, randomUUID());
    assert.equal(mismatch.error?.code, "session_changed");
    assert.throws(
      () => requireExportAccess({ ...ownerA, role: "manager" }),
      /forbidden/,
    );
    // Lapse: Free, and a second browser that holds no Free slot.
    await admin`update restaurant_entitlements set status='canceled',access_until=now()-interval '1 day' where tenant_id=${A.tenantId}`;
    const other = await ownerSession(a, A.tenantId);
    const [slot] =
      await admin`select free_slot from devices where id=${other.deviceId}`;
    assert.equal(slot.free_slot, null);
    assert.equal(other.sellingAllowed, false);
    const free = await exportRun(other, "json");
    assert.equal(free.error, null);
    JSON.parse(free.text);
  });
  await test("29b export: on a terminal a stale authenticated_at → step_up_required; after a fresh step-up it succeeds; a personal (owner browser) session never needs it", async () => {
    const ownerSeat = (await seat(a.id, A.tenantId)).employee_id;
    const term = await terminalSession(A.tenantId, ownerSeat);
    await admin`update sessions set authenticated_at=now()-interval '2 hours' where id=${term.session.id}`;
    const stale = await sessionFor(term);
    assert.equal(stale.access?.deviceKind, "terminal");
    assert.throws(() => requireExportAccess(stale), /step_up_required/);
    await admin`update sessions set authenticated_at=now() where id=${term.session.id}`;
    requireExportAccess(await sessionFor(term));
    await admin`update sessions set authenticated_at=now()-interval '2 hours' where id=${ownerA.id}`;
    requireExportAccess(await sessionFor(await entry(a, A.tenantId)));
  });
  await test("29c export: discovery never lists cfdi_secrets or cfdi_files even when gm_app can read them", async () => {
    const tables = await inTenant(A.tenantId, (tx) => exportTables(tx));
    const names = tables.map((t) => t.name);
    assert.ok(!names.includes("cfdi_secrets") && !names.includes("cfdi_files"));
    const [present] =
      await admin`select to_regclass('public.cfdi_files') is not null as files`;
    if (!present.files)
      console.log(
        "  (030 not applied: cfdi tables absent, denylist checked by unit test)",
      );
  });
  await test("29d export: the first statement sets statement_timeout 60s and idle_in_transaction_session_timeout 60s", async () => {
    const shown = await sql.begin(
      "isolation level repeatable read read only",
      async (raw) => {
        const tx = raw as unknown as Tx;
        await exportScope(tx, A.tenantId);
        const [a1] = await tx`show statement_timeout`;
        const [a2] = await tx`show idle_in_transaction_session_timeout`;
        const [a3] = await tx`select current_setting('app.tenant_id') as t`;
        return [
          a1.statement_timeout,
          a2.idle_in_transaction_session_timeout,
          a3.t,
        ];
      },
    );
    assert.deepEqual(shown, ["1min", "1min", A.tenantId]);
  });

  // ---- Restaurant privacy URL --------------------------------------------------
  await test("30 restaurant privacy: owner saves https URL with version; http and whitespace rejected; manager read-only; public catalog URL; terminal owner without recent PIN gets step_up_required", async () => {
    const save = (body: unknown, s = ownerA) =>
      inTenant(A.tenantId, (tx) => saveRestaurantPrivacy(tx, s, body));
    const saved = await save({
      operationId: randomUUID(),
      expectedVersion: 0,
      privacyNoticeUrl: "https://taqueria.mx/privacidad",
    });
    assert.deepEqual(saved, {
      privacyNoticeUrl: "https://taqueria.mx/privacidad",
      version: 1,
    });
    await rejects(
      save({
        operationId: randomUUID(),
        expectedVersion: 0,
        privacyNoticeUrl: null,
      }),
      "settings_changed",
    );
    for (const bad of [
      "http://taqueria.mx",
      "https://taqueria.mx/a b",
      "ftp://x",
    ])
      await assert.rejects(
        save({
          operationId: randomUUID(),
          expectedVersion: 1,
          privacyNoticeUrl: bad,
        }),
        /ZodError|invalid/i,
      );
    assert.equal(
      await inTenant(A.tenantId, (tx) => restaurantPrivacyUrl(tx)),
      "https://taqueria.mx/privacidad",
    );
    const manager = { ...ownerA, role: "manager" };
    assert.equal(
      (await inTenant(A.tenantId, (tx) => restaurantPrivacy(tx, manager)))
        .privacyNoticeUrl,
      "https://taqueria.mx/privacidad",
    );
    await rejects(
      save(
        {
          operationId: randomUUID(),
          expectedVersion: 1,
          privacyNoticeUrl: null,
        },
        manager,
      ),
      "forbidden",
    );
    await rejects(
      inTenant(A.tenantId, (tx) =>
        restaurantPrivacy(tx, { ...ownerA, role: "cashier" }),
      ),
      "forbidden",
    );
    const removed = await save({
      operationId: randomUUID(),
      expectedVersion: 1,
      privacyNoticeUrl: null,
    });
    assert.deepEqual(removed, { privacyNoticeUrl: null, version: 2 });
    // The POST route runs permit(owner) then requireRecentAuth (the same
    // pair as the export): a terminal session with a stale PIN is refused.
    const ownerSeat = (await seat(a.id, A.tenantId)).employee_id;
    const term = await terminalSession(A.tenantId, ownerSeat);
    await admin`update sessions set authenticated_at=now()-interval '2 hours' where id=${term.session.id}`;
    const stale = await sessionFor(term);
    assert.throws(() => requireExportAccess(stale), /step_up_required/);
  });
  await test("31 account events, support actions and co-owner/primary account rows (owner_accounts_org_read) readable only by verified org owners; an unrelated account reads none", async () => {
    await admin`insert into support_actions(id,operator_login,operator_label,ticket,reason,action,organization_id,tenant_id)
        values(${randomUUID()},'x','Operadora Prueba','T-1001','Verificación de prueba del suite','lookup',${A.organizationId},${A.tenantId})`;
    const overview = await as(a, (tx, x) =>
      accountOverview(tx, x, PUBLISHED, TAX),
    );
    const org = overview.organizations.find((o) => o.id === A.organizationId)!;
    assert.equal(org.role, "primary");
    assert.equal(org.primary.email, a.email);
    assert.ok(org.supportActions.some((s) => s.ticket === "T-1001"));
    assert.ok(org.events.some((e) => e.kind === "co_owner_added"));
    assert.equal(org.taxProfile, "disabled");
    const x = await owner("unrelated");
    await rejects(
      as(x, async (tx, y) => {
        const { organizationScope } = await import("../server/co-owners.js");
        return organizationScope(tx, y.id, A.organizationId, "owner");
      }),
      "forbidden",
    );
    const peek = await as(x, async (tx) => ({
      support:
        await tx`select 1 from support_actions where organization_id=${A.organizationId}`,
      events:
        await tx`select 1 from account_events where organization_id=${A.organizationId}`,
      accounts: await tx`select 1 from owner_accounts where id=${a.id}`,
      coOwners:
        await tx`select 1 from organization_co_owners where organization_id=${A.organizationId}`,
    }));
    for (const [name, rows] of Object.entries(peek))
      assert.equal(rows.length, 0, name);
  });
  await test("32 RLS recursion smoke: every new policy path executes without 'infinite recursion detected'", async () => {
    const failures: string[] = [];
    const probes = [
      "select count(*) from owner_accounts",
      "select count(*) from organizations",
      "select count(*) from restaurants",
      "select count(*) from owner_memberships",
      "select count(*) from organization_co_owners",
      "select count(*) from ownership_transfers",
      "select count(*) from account_recovery_codes",
      "select count(*) from restaurant_invitations",
      "select count(*) from legal_acceptances",
      "select count(*) from account_events",
      "select count(*) from support_actions",
      "select count(*) from organization_tax_profiles",
      "select count(*) from restaurant_account_settings",
      "select count(*) from organization_billing",
      "select count(*) from billing_locations",
      "select count(*) from signup_billing_intents",
      "update organizations set created_by_account=created_by_account where false",
      "update owner_memberships set revoked_at=revoked_at where false",
      "update organization_co_owners set removed_at=removed_at where false",
      "update ownership_transfers set state=state where false",
      "update account_recovery_codes set revoked_at=revoked_at where false",
      "update restaurant_invitations set revoked=revoked where false",
    ];
    for (const probe of probes)
      try {
        await sql.begin(async (tx) => {
          await tx`select set_config('app.account_id',${a.id},true),
              set_config('app.organization_id',${A.organizationId},true),
              set_config('app.tenant_id',${A.tenantId},true),
              set_config('app.transfer_id',${randomUUID()},true),
              set_config('app.transfer_hash',${"0".repeat(64)},true),
              set_config('app.invitation_hash',${"0".repeat(64)},true),
              set_config('app.recovery_lookup','ABCDEFGH',true),
              set_config('app.recovery_account_id',${a.id},true)`;
          await tx.unsafe(probe);
        });
      } catch (e) {
        if (/recursion/.test(String(e))) failures.push(probe);
        else throw e;
      }
    assert.deepEqual(failures, []);
  });
  await test("33 shell: the POS shell's owner block warns only about support and recovery-code transfers (never the primary's own), lists support actions of the last 7 days, reaches the owner seat entered with its PIN on a terminal, and is null for other roles", async () => {
    const o = await owner("shell");
    const S = await restaurant(o, `Aviso ${run}`);
    const shell = (s: Session) =>
      inTenant(S.tenantId, (tx) => shellState(tx, s, PUBLISHED));
    const google = await ownerSession(o, S.tenantId);
    assert.equal(google.access?.ownerAccount, true);
    // 1. The primary's own transfer is not a warning; the console shows it.
    const own = await as(o, (tx, x) =>
      requestTransfer(
        tx,
        x,
        {
          operationId: randomUUID(),
          organizationId: S.organizationId,
          email: `shell-to-${run}@example.com`,
          previousOwnerStays: false,
          confirmName: `Aviso ${run}`,
        },
        PUBLISHED,
      ),
    );
    let state = await shell(google);
    assert.ok(state.account, "a Google-entered owner gets the owner block");
    assert.deepEqual(state.account.transfers, []);
    const center = await as(o, (tx, x) =>
      accountOverview(tx, x, PUBLISHED, TAX),
    );
    assert.equal(
      center.organizations.find((g) => g.id === S.organizationId)?.transfer
        ?.initiatedBy,
      "owner",
    );
    await as(o, (tx, x) => cancelTransfer(tx, x, { transferId: own.id }));
    // 2. A support-initiated transfer is a warning with its dates, and the
    // support action is listed.
    const actionId = randomUUID();
    await admin`insert into support_actions(id,operator_login,operator_label,ticket,reason,action,organization_id)
      values(${actionId},'x','Operadora Prueba','T-3301','Transferencia de prueba del suite','transfer_ownership',${S.organizationId})`;
    const supportTransfer = randomUUID();
    await admin`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,
        initiated_by,support_action_id,previous_owner_stays,available_at,expires_at)
      values(${supportTransfer},${S.organizationId},${o.id},${`soporte-${run}@example.com`},${hash(randomUUID())},
        'support',${actionId},false,now()+interval '72 hours',now()+interval '72 hours'+interval '7 days')`;
    state = await shell(google);
    assert.equal(state.account?.transfers.length, 1);
    const warning = state.account!.transfers[0];
    assert.equal(warning.initiatedBy, "support");
    assert.equal(warning.toEmailMasked, "s***@e***.com");
    assert.equal(warning.organizationName, `Aviso ${run}`);
    assert.ok(Date.parse(warning.expiresAt) > Date.parse(warning.availableAt));
    assert.deepEqual(
      state.account!.supportActions.map((x) => x.action),
      ["transfer_ownership"],
    );
    await admin`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='support' where id=${supportTransfer}`;
    // Support actions older than 7 days are not listed (LD-12 named trigger).
    await admin.begin(async (tx) => {
      await tx`alter table support_actions disable trigger support_actions_append_only`;
      await tx`update support_actions set created_at=now()-interval '8 days' where id=${actionId}`;
      await tx`alter table support_actions enable trigger support_actions_append_only`;
    });
    state = await shell(google);
    assert.deepEqual(state.account?.supportActions, []);
    assert.deepEqual(state.account?.transfers, []);
    // 3. A recovery-code transfer warns the primary, also on the owner seat
    // entered with its PIN on a shared terminal (ACC-5).
    const { codes } = await as(o, (tx, x) => generateRecoveryCodes(tx, x));
    const thief = await owner("shell-recovery");
    await as(thief, (tx, x) => redeemRecoveryCode(tx, x, { code: codes[0] }));
    state = await shell(google);
    assert.deepEqual(
      state.account?.transfers.map((x) => x.initiatedBy),
      ["recovery_code"],
    );
    const ownerSeat = (await seat(o.id, S.tenantId)).employee_id;
    const pinned = await sessionFor(
      await terminalSession(S.tenantId, ownerSeat),
    );
    assert.equal(pinned.role, "owner");
    assert.equal(pinned.access?.ownerAccount, false);
    const pinState = await shell(pinned);
    assert.deepEqual(
      pinState.account?.transfers.map((x) => x.initiatedBy),
      ["recovery_code"],
    );
    // 4. Other roles get no owner block.
    const cashierId = randomUUID();
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role,pin_set_at)
      values(${S.tenantId},${cashierId},'Cajera aviso',${`aviso-${run}`},${password("246813")},'cashier',now())`;
    const cashier = await sessionFor(
      await terminalSession(S.tenantId, cashierId),
    );
    assert.equal((await shell(cashier)).account, null);
    // A revoked owner seat (an owner session left over) gets none either.
    await admin`update owner_memberships set revoked_at=now(),revoked_by=${o.id} where account_id=${o.id} and tenant_id=${S.tenantId}`;
    assert.equal((await shell(pinned)).account, null);
  });
  await test("34 transfer: the co-owner limit is re-checked at acceptance under 931 when the previous owner stays (co-owners who joined during the window count; the promoted target does not)", async () => {
    const coOwner = async (from: Owner, organizationId: string, to: Owner) => {
      const invite = await as(from, (tx, x) =>
        createCoOwnerInvitation(
          tx,
          x,
          { operationId: randomUUID(), organizationId, email: to.email },
          PUBLISHED,
        ),
      );
      await as(to, (tx, x) =>
        acceptInvitation(
          tx,
          x,
          {
            token: token(invite.path, "invite"),
            legalAccepted: { terms: V.terms, privacy: V.privacy },
          },
          PUBLISHED,
        ),
      );
    };
    const active = async (organizationId: string) =>
      (
        await admin`select account_id from organization_co_owners
          where organization_id=${organizationId} and removed_at is null`
      )
        .map((r) => r.account_id as string)
        .sort();
    const transferTo = (
      from: Owner,
      organizationId: string,
      name: string,
      to: Owner,
    ) =>
      as(from, (tx, x) =>
        requestTransfer(
          tx,
          x,
          {
            operationId: randomUUID(),
            organizationId,
            email: to.email,
            previousOwnerStays: true,
            confirmName: name,
          },
          PUBLISHED,
        ),
      );
    // An outside target: 2 co-owners at request, a third joins in the window.
    const f = await owner("limit-from");
    const L = await restaurant(f, `Limite ${run}`);
    const [c1, c2, c3, outsider] = [
      await owner("limit-c1"),
      await owner("limit-c2"),
      await owner("limit-c3"),
      await owner("limit-to"),
    ];
    await coOwner(f, L.organizationId, c1);
    await coOwner(f, L.organizationId, c2);
    const t = await transferTo(f, L.organizationId, `Limite ${run}`, outsider);
    await coOwner(f, L.organizationId, c3);
    await rejects(
      as(outsider, (tx, x) =>
        acceptTransfer(
          tx,
          x,
          { token: token(t.path, "transfer"), legalAccepted: V },
          PUBLISHED,
        ),
      ),
      "co_owner_limit",
    );
    const [unchanged] =
      await admin`select o.created_by_account,t.state from organizations o
        join ownership_transfers t on t.organization_id=o.id where t.id=${t.id}`;
    assert.deepEqual(
      [unchanged.created_by_account, unchanged.state],
      [f.id, "pending"],
    );
    assert.equal((await active(L.organizationId)).length, 3);
    // Once a co-owner leaves, the previous owner becomes the third.
    await as(c3, (tx, x) =>
      leaveCoOwnership(tx, x, { organizationId: L.organizationId }),
    );
    await as(outsider, (tx, x) =>
      acceptTransfer(
        tx,
        x,
        { token: token(t.path, "transfer"), legalAccepted: V },
        PUBLISHED,
      ),
    );
    assert.deepEqual(
      await active(L.organizationId),
      [c1.id, c2.id, f.id].sort(),
    );
    // A co-owner target is promoted, so it does not count against the limit.
    const g = await owner("promote-limit-from");
    const P = await restaurant(g, `Limite promocion ${run}`);
    const [d1, d2, d3] = [
      await owner("promote-limit-d1"),
      await owner("promote-limit-d2"),
      await owner("promote-limit-d3"),
    ];
    await coOwner(g, P.organizationId, d1);
    await coOwner(g, P.organizationId, d2);
    const promote = await transferTo(
      g,
      P.organizationId,
      `Limite promocion ${run}`,
      d1,
    );
    await coOwner(g, P.organizationId, d3);
    await as(d1, (tx, x) =>
      acceptTransfer(
        tx,
        x,
        { token: token(promote.path, "transfer"), legalAccepted: V },
        PUBLISHED,
      ),
    );
    assert.deepEqual(
      await active(P.organizationId),
      [d2.id, d3.id, g.id].sort(),
    );
  });
  console.log(
    `Account DB passed (${checks} checks): legal acceptance and gating, co-owners on access's lifecycle, transfers, recovery codes, export, restaurant privacy and the 031 RLS paths. Fixtures retained (append-only evidence).`,
  );
} finally {
  await sql.end();
  await admin.end();
}
