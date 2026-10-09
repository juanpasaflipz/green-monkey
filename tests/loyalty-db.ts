// Loyalty club (038) against PostgreSQL: the commands, the ledger and guard triggers, the hooks
// inside money transactions, the reconcile job, the join page and the kiosk functions, the import,
// retention and the role/RLS boundaries (specs/loyalty-w4.md §9.2, checks L1–L21 and H1).
// Fixture: fresh restaurants per group (Pro unless stated), each with its staff, a terminal with
// an open drawer, a menu, tables and the restaurant's privacy notice. Money and ledger rows stay
// in place (the isolated test database is disposable; they refuse DELETE).
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import postgres from "postgres";
import { password } from "../server/auth.js";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import { makeRoute } from "../server/http.js";
import { apiErrorHandler } from "../server/api-errors.js";
import { setLogSink } from "../server/logging.js";
import { createOrder, getOrder, recordPayment } from "../server/orders.js";
import { voidLines } from "../server/voids.js";
import { recordRefund } from "../server/refunds.js";
import { applyDiscount, reverseDiscount } from "../server/discounts.js";
import { approvalFor } from "../server/routes/discounts.js";
import { handlers } from "../server/jobs.js";
import "../server/jobs/handlers/loyalty.js";
import { runRetention } from "../server/ops/retention.js";
import { exportTables } from "../server/data-export.js";
import { seal } from "../server/tokens.js";
import {
  getLoyaltySettings,
  loyaltyCapability,
  saveLoyaltySettings,
} from "../server/loyalty/settings.js";
import {
  adjustMember,
  deleteMember,
  enrollMember,
  listMembers,
  lookupByPhone,
  memberDataSheet,
  memberDetail,
  resetLookupBudget,
  searchByName,
  updateMember,
} from "../server/loyalty/members.js";
import {
  changeOrderMember,
  getOrderLoyalty,
  joinUrlForOrder,
  linkFromKiosk,
  linkOrderMember,
  receiptLoyalty,
  reconcileOrderRoute,
} from "../server/loyalty/links.js";
import { orderLoyaltyView, reconcileOrder } from "../server/loyalty/ledger.js";
import { redeemReward } from "../server/loyalty/rewards.js";
import { joinOrder, joinView } from "../server/loyalty/join.js";
import {
  issueKioskMemberToken,
  lookupMemberForKiosk,
  loyaltyKioskConfig,
  memberFromToken,
} from "../server/loyalty/kiosk.js";
import {
  commitLoyaltyImportPage,
  importStatus,
} from "../server/loyalty/import.js";
import { loyaltyReport } from "../server/loyalty/reports.js";
import { clubRouter, register as registerLoyalty } from "../server/routes/loyalty.js";
import { type Order, type Session } from "../shared/domain.js";
import { discountExpectation, planDiscount } from "../shared/discounts.js";
import {
  JOIN_HEADER,
  LOYALTY_DEFAULTS,
  rewardDiscountRequest,
  type LoyaltySettingsView,
  type MemberSummary,
} from "../shared/loyalty.js";
import {
  importPages,
  importVerified,
  posLiteExport,
  previewLoyaltyImport,
} from "../shared/loyalty-import.js";
import { isolatedTarget } from "./isolated-target.js";
import { noRetries } from "./db-retries.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const { runtime: url, migration } = isolatedTarget(process.env);
const sql = connect(url),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);
const logLines: string[] = [];
setLogSink((line) => logLines.push(line));
const [{ started }] = await admin`select clock_timestamp() as started`;

const restaurant = {
  name: "Taquería Lealtad",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const roles = ["owner", "manager", "cashier", "server", "kitchen"] as const;
type Role = (typeof roles)[number];
type Fixture = {
  tenantId: string;
  terminal: string;
  ids: Record<Role, string>;
  s: Record<Role, Session>;
  p: Record<"taco" | "burrito" | "combo" | "molcajete" | "banquete", string>;
  table: string;
  tenants: string[];
};
const tenantsMade: string[] = [];

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
async function rejects(promise: Promise<unknown>, code: string | RegExp) {
  await assert.rejects(promise, (e: any) => {
    const got = String(e.code ?? e.message);
    if (code instanceof RegExp) assert.match(`${got} ${e.message ?? ""}`, code);
    else assert.equal(got, code, `expected ${code}, got ${got} (${e.message})`);
    return true;
  });
}
const asAdmin = <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
  admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    return fn(tx);
  }) as Promise<T>;
const run = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
const product = (id: string, es: string, price: number) => ({
  id,
  name: { es, en: es },
  category: { es: "Pruebas", en: "Tests" },
  price,
  available: true,
  station: "kitchen",
  groups: [],
  cost: 100,
  version: 1,
  recipe: [],
});
let phoneSeq = Math.floor(Math.random() * 1_000_000);
/** A fresh Mexican mobile number for this run (10 digits). */
const newPhone = () => "55" + String(10_000_000 + (phoneSeq++ % 89_999_999)).slice(0, 8);

/** A fresh restaurant: staff, a terminal with an open drawer, a menu, a table and its privacy notice. */
async function makeTenant(
  label: string,
  o: { plan?: "pro" | "free"; privacy?: boolean } = {},
): Promise<Fixture> {
  const organizationId = randomUUID(),
    tenantId = randomUUID(),
    terminal = randomUUID(),
    table = randomUUID();
  const ids = Object.fromEntries(roles.map((r) => [r, randomUUID()])) as Record<Role, string>;
  const p = {
    taco: randomUUID(),
    burrito: randomUUID(),
    combo: randomUUID(),
    molcajete: randomUUID(),
    banquete: randomUUID(),
  };
  await admin`insert into organizations(id,name) values(${organizationId},${"Lealtad " + label})`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values(${tenantId},${organizationId},${restaurant.name},'MXN','America/Mexico_City',240,true)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${tenantId},${o.plan === "free" ? "free" : "active"},${o.plan === "free" ? null : admin`now()+interval '1 day'`},'fixture')`;
  await asAdmin(tenantId, async (tx) => {
    for (const r of roles)
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${ids[r]},${"Lealtad " + r},${r + "-" + ids[r].slice(0, 8)},${password("4321")},${r})`;
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,free_slot) values(${tenantId},${terminal},'Caja club',${"fx-" + terminal},'terminal',1)`;
    await tx`insert into dining_tables(tenant_id,id,name,position) values(${tenantId},${table},'Mesa 4',1)`;
    for (const item of [
      product(p.taco, "Taco", 4500),
      product(p.burrito, "Burrito", 8500),
      product(p.combo, "Combo", 15000),
      product(p.molcajete, "Molcajete", 21000),
      product(p.banquete, "Banquete", 90000),
    ])
      await tx`insert into catalog(tenant_id,id,data) values(${tenantId},${item.id},${tx.json(item)})`;
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${randomUUID()},${terminal},${ids.owner},0)`;
    if (o.privacy !== false)
      await tx`insert into restaurant_account_settings(tenant_id,privacy_notice_url)
        values(${tenantId},'https://example.com/aviso-de-privacidad')`;
  });
  const s = Object.fromEntries(
    roles.map((r) => [
      r,
      {
        id: randomUUID(),
        tenantId,
        employeeId: ids[r],
        name: "Lealtad " + r,
        role: r,
        deviceId: terminal,
        expiresAt: "",
        offlineUntil: "",
        csrf: "",
        restaurant,
      } satisfies Session,
    ]),
  ) as Record<Role, Session>;
  tenantsMade.push(tenantId);
  return { tenantId, terminal, ids, s, p, table, tenants: tenantsMade };
}

/** A terminal PIN session whose last PIN is older than the step-up window. */
const stale = (s: Session) =>
  ({
    ...s,
    access: {
      absoluteExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      authenticatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      deviceName: "Caja club",
      deviceKind: "terminal",
      idleLockSeconds: null,
      ownerAccount: false,
    },
  }) as Session;

/** The settings body a manager saves (current version unless given). */
async function settingsBody(f: Fixture, over: Record<string, unknown> = {}) {
  const v = (await run(f.s.owner, (tx) => getLoyaltySettings(tx, f.s.owner))) as LoyaltySettingsView;
  return {
    operationId: randomUUID(),
    expectedVersion: v.version,
    enabled: true,
    programName: "",
    stampsRequired: 10,
    stampThreshold: 40000,
    maxStampsPerOrder: null,
    rewardKind: "item",
    rewardDescription: "Un producto gratis",
    rewardAmount: null,
    rewardMaxAmount: 15000,
    maxRewardsPerOrder: 1,
    promptAtCheckout: true,
    receiptJoinQr: true,
    linkWindowDays: 7,
    privacyAttested: true,
    ...over,
  };
}
async function saveSettings(f: Fixture, over: Record<string, unknown> = {}) {
  const body = await settingsBody(f, over);
  return run(f.s.owner, (tx) => saveLoyaltySettings(tx, f.s.owner, body));
}
/** A restaurant with the club switched on (defaults, cap $150). */
async function clubTenant(label: string, over: Record<string, unknown> = {}) {
  const f = await makeTenant(label);
  await saveSettings(f, over);
  return f;
}

async function enroll(f: Fixture, o: { phone?: string; name?: string; s?: Session; marketing?: boolean } = {}) {
  const s = o.s ?? f.s.cashier;
  const r = await run(s, (tx) =>
    enrollMember(tx, s, {
      operationId: randomUUID(),
      phone: o.phone ?? newPhone(),
      country: "MX",
      name: o.name ?? "Ana López",
      consent: true,
      marketingOptIn: o.marketing ?? false,
    }),
  );
  return r.member;
}
async function newOrder(
  f: Fixture,
  lines: { product: string; quantity: number }[],
  o: { s?: Session; table?: boolean } = {},
): Promise<Order> {
  const s = o.s ?? f.s.cashier;
  return run(s, (tx) =>
    createOrder(tx, s, {
      operationId: randomUUID(),
      lines: lines.map((l) => ({
        id: randomUUID(),
        productId: l.product,
        quantity: l.quantity,
        options: [],
        note: "",
      })),
      mode: o.table ? "dine_in" : "takeaway",
      tableId: o.table ? f.table : null,
      name: "Club",
      note: "",
      channel: "pos",
    }),
  );
}
async function pay(
  f: Fixture,
  orderId: string,
  amount: number,
  o: { s?: Session; method?: "cash" | "external"; tip?: number } = {},
) {
  const s = o.s ?? f.s.cashier;
  const method = o.method ?? "cash";
  return run(s, (tx) =>
    recordPayment(tx, s, orderId, {
      operationId: randomUUID(),
      amount,
      tip: o.tip ?? 0,
      received: method === "cash" ? amount + (o.tip ?? 0) : 0,
      method,
      externalConfirmed: method === "external",
      reference: method === "external" ? "T-482913" : "",
    }),
  );
}
const link = (f: Fixture, orderId: string, memberId: string, s: Session = f.s.cashier) =>
  run(s, (tx) => linkOrderMember(tx, s, orderId, { operationId: randomUUID(), memberId }));
const change = (
  f: Fixture,
  orderId: string,
  memberId: string | null,
  expectedMemberId: string | null,
  s: Session = f.s.cashier,
) =>
  run(s, (tx) =>
    changeOrderMember(tx, s, orderId, { operationId: randomUUID(), memberId, expectedMemberId }),
  );
/** The member's cached balances and lifetime counters, plus the ledger sums. */
async function member(f: Fixture, memberId: string) {
  return asAdmin(f.tenantId, async (tx) => {
    const [m] = await tx`select stamps,rewards,lifetime_stamps,rewards_earned,rewards_redeemed,
        last_activity_at,redacted_at,name,phone_e164,version,
        (select coalesce(sum(stamps_delta),0)::int from loyalty_ledger l where l.member_id=m.id) as ledger_stamps,
        (select coalesce(sum(rewards_delta),0)::int from loyalty_ledger l where l.member_id=m.id) as ledger_rewards
      from loyalty_members m where id=${memberId}`;
    return m;
  });
}
async function ledgerKinds(f: Fixture, orderId: string) {
  return asAdmin(f.tenantId, async (tx) =>
    (await tx`select kind,stamps_delta,member_id from loyalty_ledger where order_id=${orderId}
      order by created_at,id`).map((r: any) => `${r.kind}:${r.stamps_delta}`),
  );
}
/** loyalty_reconcile jobs of an order, by dedupe key. */
async function jobKeys(f: Fixture, orderId: string) {
  return asAdmin(f.tenantId, async (tx) =>
    (await tx`select dedupe_key from jobs where kind='loyalty_reconcile' and payload->>'orderId'=${orderId}
      order by created_at`).map((r: any) => r.dedupe_key as string),
  );
}
/** Runs every waiting loyalty_reconcile job of the order through the registered handler. */
async function runJobs(f: Fixture, orderId: string) {
  const entry = handlers().get("loyalty_reconcile");
  assert(entry, "loyalty_reconcile is registered");
  const jobs = await asAdmin(f.tenantId, (tx) =>
    tx`select id,dedupe_key,payload from jobs where kind='loyalty_reconcile' and state='available'
      and payload->>'orderId'=${orderId} order by created_at`,
  );
  for (const j of jobs as any[]) {
    await entry.handler({
      job: {
        tenantId: f.tenantId,
        id: j.id,
        kind: "loyalty_reconcile",
        dedupeKey: j.dedupe_key,
        payload: j.payload,
        attempts: 1,
        lease: "",
        createdAt: new Date(),
      },
      tenant: (fn) => tenant(sql, f.tenantId, fn),
      extendLease: async () => {},
      signal: new AbortController().signal,
      log: { info() {}, warn() {}, error() {} } as never,
    });
    await asAdmin(f.tenantId, (tx) => tx`update jobs set state='done' where id=${j.id}`);
  }
  return jobs.length;
}
/** A reward redemption as RedeemRewardDialog sends it (the preview from the current order). */
async function redeem(
  f: Fixture,
  orderId: string,
  memberId: string,
  lineId?: string,
  s: Session = f.s.cashier,
) {
  const order = await run(s, (tx) => getOrder(tx, orderId));
  const program = (await run(f.s.owner, (tx) => getLoyaltySettings(tx, f.s.owner))) as LoyaltySettingsView;
  const request = rewardDiscountRequest(program, order, lineId);
  const plan = planDiscount(order, request);
  return run(s, (tx) =>
    redeemReward(tx, s, orderId, {
      operationId: randomUUID(),
      memberId,
      expectedVersion: order.version,
      ...(lineId ? { lineId } : {}),
      ...discountExpectation(order, plan),
    }),
  );
}
const lineOf = (o: Order, productId: string) => o.lines.find((l) => l.productId === productId)!.id;
/** Gives a member stamps through the ledger (a manager adjustment), as a fixture. */
async function giveStamps(f: Fixture, memberId: string, stamps: number, rewards = 0) {
  return run(f.s.manager, (tx) =>
    adjustMember(tx, f.s.manager, memberId, {
      operationId: randomUUID(),
      stamps,
      rewards,
      reason: "correction",
      note: "Saldo de prueba",
    }),
  );
}

try {
  // ------------------------------------------------------------------ L21 settings
  await test("L21. settings: enabling needs Pro (pro_required), the restaurant's privacy notice and the attestation; a stale version is stale_settings; the attestation records who; operators read only the club view; kitchen is forbidden", async () => {
    const free = await makeTenant("free", { plan: "free" });
    await rejects(saveSettings(free), "pro_required");
    const bare = await makeTenant("sin aviso", { privacy: false });
    await rejects(saveSettings(bare), "loyalty_privacy_notice_required");
    const f = await makeTenant("ajustes");
    await rejects(saveSettings(f, { privacyAttested: false }), "loyalty_privacy_attestation_required");
    // Off and unattested saves are fine.
    const off = (await saveSettings(f, { enabled: false, privacyAttested: false })) as LoyaltySettingsView;
    assert.equal(off.enabled, false);
    assert.equal(off.version, 1);
    const stale1 = await settingsBody(f, { expectedVersion: 0 });
    await rejects(run(f.s.owner, (tx) => saveLoyaltySettings(tx, f.s.owner, stale1)), "stale_settings");
    const on = (await saveSettings(f)) as LoyaltySettingsView;
    assert.equal(on.enabled, true);
    assert.equal(on.privacyAttestedByName, "Lealtad owner");
    assert.equal(on.importAllowed, false);
    assert.deepEqual(await run(f.s.owner, (tx) => loyaltyCapability(tx)), { enabled: true });
    assert.deepEqual(await run(free.s.owner, (tx) => loyaltyCapability(tx)), {
      enabled: false,
      reason: "pro_required",
    });
    const cashierView = await run(f.s.cashier, (tx) => getLoyaltySettings(tx, f.s.cashier));
    assert.deepEqual(Object.keys(cashierView).sort(), [
      "enabled",
      "maxRewardsPerOrder",
      "privacyUrl",
      "programName",
      "promptAtCheckout",
      "rewardAmount",
      "rewardDescription",
      "rewardKind",
      "rewardMaxAmount",
      "stampsRequired",
    ]);
    await rejects(run(f.s.kitchen, (tx) => getLoyaltySettings(tx, f.s.kitchen)), "forbidden");
    const body = await settingsBody(f);
    await rejects(run(f.s.cashier, (tx) => saveLoyaltySettings(tx, f.s.cashier, body)), "forbidden");
    await rejects(run(stale(f.s.manager), (tx) => saveLoyaltySettings(tx, stale(f.s.manager), body)), "step_up_required");
    // An amount reward has no item cap; an item reward without an amount.
    await rejects(saveSettings(f, { rewardKind: "amount", rewardAmount: null }), "loyalty_settings_invalid");
    const amount = (await saveSettings(f, { rewardKind: "amount", rewardAmount: 5000, rewardMaxAmount: null })) as LoyaltySettingsView;
    assert.equal(amount.rewardAmount, 5000);
    assert.equal(LOYALTY_DEFAULTS.rewardMaxAmount, 15000);
  });

  // ------------------------------------------------------------------ L1 / L2 schema
  const A = await clubTenant("A");
  const B = await clubTenant("B");
  await test("L1. RLS isolates all four tables (FORCE on); the runtime role has no DELETE and cannot UPDATE balances; the ledger refuses UPDATE and DELETE even for the owner", async () => {
    const ana = await enroll(A);
    const o = await newOrder(A, [{ product: A.p.combo, quantity: 1 }]);
    await link(A, o.id, ana.id);
    await giveStamps(A, ana.id, 2);
    const seen = await run(B.s.owner, async (tx) => ({
      members: (await tx`select count(*)::int as n from loyalty_members where id=${ana.id}`)[0].n,
      ledger: (await tx`select count(*)::int as n from loyalty_ledger where member_id=${ana.id}`)[0].n,
      links: (await tx`select count(*)::int as n from loyalty_order_links where order_id=${o.id}`)[0].n,
      settings: (await tx`select count(*)::int as n from loyalty_settings where tenant_id=${A.tenantId}`)[0].n,
    }));
    assert.deepEqual(seen, { members: 0, ledger: 0, links: 0, settings: 0 });
    const tables = await admin`select relname, relrowsecurity, relforcerowsecurity,
        has_table_privilege('gm_app', oid, 'DELETE') as can_delete
      from pg_class where relname in ('loyalty_settings','loyalty_members','loyalty_ledger','loyalty_order_links')
      order by relname`;
    assert.equal(tables.length, 4);
    for (const t of tables) {
      assert.equal(t.relrowsecurity && t.relforcerowsecurity, true, t.relname);
      assert.equal(t.can_delete, false, t.relname);
    }
    await rejects(run(A.s.owner, (tx) => tx`update loyalty_members set stamps=99 where id=${ana.id}`), /permission denied|42501/);
    await rejects(run(A.s.owner, (tx) => tx`update loyalty_members set rewards=9 where id=${ana.id}`), /permission denied|42501/);
    await rejects(run(A.s.owner, (tx) => tx`update loyalty_ledger set note='x' where member_id=${ana.id}`), /permission denied|42501/);
    await rejects(run(A.s.owner, (tx) => tx`delete from loyalty_members where id=${ana.id}`), /permission denied|42501/);
    await rejects(asAdmin(A.tenantId, (tx) => tx`update loyalty_ledger set note='x' where member_id=${ana.id}`), /append-only/);
    await rejects(asAdmin(A.tenantId, (tx) => tx`delete from loyalty_ledger where member_id=${ana.id}`), /append-only/);
    // The ledger trigger refuses a row outside the current tenant.
    await rejects(
      asAdmin(B.tenantId, (tx) => tx`insert into loyalty_ledger(tenant_id,id,member_id,kind,stamps_delta,rewards_delta,reason,note,actor_id)
        values(${A.tenantId},${randomUUID()},${ana.id},'adjustment',1,0,'other','prueba',${A.ids.owner})`),
      /outside the current tenant|42501/,
    );
  });

  await test("L2. a member is born with zero balances; the phone CHECK and the unique index; the redacted shape; the guard refuses identity changes and any change after deletion", async () => {
    const insert = (o: Record<string, unknown>) =>
      asAdmin(A.tenantId, (tx) => tx`insert into loyalty_members(tenant_id,id,phone_e164,name,name_key,joined_via,joined_by,
          consent_channel,consent_at,stamps,redacted_at,redaction_reason,redacted_by)
        values(${A.tenantId},${randomUUID()},${o.phone ?? "+52" + newPhone()},'Beto','beto','pos',${A.ids.cashier},
          'staff_attested',now(),${o.stamps ?? 0},${o.redactedAt ?? null},${o.reason ?? null},${o.by ?? null})`);
    await rejects(insert({ stamps: 5 }), /loyalty_member_balances_from_ledger/);
    await rejects(insert({ phone: "+52123" }), /23514|check/);
    await rejects(insert({ phone: "+1" + "0125550100" }), /23514|check/);
    const phone = "+52" + newPhone();
    await insert({ phone });
    await rejects(insert({ phone }), /23505|duplicate/);
    const beto = await enroll(A, { name: "Beto" });
    await rejects(
      asAdmin(A.tenantId, (tx) => tx`update loyalty_members set redacted_at=now(),redaction_reason='arco',redacted_by=${A.ids.owner} where id=${beto.id}`),
      /loyalty_members_redacted_shape|23514/,
    );
    await rejects(asAdmin(A.tenantId, (tx) => tx`update loyalty_members set joined_via='join_qr',consent_channel='self_service',joined_by=null where id=${beto.id}`), /loyalty_member_immutable/);
    await rejects(asAdmin(A.tenantId, (tx) => tx`update loyalty_members set consent_at=now()-interval '1 day' where id=${beto.id}`), /loyalty_member_immutable/);
    await run(A.s.manager, (tx) =>
      deleteMember(tx, A.s.manager, beto.id, { operationId: randomUUID(), expectedVersion: 1, confirm: "ELIMINAR" }),
    );
    await rejects(asAdmin(A.tenantId, (tx) => tx`update loyalty_members set name='Beto' where id=${beto.id}`), /loyalty_member_deleted/);
    await rejects(asAdmin(A.tenantId, (tx) => tx`update loyalty_members set marketing_opt_in=true where id=${beto.id}`), /loyalty_member_deleted|23514/);
    // 'kiosk' is not a way to join (critic R20).
    await rejects(
      asAdmin(A.tenantId, (tx) => tx`insert into loyalty_members(tenant_id,id,phone_e164,name,joined_via,consent_channel,consent_at)
        values(${A.tenantId},${randomUUID()},${"+52" + newPhone()},'K','kiosk','self_service',now())`),
      /23514|check/,
    );
  });

  await test("L3. enrollment: the privacy notice and consent are required; the same phone enrolled from two registers at once gives one member and both callers get it (noRetries)", async () => {
    const f = await clubTenant("alta");
    await rejects(
      run(f.s.cashier, (tx) => enrollMember(tx, f.s.cashier, { operationId: randomUUID(), phone: newPhone(), country: "MX", name: "Ana", consent: false })),
      "loyalty_consent_required",
    );
    await rejects(
      run(f.s.cashier, (tx) => enrollMember(tx, f.s.cashier, { operationId: randomUUID(), phone: "12345", country: "MX", name: "Ana", consent: true })),
      "loyalty_invalid_phone",
    );
    await rejects(
      run(f.s.cashier, (tx) => enrollMember(tx, f.s.cashier, { operationId: randomUUID(), phone: newPhone(), country: "MX", name: "   ", consent: true })),
      "loyalty_name_required",
    );
    await rejects(
      run(f.s.kitchen, (tx) => enrollMember(tx, f.s.kitchen, { operationId: randomUUID(), phone: newPhone(), country: "MX", name: "Ana", consent: true })),
      "forbidden",
    );
    const phone = newPhone();
    const body = (name: string) => ({ operationId: randomUUID(), phone, country: "MX", name, consent: true, marketingOptIn: false });
    const [a, b] = await noRetries("L3 enrollment", () =>
      Promise.all([
        run(f.s.cashier, (tx) => enrollMember(tx, f.s.cashier, body("Ana"))),
        run(f.s.server, (tx) => enrollMember(tx, f.s.server, body("Anita"))),
      ]),
    );
    assert.equal(a.member.id, b.member.id);
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
    const [row] = await asAdmin(f.tenantId, (tx) => tx`select count(*)::int as n, min(consent_channel) as channel,
        min(consent_notice_url) as notice, bool_or(marketing_opt_in) as marketing from loyalty_members where phone_e164=${"+52" + phone}`);
    assert.deepEqual({ ...row }, { n: 1, channel: "staff_attested", notice: "https://example.com/aviso-de-privacidad", marketing: false });
    // The same operationId and body replays; a different body conflicts.
    const same = body("Ana");
    const first = await run(f.s.cashier, (tx) => enrollMember(tx, f.s.cashier, same));
    assert.deepEqual(await run(f.s.cashier, (tx) => enrollMember(tx, f.s.cashier, same)), JSON.parse(JSON.stringify(first)));
    await rejects(run(f.s.cashier, (tx) => enrollMember(tx, f.s.cashier, { ...same, name: "Otra" })), "operation_conflict");
    // Club off: no enrollment.
    await saveSettings(f, { enabled: false });
    await rejects(enroll(f), "loyalty_disabled");
  });

  // ------------------------------------------------------------------ L4–L8 earning
  /** A manager's amount refund of the order's first tender (recordRefund, LD-2 approval). */
  async function refundAmount(f: Fixture, orderId: string, amount: number) {
    const order = await run(f.s.manager, (tx) => getOrder(tx, orderId));
    const body = {
      mode: "amount",
      operationId: randomUUID(),
      tenderId: order.tenders[0].id,
      amount,
      expectedRefunded: order.refunded,
      reasonCode: "customer_cancelled",
      note: "",
      external: [],
    };
    const a = await approvalFor(sql, f.s.manager, undefined, "required");
    return run(f.s.manager, (tx) => recordRefund(tx, f.s.manager, orderId, body, a));
  }

  await test("L4. link, then a $150 cash payment: refreshCheckState enqueues loyalty_reconcile settle:<id>:15000 and the handler posts earn 1; $900 at a $400 threshold posts 3; rerunning the job or the reconcile posts nothing", async () => {
    const f = await clubTenant("ganar");
    const ana = await enroll(f);
    const o = await newOrder(f, [{ product: f.p.combo, quantity: 1 }]);
    const linked = await link(f, o.id, ana.id);
    assert.deepEqual([linked.earned, linked.settled, linked.linkable], [0, false, true]);
    await pay(f, o.id, 15000);
    assert.deepEqual(await jobKeys(f, o.id), [`settle:${o.id}:15000`]);
    assert.equal((await member(f, ana.id)).stamps, 0, "nothing posts inside the payment");
    assert.equal(await runJobs(f, o.id), 1);
    assert.deepEqual(await ledgerKinds(f, o.id), ["earn:1"]);
    const m = await member(f, ana.id);
    assert.deepEqual([m.stamps, m.lifetime_stamps, m.ledger_stamps], [1, 1, 1]);
    assert(m.last_activity_at, "earning is activity");
    // Redelivery: the same job again, and Vender's reconcile call, post nothing.
    await asAdmin(f.tenantId, (tx) => tx`update jobs set state='available' where kind='loyalty_reconcile' and payload->>'orderId'=${o.id}`);
    await runJobs(f, o.id);
    const view = await run(f.s.cashier, (tx) => reconcileOrderRoute(tx, f.s.cashier, o.id));
    assert.deepEqual([view.earned, view.member?.stamps, view.settled], [1, 1, true]);
    assert.deepEqual(await ledgerKinds(f, o.id), ["earn:1"]);
    const big = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await link(f, big.id, ana.id);
    await pay(f, big.id, 90000);
    await runJobs(f, big.id);
    assert.deepEqual(await ledgerKinds(f, big.id), ["earn:3"]);
    assert.equal((await member(f, ana.id)).stamps, 4);
    // A tip never counts; a table check that becomes "paid" earns from the paid branch.
    const mesa = await newOrder(f, [{ product: f.p.taco, quantity: 1 }], { table: true });
    await link(f, mesa.id, ana.id);
    await pay(f, mesa.id, 4500, { tip: 50000, method: "external" });
    assert.deepEqual(await jobKeys(f, mesa.id), [`settle:${mesa.id}:4500`]);
    await runJobs(f, mesa.id);
    assert.deepEqual(await ledgerKinds(f, mesa.id), ["earn:1"]);
  });

  await test("L5. payment, then link: the link reconciles inline; after link_window_days it is loyalty_link_window_closed; recovery and voided orders are loyalty_order_not_eligible; a deleted member is loyalty_member_deleted", async () => {
    const f = await clubTenant("despues");
    const ana = await enroll(f);
    const o = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await pay(f, o.id, 90000);
    assert.deepEqual(await jobKeys(f, o.id), [], "no member, no job");
    const v = await link(f, o.id, ana.id);
    assert.deepEqual([v.earned, v.member?.stamps], [3, 3]);
    assert.deepEqual(await ledgerKinds(f, o.id), ["earn:3"]);
    // Linking the same member again replays; another member is refused.
    const beto = await enroll(f, { name: "Beto" });
    assert.equal((await link(f, o.id, ana.id)).earned, 3);
    await rejects(link(f, o.id, beto.id), "loyalty_order_linked");
    const old = await newOrder(f, [{ product: f.p.combo, quantity: 1 }]);
    await pay(f, old.id, 15000);
    await asAdmin(f.tenantId, (tx) => tx`update tenders set created_at=now()-interval '8 days' where order_id=${old.id}`);
    await rejects(link(f, old.id, ana.id), "loyalty_link_window_closed");
    const view = await run(f.s.cashier, (tx) => getOrderLoyalty(tx, f.s.cashier, old.id));
    assert.equal(view.linkable, false);
    const recoveryId = randomUUID();
    await asAdmin(f.tenantId, (tx) => tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,state,total)
      values(${f.tenantId},${recoveryId},${900000 + Math.floor(Math.random() * 90000)},current_date,${f.ids.cashier},'takeaway','R','','pos','recovery_pending',15000)`);
    await rejects(link(f, recoveryId, ana.id), "loyalty_order_not_eligible");
    const voided = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
    await run(f.s.manager, (tx) =>
      voidLines(tx, f.s.manager, voided.id, {
        operationId: randomUUID(),
        expectedVersion: voided.version,
        lines: [{ lineId: voided.lines[0].id, quantity: 1 }],
        reason: "Pedido equivocado",
        stockDisposition: "no_return",
      }, f.ids.manager),
    );
    await rejects(link(f, voided.id, ana.id), "loyalty_order_not_eligible");
    await run(f.s.manager, (tx) =>
      deleteMember(tx, f.s.manager, beto.id, { operationId: randomUUID(), expectedVersion: 1, confirm: "ELIMINAR" }),
    );
    const fresh = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
    await rejects(link(f, fresh.id, beto.id), "loyalty_member_deleted");
    await rejects(run(f.s.kitchen, (tx) => linkOrderMember(tx, f.s.kitchen, fresh.id, { operationId: randomUUID(), memberId: ana.id })), "forbidden");
  });

  await test("L6. link and payment race on one order (both start orders, noRetries): exactly the target stamps, once", async () => {
    const f = await clubTenant("carrera");
    const ana = await enroll(f);
    let expected = 0;
    for (let i = 0; i < 6; i++) {
      const o = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
      const linkIt = () => link(f, o.id, ana.id);
      const payIt = () => pay(f, o.id, 90000);
      await noRetries(`L6 race ${i}`, () =>
        Promise.all(i % 2 ? [linkIt(), payIt()] : [payIt(), linkIt()]),
      );
      await runJobs(f, o.id);
      await run(f.s.cashier, (tx) => reconcileOrderRoute(tx, f.s.cashier, o.id));
      expected += 3;
      assert.deepEqual(
        (await ledgerKinds(f, o.id)).filter((k) => k.startsWith("earn")),
        ["earn:3"],
        `order ${i}`,
      );
    }
    const m = await member(f, ana.id);
    assert.equal(m.stamps + 10 * m.rewards, expected);
    assert.equal(m.stamps, m.ledger_stamps);
  });

  await test("L7. card completion carries overflow over (9 + 3 → 1 reward, 2 stamps); a lowered stamps_required completes on the next posting", async () => {
    const f = await clubTenant("tarjeta");
    const ana = await enroll(f);
    await giveStamps(f, ana.id, 9);
    const o = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await link(f, o.id, ana.id);
    await pay(f, o.id, 90000);
    await runJobs(f, o.id);
    assert.deepEqual(await ledgerKinds(f, o.id), ["earn:3", "reward_earned:-10"]);
    let m = await member(f, ana.id);
    assert.deepEqual([m.stamps, m.rewards, m.rewards_earned], [2, 1, 1]);
    const view = await run(f.s.cashier, (tx) => getOrderLoyalty(tx, f.s.cashier, o.id));
    assert.deepEqual([view.earned, view.completed], [3, 1]);
    const beto = await enroll(f, { name: "Beto" });
    await giveStamps(f, beto.id, 9);
    await saveSettings(f, { stampsRequired: 8 });
    assert.equal((await member(f, beto.id)).stamps, 9, "past rows never change");
    const t = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
    await link(f, t.id, beto.id);
    await pay(f, t.id, 4500);
    await runJobs(f, t.id);
    m = await member(f, beto.id);
    assert.deepEqual([m.stamps, m.rewards], [2, 1]);
  });

  await test("L8. refunds: a partial one below the threshold posts nothing, one crossing it −1, a full one reverses all; crossing a completed unredeemed card withdraws the reward; a redeemed one leaves negative stamps; both refund paths enqueue", async () => {
    const f = await clubTenant("reembolso");
    const ana = await enroll(f);
    const o = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await link(f, o.id, ana.id);
    await pay(f, o.id, 90000);
    await runJobs(f, o.id);
    await refundAmount(f, o.id, 5000); // 85000: still 3
    const keys = await jobKeys(f, o.id);
    assert.equal(keys.length, 2);
    assert.match(keys[1], /^refund:[0-9a-f-]{36}$/);
    await runJobs(f, o.id);
    assert.deepEqual(await ledgerKinds(f, o.id), ["earn:3"]);
    await refundAmount(f, o.id, 20000); // 65000: 2
    await runJobs(f, o.id);
    assert.deepEqual(await ledgerKinds(f, o.id), ["earn:3", "earn_reversal:-1"]);
    await refundAmount(f, o.id, 65000); // 0
    await runJobs(f, o.id);
    assert.deepEqual(await ledgerKinds(f, o.id), ["earn:3", "earn_reversal:-1", "earn_reversal:-2"]);
    assert.equal((await member(f, ana.id)).stamps, 0);
    // A completed card that was not used: the reward is withdrawn.
    const beto = await enroll(f, { name: "Beto" });
    await giveStamps(f, beto.id, 9);
    const c = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await link(f, c.id, beto.id);
    await pay(f, c.id, 90000);
    await runJobs(f, c.id);
    assert.deepEqual([(await member(f, beto.id)).stamps, (await member(f, beto.id)).rewards], [2, 1]);
    await refundAmount(f, c.id, 90000);
    await runJobs(f, c.id);
    let m = await member(f, beto.id);
    assert.deepEqual([m.stamps, m.rewards, m.rewards_earned], [9, 0, 0]);
    // A completed card whose reward was redeemed: negative stamps (Ajuste pendiente).
    const caro = await enroll(f, { name: "Caro" });
    await giveStamps(f, caro.id, 9);
    const d = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await link(f, d.id, caro.id);
    await pay(f, d.id, 90000);
    await runJobs(f, d.id);
    const r = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }]);
    await redeem(f, r.id, caro.id, lineOf(r, f.p.burrito));
    await refundAmount(f, d.id, 90000);
    await runJobs(f, d.id);
    m = await member(f, caro.id);
    assert.deepEqual([m.stamps, m.rewards], [-1, 0]);
    // The legacy POST /refunds path (manager, cash) enqueues too.
    const e = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await link(f, e.id, ana.id);
    await pay(f, e.id, 90000);
    await runJobs(f, e.id);
    const tender = (await run(f.s.manager, (tx) => getOrder(tx, e.id))).tenders[0].id;
    const { refund } = await import("../server/refunds.js");
    await run(f.s.manager, (tx) => refund(tx, f.s.manager, { operationId: randomUUID(), tenderId: tender, amount: 90000, reason: "Devolución", disposition: "no_stock_return" }));
    assert.equal((await jobKeys(f, e.id)).filter((k) => k.startsWith("refund:")).length, 1);
    await runJobs(f, e.id);
    assert.deepEqual(await ledgerKinds(f, e.id), ["earn:3", "earn_reversal:-3"]);
  });

  await test("L12. change member: staff on an open check; a cashier is refused after settlement; a manager with step-up moves the stamps (reversal and earn); removal", async () => {
    const f = await clubTenant("cambio");
    const ana = await enroll(f);
    const beto = await enroll(f, { name: "Beto" });
    const o = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await link(f, o.id, ana.id);
    let v = await change(f, o.id, beto.id, ana.id);
    assert.equal(v.member?.id, beto.id);
    await rejects(change(f, o.id, ana.id, ana.id), "loyalty_order_linked");
    await change(f, o.id, ana.id, beto.id);
    await pay(f, o.id, 90000);
    await runJobs(f, o.id);
    await rejects(change(f, o.id, beto.id, ana.id), "forbidden");
    await rejects(change(f, o.id, beto.id, ana.id, stale(f.s.manager)), "step_up_required");
    v = await change(f, o.id, beto.id, ana.id, f.s.manager);
    assert.deepEqual([v.member?.id, v.earned], [beto.id, 3]);
    // Rows of one reconcile are posted per member in id order: compare them as a set.
    assert.deepEqual((await ledgerKinds(f, o.id)).sort(), ["earn:3", "earn:3", "earn_reversal:-3"]);
    assert.deepEqual([(await member(f, ana.id)).stamps, (await member(f, beto.id)).stamps], [0, 3]);
    v = await change(f, o.id, null, beto.id, f.s.manager);
    assert.equal(v.member, null);
    assert.equal((await member(f, beto.id)).stamps, 0);
    const [l] = await asAdmin(f.tenantId, (tx) => tx`select member_id,changed_by from loyalty_order_links where order_id=${o.id}`);
    assert.deepEqual([l.member_id, l.changed_by], [null, f.ids.manager]);
    // A removed link takes a member again ("Agregar cliente").
    v = await link(f, o.id, ana.id, f.s.manager);
    assert.equal(v.earned, 3);
    const audit = await asAdmin(f.tenantId, (tx) => tx`select detail from audit where operation='loyalty.order.relinked' and entity_id=${o.id}`);
    assert(audit.length >= 3);
    for (const a of audit) assert.deepEqual(Object.keys(a.detail).sort(), ["from", "orderId", "to"]);
  });

  await test("L20. hook cost: a payment on an unlinked order adds exactly one statement (the link read) and no job; a linked one adds the read and one jobs insert", async () => {
    const f = await clubTenant("costo");
    const ana = await enroll(f);
    const statements: string[] = [];
    const traced = postgres(url, { max: 1, debug: (_c, q) => statements.push(q) });
    try {
      for (const linked of [false, true]) {
        const o = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
        if (linked) await link(f, o.id, ana.id);
        statements.length = 0;
        await tenant(traced, f.tenantId, (tx) =>
          recordPayment(tx, f.s.cashier, o.id, {
            operationId: randomUUID(),
            amount: 4500,
            tip: 0,
            received: 4500,
            method: "cash",
            externalConfirmed: false,
            reference: "",
          }),
        );
        const loyalty = statements.filter((q) => /loyalty_order_links|loyalty_reconcile|loyalty_/.test(q));
        assert.equal(loyalty.filter((q) => /from loyalty_order_links/.test(q)).length, 1, `link read (linked=${linked})`);
        const jobs = statements.filter((q) => /insert into jobs/.test(q));
        assert.equal(jobs.length - (linked ? 1 : 0) >= 0, true);
        assert.equal((await jobKeys(f, o.id)).length, linked ? 1 : 0);
        assert.equal(loyalty.length, 1, JSON.stringify(loyalty));
      }
    } finally {
      await traced.end();
    }
  });

  // ------------------------------------------------------------------ L10 / L11 rewards
  await test("L10. redeem: a comp of one unit within the cap, the cap as an amount above it; reason loyalty_reward with no approver; a cashier redeems with no PIN and no limit (and a later staff discount's limit ignores it); rewards −1; max per order; the reserved reason is refused by Descuento", async () => {
    const f = await clubTenant("canje");
    const ana = await enroll(f);
    await giveStamps(f, ana.id, 0, 2);
    const o = await newOrder(f, [
      { product: f.p.burrito, quantity: 2 },
      { product: f.p.molcajete, quantity: 1 },
    ]);
    // A stale terminal session: no step-up asked, no PIN, no limit (default cashier limit is 0 %).
    const r = await redeem(f, o.id, ana.id, lineOf(o, f.p.burrito), stale(f.s.cashier));
    const reward = r.order.discounts!.find((d) => d.reasonCode === "loyalty_reward")!;
    assert.deepEqual(
      [reward.kind, reward.amount, reward.units, reward.approverName, reward.note],
      ["comp", 8500, 1, null, ""],
    );
    assert.equal(r.order.total, 8500 + 21000);
    assert.equal(r.loyalty.member?.rewards, 1);
    assert.deepEqual(r.loyalty.redemptions.map((x) => [x.amount, x.restored]), [[8500, false]]);
    const [d] = await asAdmin(f.tenantId, (tx) => tx`select reason_code,approver_id,actor_id,device_id from discounts where id=${reward.id}`);
    assert.deepEqual({ ...d }, { reason_code: "loyalty_reward", approver_id: null, actor_id: f.ids.cashier, device_id: f.terminal });
    const [row] = await asAdmin(f.tenantId, (tx) => tx`select kind,rewards_delta,discount_id,order_id,actor_id from loyalty_ledger where discount_id=${reward.id}`);
    assert.deepEqual({ ...row }, { kind: "reward_redeemed", rewards_delta: -1, discount_id: reward.id, order_id: o.id, actor_id: f.ids.cashier });
    // Linked by the redemption (via pos).
    assert.equal((await run(f.s.cashier, (tx) => getOrderLoyalty(tx, f.s.cashier, o.id))).member?.id, ana.id);
    // max_rewards_per_order = 1.
    await rejects(redeem(f, o.id, ana.id, lineOf(o, f.p.molcajete)), "loyalty_reward_limit");
    // A cashier's own discount: the reward does not count against the limit (manager approves nothing).
    await asAdmin(f.tenantId, (tx) => tx`insert into money_controls(tenant_id,cashier_max_percent_bps,cashier_max_amount,server_max_percent_bps,
        server_max_amount,blind_close,expected_roles,close_roles,version,updated_by)
      values(${f.tenantId},10000,10000,0,0,false,'{manager}','{}',1,${f.ids.owner})`);
    const fresh = await run(f.s.cashier, (tx) => getOrder(tx, o.id));
    const staffBody: any = {
      operationId: randomUUID(),
      expectedVersion: fresh.version,
      scope: "line",
      lineId: lineOf(fresh, f.p.burrito),
      quantity: 1,
      kind: "comp",
      reasonCode: "courtesy",
      note: "",
    };
    Object.assign(staffBody, discountExpectation(fresh, planDiscount(fresh, staffBody)));
    const a = await approvalFor(sql, f.s.cashier, undefined, "conditional");
    const staff = await run(f.s.cashier, (tx) => applyDiscount(tx, f.s.cashier, o.id, staffBody, a));
    assert.equal(staff.discounts!.filter((x) => x.reasonCode === "courtesy").length, 1, "within the $100 cap only because the reward does not count");
    // The reserved reason through Descuento.
    const again = await run(f.s.manager, (tx) => getOrder(tx, o.id));
    await rejects(
      run(f.s.manager, (tx) => applyDiscount(tx, f.s.manager, o.id, { ...staffBody, operationId: randomUUID(), expectedVersion: again.version, reasonCode: "loyalty_reward" }, { approverId: f.ids.manager })),
      "discount_reason_reserved",
    );
    // An item above the cap: an amount discount equal to the cap.
    const m = await newOrder(f, [{ product: f.p.molcajete, quantity: 1 }]);
    const capped = await redeem(f, m.id, ana.id, lineOf(m, f.p.molcajete));
    const cd = capped.order.discounts!.find((x) => x.reasonCode === "loyalty_reward")!;
    assert.deepEqual([cd.kind, cd.amount, cd.base], ["amount", 15000, 21000]);
    assert.equal((await member(f, ana.id)).rewards, 0);
    const n = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
    await rejects(redeem(f, n.id, ana.id, lineOf(n, f.p.taco)), "loyalty_no_reward");
    await rejects(run(f.s.kitchen, (tx) => redeemReward(tx, f.s.kitchen, n.id, {})), "forbidden");
  });

  await test("L10b. concurrent redemption of a single reward on two orders (noRetries): one succeeds, the other is loyalty_no_reward; an amount reward conflicts with a check discount", async () => {
    const f = await clubTenant("canje doble");
    const ana = await enroll(f);
    await giveStamps(f, ana.id, 0, 1);
    const o1 = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }]);
    const o2 = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }]);
    const results = await noRetries("L10b", () =>
      Promise.allSettled([
        redeem(f, o1.id, ana.id, lineOf(o1, f.p.burrito)),
        redeem(f, o2.id, ana.id, lineOf(o2, f.p.burrito)),
      ]),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal(failed.reason.code, "loyalty_no_reward");
    const m = await member(f, ana.id);
    assert.deepEqual([m.rewards, m.rewards_redeemed, m.ledger_rewards], [0, 1, 0]);
    const g = await clubTenant("canje importe", { rewardKind: "amount", rewardAmount: 5000, rewardMaxAmount: null });
    const beto = await enroll(g);
    await giveStamps(g, beto.id, 0, 1);
    const o = await newOrder(g, [{ product: g.p.combo, quantity: 1 }]);
    const r = await redeem(g, o.id, beto.id);
    const d = r.order.discounts!.find((x) => x.reasonCode === "loyalty_reward")!;
    assert.deepEqual([d.scope, d.kind, d.amount], ["order", "amount", 5000]);
    await giveStamps(g, beto.id, 0, 1);
    await saveSettings(g, { rewardKind: "amount", rewardAmount: 5000, rewardMaxAmount: null, maxRewardsPerOrder: 2 });
    await rejects(redeem(g, o.id, beto.id), "loyalty_reward_conflict");
  });

  await test("L11. restoration: reverseDiscount of a reward → job → reward_restored once; a comped unit voided then the check settled → restored; an all-voided close → restored", async () => {
    const f = await clubTenant("devolver");
    const ana = await enroll(f);
    await giveStamps(f, ana.id, 0, 3);
    const o = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }, { product: f.p.taco, quantity: 1 }]);
    const r = await redeem(f, o.id, ana.id, lineOf(o, f.p.burrito));
    const discountId = r.order.discounts!.find((x) => x.reasonCode === "loyalty_reward")!.id;
    const a = await approvalFor(sql, f.s.manager, undefined, "required");
    await run(f.s.manager, (tx) =>
      reverseDiscount(tx, f.s.manager, o.id, discountId, { operationId: randomUUID(), expectedVersion: r.order.version, note: "Se equivocó de producto" }, a),
    );
    assert.deepEqual(await jobKeys(f, o.id), [`discount:${discountId}`]);
    await runJobs(f, o.id);
    await run(f.s.cashier, (tx) => reconcileOrderRoute(tx, f.s.cashier, o.id));
    assert.deepEqual(await ledgerKinds(f, o.id), ["reward_redeemed:0", "reward_restored:0"]);
    assert.equal((await member(f, ana.id)).rewards, 3);
    await rejects(
      asAdmin(f.tenantId, (tx) => tx`insert into loyalty_ledger(tenant_id,id,member_id,kind,stamps_delta,rewards_delta,order_id,discount_id)
        values(${f.tenantId},${randomUUID()},${ana.id},'reward_restored',0,1,${o.id},${discountId})`),
      // Never two restorations: the unique index, or first the rewards_redeemed CHECK.
      /loyalty_ledger_restored|23505|rewards_redeemed_check/,
    );
    // The comped unit is voided before payment; the check settles on the rest.
    const v = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }, { product: f.p.taco, quantity: 1 }]);
    const rv = await redeem(f, v.id, ana.id, lineOf(v, f.p.burrito));
    await run(f.s.manager, (tx) =>
      voidLines(tx, f.s.manager, v.id, {
        operationId: randomUUID(),
        expectedVersion: rv.order.version,
        lines: [{ lineId: lineOf(v, f.p.burrito), quantity: 1 }],
        reason: "No lo quiso",
        stockDisposition: "no_return",
      }, f.ids.manager),
    );
    await pay(f, v.id, 4500);
    await runJobs(f, v.id);
    assert.deepEqual(await ledgerKinds(f, v.id), ["reward_redeemed:0", "earn:1", "reward_restored:0"]);
    // Every line voided: the check closes voided and the reward returns.
    const w = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }]);
    const rw = await redeem(f, w.id, ana.id, lineOf(w, f.p.burrito));
    assert.equal(rw.order.checkState, "closed", "a reward that pays the whole takeaway closes it");
    const x = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }, { product: f.p.taco, quantity: 1 }], { table: true });
    const rx = await redeem(f, x.id, ana.id, lineOf(x, f.p.burrito));
    await run(f.s.manager, (tx) =>
      voidLines(tx, f.s.manager, x.id, {
        operationId: randomUUID(),
        expectedVersion: rx.order.version,
        lines: x.lines.map((l) => ({ lineId: l.id, quantity: 1 })),
        reason: "Se fueron",
        stockDisposition: "no_return",
      }, f.ids.manager),
    );
    assert.deepEqual(await jobKeys(f, x.id), [`void:${x.id}`]);
    await runJobs(f, x.id);
    assert.deepEqual(await ledgerKinds(f, x.id), ["reward_redeemed:0", "reward_restored:0"]);
  });

  // ------------------------------------------------------------------ L13–L15 members, ARCO, retention
  await test("L13. adjust: step-up on a terminal; below zero refused; a full card completes; the audit detail holds ids, counts and field names, never a name or phone", async () => {
    const f = await clubTenant("ajuste");
    const ana = await enroll(f, { name: "Ana Zúñiga", phone: "5544332211" });
    const body = { operationId: randomUUID(), stamps: 2, reason: "correction", note: "Corrección de caja" };
    await rejects(run(stale(f.s.manager), (tx) => adjustMember(tx, stale(f.s.manager), ana.id, body)), "step_up_required");
    await rejects(run(f.s.cashier, (tx) => adjustMember(tx, f.s.cashier, ana.id, body)), "forbidden");
    let d = await run(f.s.manager, (tx) => adjustMember(tx, f.s.manager, ana.id, body));
    assert.equal(d.stamps, 2);
    await rejects(
      run(f.s.manager, (tx) => adjustMember(tx, f.s.manager, ana.id, { operationId: randomUUID(), stamps: -3, reason: "correction", note: "Error" })),
      "loyalty_adjust_below_zero",
    );
    await rejects(
      run(f.s.manager, (tx) => adjustMember(tx, f.s.manager, ana.id, { operationId: randomUUID(), rewards: -1, reason: "correction", note: "Error" })),
      "loyalty_no_reward",
    );
    d = await run(f.s.manager, (tx) => adjustMember(tx, f.s.manager, ana.id, { operationId: randomUUID(), stamps: 9, reason: "goodwill", note: "Cortesía" }));
    assert.deepEqual([d.stamps, d.rewards], [1, 1]);
    assert.deepEqual(d.history.slice(0, 2).map((h) => h.kind).sort(), ["adjustment", "reward_earned"]);
    // Rectification: name, phone, marketing; a phone in use is loyalty_phone_taken.
    const beto = await enroll(f, { name: "Beto", phone: "5544332299" });
    await rejects(
      run(f.s.manager, (tx) => updateMember(tx, f.s.manager, ana.id, { operationId: randomUUID(), expectedVersion: d.version, phone: "5544332299", country: "MX" })),
      "loyalty_phone_taken",
    );
    const u = await run(f.s.manager, (tx) => updateMember(tx, f.s.manager, ana.id, { operationId: randomUUID(), expectedVersion: d.version, name: "Ana María", marketingOptIn: true }));
    assert.deepEqual([u.name, u.marketingOptIn, u.version], ["Ana María", true, d.version + 1]);
    await rejects(
      run(f.s.manager, (tx) => updateMember(tx, f.s.manager, ana.id, { operationId: randomUUID(), expectedVersion: d.version, name: "Otra" })),
      "loyalty_member_changed",
    );
    const audits = await asAdmin(f.tenantId, (tx) => tx`select operation,detail::text as detail from audit where tenant_id=${f.tenantId} and operation like 'loyalty.%'`);
    assert(audits.length >= 5);
    for (const a of audits) {
      assert.doesNotMatch(a.detail, /Ana|Zúñiga|María|Beto|5544332211|5544332299|4433/, a.operation);
    }
    // Staff search by name: ≥ 3 letters, accents folded, masked phones only.
    const found = await run(f.s.cashier, (tx) => searchByName(tx, f.s.cashier, { q: "maria" }));
    assert.deepEqual(found.map((x) => [x.id, x.maskedPhone]), [[ana.id, "···· 2211"]]);
    assert.deepEqual(await run(f.s.cashier, (tx) => searchByName(tx, f.s.cashier, { q: "an" })), []);
    // Detail for managers only; the printable ARCO sheet needs step-up.
    await rejects(run(f.s.cashier, (tx) => memberDetail(tx, f.s.cashier, ana.id)), "forbidden");
    await rejects(run(stale(f.s.manager), (tx) => memberDataSheet(tx, stale(f.s.manager), ana.id)), "step_up_required");
    const sheet = await run(f.s.manager, (tx) => memberDataSheet(tx, f.s.manager, ana.id));
    assert.deepEqual([sheet.phone, sheet.consentChannel, sheet.history.length >= 3], ["+525544332211", "staff_attested", true]);
    const updated = audits.find((a: any) => a.operation === "loyalty.member.updated");
    assert.deepEqual(JSON.parse(updated.detail), { memberId: ana.id, fields: ["name", "marketingOptIn"] });
    assert(beto.id);
  });

  await test("L14. delete (ARCO): the redaction shape; later link and ledger posts are loyalty_member_deleted; the owner export of the member holds no name or phone; lookups never find it", async () => {
    const f = await clubTenant("arco");
    const phone = newPhone();
    const ana = await enroll(f, { phone, name: "Ana Borrable" });
    await giveStamps(f, ana.id, 4);
    await rejects(
      run(f.s.manager, (tx) => deleteMember(tx, f.s.manager, ana.id, { operationId: randomUUID(), expectedVersion: 1, confirm: "BORRAR" })),
      "invalid_input",
    );
    await rejects(
      run(stale(f.s.owner), (tx) => deleteMember(tx, stale(f.s.owner), ana.id, { operationId: randomUUID(), expectedVersion: 1, confirm: "ELIMINAR" })),
      "step_up_required",
    );
    const d = await run(f.s.owner, (tx) => deleteMember(tx, f.s.owner, ana.id, { operationId: randomUUID(), expectedVersion: 1, confirm: "ELIMINAR" }));
    assert.deepEqual([d.name, d.phone, d.deleted, d.redactionReason, d.marketingOptIn, d.consentNoticeUrl], ["", null, true, "arco", false, null]);
    assert.equal(d.stamps, 4, "balances are frozen, not erased");
    const o = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
    await rejects(link(f, o.id, ana.id), "loyalty_member_deleted");
    await rejects(giveStamps(f, ana.id, 1), "loyalty_member_deleted");
    await rejects(
      asAdmin(f.tenantId, (tx) => tx`insert into loyalty_ledger(tenant_id,id,member_id,kind,stamps_delta,rewards_delta,reason,note,actor_id)
        values(${f.tenantId},${randomUUID()},${ana.id},'adjustment',1,0,'other','prueba',${f.ids.owner})`),
      /loyalty_member_deleted/,
    );
    assert.equal(await run(f.s.cashier, (tx) => lookupByPhone(tx, f.s.cashier, { phone, country: "MX" })), null);
    const list = await run(f.s.manager, (tx) => listMembers(tx, f.s.manager, {}));
    assert.equal(list.rows.some((r) => r.id === ana.id), false);
    const tables = await run(f.s.owner, (tx) => exportTables(tx));
    const t = tables.find((x) => x.name === "loyalty_members")!;
    assert(t, "the owner export includes loyalty_members");
    for (const name of ["loyalty_ledger", "loyalty_order_links", "loyalty_settings"])
      assert(tables.some((x) => x.name === name), name);
    const rows = await asAdmin(f.tenantId, (tx) => tx.unsafe(`select ${t.columns.join(",")} from loyalty_members where id=$1`, [ana.id]));
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(`Borrable|${phone}`));
    const audit = await asAdmin(f.tenantId, (tx) => tx`select detail from audit where operation='loyalty.member.deleted' and entity_id=${ana.id}`);
    assert.deepEqual(audit[0].detail, { memberId: ana.id, reason: "arco" });
  });

  await test("L15. retention: a member inactive 25 months is redacted, one at 23 months is not; an imported member whose last pos-lite visit is old is redacted on the next pass; nothing is deleted; it runs as the schema owner under the NO FORCE pattern", async () => {
    const f = await clubTenant("retencion");
    const ids = { old: randomUUID(), recent: randomUUID(), imported: randomUUID() };
    await asAdmin(f.tenantId, async (tx) => {
      await tx`insert into loyalty_members(tenant_id,id,phone_e164,name,name_key,joined_at,joined_via,joined_by,consent_channel,consent_at)
        values(${f.tenantId},${ids.old},${"+52" + newPhone()},'Viejo','viejo',now()-interval '25 months','pos',${f.ids.cashier},'staff_attested',now()-interval '25 months'),
              (${f.tenantId},${ids.recent},${"+52" + newPhone()},'Reciente','reciente',now()-interval '23 months','pos',${f.ids.cashier},'staff_attested',now()-interval '23 months')`;
      await tx`insert into loyalty_members(tenant_id,id,phone_e164,name,name_key,joined_at,joined_via,consent_channel,consent_at,
          legacy_source,legacy_id,legacy_last_visit_at)
        values(${f.tenantId},${ids.imported},${"+52" + newPhone()},'Importado','importado',now()-interval '40 months','import','pos_lite_import',
          now()-interval '40 months','pos-lite',${"r-" + ids.imported.slice(0, 8)},now()-interval '30 months')`;
      await tx`insert into loyalty_ledger(tenant_id,id,member_id,kind,stamps_delta,rewards_delta,actor_id,reason)
        values(${f.tenantId},${randomUUID()},${ids.imported},'import',3,0,${f.ids.owner},'pos_lite_balance')`;
    });
    assert.equal((await member(f, ids.imported)).last_activity_at, null, "an import is not activity");
    const before = await asAdmin(f.tenantId, (tx) => tx`select count(*)::int as n from loyalty_ledger where tenant_id=${f.tenantId}`);
    const result = await runRetention(admin, { pauseMs: 0 });
    assert.deepEqual(result.failed, []);
    assert(result.redacted.loyalty_members >= 2);
    const [old, recent, imported] = await Promise.all([member(f, ids.old), member(f, ids.recent), member(f, ids.imported)]);
    assert(old.redacted_at && imported.redacted_at && !recent.redacted_at);
    assert.deepEqual([old.name, old.phone_e164, imported.stamps], ["", null, 3]);
    const [r] = await asAdmin(f.tenantId, (tx) => tx`select redaction_reason,redacted_by from loyalty_members where id=${ids.old}`);
    assert.deepEqual({ ...r }, { redaction_reason: "retention", redacted_by: null });
    const after = await asAdmin(f.tenantId, (tx) => tx`select count(*)::int as n from loyalty_ledger where tenant_id=${f.tenantId}`);
    assert.equal(after[0].n, before[0].n);
    const [forced] = await admin`select relforcerowsecurity as f from pg_class where relname='loyalty_members'`;
    assert.equal(forced.f, true);
  });

  // ------------------------------------------------------------------ L17 import
  await test("L17. import: the export SQL reads pos-lite's tables; pages commit and replay; a partial mapping is refused; refused while the club is on or for another restaurant; totals equal the fixture's; mappings and the batch are written; import rows are not activity", async () => {
    const f = await makeTenant("importar");
    await saveSettings(f, { enabled: false, privacyAttested: false });
    // The operator's export, run on pos-lite-shaped temporary tables (no pos-lite database).
    const exportSql = readFileSync("scripts/loyalty/poslite-export.sql", "utf8");
    const select = exportSql
      .slice(exportSql.indexOf("BEGIN READ ONLY;") + "BEGIN READ ONLY;".length, exportSql.lastIndexOf("COMMIT;"))
      .replaceAll(":'tenant'", "'px'")
      .replaceAll(":'target'", `'${f.tenantId}'`);
    const exported = await admin.begin(async (tx) => {
      await tx.unsafe(`create temp table loyalty_customers(id serial primary key, tenant_id text, phone text, country_code text,
          name text, sms_opt_in boolean, created_at timestamptz, last_visit timestamptz, orders_count int, total_spent numeric(10,2)) on commit drop;
        create temp table stamp_cards(id serial primary key, tenant_id text, customer_id int, stamps_earned int, stamps_required int,
          completed boolean, redeemed boolean, completed_at timestamptz) on commit drop;
        create temp table loyalty_config(tenant_id text, key text, value text) on commit drop;
        insert into loyalty_customers(tenant_id,phone,country_code,name,sms_opt_in,created_at,last_visit,orders_count,total_spent) values
          ('px','5550002001','MX','Uno',true,'2025-01-01','2026-09-01',3,300.5),
          ('px','5550002002','MX','Dos',false,'2025-02-01','2026-09-30',12,1200),
          ('other','5550002003','MX','Ajeno',true,'2025-01-01','2026-09-01',1,10);
        insert into stamp_cards(tenant_id,customer_id,stamps_earned,stamps_required,completed,redeemed,completed_at) values
          ('px',1,4,10,false,false,null),
          ('px',2,10,10,true,false,'2026-09-30'),
          ('other',3,5,10,false,false,null);
        insert into loyalty_config values ('px','stamps_required','10'),('px','stamp_bonus_threshold','400'),('px','sms_enabled','true');`);
      const [row] = await tx.unsafe(select);
      return Object.values(row)[0];
    });
    const parsed = posLiteExport.parse(exported);
    assert.deepEqual(parsed.summary, { members: 2, activeCardStamps: 4, completedCards: 1, completedUnredeemed: 1 });
    assert.deepEqual(parsed.members.map((m) => [m.name, m.next_card_stamps, m.completed_cards.length]), [["Uno", 4, 0], ["Dos", 0, 1]]);
    assert.equal(parsed.targetTenantId, f.tenantId);
    // The fixture file, as the owner uploads it.
    const file = posLiteExport.parse({
      ...JSON.parse(readFileSync("tests/fixtures/poslite-loyalty-export.json", "utf8")),
      targetTenantId: f.tenantId,
      sourceTenantId: "fixture-" + f.tenantId.slice(0, 8),
    });
    const preview = previewLoyaltyImport(file, { policy: "recent", now: Date.parse("2026-10-09T18:00:00Z"), stampsRequired: 10 });
    assert.equal(preview.fileSummaryOk, true);
    const pages = importPages(preview.accepted, 4);
    const batchHash = createHash("sha256").update(JSON.stringify(file)).digest("hex");
    const commit = (page: number, rows = pages[page], s: Session = f.s.owner, target = f.tenantId) =>
      run(s, (tx) =>
        commitLoyaltyImportPage(tx, s, {
          batchHash,
          sourceTenantId: file.sourceTenantId,
          targetTenantId: target,
          policy: "recent",
          page,
          pages: pages.length,
          rows,
        }),
      );
    await rejects(commit(0, pages[0], f.s.owner, randomUUID()), "loyalty_import_scope");
    await rejects(commit(0, pages[0], f.s.cashier), "forbidden");
    await rejects(commit(0, pages[0], stale(f.s.owner)), "step_up_required");
    const first = await commit(0);
    assert.deepEqual([first.imported, first.replayed], [4, false]);
    assert.deepEqual([(await commit(0)).replayed, (await commit(0)).imported], [true, 0]);
    await rejects(commit(1, [...pages[1], pages[0][0]]), "import_existing_mapping");
    const second = await commit(1);
    assert.equal(second.imported, 2);
    const status = await run(f.s.owner, (tx) => importStatus(tx, f.s.owner, first.batchId));
    assert.deepEqual(importVerified(preview, status), []);
    assert.deepEqual(status, { batchId: first.batchId, ...preview.expected });
    const [b] = await asAdmin(f.tenantId, (tx) => tx`select count(*)::int as n from import_batches where source='pos-lite-loyalty' and file_hash=${batchHash}`);
    assert.equal(b.n, 1);
    const [mp] = await asAdmin(f.tenantId, (tx) => tx`select count(*)::int as n from source_mappings where import_batch_id=${first.batchId} and entity_type='loyalty_member'`);
    assert.equal(mp.n, 6);
    const imported = await asAdmin(f.tenantId, (tx) => tx`select consent_channel,joined_via,marketing_opt_in,legacy_sms_opt_in,last_activity_at,legacy_spend
      from loyalty_members where tenant_id=${f.tenantId} and legacy_id='101'`);
    assert.deepEqual({ ...imported[0], legacy_spend: Number(imported[0].legacy_spend) }, {
      consent_channel: "pos_lite_import",
      joined_via: "import",
      marketing_opt_in: false,
      legacy_sms_opt_in: true,
      last_activity_at: null,
      legacy_spend: 123450,
    });
    await saveSettings(f);
    await rejects(commit(0), "loyalty_import_after_enable");
  });

  // ------------------------------------------------------------------ L18 / L19 join page and kiosk
  await test("L18. join page: wrong purpose or tenant → 401, an expired code → 410; GET returns no member data; POST creates the member and link and returns counts only; another phone is loyalty_order_linked; an unpaid order is pending, then the settle earns", async () => {
    const f = await clubTenant("unirse");
    const o = await newOrder(f, [{ product: f.p.combo, quantity: 1 }]);
    const token = seal("loyalty-join", { t: f.tenantId, o: o.id }, { ttlSeconds: 3600 });
    const view = await joinView(sql, token);
    assert.deepEqual(Object.keys(view).sort(), ["businessDate", "linked", "orderNumber", "privacyUrl", "programName", "restaurantName", "rewardDescription", "stampsRequired"]);
    assert.deepEqual([view.linked, view.programName, view.privacyUrl], [false, "Club Taquería Lealtad", "https://example.com/aviso-de-privacidad"]);
    await rejects(joinView(sql, seal("cfdi-portal", { t: f.tenantId, o: o.id }, { ttlSeconds: 60 })), "unauthorized");
    await rejects(joinView(sql, seal("loyalty-join", { t: B.tenantId, o: o.id }, { ttlSeconds: 60 })), "unauthorized");
    const brief = seal("loyalty-join", { t: f.tenantId, o: o.id }, { ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 2100));
    await rejects(joinView(sql, brief), "loyalty_join_expired");
    const body = (phone: string, name = "Diana") => ({ phone, country: "MX", name, privacyAccepted: true, marketingOptIn: false });
    await rejects(joinOrder(sql, token, { ...body(newPhone()), privacyAccepted: false }), "loyalty_consent_required");
    const phone = newPhone();
    const r = await joinOrder(sql, token, body(phone));
    assert.deepEqual(r, { stampsAdded: 0, stamps: 0, required: 10, rewards: 0, pending: true });
    const [m] = await asAdmin(f.tenantId, (tx) => tx`select m.joined_via,m.consent_channel,m.consent_notice_url,m.joined_by,l.via,l.linked_by
      from loyalty_members m join loyalty_order_links l on l.member_id=m.id where m.phone_e164=${"+52" + phone}`);
    assert.deepEqual({ ...m }, { joined_via: "join_qr", consent_channel: "self_service", consent_notice_url: "https://example.com/aviso-de-privacidad", joined_by: null, via: "join_qr", linked_by: null });
    await rejects(joinOrder(sql, token, body(newPhone())), "loyalty_order_linked");
    assert.equal((await joinView(sql, token)).linked, true);
    await pay(f, o.id, 15000);
    await runJobs(f, o.id);
    const again = await joinOrder(sql, token, body(phone, "Otro nombre"));
    assert.deepEqual(again, { stampsAdded: 1, stamps: 1, required: 10, rewards: 0, pending: false });
    // An existing member's name is never overwritten from this page.
    const ana = await enroll(f, { name: "Ana Caja" });
    const p2 = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
    await pay(f, p2.id, 4500);
    const t2 = seal("loyalty-join", { t: f.tenantId, o: p2.id }, { ttlSeconds: 3600 });
    const anaPhone = (await asAdmin(f.tenantId, (tx) => tx`select phone_e164 from loyalty_members where id=${ana.id}`))[0].phone_e164.slice(3);
    const joined = await joinOrder(sql, t2, body(anaPhone, "Impostor"));
    assert.deepEqual([joined.stampsAdded, joined.pending], [1, false]);
    assert.equal((await member(f, ana.id)).name, "Ana Caja");
    // Receipts: a linked order prints counts (no name), an unlinked one within its window a join token.
    const printed = await run(f.s.cashier, (tx) => receiptLoyalty(tx, f.s.cashier, p2.id));
    assert.deepEqual(printed, { kind: "member", programName: "Club Taquería Lealtad", stamps: 1, required: 10, rewards: 0, rewardDescription: "Un producto gratis" });
    const p3 = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
    await pay(f, p3.id, 4500);
    const qr = await run(f.s.cashier, (tx) => receiptLoyalty(tx, f.s.cashier, p3.id));
    assert.equal(qr.kind, "join");
    if (qr.kind === "join") assert.equal((await joinView(sql, qr.token)).orderNumber, p3.number);
  });

  await test("L19. kiosk (R20–R23): config; a lookup returns counts and a masked phone only, with a member token bound to tenant and station; memberFromToken refuses another station, tenant or a deleted member; linkFromKiosk inside the order's transaction, then the settle earns; joinUrlForOrder", async () => {
    const f = await clubTenant("kiosco");
    const phone = newPhone();
    const ana = await enroll(f, { phone, name: "Ana Kiosco" });
    await giveStamps(f, ana.id, 6);
    const station = randomUUID();
    assert.deepEqual(await run(f.s.owner, (tx) => loyaltyKioskConfig(tx)), { enabled: true, stampsRequired: 10, rewardLabel: "Un producto gratis" });
    const found = await run(f.s.owner, (tx) => lookupMemberForKiosk(tx, { phone, country: "MX" }, { stationId: station }));
    assert(found.found);
    assert.deepEqual(Object.keys(found).sort(), ["found", "maskedPhone", "memberToken", "required", "rewards", "stamps"]);
    assert.deepEqual([found.stamps, found.required, found.maskedPhone], [6, 10, "···· " + phone.slice(-4)]);
    assert.doesNotMatch(JSON.stringify(found), /Ana|Kiosco/);
    assert.deepEqual(await run(f.s.owner, (tx) => lookupMemberForKiosk(tx, { phone: newPhone(), country: "MX" }, { stationId: station })), { found: false });
    const id = await run(f.s.owner, (tx) => memberFromToken(tx, found.memberToken, { tenantId: f.tenantId, stationId: station }));
    assert.equal(id, ana.id);
    await rejects(run(f.s.owner, (tx) => memberFromToken(tx, found.memberToken, { tenantId: f.tenantId, stationId: randomUUID() })), "loyalty_member_token_invalid");
    await rejects(run(B.s.owner, (tx) => memberFromToken(tx, found.memberToken, { tenantId: B.tenantId, stationId: station })), "loyalty_member_token_invalid");
    await rejects(run(f.s.owner, (tx) => memberFromToken(tx, "v2.x.y.z", { tenantId: f.tenantId, stationId: station })), "loyalty_member_token_invalid");
    // A stub acceptance: the order and its link in one transaction, before any tender or refresh.
    const order = await run(f.s.cashier, async (tx) => {
      const o = await createOrder(tx, f.s.cashier, {
        operationId: randomUUID(),
        lines: [{ id: randomUUID(), productId: f.p.banquete, quantity: 1, options: [], note: "" }],
        mode: "takeaway",
        tableId: null,
        name: "Kiosco",
        note: "",
        channel: "kiosk",
      });
      await linkFromKiosk(tx, f.s.cashier, o.id, await memberFromToken(tx, found.memberToken, { tenantId: f.tenantId, stationId: station }));
      await linkFromKiosk(tx, f.s.cashier, o.id, ana.id);
      return o;
    });
    const url = await run(f.s.cashier, (tx) => joinUrlForOrder(tx, order.id));
    assert.equal(url, null, "a linked order offers no join");
    await pay(f, order.id, 90000);
    await runJobs(f, order.id);
    const v = await run(f.s.cashier, (tx) => orderLoyaltyView(tx, order.id));
    assert.deepEqual([v.via, v.earned, v.member?.stamps, v.member?.rewards], ["kiosk", 3, 9, 0]);
    const other = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
    const offer = await run(f.s.cashier, (tx) => joinUrlForOrder(tx, other.id));
    assert.match(offer!.url, /\/club#v2\./);
    await run(f.s.manager, (tx) => deleteMember(tx, f.s.manager, ana.id, { operationId: randomUUID(), expectedVersion: 1, confirm: "ELIMINAR" }));
    await rejects(run(f.s.owner, (tx) => memberFromToken(tx, issueKioskMemberToken(f.tenantId, ana.id, station), { tenantId: f.tenantId, stationId: station })), "loyalty_member_token_invalid");
  });

  // ------------------------------------------------------------------ L16 burst
  await test("L16. lock-order burst under noRetries, zero deadlocks: links, payments, settlements of table checks, refunds, redemptions, reward reversals, member changes, reconcile jobs and linkFromKiosk inside a stub acceptance", async () => {
    const f = await clubTenant("rafaga");
    const members: MemberSummary[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await enroll(f, { name: "Socio " + i });
      await giveStamps(f, m.id, 0, 3);
      members.push(m);
    }
    const paid: Order[] = [];
    for (let i = 0; i < 4; i++) {
      const o = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
      await link(f, o.id, members[i].id);
      await pay(f, o.id, 90000);
      paid.push(o);
    }
    const redeemed: { order: Order; discountId: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const o = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }, { product: f.p.taco, quantity: 1 }], { table: i === 0 });
      const r = await redeem(f, o.id, members[i].id, lineOf(o, f.p.burrito));
      redeemed.push({ order: r.order, discountId: r.order.discounts!.find((x) => x.reasonCode === "loyalty_reward")!.id });
    }
    const fresh = await Promise.all(Array.from({ length: 6 }, () => newOrder(f, [{ product: f.p.combo, quantity: 1 }, { product: f.p.burrito, quantity: 1 }])));
    const a = await approvalFor(sql, f.s.manager, undefined, "required");
    await noRetries("L16 burst", () =>
      Promise.all([
        // Link and pay the same orders from two terminals.
        ...fresh.slice(0, 3).flatMap((o, i) => [link(f, o.id, members[i].id), pay(f, o.id, 23500)]),
        // Redeem while the same member is linked elsewhere.
        redeem(f, fresh[3].id, members[0].id, lineOf(fresh[3], f.p.burrito)),
        link(f, fresh[4].id, members[0].id),
        change(f, fresh[5].id, members[1].id, null),
        // Refunds of paid, linked orders, and their reconcile jobs.
        ...paid.slice(0, 2).map((o) => refundAmount(f, o.id, 50000)),
        ...paid.map((o) => runJobs(f, o.id)),
        // Reward reversals.
        ...redeemed.map((r) =>
          run(f.s.manager, (tx) =>
            reverseDiscount(tx, f.s.manager, r.order.id, r.discountId, { operationId: randomUUID(), expectedVersion: r.order.version, note: "Reversión de prueba" }, a),
          ),
        ),
        // A kiosk acceptance: create, link, pay.
        (async () => {
          const o = await run(f.s.server, async (tx) => {
            const created = await createOrder(tx, f.s.server, {
              operationId: randomUUID(),
              lines: [{ id: randomUUID(), productId: f.p.combo, quantity: 1, options: [], note: "" }],
              mode: "takeaway",
              tableId: null,
              name: "Kiosco",
              note: "",
              channel: "kiosk",
            });
            await linkFromKiosk(tx, f.s.server, created.id, members[2].id);
            return created;
          });
          await pay(f, o.id, 15000, { s: f.s.server });
          return runJobs(f, o.id);
        })(),
        // Reconciles of everything at once.
        ...[...paid, ...fresh].map((o) => run(f.s.cashier, (tx) => reconcileOrder(tx, f.tenantId, o.id)).catch((e) => {
          if (e.code !== "loyalty_retry") throw e;
        })),
      ]),
    );
    for (const o of [...paid, ...fresh, ...redeemed.map((r) => r.order)]) await runJobs(f, o.id);
    for (const m of members) {
      const row = await member(f, m.id);
      assert.deepEqual([row.stamps, row.rewards], [row.ledger_stamps, row.ledger_rewards], m.firstName);
    }
    const report = await run(f.s.owner, (tx) => loyaltyReport(tx, f.s.owner, { from: "2000-01-01", to: "2099-12-31" }).catch(() => null));
    assert.equal(report, null, "the report range is bounded (92 days)");
  });

  // ------------------------------------------------------------------ report
  await test("Report: Finanzas › Club de lealtad figures for the day, from one snapshot, with the ledger-vs-members check", async () => {
    const f = await clubTenant("reporte");
    const ana = await enroll(f, { name: "Ana Reporte" });
    const beto = await enroll(f, { name: "Beto Reporte" });
    await giveStamps(f, ana.id, 9);
    const o = await newOrder(f, [{ product: f.p.banquete, quantity: 1 }]);
    await link(f, o.id, ana.id);
    await pay(f, o.id, 90000);
    await runJobs(f, o.id);
    const r = await newOrder(f, [{ product: f.p.burrito, quantity: 1 }, { product: f.p.taco, quantity: 1 }]);
    await redeem(f, r.id, ana.id, lineOf(r, f.p.burrito));
    await pay(f, r.id, 4500);
    await runJobs(f, r.id);
    const unlinked = await newOrder(f, [{ product: f.p.combo, quantity: 1 }]);
    await pay(f, unlinked.id, 15000);
    const day = (await run(f.s.owner, (tx) => getOrder(tx, o.id))).businessDate!;
    const { snapshotTenant } = await import("../server/reports/snapshot.js");
    const rep = await snapshotTenant(sql, f.tenantId, (tx) => loyaltyReport(tx, f.s.owner, { from: day, to: day }));
    assert.deepEqual(rep.members, { total: 2, new: 2, imported: 0, active: 1 });
    assert.deepEqual(rep.stamps, { earned: 4, reversed: 0, adjusted: 9 });
    assert.deepEqual([rep.rewards.earned, rep.rewards.redeemed, rep.rewards.value, rep.rewards.rateBps], [1, 1, 8500, 10000]);
    assert.deepEqual(rep.sales, { members: 94500, total: 109500, shareBps: Math.round((94500 * 10000) / 109500) });
    assert.deepEqual(rep.top.map((t) => [t.name, t.visits, t.spend]), [["Ana Reporte", 2, 94500]]);
    assert.equal(rep.mismatches, 0);
    await rejects(snapshotTenant(sql, f.tenantId, (tx) => loyaltyReport(tx, f.s.cashier, { from: day, to: day })), "forbidden");
    assert(beto.id);
  });

  // ------------------------------------------------------------------ H1 HTTP
  await test("H1. HTTP: kitchen → 403 on every staff route; the cashier/manager matrix; operationId replays and conflicts; /api/club is no-store, screens malformed tokens before any database work and limits per IP and per (IP, token); log lines never hold a phone", async () => {
    const f = await clubTenant("http");
    resetLookupBudget();
    const app = express();
    app.set("trust proxy", "loopback");
    app.use(express.json({ limit: "256kb" }));
    const { requestLog } = await import("../server/logging.js");
    app.use(requestLog());
    app.use("/api/club", clubRouter(sql));
    let who: Session = f.s.kitchen;
    app.use("/api", (req, _res, next) => {
      (req as unknown as { session: Session }).session = who;
      next();
    });
    registerLoyalty({ app, sql, route: makeRoute(app, sql) });
    app.use(apiErrorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = async (method: "GET" | "POST", path: string, o: { body?: unknown; token?: string; ip?: string } = {}) => {
      const ip = o.ip ?? `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
      const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": ip, "x-forwarded-for": `${ip}, 192.0.2.84` };
      if (o.token !== undefined) headers[JOIN_HEADER] = o.token;
      const r = await fetch(origin + path, { method, headers, body: method === "POST" ? JSON.stringify(o.body ?? {}) : undefined });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
    };
    try {
      const phone = newPhone();
      const ana = await enroll(f, { phone });
      const o = await newOrder(f, [{ product: f.p.taco, quantity: 1 }]);
      const id = randomUUID();
      const routes: ["GET" | "POST", string][] = [
        ["GET", "/api/loyalty/settings"],
        ["POST", "/api/loyalty/settings"],
        ["POST", "/api/loyalty/members/lookup"],
        ["POST", "/api/loyalty/members/search"],
        ["POST", "/api/loyalty/members/list"],
        ["POST", "/api/loyalty/members"],
        ["GET", `/api/loyalty/members/${ana.id}`],
        ["GET", `/api/loyalty/members/${ana.id}/sheet`],
        ["POST", `/api/loyalty/members/${ana.id}/update`],
        ["POST", `/api/loyalty/members/${ana.id}/adjust`],
        ["POST", `/api/loyalty/members/${ana.id}/delete`],
        ["GET", `/api/loyalty/orders/${o.id}`],
        ["POST", `/api/loyalty/orders/${o.id}/member`],
        ["POST", `/api/loyalty/orders/${o.id}/member/change`],
        ["POST", `/api/loyalty/orders/${o.id}/reconcile`],
        ["POST", `/api/loyalty/orders/${o.id}/reward`],
        ["GET", `/api/loyalty/orders/${o.id}/receipt`],
        ["POST", "/api/loyalty/import/commit"],
        ["GET", `/api/loyalty/import/${id}`],
        ["GET", "/api/loyalty/report?from=2026-10-01&to=2026-10-02"],
      ];
      for (const [method, path] of routes) {
        const r = await call(method, path, { body: { operationId: randomUUID() } });
        assert.deepEqual([r.status, r.body?.error], [403, "forbidden"], `${method} ${path}`);
      }
      // Cashier: lookup yes, Clientes and settings writes no.
      who = f.s.cashier;
      const found = await call("POST", "/api/loyalty/members/lookup", { body: { phone, country: "MX" } });
      assert.deepEqual([found.status, found.body.id, found.body.maskedPhone], [200, ana.id, "···· " + phone.slice(-4)]);
      assert.equal(JSON.stringify(found.body).includes(phone), false);
      for (const [method, path] of [
        ["POST", "/api/loyalty/members/list"],
        ["GET", `/api/loyalty/members/${ana.id}`],
        ["POST", `/api/loyalty/members/${ana.id}/adjust`],
        ["POST", "/api/loyalty/settings"],
        ["GET", "/api/loyalty/report?from=2026-10-01&to=2026-10-02"],
      ] as const) {
        const r = await call(method, path, { body: { operationId: randomUUID() } });
        assert.deepEqual([r.status, r.body?.error], [403, "forbidden"], `cashier ${method} ${path}`);
      }
      const linkBody = { operationId: randomUUID(), memberId: ana.id };
      const l1 = await call("POST", `/api/loyalty/orders/${o.id}/member`, { body: linkBody });
      const l2 = await call("POST", `/api/loyalty/orders/${o.id}/member`, { body: linkBody });
      assert.deepEqual([l1.status, l2.status], [200, 200]);
      assert.deepEqual(l2.body, l1.body);
      const l3 = await call("POST", `/api/loyalty/orders/${o.id}/member`, { body: { ...linkBody, memberId: randomUUID() } });
      assert.deepEqual([l3.status, l3.body.error], [409, "operation_conflict"]);
      who = f.s.manager;
      const list = await call("POST", "/api/loyalty/members/list", { body: { q: phone.slice(-4) } });
      assert.deepEqual([list.status, list.body.rows.length], [200, 1]);
      // /api/club: no-store, screened, limited.
      const token = seal("loyalty-join", { t: f.tenantId, o: o.id }, { ttlSeconds: 3600 });
      const g = await call("GET", "/api/club/join", { token });
      assert.equal(g.status, 200);
      assert.equal(g.headers.get("cache-control"), "no-store");
      const bad = await call("GET", "/api/club/join", { token: "not-a-token" });
      assert.deepEqual([bad.status, bad.body.error, bad.headers.get("cache-control")], [401, "unauthorized", "no-store"]);
      // Malformed tokens never reach the database: a router over a pool that throws.
      const touched: string[] = [];
      const poison = { begin: async () => { touched.push("db"); throw new Error("touched"); } } as unknown as postgres.Sql;
      const screened = express();
      screened.set("trust proxy", "loopback");
      screened.use(express.json());
      screened.use("/api/club", clubRouter(poison));
      screened.use(apiErrorHandler);
      const s2 = screened.listen(0, "127.0.0.1");
      await new Promise<void>((r) => s2.once("listening", r));
      try {
        const o2 = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;
        const statuses: number[] = [];
        for (let i = 0; i < 31; i++) {
          const r = await fetch(o2 + "/api/club/join", { headers: { "x-real-ip": "203.0.113.9", [JOIN_HEADER]: "x".repeat(i) } });
          statuses.push(r.status);
          await r.text();
        }
        assert.deepEqual(statuses.slice(0, 30), Array(30).fill(401));
        assert.equal(statuses[30], 429);
        assert.deepEqual(touched, []);
      } finally {
        await new Promise((r) => s2.close(r));
      }
      // POST /join: 5 per (IP, token), then 429 rate_limited; another token from that IP still passes.
      const ip = "203.0.113.77";
      const j = [] as number[];
      for (let i = 0; i < 6; i++)
        j.push((await call("POST", "/api/club/join", { token, ip, body: { phone: "123", country: "MX", name: "x", privacyAccepted: true } })).status);
      assert.deepEqual(j, [400, 400, 400, 400, 400, 429]);
      const other = seal("loyalty-join", { t: f.tenantId, o: randomUUID() }, { ttlSeconds: 3600 });
      assert.equal((await call("POST", "/api/club/join", { token: other, ip, body: {} })).status, 400);
      const limited = await call("POST", "/api/club/join", { token, ip, body: {} });
      assert.equal(limited.body.error, "rate_limited");
      // The request log holds route templates and no phone digits.
      const all = logLines.join("\n");
      assert.equal(all.includes(phone), false);
      assert.equal(all.includes(phone.slice(2)), false);
      assert.match(all, /\/api\/loyalty\/members\/lookup|loyalty/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  console.log(`${checks} loyalty checks passed`);
} finally {
  for (const id of tenantsMade)
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${id},true)`;
      await tx`delete from jobs where tenant_id=${id} and kind in ('kitchen_dispatch','loyalty_reconcile') and created_at>=${started}`;
    });
  await sql.end();
  await admin.end();
}
