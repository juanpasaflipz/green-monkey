// cfdi (030) against a real database (spec §7.3): the worker handlers run as the jobs login
// (gm_worker, a gm_jobs_worker member) through the Wave 2.0 runner, the web functions as the
// runtime role, and the deterministic Facturapi fake answers in process (no sockets, no key).
//
// Fixtures: every run creates fresh fictional restaurants and LEAVES its rows in the disposable
// test database (cfdi_* and fiscal records reject DELETE/TRUNCATE; LD-12, cfdi-rebase §2 item 7).
// Until fiscal 027 merges into this branch, fiscal's tables come from a TEST-ONLY stand-in
// (tests/fixtures/cfdi/fiscal-027-standin.sql), applied only when fiscal_tickets is absent; tickets
// and refund adjustments are inserted with fiscal's figures (extractTax, complement extraction).
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
import { claimJobs } from "../server/jobs/queue.js";
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
import { rekeyOrganizationSecrets } from "../server/cfdi/rekey.js";
import { lockDocument } from "../server/cfdi/locks.js";
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

// Fiscal 027 stand-in (test database only, until the fiscal rebase).
const [{ present }] =
  await admin`select to_regclass('public.fiscal_tickets') is not null as present`;
if (!present)
  await admin.begin((tx) =>
    tx.unsafe(
      readFileSync("tests/fixtures/cfdi/fiscal-027-standin.sql", "utf8"),
    ),
  );

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
    await tx`insert into fiscal_folio_counters(tenant_id,series,last_value) values(${tenantId},'A',1)`;
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
    folio: 0,
    tickets: new Map(),
  };
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
  const number = ++t.folio;
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
    await tx`insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,total)
      values(${t.tenantId},${orderId},${number},${date},${t.cashier.employeeId},'takeaway','','','pos',${total})`;
    for (const p of payments) {
      const tenderId = randomUUID();
      tenderIds.push(tenderId);
      await tx`insert into tenders(tenant_id,id,order_id,method,amount,received)
        values(${t.tenantId},${tenderId},${orderId},${p.method},${p.amount},${p.amount})`;
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
    await tx`insert into refunds(tenant_id,id,tender_id,amount,reason,disposition,actor_id,method)
      values(${t.tenantId},${refundId},${tk.tenderIds[0]},${total},'cfdi fixture','discard',${t.owner.employeeId},${method})`;
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
    // 2,001 tickets × 2 categories = 4,002 concepts → 2 parts (a ticket is never split).
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${C.tenantId},true)`;
      await tx`
        insert into orders(tenant_id,id,number,business_date,employee_id,mode,name,note,channel,total)
        select ${C.tenantId}, gen_random_uuid(), n, ${day}::date, ${C.cashier.employeeId}, 'takeaway','','','pos', 1580
        from generate_series(1, 2001) n`;
      await tx`
        insert into fiscal_tickets(tenant_id,id,order_id,series,number,self_invoice_code,business_date,issued_by,source,
          currency,gross_before_discount,discount,gross,base,tax,tax_basis,lines,payments)
        select o.tenant_id, gen_random_uuid(), o.id, 'A', o.number,
          upper(substr(md5(random()::text || o.id::text), 1, 12)),
          o.business_date, o.employee_id, 'sale', 'MXN', 1580, 0, 1580, 1442, 138, 'line_snapshot', '[]',
          jsonb_build_array(jsonb_build_object('method','cash','amount',1580,'tip',0,'reference',null,'at',now()))
        from orders o where o.tenant_id = ${C.tenantId} and o.business_date = ${day}::date`;
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
    await rejects(
      saveSettings(R, { globalPeriodicity: "day" }),
      "cfdi_resico_monthly",
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
    assert.equal(saved.settings?.nextPeriodicityFrom, firstOfNextMonth(today()));
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

  await test("reports hooks: cfdiAlerts/cfdiReportAlerts map the attention counts; disabled CFDI gives none", async () => {
    const a = await web(A, (tx) => cfdiAlerts(tx));
    assert.equal(a.mode, "test");
    const mapped = cfdiReportAlerts(a);
    assert.ok(mapped.every((m) => m.code.startsWith("cfdi_") && m.count > 0));
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
    const first = await invoice(A, t1, { s: A.manager, reissueGlobal: true });
    assert.equal(first.status, "waiting");
    // Hold G's document key: the worker cancels G at the provider, then waits for the key at its
    // step 3; the late request reads G (valid, holding t2) and waits behind the worker.
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

  await test("17c. the -- 030 cfdi grants block is idempotent (applied twice)", async () => {
    const grants = readFileSync("scripts/grants.sql", "utf8");
    const block = grants.slice(grants.indexOf("-- 030 cfdi"));
    for (let i = 0; i < 2; i++) await admin.begin((tx) => tx.unsafe(block));
    const [r] =
      await admin`select has_table_privilege('gm_jobs_worker', 'fiscal_tickets', 'SELECT') as fiscal,
      has_table_privilege('gm_app', 'cfdi_secrets', 'SELECT') as secrets`;
    assert.deepEqual({ ...r }, { fiscal: true, secrets: false });
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
