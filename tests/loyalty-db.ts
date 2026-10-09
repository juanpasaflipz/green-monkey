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
import { DomainError, type Order, type Session } from "../shared/domain.js";
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
    v = await change(f, o.id, ana.id, beto.id);
    await pay(f, o.id, 90000);
    await runJobs(f, o.id);
    await rejects(change(f, o.id, beto.id, ana.id), "forbidden");
    await rejects(change(f, o.id, beto.id, ana.id, stale(f.s.manager)), "step_up_required");
    v = await change(f, o.id, beto.id, ana.id, f.s.manager);
    assert.deepEqual([v.member?.id, v.earned], [beto.id, 3]);
    assert.deepEqual(await ledgerKinds(f, o.id), ["earn:3", "earn_reversal:-3", "earn:3"]);
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

  // __PART3__
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
