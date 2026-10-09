// Payments (037) DB suite, phase P1 (spec §12.2 items 1-4, 8-12, 15-16 for what P1 builds; the
// integrated start, settle and worker items are P2's). Fresh fictional restaurants per run, so it
// shares the test database with every other suite. Run: npm run test:db:payments.
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { checkRole, connect, tenant, type Tx } from "../server/db.js";
import {
  addRound,
  createOrder,
  getOrder,
  recordPayment,
} from "../server/orders.js";
import { catalog, menuRevision, publicCatalog } from "../server/menu-read.js";
import { voidLines } from "../server/voids.js";
import { applyDiscount } from "../server/discounts.js";
import { closeCheck, recordSettlement } from "../server/checks.js";
import { recordRefund, refund } from "../server/refunds.js";
import { cashSummary, closeCash } from "../server/cash.js";
import { saveFiscalProfile } from "../server/fiscal.js";
import { newTender } from "../server/offline-sync.js";
import { resolvePaymentAttempt } from "../server/offline-attempts.js";
import {
  archiveTerminal,
  paymentOptions,
  paymentSettingsView,
  savePlatformPrices,
  savePlatforms,
  saveTerminal,
  setDeviceTerminal,
} from "../server/payments/settings.js";
import { salesSummary } from "../server/reports/summary.js";
import { tenderRows } from "../server/reports/lists.js";
import { exceptionRows } from "../server/reports/exceptions.js";
import { reportsPorts as ports } from "../server/reports/ports.js";
import { snapshotTenant } from "../server/reports/snapshot.js";
import { businessDate, type Order, type Session } from "../shared/domain.js";
import { discountExpectation, planDiscount } from "../shared/discounts.js";
import type { SessionAccess } from "../shared/access.js";
import { isolatedTarget } from "./isolated-target.js";
import { noRetries } from "./db-retries.js";

const target = isolatedTarget(process.env);
const sql = connect(target.runtime),
  admin = postgres(target.migration, { max: 1 });
await checkRole(sql);

const run = Date.now().toString(36);
const organizationId = randomUUID();
const A = randomUUID(),
  B = randomUUID();
const ids = {
  owner: randomUUID(),
  manager: randomUUID(),
  cashier: randomUUID(),
  server: randomUUID(),
  ownerB: randomUUID(),
  device1: randomUUID(),
  device2: randomUUID(),
  deviceB: randomUUID(),
  drawer1: randomUUID(),
  drawer2: randomUUID(),
  drawerB: randomUUID(),
  taco: randomUUID(),
  agua: randomUUID(),
  tacoB: randomUUID(),
};
const restaurant = {
  name: "Pagos ficticios " + run,
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
const session = (
  tenantId: string,
  employeeId: string,
  role: string,
  deviceId: string,
  access?: Partial<SessionAccess>,
): Session => ({
  id: randomUUID(),
  tenantId,
  employeeId,
  name: role,
  role,
  deviceId,
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant,
  ...(access
    ? {
        access: {
          absoluteExpiresAt: null,
          authenticatedAt: new Date().toISOString(),
          deviceName: "Caja pagos",
          deviceKind: "terminal",
          idleLockSeconds: null,
          ownerAccount: false,
          ...access,
        } as SessionAccess,
      }
    : {}),
});
const owner = session(A, ids.owner, "owner", ids.device1);
const manager = session(A, ids.manager, "manager", ids.device1);
const cashier = session(A, ids.cashier, "cashier", ids.device1);
const server2 = session(A, ids.server, "server", ids.device2);
const ownerB = session(B, ids.ownerB, "owner", ids.deviceB);
const staleManager = session(A, ids.manager, "manager", ids.device1, {
  authenticatedAt: new Date(Date.now() - 86_400_000).toISOString(),
});

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
    else assert.equal(got, code);
    return true;
  });
}
const write = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
/** The table owner inside one tenant's scope (fixture rows, trigger checks). */
async function asOwner<T>(tenantId: string, fn: (tx: any) => Promise<T>) {
  return admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
const today = businessDate(
  new Date().toISOString(),
  restaurant.timezone,
  restaurant.cutoff,
);

async function newOrder(
  s: Session,
  lines: { product: string; quantity: number }[],
  extra: Record<string, unknown> = {},
): Promise<Order> {
  return write(s, (tx) =>
    createOrder(tx, s, {
      operationId: randomUUID(),
      lines: lines.map((l) => ({
        id: randomUUID(),
        productId: l.product,
        quantity: l.quantity,
        options: [],
        note: "",
      })),
      mode: "takeaway",
      tableId: null,
      name: "Pagos",
      note: "",
      channel: "pos",
      ...extra,
    }),
  );
}
const orderOf = (id: string, s: Session = owner) =>
  write(s, (tx) => getOrder(tx, id));
function pay(s: Session, orderId: string, body: Record<string, unknown>) {
  return write(s, (tx) =>
    recordPayment(tx, s, orderId, { operationId: randomUUID(), ...body }),
  );
}
const platformBody = (amount: number, extra: object = {}) => ({
  amount,
  tip: 0,
  received: amount,
  method: "platform",
  platform: "didi_food",
  externalConfirmed: true,
  reference: "4F2A",
  ...extra,
});
const terminalBody = (amount: number, terminalId?: string, tip = 0) => ({
  amount,
  tip,
  received: amount + tip,
  method: "external",
  externalConfirmed: true,
  reference: "AUT-" + run,
  ...(terminalId ? { terminalId } : {}),
});

/** An attempt row as P2's start would insert it (fixture only: P1 never starts one). */
async function attempt(o: {
  tenantId?: string;
  orderId: string;
  terminalId: string;
  drawerId: string;
  state?: string;
  amount?: number;
}) {
  const attemptId = randomUUID();
  await asOwner(
    o.tenantId ?? A,
    (tx) =>
      tx`insert into payment_attempts(tenant_id,id,operation_id,settle_operation_id,target,origin,order_id,
        terminal_id,provider,provider_device_id,terminal_label,amount,tip,currency,employee_id,device_id,
        session_id,cash_session_id,state)
      values(${o.tenantId ?? A},${attemptId},${randomUUID()},${randomUUID()},'order','pos',${o.orderId},
        ${o.terminalId},'mercadopago','NEWLAND_N950__N950NCB801293324','MP Caja',${o.amount ?? 4500},0,'MXN',
        ${ids.cashier},${ids.device1},${randomUUID()},${o.drawerId},${o.state ?? "created"})`,
  );
  return attemptId;
}
/** P2's cancel of a not-yet-sent attempt (a web transition the 037 trigger allows). */
const cancelAttempt = (attemptId: string) =>
  write(
    owner,
    (tx) =>
      tx`update payment_attempts set state='cancelled',version=version+1 where id=${attemptId}`,
  );

try {
  // ---- Fixture: two fictional restaurants (A with two registers, B), Pro, with a fiscal profile.
  await admin`insert into organizations(id,name) values(${organizationId},${restaurant.name})`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values (${A},${organizationId},${restaurant.name},'MXN',${restaurant.timezone},${restaurant.cutoff},false),
           (${B},${organizationId},${restaurant.name + " B"},'MXN',${restaurant.timezone},${restaurant.cutoff},false)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values (${A},'active',now()+interval '1 day','fixture'),(${B},'active',now()+interval '1 day','fixture')`;
  for (const [tenantId, employee, role, name] of [
    [A, ids.owner, "owner", "Olga Dueña"],
    [A, ids.manager, "manager", "Marisol Vega"],
    [A, ids.cashier, "cashier", "Carlos Caja"],
    [A, ids.server, "server", "Sara Mesera"],
    [B, ids.ownerB, "owner", "Beto Dueño"],
  ])
    await admin`insert into employees(tenant_id,id,name,login,secret_hash,role)
      values(${tenantId},${employee},${name},${"p" + randomUUID().slice(0, 12)},'fixture',${role})`;
  await admin`insert into devices(tenant_id,id,name,token_hash,free_slot)
    values (${A},${ids.device1},'Caja mostrador','fixture',1),(${A},${ids.device2},'Barra','fixture',null),
           (${B},${ids.deviceB},'Caja B','fixture',1)`;
  await admin`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
    values (${A},${ids.drawer1},${ids.device1},${ids.cashier},100000,now()-interval '2 hours'),
           (${A},${ids.drawer2},${ids.device2},${ids.server},50000,now()-interval '1 hour'),
           (${B},${ids.drawerB},${ids.deviceB},${ids.ownerB},0,now()-interval '1 hour')`;
  const product = (
    tenantId: string,
    productId: string,
    name: string,
    price: number,
  ) =>
    admin`insert into catalog(tenant_id,id,data) values(${tenantId},${productId},${admin.json(
      {
        id: productId,
        name: { es: name, en: name },
        category: { es: "Pruebas", en: "Tests" },
        price,
        available: true,
        station: "kitchen",
        groups: [],
        cost: 1500,
        recipe: [],
        version: 1,
      },
    )})`;
  await product(A, ids.taco, "Taco ficticio", 4500);
  await product(A, ids.agua, "Agua ficticia", 3000);
  await product(B, ids.tacoB, "Taco B", 2000);
  await write(owner, (tx) =>
    saveFiscalProfile(tx, owner, {
      operationId: randomUUID(),
      expectedVersion: 0,
      identity: {
        rfc: "EKU9003173C9",
        legalName: "ALIMENTOS DE PRUEBA",
        regime: "601",
        postalCode: "06700",
        address: {
          street: "Av. Ficticia 123",
          neighborhood: "Roma Norte",
          municipality: "Cuauhtémoc",
          state: "Ciudad de México",
        },
      },
      ticketSeries: "",
      taxRegion: "general",
      defaultTaxCategory: "iva16",
      borderConfirmed: false,
    }),
  );

  // ---- Configuration: a manual bank terminal and an integrated MP device (fixture row: P2's
  // worker activates accounts, so P1 cannot create one through saveTerminal).
  const bbva = (
    await write(manager, (tx) =>
      saveTerminal(tx, manager, {
        operationId: randomUUID(),
        name: "BBVA",
        kind: "manual",
        feeBp: 175,
      }),
    )
  ).terminals.find((t) => t.name === "BBVA")!;
  const mpTerminal = randomUUID();
  await asOwner(
    A,
    (tx) =>
      tx`insert into payment_terminals(tenant_id,id,name,kind,provider_device_id,fee_bp,created_by,updated_by)
      values(${A},${mpTerminal},'MP Caja','mercadopago_point','NEWLAND_N950__N950NCB801293324',418,${ids.manager},${ids.manager})`,
  );

  await test("4. migration 037: the replaced checks keep their names and every tender check is validated", async () => {
    const rows = await admin`
      select conrelid::regclass::text as rel, conname, convalidated from pg_constraint
      where conrelid in ('tenders'::regclass,'refunds'::regclass,'refund_batches'::regclass)
        and conname in ('tenders_method_check','tenders_platform_shape','tenders_terminal_shape',
          'tenders_integrated_shape','tenders_card_shape','tenders_fee_shape','tenders_terminal_fk',
          'tenders_attempt_fk','refunds_method_valid','refund_batches_split')
      order by conname`;
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.convalidated));
    const [method] =
      await admin`select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid='tenders'::regclass and conname='tenders_method_check'`;
    assert.match(method.def, /platform/);
    const [old] = await admin`select count(*)::int as n from pg_constraint
      where conrelid='refund_batches'::regclass and contype='c'
        and pg_get_constraintdef(oid) like '%(cash_amount + external_amount) = amount%'`;
    assert.equal(old.n, 0, "the 028 split check was replaced");
  });

  await test("1. RLS: a restaurant sees none of another's payments rows; the runtime role never reads secrets", async () => {
    const tB = randomUUID();
    await asOwner(B, async (tx) => {
      await tx`insert into payment_terminals(tenant_id,id,name,kind,created_by,updated_by)
        values(${B},${tB},'Terminal B','manual',${ids.ownerB},${ids.ownerB})`;
      await tx`insert into payment_platforms(tenant_id,platform,commission_bp,updated_by)
        values(${B},'rappi',2500,${ids.ownerB})`;
      await tx`insert into payment_platform_prices(tenant_id,product_id,platform,price,updated_by)
        values(${B},${ids.tacoB},'rappi',2500,${ids.ownerB})`;
      await tx`insert into payment_device_terminals(tenant_id,device_id,terminal_id,updated_by)
        values(${B},${ids.deviceB},${tB},${ids.ownerB})`;
      await tx`insert into payment_secrets(tenant_id,id,purpose,kid,payload_secret)
        values(${B},${randomUUID()},'credentials_upload','k1',${"x".repeat(32)})`;
      await tx`insert into drawer_terminal_counts(tenant_id,id,drawer_id,terminal_id,expected,reported)
        values(${B},${randomUUID()},${ids.drawerB},${tB},0,0)`;
    });
    const tables = [
      "payment_terminals",
      "payment_platforms",
      "payment_platform_prices",
      "payment_device_terminals",
      "payment_provider_accounts",
      "payment_provider_devices",
      "payment_attempts",
      "payment_attempt_events",
      "drawer_terminal_counts",
    ];
    for (const table of tables) {
      const rows = await write(
        owner,
        (tx) => tx`select tenant_id from ${tx(table)}`,
      );
      assert.ok(
        rows.every((r) => r.tenant_id === A),
        `${table}: only A's rows`,
      );
    }
    const mine = await write(
      ownerB,
      (tx) => tx`select id from payment_terminals`,
    );
    assert.deepEqual(
      mine.map((r) => r.id),
      [tB],
    );
    await rejects(
      write(ownerB, (tx) => tx`select id from payment_secrets`),
      /permission denied|42501/,
    );
  });

  await test("2. grants: no DELETE for the runtime role, worker-only attempt columns, insert-only secrets and evidence", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a = await attempt({
      orderId: o.id,
      terminalId: mpTerminal,
      drawerId: ids.drawer1,
    });
    await rejects(
      write(owner, (tx) => tx`delete from payment_attempts where id=${a}`),
      /permission denied|42501/,
    );
    await rejects(
      write(
        owner,
        (tx) => tx`update payment_attempts set paid_amount=4500 where id=${a}`,
      ),
      /permission denied|42501/,
    );
    await rejects(
      write(owner, (tx) => tx`delete from payment_terminals`),
      /permission denied|42501/,
    );
    await rejects(
      write(
        owner,
        (tx) =>
          tx`insert into payment_provider_devices(tenant_id,provider,device_id,seen_at) values(${A},'clip','X1',now())`,
      ),
      /permission denied|42501/,
    );
    await rejects(
      write(
        owner,
        (tx) => tx`update payment_attempt_events set kind='x' where false`,
      ),
      /permission denied|42501/,
    );
    const deletable = await admin`
      select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r'
        and (c.relname like 'payment%' or c.relname = 'drawer_terminal_counts')
        and (has_table_privilege('gm_app', c.oid, 'DELETE') or has_table_privilege('gm_jobs_worker', c.oid, 'DELETE'))`;
    assert.deepEqual(
      deletable.map((r) => r.relname),
      [],
    );
    await cancelAttempt(a);
  });

  await test("3. triggers: web transitions only, identity and final rows immutable, secrets and activation worker-only", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const a = await attempt({
      orderId: o.id,
      terminalId: mpTerminal,
      drawerId: ids.drawer1,
      state: "pending",
    });
    // pending → approved is the worker's (provider-confirmed) transition.
    await rejects(
      write(
        owner,
        (tx) => tx`update payment_attempts set state='cancelled' where id=${a}`,
      ),
      /payment_attempt_transition pending -> cancelled/,
    );
    await rejects(
      asOwner(
        A,
        (tx) => tx`update payment_attempts set amount=1 where id=${a}`,
      ),
      /payment_attempt_identity_immutable/,
    );
    await rejects(
      asOwner(
        A,
        (tx) => tx`update payment_attempts set order_id=null where id=${a}`,
      ),
      /payment_attempt_identity_immutable/,
    );
    await rejects(
      asOwner(A, (tx) => tx`delete from payment_attempts where id=${a}`),
      /never deleted/,
    );
    const b = await attempt({
      orderId: (await newOrder(cashier, [{ product: ids.agua, quantity: 1 }]))
        .id,
      terminalId: bbva.id,
      drawerId: ids.drawer1,
    });
    await cancelAttempt(b);
    await rejects(
      write(
        owner,
        (tx) => tx`update payment_attempts set error_code='x1' where id=${b}`,
      ),
      /payment_attempt_final/,
    );
    // Secrets: the runtime role inserts an upload, never updates it; only the worker re-seals.
    const secret = randomUUID();
    await write(
      owner,
      (tx) =>
        tx`insert into payment_secrets(tenant_id,id,purpose,kid,payload_secret) values(${A},${secret},'credentials_upload','k1',${"y".repeat(32)})`,
    );
    await rejects(
      write(
        owner,
        (tx) =>
          tx`update payment_secrets set wiped_at=now(),payload_secret=null where id=${secret}`,
      ),
      /permission denied|42501/,
    );
    // The guard itself (any non-worker login; the fixture login is a superuser, which counts as a
    // worker member, so the trigger's DELETE branch is what it can show).
    await rejects(
      asOwner(A, (tx) => tx`delete from payment_secrets where id=${secret}`),
      /wiped, not deleted/,
    );
    // Accounts: never born or made active outside the worker.
    const hook = createHash("sha256").update(randomUUID()).digest("hex");
    await rejects(
      write(
        owner,
        (tx) =>
          tx`insert into payment_provider_accounts(tenant_id,provider,state,hook_hash,credential_secret_id,verified_at)
            values(${A},'clip','active',${hook},${secret},now())`,
      ),
      /payment_account_activation_worker_only/,
    );
    await write(
      owner,
      (tx) =>
        tx`insert into payment_provider_accounts(tenant_id,provider,state,hook_hash) values(${A},'clip','verifying',${hook})`,
    );
    await rejects(
      write(
        owner,
        (tx) =>
          tx`update payment_provider_accounts set state='active' where provider='clip'`,
      ),
      /payment_account_activation_worker_only/,
    );
    if (target.worker) {
      const worker = postgres(target.worker, { max: 1 });
      try {
        await worker.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${A}, true)`;
          await tx`update payment_attempts set state='approved',paid_amount=4500,decided_at=now() where id=${a}`;
        });
        await rejects(
          worker.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${A}, true)`;
            await tx`update payment_attempts set state='review' where id=${a}`;
          }),
          /payment_attempt_transition approved -> review|permission denied/,
        );
        await rejects(
          worker.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${A}, true)`;
            await tx`insert into tenders(tenant_id,id,order_id,method,amount,received) values(${A},${randomUUID()},${o.id},'cash',1,1)`;
          }),
          /permission denied|42501/,
        );
      } finally {
        await worker.end();
      }
      // The web side moves an approved attempt that no longer fits to review (P2's settle).
      await write(
        owner,
        (tx) =>
          tx`update payment_attempts set state='review',error_code='payments_settle_order_changed' where id=${a}`,
      );
      await write(
        owner,
        (tx) =>
          tx`update payment_attempts set state='dismissed',resolution='refunded_at_provider',resolution_note='Reembolso MP 123456789',resolved_by=${ids.manager},resolved_at=now() where id=${a}`,
      );
    } else {
      await asOwner(
        A,
        (tx) =>
          tx`update payment_attempts set state='review',paid_amount=4500 where id=${a}`,
      ).catch(() => {});
      console.log(
        "  (worker login not configured: worker transitions skipped)",
      );
    }
  });

  await test("4b. tender shape checks refuse each malformed row once", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const tender = (cols: Record<string, unknown>) =>
      asOwner(A, (tx) => {
        const row = {
          tenant_id: A,
          id: randomUUID(),
          order_id: o.id,
          session_id: ids.drawer1,
          method: "cash",
          amount: 100,
          tip: 0,
          received: 100,
          ...cols,
        };
        return tx`insert into tenders ${tx(row)}`;
      });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ method: "card" }, /tenders_method_check/],
      [{ method: "platform" }, /tenders_platform_shape/],
      [
        { method: "platform", platform: "rappi", tip: 10, received: 110 },
        /tenders_platform_shape/,
      ],
      [
        { method: "platform", platform: "rappi", received: 90 },
        /tenders_platform_shape/,
      ],
      [{ method: "platform", platform: "other" }, /tenders_platform_shape/],
      [{ platform: "rappi" }, /tenders_platform_shape/],
      [
        { terminal_id: bbva.id, terminal_label: "BBVA" },
        /tenders_terminal_shape/,
      ],
      [{ method: "external", terminal_id: bbva.id }, /tenders_terminal_shape/],
      [
        {
          method: "external",
          terminal_id: mpTerminal,
          terminal_label: "MP",
          provider: "mercadopago",
          provider_reference: "ORD1",
        },
        /tenders_integrated_shape/,
      ],
      [{ provider_reference: "ORD1" }, /tenders_integrated_shape/],
      [{ card_brand: "visa" }, /tenders_card_shape/],
      [{ method: "external", card_last4: "42" }, /tenders_card_shape/],
      [{ fee: 10 }, /tenders_fee_shape/],
      [{ fee: 10, fee_source: "guess" }, /tenders_fee_shape/],
    ];
    for (const [cols, pattern] of cases) await rejects(tender(cols), pattern);
  });

  await test("recordPayment platform: platform required, full balance, no tip, confirmation, enabled platform; the tender is outside cash and carries the estimated commission", async () => {
    await write(manager, (tx) =>
      savePlatforms(tx, manager, {
        operationId: randomUUID(),
        platforms: [
          {
            platform: "didi_food",
            enabled: true,
            commissionBp: 2500,
            expectedVersion: 0,
          },
          {
            platform: "rappi",
            enabled: false,
            commissionBp: null,
            expectedVersion: 0,
          },
        ],
      }),
    );
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    await rejects(
      pay(cashier, o.id, platformBody(9000, { platform: undefined })),
      "payments_platform_required",
    );
    await rejects(
      pay(cashier, o.id, platformBody(9000, { platform: "other" })),
      "payments_platform_required",
    );
    await rejects(
      pay(cashier, o.id, platformBody(4500)),
      "payments_platform_full_balance",
    );
    await rejects(
      pay(cashier, o.id, platformBody(9000, { tip: 500, received: 9500 })),
      "payments_platform_no_tip",
    );
    await rejects(
      pay(cashier, o.id, platformBody(9000, { externalConfirmed: false })),
      "payments_platform_confirm_required",
    );
    await rejects(
      pay(cashier, o.id, platformBody(9000, { platform: "rappi" })),
      "payments_platform_disabled",
    );
    await rejects(
      pay(cashier, o.id, platformBody(9000, { terminalId: bbva.id })),
      "invalid_input",
    );
    await rejects(
      pay(cashier, o.id, {
        ...terminalBody(9000),
        method: "cash",
        terminalId: bbva.id,
      }),
      "invalid_input",
    );
    const paid = await pay(cashier, o.id, platformBody(9000, { received: 1 }));
    assert.equal(paid.paid, 9000);
    assert.notEqual(paid.checkState, "open");
    const [t] = paid.tenders;
    assert.equal(t.method, "platform");
    assert.equal(t.platform, "didi_food");
    assert.equal(t.received, 9000, "received is forced to the amount");
    assert.equal(t.external_reference, "4F2A");
    assert.equal(t.fee, undefined, "the order view never carries fees");
    const [row] = await asOwner(
      A,
      (tx) => tx`select fee,fee_source from tenders where id=${t.id}`,
    );
    assert.deepEqual({ ...row }, { fee: 2250, fee_source: "estimated" });
    // 11. the fiscal ticket payload records the platform and its label.
    const [ticket] = await asOwner(
      A,
      (tx) => tx`select payments from fiscal_tickets where order_id=${o.id}`,
    );
    assert.ok(ticket, "a platform order gets its fiscal ticket");
    assert.deepEqual(
      ticket.payments.map((p: any) => [p.method, p.platform, p.label]),
      [["platform", "didi_food", "DiDi Food"]],
    );
    const [audit] = await asOwner(
      A,
      (tx) =>
        tx`select detail from audit where entity_id=${o.id} and operation='payment.recorded'`,
    );
    assert.equal(audit.detail.platform, "didi_food");
  });

  await test("recordPayment named terminal: label snapshot and fee on amount + tip; archived and unknown terminals refused online", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const paid = await pay(cashier, o.id, terminalBody(4500, bbva.id, 500));
    const [row] = await asOwner(
      A,
      (tx) =>
        tx`select terminal_id,terminal_label,fee,fee_source,received from tenders where order_id=${o.id}`,
    );
    assert.deepEqual(
      { ...row },
      {
        terminal_id: bbva.id,
        terminal_label: "BBVA",
        fee: 88, // 1.75 % of 5,000, half up
        fee_source: "estimated",
        received: 5000,
      },
    );
    assert.equal(paid.tenders[0].terminal_label, "BBVA");
    const archived = (
      await write(manager, (tx) =>
        saveTerminal(tx, manager, {
          operationId: randomUUID(),
          name: "Vieja " + run,
          kind: "manual",
          feeBp: null,
        }),
      )
    ).terminals.find((t) => t.name === "Vieja " + run)!;
    await write(manager, (tx) =>
      archiveTerminal(tx, manager, archived.id, {
        operationId: randomUUID(),
        expectedVersion: archived.version,
      }),
    );
    const o2 = await newOrder(cashier, [{ product: ids.agua, quantity: 1 }]);
    await rejects(
      pay(cashier, o2.id, terminalBody(3000, archived.id)),
      "payments_terminal_inactive",
    );
    await rejects(
      pay(cashier, o2.id, terminalBody(3000, randomUUID())),
      "payments_terminal_not_found",
    );
  });

  await test("8. guards: payment, void, discount, close and settlement refuse while the order has a live attempt; a round is allowed; the guard lifts when the attempt ends", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]);
    const other = await newOrder(cashier, [{ product: ids.agua, quantity: 1 }]);
    const a = await attempt({
      orderId: o.id,
      terminalId: mpTerminal,
      drawerId: ids.drawer1,
    });
    await rejects(
      pay(cashier, o.id, { amount: 1000, received: 1000, method: "cash" }),
      "payments_order_attempt_live",
    );
    await rejects(
      write(manager, (tx) =>
        voidLines(
          tx,
          manager,
          o.id,
          {
            operationId: randomUUID(),
            expectedVersion: o.version,
            lines: [{ lineId: o.lines[0].id, quantity: 1 }],
            reason: "Cliente cambió de opinión",
            stockDisposition: "no_return",
          },
          ids.manager,
        ),
      ),
      "payments_order_attempt_live",
    );
    await rejects(
      write(manager, (tx) =>
        applyDiscount(
          tx,
          manager,
          o.id,
          (() => {
            const body = {
              operationId: randomUUID(),
              expectedVersion: o.version,
              scope: "order",
              kind: "percent",
              percentBps: 1000,
              reasonCode: "courtesy",
              note: "",
            };
            // The preview a client would send (a fresh order: nothing paid yet).
            return {
              ...body,
              ...discountExpectation(o, planDiscount(o, body as never)),
            };
          })(),
          { approverId: null },
        ),
      ),
      "payments_order_attempt_live",
    );
    await rejects(
      write(cashier, (tx) =>
        closeCheck(tx, cashier, o.id, { operationId: randomUUID() }),
      ),
      "payments_order_attempt_live",
    );
    await rejects(
      write(cashier, (tx) =>
        recordSettlement(tx, cashier, {
          operationId: randomUUID(),
          orders: [
            { id: o.id, amount: 9000 },
            { id: other.id, amount: 3000 },
          ],
          received: 12000,
        }),
      ),
      "payments_order_attempt_live",
    );
    // A round raises the total: allowed while the charge runs.
    const grown = await write(cashier, (tx) =>
      addRound(tx, cashier, o.id, {
        operationId: randomUUID(),
        expectedVersion: o.version,
        lines: [
          {
            id: randomUUID(),
            productId: ids.agua,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
      }),
    );
    assert.equal(grown.total, 12000);
    // Offline evidence is always applied (OFF-8), even with a live attempt.
    const tenderId = await write(cashier, (tx) =>
      newTender(
        tx,
        cashier,
        o.id,
        {
          method: "cash",
          amount: 1000,
          tip: 0,
          received: 1000,
          reference: "",
          externalConfirmed: false,
        },
        ids.drawer1,
      ),
    );
    assert.ok(tenderId);
    await cancelAttempt(a);
    const after = await pay(cashier, o.id, {
      amount: 1000,
      received: 1000,
      method: "cash",
    });
    assert.equal(after.paid, 2000);
  });

  await test("12. offline evidence: a platform sale and a named-terminal sale apply; an archived terminal is accepted, an unknown one dropped and noted", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    await write(cashier, (tx) =>
      newTender(
        tx,
        cashier,
        o.id,
        {
          method: "platform",
          amount: 4500,
          tip: 0,
          received: 4500,
          reference: "",
          externalConfirmed: true,
          platform: "rappi", // disabled now: evidence predates the setting
        },
        ids.drawer1,
      ),
    );
    const [p] = await asOwner(
      A,
      (tx) => tx`select method,platform from tenders where order_id=${o.id}`,
    );
    assert.deepEqual({ ...p }, { method: "platform", platform: "rappi" });
    const archived = (
      await write(manager, (tx) => paymentSettingsView(tx, manager))
    ).terminals.find((t) => t.archivedAt)!;
    const o2 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    await write(cashier, (tx) =>
      newTender(
        tx,
        cashier,
        o2.id,
        {
          method: "external",
          amount: 4500,
          tip: 0,
          received: 4500,
          reference: "OFF-1",
          externalConfirmed: true,
          terminalId: archived.id,
        },
        ids.drawer1,
      ),
    );
    const o3 = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const unknown = randomUUID();
    await write(cashier, (tx) =>
      newTender(
        tx,
        cashier,
        o3.id,
        {
          method: "external",
          amount: 4500,
          tip: 0,
          received: 4500,
          reference: "OFF-2",
          externalConfirmed: true,
          terminalId: unknown,
        },
        ids.drawer1,
      ),
    );
    const rows = await asOwner(
      A,
      (tx) =>
        tx`select order_id,terminal_id,terminal_label from tenders where order_id in (${o2.id},${o3.id})`,
    );
    assert.equal(
      rows.find((r: any) => r.order_id === o2.id).terminal_id,
      archived.id,
    );
    assert.equal(rows.find((r: any) => r.order_id === o3.id).terminal_id, null);
    const [note] = await asOwner(
      A,
      (tx) =>
        tx`select detail from audit where entity_id=${o3.id} and operation='payment.recorded'`,
    );
    assert.equal(note.detail.droppedTerminalId, unknown);
    assert.equal(note.detail.note, "payments_terminal_unknown");
  });

  await test("12b. payment recovery: a manager records a stored platform attempt; inconsistent platform evidence is refused", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const stored = (payload: object) => ({
      formatVersion: 1,
      tenantId: A,
      employeeId: ids.cashier,
      deviceId: ids.device1,
      sessionId: cashier.id,
      cashSessionId: ids.drawer1,
      orderId: o.id,
      createdAt: new Date().toISOString(),
      payload: {
        operationId: randomUUID(),
        amount: 4500,
        tip: 0,
        received: 4500,
        method: "platform",
        externalConfirmed: true,
        reference: "UB-1",
        platform: "uber_eats",
        ...payload,
      },
    });
    const result = await write(manager, (tx) =>
      resolvePaymentAttempt(tx, manager, {
        operationId: randomUUID(),
        attempt: stored({}),
        outcome: "recorded",
        reason: "La plataforma cobró el pedido, verificado en su portal",
        confirmed: true,
      }),
    );
    assert.equal(result.state, "recorded");
    const [t] = await asOwner(
      A,
      (tx) =>
        tx`select method,platform,source from tenders where order_id=${o.id}`,
    );
    assert.deepEqual(
      { ...t },
      { method: "platform", platform: "uber_eats", source: "offline_recovery" },
    );
    await rejects(
      write(manager, (tx) =>
        resolvePaymentAttempt(tx, manager, {
          operationId: randomUUID(),
          attempt: stored({ externalConfirmed: false }),
          outcome: "recorded",
          reason: "La plataforma cobró el pedido, verificado en su portal",
          confirmed: true,
        }),
      ),
      "invalid_input",
    );
  });

  await test("10. refunds: an amount refund of a platform tender needs no drawer or terminal confirmation; the batch splits it as platform; the legacy route refuses it", async () => {
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    await write(manager, (tx) =>
      savePlatforms(tx, manager, {
        operationId: randomUUID(),
        platforms: [
          {
            platform: "uber_eats",
            enabled: true,
            commissionBp: 3000,
            expectedVersion: 0,
          },
        ],
      }),
    );
    const paid = await pay(
      cashier,
      o.id,
      platformBody(4500, { platform: "uber_eats" }),
    );
    const tenderId = paid.tenders[0].id;
    await rejects(
      write(manager, (tx) =>
        refund(tx, manager, {
          operationId: randomUUID(),
          tenderId,
          amount: 1000,
          reason: "Plataforma reembolsó",
          disposition: "discard",
        }),
      ),
      "payments_platform_refund_requires_batch",
    );
    const r = await write(manager, (tx) =>
      recordRefund(
        tx,
        manager,
        o.id,
        {
          mode: "amount",
          operationId: randomUUID(),
          tenderId,
          amount: 1500,
          expectedRefunded: 0,
          reasonCode: "charge_error",
          note: "",
        },
        { approverId: ids.manager },
      ),
    );
    assert.deepEqual(
      {
        cash: r.batch.cashAmount,
        external: r.batch.externalAmount,
        platform: r.batch.platformAmount,
      },
      { cash: 0, external: 0, platform: 1500 },
    );
    assert.equal(r.batch.rows[0].method, "platform");
    // The deferred reconcile trigger counts the platform portion.
    await rejects(
      asOwner(A, async (tx) => {
        const batch = randomUUID();
        await tx`insert into refund_batches(tenant_id,id,order_id,mode,amount,cash_amount,external_amount,
            platform_amount,reason_code,actor_id,approver_id,device_id,business_date)
          values(${A},${batch},${o.id},'amount',100,0,0,100,'charge_error',${ids.manager},${ids.manager},
            ${ids.device1},${today})`;
        await tx`insert into refunds(tenant_id,id,tender_id,amount,reason,disposition,actor_id,method,batch_id,order_id)
          values(${A},${randomUUID()},${tenderId},100,'x','no_stock_return',${ids.manager},'cash',${batch},${o.id})`;
      }),
      /refund method must match|does not reconcile/,
    );
    await rejects(
      asOwner(
        A,
        (tx) =>
          tx`insert into refund_batches(tenant_id,id,order_id,mode,amount,cash_amount,external_amount,
            platform_amount,reason_code,actor_id,approver_id,device_id,business_date)
          values(${A},${randomUUID()},${o.id},'amount',100,0,0,90,'charge_error',${ids.manager},${ids.manager},
            ${ids.device1},${today})`,
      ),
      /refund_batches_split/,
    );
  });

  await test("13. price lists: a platform-priced order uses the platform price (POS fallback), its rounds keep the list, its platform tender must match; QR never takes a list", async () => {
    const before = await write(owner, (tx) => menuRevision(tx));
    await rejects(
      write(staleManager, (tx) =>
        savePlatformPrices(tx, staleManager, {
          operationId: randomUUID(),
          prices: [
            {
              productId: ids.taco,
              platform: "uber_eats",
              price: 5900,
              expectedVersion: 0,
            },
          ],
        }),
      ),
      "step_up_required",
    );
    await rejects(
      write(cashier, (tx) =>
        savePlatformPrices(tx, cashier, {
          operationId: randomUUID(),
          prices: [
            {
              productId: ids.taco,
              platform: "uber_eats",
              price: 5900,
              expectedVersion: 0,
            },
          ],
        }),
      ),
      "forbidden",
    );
    const saved = await write(manager, (tx) =>
      savePlatformPrices(tx, manager, {
        operationId: randomUUID(),
        prices: [
          {
            productId: ids.taco,
            platform: "uber_eats",
            price: 5900,
            expectedVersion: 0,
          },
        ],
      }),
    );
    assert.deepEqual(
      saved.prices.map((p) => [p.productId, p.platform, p.price, p.version]),
      [[ids.taco, "uber_eats", 5900, 1]],
    );
    await rejects(
      write(manager, (tx) =>
        savePlatformPrices(tx, manager, {
          operationId: randomUUID(),
          prices: [
            {
              productId: ids.taco,
              platform: "uber_eats",
              price: 6000,
              expectedVersion: 0,
            },
          ],
        }),
      ),
      "payments_price_changed",
    );
    const after = await write(owner, (tx) => menuRevision(tx));
    assert.ok(after.revision > before.revision, "every POS reprices");
    const staff = await write(owner, (tx) => catalog(tx));
    assert.deepEqual(staff.find((p) => p.id === ids.taco)!.platformPrices, {
      uber_eats: 5900,
    });
    assert.equal(
      staff.find((p) => p.id === ids.agua)!.platformPrices,
      undefined,
    );
    const diner = await write(owner, (tx) => publicCatalog(tx));
    assert.ok(
      diner.every((p) => !("platformPrices" in p)),
      "diners never see platform prices",
    );
    const o = await newOrder(
      cashier,
      [
        { product: ids.taco, quantity: 2 },
        { product: ids.agua, quantity: 1 },
      ],
      { pricePlatform: "uber_eats" },
    );
    assert.equal(o.pricePlatform, "uber_eats");
    assert.equal(
      o.lines.find((l) => l.productId === ids.taco)!.unitPrice,
      5900,
    );
    assert.equal(
      o.lines.find((l) => l.productId === ids.agua)!.unitPrice,
      3000,
      "no platform price: the POS price",
    );
    assert.equal(o.total, 2 * 5900 + 3000);
    const round = await write(cashier, (tx) =>
      addRound(tx, cashier, o.id, {
        operationId: randomUUID(),
        expectedVersion: o.version,
        lines: [
          {
            id: randomUUID(),
            productId: ids.taco,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
      }),
    );
    assert.equal(round.total, 3 * 5900 + 3000);
    await rejects(
      write(cashier, (tx) =>
        addRound(tx, cashier, o.id, {
          operationId: randomUUID(),
          expectedVersion: round.version,
          lines: [
            {
              id: randomUUID(),
              productId: ids.taco,
              quantity: 1,
              options: [],
              note: "",
            },
          ],
          mode: "takeaway",
          pricePlatform: "didi_food",
        }),
      ),
      "payments_platform_price_list",
    );
    await rejects(
      pay(cashier, o.id, platformBody(round.total)),
      "payments_platform_price_list",
    );
    const settled = await pay(
      cashier,
      o.id,
      platformBody(round.total, { platform: "uber_eats" }),
    );
    assert.notEqual(settled.checkState, "open");
    const [ticket] = await asOwner(
      A,
      (tx) => tx`select gross from fiscal_tickets where order_id=${o.id}`,
    );
    assert.equal(
      ticket.gross,
      round.total,
      "the ticket uses the charged price",
    );
    await rejects(
      newOrder(cashier, [{ product: ids.taco, quantity: 1 }], {
        channel: "qr",
        pricePlatform: "uber_eats",
      }),
      "invalid_input",
    );
  });

  await test("14. settings: names unique, integrated kinds need an account, archive refused while the terminal may show a charge, device defaults, options hide fees from cashiers", async () => {
    await rejects(
      write(manager, (tx) =>
        saveTerminal(tx, manager, {
          operationId: randomUUID(),
          name: " bbva ",
          kind: "manual",
          feeBp: null,
        }),
      ),
      "payments_terminal_name_taken",
    );
    await rejects(
      write(manager, (tx) =>
        saveTerminal(tx, manager, {
          operationId: randomUUID(),
          name: "Clip Mostrador",
          kind: "clip_pinpad",
          providerDeviceId: "P8SN123",
          feeBp: 418,
        }),
      ),
      "payments_provider_not_configured",
    );
    await rejects(
      write(cashier, (tx) =>
        saveTerminal(tx, cashier, {
          operationId: randomUUID(),
          name: "X",
          kind: "manual",
          feeBp: null,
        }),
      ),
      "forbidden",
    );
    await rejects(
      write(staleManager, (tx) =>
        saveTerminal(tx, staleManager, {
          operationId: randomUUID(),
          name: "X",
          kind: "manual",
          feeBp: null,
        }),
      ),
      "step_up_required",
    );
    const o = await newOrder(cashier, [{ product: ids.taco, quantity: 1 }]);
    const live = await attempt({
      orderId: o.id,
      terminalId: mpTerminal,
      drawerId: ids.drawer1,
    });
    const view = await write(manager, (tx) => paymentSettingsView(tx, manager));
    const mp = view.terminals.find((t) => t.id === mpTerminal)!;
    await rejects(
      write(manager, (tx) =>
        archiveTerminal(tx, manager, mpTerminal, {
          operationId: randomUUID(),
          expectedVersion: mp.version,
        }),
      ),
      "payments_terminal_busy",
    );
    await cancelAttempt(live);
    // Device defaults: own device for operators, any for managers; null clears.
    await rejects(
      write(cashier, (tx) =>
        setDeviceTerminal(tx, cashier, ids.device2, {
          operationId: randomUUID(),
          terminalId: bbva.id,
        }),
      ),
      "forbidden",
    );
    await write(cashier, (tx) =>
      setDeviceTerminal(tx, cashier, ids.device1, {
        operationId: randomUUID(),
        terminalId: bbva.id,
      }),
    );
    const forCashier = await write(cashier, (tx) =>
      paymentOptions(tx, cashier),
    );
    assert.equal(forCashier.defaultTerminalId, bbva.id);
    assert.ok(forCashier.terminals.every((t) => !("feeBp" in t)));
    assert.ok(forCashier.platforms.every((p) => !("commissionBp" in p)));
    assert.ok(
      !forCashier.platforms.some((p) => p.platform === "rappi"),
      "a disabled platform is not offered",
    );
    assert.equal(forCashier.integratedAvailable, false);
    const forManager = await write(manager, (tx) =>
      paymentOptions(tx, manager),
    );
    assert.equal(
      forManager.terminals.find((t) => t.id === bbva.id)!.feeBp,
      175,
    );
    assert.equal(
      forManager.platforms.find((p) => p.platform === "didi_food")!
        .commissionBp,
      2500,
    );
    await write(manager, (tx) =>
      setDeviceTerminal(tx, manager, ids.device1, {
        operationId: randomUUID(),
        terminalId: null,
      }),
    );
    assert.equal(
      (await write(cashier, (tx) => paymentOptions(tx, cashier)))
        .defaultTerminalId,
      null,
    );
    await rejects(
      write(manager, (tx) =>
        savePlatforms(tx, manager, {
          operationId: randomUUID(),
          platforms: [
            {
              platform: "didi_food",
              enabled: true,
              commissionBp: 2000,
              expectedVersion: 0,
            },
          ],
        }),
      ),
      "payments_settings_changed",
    );
  });

  await test("9. drawer: close refused while an attempt is live; card money by terminal and platform money apart from expected cash; batch totals per terminal", async () => {
    // Register 2 (Barra) has its own drawer: one cash, one BBVA, one "Otra terminal" and one
    // platform sale, then a close with the batch totals typed per terminal.
    const s = server2;
    // Servers may not close drawers (money controls default): a manager closes register 2.
    const closer = session(A, ids.manager, "manager", ids.device2);
    const sale = async (method: object, amount: number) => {
      const o = await newOrder(s, [{ product: ids.agua, quantity: 1 }]);
      return pay(s, o.id, {
        ...method,
        amount,
        received: amount + (method as any).tip,
      });
    };
    await sale({ method: "cash", tip: 0 }, 3000);
    await sale(
      {
        method: "external",
        tip: 300,
        externalConfirmed: true,
        reference: "B1",
        terminalId: bbva.id,
      },
      3000,
    );
    await sale(
      { method: "external", tip: 0, externalConfirmed: true, reference: "B2" },
      3000,
    );
    await sale(
      {
        method: "platform",
        tip: 0,
        externalConfirmed: true,
        reference: "",
        platform: "didi_food",
      },
      3000,
    );
    const blocker = await newOrder(s, [{ product: ids.agua, quantity: 1 }]);
    const a = await attempt({
      orderId: blocker.id,
      terminalId: mpTerminal,
      drawerId: ids.drawer2,
    });
    const view = await write(s, (tx) => cashSummary(tx, s));
    assert.equal(view!.unresolvedAttempts.length, 1);
    assert.equal(view!.unresolvedAttempts[0].orderNumber, blocker.number);
    await rejects(
      write(closer, (tx) =>
        closeCash(tx, closer, {
          operationId: randomUUID(),
          counted: 83_000,
          reason: "",
        }),
      ),
      "payments_attempt_unresolved",
    );
    await cancelAttempt(a);
    const open = await write(manager, (tx) =>
      cashSummary(tx, manager, ids.drawer2),
    );
    assert.equal(
      open!.expected,
      50_000 + 3000,
      "platform never enters expected cash",
    );
    assert.deepEqual(open!.platform, {
      sales: 3000,
      refunds: 0,
      net: 3000,
      count: 1,
    });
    assert.deepEqual(
      open!.byTerminal.map((t) => [t.label, t.count, t.amount, t.tips, t.net]),
      [
        ["BBVA", 1, 3000, 300, 3300],
        [null, 1, 3000, 0, 3000],
      ],
    );
    assert.deepEqual(open!.byTerminal[0].fees, { provider: 0, estimated: 58 });
    assert.equal(
      open!.external.sales,
      6000,
      "the card total stays the sum of terminals",
    );
    assert.deepEqual(
      open!.platforms.map((p) => [p.platform, p.amount, p.commission]),
      [["didi_food", 3000, 750]],
    );
    const blind = await write(s, (tx) => cashSummary(tx, s));
    assert.ok(
      blind!.byTerminal.every((t) => !("fees" in t)),
      "no fees for staff",
    );
    assert.ok(
      (blind!.tenders as any[]).every((t) => !("fee" in t)),
      "tender rows carry no fees for staff",
    );
    await rejects(
      write(closer, (tx) =>
        closeCash(tx, closer, {
          operationId: randomUUID(),
          counted: 53_000,
          reason: "",
          externalReported: 1,
          terminalReports: [{ terminalId: bbva.id, reported: 3300 }],
        }),
      ),
      "invalid_input",
    );
    await write(closer, (tx) =>
      closeCash(tx, closer, {
        operationId: randomUUID(),
        counted: 53_000,
        reason: "",
        terminalReports: [
          { terminalId: bbva.id, reported: 3200 },
          { terminalId: null, reported: 3000 },
        ],
      }),
    );
    const counts = await asOwner(
      A,
      (tx) =>
        tx`select terminal_id,expected,reported from drawer_terminal_counts where drawer_id=${ids.drawer2} order by terminal_id nulls last`,
    );
    assert.deepEqual(
      counts.map((c: any) => [c.terminal_id, c.expected, c.reported]),
      [
        [bbva.id, 3300, 3200],
        [null, 3000, 3000],
      ],
    );
    const [drawer] = await asOwner(
      A,
      (tx) =>
        tx`select expected,external_expected,external_reported from cash_sessions where id=${ids.drawer2}`,
    );
    assert.deepEqual(
      { ...drawer },
      { expected: 53_000, external_expected: 6300, external_reported: 6200 },
    );
    const closed = await write(manager, (tx) =>
      cashSummary(tx, manager, ids.drawer2),
    );
    assert.deepEqual(
      closed!.byTerminal.map((t) => [t.reported, t.difference]),
      [
        [3200, -100],
        [3000, 0],
      ],
    );
  });

  await test("16. reports: platform is its own method, byTerminal and byPlatform reconcile with it, fees reach the margin, and per-terminal batch differences are exceptions", async () => {
    const summary = await snapshotTenant(sql, A, (tx) =>
      salesSummary(tx, owner, { from: today, to: today }, "req-pay", ports),
    );
    const methods = summary.collections.byMethod.map((m) => m.method);
    assert.deepEqual(methods, ["cash", "external", "platform"]);
    const external = summary.collections.byMethod[1];
    const platform = summary.collections.byMethod[2];
    assert.equal(
      summary.collections.byTerminal.reduce((s, t) => s + t.amount, 0),
      external.amount,
    );
    assert.equal(
      summary.collections.byPlatform.reduce((s, p) => s + p.amount, 0),
      platform.amount,
    );
    assert.ok(platform.amount > 0);
    assert.ok(
      summary.checks.every((c) => c.ok),
      JSON.stringify(summary.checks),
    );
    const bbvaRow = summary.collections.byTerminal.find(
      (t) => t.terminalId === bbva.id,
    )!;
    assert.equal(bbvaRow.label, "BBVA");
    assert.ok(bbvaRow.fees.estimated > 0);
    assert.equal(bbvaRow.netAfterFees, bbvaRow.net - bbvaRow.fees.estimated);
    const didi = summary.collections.byPlatform.find(
      (p) => p.platform === "didi_food",
    )!;
    assert.ok(didi.commission > 0);
    assert.equal(
      summary.margin.processorFees,
      summary.collections.byTerminal.reduce(
        (s, t) => s + t.fees.provider + t.fees.estimated,
        0,
      ),
    );
    assert.equal(
      summary.margin.platformCommissions,
      summary.collections.byPlatform.reduce((s, p) => s + p.commission, 0),
    );
    assert.equal(summary.refunds.platform, 1500);
    const list = await snapshotTenant(sql, A, (tx) =>
      tenderRows(tx, owner, { from: today, to: today, method: "platform" }),
    );
    assert.ok(list.rows.length >= 3);
    assert.ok(list.rows.every((r) => r.method === "platform" && r.platform));
    const card = await snapshotTenant(sql, A, (tx) =>
      tenderRows(tx, owner, { from: today, to: today, method: "external" }),
    );
    assert.ok(card.rows.some((r) => r.terminal === "BBVA" && r.fee !== null));
    const ex = await snapshotTenant(sql, A, (tx) =>
      exceptionRows(tx, owner, {
        from: today,
        to: today,
        kinds: "terminal_difference",
      }),
    );
    assert.deepEqual(
      ex.rows.map((r) => [r.amount, r.detail.terminalId]),
      [[-100, bbva.id]],
    );
  });

  await test("15. lock order: platform and terminal payments, voids, rounds, price and terminal saves and a drawer close run together with no deadlock (LO-R9)", async () => {
    const list: Order[] = [];
    for (let i = 0; i < 4; i++)
      list.push(await newOrder(cashier, [{ product: ids.taco, quantity: 2 }]));
    const view = await write(manager, (tx) => paymentSettingsView(tx, manager));
    const price = view.prices.find(
      (p) => p.productId === ids.taco && p.platform === "uber_eats",
    )!;
    const results = await noRetries("payments burst", () =>
      Promise.allSettled([
        pay(cashier, list[0].id, platformBody(list[0].total)),
        pay(cashier, list[1].id, terminalBody(list[1].total, bbva.id)),
        write(manager, (tx) =>
          voidLines(
            tx,
            manager,
            list[2].id,
            {
              operationId: randomUUID(),
              expectedVersion: list[2].version,
              lines: [{ lineId: list[2].lines[0].id, quantity: 1 }],
              reason: "Cliente cambió de opinión",
              stockDisposition: "no_return",
            },
            ids.manager,
          ),
        ),
        write(cashier, (tx) =>
          addRound(tx, cashier, list[3].id, {
            operationId: randomUUID(),
            expectedVersion: list[3].version,
            lines: [
              {
                id: randomUUID(),
                productId: ids.taco,
                quantity: 1,
                options: [],
                note: "",
              },
            ],
            mode: "takeaway",
          }),
        ),
        write(manager, (tx) =>
          savePlatformPrices(tx, manager, {
            operationId: randomUUID(),
            prices: [
              {
                productId: ids.taco,
                platform: "uber_eats",
                price: 6100,
                expectedVersion: price.version,
              },
            ],
          }),
        ),
        write(manager, (tx) =>
          saveTerminal(tx, manager, {
            operationId: randomUUID(),
            name: "Santander " + run,
            kind: "manual",
            feeBp: 200,
          }),
        ),
        write(manager, (tx) =>
          closeCash(tx, manager, {
            operationId: randomUUID(),
            counted: 0,
            reason: "Corte de prueba del burst",
          }),
        ),
      ]),
    );
    // The close may win the race against the two payments, which then need an open drawer;
    // nothing else may fail, and no deadlock or serialization failure may occur (noRetries).
    for (const r of results)
      if (r.status === "rejected")
        assert.equal(
          (r.reason as { code?: string }).code,
          "drawer_required",
          String(r.reason),
        );
  });

  console.log(`payments DB: ${checks} checks passed`);
} finally {
  await sql.end();
  await admin.end();
}
