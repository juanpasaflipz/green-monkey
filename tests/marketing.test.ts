import { describe, it, expect } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  automationKeys,
  automationParams,
  csvCell,
  emailHtml,
  guestCapture,
  inSegment,
  normalizePhone,
  qualifies,
  reachableChannel,
  renderMessage,
  type GuestStats,
} from "../shared/marketing";
import { monthPlan, type Insights } from "../server/marketing-assistant";
import {
  resendProvider,
  twilioProvider,
  whatsappProvider,
  type Outbound,
} from "../server/marketing-delivery";
import { channelStatus } from "../server/marketing";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 11, 18);
const window = { start: now - DAY, end: now };
const guest = (g: Partial<GuestStats> = {}): GuestStats => ({
  id: "g1",
  name: "Ana López",
  email: "ana@example.com",
  phone: "+525512345678",
  locale: "es",
  optIn: { email: true, sms: false, whatsapp: true },
  createdAt: now - 60 * DAY,
  consentAt: now - 60 * DAY,
  visits: 3,
  spend: 90_000,
  firstAt: now - 50 * DAY,
  lastAt: now - 2 * DAY,
  lastOrderId: "o9",
  channels: ["pos"],
  modes: ["dine_in"],
  visitsInWindow: 0,
  feedback: null,
  ...g,
});
const params = automationParams.parse({});

describe("guest contact rules", () => {
  it("normalizes phones to E.164 with the restaurant's country", () => {
    expect(normalizePhone("55 1234 5678", "52")).toBe("+525512345678");
    expect(normalizePhone("(415) 555-0100", "1")).toBe("+14155550100");
    expect(normalizePhone("+34 600 111 222", "52")).toBe("+34600111222");
    expect(normalizePhone("0044 20 7946 0958", "52")).toBe("+442079460958");
    expect(() => normalizePhone("12345", "52")).toThrow();
    expect(() => normalizePhone("5512345678", null)).not.toThrow();
    expect(() => normalizePhone("abc", "52")).toThrow();
  });
  it("requires an address for every consented channel", () => {
    expect(() => guestCapture.parse({ name: "x" })).toThrow();
    expect(() =>
      guestCapture.parse({ email: "a@b.mx", consent: { sms: true } }),
    ).toThrow();
    expect(() =>
      guestCapture.parse({ phone: "5512345678", consent: { email: true } }),
    ).toThrow();
    const ok = guestCapture.parse({
      email: " Ana@Example.COM ",
      consent: { email: true },
    });
    expect(ok.email).toBe("ana@example.com");
    expect(ok.consent).toEqual({ email: true, sms: false, whatsapp: false });
  });
  it("uses the first consented, configured channel", () => {
    const g = guest();
    expect(
      reachableChannel(
        g,
        ["sms", "whatsapp", "email"],
        ["email", "sms", "whatsapp"],
      ),
    ).toBe("whatsapp");
    expect(
      reachableChannel(g, ["sms", "whatsapp", "email"], ["email", "sms"]),
    ).toBe("email");
    expect(
      reachableChannel(g, ["sms"], ["email", "sms", "whatsapp"]),
    ).toBeNull();
    expect(
      reachableChannel({ ...g, email: null }, ["email"], ["email"]),
    ).toBeNull();
  });
});

describe("segments", () => {
  it("filters by visits, spend, recency and channel", () => {
    const g = guest();
    const yes = (s: object) => inSegment(g, s, now);
    expect(yes({})).toBe(true);
    expect(yes({ minVisits: 3, maxVisits: 3 })).toBe(true);
    expect(yes({ minVisits: 4 })).toBe(false);
    expect(yes({ maxVisits: 2 })).toBe(false);
    expect(yes({ minSpend: 90_001 })).toBe(false);
    expect(yes({ minAverageCheck: 30_000 })).toBe(true);
    expect(yes({ minAverageCheck: 30_001 })).toBe(false);
    expect(yes({ visitedWithinDays: 2 })).toBe(true);
    expect(yes({ visitedWithinDays: 1 })).toBe(false);
    expect(yes({ notVisitedForDays: 2 })).toBe(true);
    expect(yes({ notVisitedForDays: 3 })).toBe(false);
    expect(yes({ joinedWithinDays: 30 })).toBe(false);
    expect(yes({ orderedVia: "qr" })).toBe(false);
    expect(yes({ neverOrderedVia: "qr" })).toBe(true);
    const never = guest({ visits: 0, spend: 0, lastAt: null, channels: [] });
    expect(inSegment(never, { notVisitedForDays: 30 }, now)).toBe(true);
    expect(inSegment(never, { visitedWithinDays: 30 }, now)).toBe(false);
    expect(inSegment(never, { minAverageCheck: 1 }, now)).toBe(false);
  });
});

describe("automation qualification", () => {
  const q = (key: (typeof automationKeys)[number], g: Partial<GuestStats>) =>
    qualifies(key, guest(g), params, window);
  it("only fires on an event inside the window", () => {
    for (const key of automationKeys) expect(q(key, {})).toBeNull();
  });
  it("welcome: consent granted in the window", () => {
    expect(q("welcome", { consentAt: now - 3600_000 })).toBe("welcome");
    expect(q("welcome", { consentAt: now })).toBeNull();
    expect(q("welcome", { consentAt: null })).toBeNull();
  });
  it("miss you: crosses the inactivity threshold exactly once", () => {
    expect(q("miss_you", { lastAt: now - 30 * DAY - 3600_000 })).toBe(
      "miss:o9",
    );
    expect(q("miss_you", { lastAt: now - 29 * DAY })).toBeNull();
    expect(q("miss_you", { lastAt: now - 31 * DAY - 1 })).toBeNull();
    expect(q("miss_you", { lastAt: null })).toBeNull();
  });
  it("repeat guest: every fifth visit, even when two land in one window", () => {
    const visited = { lastAt: now - 3600_000 };
    expect(
      q("repeat_guest", { ...visited, visits: 5, visitsInWindow: 1 }),
    ).toBe("repeat:1");
    expect(
      q("repeat_guest", { ...visited, visits: 6, visitsInWindow: 2 }),
    ).toBe("repeat:1");
    expect(
      q("repeat_guest", { ...visited, visits: 6, visitsInWindow: 1 }),
    ).toBeNull();
    expect(
      q("repeat_guest", { ...visited, visits: 10, visitsInWindow: 1 }),
    ).toBe("repeat:2");
    expect(q("repeat_guest", { visits: 5, visitsInWindow: 0 })).toBeNull();
  });
  it("big spender, feedback, channel nudges and follow-up", () => {
    const visited = { lastAt: now - 3600_000, visitsInWindow: 1 };
    expect(q("big_spender", { ...visited, visits: 2, spend: 100_000 })).toBe(
      "big:o9",
    );
    expect(
      q("big_spender", { ...visited, visits: 2, spend: 99_998 }),
    ).toBeNull();
    expect(
      q("positive_feedback", {
        feedback: { orderId: "o9", rating: 5, at: now - 1 },
      }),
    ).toBe("feedback:o9");
    expect(
      q("positive_feedback", {
        feedback: { orderId: "o9", rating: 3, at: now - 1 },
      }),
    ).toBeNull();
    expect(
      q("positive_feedback", {
        feedback: { orderId: "o9", rating: 5, at: now - 2 * DAY },
      }),
    ).toBeNull();
    expect(q("first_online_order", visited)).toBe("online");
    expect(
      q("first_online_order", { ...visited, channels: ["pos", "qr"] }),
    ).toBeNull();
    expect(q("drive_in_store", { ...visited, modes: ["takeaway"] })).toBe(
      "instore",
    );
    expect(q("drive_in_store", visited)).toBeNull();
    expect(q("follow_up", visited)).toBe("follow:o9");
  });
});

describe("message rendering", () => {
  const vars = {
    name: "Ana",
    restaurant: "Casa <Bosque>",
    code: "VUELVE10",
    offerName: "10% de regreso",
    review: null,
    locale: "es" as const,
  };
  it("substitutes placeholders and keeps unknown ones visible", () => {
    expect(
      renderMessage(
        "Hola {{name}} de {{ restaurant }}.{{offer}} {{nope}}",
        vars,
      ),
    ).toBe(
      "Hola Ana de Casa <Bosque>. Usa el código VUELVE10 (10% de regreso) en tu próxima orden. {{nope}}",
    );
    expect(
      renderMessage("Hi {{name}}.{{offer}}", {
        ...vars,
        name: "",
        code: null,
        locale: "en",
      }),
    ).toBe("Hi there.");
  });
  it("escapes HTML and always carries an unsubscribe link", () => {
    const html = emailHtml('<script>alert(1)</script>\n\nSegundo "párrafo"', {
      restaurant: vars.restaurant,
      unsubscribeUrl: "https://app.example/u/t?a=1&b=2",
      privacyUrl: null,
      locale: "es",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Casa &lt;Bosque&gt;");
    expect(html).toContain('href="https://app.example/u/t?a=1&amp;b=2"');
    expect(html).toContain("Darme de baja");
    expect(html).not.toContain("Aviso de privacidad");
  });
  it("neutralizes spreadsheet formulas in exports", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+525512345678")).toBe("'+525512345678");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });
});

describe("channel configuration", () => {
  const full = {
    MARKETING_DATABASE_URL: "postgresql://x",
    APP_URL: "https://app.example",
    MARKETING_EMAIL_ENABLED: "true",
    RESEND_API_KEY: "re_x",
    MARKETING_EMAIL_FROM: "hola@mail.example",
  };
  it("needs an explicit flag, credentials, the worker and an HTTPS app URL", () => {
    expect(channelStatus(full).email).toEqual({ enabled: true });
    expect(
      channelStatus({ ...full, MARKETING_EMAIL_ENABLED: "" }).email.reason,
    ).toBe("not_enabled");
    expect(channelStatus({ ...full, RESEND_API_KEY: "" }).email.reason).toBe(
      "credentials_required",
    );
    expect(
      channelStatus({ ...full, MARKETING_DATABASE_URL: "" }).email.enabled,
    ).toBe(false);
    expect(
      channelStatus({ ...full, APP_URL: "http://localhost:3001" }).email
        .enabled,
    ).toBe(false);
    expect(channelStatus(full).sms.reason).toBe("not_enabled");
    expect(channelStatus(full).whatsapp.enabled).toBe(false);
  });
});

describe("provider adapters", () => {
  const message: Outbound = {
    id: "5b0c7a7e-5d0e-4a37-9f0e-3b7f3f0d7b11",
    channel: "email",
    to: "ana@example.com",
    subject: "Hola",
    text: "Hola Ana",
    locale: "es",
    guestName: "Ana",
    restaurant: 'Casa "Bosque" <x>',
    replyTo: "hola@casa.example",
    privacyUrl: null,
    unsubscribeUrl: "https://app.example/u/tok",
    oneClickUrl: "https://app.example/api/guest/unsubscribe/tok",
  };
  const capture = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, http };
  };
  it("Resend: idempotent request with one-click unsubscribe headers", async () => {
    const { calls, http } = capture(200, { id: "re_1" });
    const result = await resendProvider(
      { apiKey: "re_k", from: "hola@mail.example" },
      http,
    )(message);
    expect(result).toEqual({ ok: true, providerId: "re_1" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(message.id);
    expect(headers.Authorization).toBe("Bearer re_k");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.from).toBe("Casa  Bosque   x <hola@mail.example>");
    expect(body.to).toEqual(["ana@example.com"]);
    expect(body.reply_to).toBe("hola@casa.example");
    expect(body.headers["List-Unsubscribe"]).toBe(
      "<https://app.example/api/guest/unsubscribe/tok>",
    );
    expect(body.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(body.text).toContain("https://app.example/u/tok");
  });
  it("classifies provider failures as retryable or final", async () => {
    const send = (status: number) =>
      resendProvider(
        { apiKey: "k", from: "a@b.mx" },
        capture(status, {}).http,
      )(message);
    expect(await send(429)).toEqual({
      ok: false,
      retryable: true,
      code: "resend_429",
    });
    expect(await send(503)).toEqual({
      ok: false,
      retryable: true,
      code: "resend_503",
    });
    expect(await send(422)).toEqual({
      ok: false,
      retryable: false,
      code: "resend_422",
    });
    expect(await send(200)).toEqual({
      ok: false,
      retryable: false,
      code: "resend_no_id",
    });
  });
  it("Twilio: form-encoded message through the messaging service", async () => {
    const { calls, http } = capture(201, { sid: "SM1" });
    const result = await twilioProvider(
      { accountSid: "AC1", authToken: "tok", messagingServiceSid: "MG1" },
      http,
    )({
      ...message,
      channel: "sms",
      to: "+525512345678",
      text: "Hola\nBaja: https://x",
    });
    expect(result).toEqual({ ok: true, providerId: "SM1" });
    expect(calls[0].url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json",
    );
    const form = calls[0].init.body as URLSearchParams;
    expect(form.get("To")).toBe("+525512345678");
    expect(form.get("MessagingServiceSid")).toBe("MG1");
    expect(form.get("Body")).toBe("Hola\nBaja: https://x");
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Basic " + Buffer.from("AC1:tok").toString("base64"));
  });
  it("WhatsApp: approved template with four single-line parameters", async () => {
    const { calls, http } = capture(200, { messages: [{ id: "wamid.1" }] });
    const result = await whatsappProvider(
      {
        accessToken: "t",
        phoneNumberId: "123",
        apiVersion: "v23.0",
        template: "gm_marketing",
      },
      http,
    )({
      ...message,
      channel: "whatsapp",
      to: "+525512345678",
      text: "Línea uno\n\nLínea dos",
    });
    expect(result).toEqual({ ok: true, providerId: "wamid.1" });
    expect(calls[0].url).toBe("https://graph.facebook.com/v23.0/123/messages");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.to).toBe("525512345678");
    expect(body.template.name).toBe("gm_marketing");
    expect(body.template.language.code).toBe("es_MX");
    expect(
      body.template.components[0].parameters.map((p: any) => p.text),
    ).toEqual([
      "Ana",
      'Casa "Bosque" <x>',
      "Línea uno Línea dos",
      "https://app.example/u/tok",
    ]);
  });
});

describe("assistant month plan", () => {
  const data: Insights = {
    historyDays: 40,
    sufficient: true,
    weekdays: [],
    slowDays: [2],
    topProducts: [
      {
        name: { es: "Burrito California", en: "California Burrito" },
        quantity: 90,
      },
    ],
    guests: { total: 80, reachable: 60, lapsed: 12, recent: 9 },
  };
  it("plans slow days, win-backs, new guests and upcoming dates", () => {
    const plan = monthPlan(data, Temporal.PlainDate.from("2026-11-11"), "es");
    const reasons = plan.map((p) => p.reason);
    expect(reasons.filter((r) => r === "slow_day")).toHaveLength(2);
    expect(reasons).toContain("winback");
    expect(reasons).toContain("new_guests");
    expect(plan.find((p) => p.reason === "slow_day")!.date).toBe("2026-11-16");
    expect(plan.find((p) => p.reason === "slow_day")!.body).toContain(
      "Burrito California",
    );
    expect(plan.every((p) => p.date > "2026-11-11")).toBe(true);
    expect([...plan].sort((a, b) => a.date.localeCompare(b.date))).toEqual(
      plan,
    );
    const december = monthPlan(
      data,
      Temporal.PlainDate.from("2026-11-25"),
      "en",
    );
    expect(
      december.some(
        (p) => p.reason === "occasion" && p.title === "Guadalupe Day",
      ),
    ).toBe(true);
  });
  it("does not invent slow days without enough history", () => {
    const plan = monthPlan(
      {
        ...data,
        sufficient: false,
        slowDays: [],
        guests: { total: 2, reachable: 1, lapsed: 0, recent: 1 },
      },
      Temporal.PlainDate.from("2026-07-01"),
      "es",
    );
    expect(plan).toEqual([]);
  });
});
