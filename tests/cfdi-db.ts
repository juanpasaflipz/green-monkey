// cfdi (030) against a real database (spec §7.3): the worker handlers run as the jobs login
// (gm_worker, a gm_jobs_worker member) through the Wave 2.0 runner, the web functions as the
// runtime role, and the deterministic Facturapi fake answers in process (no sockets, no key).
//
// Fixtures: every run creates fresh fictional restaurants and LEAVES its rows in the disposable
// test database (cfdi_* and fiscal records reject DELETE/TRUNCATE; LD-12, cfdi-rebase §2 item 7).
// Fiscal 027 and discounts 028 are the real tables; tickets and refund adjustments are inserted
// with fiscal's figures (extractTax, complement extraction) under their constraints and triggers.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { isolatedTarget, requireWorker } from "./isolated-target.js";
import {
  checkRole,
  checkWorkerRole,
  connect,
  connectWorker,
  tenant,
  type Tx,
} from "../server/db.js";
import { password } from "../server/auth.js";
import { setLogSink } from "../server/logging.js";
import type { Alert } from "../server/ops/alerts.js";
import { createJobRunner } from "../server/jobs/runner.js";
import { cancelJob, claimJobs, expireLostJobs } from "../server/jobs/queue.js";
import {
  discoverTenants,
  workerHandlers,
} from "../server/jobs/worker-registry.js";
import "../server/cfdi/worker/register.js";
import {
  cfdiWorkerConfig,
  parseCredentialKeyring,
} from "../server/cfdi/config.js";
import { createFacturapiClient } from "../server/cfdi/facturapi.js";
import {
  setCfdiRuntime,
  type CfdiRuntime,
} from "../server/cfdi/worker/runtime.js";
import {
  seedGlobalTicks,
  verifyAndPublish,
} from "../server/cfdi/worker/boot.js";
import { nextHour } from "../server/cfdi/worker/global.js";
import { cfdiEnqueue } from "../server/cfdi/jobs.js";
import * as service from "../server/cfdi/service.js";
import * as portal from "../server/cfdi/portal.js";
import {
  cfdiAlerts,
  cfdiCapability,
  cfdiCoverage,
  cfdiReportAlerts,
  enqueueCfdiRefund,
} from "../server/cfdi/hooks.js";
import { selfInvoiceOffered } from "../server/cfdi/store.js";
import { recordRefundTax } from "../server/fiscal.js";
import { todaySummary } from "../server/reports/today.js";
import { dayCorte } from "../server/reports/cortes.js";
import { reportsPorts } from "../server/reports/ports.js";
import { rekeyOrganizationSecrets } from "../server/cfdi/rekey.js";
import { recoveryAction } from "../server/cfdi/recovery.js";
import { loadDocument } from "../server/cfdi/store.js";
import { lockDocument, lockPeriod } from "../server/cfdi/locks.js";
import { noRetries } from "./db-retries.js";
import { seal } from "../server/tokens.js";
import { parseCfdiTotals } from "../server/cfdi/xml.js";
import { businessDate, type Session } from "../shared/domain.js";
import { firstOfNextMonth } from "../shared/cfdi.js";
import {
  extractTax,
  formatFolio,
  selfInvoiceCodeFromBytes,
  TAX_RULES,
  type TaxCategory,
} from "../shared/fiscal.js";
import { createFacturapiFake, FAKE_BASE_URL } from "./fakes/facturapi-fake.js";
import { TEST_CSD, TEST_CSD_PASSWORD } from "./fixtures/cfdi/test-csd.js";

// CFDI_DB_DEBUG=1 prints warnings and errors (job handler failures) while debugging.
setLogSink((line) => {
  if (process.env.CFDI_DB_DEBUG && /"level":"(warn|error)"/.test(line))
    console.error(line);
});
const target = isolatedTarget(process.env);
const admin = postgres(target.migration, { max: 2, onnotice: () => {} });
const app = connect(target.runtime);
await checkRole(app);
const worker = connectWorker(requireWorker(target));
await checkWorkerRole(worker);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyring = "t1:" + Buffer.alloc(32, 3).toString("base64url");
const alerts: Alert[] = [];
const dead: { kind: string; code: string }[] = [];
const fake = createFacturapiFake();
const runtime: CfdiRuntime = {
  config: {
    ...cfdiWorkerConfig(
      {
        FACTURAPI_API_KEY: "sk_user_fixture",
        CREDENTIAL_ENCRYPTION_KEY: keyring,
      },
      "test",
    ),
    // The production-only live switch, on for the live-mode checks (DB item 13).
    liveEnabled: true,
  },
  ring: parseCredentialKeyring(keyring),
  client: createFacturapiClient({
    fetch: fake.fetch,
    baseUrl: FAKE_BASE_URL,
    userAgent: "green-monkey/test",
    timeouts: { standardMs: 1500, longMs: 1500 },
  }),
  alert: (a) => {
    alerts.push(a);
  },
  providerOk: true,
};
setCfdiRuntime(runtime);
assert.equal(await verifyAndPublish(worker, runtime), true);

const runner = createJobRunner(worker, {
  handlers: workerHandlers,
  concurrency: 4,
  sweepMs: 3_600_000,
  onDead: (job, code) => dead.push({ kind: job.kind, code }),
});

/** Runs every due cfdi job of a tenant until none is left (handlers chain follow-ups). */
async function settle(tenantId: string, rounds = 80) {
  for (let i = 0; i < rounds; i++) {
    const claimed = await runner.drainTenant(tenantId);
    while (runner.running() > 0) await sleep(10);
    if (claimed === 0) {
      const [{ n }] = await admin`
        select count(*)::int as n from jobs where tenant_id = ${tenantId}
          and kind like 'cfdi\\_%' and state in ('queued','available') and next_at <= now()`;
      if (!n) return;
    }
  }
  throw new Error("settle: jobs keep coming");
}
/** Makes every waiting (backoff or runAt) cfdi job of a tenant due now. */
async function due(tenantId: string, kind?: string) {
  await admin`
    update jobs set next_at = now() where tenant_id = ${tenantId} and state = 'available'
      and kind like 'cfdi\\_%' ${kind ? admin`and kind = ${kind}` : admin``}`;
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

type Fixture = {
  tenantId: string;
  owner: Session;
  manager: Session;
  cashier: Session;
  rfc: string;
  /** The device's open drawer: cash tenders and cash refunds belong to it (028). */
  drawerId: string;
  folio: number;
  tickets: Map<string, Ticket>;
};
type Ticket = {
  id: string;
  orderId: string;
  folio: string;
  code: string;
  businessDate: string;
  tenderIds: string[];
  groups: { category: TaxCategory; gross: number }[];
  refunded: Map<TaxCategory, number>;
};
const restaurant = {
  name: "CFDI fixture",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const today = () =>
  businessDate(
    new Date().toISOString(),
    restaurant.timezone,
    restaurant.cutoff,
  );
const daysAgo = (n: number) => {
  const d = new Date(today() + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function makeTenant(
  label: string,
  o: { rfc?: string; legalName?: string; regime?: string } = {},
): Promise<Fixture> {
  const organizationId = randomUUID();
  const tenantId = randomUUID();
  const deviceId = randomUUID();
  const drawerId = randomUUID();
  const ids = {
    owner: randomUUID(),
    manager: randomUUID(),
    cashier: randomUUID(),
  };
  const rfc = o.rfc ?? "EKU9003173C9";
  await admin.begin(async (tx) => {
    await tx`insert into organizations(id,name) values(${organizationId},${"CFDI " + label})`;
    await tx`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
      values(${tenantId},${organizationId},${"CFDI " + label},'MXN','America/Mexico_City',240,true)`;
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    for (const [role, id] of Object.entries(ids))
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${id},${"CFDI " + role},${role + "-" + id.slice(0, 8)},${password("cfdi-fixture")},${role})`;
    await tx`insert into devices(tenant_id,id,name,token_hash,free_slot) values(${tenantId},${deviceId},'CFDI device','fixture',1)`;
    await tx`insert into restaurant_entitlements(tenant_id,status,access_until,source)
      values(${tenantId},'active',now()+interval '1 day','fixture')`;
    await tx`insert into restaurant_fiscal_profiles(tenant_id,rfc,legal_name,regime,postal_code,ticket_series,updated_by)
      values(${tenantId},${rfc},${o.legalName ?? "ESCUELA KEMPER URGATE"},${o.regime ?? "601"},'42501','A',${ids.owner})`;
    // Folio counters are written with their first ticket (027's gapless constraint trigger).
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening)
      values(${tenantId},${drawerId},${deviceId},${ids.cashier},0)`;
  });
  const session = (role: keyof typeof ids): Session => ({
    id: randomUUID(),
    tenantId,
    employeeId: ids[role],
    name: "CFDI " + role,
    role,
    deviceId,
    expiresAt: "",
    offlineUntil: "",
    csrf: "",
    restaurant,
  });
  return {
    tenantId,
    owner: session("owner"),
    manager: session("manager"),
    cashier: session("cashier"),
    rfc,
    drawerId,
    folio: 0,
    tickets: new Map(),
  };
}

/** The next folio of series A, taken as fiscal takes it: the counter advances by one. */
async function nextFolio(tx: postgres.TransactionSql, tenantId: string) {
  const [c] = await tx<{ last_value: string }[]>`
    insert into fiscal_folio_counters(tenant_id,series,last_value) values(${tenantId},'A',1)
    on conflict (tenant_id,series) do update set last_value = fiscal_folio_counters.last_value + 1
    returning last_value`;
  return Number(c.last_value);
}

/** A paid order and its fiscal ticket with fiscal's figures (one row per tax category). */
async function makeTicket(
  t: Fixture,
  o: {
    groups?: { category: TaxCategory; gross: number }[];
    payments?: { method: "cash" | "external"; amount: number }[];
    businessDate?: string;
  } = {},
): Promise<Ticket> {
  const groups = o.groups ?? [{ category: "iva16", gross: 11600 }];
  const total = groups.reduce((s, g) => s + g.gross, 0);
  const payments = o.payments ?? [{ method: "cash" as const, amount: total }];
  let number = 0;
  const id = randomUUID();
  const orderId = randomUUID();
  const code = selfInvoiceCodeFromBytes(randomBytes(12));
  const date = o.businessDate ?? today();
  const tenderIds: string[] = [];
  const taxes = groups.map((g) => {
    const tax = extractTax(g.gross, TAX_RULES[g.category].rateBps).tax;
    return {
      ...g,
      rate: TAX_RULES[g.category].rateBps,
      tax,
      base: g.gross - tax,
    };
  });
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${t.tenantId},true)`;
    number = await nextFolio(tx, t.tenantId);
    t.folio = number;
    await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,total)
      values(${t.tenantId},${orderId},${number},${date},${t.cashier.employeeId},'takeaway','','','pos',${total})`;
    for (const p of payments) {
      const tenderId = randomUUID();
      tenderIds.push(tenderId);
      await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,received,external_reference)
        values(${t.tenantId},${tenderId},${orderId},${p.method === "cash" ? t.drawerId : null},${p.method},${p.amount},${p.amount},
          ${p.method === "external" ? "CFDI-TERM-" + number : null})`;
    }
    await tx`insert into fiscal_tickets(tenant_id,id,order_id,series,number,self_invoice_code,business_date,
        issued_by,source,currency,gross_before_discount,discount,gross,base,tax,tax_basis,issuer,lines,payments)
      values(${t.tenantId},${id},${orderId},'A',${number},${code},${date},${t.cashier.employeeId},'sale','MXN',
        ${total},0,${total},${taxes.reduce((s, g) => s + g.base, 0)},${taxes.reduce((s, g) => s + g.tax, 0)},
        'line_snapshot',
        ${tx.json({ tradeName: "CFDI fixture", rfc: t.rfc, legalName: "ESCUELA KEMPER URGATE", regime: "601", regimeName: { es: "General", en: "General" }, postalCode: "42501", address: {}, taxRegion: "general" })},
        '[]'::jsonb,
        ${tx.json(payments.map((p, i) => ({ ...p, tip: 0, reference: null, at: new Date(Date.now() + i).toISOString() })))})`;
    for (const g of taxes)
      await tx`insert into fiscal_ticket_taxes(tenant_id,ticket_id,category,rate_bps,gross_before_discount,discount,
          gross,base_before_discount,discount_base,base,tax)
        values(${t.tenantId},${id},${g.category},${g.rate},${g.gross},0,${g.gross},${g.base},0,${g.base},${g.tax})`;
  });
  const ticket = {
    id,
    orderId,
    folio: formatFolio("A", number),
    code,
    businessDate: date,
    tenderIds,
    groups,
    refunded: new Map<TaxCategory, number>(),
  };
  t.tickets.set(id, ticket);
  return ticket;
}

/**
 * A refund with fiscal's complement extraction per category (fiscal.md §4.3) and fiscal's hook
 * (recordRefundTax step 9 → enqueueCfdiRefund) called in the runtime role's transaction.
 */
async function refund(
  t: Fixture,
  tk: Ticket,
  amounts: Partial<Record<TaxCategory, number>>,
  method: "cash" | "external" = "cash",
): Promise<string> {
  const refundId = randomUUID();
  const total = Object.values(amounts).reduce((s, n) => s + (n ?? 0), 0);
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${t.tenantId},true)`;
    await tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id,method,external_reference)
      values(${t.tenantId},${refundId},${tk.tenderIds[0]},${method === "cash" ? t.drawerId : null},${total},'cfdi fixture','discard',
        ${t.owner.employeeId},${method},${method === "external" ? "CFDI-REFUND" : null})`;
    for (const [category, gross] of Object.entries(amounts) as [
      TaxCategory,
      number,
    ][]) {
      const sale = tk.groups.find((g) => g.category === category)!.gross;
      const before = tk.refunded.get(category) ?? 0;
      const rate = TAX_RULES[category].rateBps;
      const tax =
        extractTax(sale - before, rate).tax -
        extractTax(sale - before - gross, rate).tax;
      tk.refunded.set(category, before + gross);
      await tx`insert into fiscal_adjustments(tenant_id,id,refund_id,order_id,category,rate_bps,gross,base,tax,business_date,created_by)
        values(${t.tenantId},${randomUUID()},${refundId},${tk.orderId},${category},${rate},${gross},${gross - tax},${tax},${today()},${t.owner.employeeId})`;
    }
  });
  await tenant(app, t.tenantId, (tx) =>
    enqueueCfdiRefund(tx, { tenantId: t.tenantId }, refundId),
  );
  return refundId;
}

const web = <T>(t: Fixture, fn: (tx: Tx) => Promise<T>) =>
  tenant(app, t.tenantId, fn);
const op = () => randomUUID();

/** Activation through the owner's route, provisioning by the worker, optional backdated start. */
async function activate(
  t: Fixture,
  o: { testFrom?: string; periodicity?: "day" | "month" } = {},
) {
  await web(t, (tx) =>
    service.activate(tx, t.owner, { operationId: op(), expectedVersion: 0 }),
  );
  if (o.testFrom)
    // LD-12 named-trigger pattern: test_from is immutable for every role.
    await admin.begin(async (tx) => {
      await tx`alter table cfdi_settings disable trigger cfdi_settings_guard`;
      await tx`update cfdi_settings set test_from = ${o.testFrom}::date where tenant_id = ${t.tenantId}`;
      await tx`alter table cfdi_settings enable trigger cfdi_settings_guard`;
    });
  if (o.periodicity && o.periodicity !== "month")
    await saveSettings(t, { globalPeriodicity: o.periodicity });
  await settle(t.tenantId);
  const view = await web(t, (tx) => service.getSettings(tx, t.manager));
  assert.equal(
    view.organization?.status,
    "ready",
    "organization provisioned by the worker",
  );
  return view;
}

async function saveSettings(
  t: Fixture,
  patch: Partial<Record<string, unknown>>,
) {
  const view = await web(t, (tx) => service.getSettings(tx, t.owner));
  const s = view.settings!;
  return web(t, (tx) =>
    service.saveSettings(tx, t.owner, {
      operationId: op(),
      expectedVersion: s.version,
      enabled: s.enabled,
      globalPeriodicity: s.globalPeriodicity,
      globalAuto: s.globalAuto,
      conceptMode: s.conceptMode,
      conceptDescription: s.conceptDescription,
      cardPaymentForm: s.cardPaymentForm,
      defaultUse: s.defaultUse,
      selfInvoiceEnabled: s.selfInvoiceEnabled,
      selfInvoicePolicy: s.selfInvoicePolicy,
      selfInvoiceDays: s.selfInvoiceDays,
      portalReissueGlobal: s.portalReissueGlobal,
      supportEmail: s.supportEmail,
      ...patch,
    }),
  );
}

const MORAL = {
  rfc: "URE180429TM6",
  legalName: "UNIVERSIDAD ROBOTICA ESPAÑOLA",
  regime: "601",
  postalCode: "86991",
  use: "G03" as const,
  email: "facturas@example.com",
};
async function invoice(
  t: Fixture,
  tk: Ticket,
  o: {
    s?: Session;
    receptor?: Partial<typeof MORAL>;
    cardForm?: "04" | "28" | null;
    reissueGlobal?: boolean;
  } = {},
) {
  return web(t, (tx) =>
    service.requestInvoice(tx, o.s ?? t.cashier, {
      operationId: op(),
      ticketId: tk.id,
      receptor: { ...MORAL, ...o.receptor },
      cardForm: o.cardForm ?? null,
      confirmPreStart: false,
      reissueGlobal: o.reissueGlobal ?? false,
    }),
  );
}
const docRow = async (id: string) =>
  (await admin`select * from cfdi_documents where id = ${id}`)[0];
const claims = (ticketId: string) =>
  admin`select document_id, state, mode, released_reason from cfdi_document_tickets where ticket_id = ${ticketId} order by created_at`;
const events = async (documentId: string) =>
  (
    await admin`select kind from cfdi_events where document_id = ${documentId} order by created_at, id`
  ).map((r) => r.kind as string);
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, code);
    return true;
  });
}
async function tick(t: Fixture, payload: Record<string, unknown> = {}) {
  await web(t, (tx) =>
    cfdiEnqueue(tx, t.tenantId, {
      kind: "cfdi_global",
      dedupeKey: "tick:test:" + randomUUID(),
      payload,
    }),
  );
  await settle(t.tenantId);
}

/** Polls `check` every 20 ms for up to `ms`. */
async function waitFor(check: () => Promise<boolean>, ms = 10_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("waitFor: timed out");
    await sleep(20);
  }
}
/** Advisory-lock requests waiting in this (isolated) test database. */
const advisoryWaiters = async () =>
  (
    await admin`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`
  )[0].n as number;
/** LD-12 named-trigger pattern: moves a document's clocks back (the guard refuses every role). */
async function age(documentIds: string[], minutes: number) {
  await admin.begin(async (tx) => {
    await tx`alter table cfdi_documents disable trigger cfdi_documents_guard`;
    await tx`
      update cfdi_documents set updated_at = updated_at - make_interval(mins => ${minutes}),
        stamped_at = stamped_at - make_interval(mins => ${minutes})
      where id = any(${documentIds}::uuid[])`;
    await tx`alter table cfdi_documents enable trigger cfdi_documents_guard`;
  });
}
const cancelAs = (t: Fixture, s: Session, id: string) =>
  web(t, (tx) =>
    service.cancelDocument(
      tx,
      s,
      { operationId: op(), motive: "02", reason: "Datos equivocados" },
      { params: { id } } as never,
    ),
  );
const liveTicks = async (tenantId: string) =>
  admin`select dedupe_key, next_at from jobs where tenant_id = ${tenantId} and kind = 'cfdi_global'
    and state in ('queued','available','running') order by next_at`;

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

const A = await makeTenant("A");
const B = await makeTenant("B");
// Tickets of a closed day that exist before activation: the activation tick builds their global
// on time (a ticket created after its period was built is a late ticket, DB item 6).
const dayX = daysAgo(3);
const preT1 = await makeTicket(A, {
  businessDate: dayX,
  groups: [{ category: "iva16", gross: 5800 }],
});
const preT2 = await makeTicket(A, {
  businessDate: dayX,
  groups: [
    { category: "iva16", gross: 10000 },
    { category: "exempt", gross: 2000 },
  ],
  payments: [{ method: "external", amount: 12000 }],
});

try {
  await test("18. provider disabled: cfdi routes answer cfdi_unavailable and /capabilities says provider_not_configured", async () => {
    await worker`update cfdi_platform set provider = 'disabled', live_enabled = false, upload_kid = null, upload_public_jwk = null, shared_org_id = null`;
    assert.deepEqual(await web(A, (tx) => cfdiCapability(tx)), {
      enabled: false,
      reason: "provider_not_configured",
    });
    await rejects(
      web(A, (tx) =>
        service.activate(tx, A.owner, {
          operationId: op(),
          expectedVersion: 0,
        }),
      ),
      "cfdi_unavailable",
    );
    const status = await web(A, (tx) => service.getStatus(tx, A.cashier));
    assert.equal(status.available, false);
    assert.equal(status.canInvoice, false);
    assert.equal(await web(A, (tx) => selfInvoiceOffered(tx)), false);
    assert.equal(await verifyAndPublish(worker, runtime), true);
    assert.deepEqual(await web(A, (tx) => cfdiCapability(tx)), {
      enabled: true,
      reason: "live_enabled",
    });
  });

  await test("activation (owner, step-up) creates settings in test mode and the worker provisions the organization (find-or-create, legal data, sealed test key)", async () => {
    const stale: Session = {
      ...A.owner,
      access: {
        absoluteExpiresAt: null,
        authenticatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        deviceName: "Terminal",
        deviceKind: "terminal",
        idleLockSeconds: null,
        ownerAccount: false,
      },
    };
    await rejects(
      web(A, (tx) =>
        service.activate(tx, stale, { operationId: op(), expectedVersion: 0 }),
      ),
      "step_up_required",
    );
    await rejects(
      web(A, (tx) =>
        service.activate(tx, A.manager, {
          operationId: op(),
          expectedVersion: 0,
        }),
      ),
      "forbidden",
    );
    const view = await activate(A, {
      testFrom: daysAgo(40),
      periodicity: "day",
    });
    assert.equal(view.settings?.mode, "test");
    assert.equal(view.settings?.globalPeriodicity, "day");
    assert.equal(view.organization?.legalSyncedVersion, 1);
    const [org] =
      await admin`select provider_org_id, test_secret_id from cfdi_organizations where tenant_id = ${A.tenantId}`;
    assert.ok(org.provider_org_id && org.test_secret_id);
    const [secret] =
      await admin`select purpose, kid, payload_secret from cfdi_secrets where id = ${org.test_secret_id}`;
    assert.equal(secret.purpose, "org_test_key");
    assert.equal(secret.kid, "t1");
    assert.ok(
      !String(secret.payload_secret).includes("sk_test"),
      "sealed, never plain",
    );
    await rejects(
      web(A, (tx) =>
        service.activate(tx, A.owner, {
          operationId: op(),
          expectedVersion: 0,
        }),
      ),
      "cfdi_settings_changed",
    );
    const [audit] =
      await admin`select operation from audit where tenant_id = ${A.tenantId} and operation = 'cfdi.activated'`;
    assert.ok(audit);
    assert.equal(await web(A, (tx) => selfInvoiceOffered(tx)), true);
    await activate(B, { testFrom: daysAgo(40), periodicity: "day" });
  });

  await test("1. MON-1/FIT-6: a staff invoice stamps a CFDI whose stamped IVA equals the fiscal ticket tax (amount_check exact), stores XML and PDF and emails the receptor", async () => {
    const tk = await makeTicket(A, {
      groups: [
        { category: "iva16", gross: 11650 },
        { category: "iva0", gross: 5000 },
      ],
    });
    const view = await invoice(A, tk);
    assert.equal(view.status, "queued");
    assert.equal(view.kind, "invoice");
    await settle(A.tenantId);
    const doc = await docRow(view.id);
    assert.equal(doc.status, "valid");
    assert.equal(doc.amount_check, "exact");
    assert.equal(doc.expected_total, 16650);
    assert.equal(doc.expected_tax, extractTax(11650, 1600).tax);
    assert.equal(doc.tax, doc.expected_tax);
    assert.equal(doc.series, "F");
    assert.ok(doc.uuid && doc.emailed_at);
    const files =
      await admin`select format, sha256 from cfdi_files where document_id = ${view.id} order by format`;
    assert.deepEqual(
      files.map((f) => f.format),
      ["pdf", "xml"],
    );
    const [xml] =
      await admin`select content from cfdi_files where document_id = ${view.id} and format = 'xml'`;
    const totals = parseCfdiTotals(new Uint8Array(xml.content));
    assert.equal(totals.taxTraslados, doc.expected_tax);
    assert.equal(totals.concepts[0].noIdentificacion, tk.folio);
    assert.deepEqual(
      (await claims(tk.id)).map((c) => c.state),
      ["active"],
    );
    const ev = await events(view.id);
    for (const k of [
      "requested",
      "frozen",
      "stamped",
      "amount_check",
      "emailed",
    ])
      assert.ok(ev.includes(k), k);
    const detail = await web(A, (tx) =>
      service.getDocument(tx, A.manager, { params: { id: view.id } } as never),
    );
    assert.equal(detail.status, "valid");
    assert.deepEqual(detail.files.sort(), ["pdf", "xml"]);
    assert.equal(detail.ticketFolios[0], tk.folio);
    // The cashier who issued it sees it for 24 h; another cashier session id does not matter.
    const own = await web(A, (tx) =>
      service.getDocument(tx, A.cashier, { params: { id: view.id } } as never),
    );
    assert.equal(own.id, view.id);
    const file = await web(A, (tx) =>
      service.sendDocumentFile(tx, A.cashier, { id: view.id, format: "pdf" }),
    );
    assert.equal(file.contentType, "application/pdf");
    assert.match(file.filename, /^URE180429TM6_F\d+\.pdf$/);
    // operations stores ids only, never receptor data (cfdi-rebase §2 item 12).
    const stored =
      await admin`select result from operations where tenant_id = ${A.tenantId} and kind = 'cfdi.invoice'`;
    assert.ok(stored.length > 0);
    assert.ok(
      stored.every((r) => !JSON.stringify(r.result).includes("URE180429TM6")),
    );
  });

  await test("2. portal: the code resolves the tenant only through the lookup policy; tenants stay apart; request and download tokens are purpose-bound and expire", async () => {
    const tk = await makeTicket(A, {
      groups: [{ category: "iva16", gross: 23200 }],
    });
    // The runtime role cannot see another tenant's ticket without the code…
    const hidden = await tenant(
      app,
      B.tenantId,
      (tx) => tx`select id from fiscal_tickets where id = ${tk.id}`,
    );
    assert.equal(hidden.length, 0);
    // …and the code alone resolves exactly that ticket (no tenant set).
    assert.deepEqual(
      await portal.resolveTicketCode(
        app,
        tk.code.toLowerCase().replace(/(.{4})/g, "$1-"),
      ),
      {
        tenantId: A.tenantId,
        ticketId: tk.id,
      },
    );
    assert.equal(await portal.resolveTicketCode(app, "0000-0000-0000"), null);
    const view = await portal.portalTicket(app, tk.code);
    assert.equal(view.eligibility, "available");
    assert.equal(view.total, 23200);
    assert.equal(view.folio, tk.folio);
    assert.equal("documents" in view, false);
    const submitted = await portal.portalSubmit(app, tk.code, {
      operationId: op(),
      receptor: { ...MORAL, email: "cliente@example.com" },
      cardForm: null,
      privacyAccepted: true,
      locale: "es",
    });
    assert.equal(submitted.document.status, "queued");
    assert.equal(submitted.document.rfcMasked, "URE******TM6");
    assert.equal(submitted.document.emailMasked, "c***@example.com");
    await settle(A.tenantId);
    const status = await portal.portalRequestStatus(
      app,
      submitted.requestToken,
    );
    assert.equal(status.status, "valid");
    assert.ok(status.downloadToken);
    const pdf = await portal.portalFile(app, status.downloadToken!, "pdf");
    assert.equal(pdf.contentType, "application/pdf");
    // Purposes never cross; a token for another purpose or an expired one is unauthorized.
    await rejects(
      portal.portalFile(app, submitted.requestToken, "pdf"),
      "unauthorized",
    );
    await rejects(
      portal.portalRequestStatus(app, status.downloadToken!),
      "unauthorized",
    );
    const short = seal(
      "cfdi-portal",
      { tid: A.tenantId, did: randomUUID(), tkt: tk.id },
      { ttlSeconds: 1 },
    );
    await sleep(1100);
    await rejects(portal.portalRequestStatus(app, short), "unauthorized");
    const [doc] =
      await admin`select source, created_by from cfdi_documents where receptor_rfc = ${MORAL.rfc} and source = 'portal' order by created_at desc limit 1`;
    assert.equal(doc.source, "portal");
    assert.equal(doc.created_by, null);
    // Downloading later needs the RFC used.
    await rejects(
      portal.portalAccess(app, tk.code, { rfc: "XIQB891116QE4" }),
      "cfdi_portal_rfc_mismatch",
    );
    const access = await portal.portalAccess(app, tk.code, { rfc: MORAL.rfc });
    assert.equal(
      (await portal.portalRequestStatus(app, access.requestToken)).status,
      "valid",
    );
    const again = await portal.portalTicket(app, tk.code);
    assert.equal(again.eligibility, "invoiced");
    assert.equal(
      again.latest?.downloadToken,
      null,
      "the lookup never hands out files",
    );
    // No portal action writes an audit row (there is no actor).
    const [{ n }] =
      await admin`select count(*)::int as n from audit where tenant_id = ${A.tenantId} and operation like 'cfdi.portal%'`;
    assert.equal(n, 0);
  });

  await test("3. one active invoice per ticket: concurrent staff and portal requests give exactly one document; the other is refused", async () => {
    const tk = await makeTicket(A);
    const results = await noRetries("staff and portal invoice race", () =>
      Promise.allSettled([
        invoice(A, tk),
        portal.portalSubmit(app, tk.code, {
          operationId: op(),
          receptor: { ...MORAL, email: "otro@example.com" },
          cardForm: null,
          privacyAccepted: true,
          locale: "es",
        }),
      ]),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(failed.length, 1);
    assert.ok(
      ["cfdi_ticket_invoicing", "cfdi_ticket_already_invoiced"].includes(
        failed[0].reason.code,
      ),
    );
    const rows = await claims(tk.id);
    assert.equal(rows.length, 1);
    await settle(A.tenantId);
  });

  await test("4. FIT-6: the global of a closed day holds exactly the paid, un-invoiced tickets in folio order with NoIdentificacion = folio; rerunning the tick creates nothing", async () => {
    const day = dayX;
    const docs =
      await admin`select * from cfdi_documents where tenant_id = ${A.tenantId} and kind = 'global' and period_key = ${"D" + day}`;
    assert.equal(docs.length, 1);
    const g = docs[0];
    assert.equal(g.status, "valid");
    assert.equal(g.series, "FG");
    assert.equal(g.ticket_count, 2);
    assert.equal(g.amount_check, "exact");
    assert.deepEqual(g.global_info, {
      periodicity: "day",
      months: day.slice(5, 7),
      year: Number(day.slice(0, 4)),
      from: day,
      to: day,
    });
    // FormaPago of the ticket of greatest amount (the card ticket, default credit 04).
    assert.equal(g.payment_form, "04");
    const [xml] =
      await admin`select content from cfdi_files where document_id = ${g.id} and format = 'xml'`;
    const totals = parseCfdiTotals(new Uint8Array(xml.content));
    assert.deepEqual(
      totals.concepts.map((c) => c.noIdentificacion),
      [preT1.folio, preT2.folio, preT2.folio],
    );
    assert.equal(totals.total, 5800 + 12000);
    const [period] =
      await admin`select status, documents, late_tickets from cfdi_global_periods where tenant_id = ${A.tenantId} and period_key = ${"D" + day}`;
    assert.deepEqual(
      { ...period },
      { status: "built", documents: 1, late_tickets: 0 },
    );
    assert.ok(!(await events(g.id)).includes("late_global"), "built on time");
    // A ticket of that day invoiced to a customer is never put in a later part.
    const t3 = await makeTicket(A, { businessDate: day });
    await invoice(A, t3);
    await settle(A.tenantId);
    await tick(A);
    await tick(A);
    const [{ n }] =
      await admin`select count(*)::int as n from cfdi_documents where tenant_id = ${A.tenantId} and kind = 'global' and period_key = ${"D" + day}`;
    assert.equal(n, 1, "idempotent per period");
    const coverage = await web(A, (tx) =>
      cfdiCoverage(tx, { from: day, to: day }),
    );
    assert.deepEqual(coverage, {
      mode: "test",
      tickets: 3,
      invoiced: 1,
      globalized: 2,
      uncovered: 0,
      invoicedTotal: 11600,
      globalTotal: 17800,
    });
    const periods = await web(A, (tx) =>
      service.listGlobals(tx, A.manager, {
        query: { from: day, to: day },
      } as never),
    );
    assert.equal(periods[0].status, "built");
    assert.equal(periods[0].ticketCount, 2);
  });

  await test("5. global parts: a period with more than 4,000 concepts is split into parts with disjoint tickets", async () => {
    const C = await makeTenant("parts");
    await activate(C, { testFrom: daysAgo(40), periodicity: "day" });
    const day = daysAgo(5);
    // 2,001 tickets × 2 categories = 4,002 concepts → 2 parts (a ticket is never split). Each
    // ticket takes the next folio as fiscal issues it (027's counter guard and gapless check), in
    // one transaction; upper-case hex codes are valid self-invoice codes.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${C.tenantId},true)`;
      await tx`
        insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,total)
        select ${C.tenantId}, gen_random_uuid(), n, ${day}::date, ${C.cashier.employeeId}, 'takeaway','','','pos', 1580
        from generate_series(1, 2001) n`;
      await tx.unsafe(`
        DO $$ DECLARE o record; BEGIN
          FOR o IN SELECT id, number, business_date, employee_id FROM orders
            WHERE tenant_id = '${C.tenantId}'::uuid AND business_date = '${day}'::date ORDER BY number LOOP
            INSERT INTO fiscal_folio_counters(tenant_id, series, last_value) VALUES ('${C.tenantId}'::uuid, 'A', 1)
              ON CONFLICT (tenant_id, series) DO UPDATE SET last_value = fiscal_folio_counters.last_value + 1;
            INSERT INTO fiscal_tickets(tenant_id, id, order_id, series, number, self_invoice_code, business_date,
              issued_by, source, currency, gross_before_discount, discount, gross, base, tax, tax_basis, lines, payments)
            VALUES ('${C.tenantId}'::uuid, gen_random_uuid(), o.id, 'A', o.number,
              upper(substr(md5(random()::text || o.id::text), 1, 12)),
              o.business_date, o.employee_id, 'sale', 'MXN', 1580, 0, 1580, 1442, 138, 'line_snapshot', '[]',
              jsonb_build_array(jsonb_build_object('method','cash','amount',1580,'tip',0,'reference',null,'at',now())));
          END LOOP;
        END $$`);
      await tx`
        insert into fiscal_ticket_taxes(tenant_id,ticket_id,category,rate_bps,gross_before_discount,discount,gross,
          base_before_discount,discount_base,base,tax)
        select t.tenant_id, t.id, c.category, c.rate, c.gross, 0, c.gross, c.base, 0, c.base, c.tax
        from fiscal_tickets t,
          (values ('iva16', 1600, 1000, 862, 138), ('iva0', 0, 580, 580, 0)) c(category, rate, gross, base, tax)
        where t.tenant_id = ${C.tenantId}`;
    });
    await tick(C);
    const parts =
      await admin`select id, part, ticket_count, concept_count, status from cfdi_documents
      where tenant_id = ${C.tenantId} and kind = 'global' order by part`;
    assert.equal(parts.length, 2);
    assert.deepEqual(
      parts.map((p) => p.part),
      [1, 2],
    );
    assert.equal(parts[0].ticket_count + parts[1].ticket_count, 2001);
    assert.ok(
      parts.every((p) => p.concept_count <= 4000 && p.status === "valid"),
    );
    const [{ overlap }] = await admin`
      select count(*)::int as overlap from cfdi_document_tickets a join cfdi_document_tickets b
        on a.ticket_id = b.ticket_id and a.document_id < b.document_id
      where a.tenant_id = ${C.tenantId} and a.state = 'active' and b.state = 'active'`;
    assert.equal(overlap, 0);
  });

  await test("6. D5 (binding): a ticket synced after its day was globalized goes into a supplementary part of that same day, flagged late and alerted once past due", async () => {
    const day = dayX;
    const late = await makeTicket(A, {
      businessDate: day,
      groups: [{ category: "iva16", gross: 4640 }],
    });
    alerts.length = 0;
    await tick(A);
    const parts =
      await admin`select id, part, status, global_info from cfdi_documents
      where tenant_id = ${A.tenantId} and kind = 'global' and period_key = ${"D" + day} order by part`;
    assert.equal(parts.length, 2);
    assert.equal(parts[1].part, 2);
    assert.equal(parts[1].status, "valid");
    assert.deepEqual(
      parts[1].global_info,
      parts[0].global_info,
      "same Periodicidad, Meses and Año",
    );
    const rows = await claims(late.id);
    assert.equal(rows[0].document_id, parts[1].id);
    const [period] =
      await admin`select late_tickets, documents from cfdi_global_periods where tenant_id = ${A.tenantId} and period_key = ${"D" + day}`;
    assert.equal(period.late_tickets, 1);
    assert.equal(period.documents, 2);
    assert.ok((await events(parts[1].id)).includes("late_global"));
    assert.ok(
      alerts.some(
        (a) => a.key.startsWith("cfdi_global_late:") && a.key.endsWith(":p2"),
      ),
    );
    assert.ok(
      !alerts.some((a) => /RFC|@|ESCUELA/.test(a.body)),
      "alert bodies carry codes and ids only",
    );
    // Never into the next open period.
    const [{ n }] =
      await admin`select count(*)::int as n from cfdi_document_tickets c join cfdi_documents d
      on d.tenant_id = c.tenant_id and d.id = c.document_id where c.ticket_id = ${late.id} and d.period_key <> ${"D" + day}`;
    assert.equal(n, 0);
  });

  await test("7. invoice after the global: a manager (step-up) cancels the global with 04, the replacement leaves the ticket out, then the nominative invoice stamps; two late requests share one reissue", async () => {
    const day = daysAgo(4);
    const t1 = await makeTicket(A, { businessDate: day });
    const t2 = await makeTicket(A, {
      businessDate: day,
      groups: [{ category: "iva16", gross: 23200 }],
    });
    const t3 = await makeTicket(A, {
      businessDate: day,
      groups: [{ category: "iva16", gross: 5800 }],
    });
    await tick(A);
    const [g] =
      await admin`select id from cfdi_documents where tenant_id = ${A.tenantId} and kind = 'global' and period_key = ${"D" + day} and status = 'valid'`;
    await rejects(invoice(A, t1), "cfdi_ticket_in_global");
    await rejects(invoice(A, t1, { reissueGlobal: true }), "forbidden");
    const ticketView = await web(A, (tx) =>
      service.getTicket(tx, A.manager, {
        params: { ticketId: t1.id },
      } as never),
    );
    assert.equal(ticketView.eligibility, "in_global");
    assert.equal(ticketView.reissueAllowed, true);
    const first = await invoice(A, t1, { s: A.manager, reissueGlobal: true });
    const second = await invoice(A, t2, {
      s: A.manager,
      reissueGlobal: true,
      receptor: { email: null },
    });
    assert.equal(first.status, "waiting");
    assert.equal(second.status, "waiting");
    const cancellations =
      await admin`select motive, source, status from cfdi_cancellations where document_id = ${g.id}`;
    assert.equal(
      cancellations.length,
      1,
      "one cancellation for both late requests",
    );
    assert.equal(cancellations[0].motive, "04");
    await settle(A.tenantId);
    const [canceled] =
      await admin`select status from cfdi_documents where id = ${g.id}`;
    assert.equal(canceled.status, "canceled");
    const [replacement] =
      await admin`select id, status, part, replaces_document_id, ticket_count from cfdi_documents
      where replaces_document_id = ${g.id} and kind = 'global'`;
    assert.equal(replacement.status, "valid");
    assert.equal(
      replacement.ticket_count,
      1,
      "only the ticket nobody asked for stays in the global",
    );
    assert.deepEqual(
      (await claims(t3.id))
        .filter((c) => c.state === "active")
        .map((c) => c.document_id),
      [replacement.id],
    );
    for (const [d, tk] of [
      [first, t1],
      [second, t2],
    ] as const) {
      const row = await docRow(d.id);
      assert.equal(row.status, "valid");
      assert.deepEqual(
        (await claims(tk.id))
          .filter((c) => c.state === "active")
          .map((c) => c.document_id),
        [d.id],
      );
    }
    // SAT order: the global was canceled before the replacement stamped, the invoices after both.
    const [order] = await admin`
      select (select stamped_at from cfdi_documents where id = ${replacement.id}) < (select stamped_at from cfdi_documents where id = ${first.id}) as ok`;
    assert.equal(order.ok, true);
    const acuse =
      await admin`select format from cfdi_files where document_id = ${g.id} and format like 'cancel%'`;
    assert.equal(acuse.length, 2);
  });

  await test("8. refunds: after a valid invoice an egreso related 01 is issued; before invoicing the refund is netted with fiscal's figures (exact); a full refund makes the ticket ineligible and leaves it out of globals", async () => {
    // After the invoice → credit note.
    const tk = await makeTicket(A, {
      groups: [{ category: "iva16", gross: 11600 }],
    });
    const inv = await invoice(A, tk);
    await settle(A.tenantId);
    const refundId = await refund(A, tk, { iva16: 5800 });
    const [{ jobs }] =
      await admin`select count(*)::int as jobs from jobs where tenant_id = ${A.tenantId} and kind = 'cfdi_refund' and dedupe_key = ${"refund:" + refundId}`;
    assert.equal(jobs, 1, "24. fiscal hook: one cfdi_refund job per refund");
    await settle(A.tenantId);
    const [egreso] =
      await admin`select * from cfdi_documents where refund_id = ${refundId}`;
    assert.equal(egreso.kind, "egreso");
    assert.equal(egreso.status, "valid");
    assert.equal(egreso.parent_document_id, inv.id);
    assert.equal(egreso.series, "NC");
    assert.equal(egreso.amount_check, "exact");
    const parent = await docRow(inv.id);
    assert.deepEqual(egreso.request.related_documents, [
      { relationship: "01", documents: [parent.uuid] },
    ]);
    assert.equal(egreso.request.use, "G03" === MORAL.use ? "G02" : "S01");
    const detail = await web(A, (tx) =>
      service.getDocument(tx, A.manager, { params: { id: inv.id } } as never),
    );
    assert.deepEqual(detail.creditNotes, [egreso.id]);
    assert.equal(
      detail.canCancel,
      false,
      "credit notes block the cancellation",
    );

    // Before invoicing → netted.
    const tk2 = await makeTicket(A, {
      groups: [
        { category: "iva16", gross: 11600 },
        { category: "iva0", gross: 3000 },
      ],
    });
    const r2 = await refund(A, tk2, { iva16: 5801 });
    await settle(A.tenantId);
    const inv2 = await invoice(A, tk2);
    await settle(A.tenantId);
    const d2 = await docRow(inv2.id);
    assert.deepEqual(d2.netted_refund_ids, [r2]);
    assert.equal(d2.expected_total, 11600 - 5801 + 3000);
    assert.equal(d2.expected_tax, extractTax(11600 - 5801, 1600).tax);
    assert.equal(d2.amount_check, "exact");

    // Full refund → ineligible, never in a global.
    const day = daysAgo(6);
    const tk3 = await makeTicket(A, {
      businessDate: day,
      groups: [{ category: "iva16", gross: 2320 }],
    });
    await refund(A, tk3, { iva16: 2320 });
    await rejects(invoice(A, tk3), "cfdi_ticket_fully_refunded");
    await tick(A);
    assert.equal((await claims(tk3.id)).length, 0);
  });

  await test("8b. fiscal 027 / discounts 028 wiring: refunds recorded through fiscal's recordRefundTax (step 9) enqueue cfdi_refund; the credit note's FormaPago follows refunds.method (the card tender's refund takes the card form, the cash tender's 01), never the parent's", async () => {
    await saveSettings(A, { cardPaymentForm: "28" });
    try {
      const tk = await makeTicket(A, {
        groups: [{ category: "iva16", gross: 11600 }],
        payments: [
          { method: "cash", amount: 7600 },
          { method: "external", amount: 4000 },
        ],
      });
      const inv = await invoice(A, tk);
      await settle(A.tenantId);
      assert.equal((await docRow(inv.id)).payment_form, "01");
      // The runtime role's refund transaction, as discounts' insertRefundBatch and the legacy
      // refund run it: the money row, then fiscal's tax rows, whose step 9 calls cfdi's hook.
      const fiscalRefund = (tenderIndex: number, amount: number) =>
        web(A, async (tx) => {
          const id = randomUUID();
          const external = tenderIndex === 1;
          await tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id,method,external_reference)
            values(${A.tenantId},${id},${tk.tenderIds[tenderIndex]},${external ? null : A.drawerId},${amount},'cfdi wiring',
              'discard',${A.manager.employeeId},${external ? "external" : "cash"},${external ? "TERM-REFUND" : null})`;
          const view = await recordRefundTax(tx, A.manager, id);
          assert.ok(
            view.groups.length > 0,
            "fiscal wrote the refund's tax rows",
          );
          return id;
        });
      const card = await fiscalRefund(1, 3000);
      const cash = await fiscalRefund(0, 1000);
      const [{ jobs }] =
        await admin`select count(*)::int as jobs from jobs where tenant_id = ${A.tenantId} and kind = 'cfdi_refund'
          and dedupe_key in (${"refund:" + card}, ${"refund:" + cash})`;
      assert.equal(
        jobs,
        2,
        "recordRefundTax enqueued one cfdi_refund per refund",
      );
      await settle(A.tenantId);
      const notes = await admin`
        select refund_id, status, payment_form, amount_check, expected_total from cfdi_documents
        where tenant_id = ${A.tenantId} and kind = 'egreso' and refund_id in (${card}, ${cash})`;
      const byRefund = new Map(notes.map((n) => [n.refund_id as string, n]));
      assert.equal(byRefund.get(card)?.status, "valid");
      assert.equal(byRefund.get(card)?.payment_form, "28");
      assert.equal(byRefund.get(card)?.expected_total, 3000);
      assert.equal(byRefund.get(card)?.amount_check, "exact");
      assert.equal(byRefund.get(cash)?.status, "valid");
      assert.equal(byRefund.get(cash)?.payment_form, "01");
      assert.equal(byRefund.get(cash)?.expected_total, 1000);
    } finally {
      await saveSettings(A, { cardPaymentForm: "04" });
    }
  });

  await test("9. substitution: the replacement (relation 04) stamps first, the old invoice is canceled with 01 and the claim moves; a rejected cancellation leaves both valid, the new claim pending, and alerts", async () => {
    const tk = await makeTicket(A);
    const d1 = await invoice(A, tk);
    await settle(A.tenantId);
    const d2 = await web(A, (tx) =>
      service.substituteDocument(
        tx,
        A.manager,
        {
          operationId: op(),
          receptor: { ...MORAL, postalCode: "86990" },
          cardForm: null,
          reason: "CP equivocado",
        },
        { params: { id: d1.id } } as never,
      ),
    );
    assert.equal(d2.replacesDocumentId, d1.id);
    await settle(A.tenantId);
    const old = await docRow(d1.id);
    const fresh = await docRow(d2.id);
    assert.equal(fresh.status, "valid");
    assert.equal(old.status, "canceled");
    assert.deepEqual(fresh.request.related_documents, [
      { relationship: "04", documents: [old.uuid] },
    ]);
    const [c] =
      await admin`select motive, status, substitute_document_id from cfdi_cancellations where document_id = ${d1.id}`;
    assert.deepEqual(
      { ...c },
      { motive: "01", status: "accepted", substitute_document_id: d2.id },
    );
    const active = (await claims(tk.id)).filter((r) => r.state === "active");
    assert.deepEqual(
      active.map((r) => r.document_id),
      [d2.id],
    );

    // Rejected by the receptor (fake: FAKE REJECT CANCEL on the original's receptor name).
    const tk2 = await makeTicket(A);
    const r1 = await invoice(A, tk2, {
      receptor: { legalName: "UNIVERSIDAD FAKE REJECT CANCEL" },
    });
    await settle(A.tenantId);
    const r2 = await web(A, (tx) =>
      service.substituteDocument(
        tx,
        A.manager,
        {
          operationId: op(),
          receptor: MORAL,
          cardForm: null,
          reason: "Nombre",
        },
        { params: { id: r1.id } } as never,
      ),
    );
    alerts.length = 0;
    await settle(A.tenantId);
    assert.equal((await docRow(r1.id)).status, "canceling");
    await due(A.tenantId, "cfdi_reconcile");
    await settle(A.tenantId);
    assert.equal((await docRow(r1.id)).status, "valid");
    assert.equal((await docRow(r2.id)).status, "valid");
    const states = Object.fromEntries(
      (await claims(tk2.id)).map((r) => [r.document_id, r.state]),
    );
    assert.deepEqual(states, { [r1.id]: "active", [r2.id]: "pending" });
    assert.ok(
      alerts.some((a) => a.key.startsWith("cfdi_substitution_rejected:")),
    );
    const attention = await web(A, (tx) => service.getAlerts(tx, A.manager));
    assert.ok(attention.rejectedSubstitutions >= 1);
  });

  await test("10. a staff cancellation with motive 02 releases the ticket and the next tick puts it in a supplementary global", async () => {
    const day = daysAgo(8);
    const tk = await makeTicket(A, { businessDate: day });
    await tick(A);
    const d = await invoice(A, await makeTicket(A, { businessDate: day }));
    await settle(A.tenantId);
    const cashierTry = web(A, (tx) =>
      service.cancelDocument(
        tx,
        A.cashier,
        { operationId: op(), motive: "02", reason: "x" },
        { params: { id: d.id } } as never,
      ),
    );
    await rejects(cashierTry, "forbidden");
    await web(A, (tx) =>
      service.cancelDocument(
        tx,
        A.manager,
        { operationId: op(), motive: "02", reason: "Datos equivocados" },
        {
          params: { id: d.id },
        } as never,
      ),
    );
    await settle(A.tenantId);
    assert.equal((await docRow(d.id)).status, "canceled");
    const [freed] =
      await admin`select ticket_id from cfdi_document_tickets where document_id = ${d.id}`;
    const rows = await claims(freed.ticket_id);
    assert.equal(rows.find((r) => r.document_id === d.id)?.state, "released");
    const supplementary = rows.find(
      (r) => r.document_id !== d.id && r.state === "active",
    );
    assert.ok(supplementary, "the after-cancel tick claimed it in a global");
    const [g] =
      await admin`select period_key, part from cfdi_documents where id = ${supplementary!.document_id}`;
    assert.equal(g.period_key, "D" + day);
    assert.ok(g.part >= 2);
    void tk;
  });

  await test("R2-4. after a rejected substitution, a staff cancellation (02) of the original hands the ticket to the valid substitute: a later refund gets a credit note related to the substitute and coverage counts the ticket as invoiced", async () => {
    const S = await makeTenant("substitution after rejection");
    await activate(S);
    const tk = await makeTicket(S);
    const d1 = await invoice(S, tk);
    await settle(S.tenantId);
    assert.equal((await docRow(d1.id)).status, "valid");
    // The receptor rejects the motive-01 cancellation once (the original's name carries no
    // marker, so the later 02 cancellation is accepted at once: under 24 h and $1,000).
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_rejected",
      match: { type: "I", global: false },
    });
    const d2 = await web(S, (tx) =>
      service.substituteDocument(
        tx,
        S.manager,
        {
          operationId: op(),
          receptor: { ...MORAL, postalCode: "86990" },
          cardForm: null,
          reason: "CP equivocado",
        },
        { params: { id: d1.id } } as never,
      ),
    );
    await settle(S.tenantId);
    assert.equal((await docRow(d1.id)).status, "canceling");
    await due(S.tenantId, "cfdi_reconcile");
    await settle(S.tenantId);
    assert.equal((await docRow(d1.id)).status, "valid");
    assert.equal((await docRow(d2.id)).status, "valid");
    const stateOf = async () =>
      Object.fromEntries(
        (await claims(tk.id)).map((r) => [r.document_id, r.state]),
      );
    assert.deepEqual(await stateOf(), {
      [d1.id]: "active",
      [d2.id]: "pending",
    });
    let attention = await web(S, (tx) => service.getAlerts(tx, S.manager));
    assert.equal(attention.rejectedSubstitutions, 1);

    // The alert's "request the cancellation again": Cancelar on the original, motive 02.
    await web(S, (tx) =>
      service.cancelDocument(
        tx,
        S.manager,
        { operationId: op(), motive: "02", reason: "Sustituida" },
        { params: { id: d1.id } } as never,
      ),
    );
    await settle(S.tenantId);
    assert.equal((await docRow(d1.id)).status, "canceled");
    assert.deepEqual(await stateOf(), {
      [d1.id]: "released",
      [d2.id]: "active",
    });
    assert.ok((await events(d2.id)).includes("substitution_completed"));
    attention = await web(S, (tx) => service.getAlerts(tx, S.manager));
    assert.equal(attention.rejectedSubstitutions, 0);
    assert.deepEqual(
      await web(S, (tx) => cfdiCoverage(tx, { from: today(), to: today() })),
      {
        mode: "test",
        tickets: 1,
        invoiced: 1,
        globalized: 0,
        uncovered: 0,
        invoicedTotal: 11600,
        globalTotal: 0,
      },
    );

    // A later refund produces a credit note related to the substitute.
    const refundId = await refund(S, tk, { iva16: 5800 });
    await settle(S.tenantId);
    const [egreso] =
      await admin`select * from cfdi_documents where refund_id = ${refundId}`;
    assert.equal(egreso?.status, "valid");
    assert.equal(egreso.parent_document_id, d2.id);
    assert.deepEqual(egreso.request.related_documents, [
      { relationship: "01", documents: [(await docRow(d2.id)).uuid] },
    ]);
  });

  await test("R3-1. a substitute left waiting by a rejected cancellation blocks a second Sustituir (cfdi_substitution_pending) and keeps the attention count; the register asks again with motive 01 and that substitute, whose first poll is queued at once (CFDI-R3-3), and the ticket moves to it", async () => {
    const S = await makeTenant("substitution asked again");
    await activate(S);
    const tk = await makeTicket(S);
    const d1 = await invoice(S, tk);
    await settle(S.tenantId);
    const substitute = (reason: string) =>
      web(S, (tx) =>
        service.substituteDocument(
          tx,
          S.manager,
          {
            operationId: op(),
            receptor: { ...MORAL, postalCode: "86990" },
            cardForm: null,
            reason,
          },
          { params: { id: d1.id } } as never,
        ),
      );
    const view = (id: string) =>
      web(S, (tx) =>
        service.getDocument(tx, S.manager, { params: { id } } as never),
      );
    const attention = async () =>
      (await web(S, (tx) => service.getAlerts(tx, S.manager)))
        .rejectedSubstitutions;
    const stateOf = async () =>
      Object.fromEntries(
        (await claims(tk.id)).map((r) => [r.document_id, r.state]),
      );
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_rejected",
      match: { type: "I", global: false },
    });
    const d2 = await substitute("CP equivocado");
    await settle(S.tenantId);
    await due(S.tenantId, "cfdi_reconcile");
    await settle(S.tenantId);
    assert.equal((await docRow(d1.id)).status, "valid");
    assert.equal((await docRow(d2.id)).status, "valid");
    assert.deepEqual(await stateOf(), {
      [d1.id]: "active",
      [d2.id]: "pending",
    });
    let v = await view(d1.id);
    assert.equal(v.cancellation?.status, "rejected");
    assert.equal(v.waitingSubstituteId, d2.id, "the register's alert");
    assert.equal(v.canSubstitute, false);
    assert.equal(v.canRequestAgain, true);
    assert.equal(v.canCancel, true);
    assert.equal(await attention(), 1);

    // A second Sustituir would stamp D3 and leave D2 valid with a claim pending forever.
    await rejects(substitute("Otra vez"), "cfdi_substitution_pending");
    assert.deepEqual(
      (
        await admin`select id from cfdi_documents where replaces_document_id = ${d1.id}`
      ).map((r) => r.id),
      [d2.id],
    );
    assert.equal(await attention(), 1, "the alert stays");

    // Motive 01 needs a waiting substitute.
    const other = await invoice(S, await makeTicket(S));
    await settle(S.tenantId);
    await rejects(
      web(S, (tx) =>
        service.cancelDocument(
          tx,
          S.manager,
          { operationId: op(), motive: "01", reason: "Sin sustituta" },
          { params: { id: other.id } } as never,
        ),
      ),
      "cfdi_substitute_missing",
    );

    // "Vuelve a solicitar la cancelación": motive 01 with D2. This time the receptor must
    // accept, and this cancellation's own poll chain starts at once although the first
    // cancellation's chain already used reconcile:<d1>:cancel:1 (CFDI-R3-3).
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_pending",
      match: { type: "I", global: false },
    });
    v = await web(S, (tx) =>
      service.cancelDocument(
        tx,
        S.manager,
        { operationId: op(), motive: "01", reason: "El cliente aceptará" },
        { params: { id: d1.id } } as never,
      ),
    );
    assert.equal(v.waitingSubstituteId, null, "a cancellation is open");
    assert.equal(v.canRequestAgain, false);
    assert.equal(await attention(), 0, "resolving while the request is open");
    await settle(S.tenantId);
    assert.equal((await docRow(d1.id)).status, "canceling");
    const [again] = await admin`
      select id, motive, source, substitute_document_id, status from cfdi_cancellations
      where document_id = ${d1.id} order by created_at desc limit 1`;
    assert.deepEqual(
      {
        motive: again.motive,
        source: again.source,
        substitute: again.substitute_document_id,
        status: again.status,
      },
      {
        motive: "01",
        source: "substitution",
        substitute: d2.id,
        status: "requested",
      },
    );
    const polls = await admin`
      select dedupe_key from jobs where tenant_id = ${S.tenantId} and kind = 'cfdi_reconcile'
        and payload->>'documentId' = ${d1.id} and state in ('queued','available')`;
    assert.deepEqual(
      polls.map((r) => r.dedupe_key),
      [
        `reconcile:${d1.id}:cancel:c${again.id.replace(/-/g, "").slice(0, 12)}:1`,
      ],
      "the second cancellation's first poll is queued",
    );
    await due(S.tenantId, "cfdi_reconcile");
    await settle(S.tenantId);
    assert.equal((await docRow(d1.id)).status, "canceled");
    assert.deepEqual(await stateOf(), {
      [d1.id]: "released",
      [d2.id]: "active",
    });
    const sent = fake.invoices.get((await docRow(d1.id)).provider_invoice_id);
    assert.equal(
      sent?.cancel?.substitution?.toLowerCase(),
      String((await docRow(d2.id)).uuid).toLowerCase(),
      "motive 01 carries the substitute's UUID",
    );
    assert.ok((await events(d2.id)).includes("substitution_completed"));
    assert.equal(await attention(), 0);
    assert.equal((await view(d1.id)).waitingSubstituteId, null);
  });

  await test("R3-1b. a motive-01 cancellation the provider refuses leaves the substitute waiting: the attention count and the original's alert show it until the substitute is canceled", async () => {
    const S = await makeTenant("substitution refused by the provider");
    await activate(S);
    const tk = await makeTicket(S);
    const d1 = await invoice(S, tk);
    await settle(S.tenantId);
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_refused",
      match: { type: "I", global: false },
    });
    alerts.length = 0;
    const d2 = await web(S, (tx) =>
      service.substituteDocument(
        tx,
        S.manager,
        {
          operationId: op(),
          receptor: { ...MORAL, postalCode: "86990" },
          cardForm: null,
          reason: "CP equivocado",
        },
        { params: { id: d1.id } } as never,
      ),
    );
    await settle(S.tenantId);
    const [c] =
      await admin`select status, error_code from cfdi_cancellations where document_id = ${d1.id}`;
    assert.deepEqual(
      { ...c },
      { status: "failed", error_code: "cfdi_cancel_rejected_provider" },
    );
    assert.equal((await docRow(d1.id)).status, "valid");
    assert.equal((await docRow(d2.id)).status, "valid");
    assert.deepEqual(
      Object.fromEntries(
        (await claims(tk.id)).map((r) => [r.document_id, r.state]),
      ),
      { [d1.id]: "active", [d2.id]: "pending" },
    );
    assert.ok(alerts.some((a) => a.key.startsWith("cfdi_cancel_failed:")));
    const attention = async () =>
      (await web(S, (tx) => service.getAlerts(tx, S.manager)))
        .rejectedSubstitutions;
    assert.equal(await attention(), 1, "refused, not only rejected, counts");
    const view = () =>
      web(S, (tx) =>
        service.getDocument(tx, S.manager, {
          params: { id: d1.id },
        } as never),
      );
    let v = await view();
    assert.equal(v.cancellation?.status, "failed");
    assert.equal(v.waitingSubstituteId, d2.id);
    assert.equal(v.canRequestAgain, true);
    assert.equal(v.canSubstitute, false);

    // The other way out: cancel the substitute (02); the original keeps the ticket.
    await cancelAs(S, S.manager, d2.id);
    await settle(S.tenantId);
    assert.equal((await docRow(d2.id)).status, "canceled");
    assert.deepEqual(
      Object.fromEntries(
        (await claims(tk.id)).map((r) => [r.document_id, r.state]),
      ),
      { [d1.id]: "active", [d2.id]: "released" },
    );
    assert.equal(await attention(), 0);
    v = await view();
    assert.equal(v.waitingSubstituteId, null);
    assert.equal(v.canSubstitute, true);
  });

  await test("R3-2. a refund while a staff cancellation is still queued (provider outage) waits: no credit note against the invoice being canceled, and the ticket ends net in its global", async () => {
    const R = await makeTenant("refund during a cancellation");
    await activate(R, { testFrom: daysAgo(40), periodicity: "day" });
    const day = daysAgo(3);
    const tk = await makeTicket(R, { businessDate: day });
    const d = await invoice(R, tk);
    await settle(R.tenantId);
    assert.equal((await docRow(d.id)).status, "valid");
    fake.fault({
      op: "invoices.cancel",
      fault: "unavailable",
      match: { type: "I", global: false },
    });
    await web(R, (tx) =>
      service.cancelDocument(
        tx,
        R.manager,
        { operationId: op(), motive: "03", reason: "No se concretó" },
        { params: { id: d.id } } as never,
      ),
    );
    await settle(R.tenantId);
    const [queued] =
      await admin`select status from cfdi_cancellations where document_id = ${d.id}`;
    assert.equal(
      queued.status,
      "queued",
      "the provider outage keeps it queued",
    );
    assert.equal((await docRow(d.id)).status, "valid");

    const refundId = await refund(R, tk, { iva16: 5800 });
    await settle(R.tenantId);
    const egresos = () =>
      admin`select id from cfdi_documents where refund_id = ${refundId}`;
    assert.equal((await egresos()).length, 0, "no credit note while canceling");
    const [job] =
      await admin`select state, error_code from jobs where tenant_id = ${R.tenantId} and dedupe_key = ${"refund:" + refundId}`;
    assert.deepEqual(
      { ...job },
      { state: "available", error_code: "cfdi_parent_cancel_open" },
    );

    // The outage ends: the cancellation is accepted, the ticket goes to a supplementary part of
    // its day at its net amount, and the refund needs no credit note.
    for (let i = 0; i < 4; i++) {
      await due(R.tenantId);
      await settle(R.tenantId);
    }
    assert.equal((await docRow(d.id)).status, "canceled");
    const active = (await claims(tk.id)).filter((r) => r.state === "active");
    assert.equal(active.length, 1);
    const g = await docRow(active[0].document_id);
    assert.equal(g.kind, "global");
    assert.equal(g.period_key, "D" + day);
    assert.equal(g.status, "valid");
    assert.deepEqual(g.netted_refund_ids, [refundId]);
    assert.equal(g.expected_total, 11600 - 5800);
    assert.equal((await egresos()).length, 0);
    const [finished] =
      await admin`select state from jobs where tenant_id = ${R.tenantId} and dedupe_key = ${"refund:" + refundId}`;
    assert.equal(finished.state, "done");
  });

  await test("R3-2b. credit notes block every cancellation: the staff request (cfdi_has_credit_notes), the late invoice's request (route III instead of a motive-04 cancellation, CFDI-INT-1), and cfdi_cancel and cfdi_reissue re-check under the document key without calling the provider", async () => {
    const N = await makeTenant("credit notes block cancellations");
    await activate(N, { testFrom: daysAgo(40), periodicity: "day" });
    const tk = await makeTicket(N);
    const d = await invoice(N, tk);
    await settle(N.tenantId);
    await refund(N, tk, { iva16: 5800 });
    await settle(N.tenantId);
    const [egreso] =
      await admin`select status from cfdi_documents where parent_document_id = ${d.id} and kind = 'egreso'`;
    assert.equal(egreso.status, "valid");
    await rejects(cancelAs(N, N.manager, d.id), "cfdi_has_credit_notes");
    await rejects(
      web(N, (tx) =>
        service.substituteDocument(
          tx,
          N.manager,
          {
            operationId: op(),
            receptor: MORAL,
            cardForm: null,
            reason: "Nombre",
          },
          { params: { id: d.id } } as never,
        ),
      ),
      "cfdi_has_credit_notes",
    );

    // A cancellation that slipped past the request's check (a credit note created before
    // cfdi_refund took the document key): the worker refuses it before calling the provider.
    const sendCancel = async (documentId: string, motive: "02" | "04") => {
      const cancellationId = randomUUID();
      await web(N, async (tx) => {
        await tx`
          insert into cfdi_cancellations(tenant_id, id, document_id, motive, source, reason)
          values (${N.tenantId}, ${cancellationId}, ${documentId}, ${motive},
            ${motive === "04" ? "reissue" : "staff"}, 'race')`;
        await cfdiEnqueue(
          tx,
          N.tenantId,
          motive === "04"
            ? {
                kind: "cfdi_reissue",
                dedupeKey: "reissue:test:" + cancellationId,
                payload: { globalDocumentId: documentId },
              }
            : {
                kind: "cfdi_cancel",
                dedupeKey: "cancel:" + cancellationId,
                payload: { cancellationId },
              },
        );
      });
      return cancellationId;
    };
    const deletes = () =>
      fake.requests.filter((r) => r.method === "DELETE").length;
    let before = deletes();
    alerts.length = 0;
    const raced = await sendCancel(d.id, "02");
    await settle(N.tenantId);
    const [refused] =
      await admin`select status, error_code from cfdi_cancellations where id = ${raced}`;
    assert.deepEqual(
      { ...refused },
      { status: "failed", error_code: "cfdi_has_credit_notes" },
    );
    assert.equal((await docRow(d.id)).status, "valid");
    assert.equal(deletes(), before, "the provider is never asked");
    assert.ok(alerts.some((a) => a.key.startsWith("cfdi_cancel_failed:")));

    // A global with a credit note: a late invoice never asks for its cancellation; it credits
    // the global for the ticket instead (route III, CFDI-INT-1).
    const day = daysAgo(2);
    const t1 = await makeTicket(N, { businessDate: day });
    const t2 = await makeTicket(N, { businessDate: day });
    const t3 = await makeTicket(N, { businessDate: day });
    await tick(N);
    const [g] =
      await admin`select id from cfdi_documents where tenant_id = ${N.tenantId} and kind = 'global'
        and period_key = ${"D" + day} and status = 'valid'`;
    await refund(N, t1, { iva16: 2320 });
    await settle(N.tenantId);
    const [note] =
      await admin`select status from cfdi_documents where parent_document_id = ${g.id} and kind = 'egreso'`;
    assert.equal(note.status, "valid");
    const late = await invoice(N, t2, { s: N.manager, reissueGlobal: true });
    assert.equal(late.status, "waiting");
    const [credit] =
      await admin`select id, parent_document_id from cfdi_documents where tenant_id = ${N.tenantId}
        and credit_ticket_id = ${t2.id}`;
    assert.equal(credit.parent_document_id, g.id);
    assert.equal((await docRow(late.id)).depends_on, credit.id);
    assert.equal(
      (
        await admin`select 1 from cfdi_cancellations where document_id = ${g.id}`
      ).length,
      0,
    );
    await settle(N.tenantId);
    assert.equal((await docRow(late.id)).status, "valid");

    // The same race on the reissue: refused under G's key, waiting invoices fail, no provider call.
    const waiter = randomUUID();
    await web(N, async (tx) => {
      await tx`
        insert into cfdi_documents(tenant_id, id, kind, source, mode, status, depends_on, receptor,
          receptor_rfc, created_by)
        values (${N.tenantId}, ${waiter}, 'invoice', 'staff', 'test', 'waiting', ${g.id},
          ${tx.json(MORAL as never)}, ${MORAL.rfc}, ${N.manager.employeeId})`;
      await tx`
        insert into cfdi_document_tickets(tenant_id, document_id, ticket_id, mode, state)
        values (${N.tenantId}, ${waiter}, ${t3.id}, 'test', 'pending')`;
    });
    before = deletes();
    alerts.length = 0;
    const reissue = await sendCancel(g.id, "04");
    await settle(N.tenantId);
    const [r4] =
      await admin`select status, error_code from cfdi_cancellations where id = ${reissue}`;
    assert.deepEqual(
      { ...r4 },
      { status: "failed", error_code: "cfdi_has_credit_notes" },
    );
    assert.equal((await docRow(g.id)).status, "valid");
    const w = await docRow(waiter);
    assert.equal(w.status, "failed");
    assert.equal(w.error_code, "cfdi_global_has_credit_notes");
    assert.deepEqual(
      (await claims(t3.id)).map((r) => [r.document_id, r.state]),
      [
        [g.id, "active"],
        [waiter, "released"],
      ],
    );
    assert.equal(deletes(), before, "the provider is never asked");
    assert.ok(alerts.some((a) => a.key.startsWith("cfdi_reissue_failed:")));
  });

  await test("11. a stamping timeout retries with the same idempotency key, adopts the invoice by external_id and never creates two provider invoices", async () => {
    const tk = await makeTicket(A);
    const d = await invoice(A, tk, {
      receptor: { legalName: "UNIVERSIDAD FAKE TIMEOUT" },
    });
    await settle(A.tenantId);
    assert.equal((await docRow(d.id)).status, "stamping");
    assert.ok((await events(d.id)).includes("stamp_unknown"));
    await due(A.tenantId, "cfdi_stamp");
    await settle(A.tenantId);
    const row = await docRow(d.id);
    assert.equal(row.status, "valid");
    const provider = [...fake.invoices.values()].filter(
      (i) => i.body.external_id === d.id,
    );
    assert.equal(provider.length, 1);
    assert.equal(row.provider_invoice_id, provider[0].id);
  });

  await test("12. 202 pending is reconciled to valid; a failed recovery fails the document and releases its claims", async () => {
    const tk = await makeTicket(A);
    const d = await invoice(A, tk, {
      receptor: { legalName: "UNIVERSIDAD FAKE PENDING" },
    });
    await settle(A.tenantId);
    assert.equal((await docRow(d.id)).status, "pending");
    await due(A.tenantId, "cfdi_reconcile");
    await settle(A.tenantId);
    assert.equal((await docRow(d.id)).status, "valid");
    const tk2 = await makeTicket(A);
    const f = await invoice(A, tk2, {
      receptor: { legalName: "UNIVERSIDAD FAKE PENDING FAILED" },
    });
    await settle(A.tenantId);
    await due(A.tenantId, "cfdi_reconcile");
    await settle(A.tenantId);
    const row = await docRow(f.id);
    assert.equal(row.status, "failed");
    assert.equal(row.error_code, "cfdi_stamping_failed");
    assert.deepEqual(
      (await claims(tk2.id)).map((c) => c.state),
      ["released"],
    );
    // The ticket can be invoiced again.
    await invoice(A, tk2);
  });

  await test("receptor errors from SAT fail the document with the field to correct and free the ticket", async () => {
    const tk = await makeTicket(A);
    const d = await invoice(A, tk, {
      receptor: { legalName: "UNIVERSIDAD FAKE NAME MISMATCH" },
    });
    await settle(A.tenantId);
    const row = await docRow(d.id);
    assert.equal(row.status, "failed");
    assert.equal(row.error_code, "cfdi_receptor_name_mismatch");
    assert.equal(row.error_path, "customer.legal_name");
    assert.deepEqual(
      (await claims(tk.id)).map((c) => c.state),
      ["released"],
    );
    const view = await web(A, (tx) =>
      service.getTicket(tx, A.cashier, {
        params: { ticketId: tk.id },
      } as never),
    );
    assert.equal(view.eligibility, "available");
  });

  await test("14. CSD: the box is sealed to the worker key, the runtime role cannot read secrets, the payload is wiped on acceptance and on rejection, and an RFC mismatch is refused", async () => {
    await assert.rejects(
      tenant(
        app,
        A.tenantId,
        (tx) => tx`select payload_secret from cfdi_secrets`,
      ),
      /permission denied/,
    );
    await rejects(
      web(A, (tx) =>
        service.uploadCsd(tx, A.owner, {
          operationId: op(),
          cer: TEST_CSD.otherRfcCer,
          key: TEST_CSD.key,
          password: TEST_CSD_PASSWORD,
        }),
      ),
      "cfdi_csd_rfc_mismatch",
    );
    await rejects(
      web(A, (tx) =>
        service.uploadCsd(tx, A.owner, {
          operationId: op(),
          cer: TEST_CSD.cer,
          key: TEST_CSD.key,
          password: "nope",
        }),
      ),
      "cfdi_csd_password",
    );
    const uploaded = await web(A, (tx) =>
      service.uploadCsd(tx, A.owner, {
        operationId: op(),
        cer: TEST_CSD.cer,
        key: TEST_CSD.key,
        password: TEST_CSD_PASSWORD,
      }),
    );
    assert.equal(uploaded.status, "queued");
    assert.equal(uploaded.certificate.rfc, "EKU9003173C9");
    const [box] =
      await admin`select s.payload_secret, s.wiped_at from cfdi_csd_uploads u join cfdi_secrets s on s.id = u.secret_id where u.id = ${uploaded.uploadId}`;
    assert.ok(box.payload_secret && !box.wiped_at);
    assert.ok(!String(box.payload_secret).includes(TEST_CSD_PASSWORD));
    await rejects(
      web(A, (tx) =>
        service.uploadCsd(tx, A.owner, {
          operationId: op(),
          cer: TEST_CSD.cer,
          key: TEST_CSD.key,
          password: TEST_CSD_PASSWORD,
        }),
      ),
      "cfdi_csd_upload_in_progress",
    );
    await settle(A.tenantId);
    const [after] =
      await admin`select u.status, s.payload_secret, s.wiped_at from cfdi_csd_uploads u join cfdi_secrets s on s.id = u.secret_id where u.id = ${uploaded.uploadId}`;
    assert.equal(after.status, "accepted");
    assert.equal(after.payload_secret, null);
    assert.ok(after.wiped_at);
    const [org] =
      await admin`select csd_status, csd_serial from cfdi_organizations where tenant_id = ${A.tenantId}`;
    assert.equal(org.csd_status, "valid");
    assert.equal(org.csd_serial, "30001000000500003416");
    // A box the worker cannot open (sealed for another row) is rejected and still wiped.
    const forged = await web(A, (tx) =>
      service.uploadCsd(tx, A.owner, {
        operationId: op(),
        cer: TEST_CSD.cer,
        key: TEST_CSD.key,
        password: TEST_CSD_PASSWORD,
      }),
    );
    const [moved] =
      await admin`select secret_id from cfdi_csd_uploads where id = ${forged.uploadId}`;
    const [other] =
      await admin`select payload_secret from cfdi_secrets where id = ${moved.secret_id}`;
    // Re-point the payload at a box bound to another id (owner-level tampering simulation).
    await admin.begin(async (tx) => {
      await tx`alter table cfdi_secrets disable trigger cfdi_secrets_guard`;
      await tx`update cfdi_secrets set payload_secret = ${String(other.payload_secret).split(".").reverse().join(".")} where id = ${moved.secret_id}`;
      await tx`alter table cfdi_secrets enable trigger cfdi_secrets_guard`;
    });
    await settle(A.tenantId);
    const [rejected] =
      await admin`select u.status, u.error_code, s.payload_secret from cfdi_csd_uploads u join cfdi_secrets s on s.id = u.secret_id where u.id = ${forged.uploadId}`;
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.payload_secret, null);
    const [kept] =
      await admin`select csd_status from cfdi_organizations where tenant_id = ${A.tenantId}`;
    assert.equal(
      kept.csd_status,
      "valid",
      "a refused upload keeps the CSD in force",
    );
  });

  await test("13. test/live separation: live needs the platform switch, a ready organization, a valid CSD and production readiness; test claims never cover live tickets; live is final", async () => {
    const L = await makeTenant("live");
    await activate(L, { testFrom: daysAgo(40), periodicity: "day" });
    const before = await web(L, (tx) => service.getSettings(tx, L.owner));
    await rejects(
      web(L, (tx) =>
        service.requestLive(tx, L.owner, {
          operationId: op(),
          expectedVersion: before.settings!.version,
          liveFrom: today(),
        }),
      ),
      "cfdi_live_requirements",
    );
    await web(L, (tx) =>
      service.uploadCsd(tx, L.owner, {
        operationId: op(),
        cer: TEST_CSD.cer,
        key: TEST_CSD.key,
        password: TEST_CSD_PASSWORD,
      }),
    );
    await settle(L.tenantId);
    const [org] =
      await admin`select provider_org_id from cfdi_organizations where tenant_id = ${L.tenantId}`;
    fake.signManifesto(org.provider_org_id);
    // A test-mode invoice for a ticket of today.
    const tk = await makeTicket(L);
    await invoice(L, tk);
    await settle(L.tenantId);
    await web(L, (tx) =>
      cfdiEnqueue(tx, L.tenantId, {
        kind: "cfdi_org",
        dedupeKey: "refresh:test",
        payload: { action: "refresh" },
      }),
    );
    await settle(L.tenantId);
    const view = await web(L, (tx) => service.getSettings(tx, L.owner));
    assert.equal(view.live.canRequest, true);
    await rejects(
      web(L, (tx) =>
        service.requestLive(tx, L.owner, {
          operationId: op(),
          expectedVersion: view.settings!.version,
          liveFrom: daysAgo(1),
        }),
      ),
      "cfdi_live_from_invalid",
    );
    await web(L, (tx) =>
      service.requestLive(tx, L.owner, {
        operationId: op(),
        expectedVersion: view.settings!.version,
        liveFrom: today(),
      }),
    );
    await settle(L.tenantId);
    const live = await web(L, (tx) => service.getSettings(tx, L.owner));
    assert.equal(live.settings?.mode, "live");
    assert.equal(live.settings?.liveFrom, today());
    const [keys] =
      await admin`select live_secret_id from cfdi_organizations where tenant_id = ${L.tenantId}`;
    assert.ok(keys.live_secret_id);
    // The ticket invoiced in test mode is not covered in live mode.
    const ticket = await web(L, (tx) =>
      service.getTicket(tx, L.cashier, {
        params: { ticketId: tk.id },
      } as never),
    );
    assert.equal(ticket.mode, "live");
    assert.equal(ticket.eligibility, "available");
    const d = await invoice(L, tk);
    await settle(L.tenantId);
    const row = await docRow(d.id);
    assert.equal(row.mode, "live");
    assert.equal(row.livemode, true);
    assert.equal(row.status, "valid");
    // Live is final, even for the owner of the table.
    await assert.rejects(
      admin`update cfdi_settings set mode = 'test', live_from = null, live_enabled_at = null, live_enabled_by = null where tenant_id = ${L.tenantId}`,
      /cfdi_live_is_final/,
    );
  });

  await test("15. immutability: identity, frozen request and stamp fields, claims, files and events reject UPDATE/DELETE/TRUNCATE; the runtime role cannot update documents or insert non-queued rows", async () => {
    const [doc] =
      await admin`select id, tenant_id from cfdi_documents where tenant_id = ${A.tenantId} and status = 'valid' and kind = 'invoice' limit 1`;
    for (const [statement, pattern] of [
      [
        admin`update cfdi_documents set receptor_rfc = 'XIQB891116QE4' where id = ${doc.id}`,
        /cfdi_document_identity_immutable/,
      ],
      [
        admin`update cfdi_documents set expected_total = 1 where id = ${doc.id}`,
        /cfdi_document_request_frozen/,
      ],
      [
        admin`update cfdi_documents set total = 1 where id = ${doc.id}`,
        /cfdi_document_stamp_immutable/,
      ],
      [
        admin`update cfdi_documents set tax = tax + 1 where id = ${doc.id}`,
        /cfdi_document_amounts_immutable/,
      ],
      [
        admin`update cfdi_documents set status = 'queued' where id = ${doc.id}`,
        /cfdi_document_transition/,
      ],
      [
        admin`delete from cfdi_documents where id = ${doc.id}`,
        /fiscal records/,
      ],
      [
        admin`update cfdi_files set sha256 = repeat('0', 64) where document_id = ${doc.id}`,
        /immutable/,
      ],
      [
        admin`delete from cfdi_events where document_id = ${doc.id}`,
        /immutable/,
      ],
      [
        admin`delete from cfdi_document_tickets where document_id = ${doc.id}`,
        /not deleted/,
      ],
      [admin`truncate cfdi_documents cascade`, /immutable/],
      [admin`truncate cfdi_files`, /immutable/],
    ] as const)
      await assert.rejects(statement, pattern);
    await assert.rejects(
      tenant(
        app,
        A.tenantId,
        (tx) =>
          tx`update cfdi_documents set status = 'failed' where id = ${doc.id}`,
      ),
      /permission denied/,
    );
    await assert.rejects(
      tenant(
        app,
        A.tenantId,
        (tx) => tx`
        insert into cfdi_documents(tenant_id, id, kind, source, mode, status, receptor, receptor_rfc)
        values (${A.tenantId}, ${randomUUID()}, 'invoice', 'staff', 'test', 'valid', '{}', 'URE180429TM6')`,
      ),
      /row-level security/,
    );
    await assert.rejects(
      tenant(
        app,
        A.tenantId,
        (tx) => tx`update cfdi_organizations set status = 'ready'`,
      ),
      /permission denied|worker_only/,
    );
    await assert.rejects(
      tenant(
        app,
        A.tenantId,
        (
          tx,
        ) => tx`insert into cfdi_settings(tenant_id, test_from, updated_by, mode, live_from, live_enabled_at, live_enabled_by)
        values (${A.tenantId}, current_date, ${A.owner.employeeId}, 'live', current_date, now(), ${A.owner.employeeId})`,
      ),
      /row-level security|duplicate key/,
    );
  });

  await test("16. RLS: every cfdi table is tenant-isolated for the runtime role and for the worker's tenant transactions", async () => {
    const tables = [
      "cfdi_settings",
      "cfdi_organizations",
      "cfdi_csd_uploads",
      "cfdi_documents",
      "cfdi_document_tickets",
      "cfdi_cancellations",
      "cfdi_files",
      "cfdi_events",
      "cfdi_global_periods",
    ];
    for (const sql of [app, worker])
      for (const table of tables) {
        const rows = await tenant(
          sql,
          B.tenantId,
          (tx) => tx`select distinct tenant_id from ${tx(table)}`,
        );
        assert.ok(
          rows.every((r) => r.tenant_id === B.tenantId),
          `${table}`,
        );
        const none = await sql.begin(
          (tx) => tx`select count(*)::int as n from ${tx(table)}`,
        );
        assert.equal(none[0].n, 0, `${table} without a tenant`);
      }
    // The platform row is public (no tenant data) and readable by everyone.
    const [p] = await app`select provider from cfdi_platform`;
    assert.equal(p.provider, "organizations");
  });

  await test("17. OPS-15: the worker discovers due cfdi jobs of both tenants and no other kind; a claim in tenant A's transaction never touches tenant B's job; the runtime role sees only its tenant", async () => {
    const probe = "cfdi_probe_" + randomUUID().slice(0, 6);
    for (const t of [A, B])
      await admin`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,next_at)
        values (${t.tenantId}, ${randomUUID()}, ${probe}, 'probe', '{}', 'available', now()),
               (${t.tenantId}, ${randomUUID()}, 'kitchen_dispatch', ${"probe-" + randomUUID()}, '{}', 'available', now())`;
    const found = await discoverTenants(worker, [probe]);
    assert.ok(found.includes(A.tenantId) && found.includes(B.tenantId));
    assert.deepEqual(
      (await discoverTenants(worker, ["kitchen_dispatch"])).filter(
        (id) => id === A.tenantId || id === B.tenantId,
      ),
      [],
      "the discovery policy covers cfdi kinds only",
    );
    const claimed = await tenant(worker, A.tenantId, (tx) =>
      claimJobs(tx, [probe], 10, 60),
    );
    assert.deepEqual(
      claimed.map((j) => j.tenantId),
      [A.tenantId],
    );
    const [bJob] =
      await admin`select state from jobs where tenant_id = ${B.tenantId} and kind = ${probe}`;
    assert.equal(bJob.state, "available");
    const seen = await tenant(
      app,
      A.tenantId,
      (tx) =>
        tx`select distinct tenant_id from jobs where kind like 'cfdi\\_%'`,
    );
    assert.deepEqual(
      seen.map((r) => r.tenant_id),
      [A.tenantId],
    );
    await admin`update jobs set state = 'done', lease_until = null where kind = ${probe}`;
    await admin`update jobs set state = 'done' where dedupe_key like 'probe-%'`;
  });

  await test("17b. retry limits: a stamping job that keeps getting 5xx dies at attempt 12 for an invoice (cfdi_attempts_exhausted, document stays stamping, jobs_dead_cfdi_stamp); once stuck, Reintentar (managers) re-enqueues it", async () => {
    const tk = await makeTicket(A);
    const d = await invoice(A, tk, {
      receptor: { legalName: "UNIVERSIDAD FAKE UNAVAILABLE" },
    });
    await settle(A.tenantId);
    assert.ok(
      (await events(d.id)).includes("stamp_unknown"),
      "a 5xx is an unknown outcome",
    );
    await admin`update jobs set attempts = 11, next_at = now() where tenant_id = ${A.tenantId} and kind = 'cfdi_stamp' and dedupe_key = ${"stamp:" + d.id}`;
    dead.length = 0;
    await settle(A.tenantId);
    const [job] =
      await admin`select state, error_code, attempts from jobs where dedupe_key = ${"stamp:" + d.id}`;
    assert.deepEqual(
      { ...job },
      { state: "dead", error_code: "cfdi_attempts_exhausted", attempts: 12 },
    );
    assert.deepEqual(dead, [
      { kind: "cfdi_stamp", code: "cfdi_attempts_exhausted" },
    ]);
    const row = await docRow(d.id);
    assert.equal(row.status, "stamping");
    assert.ok((await events(d.id)).includes("attempts_exhausted"));
    // Stuck after 30 minutes: Reintentar (manager) re-enqueues; the next attempt adopts nothing
    // (the fake never created it) and stamps once the provider answers.
    await admin.begin(async (tx) => {
      await tx`alter table cfdi_documents disable trigger cfdi_documents_guard`;
      await tx`update cfdi_documents set updated_at = now() - interval '31 minutes' where id = ${d.id}`;
      await tx`alter table cfdi_documents enable trigger cfdi_documents_guard`;
    });
    const view = await web(A, (tx) =>
      service.getDocument(tx, A.manager, { params: { id: d.id } } as never),
    );
    assert.equal(view.stuck, true);
    assert.equal(view.canRetry, true);
    await web(A, (tx) =>
      service.retryDocument(tx, A.manager, { operationId: op() }, {
        params: { id: d.id },
      } as never),
    );
    const [retry] =
      await admin`select state from jobs where tenant_id = ${A.tenantId} and kind = 'cfdi_stamp'
      and dedupe_key like ${"stamp:" + d.id + ":r%"}`;
    assert.equal(retry.state, "available");
    await rejects(
      web(A, (tx) =>
        service.retryDocument(tx, A.cashier, { operationId: op() }, {
          params: { id: d.id },
        } as never),
      ),
      "forbidden",
    );
    void row;
  });

  await test("17d. runAt: the next global tick is stored with next_at in the future and is not discovered before then", async () => {
    const [next] =
      await admin`select next_at, dedupe_key from jobs where tenant_id = ${A.tenantId} and kind = 'cfdi_global'
      and state = 'available' order by next_at desc limit 1`;
    assert.ok(new Date(next.next_at).getTime() > Date.now());
    assert.ok(next.dedupe_key.startsWith("tick:"));
    assert.equal(
      new Date(next.dedupe_key.slice(5)).getTime(),
      new Date(next.next_at).getTime(),
    );
    const claimed = await tenant(worker, A.tenantId, (tx) =>
      claimJobs(tx, ["cfdi_global"], 10, 60),
    );
    assert.equal(claimed.length, 0);
  });

  await test("19. settings: a periodicity change applies from the first of next month once a global exists; RESICO forces monthly; a stale version conflicts", async () => {
    const saved = await saveSettings(A, { globalPeriodicity: "week" });
    assert.equal(saved.settings?.globalPeriodicity, "day");
    assert.equal(saved.settings?.nextPeriodicity, "week");
    assert.match(saved.settings!.nextPeriodicityFrom!, /^\d{4}-\d{2}-01$/);
    const back = await saveSettings(A, { globalPeriodicity: "day" });
    assert.equal(
      back.settings?.nextPeriodicity,
      null,
      "choosing the current one cancels the change",
    );
    await rejects(
      web(A, (tx) =>
        service.saveSettings(tx, A.owner, {
          ...settingsBody(back.settings!),
          expectedVersion: back.settings!.version - 1,
        }),
      ),
      "cfdi_settings_changed",
    );
    await rejects(
      web(A, (tx) =>
        service.saveSettings(tx, A.manager, {
          ...settingsBody(back.settings!),
          expectedVersion: back.settings!.version,
        }),
      ),
      "forbidden",
    );
    const R = await makeTenant("resico-settings", {
      rfc: "XIQB891116QE4",
      legalName: "BERENICE XIMO QUEZADA",
      regime: "626",
    });
    const view = await activate(R);
    assert.equal(view.settings?.resicoMonthly, true);
    // LD-33 SAT-4: a RESICO save is coerced to monthly (never refused, which locked the owner
    // out of every other setting); a "day" from an older client stores "month".
    const coerced = await saveSettings(R, { globalPeriodicity: "day" });
    assert.equal(
      coerced.settings?.nextPeriodicity ?? coerced.settings?.globalPeriodicity,
      "month",
    );
    const [audit] =
      await admin`select detail from audit where tenant_id = ${A.tenantId} and operation = 'cfdi.settings.saved' order by id desc limit 1`;
    assert.ok(audit.detail.before && audit.detail.after);
  });

  await test("R2-1. a periodicity change never rewrites past periods: the months before the change stay one monthly global each, a late ticket joins its own month, no daily row or empty period dates before the change, and a save once rows exist is deferred", async () => {
    // Months: m3 and m2 closed long ago (sales), m1 = the change date (first of last month).
    const firstOf = (back: number) => {
      const d = new Date(today().slice(0, 7) + "-01T12:00:00Z");
      d.setUTCMonth(d.getUTCMonth() - back);
      return d.toISOString().slice(0, 10);
    };
    const plus = (date: string, n: number) => {
      const d = new Date(date + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const m3 = firstOf(3);
    const m2 = firstOf(2);
    const m1 = firstOf(1);
    const P = await makeTenant("periodicity change");
    const t1 = await makeTicket(P, { businessDate: plus(m3, 2) });
    const t2 = await makeTicket(P, { businessDate: plus(m2, 1) });
    const t3 = await makeTicket(P, { businessDate: plus(m2, 9) });
    // Activated monthly in m3; a change to daily was saved in m2 for m1 (stored as the panel
    // stores it); the first tick on or after m1 runs only now (CFDI paused, or no sign-in).
    await web(P, (tx) =>
      service.activate(tx, P.owner, { operationId: op(), expectedVersion: 0 }),
    );
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${P.tenantId}, true)`;
      await tx`alter table cfdi_settings disable trigger cfdi_settings_guard`;
      await tx`
        update cfdi_settings set test_from = ${m3}::date, next_periodicity = 'day',
          next_periodicity_from = ${m1}::date
        where tenant_id = ${P.tenantId}`;
      await tx`alter table cfdi_settings enable trigger cfdi_settings_guard`;
    });
    await settle(P.tenantId);
    const rows = () =>
      admin`
        select period_key, periodicity, date_from::text as from_date, date_to::text as to_date, status
        from cfdi_global_periods where tenant_id = ${P.tenantId} and mode = 'test'
        order by date_from`;
    const globalOf = async (ticketId: string) => {
      const [c] = await admin`
        select d.period_key, d.part, d.global_info->>'periodicity' as periodicity, d.status
        from cfdi_document_tickets c join cfdi_documents d on d.tenant_id = c.tenant_id and d.id = c.document_id
        where c.tenant_id = ${P.tenantId} and c.ticket_id = ${ticketId} and c.state = 'active'`;
      return c ? { ...c } : null;
    };
    const invariants = async (label: string) => {
      const all = await rows();
      const before = all.filter((r) => r.from_date < m1);
      assert.deepEqual(
        before.map((r) => [r.period_key, r.periodicity, r.status]),
        [
          ["M" + m3.slice(0, 7), "month", "built"],
          ["M" + m2.slice(0, 7), "month", "built"],
        ],
        `${label}: the months before the change keep one monthly row each`,
      );
      const after = all.filter((r) => r.from_date >= m1);
      assert.ok(
        after.every((r) => r.periodicity === "day"),
        `${label}: rows from the change date are daily`,
      );
      assert.equal(after[0].from_date, m1, `${label}: days start at m1`);
      // Partition: every date from m3 through today belongs to exactly one row.
      for (let i = 1; i < all.length; i++)
        assert.equal(
          all[i].from_date,
          plus(all[i - 1].to_date, 1),
          `${label}: no gap or overlap at ${all[i].period_key}`,
        );
      const views = await web(P, (tx) =>
        service.listGlobals(tx, P.manager, {
          query: { from: m3, to: plus(m1, -1) },
        } as never),
      );
      assert.deepEqual(
        views.map((v) => [v.periodKey, v.status]),
        [
          ["M" + m2.slice(0, 7), "built"],
          ["M" + m3.slice(0, 7), "built"],
        ],
        `${label}: the register (newest first) shows no "Sin ventas" period before the change`,
      );
    };

    await invariants("first tick");
    const settings = (await web(P, (tx) => service.getSettings(tx, P.owner)))
      .settings!;
    assert.equal(settings.globalPeriodicity, "day", "promoted");
    assert.equal(settings.nextPeriodicity, null);
    assert.deepEqual(await globalOf(t1.id), {
      period_key: "M" + m3.slice(0, 7),
      part: 1,
      periodicity: "month",
      status: "valid",
    });
    const m2Global = await globalOf(t2.id);
    assert.deepEqual(m2Global, {
      period_key: "M" + m2.slice(0, 7),
      part: 1,
      periodicity: "month",
      status: "valid",
    });
    assert.deepEqual(await globalOf(t3.id), m2Global, "one global for m2");

    // A ticket of m2 synced late goes into a supplementary MONTHLY part of m2 (D5), never into
    // a daily period; ticks after the promotion add no row before the change date.
    const t4 = await makeTicket(P, { businessDate: plus(m2, 20) });
    await tick(P);
    await invariants("late tick");
    assert.deepEqual(await globalOf(t4.id), {
      period_key: "M" + m2.slice(0, 7),
      part: 2,
      periodicity: "month",
      status: "valid",
    });
    await due(P.tenantId);
    await tick(P);
    await invariants("tick after every due time");

    // Rows exist (none of them open is enough): a new change waits for the first of next month.
    const saved = await saveSettings(P, { globalPeriodicity: "month" });
    assert.equal(saved.settings?.globalPeriodicity, "day");
    assert.equal(saved.settings?.nextPeriodicity, "month");
    assert.equal(
      saved.settings?.nextPeriodicityFrom,
      firstOfNextMonth(today()),
    );
    const fresh = await makeTenant("periodicity deferred with open rows");
    await activate(fresh);
    const [{ open, built }] = await admin`
      select count(*) filter (where status = 'open')::int as open,
        count(*) filter (where status <> 'open')::int as built
      from cfdi_global_periods where tenant_id = ${fresh.tenantId}`;
    assert.deepEqual({ open, built }, { open: 1, built: 0 });
    const deferred = await saveSettings(fresh, { globalPeriodicity: "day" });
    assert.equal(
      deferred.settings?.globalPeriodicity,
      "month",
      "the current month's open row keeps its periodicity",
    );
    assert.equal(deferred.settings?.nextPeriodicity, "day");
  });

  await test("20. self-invoice window: month and days policies; an expired code is refused; more than 5 portal attempts per ticket in 24 h are refused", async () => {
    const old = await makeTicket(A, { businessDate: daysAgo(20) });
    await saveSettings(A, { selfInvoicePolicy: "days", selfInvoiceDays: 3 });
    const view = await portal.portalTicket(app, old.code);
    assert.equal(view.eligibility, "expired");
    await rejects(
      portal.portalSubmit(app, old.code, {
        operationId: op(),
        receptor: MORAL,
        cardForm: null,
        privacyAccepted: true,
        locale: "es",
      }),
      "cfdi_portal_expired",
    );
    await saveSettings(A, { selfInvoicePolicy: "month" });
    const recent = await makeTicket(A);
    assert.equal(
      (await portal.portalTicket(app, recent.code)).eligibility,
      "available",
    );
    for (let i = 0; i < 5; i++) {
      await portal.portalSubmit(app, recent.code, {
        operationId: op(),
        receptor: {
          ...MORAL,
          legalName: "UNIVERSIDAD FAKE ZIP MISMATCH",
          email: "c@example.com",
        },
        cardForm: null,
        privacyAccepted: true,
        locale: "es",
      });
      await settle(A.tenantId);
    }
    await rejects(
      portal.portalSubmit(app, recent.code, {
        operationId: op(),
        receptor: MORAL,
        cardForm: null,
        privacyAccepted: true,
        locale: "es",
      }),
      "cfdi_portal_too_many_attempts",
    );
    await rejects(
      portal.portalSubmit(app, recent.code, {
        operationId: op(),
        receptor: { ...MORAL, email: null },
        cardForm: null,
        privacyAccepted: true,
        locale: "es",
      }),
      "cfdi_email_required",
    );
    // Self-invoicing off: the portal says to ask at the restaurant.
    await saveSettings(A, { selfInvoiceEnabled: false });
    assert.equal(
      (await portal.portalTicket(app, (await makeTicket(A)).code)).eligibility,
      "disabled",
    );
    assert.equal(await web(A, (tx) => selfInvoiceOffered(tx)), false);
    await saveSettings(A, { selfInvoiceEnabled: true });
  });

  await test("21. email: deliver emails once per document and records emailed_at; a resend is a new operation to a new address", async () => {
    const tk = await makeTicket(A);
    const d = await invoice(A, tk);
    await settle(A.tenantId);
    const provider = [...fake.invoices.values()].find(
      (i) => i.body.external_id === d.id,
    )!;
    assert.equal(
      fake.emails.filter((e) => e.invoiceId === provider.id).length,
      1,
    );
    await web(A, (tx) =>
      service.emailDocument(
        tx,
        A.cashier,
        { operationId: op(), email: "contabilidad@example.com" },
        { params: { id: d.id } } as never,
      ),
    );
    await settle(A.tenantId);
    const sent = fake.emails.filter((e) => e.invoiceId === provider.id);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].to, ["contabilidad@example.com"]);
    const [job] =
      await admin`select payload from jobs where tenant_id = ${A.tenantId} and kind = 'cfdi_deliver' and payload->>'email' = 'true' order by created_at desc limit 1`;
    assert.ok(
      !JSON.stringify(job.payload).includes("@"),
      "no address in a job payload (R16)",
    );
  });

  await test("22. amount check: a provider that rounds differently marks the document differs and alerts; an egreso whose canonical IVA differs from fiscal's adjustment by a centavo is exact", async () => {
    const tk = await makeTicket(A, {
      groups: [{ category: "iva16", gross: 11699 }],
    });
    alerts.length = 0;
    const d = await invoice(A, tk, {
      receptor: { legalName: "UNIVERSIDAD FAKE ROUNDING" },
    });
    await settle(A.tenantId);
    const row = await docRow(d.id);
    assert.equal(row.amount_check, "differs");
    assert.ok(alerts.some((a) => a.key.startsWith("cfdi_amount_mismatch:")));
    // Ticket 1.05 at 16 %, refund 0.50: fiscal's complement extraction gives the refund
    // extract(1.05) − extract(0.55) = 0.14 − 0.08 = 0.06 of IVA, the credit note stamps
    // extract(0.50) = 0.07 (the documented ≤ 1 centavo per category).
    const tk2 = await makeTicket(A, {
      groups: [{ category: "iva16", gross: 105 }],
    });
    await invoice(A, tk2);
    await settle(A.tenantId);
    alerts.length = 0;
    const r = await refund(A, tk2, { iva16: 50 });
    await settle(A.tenantId);
    const [e] =
      await admin`select id, amount_check, expected_tax from cfdi_documents where refund_id = ${r}`;
    assert.equal(e.expected_tax, 7);
    assert.equal(e.amount_check, "exact");
    const [frozen] =
      await admin`select detail from cfdi_events where document_id = ${e.id} and kind = 'frozen'`;
    assert.equal(frozen.detail.fiscalTax, 6);
    assert.equal(
      alerts.filter((a) => a.key.startsWith("cfdi_amount_mismatch")).length,
      0,
    );
  });

  await test("23. organization provisioning is idempotent: a lost createOrganization response is recovered by name search, never two organizations", async () => {
    const P = await makeTenant("FAKE LOST RESPONSE");
    await web(P, (tx) =>
      service.activate(tx, P.owner, { operationId: op(), expectedVersion: 0 }),
    );
    await settle(P.tenantId);
    await due(P.tenantId, "cfdi_org");
    await settle(P.tenantId);
    const marker = `CFDI FAKE LOST RESPONSE · GM-${P.tenantId.slice(0, 8)}`;
    const orgs = [...fake.organizations.values()].filter(
      (o) => o.name === marker,
    );
    assert.equal(orgs.length, 1);
    const [org] =
      await admin`select status, provider_org_id from cfdi_organizations where tenant_id = ${P.tenantId}`;
    assert.equal(org.status, "ready");
    assert.equal(org.provider_org_id, orgs[0].id);
  });

  await test("RESICO (LD-16 L9): a persona física in 626 invoicing a persona moral stamps the 1.25 % ISR retention and the pre-retention totals check exact", async () => {
    const R = await makeTenant("resico", {
      rfc: "XIQB891116QE4",
      legalName: "BERENICE XIMO QUEZADA",
      regime: "626",
    });
    await activate(R);
    const tk = await makeTicket(R, {
      groups: [{ category: "iva16", gross: 11600 }],
    });
    const d = await invoice(R, tk);
    await settle(R.tenantId);
    const row = await docRow(d.id);
    assert.equal(row.status, "valid");
    assert.equal(row.expected_withholding, 125);
    assert.equal(row.withheld, 125);
    assert.equal(row.amount_check, "exact");
    assert.equal(row.total, 11600 - 125);
    assert.deepEqual(row.request.items[0].product.taxes[1], {
      type: "ISR",
      rate: 0.0125,
      factor: "Tasa",
      withholding: true,
    });
    // A persona física receptor: no retention.
    const tk2 = await makeTicket(R);
    const d2 = await invoice(R, tk2, {
      receptor: {
        rfc: "XIQB891116QE4",
        legalName: "BERENICE XIMO QUEZADA",
        regime: "612",
        use: "G03",
      },
    });
    await settle(R.tenantId);
    assert.equal((await docRow(d2.id)).expected_withholding, 0);
  });

  await test("reports hooks: cfdiAlerts/cfdiReportAlerts map the attention counts and Hoy (todaySummary) carries them; the corte del día (dayCorte) carries extra.cfdi; disabled CFDI gives neither", async () => {
    const a = await web(A, (tx) => cfdiAlerts(tx));
    assert.equal(a.mode, "test");
    const mapped = cfdiReportAlerts(a);
    assert.ok(mapped.every((m) => m.code.startsWith("cfdi_") && m.count > 0));
    // Reports 029's anchors are filled: Hoy carries exactly these codes and the corte del día the
    // coverage of its date (wave2-cross-track C31).
    const hoy = await web(A, (tx) =>
      todaySummary(tx, A.manager, "cfdi-db", reportsPorts),
    );
    assert.ok(mapped.length > 0, "tenant A has CFDI attention items here");
    assert.deepEqual(
      hoy.alerts.filter((x) => x.code.startsWith("cfdi_")),
      mapped,
    );
    const corte = await web(A, (tx) =>
      dayCorte(tx, A.manager, today(), "cfdi-db", reportsPorts),
    );
    assert.deepEqual(
      corte.extra.cfdi,
      await web(A, (tx) => cfdiCoverage(tx, { from: today(), to: today() })),
    );
    assert.ok((corte.extra.cfdi as { tickets: number }).tickets > 0);
    const fresh = await makeTenant("no-cfdi");
    assert.deepEqual(
      cfdiReportAlerts(await web(fresh, (tx) => cfdiAlerts(tx))),
      [],
    );
    assert.equal(
      await web(fresh, (tx) =>
        cfdiCoverage(tx, { from: today(), to: today() }),
      ),
      null,
    );
    const freshHoy = await web(fresh, (tx) =>
      todaySummary(tx, fresh.manager, "cfdi-db", reportsPorts),
    );
    assert.equal(
      freshHoy.alerts.filter((x) => x.code.startsWith("cfdi_")).length,
      0,
    );
    const freshCorte = await web(fresh, (tx) =>
      dayCorte(tx, fresh.manager, today(), "cfdi-db", reportsPorts),
    );
    assert.equal(
      "cfdi" in freshCorte.extra,
      false,
      "no CFDI section while off",
    );
    // 24 (negative half): no refund job while CFDI is not activated.
    const tk = await makeTicket(fresh);
    const r = await refund(fresh, tk, { iva16: 100 });
    const [{ n }] =
      await admin`select count(*)::int as n from jobs where tenant_id = ${fresh.tenantId} and dedupe_key = ${"refund:" + r}`;
    assert.equal(n, 0);
  });

  await test("key rotation: cfdi:rekey re-seals every organization key under the new active kid; the old kid is then no longer needed", async () => {
    const rotated = parseCredentialKeyring(
      "t2:" + Buffer.alloc(32, 9).toString("base64url") + "," + keyring,
    );
    const result = await rekeyOrganizationSecrets(worker, rotated);
    assert.equal(result.failed, 0);
    assert.ok(result.tenants >= 3 && result.resealed >= 3);
    const [{ n }] =
      await admin`select count(*)::int as n from cfdi_secrets where purpose like 'org_%' and wiped_at is null and kid <> 't2'`;
    assert.equal(n, 0);
    assert.deepEqual(await rekeyOrganizationSecrets(worker, rotated), {
      tenants: result.tenants,
      resealed: 0,
      failed: 0,
    });
    // The worker keeps stamping with only the new kid.
    runtime.ring = parseCredentialKeyring(
      "t2:" + Buffer.alloc(32, 9).toString("base64url"),
    );
    const tk = await makeTicket(A);
    const d = await invoice(A, tk);
    await settle(A.tenantId);
    assert.equal((await docRow(d.id)).status, "valid");
    // The listing policy is off in tenant transactions: one organization per tenant.
    const orgs = await tenant(
      worker,
      A.tenantId,
      (tx) => tx`select tenant_id from cfdi_organizations`,
    );
    assert.deepEqual(
      orgs.map((o) => o.tenant_id),
      [A.tenantId],
    );
  });

  await test("7b. CFDI-R1 reissue race: a late request that reaches the global's key after the worker's reissue step (G canceled, G' created) answers cfdi_global_in_progress, never a stranded waiting invoice; retried, it reissues G' and stamps", async () => {
    const day = daysAgo(10);
    const t1 = await makeTicket(A, { businessDate: day });
    const t2 = await makeTicket(A, {
      businessDate: day,
      groups: [{ category: "iva16", gross: 23200 }],
    });
    const t3 = await makeTicket(A, { businessDate: day });
    await tick(A);
    const [g] =
      await admin`select id from cfdi_documents where tenant_id = ${A.tenantId} and kind = 'global'
        and period_key = ${"D" + day} and status = 'valid'`;
    // The motive-04 request is sent first (cfdi_reissue checks G's credit notes under G's key
    // before it sends, CFDI-R3-2): the fake answers pending, so G is canceling and the worker
    // completes the cancellation at its next poll.
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_pending",
      match: { global: true },
    });
    const first = await invoice(A, t1, { s: A.manager, reissueGlobal: true });
    assert.equal(first.status, "waiting");
    await settle(A.tenantId);
    assert.equal((await docRow(g.id)).status, "canceling");
    // Hold G's document key: the worker reads G canceled at the provider, then waits for the key
    // at its step 3; the late request reads G (canceling, holding t2) and waits behind the worker.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const holder = admin.begin(async (tx) => {
      await lockDocument(tx as unknown as Tx, A.tenantId, g.id);
      holding();
      await released;
    });
    await held;
    await due(A.tenantId, "cfdi_reissue");
    const workerRun = settle(A.tenantId);
    await waitFor(async () => (await advisoryWaiters()) >= 1);
    const late = invoice(A, t2, { s: A.manager, reissueGlobal: true }).then(
      (v) => ({ v, e: null as { code?: string } | null }),
      (e: { code?: string }) => ({ v: null, e }),
    );
    await waitFor(async () => (await advisoryWaiters()) >= 2);
    release();
    await holder;
    const outcome = await late;
    await workerRun;
    assert.equal(outcome.e?.code, "cfdi_global_in_progress");
    const [replacement] =
      await admin`select id, status from cfdi_documents where replaces_document_id = ${g.id} and kind = 'global'`;
    assert.equal(replacement.status, "valid");
    assert.equal((await docRow(first.id)).status, "valid");
    const [{ stranded }] =
      await admin`select count(*)::int as stranded from cfdi_documents where tenant_id = ${A.tenantId} and status = 'waiting'`;
    assert.equal(stranded, 0, "no invoice waits on a canceled global");
    const [{ extra }] =
      await admin`select count(*)::int as extra from cfdi_cancellations where document_id = ${g.id}`;
    assert.equal(
      extra,
      1,
      "no second motive-04 cancellation of a canceled global",
    );
    // The retry lands on G' (valid, holding t2): one reissue of G', then the invoice stamps.
    const retried = await invoice(A, t2, { s: A.manager, reissueGlobal: true });
    assert.equal(retried.status, "waiting");
    await settle(A.tenantId);
    assert.equal((await docRow(retried.id)).status, "valid");
    assert.deepEqual(
      (await claims(t2.id))
        .filter((c) => c.state === "active")
        .map((c) => c.document_id),
      [retried.id],
    );
    assert.equal(
      (await claims(t3.id)).filter((c) => c.state === "active").length,
      1,
    );
  });

  await test("R2-5. the replacement global takes its part number under the period key, after the global's key: a reissue waits while the builder holds the period, then numbers the next part; a duplicate part is refused", async () => {
    const [idx] = await admin`
      select indexdef from pg_indexes where tablename = 'cfdi_documents' and indexname = 'cfdi_documents_period'`;
    assert.match(idx.indexdef, /^CREATE UNIQUE INDEX/);
    const day = daysAgo(11);
    const t1 = await makeTicket(A, { businessDate: day });
    const t2 = await makeTicket(A, { businessDate: day });
    await tick(A);
    const [g] = await admin`
      select id, part, period_key from cfdi_documents where tenant_id = ${A.tenantId} and kind = 'global'
        and period_key = ${"D" + day} and status = 'valid'`;
    // Hold the period's key as a late or supplementary build would: the reissue cancels G at
    // the provider, takes G's key, then waits for the period key before numbering G'.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const holder = admin.begin(async (tx) => {
      await lockPeriod(tx as unknown as Tx, A.tenantId, "test", g.period_key);
      holding();
      await released;
    });
    await held;
    const late = await invoice(A, t1, { s: A.manager, reissueGlobal: true });
    assert.equal(late.status, "waiting");
    const workerRun = settle(A.tenantId);
    await waitFor(async () => (await advisoryWaiters()) >= 1);
    const [{ created }] = await admin`
      select count(*)::int as created from cfdi_documents where replaces_document_id = ${g.id}`;
    assert.equal(created, 0, "G' is not numbered while the period key is held");
    release();
    await holder;
    await workerRun;
    const [replacement] = await admin`
      select part, status from cfdi_documents where replaces_document_id = ${g.id} and kind = 'global'`;
    assert.equal(replacement.status, "valid");
    const [{ max }] = await admin`
      select max(part)::int as max from cfdi_documents where tenant_id = ${A.tenantId} and kind = 'global'
        and mode = 'test' and period_key = ${g.period_key}`;
    assert.equal(replacement.part, max);
    assert.ok(replacement.part > g.part);
    assert.equal((await docRow(late.id)).status, "valid");
    assert.equal(
      (await claims(t2.id)).filter((c) => c.state === "active").length,
      1,
    );
    // The index backs the key: a second document with an existing part number is refused.
    await assert.rejects(
      admin.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${A.tenantId}, true)`;
        await tx`
          insert into cfdi_documents(tenant_id, id, kind, source, mode, status, period_key, global_info, part)
          values (${A.tenantId}, ${randomUUID()}, 'global', 'scheduler', 'test', 'queued', ${g.period_key},
            '{"periodicity":"day","months":"01","year":2026}', ${g.part})`;
      }),
      (e: { code?: string }) => e.code === "23505",
    );
  });

  await test("R2. CFDI unavailable in the worker for longer than every retry limit: no cfdi job dies or uses up attempts (each hands over to a fresh copy); restored, the pending stamp, the cancellation awaiting acceptance, the queued cancellation, the queued stamp and the tick chain resume", async () => {
    const R = await makeTenant("unavailable");
    await activate(R, { testFrom: daysAgo(40), periodicity: "day" });
    const p = await invoice(R, await makeTicket(R), {
      receptor: { legalName: "UNIVERSIDAD FAKE PENDING" },
    });
    const k = await invoice(R, await makeTicket(R), {
      receptor: { legalName: "UNIVERSIDAD FAKE CANCEL PENDING" },
    });
    const q = await invoice(R, await makeTicket(R));
    await settle(R.tenantId);
    assert.equal((await docRow(p.id)).status, "pending");
    await cancelAs(R, R.manager, k.id);
    await settle(R.tenantId);
    assert.equal((await docRow(k.id)).status, "canceling");
    await cancelAs(R, R.manager, q.id);
    const s = await invoice(R, await makeTicket(R));
    const deadBefore = dead.length;
    setCfdiRuntime(null);
    try {
      // More rounds than any cfdi kind allows attempts (20 is the highest).
      for (let i = 0; i < 25; i++) {
        await due(R.tenantId);
        await settle(R.tenantId);
      }
    } finally {
      setCfdiRuntime(runtime);
    }
    assert.equal(dead.length, deadBefore, "no cfdi job died");
    const [{ most }] =
      await admin`select max(attempts)::int as most from jobs where tenant_id = ${R.tenantId} and dedupe_key like '%:wait:%'`;
    assert.equal(most, 1, "waiting never uses up attempts");
    const waiting =
      await admin`select kind from jobs where tenant_id = ${R.tenantId} and state = 'available' and dedupe_key like '%:wait:25'`;
    for (const kind of [
      "cfdi_reconcile",
      "cfdi_cancel",
      "cfdi_stamp",
      "cfdi_global",
    ])
      assert.ok(
        waiting.some((w) => w.kind === kind),
        kind + " still waiting",
      );
    assert.equal((await docRow(p.id)).status, "pending");
    assert.equal((await docRow(k.id)).status, "canceling");
    assert.equal((await docRow(q.id)).status, "valid");
    assert.equal((await docRow(s.id)).status, "queued");
    // Restored.
    for (let i = 0; i < 2; i++) {
      await due(R.tenantId);
      await settle(R.tenantId);
    }
    assert.equal((await docRow(p.id)).status, "valid");
    assert.equal((await docRow(k.id)).status, "canceled");
    assert.equal((await docRow(q.id)).status, "canceled");
    assert.equal((await docRow(s.id)).status, "valid");
    assert.ok(
      (await liveTicks(R.tenantId)).length >= 1,
      "the tick chain lives",
    );
  });

  await test("R2b. recovery: with its job gone, a pending stamp, a staff cancellation never sent and files never stored are re-enqueued by the tick's sweep (once), a canceling document by Reintentar; a document with nothing stranded is not retryable", async () => {
    const R = await makeTenant("recovery");
    await activate(R, { testFrom: daysAgo(40), periodicity: "day" });
    // Files: every download of the next invoice fails until its deliver job dies (8 attempts).
    fake.fault({ op: "invoices.download", fault: "internal_error", times: 8 });
    const f = await invoice(R, await makeTicket(R));
    await settle(R.tenantId);
    for (let i = 0; i < 8; i++) {
      await due(R.tenantId, "cfdi_deliver");
      await settle(R.tenantId);
    }
    const [deliver] =
      await admin`select state from jobs where tenant_id = ${R.tenantId} and dedupe_key = ${"deliver:" + f.id}`;
    assert.equal(deliver.state, "dead");
    const p = await invoice(R, await makeTicket(R), {
      receptor: { legalName: "UNIVERSIDAD FAKE PENDING" },
    });
    const k = await invoice(R, await makeTicket(R), {
      receptor: { legalName: "UNIVERSIDAD FAKE CANCEL PENDING" },
    });
    const q = await invoice(R, await makeTicket(R));
    await settle(R.tenantId);
    await cancelAs(R, R.manager, k.id);
    await settle(R.tenantId);
    await cancelAs(R, R.manager, q.id);
    assert.equal((await docRow(p.id)).status, "pending");
    assert.equal((await docRow(k.id)).status, "canceling");
    // Every job gone (as after dead jobs).
    await admin`update jobs set state = 'dead' where tenant_id = ${R.tenantId}
      and kind in ('cfdi_reconcile','cfdi_cancel') and state in ('queued','available')`;
    await age([f.id, p.id, k.id, q.id], 31);
    await admin.begin(async (tx) => {
      await tx`alter table cfdi_cancellations disable trigger cfdi_cancellations_guard`;
      await tx`update cfdi_cancellations set created_at = created_at - interval '31 minutes' where document_id = ${q.id}`;
      await tx`alter table cfdi_cancellations enable trigger cfdi_cancellations_guard`;
    });
    const view = (id: string) =>
      web(R, (tx) =>
        service.getDocument(tx, R.manager, { params: { id } } as never),
      );
    for (const d of [f, p, k, q])
      assert.equal((await view(d.id)).canRetry, true, "Reintentar offered");
    await web(R, (tx) =>
      service.retryDocument(tx, R.manager, { operationId: op() }, {
        params: { id: k.id },
      } as never),
    );
    await tick(R);
    assert.equal((await docRow(p.id)).status, "valid");
    assert.equal((await docRow(k.id)).status, "canceled");
    assert.equal((await docRow(q.id)).status, "canceled");
    const [{ files }] =
      await admin`select count(*)::int as files from cfdi_files where document_id = ${f.id} and format in ('xml','pdf')`;
    assert.equal(files, 2);
    const swept = async () =>
      (
        await admin`select document_id, detail->>'action' as action from cfdi_events
          where tenant_id = ${R.tenantId} and kind = 'recovery_queued' order by document_id`
      ).map((r) => `${r.document_id}:${r.action}`);
    assert.deepEqual(
      (await swept()).sort(),
      [`${f.id}:deliver`, `${p.id}:reconcile`, `${q.id}:cancel`].sort(),
      "the canceling document was already served by Reintentar's poll",
    );
    await tick(R);
    assert.equal((await swept()).length, 3, "nothing left to recover");
    await rejects(
      web(R, (tx) =>
        service.retryDocument(tx, R.manager, { operationId: op() }, {
          params: { id: f.id },
        } as never),
      ),
      "cfdi_not_retryable",
    );
  });

  await test("R3. the global tick chain never ends: a tick failing at its last attempt schedules the next one before it goes dead; GET /cfdi/status and the worker boot restart a chain with no live tick (enabled restaurants only)", async () => {
    const T = await makeTenant("ticks");
    await activate(T, { testFrom: daysAgo(40), periodicity: "day" });
    const failing = "tick:test:" + randomUUID();
    await web(T, (tx) =>
      cfdiEnqueue(tx, T.tenantId, {
        kind: "cfdi_global",
        dedupeKey: failing,
        payload: {},
      }),
    );
    await admin`update jobs set state = 'done' where tenant_id = ${T.tenantId} and kind = 'cfdi_global'
      and state in ('queued','available') and dedupe_key <> ${failing}`;
    await admin`update jobs set attempts = 19 where tenant_id = ${T.tenantId} and dedupe_key = ${failing}`;
    const config = runtime.config as { graceMinutes: number };
    const grace = config.graceMinutes;
    config.graceMinutes = Number.NaN; // every tick now throws
    dead.length = 0;
    const before = nextHour(new Date()).toISOString();
    try {
      await settle(T.tenantId);
    } finally {
      config.graceMinutes = grace;
    }
    const after = nextHour(new Date()).toISOString();
    const [job] =
      await admin`select state, error_code from jobs where tenant_id = ${T.tenantId} and dedupe_key = ${failing}`;
    assert.deepEqual(
      { ...job },
      { state: "dead", error_code: "cfdi_attempts_exhausted" },
    );
    assert.deepEqual(dead, [
      { kind: "cfdi_global", code: "cfdi_attempts_exhausted" },
    ]);
    const live = await liveTicks(T.tenantId);
    assert.equal(live.length, 1);
    assert.ok(
      [`tick:${before}`, `tick:${after}`].includes(live[0].dedupe_key),
      live[0].dedupe_key,
    );
    // Sign-in restarts a chain with no live tick.
    await admin`update jobs set state = 'dead' where tenant_id = ${T.tenantId} and kind = 'cfdi_global' and state = 'available'`;
    await web(T, (tx) => service.getStatus(tx, T.cashier));
    assert.match(
      (await liveTicks(T.tenantId))[0]?.dedupe_key ?? "",
      /^tick:status:/,
    );
    await web(T, (tx) => service.getStatus(tx, T.cashier));
    assert.equal(
      (await liveTicks(T.tenantId)).length,
      1,
      "only when none is live",
    );
    // The worker boot does too, for enabled restaurants only.
    await admin`update jobs set state = 'dead' where tenant_id = ${T.tenantId} and kind = 'cfdi_global' and state = 'available'`;
    const P = await makeTenant("paused ticks");
    await activate(P, { testFrom: daysAgo(40), periodicity: "day" });
    await saveSettings(P, { enabled: false });
    await admin`update jobs set state = 'dead' where tenant_id = ${P.tenantId} and kind = 'cfdi_global' and state = 'available'`;
    assert.ok((await seedGlobalTicks(worker)) >= 1);
    assert.match(
      (await liveTicks(T.tenantId))[0]?.dedupe_key ?? "",
      /^tick:boot:/,
    );
    assert.equal((await liveTicks(P.tenantId)).length, 0, "paused: no tick");
    await settle(T.tenantId);
    assert.ok((await liveTicks(T.tenantId)).length >= 1, "the chain continues");
  });

  await test("R4/R9. the staff ticket view carries the restaurant's card form (a card ticket invoiced with it stamps FormaPago 28); a cashier sees only the documents they created in the last 24 h and download links only for those", async () => {
    await saveSettings(A, { cardPaymentForm: "28" });
    try {
      const tk = await makeTicket(A, {
        payments: [{ method: "external", amount: 11600 }],
      });
      const ticketView = (s: Session, ticketId: string) =>
        web(A, (tx) =>
          service.getTicket(tx, s, { params: { ticketId } } as never),
        );
      const view = await ticketView(A.cashier, tk.id);
      assert.equal(view.needsCardForm, true);
      assert.equal(view.cardPaymentForm, "28");
      const d = await invoice(A, tk, {
        s: A.manager,
        cardForm: view.cardPaymentForm,
      });
      await settle(A.tenantId);
      assert.equal((await docRow(d.id)).payment_form, "28");
      const cashier = await ticketView(A.cashier, tk.id);
      assert.deepEqual(cashier.documents, []);
      assert.equal(cashier.covering?.documentId, d.id);
      assert.equal(cashier.covering?.canOpen, false);
      const manager = await ticketView(A.manager, tk.id);
      assert.deepEqual(
        manager.documents.map((x) => x.id),
        [d.id],
      );
      assert.equal(manager.covering?.canOpen, true);
      const tk2 = await makeTicket(A);
      const own = await invoice(A, tk2);
      await settle(A.tenantId);
      const mine = await ticketView(A.cashier, tk2.id);
      assert.deepEqual(
        mine.documents.map((x) => x.id),
        [own.id],
      );
      assert.equal(mine.covering?.canOpen, true);
    } finally {
      await saveSettings(A, { cardPaymentForm: "04" });
    }
  });

  await test("R7. a credit note the provider refuses is not re-created by the tick's refund sweep; Reintentar (force) issues a new one", async () => {
    const tk = await makeTicket(A);
    await invoice(A, tk);
    await settle(A.tenantId);
    fake.fault({
      op: "invoices.create",
      fault: "stamp_failed",
      match: { type: "E" },
    });
    const r = await refund(A, tk, { iva16: 1160 });
    await settle(A.tenantId);
    const [failed] =
      await admin`select id, status from cfdi_documents where refund_id = ${r}`;
    assert.equal(failed.status, "failed");
    await tick(A);
    assert.equal(
      (await admin`select id from cfdi_documents where refund_id = ${r}`)
        .length,
      1,
      "the sweep leaves the failed credit note to Reintentar",
    );
    await web(A, (tx) =>
      service.retryDocument(tx, A.manager, { operationId: op() }, {
        params: { id: failed.id },
      } as never),
    );
    await settle(A.tenantId);
    assert.deepEqual(
      (
        await admin`select status from cfdi_documents where refund_id = ${r} order by created_at`
      ).map((x) => x.status),
      ["failed", "valid"],
    );
  });

  await test("R12. two concurrent activations: one wins, the other answers cfdi_settings_changed (never a 500); the register cursor keeps microseconds and a malformed cursor is refused", async () => {
    const T = await makeTenant("activation race");
    const results = await noRetries("concurrent activations", () =>
      Promise.allSettled(
        [0, 1].map(() =>
          web(T, (tx) =>
            service.activate(tx, T.owner, {
              operationId: op(),
              expectedVersion: 0,
            }),
          ),
        ),
      ),
    );
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    const lost = results.find(
      (x) => x.status === "rejected",
    ) as PromiseRejectedResult;
    assert.equal(lost.reason.code, "cfdi_settings_changed");
    await settle(T.tenantId);
    const list = (query: Record<string, string>) =>
      web(A, (tx) =>
        service.listDocumentsRoute(tx, A.manager, {
          query: { from: daysAgo(40), to: today(), ...query },
        } as never),
      );
    const first = await list({ limit: "1" });
    assert.match(
      first.next ?? "",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}$/,
    );
    const second = await list({ limit: "1", after: first.next! });
    assert.notEqual(second.rows[0]?.id, first.rows[0].id);
    const both = await list({ limit: "2" });
    assert.deepEqual(
      both.rows.map((x) => x.id),
      [first.rows[0].id, second.rows[0].id],
    );
    await assert.rejects(
      list({ after: "yesterday|" + randomUUID() }),
      (e: Error) => e.name === "ZodError",
    );
  });

  await test("17e. LD-21 / PLATFORM-OPS-10: worker discovery, the claim and expireLostJobs find running jobs with expired leases through jobs_running_lease_until (tenant_id, kind, lease_until), not by scanning a tenant's done jobs", async () => {
    const [def] = await admin`
      select indexdef from pg_indexes where tablename = 'jobs' and indexname = 'jobs_running_lease_until'`;
    assert.match(
      def?.indexdef ?? "",
      /\(tenant_id, kind, lease_until\) WHERE \(state = 'running'::text\)$/,
    );
    // 30 days of done rows of one kind for one tenant, as kitchen_dispatch leaves them.
    const X = await makeTenant("jobs explain");
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${X.tenantId}, true)`;
      await tx`
        insert into jobs(tenant_id, id, kind, dedupe_key, payload, state, attempts, next_at, created_at)
        select ${X.tenantId}, gen_random_uuid(), 'cfdi_deliver', 'explain:' || n, '{}', 'done', 1,
          now() - make_interval(mins => n), now() - make_interval(mins => n)
        from generate_series(1, 4000) n`;
    });
    await admin`analyze jobs`;
    // Runs the real statement of each function with EXPLAIN in front (same text, same
    // parameters), as the worker login: outside a tenant for discovery, inside one otherwise.
    const plans: unknown[] = [];
    const explaining = <S extends object>(sql: S): S =>
      new Proxy(sql, {
        apply(target, self, args: unknown[]) {
          const [strings, ...values] = args as [
            TemplateStringsArray,
            ...unknown[],
          ];
          const raw = [
            "explain (format json) " + strings[0],
            ...strings.slice(1),
          ];
          const query = (
            target as unknown as (
              ...a: unknown[]
            ) => Promise<Record<string, unknown>[]>
          )(Object.assign([...raw], { raw }), ...values);
          return query.then((rows) => {
            plans.push(rows[0]["QUERY PLAN"]);
            return [];
          });
        },
      });
    const kinds = [...workerHandlers().keys()].filter((k) =>
      k.startsWith("cfdi_"),
    );
    // Sequential scans off (in these transactions only): CI's Postgres 18 and a jobs table
    // filled by the earlier suites must not turn the check into a planner-cost coin flip; the
    // other indexes stay available, so the plan still shows which index serves the predicate.
    const noSeqScan = (tx: Tx) => tx`set local enable_seqscan = off`;
    await worker.begin(async (tx) => {
      await noSeqScan(tx as unknown as Tx);
      await discoverTenants(explaining(tx as unknown as typeof worker), kinds);
    });
    await tenant(worker, X.tenantId, async (tx) => {
      await noSeqScan(tx);
      return claimJobs(explaining(tx), kinds, 4, 60, 12);
    });
    await tenant(worker, X.tenantId, async (tx) => {
      await noSeqScan(tx);
      return expireLostJobs(explaining(tx), "cfdi_deliver", 12);
    });
    assert.equal(plans.length, 3);
    const scans = (plan: unknown) => {
      const out: { index: string; cond: string }[] = [];
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object") return;
        const o = n as Record<string, unknown>;
        if (typeof o["Index Name"] === "string")
          out.push({
            index: o["Index Name"],
            cond: String(o["Index Cond"] ?? ""),
          });
        Object.values(o).forEach(walk);
      };
      walk(plan);
      return out;
    };
    const [discovery, claim, expiry] = plans.map(scans);
    const uses = (list: { index: string; cond: string }[], label: string) => {
      const hit = list.find((x) => x.index === "jobs_running_lease_until");
      assert.ok(hit, `${label}: ${JSON.stringify(list)}`);
      return hit!;
    };
    assert.match(uses(discovery, "discovery").cond, /lease_until < now\(\)/);
    const c = uses(claim, "claim").cond;
    assert.match(c, /tenant_id = /);
    assert.match(c, /kind = ANY/);
    const e = uses(expiry, "expireLostJobs").cond;
    assert.match(e, /tenant_id = /);
    assert.match(e, /kind = /);
    assert.match(e, /lease_until < now\(\)/);
  });

  await test("17c. the -- 030 cfdi grants block is idempotent (applied twice)", async () => {
    const grants = readFileSync("scripts/grants.sql", "utf8");
    const block = grants.slice(grants.indexOf("-- 030 cfdi"));
    for (let i = 0; i < 2; i++) await admin.begin((tx) => tx.unsafe(block));
    const [r] =
      await admin`select has_table_privilege('gm_jobs_worker', 'fiscal_tickets', 'SELECT') as fiscal,
      has_table_privilege('gm_app', 'cfdi_secrets', 'SELECT') as secrets`;
    assert.deepEqual({ ...r }, { fiscal: true, secrets: false });
  });

  // -------------------------------------------------------------------------------------------
  // Second-opinion hardening (LD-5, LD-33)
  // -------------------------------------------------------------------------------------------

  /** The owner's CSD upload of the synthetic test certificate. */
  const uploadTestCsd = (t: Fixture) =>
    web(t, (tx) =>
      service.uploadCsd(tx, t.owner, {
        operationId: op(),
        cer: TEST_CSD.cer,
        key: TEST_CSD.key,
        password: TEST_CSD_PASSWORD,
      }),
    );
  /** Activation without running the organization's provisioning (it stays without an org id). */
  async function activateUnprovisioned(t: Fixture) {
    await web(t, (tx) =>
      service.activate(tx, t.owner, { operationId: op(), expectedVersion: 0 }),
    );
    await admin`update jobs set next_at = now() + interval '1 day'
      where tenant_id = ${t.tenantId} and kind = 'cfdi_org'`;
  }
  const uploadRow = async (t: Fixture) =>
    (
      await admin`select u.status, u.error_code, s.payload_secret is null as wiped, s.wiped_at is not null as wiped_at
        from cfdi_csd_uploads u join cfdi_secrets s on s.tenant_id = u.tenant_id and s.id = u.secret_id
        where u.tenant_id = ${t.tenantId} order by u.created_at desc limit 1`
    )[0];

  /** An invoice whose substitution's motive-01 cancellation the receptor rejected (D1, D2 valid). */
  async function rejectedSubstitution(t: Fixture) {
    const tk = await makeTicket(t);
    const d1 = await invoice(t, tk);
    await settle(t.tenantId);
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_rejected",
      match: { type: "I", global: false },
    });
    const d2 = await substitute(t, d1.id);
    await settle(t.tenantId);
    await due(t.tenantId, "cfdi_reconcile");
    await settle(t.tenantId);
    assert.equal((await docRow(d1.id)).status, "valid");
    assert.equal((await docRow(d2.id)).status, "valid");
    return { tk, d1, d2 };
  }
  const substitute = (t: Fixture, id: string) =>
    web(t, (tx) =>
      service.substituteDocument(
        tx,
        t.manager,
        {
          operationId: op(),
          receptor: { ...MORAL, postalCode: "86990" },
          cardForm: null,
          reason: "CP equivocado",
        },
        { params: { id } } as never,
      ),
    );
  const requestAgain = (t: Fixture, id: string) =>
    web(t, (tx) =>
      service.cancelDocument(
        tx,
        t.manager,
        { operationId: op(), motive: "01", reason: "Otra vez" },
        { params: { id } } as never,
      ),
    );
  const viewOf = (t: Fixture, id: string) =>
    web(t, (tx) =>
      service.getDocument(tx, t.manager, { params: { id } } as never),
    );
  /** The worker's own transitions, as an earlier release (or a race) could have left them. */
  const asWorker = <T>(t: Fixture, fn: (tx: Tx) => Promise<T>) =>
    tenant(worker, t.tenantId, fn);

  /** An invoice D with one refund credited by a valid credit note E (related 01 to D). */
  async function creditedInvoice(t: Fixture) {
    const tk = await makeTicket(t);
    const d = await invoice(t, tk);
    await settle(t.tenantId);
    const refundId = await refund(t, tk, { iva16: 2320 });
    await settle(t.tenantId);
    const [e] =
      await admin`select id, status, uuid from cfdi_documents where refund_id = ${refundId} and kind = 'egreso'`;
    assert.equal(e.status, "valid");
    return { tk, d, refundId, e };
  }
  const correctCreditNote = (t: Fixture, id: string, paymentForm: string) =>
    web(t, (tx) =>
      service.substituteDocument(
        tx,
        t.manager,
        { operationId: op(), paymentForm, reason: "Se reembolsó en efectivo" },
        { params: { id } } as never,
      ),
    );

  const portalRequest = (code: string, legalName = MORAL.legalName) =>
    portal.portalSubmit(app, code, {
      operationId: op(),
      receptor: { ...MORAL, legalName, email: "cliente@example.com" },
      cardForm: null,
      privacyAccepted: true,
      locale: "es",
    });

  await test("WORKER-1a. a staff cancellation whose DELETE reached SAT but whose answer was lost is read back on the retry: the invoice ends canceled with its ticket released, never failed by a second DELETE", async () => {
    const W = await makeTenant("worker-1a");
    await activate(W);
    const tk = await makeTicket(W);
    const d = await invoice(W, tk);
    await settle(W.tenantId);
    fake.fault({ op: "invoices.cancel", fault: "lost_response" });
    await cancelAs(W, W.manager, d.id);
    await settle(W.tenantId);
    await due(W.tenantId, "cfdi_cancel");
    await settle(W.tenantId);
    const doc = await docRow(d.id);
    assert.equal(doc.status, "canceled");
    const [c] =
      await admin`select status, error_code from cfdi_cancellations where document_id = ${d.id}`;
    assert.deepEqual({ ...c }, { status: "accepted", error_code: null });
    assert.deepEqual(
      (await claims(tk.id)).map((r) => r.released_reason),
      ["canceled"],
    );
  });

  await test("WORKER-1b. a reissue whose motive-04 DELETE reached SAT but whose answer was lost reads the global back on the retry: G is canceled, G' replaces it and the waiting invoice stamps", async () => {
    const W = await makeTenant("worker-1b");
    await activate(W, { testFrom: daysAgo(40), periodicity: "day" });
    const day = daysAgo(4);
    const t1 = await makeTicket(W, { businessDate: day });
    const t2 = await makeTicket(W, { businessDate: day });
    await tick(W);
    const [g] =
      await admin`select id from cfdi_documents where tenant_id = ${W.tenantId} and kind = 'global' and status = 'valid'`;
    fake.fault({ op: "invoices.cancel", fault: "lost_response" });
    const late = await invoice(W, t1, { s: W.manager, reissueGlobal: true });
    await settle(W.tenantId);
    await due(W.tenantId, "cfdi_reissue");
    await settle(W.tenantId);
    assert.equal((await docRow(g.id)).status, "canceled");
    const [c] =
      await admin`select status from cfdi_cancellations where document_id = ${g.id}`;
    assert.equal(c.status, "accepted");
    assert.equal((await docRow(late.id)).status, "valid");
    const [replacement] =
      await admin`select status, ticket_count from cfdi_documents where replaces_document_id = ${g.id} and kind = 'global'`;
    assert.deepEqual({ ...replacement }, { status: "valid", ticket_count: 1 });
    assert.deepEqual(
      (await claims(t2.id)).map((r) => r.state),
      ["released", "active"],
    );
  });

  await test("WORKER-2. a stamp whose answer was lost is adopted on the retry before any permanent precondition: a fiscal-profile change whose legal update Facturapi refuses never fails a document that may already be a valid CFDI", async () => {
    const W = await makeTenant("worker-2");
    await activate(W);
    const tk = await makeTicket(W);
    const d = await invoice(W, tk, {
      receptor: { legalName: "UNIVERSIDAD ROBOTICA FAKE TIMEOUT" },
    });
    await settle(W.tenantId);
    assert.ok((await events(d.id)).includes("stamp_unknown"));
    assert.equal((await docRow(d.id)).status, "stamping");
    // The owner edits Datos fiscales meanwhile; Facturapi refuses the legal update.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${W.tenantId}, true)`;
      await tx`update restaurant_fiscal_profiles set legal_name = 'ESCUELA KEMPER URGATE SA', version = version + 1`;
    });
    fake.fault({ op: "organizations.legal", fault: "legal_rejected" });
    await due(W.tenantId, "cfdi_stamp");
    await settle(W.tenantId);
    const doc = await docRow(d.id);
    assert.equal(doc.status, "valid", "adopted by external_id");
    assert.deepEqual(
      (await claims(tk.id)).map((r) => r.state),
      ["active"],
    );
    const sameKey = [...fake.invoices.values()].filter(
      (i) => i.body.external_id === d.id,
    );
    assert.equal(sameKey.length, 1, "one provider invoice");
    // A first attempt that never reached Facturapi still fails on the refusal (and frees its
    // ticket); it consumes the queued fault.
    const tk2 = await makeTicket(W);
    const d2 = await invoice(W, tk2);
    await settle(W.tenantId);
    const doc2 = await docRow(d2.id);
    assert.deepEqual(
      { status: doc2.status, code: doc2.error_code },
      { status: "failed", code: "cfdi_org_tax_info_invalid" },
    );
  });

  await test("SECRETS-1a. a CSD upload is refused until the restaurant's organization exists at Facturapi (cfdi_not_ready): no sealed box is stored for a job that cannot use it", async () => {
    const W = await makeTenant("secrets-1a");
    await activateUnprovisioned(W);
    await rejects(uploadTestCsd(W), "cfdi_not_ready");
    const [{ n }] =
      await admin`select count(*)::int as n from cfdi_secrets where tenant_id = ${W.tenantId} and purpose = 'csd_upload'`;
    assert.equal(n, 0);
    const view = await web(W, (tx) => service.getSettings(tx, W.owner));
    assert.equal(view.organization?.provisioned, false);
  });

  await test("WORKER-3 / SECRETS-1b. a CSD job whose organization never gets its Facturapi id rejects the upload and wipes the sealed box on its last attempt, so a new upload is possible", async () => {
    const W = await makeTenant("secrets-1b");
    await activateUnprovisioned(W);
    // An upload stored before this release's web check (or by any other path): its job runs.
    const secretId = randomUUID();
    const uploadId = randomUUID();
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${W.tenantId}, true)`;
      await tx`insert into cfdi_secrets(tenant_id, id, purpose, kid, payload_secret)
        values (${W.tenantId}, ${secretId}, 'csd_upload', 'k1', 'sealed-box-fixture')`;
      await tx`insert into cfdi_csd_uploads(tenant_id, id, secret_id, status, requested_by)
        values (${W.tenantId}, ${uploadId}, ${secretId}, 'queued', ${W.owner.employeeId})`;
    });
    await web(W, (tx) =>
      cfdiEnqueue(tx, W.tenantId, {
        kind: "cfdi_csd",
        dedupeKey: "csd:" + uploadId,
        payload: { uploadId },
      }),
    );
    for (let i = 0; i < 4; i++) {
      await due(W.tenantId, "cfdi_csd");
      await settle(W.tenantId);
    }
    const row = await uploadRow(W);
    assert.deepEqual(
      { status: row.status, code: row.error_code, wiped: row.wiped },
      { status: "rejected", code: "cfdi_not_ready", wiped: true },
    );
  });

  await test("WORKER-3 / SECRETS-1c. an upload whose job a manager cancelled (or whose lease expired on its last attempt) is rejected by the tick's sweep with cfdi_csd_abandoned and its sealed box wiped", async () => {
    const W = await makeTenant("secrets-1c");
    await activate(W);
    await uploadTestCsd(W);
    const [job] =
      await admin`select id from jobs where tenant_id = ${W.tenantId} and kind = 'cfdi_csd' and state in ('queued','available')`;
    await web(W, (tx) => cancelJob(tx, W.manager, job.id));
    // The sweep leaves recent uploads alone (their job may still be on its way).
    await tick(W);
    assert.equal((await uploadRow(W)).status, "queued");
    await admin.begin(async (tx) => {
      await tx`alter table cfdi_csd_uploads disable trigger cfdi_csd_uploads_guard`;
      await tx`update cfdi_csd_uploads set created_at = created_at - interval '31 minutes' where tenant_id = ${W.tenantId}`;
      await tx`alter table cfdi_csd_uploads enable trigger cfdi_csd_uploads_guard`;
    });
    await tick(W);
    const row = await uploadRow(W);
    assert.deepEqual(
      { status: row.status, code: row.error_code, wiped: row.wiped },
      { status: "rejected", code: "cfdi_csd_abandoned", wiped: true },
    );
    const [org] =
      await admin`select csd_status from cfdi_organizations where tenant_id = ${W.tenantId}`;
    assert.notEqual(org.csd_status, "processing");
  });

  await test("R4-1a. a substitute with an open cancellation is never handed a motive-01 re-request, and a document named by an open motive-01 cancellation cannot be canceled itself (cfdi_substitution_in_progress)", async () => {
    const W = await makeTenant("r4-1a");
    await activate(W);
    const { tk, d1, d2 } = await rejectedSubstitution(W);
    // The manager cancels the substitute (02): while that is open, D1 offers no re-request.
    await cancelAs(W, W.manager, d2.id);
    const v = await viewOf(W, d1.id);
    assert.equal(v.waitingSubstituteId, null);
    assert.equal(v.canRequestAgain, false);
    await rejects(requestAgain(W, d1.id), "cfdi_substitute_missing");
    await settle(W.tenantId);
    assert.equal((await docRow(d2.id)).status, "canceled");
    const after = await viewOf(W, d1.id);
    assert.equal(after.canCancel, true, "D1 is usable again");
    assert.deepEqual(
      (await claims(tk.id)).map((r) => [r.document_id, r.state]),
      [
        [d1.id, "active"],
        [d2.id, "released"],
      ],
    );
    // During an outage the substitution's own cancellation is retrying: its substitute (valid,
    // named by that open 01) cannot be canceled meanwhile.
    const tk2 = await makeTicket(W);
    const e1 = await invoice(W, tk2);
    await settle(W.tenantId);
    fake.fault({ op: "invoices.cancel", fault: "unavailable" });
    const e2 = await substitute(W, e1.id);
    await settle(W.tenantId);
    assert.equal((await docRow(e2.id)).status, "valid");
    await rejects(
      cancelAs(W, W.manager, e2.id),
      "cfdi_substitution_in_progress",
    );
    await due(W.tenantId, "cfdi_cancel");
    await settle(W.tenantId);
    assert.equal((await docRow(e1.id)).status, "canceled");
    assert.deepEqual(
      (await claims(tk2.id)).map((r) => [r.document_id, r.state]),
      [
        [e1.id, "released"],
        [e2.id, "active"],
      ],
    );
  });

  await test("R4-1b. a motive-01 cancellation whose substitute ended (canceled) before it was sent fails with cfdi_substitute_failed instead of waiting forever, and recovery fails one left queued: the original can be canceled again", async () => {
    const W = await makeTenant("r4-1b");
    await activate(W);
    const { tk, d1, d2 } = await rejectedSubstitution(W);
    await requestAgain(W, d1.id);
    const [c1] =
      await admin`select id from cfdi_cancellations where document_id = ${d1.id} and status = 'queued'`;
    // The substitute is canceled first (a state an earlier release allowed): its claim released.
    await asWorker(W, async (tx) => {
      await tx`update cfdi_documents set status = 'canceled' where id = ${d2.id}`;
      await tx`update cfdi_document_tickets set state = 'released', released_reason = 'canceled', released_at = now()
        where document_id = ${d2.id} and state <> 'released'`;
    });
    await settle(W.tenantId);
    const [c] =
      await admin`select status, error_code from cfdi_cancellations where id = ${c1.id}`;
    assert.deepEqual(
      { ...c },
      {
        status: "failed",
        error_code: "cfdi_substitute_failed",
      },
    );
    assert.ok((await events(d1.id)).includes("cancel_failed"));
    await cancelAs(W, W.manager, d1.id);
    await settle(W.tenantId);
    assert.equal((await docRow(d1.id)).status, "canceled");
    assert.deepEqual(
      (await claims(tk.id)).map((r) => r.state),
      ["released", "released"],
    );
    // Recovery: a queued motive-01 cancellation whose substitute is final is a fixable state.
    const { d1: f1, d2: f2 } = await rejectedSubstitution(W);
    await requestAgain(W, f1.id);
    const [q] =
      await admin`select id from cfdi_cancellations where document_id = ${f1.id} and status = 'queued'`;
    await admin`update jobs set state = 'dead', error_code = 'cancelled' where tenant_id = ${W.tenantId}
      and kind = 'cfdi_cancel' and payload->>'cancellationId' = ${q.id}`;
    await asWorker(W, async (tx) => {
      await tx`update cfdi_documents set status = 'canceled' where id = ${f2.id}`;
      await tx`update cfdi_document_tickets set state = 'released', released_reason = 'canceled', released_at = now()
        where document_id = ${f2.id} and state <> 'released'`;
    });
    const action = await web(W, async (tx) =>
      recoveryAction(
        tx,
        (await loadDocument(tx, f1.id))!,
        Date.now() + 3_600_000,
      ),
    );
    assert.deepEqual(action, { kind: "cancel", cancellationId: q.id });
  });

  await test("R4-1c. while the original's motive-01 cancellation waits for the receptor, its substitute cannot be canceled; a substitute that ended anyway is never handed the ticket (no substitution_completed on a canceled document) and the ticket goes back to the globals", async () => {
    const W = await makeTenant("r4-1c");
    await activate(W);
    const tk = await makeTicket(W);
    const d1 = await invoice(W, tk);
    await settle(W.tenantId);
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_pending",
      match: { type: "I", global: false },
    });
    const d2 = await substitute(W, d1.id);
    await settle(W.tenantId);
    assert.equal((await docRow(d1.id)).status, "canceling");
    await rejects(
      cancelAs(W, W.manager, d2.id),
      "cfdi_substitution_in_progress",
    );
    // The substitute ended anyway (an earlier release): the receptor then accepts D1.
    await asWorker(W, async (tx) => {
      await tx`update cfdi_documents set status = 'canceled' where id = ${d2.id}`;
      await tx`update cfdi_document_tickets set state = 'released', released_reason = 'canceled', released_at = now()
        where document_id = ${d2.id} and state <> 'released'`;
    });
    await due(W.tenantId, "cfdi_reconcile");
    await settle(W.tenantId);
    assert.equal((await docRow(d1.id)).status, "canceled");
    assert.ok(!(await events(d2.id)).includes("substitution_completed"));
    const [after] =
      await admin`select count(*)::int as n from jobs where tenant_id = ${W.tenantId} and kind = 'cfdi_global'
        and dedupe_key like ${"tick:after-cancel:" + d1.id + "%"}`;
    assert.equal(after.n, 1, "the freed ticket goes back to the globals");
  });

  await test("R3-2c. a cancellation completes under its document key (the key cfdi_refund decides under): while a credit-note decision holds it, the completion waits, so the decision never reads the invoice valid and its cancellation already accepted", async () => {
    const W = await makeTenant("cancel-key");
    await activate(W);
    const tk = await makeTicket(W);
    const d = await invoice(W, tk);
    await settle(W.tenantId);
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_pending",
      match: { type: "I", global: false },
    });
    await cancelAs(W, W.manager, d.id);
    await settle(W.tenantId);
    assert.equal((await docRow(d.id)).status, "canceling");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const holder = tenant(app, W.tenantId, async (tx) => {
      await lockDocument(tx, W.tenantId, d.id);
      locked();
      await held;
    });
    await lockTaken;
    await due(W.tenantId, "cfdi_reconcile");
    let finished = false;
    const run = settle(W.tenantId).then(() => (finished = true));
    try {
      await waitFor(async () => finished || (await advisoryWaiters()) >= 1);
      assert.equal(
        (await docRow(d.id)).status,
        "canceling",
        "the completion waits for the document key",
      );
    } finally {
      release();
      await holder;
      await run;
    }
    assert.equal((await docRow(d.id)).status, "canceled");
  });

  await test("MONEY-1a / SAT-2. a credit note is never canceled with motive 02 or 03 (cfdi_not_cancellable): the register offers Sustituir, not Cancelar", async () => {
    const W = await makeTenant("money-1a");
    await activate(W);
    const { e } = await creditedInvoice(W);
    for (const motive of ["02", "03"])
      await rejects(
        web(W, (tx) =>
          service.cancelDocument(
            tx,
            W.manager,
            { operationId: op(), motive, reason: "Forma de pago equivocada" },
            { params: { id: e.id } } as never,
          ),
        ),
        "cfdi_not_cancellable",
      );
    const v = await viewOf(W, e.id);
    assert.equal(v.canCancel, false);
    assert.equal(v.canSubstitute, true);
  });

  await test("MONEY-1b / SAT-2. correcting a credit note issues a substitute for the same refund related 01 to the invoice and 04 to the old note, with the chosen FormaPago; the old note is then canceled with motive 01 and no third note is ever issued", async () => {
    const W = await makeTenant("money-1b");
    await activate(W);
    const { d, refundId, e } = await creditedInvoice(W);
    const e2 = await correctCreditNote(W, e.id, "01");
    await settle(W.tenantId);
    const row = await docRow(e2.id);
    assert.deepEqual(
      {
        kind: row.kind,
        status: row.status,
        refund: row.refund_id,
        form: row.payment_form,
      },
      { kind: "egreso", status: "valid", refund: refundId, form: "01" },
    );
    const parent = await docRow(d.id);
    assert.deepEqual(row.request.related_documents, [
      { relationship: "01", documents: [parent.uuid] },
      { relationship: "04", documents: [e.uuid] },
    ]);
    assert.equal((await docRow(e.id)).status, "canceled");
    const [c] =
      await admin`select motive, status from cfdi_cancellations where document_id = ${e.id}`;
    assert.deepEqual({ ...c }, { motive: "01", status: "accepted" });
    assert.ok((await events(e2.id)).includes("substitution_completed"));
    // The refund stays credited exactly once: neither the decision nor the sweep adds a note.
    await web(W, (tx) =>
      enqueueCfdiRefund(tx, { tenantId: W.tenantId }, refundId),
    );
    await tick(W);
    const live =
      await admin`select id from cfdi_documents where refund_id = ${refundId} and status not in ('failed','canceled')`;
    assert.deepEqual(
      live.map((r) => r.id),
      [e2.id],
    );
    assert.equal((await viewOf(W, d.id)).canCancel, false, "still credited");
  });

  await test("MONEY-1c / SAT-2. when the provider refuses the old note's motive-01 cancellation, both notes are valid: the attention count shows it and the old note offers the cancellation again", async () => {
    const W = await makeTenant("money-1c");
    await activate(W);
    const { e } = await creditedInvoice(W);
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_refused",
      match: { type: "E" },
    });
    const e2 = await correctCreditNote(W, e.id, "28");
    await settle(W.tenantId);
    assert.equal((await docRow(e2.id)).status, "valid");
    assert.equal((await docRow(e.id)).status, "valid");
    const a = await web(W, (tx) => cfdiAlerts(tx));
    assert.equal(a.rejectedSubstitutions, 1);
    const v = await viewOf(W, e.id);
    assert.equal(v.waitingSubstituteId, e2.id);
    assert.equal(v.canRequestAgain, true);
    await requestAgain(W, e.id);
    await settle(W.tenantId);
    assert.equal((await docRow(e.id)).status, "canceled");
    assert.equal(
      (await web(W, (tx) => cfdiAlerts(tx))).rejectedSubstitutions,
      0,
    );
  });

  await test("R4-2. a ticket handed to a substitute frozen before a refund gets that refund re-decided: a credit note related to the substitute, even when the refund's earlier note was canceled", async () => {
    const W = await makeTenant("r4-2");
    await activate(W);
    const { tk, d1, d2 } = await rejectedSubstitution(W);
    const refundId = await refund(W, tk, { iva16: 5800 });
    await settle(W.tenantId);
    const [e1] =
      await admin`select id, parent_document_id from cfdi_documents where refund_id = ${refundId}`;
    assert.equal(e1.parent_document_id, d1.id);
    // The note was canceled (as an earlier release let staff do): D1 can then be canceled.
    await asWorker(
      W,
      (tx) =>
        tx`update cfdi_documents set status = 'canceled' where id = ${e1.id}`,
    );
    await requestAgain(W, d1.id);
    await settle(W.tenantId);
    assert.equal((await docRow(d1.id)).status, "canceled");
    assert.deepEqual(
      (await claims(tk.id)).map((r) => [r.document_id, r.state]),
      [
        [d1.id, "released"],
        [d2.id, "active"],
      ],
    );
    const notes =
      await admin`select parent_document_id, status, expected_total from cfdi_documents
        where refund_id = ${refundId} and status not in ('failed','canceled')`;
    assert.deepEqual(
      notes.map((n) => ({ ...n })),
      [{ parent_document_id: d2.id, status: "valid", expected_total: 5800 }],
    );
  });

  await test("MONEY-2a / SAT-1. tickets released by a cancellation return to a CFDI whatever their age: an invoice and a global canceled with motive 02 more than 62 days after their period hand their tickets to a supplementary part of that period", async () => {
    const W = await makeTenant("money-2a");
    const oldDay = daysAgo(75);
    // A ticket that exists before activation: the activation tick globalizes its day.
    const inGlobal = await makeTicket(W, { businessDate: oldDay });
    await activate(W, { testFrom: daysAgo(120), periodicity: "day" });
    const [g] =
      await admin`select id from cfdi_documents where tenant_id = ${W.tenantId} and kind = 'global'
        and period_key = ${"D" + oldDay} and status = 'valid'`;
    assert.ok(g, "the old day was globalized");
    // A late ticket of an even older day, invoiced to a customer (its day's global is built).
    const veryOld = daysAgo(80);
    const late = await makeTicket(W, { businessDate: veryOld });
    const d = await invoice(W, late);
    await settle(W.tenantId);
    assert.equal((await docRow(d.id)).status, "valid");
    await cancelAs(W, W.manager, d.id);
    await settle(W.tenantId);
    assert.equal((await docRow(d.id)).status, "canceled");
    const holder = async (ticketId: string) => {
      const [c] = (await claims(ticketId)).filter((r) => r.state === "active");
      return c ? docRow(c.document_id) : null;
    };
    const lateHolder = await holder(late.id);
    assert.deepEqual(
      lateHolder && {
        kind: lateHolder.kind,
        period: lateHolder.period_key,
        status: lateHolder.status,
      },
      { kind: "global", period: "D" + veryOld, status: "valid" },
    );
    // The owner cancels the old global (02): its ticket goes into a new part of the same day.
    await cancelAs(W, W.owner, g.id);
    await settle(W.tenantId);
    assert.equal((await docRow(g.id)).status, "canceled");
    const again = await holder(inGlobal.id);
    assert.deepEqual(
      again && {
        period: again.period_key,
        status: again.status,
        part: again.part,
      },
      { period: "D" + oldDay, status: "valid", part: 2 },
    );
  });

  await test("MONEY-2b / SAT-1. a closed period with an unclaimed eligible ticket shows as overdue with Emitir ahora and counts in Today's overdue globals until it is issued; a pre-start invoice says its ticket does not go back to a global", async () => {
    const W = await makeTenant("money-2b");
    await activate(W, { testFrom: daysAgo(120), periodicity: "day" });
    const day = daysAgo(70);
    const before = (await web(W, (tx) => cfdiAlerts(tx))).overdueGlobals;
    await makeTicket(W, { businessDate: day });
    const period = async () =>
      (
        await web(W, (tx) =>
          service.listGlobals(tx, W.manager, {
            query: { from: day, to: day },
          } as never),
        )
      )[0];
    const p = await period();
    assert.deepEqual(
      { status: p.status, canRun: p.canRun },
      { status: "overdue", canRun: true },
    );
    assert.equal(
      (await web(W, (tx) => cfdiAlerts(tx))).overdueGlobals,
      before + 1,
    );
    await web(W, (tx) =>
      service.runGlobals(tx, W.manager, {
        operationId: op(),
        periodKey: "D" + day,
      }),
    );
    await settle(W.tenantId);
    const built = await period();
    assert.equal(built.status, "built");
    assert.equal(built.ticketCount, 1);
    assert.equal((await web(W, (tx) => cfdiAlerts(tx))).overdueGlobals, before);
    // A ticket from before CFDI started is invoiced on request; canceling it frees it, but no
    // global covers days before the start: the document says so.
    const pre = await makeTicket(W, { businessDate: daysAgo(130) });
    const inv = await web(W, (tx) =>
      service.requestInvoice(tx, W.manager, {
        operationId: op(),
        ticketId: pre.id,
        receptor: MORAL,
        cardForm: null,
        confirmPreStart: true,
        reissueGlobal: false,
      }),
    );
    await settle(W.tenantId);
    assert.equal((await viewOf(W, inv.id)).preStart, true);
  });

  await test("SAT-3a. CFF art. 29-A: a CFDI stamped in a year whose annual-return month has passed can no longer be canceled or substituted (cfdi_cancel_deadline_passed); the register hides both and shows the deadline", async () => {
    const W = await makeTenant("sat-3a");
    await activate(W);
    const tk = await makeTicket(W);
    const d = await invoice(W, tk);
    await settle(W.tenantId);
    // Stamped 500 days ago: its year's deadline (end of March of the next year) is past.
    await age([d.id], 500 * 24 * 60);
    await rejects(cancelAs(W, W.manager, d.id), "cfdi_cancel_deadline_passed");
    await rejects(substitute(W, d.id), "cfdi_cancel_deadline_passed");
    const v = await viewOf(W, d.id);
    assert.equal(v.canCancel, false);
    assert.equal(v.canSubstitute, false);
    assert.ok(v.cancelDeadline && Date.parse(v.cancelDeadline) < Date.now());
    assert.equal((await docRow(d.id)).status, "valid");
  });

  await test("SAT-3b. a ticket in a global past its 29-A deadline is invoiced through a credit note to the global for its net amount (Guía global Apéndice 2 III), never a motive-04 cancellation: the note relates 01 to the global, then the invoice takes the ticket and stamps", async () => {
    const W = await makeTenant("sat-3b");
    await activate(W, { testFrom: daysAgo(40), periodicity: "day" });
    const day = daysAgo(4);
    const t1 = await makeTicket(W, {
      businessDate: day,
      groups: [
        { category: "iva16", gross: 11600 },
        { category: "iva0", gross: 2000 },
      ],
    });
    const t2 = await makeTicket(W, { businessDate: day });
    await tick(W);
    const [g] =
      await admin`select id, uuid from cfdi_documents where tenant_id = ${W.tenantId} and kind = 'global' and status = 'valid'`;
    await age([g.id], 500 * 24 * 60);
    const view = await web(W, (tx) =>
      service.getTicket(tx, W.manager, {
        params: { ticketId: t1.id },
      } as never),
    );
    assert.deepEqual(
      { eligibility: view.eligibility, route: view.reissueRoute },
      { eligibility: "in_global", route: "credit_note" },
    );
    await refund(W, t1, { iva0: 500 });
    await settle(W.tenantId);
    const inv = await invoice(W, t1, { s: W.manager, reissueGlobal: true });
    assert.equal(inv.status, "waiting");
    await settle(W.tenantId);
    const [note] =
      await admin`select * from cfdi_documents where tenant_id = ${W.tenantId} and credit_ticket_id = ${t1.id}`;
    assert.equal(note.kind, "egreso");
    assert.equal(note.status, "valid");
    assert.equal(note.parent_document_id, g.id);
    assert.deepEqual(note.request.related_documents, [
      { relationship: "01", documents: [g.uuid] },
    ]);
    assert.equal(note.expected_total, 11600 + 2000 - 500, "the ticket's net");
    assert.equal(note.request.use, "S01");
    const row = await docRow(inv.id);
    assert.equal(row.status, "valid");
    assert.equal(row.expected_total, 11600 + 2000 - 500);
    assert.deepEqual(
      (await claims(t1.id)).map((r) => [
        r.document_id,
        r.state,
        r.released_reason,
      ]),
      [
        [g.id, "released", "superseded"],
        [inv.id, "active", null],
      ],
    );
    assert.equal((await docRow(g.id)).status, "valid", "the global stays");
    const [{ n }] =
      await admin`select count(*)::int as n from cfdi_cancellations where document_id = ${g.id}`;
    assert.equal(n, 0, "no cancellation of the global");
    assert.deepEqual(
      (await claims(t2.id)).map((r) => [r.document_id, r.state]),
      [[g.id, "active"]],
    );
  });

  await test('SAT-4 / UX-1. a restaurant that becomes RESICO (626) after choosing daily globals moves to monthly from the first of next month (the tick stores the pending change), and every later save, an older client\'s "day" included, keeps monthly instead of failing', async () => {
    const W = await makeTenant("sat-4", {
      rfc: "XIQB891116QE4",
      legalName: "BERENICE XIMO QUEZADA",
      regime: "612",
    });
    await activate(W, { periodicity: "day" });
    const before = await web(W, (tx) => service.getSettings(tx, W.owner));
    assert.equal(before.settings?.globalPeriodicity, "day");
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${W.tenantId}, true)`;
      await tx`update restaurant_fiscal_profiles set regime = '626', version = version + 1`;
    });
    await tick(W);
    const after = await web(W, (tx) => service.getSettings(tx, W.owner));
    assert.deepEqual(
      {
        resico: after.settings?.resicoMonthly,
        now: after.settings?.globalPeriodicity,
        next: after.settings?.nextPeriodicity,
        from: after.settings?.nextPeriodicityFrom,
      },
      {
        resico: true,
        now: "day",
        next: "month",
        from: firstOfNextMonth(today()),
      },
    );
    const saved = await saveSettings(W, {
      globalPeriodicity: "day",
      selfInvoiceEnabled: false,
    });
    assert.equal(saved.settings?.selfInvoiceEnabled, false);
    assert.equal(saved.settings?.nextPeriodicity, "month");
  });

  await test("UX-2. restaurant-side portal failures never use up the customer's 5 attempts (only data they can fix counts), and an expired certificate closes self-invoicing (not_ready) instead of failing every attempt", async () => {
    const W = await makeTenant("ux-2");
    await activate(W);
    const tk = await makeTicket(W);
    for (let i = 0; i < 5; i++) {
      await portalRequest(tk.code, "UNIVERSIDAD FAKE STAMP FAILED");
      await settle(W.tenantId);
    }
    const [last] =
      await admin`select status, error_code from cfdi_documents where tenant_id = ${W.tenantId}
        and source = 'portal' order by created_at desc limit 1`;
    assert.deepEqual(
      { ...last },
      {
        status: "failed",
        error_code: "cfdi_stamping_failed",
      },
    );
    const ok = await portalRequest(tk.code);
    await settle(W.tenantId);
    assert.equal(
      (await portal.portalRequestStatus(app, ok.requestToken)).status,
      "valid",
    );
    // The certificate's end date has passed (no refresh marked it yet).
    const tk2 = await makeTicket(W);
    await asWorker(
      W,
      (tx) =>
        tx`update cfdi_organizations set csd_status = 'valid', csd_valid_until = now() - interval '1 day'`,
    );
    assert.equal(
      (await portal.portalTicket(app, tk2.code)).eligibility,
      "not_ready",
    );
    await rejects(portalRequest(tk2.code), "cfdi_portal_unavailable");
  });

  await test("UX-3. a portal invoice that fails after the customer left is shown to the restaurant (attention, Hoy) until a newer request of that ticket, and to the customer who comes back (the ticket's latest request with its reason)", async () => {
    const W = await makeTenant("ux-3");
    await activate(W);
    const tk = await makeTicket(W);
    const before = (await web(W, (tx) => cfdiAlerts(tx))).failedDocuments;
    await portalRequest(tk.code, "UNIVERSIDAD FAKE NAME MISMATCH");
    await settle(W.tenantId);
    assert.equal(
      (await web(W, (tx) => cfdiAlerts(tx))).failedDocuments,
      before + 1,
    );
    const back = await portal.portalTicket(app, tk.code);
    assert.equal(back.eligibility, "available");
    assert.deepEqual(
      back.latest && {
        status: back.latest.status,
        code: back.latest.error?.code,
      },
      { status: "failed", code: "cfdi_receptor_name_mismatch" },
    );
    await portalRequest(tk.code);
    await settle(W.tenantId);
    assert.equal(
      (await web(W, (tx) => cfdiAlerts(tx))).failedDocuments,
      before,
    );
  });

  await test("UX-4. a valid document's files are announced only once stored: the portal status carries filesReady (false while cfdi_deliver retries, true after) and each status read mints a fresh download token", async () => {
    const W = await makeTenant("ux-4");
    await activate(W);
    const tk = await makeTicket(W);
    fake.fault({ op: "invoices.download", fault: "internal_error", times: 2 });
    const r = await portalRequest(tk.code);
    await settle(W.tenantId);
    const stamped = await portal.portalRequestStatus(app, r.requestToken);
    assert.deepEqual(
      { status: stamped.status, ready: stamped.filesReady },
      { status: "valid", ready: false },
    );
    for (let i = 0; i < 3; i++) {
      await due(W.tenantId, "cfdi_deliver");
      await settle(W.tenantId);
    }
    const ready = await portal.portalRequestStatus(app, r.requestToken);
    assert.equal(ready.filesReady, true);
    assert.ok(ready.downloadToken);
    // Minted at this read: it expires 15 minutes from now, whenever the request was made.
    const exp = JSON.parse(
      Buffer.from(ready.downloadToken!.split(".")[2], "base64url").toString(),
    ).exp as number;
    assert.ok(exp * 1000 > Date.now() + 890_000, "a fresh 900 s token");
  });

  await test("lows: CFDI turned back on restarts its tick chain (WORKER-4); a motive-03 cancellation re-globalizes a day later (SAT-5); an invoice whose cancellation waits reads invoiced (UX-9); a past CSD end date reads expired (UX-16); an upload naming an organization key never opens or wipes it (SECRETS-2)", async () => {
    const W = await makeTenant("lows");
    await activate(W, { testFrom: daysAgo(40), periodicity: "day" });
    // WORKER-4: pause, a paused tick runs and exits, turn back on in the same 10 minutes.
    await saveSettings(W, { enabled: false });
    await web(W, (tx) => service.getSettings(tx, W.manager));
    await due(W.tenantId, "cfdi_global");
    await settle(W.tenantId);
    assert.equal(
      (await liveTicks(W.tenantId)).length,
      0,
      "paused: the chain's ticks exit",
    );
    await saveSettings(W, { enabled: true });
    assert.ok(
      (await liveTicks(W.tenantId)).some((j) =>
        String(j.dedupe_key).startsWith("tick:enabled:"),
      ),
    );
    await settle(W.tenantId);
    assert.ok((await liveTicks(W.tenantId)).length >= 1, "the chain continues");
    // SAT-5: an invoice of a closed day canceled with motive 03 frees its ticket for tomorrow.
    const day = daysAgo(3);
    const tk = await makeTicket(W, { businessDate: day });
    const d = await invoice(W, tk);
    await settle(W.tenantId);
    await tick(W);
    await web(W, (tx) =>
      service.cancelDocument(
        tx,
        W.manager,
        { operationId: op(), motive: "03", reason: "No se concretó" },
        { params: { id: d.id } } as never,
      ),
    );
    await settle(W.tenantId);
    const [later] =
      await admin`select next_at from jobs where tenant_id = ${W.tenantId} and kind = 'cfdi_global'
        and dedupe_key like ${"tick:after-cancel:" + d.id + "%"}`;
    assert.ok(Date.parse(later.next_at) > Date.now() + 23 * 3600_000);
    // UX-9: while the receptor decides, the ticket is still invoiced.
    const tk2 = await makeTicket(W);
    const d2 = await invoice(W, tk2);
    await settle(W.tenantId);
    fake.fault({
      op: "invoices.cancel",
      fault: "cancel_pending",
      match: { type: "I", global: false },
    });
    await cancelAs(W, W.manager, d2.id);
    await settle(W.tenantId);
    assert.equal((await docRow(d2.id)).status, "canceling");
    const v = await web(W, (tx) =>
      service.getTicket(tx, W.manager, {
        params: { ticketId: tk2.id },
      } as never),
    );
    assert.equal(v.eligibility, "invoiced");
    // UX-16: the panel reads a certificate past its end date as expired.
    await asWorker(
      W,
      (tx) =>
        tx`update cfdi_organizations set csd_status = 'valid', csd_valid_until = now() - interval '1 hour'`,
    );
    const view = await web(W, (tx) => service.getSettings(tx, W.manager));
    assert.equal(view.organization?.csd.status, "expired");
    // SECRETS-2: an upload row naming the organization's sealed key is never opened or wiped.
    const [org] =
      await admin`select test_secret_id from cfdi_organizations where tenant_id = ${W.tenantId}`;
    const uploadId = randomUUID();
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${W.tenantId}, true)`;
      await tx`insert into cfdi_csd_uploads(tenant_id, id, secret_id, status, requested_by, created_at)
        values (${W.tenantId}, ${uploadId}, ${org.test_secret_id}, 'queued', ${W.owner.employeeId},
          now() - interval '2 hours')`;
    });
    await web(W, (tx) =>
      cfdiEnqueue(tx, W.tenantId, {
        kind: "cfdi_csd",
        dedupeKey: "csd:" + uploadId,
        payload: { uploadId },
      }),
    );
    await settle(W.tenantId);
    await tick(W);
    const [key] =
      await admin`select payload_secret is not null as sealed, wiped_at from cfdi_secrets where id = ${org.test_secret_id}`;
    assert.deepEqual({ ...key }, { sealed: true, wiped_at: null });
    const [u] =
      await admin`select status, error_code from cfdi_csd_uploads where id = ${uploadId}`;
    assert.deepEqual(
      { ...u },
      {
        status: "rejected",
        error_code: "cfdi_csd_abandoned",
      },
    );
  });

  await test("INT-1a. a refund credited against a valid global never blocks the other tickets of its period: the staff request and the portal's (portal_reissue_global on) take route III, a credit note related 01 to the global for each ticket's net, then a stamped invoice; the global is never canceled, the ticket view says why, and its owner is told why Cancelar is missing", async () => {
    const W = await makeTenant("int-1a");
    await activate(W, { testFrom: daysAgo(40), periodicity: "day" });
    await saveSettings(W, {
      portalReissueGlobal: true,
      selfInvoicePolicy: "days",
      selfInvoiceDays: 30,
    });
    const day = daysAgo(2);
    const refunded = await makeTicket(W, { businessDate: day });
    const t1 = await makeTicket(W, {
      businessDate: day,
      groups: [{ category: "iva16", gross: 23200 }],
    });
    const t2 = await makeTicket(W, {
      businessDate: day,
      groups: [
        { category: "iva16", gross: 5800 },
        { category: "iva0", gross: 1500 },
      ],
    });
    const t3 = await makeTicket(W, { businessDate: day });
    await tick(W);
    const [g] =
      await admin`select id, uuid from cfdi_documents where tenant_id = ${W.tenantId} and kind = 'global'
        and period_key = ${"D" + day} and status = 'valid'`;
    // The routine next-day refund, credited against the global (route I).
    await refund(W, refunded, { iva16: 2320 });
    await settle(W.tenantId);
    const [routeI] =
      await admin`select status from cfdi_documents where parent_document_id = ${g.id} and refund_id is not null`;
    assert.equal(routeI.status, "valid");
    const staffView = await web(W, (tx) =>
      service.getTicket(tx, W.manager, {
        params: { ticketId: t1.id },
      } as never),
    );
    assert.deepEqual(
      {
        eligibility: staffView.eligibility,
        route: staffView.reissueRoute,
        reason: staffView.reissueReason,
      },
      {
        eligibility: "in_global",
        route: "credit_note",
        reason: "credit_notes",
      },
    );
    const owner = await web(W, (tx) =>
      service.getDocument(tx, W.owner, { params: { id: g.id } } as never),
    );
    assert.deepEqual(
      { canCancel: owner.canCancel, creditNotesBlock: owner.creditNotesBlock },
      { canCancel: false, creditNotesBlock: true },
    );
    // A cashier still asks a manager; the manager's request credits the global.
    await rejects(invoice(W, t1), "cfdi_ticket_in_global");
    const staff = await invoice(W, t1, { s: W.manager, reissueGlobal: true });
    assert.equal(staff.status, "waiting");
    // The customer, through the portal (the owner's portal_reissue_global is on).
    const portalView = await portal.portalTicket(app, t2.code);
    assert.deepEqual(
      {
        eligibility: portalView.eligibility,
        route: portalView.reissueRoute,
        reason: portalView.reissueReason,
        allowed: portalView.reissueAllowed,
      },
      {
        eligibility: "in_global",
        route: "credit_note",
        reason: "credit_notes",
        allowed: true,
      },
    );
    const customer = await portalRequest(t2.code);
    assert.equal(customer.document.status, "queued");
    assert.equal(
      (
        await admin`select 1 from cfdi_cancellations where document_id = ${g.id}`
      ).length,
      0,
      "no motive-04 cancellation is ever asked for",
    );
    await settle(W.tenantId);
    for (const [tk, net] of [
      [t1, 23200],
      [t2, 5800 + 1500],
    ] as const) {
      const [note] =
        await admin`select * from cfdi_documents where tenant_id = ${W.tenantId} and credit_ticket_id = ${tk.id}`;
      assert.deepEqual(
        {
          kind: note.kind,
          status: note.status,
          parent: note.parent_document_id,
          total: note.expected_total,
        },
        { kind: "egreso", status: "valid", parent: g.id, total: net },
      );
      assert.deepEqual(note.request.related_documents, [
        { relationship: "01", documents: [g.uuid] },
      ]);
      const [inv] =
        await admin`select * from cfdi_documents where depends_on = ${note.id} and kind = 'invoice'`;
      assert.deepEqual(
        { status: inv.status, total: inv.expected_total },
        { status: "valid", total: net },
      );
      assert.deepEqual(
        (await claims(tk.id)).map((r) => [
          r.document_id,
          r.state,
          r.released_reason,
        ]),
        [
          [g.id, "released", "superseded"],
          [inv.id, "active", null],
        ],
      );
    }
    assert.equal(
      (await portal.portalRequestStatus(app, customer.requestToken)).status,
      "valid",
    );
    assert.equal((await docRow(g.id)).status, "valid", "the global stays");
    assert.equal(
      (
        await admin`select 1 from cfdi_cancellations where document_id = ${g.id}`
      ).length,
      0,
    );
    assert.deepEqual(
      (await claims(t3.id)).map((r) => [r.document_id, r.state]),
      [[g.id, "active"]],
    );
    // Without the owner's setting the portal still sends the customer to the restaurant.
    await saveSettings(W, { portalReissueGlobal: false });
    await rejects(portalRequest(t3.code), "cfdi_ticket_in_global");
  });

  await test("INT-1b. an invoice that a credit note relates to has a defined outcome, never an impossible instruction: cancel and substitute answer cfdi_has_credit_notes, the register hides Cancelar and Sustituir for a manager and says why (creditNotesBlock), and the credit note itself can still be corrected", async () => {
    const W = await makeTenant("int-1b");
    await activate(W);
    const { d, e } = await creditedInvoice(W);
    await rejects(cancelAs(W, W.manager, d.id), "cfdi_has_credit_notes");
    await rejects(substitute(W, d.id), "cfdi_has_credit_notes");
    const v = await viewOf(W, d.id);
    assert.deepEqual(
      {
        canCancel: v.canCancel,
        canSubstitute: v.canSubstitute,
        creditNotesBlock: v.creditNotesBlock,
      },
      { canCancel: false, canSubstitute: false, creditNotesBlock: true },
    );
    // The cashier who requested it is offered neither action, so nothing is explained.
    const cashier = await web(W, (tx) =>
      service.getDocument(tx, W.cashier, { params: { id: d.id } } as never),
    );
    assert.equal(cashier.creditNotesBlock, false);
    const note = await viewOf(W, e.id);
    assert.deepEqual(
      {
        canCancel: note.canCancel,
        canSubstitute: note.canSubstitute,
        creditNotesBlock: note.creditNotesBlock,
      },
      { canCancel: false, canSubstitute: true, creditNotesBlock: false },
    );
    assert.equal((await docRow(d.id)).status, "valid");
  });

  console.log(`cfdi DB checks passed: ${checks}`);
} finally {
  await runner.stop(2000);
  setCfdiRuntime(null);
  await worker.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
}

function settingsBody(
  s: NonNullable<Awaited<ReturnType<typeof service.getSettings>>["settings"]>,
) {
  return {
    operationId: op(),
    expectedVersion: s.version,
    enabled: s.enabled,
    globalPeriodicity: s.globalPeriodicity,
    globalAuto: s.globalAuto,
    conceptMode: s.conceptMode,
    conceptDescription: s.conceptDescription,
    cardPaymentForm: s.cardPaymentForm,
    defaultUse: s.defaultUse,
    selfInvoiceEnabled: s.selfInvoiceEnabled,
    selfInvoicePolicy: s.selfInvoicePolicy,
    selfInvoiceDays: s.selfInvoiceDays,
    portalReissueGlobal: s.portalReissueGlobal,
    supportEmail: s.supportEmail,
  };
}
