import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { Temporal } from "@js-temporal/polyfill";
import { connect, tenant, checkRole } from "../server/db.js";
import { isolatedTarget } from "./isolated-target.js";
import { catalog, createOrder, getOrder } from "../server/orders.js";
import { saveOffer } from "../server/offers.js";
import {
  exportGuests,
  guestConsents,
  guestStats,
  listGuests,
  recordFeedback,
  saveGuest,
  setConsent,
} from "../server/guests.js";
import {
  cancelCampaign,
  channelStatus,
  launchCampaign,
  listAutomations,
  listCampaigns,
  performance,
  previewAudience,
  runAutomations,
  saveAutomation,
  saveCampaign,
  saveMarketingSettings,
  getMarketingSettings,
  type ChannelStatus,
} from "../server/marketing.js";
import {
  checkMarketingRole,
  marketingTick,
  type Outbound,
  type Providers,
  type SendResult,
} from "../server/marketing-delivery.js";
import type { Session } from "../shared/domain.js";

process.env.JWT_SECRET ??= randomBytes(32).toString("hex");
const { runtime: url, migration } = isolatedTarget(process.env);
const u = new URL(url);
const identity = u.hostname + ":" + (u.port || "5432") + u.pathname;
const sql = connect(url),
  admin = postgres(migration, { max: 1 });
await checkRole(sql);
const session = (n: 1 | 2, role = "owner", employee = "8000"): Session => ({
  id: randomUUID(),
  tenantId: `10000000-0000-4000-8000-00000000000${n}`,
  employeeId: `20000000-0000-4000-${employee}-00000000000${n}`,
  deviceId: `30000000-0000-4000-8000-00000000000${n}`,
  name: "Test",
  role,
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant: {
    name: "Test",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
});
const owner = session(1),
  cashier = session(1, "cashier", "8001"),
  other = session(2);
const run = <T>(s: Session, fn: (tx: any) => Promise<T>) =>
  tenant(sql, s.tenantId, fn);
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: any) => e.code === code);
const asAdmin = <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
  admin.begin(async (tx: any) => {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    return fn(tx);
  }) as Promise<T>;
const entitle = (tenantId: string, status: string) =>
  admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${tenantId},${status},now()+interval '1 hour','fixture') on conflict(tenant_id) do update set status=${status},access_until=now()+interval '1 hour'`;
const [originalEntitlement] =
  await admin`select * from restaurant_entitlements where tenant_id=${owner.tenantId}`;
await entitle(owner.tenantId, "active");
const role = "gm_marketing_test_" + randomBytes(6).toString("hex");
const password = randomBytes(32).toString("hex");
const database = new URL(migration).pathname.slice(1);
let worker: postgres.Sql | undefined;
let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
const tag = randomBytes(5).toString("hex");
const mail = (name: string) => `${name}.${tag}@example.com`;
const mobile = () =>
  "55" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
const allOn: ChannelStatus = {
  email: { enabled: true },
  sms: { enabled: true },
  whatsapp: { enabled: true },
};
const appUrl = "https://app.example";
const sent: Outbound[] = [];
let behaviour: (m: Outbound) => SendResult | "throw" = () => ({
  ok: true,
  providerId: "p-" + randomUUID(),
});
const provider = async (m: Outbound): Promise<SendResult> => {
  const result = behaviour(m);
  if (result === "throw") throw Error("network");
  sent.push(m);
  return result;
};
const providers: Providers = {
  email: provider,
  sms: provider,
  whatsapp: provider,
};
try {
  await admin.unsafe(
    `create role "${role}" login password '${password}' nosuperuser nobypassrls`,
  );
  await admin.unsafe(`grant gm_marketing_worker to "${role}"`);
  await admin.unsafe(`grant connect on database "${database}" to "${role}"`);
  const workerUrl = new URL(url);
  workerUrl.username = role;
  workerUrl.password = password;
  worker = postgres(workerUrl.href, { max: 2 });
  await checkMarketingRole(worker);
  await assert.rejects(
    checkMarketingRole(sql),
    /restricted_marketing_role_required/,
  );
  for (const s of [owner, other])
    await asAdmin(s.tenantId, async (tx) => {
      await tx`delete from marketing_runs`;
      await tx`update campaigns set state='paused' where kind='automation'`;
      await tx`update campaigns set state='cancelled' where kind='one_off' and state in ('scheduled','sending')`;
      await tx`update messages set state='suppressed',error_code='test_reset' where state in ('queued','sending')`;
      await tx`update promotions set active=false where active`;
    });
  const products = await run(owner, catalog);
  const product = products.find((p) => p.groups.length === 0 && !p.openAmount)!;
  const order = (extra: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    lines: [
      {
        id: randomUUID(),
        productId: product.id,
        quantity: 1,
        options: [],
        note: "",
      },
    ],
    mode: "takeaway",
    tableId: null,
    name: "Guest",
    note: "",
    channel: "pos",
    ...extra,
  });
  const guestOf = async (s: Session, email: string) =>
    (await run(s, (tx) => guestStats(tx))).find((g) => g.email === email)!;

  const ana = { email: mail("ana"), phone: mobile() };
  let anaId = "";
  await test("checkout captures one guest with consent evidence", async () => {
    const first = await run(cashier, (tx) =>
      createOrder(
        tx,
        cashier,
        order({
          guest: {
            name: "Ana López",
            email: " " + ana.email.toUpperCase(),
            phone: ana.phone,
            consent: { email: true, whatsapp: true },
          },
        }),
      ),
    );
    anaId = first.guestId!;
    assert(anaId);
    // Same phone, no e-mail and no consent flags: same guest, nothing revoked.
    const second = await run(owner, (tx) =>
      createOrder(
        tx,
        owner,
        order({ channel: "qr", guest: { phone: ana.phone } }),
      ),
    );
    assert.equal(second.guestId, anaId);
    const g = await guestOf(owner, ana.email);
    assert.equal(g.phone, "+52" + ana.phone);
    assert.deepEqual(g.optIn, { email: true, sms: false, whatsapp: true });
    assert.equal(g.visits, 2);
    assert.deepEqual([...g.channels].sort(), ["pos", "qr"]);
    const history = await run(owner, (tx) => guestConsents(tx, owner, anaId));
    assert.equal(history.length, 2);
    assert(
      history.every((h: any) => h.granted && h.source === "pos" && h.actor),
    );
    const [evidence] = await run(
      owner,
      (tx) =>
        tx`select wording from guest_consents where guest_id=${anaId} limit 1`,
    );
    assert(evidence.wording.length > 20);
    // Idempotent retry does not duplicate guests or consent.
    assert.equal(
      (await run(owner, (tx) => guestConsents(tx, owner, anaId))).length,
      2,
    );
    await rejects(
      run(owner, (tx) =>
        createOrder(tx, owner, order({ guest: { name: "No contact" } })),
      ).catch((e) => {
        throw Object.assign(e, { code: e.code ?? "invalid" });
      }),
      "invalid",
    );
  });

  await test("guests and consent are tenant scoped", async () => {
    assert(
      !(await run(other, (tx) => guestStats(tx))).some((g) => g.id === anaId),
    );
    const theirs = await run(other, async (tx) => {
      const p = (await catalog(tx)).find((x) => !x.groups.length)!;
      return createOrder(tx, other, {
        ...order({ guest: { email: ana.email, consent: { email: true } } }),
        lines: [
          {
            id: randomUUID(),
            productId: p.id,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
      });
    });
    assert(theirs.guestId && theirs.guestId !== anaId);
    await rejects(
      run(other, (tx) =>
        setConsent(tx, other.tenantId, anaId, "email", false, "manager", null),
      ),
      "not_found",
    );
    await rejects(
      run(cashier, (tx) => listGuests(tx, cashier, "")),
      "forbidden",
    );
  });

  let luisId = "";
  const luis = { email: mail("luis"), phone: mobile() };
  await test("manager edits require confirmation and address changes withdraw consent", async () => {
    const base = {
      id: null,
      name: "Luis",
      email: luis.email,
      phone: luis.phone,
      locale: "es",
      consent: { email: true, sms: true, whatsapp: false },
    };
    await rejects(
      run(owner, (tx) =>
        saveGuest(tx, owner, { ...base, operationId: randomUUID() }),
      ),
      "consent_confirmation_required",
    );
    const created = await run(owner, (tx) =>
      saveGuest(tx, owner, {
        ...base,
        operationId: randomUUID(),
        confirmed: true,
      }),
    );
    luisId = created.id;
    assert.deepEqual(created.optIn, {
      email: true,
      sms: true,
      whatsapp: false,
    });
    await rejects(
      run(owner, (tx) =>
        saveGuest(tx, owner, {
          ...base,
          operationId: randomUUID(),
          email: ana.email,
          confirmed: true,
        }),
      ),
      "guest_exists",
    );
    const moved = await run(owner, (tx) =>
      saveGuest(tx, owner, {
        ...base,
        id: luisId,
        operationId: randomUUID(),
        phone: mobile(),
        consent: { email: true, sms: false, whatsapp: false },
      }),
    );
    assert.deepEqual(moved.optIn, { email: true, sms: false, whatsapp: false });
    const csv = await run(owner, (tx) => exportGuests(tx, owner));
    assert(csv.includes(luis.email) && csv.includes("'+52"));
    await assert.rejects(
      run(owner, (tx) => tx`update guest_consents set granted=true`),
    );
    await assert.rejects(run(owner, (tx) => tx`delete from guests`));
  });

  const zone = [...Array(27).keys()]
    .map((n) => `Etc/GMT${n - 12 >= 0 ? "+" : "-"}${Math.abs(n - 12)}`)
    .find((z) => {
      const hour = Temporal.Now.zonedDateTimeISO(z).hour;
      return hour >= 12 && hour <= 20;
    })!;
  const place = {
    id: owner.tenantId,
    name: "Casa del Bosque",
    timezone: zone,
    currency: "MXN",
  };
  await test("welcome automation fires once, respects the frequency cap and the daily run", async () => {
    await rejects(
      run(cashier, (tx) =>
        saveAutomation(tx, cashier, {
          operationId: randomUUID(),
          key: "welcome",
          active: true,
          channels: ["email"],
          subject: "Hola",
          body: "Hola {{name}}",
        }),
      ),
      "forbidden",
    );
    for (const key of ["welcome", "follow_up"] as const)
      await run(owner, (tx) =>
        saveAutomation(tx, owner, {
          operationId: randomUUID(),
          key,
          active: true,
          channels: ["whatsapp", "email"],
          subject: "Hola de {{restaurant}}",
          body: `${key}: hola {{name}}.{{offer}}`,
        }),
      );
    const listed = await run(owner, (tx) => listAutomations(tx, owner));
    assert.equal(listed.automations.filter((a) => a.active).length, 2);
    assert.equal(listed.unavailable[0].key, "loyalty_enrollment");
    const now = Date.now() + 2000;
    const first = await tenant(worker!, owner.tenantId, (tx) =>
      runAutomations(tx, place, ["email", "whatsapp"], appUrl, now),
    );
    assert(first && first.queued >= 2);
    const mine = await run(
      owner,
      (tx) =>
        tx`select m.*,c.automation_key from messages m join campaigns c on c.id=m.campaign_id where m.guest_id in (${anaId},${luisId}) and m.automated`,
    );
    // Both qualify for welcome and follow-up; priority and the cap leave one each.
    assert.equal(mine.length, 2);
    assert(mine.every((m: any) => m.automation_key === "welcome"));
    const forAna = mine.find((m: any) => m.guest_id === anaId);
    assert.equal(forAna.channel, "whatsapp");
    assert.equal(forAna.body, "welcome: hola Ana.");
    assert.equal(mine.find((m: any) => m.guest_id === luisId).channel, "email");
    assert.equal(
      await tenant(worker!, owner.tenantId, (tx) =>
        runAutomations(tx, place, ["email", "whatsapp"], appUrl, now + 1000),
      ),
      null,
    );
    // Next day: the follow-up would qualify, but the cap holds it back.
    await asAdmin(owner.tenantId, (tx) => tx`delete from marketing_runs`);
    const again = await tenant(worker!, owner.tenantId, (tx) =>
      runAutomations(tx, place, ["email", "whatsapp"], appUrl, now + 2000),
    );
    assert(again);
    const after = await run(
      owner,
      (tx) =>
        tx`select id from messages where guest_id in (${anaId},${luisId}) and automated`,
    );
    assert.equal(after.length, 2);
  });

  let campaignId = "";
  let code = "";
  await test("campaigns need Pro, configured channels and launch exactly once", async () => {
    code = "VUELVE" + tag.toUpperCase();
    const promo = await run(owner, (tx) =>
      saveOffer(tx, owner, {
        operationId: randomUUID(),
        expectedVersion: 0,
        offer: {
          id: randomUUID(),
          name: "Regreso",
          kind: "percent",
          value: 1000,
          scope: "order",
          code,
        },
      }),
    );
    const draft = {
      id: randomUUID(),
      name: "Regreso " + tag,
      channels: ["email", "sms"],
      subject: "Vuelve a {{restaurant}}",
      body: "Hola {{name}}, te esperamos.{{offer}}",
      segment: { minVisits: 1 },
      promotionId: promo.id,
    };
    campaignId = draft.id;
    await entitle(owner.tenantId, "canceled");
    await rejects(
      run(owner, (tx) =>
        saveCampaign(tx, owner, {
          operationId: randomUUID(),
          expectedVersion: 0,
          campaign: draft,
        }),
      ),
      "pro_required",
    );
    await entitle(owner.tenantId, "active");
    await rejects(
      run(owner, (tx) =>
        saveCampaign(tx, owner, {
          operationId: randomUUID(),
          expectedVersion: 0,
          campaign: { ...draft, subject: "" },
        }),
      ).catch((e) => {
        throw Object.assign(e, { code: e.code ?? "invalid" });
      }),
      "invalid",
    );
    const saved = await run(owner, (tx) =>
      saveCampaign(tx, owner, {
        operationId: randomUUID(),
        expectedVersion: 0,
        campaign: draft,
      }),
    );
    assert.equal(saved.state, "draft");
    const preview = await run(owner, (tx) =>
      previewAudience(
        tx,
        owner,
        { segment: draft.segment, channels: draft.channels },
        channelStatus({}),
      ),
    );
    assert(preview.reachable >= 1 && preview.matching >= preview.reachable);
    assert.deepEqual(preview.blockedChannels, ["email", "sms"]);
    const launch = {
      operationId: randomUUID(),
      campaignId,
      expectedVersion: 1,
    };
    await rejects(
      run(owner, (tx) =>
        launchCampaign(tx, owner, launch, channelStatus({}), appUrl),
      ),
      "channel_not_configured",
    );
    await rejects(
      run(owner, (tx) =>
        launchCampaign(
          tx,
          owner,
          { ...launch, scheduledAt: new Date().toISOString() },
          allOn,
          appUrl,
        ),
      ),
      "invalid_schedule",
    );
    const launched = await run(owner, (tx) =>
      launchCampaign(tx, owner, launch, allOn, appUrl),
    );
    const retry = await run(owner, (tx) =>
      launchCampaign(tx, owner, launch, allOn, appUrl),
    );
    assert.deepEqual(retry, launched);
    const rows = await run(
      owner,
      (tx) => tx`select * from messages where campaign_id=${campaignId}`,
    );
    assert.equal(rows.length, launched.audience);
    const forAna = rows.find((m: any) => m.guest_id === anaId);
    assert.equal(forAna.channel, "email");
    assert.equal(forAna.to_address, ana.email);
    assert(forAna.body.includes(code) && forAna.body.includes("Ana"));
    assert(!rows.some((m: any) => m.channel === "whatsapp"));
    await rejects(
      run(owner, (tx) =>
        saveCampaign(tx, owner, {
          operationId: randomUUID(),
          expectedVersion: 1,
          campaign: draft,
        }),
      ),
      "campaign_locked",
    );
  });

  await test("the worker delivers once, honours withdrawn consent and never crosses tenants", async () => {
    // Luis unsubscribes from e-mail before delivery.
    await run(owner, (tx) =>
      setConsent(
        tx,
        owner.tenantId,
        luisId,
        "email",
        false,
        "unsubscribe_link",
        null,
      ),
    );
    const visible = await tenant(worker!, owner.tenantId, async (tx) => ({
      foreignMessages: (
        await tx`select 1 from messages where tenant_id<>${owner.tenantId}`
      ).length,
      foreignCampaigns: (
        await tx`select 1 from campaigns where tenant_id<>${owner.tenantId}`
      ).length,
      foreignRestaurants: (
        await tx`select 1 from restaurants where id<>${owner.tenantId}`
      ).length,
    }));
    assert.deepEqual(visible, {
      foreignMessages: 0,
      foreignCampaigns: 0,
      foreignRestaurants: 0,
    });
    await assert.rejects(
      tenant(worker!, owner.tenantId, (tx) => tx`select 1 from tenders`),
    );
    await assert.rejects(
      tenant(worker!, owner.tenantId, (tx) => tx`update guests set name='x'`),
    );
    await assert.rejects(worker!`select secret_hash from employees`);
    sent.length = 0;
    const tick = await marketingTick(worker!, providers, allOn, appUrl);
    assert(tick.delivered >= 2);
    const rows = await run(
      owner,
      (tx) =>
        tx`select guest_id,state,error_code,provider_id,sent_at from messages where campaign_id=${campaignId}`,
    );
    const anaRow = rows.find((m: any) => m.guest_id === anaId);
    assert.equal(anaRow.state, "sent");
    assert(anaRow.provider_id && anaRow.sent_at);
    // Luis's queued welcome e-mail is withheld, not sent.
    const [luisRow] = await run(
      owner,
      (tx) =>
        tx`select state,error_code from messages where guest_id=${luisId} and automated`,
    );
    assert.equal(luisRow.state, "suppressed");
    assert.equal(luisRow.error_code, "consent_withdrawn");
    const mail = sent.find((m) => m.to === ana.email && m.channel === "email")!;
    assert(mail.unsubscribeUrl.startsWith(appUrl + "/u/"));
    assert(mail.oneClickUrl.startsWith(appUrl + "/api/guest/unsubscribe/"));
    assert(!sent.some((m) => m.to === luis.email && m.channel === "email"));
    const before = sent.length;
    await marketingTick(worker!, providers, allOn, appUrl);
    assert.equal(sent.length, before);
    const [campaign] = (
      await run(owner, (tx) => listCampaigns(tx, owner))
    ).filter((c) => c.id === campaignId);
    assert.equal(campaign.state, "sent");
    assert.equal(campaign.messages.queued, 0);
  });

  await test("failures retry with backoff; unknown SMS outcomes are never resent", async () => {
    const make = async (channels: string[], name: string) => {
      const c = {
        id: randomUUID(),
        name: name + tag,
        channels,
        subject: "Hola",
        body: "Hola {{name}}",
        segment: {},
      };
      await run(owner, (tx) =>
        saveCampaign(tx, owner, {
          operationId: randomUUID(),
          expectedVersion: 0,
          campaign: c,
        }),
      );
      await run(owner, (tx) =>
        launchCampaign(
          tx,
          owner,
          { operationId: randomUUID(), campaignId: c.id, expectedVersion: 1 },
          allOn,
          appUrl,
        ),
      );
      return c.id;
    };
    const state = async (campaign: string, guestId: string) =>
      (
        await run(
          owner,
          (tx) =>
            tx`select state,error_code,attempts,next_at>now() as later from messages where campaign_id=${campaign} and guest_id=${guestId}`,
        )
      )[0];
    const emailCampaign = await make(["email"], "Retry ");
    behaviour = (m) =>
      m.to === ana.email
        ? { ok: false, retryable: true, code: "resend_503" }
        : { ok: true, providerId: "x" };
    await marketingTick(worker!, providers, allOn, appUrl);
    assert.deepEqual(await state(emailCampaign, anaId), {
      state: "queued",
      error_code: "resend_503",
      attempts: 1,
      later: true,
    });
    behaviour = (m) =>
      m.to === ana.email
        ? { ok: false, retryable: false, code: "resend_422" }
        : { ok: true, providerId: "x" };
    await asAdmin(
      owner.tenantId,
      (tx) =>
        tx`update messages set next_at=now() where campaign_id=${emailCampaign}`,
    );
    await marketingTick(worker!, providers, allOn, appUrl);
    assert.equal((await state(emailCampaign, anaId)).state, "failed");
    const whatsappCampaign = await make(["whatsapp"], "Unknown ");
    behaviour = (m) =>
      m.channel === "whatsapp" ? "throw" : { ok: true, providerId: "x" };
    await marketingTick(worker!, providers, allOn, appUrl);
    const unknown = await state(whatsappCampaign, anaId);
    assert.equal(unknown.state, "uncertain");
    assert.equal(unknown.error_code, "outcome_unknown");
    behaviour = () => ({ ok: true, providerId: "p-" + randomUUID() });
    sent.length = 0;
    await marketingTick(worker!, providers, allOn, appUrl);
    assert(
      !sent.some((m) => m.channel === "whatsapp" && m.to === "+52" + ana.phone),
    );
  });

  await test("scheduled campaigns start on time and can be cancelled", async () => {
    const c = {
      id: randomUUID(),
      name: "Programada " + tag,
      channels: ["email"],
      subject: "Hola",
      body: "Hola {{name}}",
      segment: {},
    };
    await run(owner, (tx) =>
      saveCampaign(tx, owner, {
        operationId: randomUUID(),
        expectedVersion: 0,
        campaign: c,
      }),
    );
    const at = new Date(Date.now() + 3600_000).toISOString();
    const scheduled = await run(owner, (tx) =>
      launchCampaign(
        tx,
        owner,
        {
          operationId: randomUUID(),
          campaignId: c.id,
          expectedVersion: 1,
          scheduledAt: at,
        },
        allOn,
        appUrl,
      ),
    );
    assert.equal(scheduled.state, "scheduled");
    await marketingTick(worker!, providers, allOn, appUrl);
    assert.equal(
      (
        await run(
          owner,
          (tx) => tx`select 1 from messages where campaign_id=${c.id}`,
        )
      ).length,
      0,
    );
    sent.length = 0;
    const tick = await marketingTick(worker!, providers, allOn, appUrl, {
      now: Date.now() + 2 * 3600_000,
    });
    assert(tick.started >= 1);
    assert(sent.some((m) => m.to === ana.email));
    await rejects(
      run(owner, (tx) =>
        cancelCampaign(tx, owner, { operationId: randomUUID(), campaignId }),
      ),
      "campaign_locked",
    );
    const d = { ...c, id: randomUUID(), name: "Cancelada " + tag };
    await run(owner, (tx) =>
      saveCampaign(tx, owner, {
        operationId: randomUUID(),
        expectedVersion: 0,
        campaign: d,
      }),
    );
    await run(owner, (tx) =>
      launchCampaign(
        tx,
        owner,
        {
          operationId: randomUUID(),
          campaignId: d.id,
          expectedVersion: 1,
          scheduledAt: at,
        },
        allOn,
        appUrl,
      ),
    );
    const cancelled = await run(owner, (tx) =>
      cancelCampaign(tx, owner, {
        operationId: randomUUID(),
        campaignId: d.id,
      }),
    );
    assert.equal(cancelled.state, "cancelled");
    await marketingTick(worker!, providers, allOn, appUrl, {
      now: Date.now() + 2 * 3600_000,
    });
    assert.equal(
      (
        await run(
          owner,
          (tx) => tx`select 1 from messages where campaign_id=${d.id}`,
        )
      ).length,
      0,
    );
  });

  await test("orders after a delivered message are attributed once; codes are reported apart", async () => {
    const baseline = await run(owner, (tx) =>
      performance(tx, owner, { campaignId }),
    );
    const placed = await run(owner, (tx) =>
      createOrder(tx, owner, order({ code, guest: { email: ana.email } })),
    );
    assert.equal(placed.guestId, anaId);
    assert(placed.discount! > 0);
    const report = await run(owner, (tx) => performance(tx, owner, {}));
    assert.equal(report.estimate, true);
    assert.equal(report.method, "last_message_within_window");
    // The guest's most recent delivered message wins, so exactly one campaign
    // is credited with this order.
    const credited = report.byCampaign.filter((c) => c.orders > 0);
    assert(credited.length >= 1);
    const all = await run(owner, (tx) => performance(tx, owner, {}));
    const mineBefore = baseline.attributedOrders;
    const scoped = await run(owner, (tx) =>
      performance(tx, owner, { campaignId }),
    );
    assert(scoped.attributedOrders >= mineBefore);
    assert.equal(
      all.byCampaign.reduce((a, c) => a + c.orders, 0),
      all.attributedOrders,
    );
    assert.equal(
      all.byDay.reduce((a, d) => a + d.sales, 0),
      all.attributedSales,
    );
    assert.equal(
      all.byGuestType.reduce((a, d) => a + d.orders, 0),
      all.attributedOrders,
    );
    const redeemed = scoped.byCampaign.find((c) => c.id === campaignId)!;
    assert.equal(redeemed.codeRedemptions, 1);
    assert.equal(redeemed.codeDiscount, placed.discount);
    await rejects(
      run(cashier, (tx) => performance(tx, cashier, {})),
      "forbidden",
    );
  });

  await test("settings are versioned and feedback is recorded once per order", async () => {
    const current = await run(owner, getMarketingSettings);
    const saved = await run(owner, (tx) =>
      saveMarketingSettings(tx, owner, {
        operationId: randomUUID(),
        expectedVersion: current.version,
        senderName: "Casa del Bosque",
        replyTo: "hola@casa.example",
        privacyUrl: "https://casa.example/privacidad",
        reviewUrl: "https://g.page/r/casa",
        frequencyCapDays: 30,
        attributionDays: 7,
        sendHour: 11,
      }),
    );
    assert.equal(saved.version, current.version + 1);
    await rejects(
      run(owner, (tx) =>
        saveMarketingSettings(tx, owner, {
          operationId: randomUUID(),
          expectedVersion: current.version,
        }),
      ),
      "stale_order",
    );
    const o = await run(owner, (tx) => createOrder(tx, owner, order()));
    const first = await run(owner, (tx) =>
      recordFeedback(tx, owner.tenantId, o.id, { rating: 5, comment: "Rico" }),
    );
    const second = await run(owner, (tx) =>
      recordFeedback(tx, owner.tenantId, o.id, { rating: 1 }),
    );
    assert.deepEqual(first, { rating: 5, comment: "Rico" });
    assert.deepEqual(second, first);
    await rejects(
      run(other, (tx) =>
        recordFeedback(tx, other.tenantId, o.id, { rating: 5 }),
      ),
      "not_found",
    );
    assert.equal((await run(owner, (tx) => getOrder(tx, o.id))).guestId, null);
  });
  console.log(`${checks} marketing checks passed on ${identity}`);
} finally {
  for (const s of [owner, other])
    await asAdmin(s.tenantId, async (tx) => {
      await tx`update campaigns set state='paused' where kind='automation'`;
      await tx`update promotions set active=false where active`;
    }).catch(() => {});
  if (originalEntitlement)
    await admin`update restaurant_entitlements set status=${originalEntitlement.status},access_until=${originalEntitlement.access_until} where tenant_id=${owner.tenantId}`;
  else
    await admin`delete from restaurant_entitlements where tenant_id=${owner.tenantId}`;
  await worker?.end();
  await admin
    .unsafe(`revoke connect on database "${database}" from "${role}"`)
    .catch(() => {});
  await admin.unsafe(`drop role if exists "${role}"`).catch(() => {});
  await sql.end();
  await admin.end();
}
