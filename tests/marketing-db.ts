// Guest marketing (047) against PostgreSQL: double opt-in, campaigns, the daily automation
// pass, delivery by the jobs login with fake providers, attribution and the role/RLS
// boundaries. The migration login may bypass RLS, so every asAdmin query names its tenant.
// Fixture: fresh Pro restaurants with the club on (fictional data only).
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { password } from "../server/auth.js";
import {
  checkRole,
  connect,
  connectWorker,
  tenant,
  type Tx,
} from "../server/db.js";
import { createOrder } from "../server/orders.js";
import {
  saveLoyaltySettings,
  getLoyaltySettings,
} from "../server/loyalty/settings.js";
import {
  enrollMember,
  updateMember,
  deleteMember,
} from "../server/loyalty/members.js";
import { linkOrderMember } from "../server/loyalty/links.js";
import {
  cancelCampaign,
  confirmMarketing,
  getMarketing,
  launchCampaign,
  launchScheduled,
  listAutomations,
  listCampaigns,
  memberStats,
  performance,
  previewAudience,
  runDaily,
  saveAutomation,
  saveCampaign,
  saveMarketing,
} from "../server/marketing/core.js";
import { marketingMessageHandler } from "../server/marketing-worker/messages.js";
import { legalConfig } from "../server/legal.js";
import { LEGAL_CI_ENV } from "./fixtures/legal-ci.js";
import { isolatedTarget, requireWorker } from "./isolated-target.js";
import type { Session } from "../shared/domain.js";
import type { LoyaltySettingsView } from "../shared/loyalty.js";

const target = isolatedTarget(process.env);
const sql = connect(target.runtime),
  admin = postgres(target.migration, { max: 1 }),
  workerSql = connectWorker(requireWorker(target));
await checkRole(sql);
const LEGAL = legalConfig(LEGAL_CI_ENV);
const restaurant = {
  name: "Taquería Campañas",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
type Fixture = {
  tenantId: string;
  owner: Session;
  cashier: Session;
  taco: string;
};
let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: any) => {
    assert.equal(String(e.code ?? e.message), code);
    return true;
  });
const asAdmin = <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
  admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    return fn(tx);
  }) as Promise<T>;
const run = <T>(s: Session, fn: (tx: Tx) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
let phoneSeq = Math.floor(Math.random() * 1_000_000);
const newPhone = () =>
  "55" + String(10_000_000 + (phoneSeq++ % 89_999_999)).slice(0, 8);
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

async function makeTenant(plan: "pro" | "free" = "pro"): Promise<Fixture> {
  const organizationId = randomUUID(),
    tenantId = randomUUID(),
    terminal = randomUUID(),
    taco = randomUUID(),
    ids = { owner: randomUUID(), cashier: randomUUID() };
  await admin`insert into organizations(id,name) values(${organizationId},'Campañas de prueba')`;
  await admin`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,free_location)
    values(${tenantId},${organizationId},${restaurant.name},'MXN','America/Mexico_City',240,true)`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    values(${tenantId},'active',now()+interval '1 day','fixture')`;
  await asAdmin(tenantId, async (tx) => {
    for (const [role, employeeId] of Object.entries(ids))
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${employeeId},${"Campañas " + role},${role + "-" + employeeId.slice(0, 8)},${password("4321")},${role})`;
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,free_slot) values(${tenantId},${terminal},'Caja campañas',${"fx-" + terminal},'terminal',1)`;
    await tx`insert into catalog(tenant_id,id,data) values(${tenantId},${taco},${tx.json(
      {
        id: taco,
        name: { es: "Taco", en: "Taco" },
        category: { es: "Pruebas", en: "Tests" },
        price: 45000,
        available: true,
        station: "kitchen",
        groups: [],
        cost: 100,
        version: 1,
        recipe: [],
      },
    )})`;
    await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening) values(${tenantId},${randomUUID()},${terminal},${ids.owner},0)`;
    await tx`insert into restaurant_account_settings(tenant_id,privacy_notice_url)
      values(${tenantId},'https://example.com/aviso-de-privacidad')`;
  });
  const session = (role: "owner" | "cashier"): Session => ({
    id: randomUUID(),
    tenantId,
    employeeId: ids[role],
    name: "Campañas " + role,
    role,
    deviceId: terminal,
    expiresAt: "",
    offlineUntil: "",
    csrf: "",
    restaurant,
  });
  const f = {
    tenantId,
    owner: session("owner"),
    cashier: session("cashier"),
    taco,
  };
  const v = (await run(f.owner, (tx) =>
    getLoyaltySettings(tx, f.owner),
  )) as LoyaltySettingsView;
  await run(f.owner, (tx) =>
    saveLoyaltySettings(
      tx,
      f.owner,
      {
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
      },
      LEGAL,
    ),
  );
  if (plan === "free")
    await admin`update restaurant_entitlements set status='free',access_until=null where tenant_id=${tenantId}`;
  return f;
}
async function enroll(f: Fixture, marketing = true, name = "Ana López") {
  const r = await run(f.cashier, (tx) =>
    enrollMember(tx, f.cashier, {
      operationId: randomUUID(),
      phone: newPhone(),
      country: "MX",
      name,
      consent: true,
      marketingOptIn: marketing,
    }),
  );
  return r.member as { id: string };
}
async function visit(f: Fixture, memberId: string) {
  const order = await run(f.cashier, (tx) =>
    createOrder(tx, f.cashier, {
      operationId: randomUUID(),
      lines: [
        {
          id: randomUUID(),
          productId: f.taco,
          quantity: 1,
          options: [],
          note: "",
        },
      ],
      mode: "takeaway",
      tableId: null,
      name: "Club",
      note: "",
      channel: "pos",
    }),
  );
  await run(f.cashier, (tx) =>
    linkOrderMember(tx, f.cashier, order.id, {
      operationId: randomUUID(),
      memberId,
    }),
  );
  return order;
}
const enable = (f: Fixture, over: Record<string, unknown> = {}) =>
  run(f.owner, async (tx) => {
    const current = await getMarketing(tx, f.owner, {});
    return saveMarketing(tx, f.owner, {
      operationId: randomUUID(),
      expectedVersion: current.settings.version,
      enabled: true,
      frequencyCapDays: 30,
      attributionDays: 7,
      sendHour: 11,
      ...over,
    });
  });
const SEND = { MARKETING_SMS_SEND: "1" };
const WORKER_ENV = {
  ...SEND,
  APP_URL: "https://app.example",
  TWILIO_ACCOUNT_SID: "synthetic",
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_MESSAGING_SERVICE_SID: "synthetic",
};
type Call = { url: string; to: string | null; body: string | null };
/** A fake provider: records requests and answers from `reply`. */
function provider(reply: (call: Call) => Response | "throw") {
  const calls: Call[] = [];
  const http = (async (url: string, init?: RequestInit) => {
    const form = init?.body instanceof URLSearchParams ? init.body : null;
    const call = {
      url,
      to: form?.get("To") ?? null,
      body: form?.get("Body") ?? null,
    };
    calls.push(call);
    const r = reply(call);
    if (r === "throw") throw Error("network");
    return r;
  }) as unknown as typeof fetch;
  return { calls, http };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });
const deliver = (
  f: Fixture,
  messageId: string,
  http: typeof fetch,
  env: NodeJS.ProcessEnv = WORKER_ENV,
) =>
  marketingMessageHandler(
    env,
    http,
  )({
    job: { tenantId: f.tenantId, payload: { messageId }, attempts: 1 },
    tenant: (fn: any) => tenant(workerSql, f.tenantId, fn),
    signal: new AbortController().signal,
  } as any);
const messages = (f: Fixture, where: "all" | string = "all") =>
  run(
    f.owner,
    (tx) =>
      tx`select * from marketing_messages where ${where === "all" ? tx`true` : tx`member_id=${where}`} order by created_at,id`,
  );
/** Runs the daily pass at a local hour past the send hour, whatever the clock says. */
async function daily(f: Fixture, env: NodeJS.ProcessEnv = SEND) {
  await asAdmin(
    f.tenantId,
    (tx) => tx`delete from marketing_runs where tenant_id=${f.tenantId}`,
  );
  // An Etc zone whose current hour is between noon and 20:00 keeps the test independent
  // of the clock. Etc/GMT-N is UTC+N (N up to 14); Etc/GMT+N is UTC-N (N up to 12).
  const utcHour = new Date().getUTCHours();
  const ahead = [...Array(27).keys()]
    .map((n) => n - 12)
    .find((k) => {
      const hour = (((utcHour + k) % 24) + 24) % 24;
      return hour >= 12 && hour <= 20;
    })!;
  const zone =
    ahead === 0 ? "UTC" : `Etc/GMT${ahead > 0 ? "-" : "+"}${Math.abs(ahead)}`;
  await admin`update restaurants set timezone=${zone} where id=${f.tenantId}`;
  try {
    return await run(f.owner, (tx) =>
      runDaily(tx, f.tenantId, env, Date.now() + 1000),
    );
  } finally {
    // Sessions snapshot the restaurant's settings; put the zone back for later commands.
    await admin`update restaurants set timezone=${restaurant.timezone} where id=${f.tenantId}`;
  }
}
/** Sends the member's confirmation with the fake provider and opens its link. */
async function confirm(f: Fixture, memberId: string) {
  const [msg] = (await messages(f, memberId)).filter(
    (m: any) => m.kind === "confirmation",
  );
  const p = provider(() =>
    json(201, { sid: "SM" + randomUUID().replace(/-/g, "") }),
  );
  await deliver(f, msg.id, p.http);
  const token = /confirm#(\S+)/.exec(p.calls[0].body!)![1];
  const [, member] = token.split(".");
  await tenant(sql, f.tenantId, (tx) =>
    confirmMarketing(tx, member, sha(token)),
  );
  return { token, text: p.calls[0].body!, to: p.calls[0].to! };
}

try {
  await test("M1 settings need a manager, the club and Pro, and are versioned", async () => {
    const f = await makeTenant();
    await rejects(
      run(f.cashier, (tx) => getMarketing(tx, f.cashier, {})),
      "forbidden",
    );
    const first = await enable(f);
    assert.equal(first.enabled, true);
    assert.equal(first.version, 1);
    await rejects(
      run(f.owner, (tx) =>
        saveMarketing(tx, f.owner, {
          operationId: randomUUID(),
          expectedVersion: 0,
          enabled: true,
        }),
      ),
      "stale_settings",
    );
    const free = await makeTenant("free");
    await rejects(enable(free), "pro_required");
    const [job] = await asAdmin(
      f.tenantId,
      (tx) =>
        tx`select kind,state from jobs where tenant_id=${f.tenantId} and kind='marketing_daily'`,
    );
    assert.equal(job.state, "available");
  });

  await test("M2 nobody is reachable before confirming the phone; the link confirms once", async () => {
    const f = await makeTenant();
    await enable(f);
    const ana = await enroll(f),
      silent = await enroll(f, false);
    const result = await daily(f);
    assert.equal(result!.confirmations, 1);
    assert.equal((await messages(f, silent.id)).length, 0);
    const before = await run(f.owner, (tx) => getMarketing(tx, f.owner, SEND));
    assert.deepEqual(
      [before.members, before.optedIn, before.confirmed],
      [2, 1, 0],
    );
    assert.equal(
      (await run(f.owner, (tx) => previewAudience(tx, f.owner, {}))).reachable,
      0,
    );
    const sent = await confirm(f, ana.id);
    assert.match(sent.to, /^\+52\d{10}$/);
    assert.match(sent.text, /^Taquería Campañas: confirma/);
    const after = await run(f.owner, (tx) => getMarketing(tx, f.owner, SEND));
    assert.equal(after.confirmed, 1);
    // No phone, name or text is stored on the message row or its job.
    const [row] = await messages(f, ana.id);
    const [job] = await asAdmin(
      f.tenantId,
      (tx) =>
        tx`select payload from jobs where tenant_id=${f.tenantId} and kind='marketing_message'`,
    );
    assert(!JSON.stringify([row, job]).includes(sent.to.slice(3)));
    assert.deepEqual(Object.keys(job.payload), ["messageId"]);
    // A wrong token, a wrong member and another restaurant's token all fail closed.
    const other = await makeTenant();
    await rejects(
      tenant(sql, f.tenantId, (tx) => confirmMarketing(tx, ana.id, sha("x"))),
      "unauthorized",
    );
    await rejects(
      tenant(sql, f.tenantId, (tx) =>
        confirmMarketing(tx, silent.id, sha(sent.token)),
      ),
      "unauthorized",
    );
    await rejects(
      tenant(sql, other.tenantId, (tx) =>
        confirmMarketing(tx, ana.id, sha(sent.token)),
      ),
      "unauthorized",
    );
    // The second daily pass does not ask again.
    assert.equal((await daily(f))!.confirmations, 0);
  });

  await test("M3 a changed phone, a withdrawn opt-in or a deletion voids the confirmation", async () => {
    const f = await makeTenant();
    await enable(f);
    const [a, b, c] = [await enroll(f), await enroll(f), await enroll(f)];
    await daily(f);
    for (const m of [a, b, c]) await confirm(f, m.id);
    assert.equal(
      (await run(f.owner, (tx) => getMarketing(tx, f.owner, SEND))).confirmed,
      3,
    );
    await run(f.owner, (tx) =>
      updateMember(tx, f.owner, a.id, {
        operationId: randomUUID(),
        expectedVersion: 1,
        marketingOptIn: false,
      }),
    );
    await run(f.owner, (tx) =>
      updateMember(tx, f.owner, b.id, {
        operationId: randomUUID(),
        expectedVersion: 1,
        phone: newPhone(),
        country: "MX",
      }),
    );
    await run(f.owner, (tx) =>
      deleteMember(tx, f.owner, c.id, {
        operationId: randomUUID(),
        expectedVersion: 1,
        confirm: "ELIMINAR",
      }),
    );
    const left = await asAdmin(
      f.tenantId,
      (tx) =>
        tx`select member_id from marketing_confirmations where tenant_id=${f.tenantId}`,
    );
    assert.equal(left.length, 0);
    assert.equal(
      (await run(f.owner, (tx) => getMarketing(tx, f.owner, SEND))).confirmed,
      0,
    );
    await assert.rejects(
      run(f.owner, (tx) => tx`delete from marketing_confirmations`),
    );
    await assert.rejects(
      run(
        f.owner,
        (tx) =>
          tx`update marketing_confirmations set phone_hash=${"a".repeat(64)}`,
      ),
    );
  });

  let shared: { f: Fixture; ana: { id: string }; campaignId: string };
  await test("M4 a campaign reaches only confirmed members, exactly once", async () => {
    const f = await makeTenant();
    await enable(f);
    const ana = await enroll(f),
      luis = await enroll(f, true, "Luis Pérez"),
      unconfirmed = await enroll(f);
    await visit(f, ana.id);
    await daily(f);
    await confirm(f, ana.id);
    await confirm(f, luis.id);
    const campaign = {
      id: randomUUID(),
      name: "Martes de tacos",
      channels: ["whatsapp", "sms"],
      body: "Hola {{name}}, este martes te esperamos en {{restaurant}}.",
      segment: {},
    };
    await rejects(
      run(f.cashier, (tx) =>
        saveCampaign(tx, f.cashier, {
          operationId: randomUUID(),
          expectedVersion: 0,
          campaign,
        }),
      ),
      "forbidden",
    );
    const saved = await run(f.owner, (tx) =>
      saveCampaign(tx, f.owner, {
        operationId: randomUUID(),
        expectedVersion: 0,
        campaign,
      }),
    );
    assert.equal(saved.state, "draft");
    const preview = await run(f.owner, (tx) =>
      previewAudience(tx, f.owner, { segment: { minVisits: 1 } }),
    );
    assert.deepEqual(preview, { matching: 1, reachable: 1 });
    const launch = {
      operationId: randomUUID(),
      campaignId: campaign.id,
      expectedVersion: 1,
    };
    await rejects(
      run(f.owner, (tx) => launchCampaign(tx, f.owner, launch, {})),
      "channel_not_configured",
    );
    const launched = await run(f.owner, (tx) =>
      launchCampaign(tx, f.owner, launch, SEND),
    );
    assert.deepEqual(launched, { state: "sending", audience: 2 });
    assert.deepEqual(
      await run(f.owner, (tx) => launchCampaign(tx, f.owner, launch, SEND)),
      launched,
    );
    const rows = (await messages(f)).filter((m: any) => m.kind === "campaign");
    assert.deepEqual(
      rows.map((m: any) => m.member_id).sort(),
      [ana.id, luis.id].sort(),
    );
    assert(rows.every((m: any) => m.channel === "sms" && m.state === "queued"));
    assert(!rows.some((m: any) => m.member_id === unconfirmed.id));
    await rejects(
      run(f.owner, (tx) =>
        saveCampaign(tx, f.owner, {
          operationId: randomUUID(),
          expectedVersion: 1,
          campaign,
        }),
      ),
      "campaign_locked",
    );
    shared = { f, ana, campaignId: campaign.id };
  });

  await test("M5 delivery rechecks consent, polls status and never repeats an unknown send", async () => {
    const { f, ana, campaignId } = shared;
    const rows = (await messages(f)).filter(
      (m: any) => m.campaign_id === campaignId,
    );
    const forAna = rows.find((m: any) => m.member_id === ana.id),
      forLuis = rows.find((m: any) => m.member_id !== ana.id);
    // Without the switch or credentials the job blocks and nothing is sent.
    const idle = provider(() => "throw");
    assert.equal(
      ((await deliver(f, forAna.id, idle.http, {})) as any).status,
      "blocked",
    );
    assert.equal(idle.calls.length, 0);
    const ok = provider((call) =>
      call.to
        ? json(201, { sid: "SM0001" })
        : json(200, { status: "delivered" }),
    );
    assert.equal(
      ((await deliver(f, forAna.id, ok.http)) as any).status,
      "retry",
    );
    assert.equal(
      ok.calls[0].body,
      "Hola Ana, este martes te esperamos en Taquería Campañas. Responde STOP para dejar de recibir mensajes.",
    );
    await deliver(f, forAna.id, ok.http);
    await deliver(f, forAna.id, ok.http);
    assert.equal(ok.calls.filter((c) => c.to).length, 1);
    const [done] = await run(
      f.owner,
      (tx) =>
        tx`select state,provider_id,sent_at from marketing_messages where id=${forAna.id}`,
    );
    assert.equal(done.state, "delivered");
    assert(done.sent_at && done.provider_id === "SM0001");
    // Luis withdraws before his message goes out.
    await run(f.owner, (tx) =>
      updateMember(tx, f.owner, forLuis.member_id, {
        operationId: randomUUID(),
        expectedVersion: 1,
        marketingOptIn: false,
      }),
    );
    const none = provider(() => "throw");
    await deliver(f, forLuis.id, none.http);
    assert.equal(none.calls.length, 0);
    const [skipped] = await run(
      f.owner,
      (tx) =>
        tx`select state,error_code from marketing_messages where id=${forLuis.id}`,
    );
    assert.deepEqual(
      [skipped.state, skipped.error_code],
      ["skipped", "consent_withdrawn"],
    );
    const [campaign] = await run(f.owner, (tx) => listCampaigns(tx, f.owner));
    assert.equal(campaign.state, "sent");
    assert.deepEqual(campaign.messages, {
      queued: 0,
      sent: 1,
      failed: 0,
      skipped: 1,
      unknown: 0,
    });
    // A lost answer and an HTTP 5xx are both unknown; a 4xx is a final failure.
    for (const [reply, state] of [
      ["throw", "unknown"],
      [() => json(503, {}), "unknown"],
      [() => json(400, { code: 21211 }), "failed"],
    ] as const) {
      const g = await makeTenant();
      await enable(g);
      const m = await enroll(g);
      await daily(g);
      await confirm(g, m.id);
      const c = {
        id: randomUUID(),
        name: "Prueba",
        channels: ["sms"],
        body: "Hola",
        segment: {},
      };
      await run(g.owner, (tx) =>
        saveCampaign(tx, g.owner, {
          operationId: randomUUID(),
          expectedVersion: 0,
          campaign: c,
        }),
      );
      await run(g.owner, (tx) =>
        launchCampaign(
          tx,
          g.owner,
          { operationId: randomUUID(), campaignId: c.id, expectedVersion: 1 },
          SEND,
        ),
      );
      const [msg] = (await messages(g)).filter(
        (x: any) => x.kind === "campaign",
      );
      const p = provider(typeof reply === "string" ? () => "throw" : reply);
      await deliver(g, msg.id, p.http);
      await deliver(g, msg.id, p.http);
      assert.equal(p.calls.length, 1);
      const [row] = await run(
        g.owner,
        (tx) => tx`select state from marketing_messages where id=${msg.id}`,
      );
      assert.equal(row.state, state);
    }
  });

  await test("M6 the daily pass fires on events in its window, once, under the frequency cap", async () => {
    const f = await makeTenant();
    await enable(f);
    const ana = await enroll(f),
      eva = await enroll(f, true, "Eva Ruiz");
    await daily(f);
    await confirm(f, ana.id);
    await confirm(f, eva.id);
    for (const key of ["follow_up", "drive_qr"] as const)
      await run(f.owner, (tx) =>
        saveAutomation(tx, f.owner, {
          operationId: randomUUID(),
          key,
          active: true,
          channels: ["sms"],
          body: `${key}: hola {{name}}`,
        }),
      );
    const listed = await run(f.owner, (tx) => listAutomations(tx, f.owner));
    assert.deepEqual(
      listed.filter((a) => a.active).map((a) => a.key),
      ["drive_qr", "follow_up"],
    );
    await visit(f, ana.id);
    const first = await daily(f);
    assert.equal(first!.queued, 1);
    const auto = async () =>
      (await messages(f)).filter((m: any) => m.kind === "automation");
    const [only] = await auto();
    assert.equal(only.member_id, ana.id);
    // drive_qr comes before follow_up, and one automated message is the limit.
    assert.match(only.dedupe_key, /^a:drive_qr:/);
    await visit(f, ana.id);
    assert.equal((await daily(f))!.queued, 0);
    assert.equal((await auto()).length, 1);
    // Same local day: the pass is fenced.
    assert.equal(
      await run(f.owner, (tx) =>
        runDaily(tx, f.tenantId, SEND, Date.now() + 2000),
      ),
      null,
    );
    // Switched off: nothing is evaluated.
    await enable(f, { enabled: false });
    await visit(f, eva.id);
    assert.equal(await daily(f), null);
    assert(!(await auto()).some((m: any) => m.member_id === eva.id));
  });

  await test("M7 scheduled campaigns start on time, cancel cleanly and stop when marketing is off", async () => {
    const f = await makeTenant();
    await enable(f);
    const ana = await enroll(f);
    await daily(f);
    await confirm(f, ana.id);
    const make = async (name: string) => {
      const c = {
        id: randomUUID(),
        name,
        channels: ["sms"],
        body: "Hola {{name}}",
        segment: {},
      };
      await run(f.owner, (tx) =>
        saveCampaign(tx, f.owner, {
          operationId: randomUUID(),
          expectedVersion: 0,
          campaign: c,
        }),
      );
      return c.id;
    };
    const schedule = (campaignId: string, at: Date) =>
      run(f.owner, (tx) =>
        launchCampaign(
          tx,
          f.owner,
          {
            operationId: randomUUID(),
            campaignId,
            expectedVersion: 1,
            scheduledAt: at.toISOString(),
          },
          SEND,
        ),
      );
    const a = await make("Programada");
    await rejects(schedule(a, new Date()), "invalid_schedule");
    assert.equal(
      (await schedule(a, new Date(Date.now() + 3600_000))).state,
      "scheduled",
    );
    const [job] = await asAdmin(
      f.tenantId,
      (tx) =>
        tx`select next_at>now() as later from jobs where tenant_id=${f.tenantId} and kind='marketing_launch'`,
    );
    assert.equal(job.later, true);
    // Not due yet: the job body does nothing.
    assert.equal(
      await run(f.owner, (tx) => launchScheduled(tx, f.tenantId, a, SEND)),
      null,
    );
    await asAdmin(
      f.tenantId,
      (tx) =>
        tx`update marketing_campaigns set scheduled_at=now()-interval '1 minute' where id=${a}`,
    );
    assert.equal(
      await run(f.owner, (tx) => launchScheduled(tx, f.tenantId, a, SEND)),
      1,
    );
    assert.equal(
      await run(f.owner, (tx) => launchScheduled(tx, f.tenantId, a, SEND)),
      null,
    );
    const b = await make("Cancelada");
    await schedule(b, new Date(Date.now() + 3600_000));
    const cancelled = await run(f.owner, (tx) =>
      cancelCampaign(tx, f.owner, { operationId: randomUUID(), campaignId: b }),
    );
    assert.equal(cancelled.state, "cancelled");
    assert.equal(
      await run(f.owner, (tx) => launchScheduled(tx, f.tenantId, b, SEND)),
      null,
    );
    const c = await make("Apagada");
    await schedule(c, new Date(Date.now() + 3600_000));
    await enable(f, { enabled: false });
    await asAdmin(
      f.tenantId,
      (tx) =>
        tx`update marketing_campaigns set scheduled_at=now()-interval '1 minute' where id=${c}`,
    );
    assert.equal(
      await run(f.owner, (tx) => launchScheduled(tx, f.tenantId, c, SEND)),
      null,
    );
    const d = await make("Sin permiso");
    await rejects(
      run(f.owner, (tx) =>
        launchCampaign(
          tx,
          f.owner,
          { operationId: randomUUID(), campaignId: d, expectedVersion: 1 },
          SEND,
        ),
      ),
      "marketing_disabled",
    );
    const states = Object.fromEntries(
      (await run(f.owner, (tx) => listCampaigns(tx, f.owner))).map((x) => [
        x.name,
        x.state,
      ]),
    );
    assert.deepEqual(states, {
      Programada: "sending",
      Cancelada: "cancelled",
      Apagada: "cancelled",
      "Sin permiso": "draft",
    });
  });

  await test("M8 an order after a sent message is attributed once; earlier orders are not", async () => {
    const { f, ana } = shared;
    const before = await run(f.owner, (tx) => performance(tx, f.owner, {}));
    assert.equal(before.attributedOrders, 0);
    assert.equal(before.sent, 1);
    const order = await visit(f, ana.id);
    const after = await run(f.owner, (tx) => performance(tx, f.owner, {}));
    assert.equal(after.estimate, true);
    assert.equal(after.attributedOrders, 1);
    assert.equal(after.attributedSales, order.total);
    assert.equal(after.byCampaign[0].orders, 1);
    assert.equal(after.byOrderSource[0].label, "pos");
    assert.equal(
      after.byDay.reduce((a, d) => a + d.sales, 0),
      after.attributedSales,
    );
    await rejects(
      run(f.cashier, (tx) => performance(tx, f.cashier, {})),
      "forbidden",
    );
    const stats = (await run(f.owner, (tx) => memberStats(tx))).find(
      (m) => m.id === ana.id,
    )!;
    assert.equal(stats.visits, 2);
    assert(!("phone" in stats) && !("name" in stats));
  });

  await test("M9 tenants are isolated and the jobs login keeps its narrow grants", async () => {
    const { f, ana } = shared;
    const other = await makeTenant();
    assert.equal((await messages(other)).length, 0);
    assert.equal(
      (await run(other.owner, (tx) => listCampaigns(tx, other.owner))).length,
      0,
    );
    const [theirs] = await messages(f, ana.id);
    const none = provider(() => "throw");
    await deliver(other, theirs.id, none.http);
    assert.equal(none.calls.length, 0);
    const worker = <T>(fn: (tx: Tx) => Promise<T>) =>
      tenant(workerSql, f.tenantId, fn);
    await assert.rejects(
      worker(
        (tx) =>
          tx`insert into marketing_campaigns(tenant_id,id,kind,name,channels,body,state,created_by) values(${f.tenantId},${randomUUID()},'one_off','x','{sms}','x','draft',${f.owner.employeeId})`,
      ),
    );
    await assert.rejects(
      worker((tx) => tx`update marketing_confirmations set confirmed_at=now()`),
    );
    await assert.rejects(
      worker((tx) => tx`update marketing_settings set version=version+1`),
    );
    await assert.rejects(worker((tx) => tx`delete from marketing_messages`));
    await assert.rejects(
      run(f.owner, (tx) => tx`delete from marketing_messages`),
    );
    await assert.rejects(
      run(f.owner, (tx) => tx`update marketing_messages set provider_id='x'`),
    );
    await assert.rejects(
      run(f.owner, (tx) => tx`update marketing_runs set queued=0`),
    );
    assert.equal((await workerSql`select 1 from marketing_messages`).length, 0);
  });
  await test("M10 only the sent token confirms: no login can write confirmed_at or read the digest", async () => {
    const f = await makeTenant();
    await enable(f);
    const ana = await enroll(f),
      eva = await enroll(f, true, "Eva Ruiz");
    await daily(f);
    const worker = <T>(fn: (tx: Tx) => Promise<T>) =>
      tenant(workerSql, f.tenantId, fn);
    // The runtime role: no direct confirmation, no pre-confirmed row, no digest to replay.
    await assert.rejects(
      run(
        f.owner,
        (tx) =>
          tx`update marketing_confirmations set confirmed_at=now() where member_id=${ana.id}`,
      ),
    );
    await assert.rejects(
      run(f.owner, (tx) => tx`select token_hash from marketing_confirmations`),
    );
    await assert.rejects(
      run(f.owner, (tx) => tx`select * from marketing_confirmations`),
    );
    await assert.rejects(
      run(
        f.owner,
        (tx) =>
          tx`update marketing_confirmations set token_hash=${"a".repeat(64)}`,
      ),
    );
    const late = await enroll(f, true, "Leo Díaz");
    await assert.rejects(
      run(
        f.owner,
        (tx) =>
          tx`insert into marketing_confirmations(tenant_id,member_id,phone_hash,confirmed_at) values(${f.tenantId},${late.id},${"b".repeat(64)},now())`,
      ),
    );
    // Even the table owner cannot create a confirmed row or rewrite a confirmed one.
    await assert.rejects(
      asAdmin(
        f.tenantId,
        (tx) =>
          tx`insert into marketing_confirmations(tenant_id,member_id,phone_hash,confirmed_at) values(${f.tenantId},${late.id},${"b".repeat(64)},now())`,
      ),
      /must start unconfirmed/,
    );
    const [fn] = await run(
      f.owner,
      (tx) =>
        tx`select marketing_confirm(${ana.id}::uuid,${"c".repeat(64)}) as ok`,
    );
    assert.equal(fn.ok, false);
    assert.equal(
      (await run(f.owner, (tx) => getMarketing(tx, f.owner, SEND))).confirmed,
      0,
    );
    // The jobs login cannot confirm, and cannot re-challenge a phone once it is confirmed.
    await assert.rejects(
      worker(
        (tx) =>
          tx`update marketing_confirmations set confirmed_at=now() where member_id=${ana.id}`,
      ),
    );
    await assert.rejects(
      worker(
        (tx) => tx`select marketing_confirm(${ana.id}::uuid,${"c".repeat(64)})`,
      ),
    );
    await confirm(f, ana.id);
    await assert.rejects(
      worker(
        (tx) =>
          tx`update marketing_confirmations set token_hash=${"d".repeat(64)},requested_at=clock_timestamp() where member_id=${ana.id}`,
      ),
      /confirmed phone is immutable/,
    );
    await assert.rejects(
      asAdmin(
        f.tenantId,
        (tx) =>
          tx`update marketing_confirmations set phone_hash=${"e".repeat(64)} where tenant_id=${f.tenantId} and member_id=${eva.id}`,
      ),
      /identity is immutable/,
    );
    assert.equal(
      (await run(f.owner, (tx) => getMarketing(tx, f.owner, SEND))).confirmed,
      1,
    );
  });

  await test("M11 a message only moves forward: an unknown or sent one can never be queued again", async () => {
    const f = await makeTenant();
    await enable(f);
    const ana = await enroll(f),
      eva = await enroll(f, true, "Eva Ruiz");
    await daily(f);
    await confirm(f, ana.id);
    await confirm(f, eva.id);
    const c = {
      id: randomUUID(),
      name: "Prueba",
      channels: ["sms"],
      body: "Hola",
      segment: {},
    };
    await run(f.owner, (tx) =>
      saveCampaign(tx, f.owner, {
        operationId: randomUUID(),
        expectedVersion: 0,
        campaign: c,
      }),
    );
    await run(f.owner, (tx) =>
      launchCampaign(
        tx,
        f.owner,
        { operationId: randomUUID(), campaignId: c.id, expectedVersion: 1 },
        SEND,
      ),
    );
    const rows = (await messages(f)).filter((m: any) => m.kind === "campaign");
    const lost = rows.find((m: any) => m.member_id === ana.id),
      good = rows.find((m: any) => m.member_id === eva.id);
    await deliver(f, lost.id, provider(() => "throw").http);
    await deliver(
      f,
      good.id,
      provider(() => json(201, { sid: "SM0002" })).http,
    );
    const worker = <T>(fn: (tx: Tx) => Promise<T>) =>
      tenant(workerSql, f.tenantId, fn);
    for (const as of [(fn: any) => run(f.owner, fn), worker])
      for (const state of ["queued", "sending", "sent"])
        await assert.rejects(
          as(
            (tx: Tx) =>
              tx`update marketing_messages set state=${state} where id=${lost.id}`,
          ),
          /finished marketing message is immutable|cannot go from/,
        );
    await assert.rejects(
      worker(
        (tx) =>
          tx`update marketing_messages set state='queued' where id=${good.id}`,
      ),
      /cannot go from sent to queued/,
    );
    await assert.rejects(
      worker(
        (tx) =>
          tx`update marketing_messages set provider_id=null where id=${good.id}`,
      ),
      /written once/,
    );
    await assert.rejects(
      worker(
        (tx) =>
          tx`update marketing_messages set provider_id='SM9999' where id=${good.id}`,
      ),
      /written once/,
    );
    await assert.rejects(
      worker(
        (tx) =>
          tx`update marketing_messages set sent_at=now() where id=${good.id}`,
      ),
      /written once/,
    );
    // Requeueing the job of the unknown message sends nothing.
    const again = provider(() => json(201, { sid: "SM0003" }));
    await deliver(f, lost.id, again.http);
    assert.equal(again.calls.length, 0);
    const states = Object.fromEntries(
      (await messages(f))
        .filter((m: any) => m.kind === "campaign")
        .map((m: any) => [m.member_id, m.state]),
    );
    assert.deepEqual(states, { [ana.id]: "unknown", [eva.id]: "sent" });
  });

  await test("M12 a renewed opt-in or an expired request gets a fresh confirmation, three at most", async () => {
    const f = await makeTenant();
    await enable(f);
    const ana = await enroll(f),
      eva = await enroll(f, true, "Eva Ruiz");
    await daily(f);
    await confirm(f, ana.id);
    const asked = async (memberId: string) =>
      (await messages(f, memberId)).filter(
        (m: any) => m.kind === "confirmation",
      ).length;
    // Ana withdraws and opts back in with the same phone: she is asked again and can confirm.
    for (const [version, marketingOptIn] of [
      [1, false],
      [2, true],
    ] as const)
      await run(f.owner, (tx) =>
        updateMember(tx, f.owner, ana.id, {
          operationId: randomUUID(),
          expectedVersion: version,
          marketingOptIn,
        }),
      );
    assert.equal((await daily(f))!.confirmations, 1);
    assert.equal(await asked(ana.id), 2);
    const [second] = (await messages(f, ana.id)).filter(
      (m: any) => m.kind === "confirmation" && m.state === "queued",
    );
    const p = provider(() => json(201, { sid: "SM0004" }));
    await deliver(f, second.id, p.http);
    const token = /confirm#(\S+)/.exec(p.calls[0].body!)![1];
    await tenant(sql, f.tenantId, (tx) =>
      confirmMarketing(tx, ana.id, sha(token)),
    );
    assert.equal(
      (await run(f.owner, (tx) => getMarketing(tx, f.owner, SEND))).confirmed,
      1,
    );
    // Eva never answered: nothing while her request is fresh, a new one once it expired,
    // and never more than three.
    assert.equal((await daily(f))!.confirmations, 0);
    const expire = () =>
      asAdmin(
        f.tenantId,
        (tx) =>
          tx`update marketing_confirmations set requested_at=now()-interval '31 days' where tenant_id=${f.tenantId} and member_id=${eva.id}`,
      );
    await expire();
    assert.equal((await daily(f))!.confirmations, 1);
    await expire();
    assert.equal((await daily(f))!.confirmations, 1);
    await expire();
    assert.equal((await daily(f))!.confirmations, 0);
    assert.equal(await asked(eva.id), 3);
    // An expired link no longer confirms.
    const [first] = (await messages(f, eva.id)).filter(
      (m: any) => m.kind === "confirmation",
    );
    const q = provider(() => json(201, { sid: "SM0005" }));
    await deliver(f, first.id, q.http);
    const old = /confirm#(\S+)/.exec(q.calls[0].body!)![1];
    await expire();
    await rejects(
      tenant(sql, f.tenantId, (tx) => confirmMarketing(tx, eva.id, sha(old))),
      "unauthorized",
    );
  });

  await test("M13 re-enabling restarts the daily chain, and a withdrawal waits for a send being prepared", async () => {
    const f = await makeTenant();
    await enable(f);
    const jobs = () =>
      asAdmin(
        f.tenantId,
        (tx) =>
          tx`select dedupe_key,state from jobs where tenant_id=${f.tenantId} and kind='marketing_daily' order by created_at`,
      );
    assert.equal((await jobs()).length, 1);
    // Today's job ran while marketing was off, so it scheduled nothing.
    await enable(f, { enabled: false });
    await asAdmin(
      f.tenantId,
      (tx) =>
        tx`update jobs set state='done' where tenant_id=${f.tenantId} and kind='marketing_daily'`,
    );
    await enable(f);
    const after = await jobs();
    assert.equal(after.length, 2);
    assert.equal(after[1].state, "available");
    assert.notEqual(after[1].dedupe_key, after[0].dedupe_key);
    // While the worker holds the confirmation it is sending against, removing consent
    // cannot commit; it completes as soon as the worker's transaction ends.
    const ana = await enroll(f);
    await daily(f);
    await confirm(f, ana.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const workerTx = tenant(workerSql, f.tenantId, async (tx) => {
      await tx`select phone_hash from marketing_confirmations where member_id=${ana.id} for update`;
      locked();
      await held;
    });
    await ready;
    let withdrawn = false;
    const withdrawal = run(f.owner, (tx) =>
      updateMember(tx, f.owner, ana.id, {
        operationId: randomUUID(),
        expectedVersion: 1,
        marketingOptIn: false,
      }),
    ).then(() => (withdrawn = true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(withdrawn, false);
    release();
    await workerTx;
    await withdrawal;
    assert.equal(withdrawn, true);
    assert.equal(
      (await run(f.owner, (tx) => getMarketing(tx, f.owner, SEND))).confirmed,
      0,
    );
  });
  console.log(`${checks} marketing checks passed`);
} finally {
  await sql.end();
  await admin.end();
  await workerSql.end();
}
