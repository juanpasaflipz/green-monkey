import { describe, it, expect } from "vitest";
import {
  automationKeys,
  automationParams,
  campaignInput,
  confirmationText,
  CONFIRM_TOKEN,
  inSegment,
  marketingSettings,
  pickChannel,
  qualifies,
  renderMarketing,
  smsText,
  type MemberStats,
} from "../shared/marketing";
import { sendChannels } from "../server/marketing/core";
import { providerConfig } from "../server/marketing-worker/messages";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 11, 18);
const window = { start: now - DAY, end: now };
const member = (m: Partial<MemberStats> = {}): MemberStats => ({
  id: "m1",
  joinedAt: now - 60 * DAY,
  confirmed: true,
  visits: 3,
  spend: 90_000,
  lastAt: now - 2 * DAY,
  lastOrderId: "o9",
  channels: ["pos"],
  modes: ["dine_in"],
  visitsInWindow: 0,
  ...m,
});
const params = automationParams.parse({});

describe("marketing segments", () => {
  it("filters by visits, spend, recency and order channel", () => {
    const yes = (s: object) => inSegment(member(), s, now);
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
    const never = member({ visits: 0, spend: 0, lastAt: null, channels: [] });
    expect(inSegment(never, { notVisitedForDays: 30 }, now)).toBe(true);
    expect(inSegment(never, { visitedWithinDays: 30 }, now)).toBe(false);
    expect(inSegment(never, { minAverageCheck: 1 }, now)).toBe(false);
  });
  it("picks the first channel that can send", () => {
    expect(pickChannel(["whatsapp", "sms"], ["sms"])).toBe("sms");
    expect(pickChannel(["whatsapp", "sms"], ["sms", "whatsapp"])).toBe(
      "whatsapp",
    );
    expect(pickChannel(["whatsapp"], ["sms"])).toBeNull();
    expect(pickChannel(["sms"], [])).toBeNull();
  });
});

describe("automation qualification", () => {
  const q = (key: (typeof automationKeys)[number], m: Partial<MemberStats>) =>
    qualifies(key, member(m), params, window);
  const visited = { lastAt: now - 3600_000, visitsInWindow: 1 };
  it("never fires without an event inside the window", () => {
    for (const key of automationKeys) expect(q(key, {})).toBeNull();
  });
  it("miss you crosses the inactivity threshold exactly once", () => {
    expect(q("miss_you", { lastAt: now - 30 * DAY - 3600_000 })).toBe(
      "miss:o9",
    );
    expect(q("miss_you", { lastAt: now - 29 * DAY })).toBeNull();
    expect(q("miss_you", { lastAt: now - 31 * DAY - 1 })).toBeNull();
    expect(q("miss_you", { lastAt: null })).toBeNull();
    // An imported member has a last visit but no order of ours.
    expect(
      q("miss_you", { lastAt: now - 30 * DAY - 1, lastOrderId: null }),
    ).toBe("miss:" + (now - 30 * DAY - 1));
  });
  it("repeat guest fires on every fifth visit, even with two in one window", () => {
    expect(q("repeat_guest", { ...visited, visits: 5 })).toBe("repeat:1");
    expect(
      q("repeat_guest", { ...visited, visits: 6, visitsInWindow: 2 }),
    ).toBe("repeat:1");
    expect(q("repeat_guest", { ...visited, visits: 6 })).toBeNull();
    expect(q("repeat_guest", { ...visited, visits: 10 })).toBe("repeat:2");
    expect(q("repeat_guest", { visits: 5 })).toBeNull();
  });
  it("big spender, channel nudges and follow-up", () => {
    expect(q("big_spender", { ...visited, visits: 2, spend: 100_000 })).toBe(
      "big:o9",
    );
    expect(
      q("big_spender", { ...visited, visits: 2, spend: 99_998 }),
    ).toBeNull();
    expect(q("drive_qr", visited)).toBe("qr");
    expect(
      q("drive_qr", { ...visited, channels: ["pos", "kiosk"] }),
    ).toBeNull();
    expect(q("drive_dine_in", { ...visited, modes: ["takeaway"] })).toBe(
      "dinein",
    );
    expect(q("drive_dine_in", visited)).toBeNull();
    expect(q("follow_up", visited)).toBe("follow:o9");
  });
});

describe("message text", () => {
  const v = { name: "  Ana María López ", restaurant: "Casa del Bosque" };
  it("uses the first name, keeps unknown placeholders and stays on one line", () => {
    expect(
      renderMarketing("Hola {{name}},\n  ven a {{ restaurant }} {{offer}}", v),
    ).toBe("Hola Ana, ven a Casa del Bosque {{offer}}");
    expect(renderMarketing("Hola {{name}}", { ...v, name: "" })).toBe(
      "Hola qué tal",
    );
  });
  it("every SMS carries the STOP instruction", () => {
    expect(smsText("Hola {{name}}", v)).toBe(
      "Hola Ana Responde STOP para dejar de recibir mensajes.",
    );
    const text = confirmationText(
      "Casa del Bosque",
      "https://app.example/club/confirm#t",
    );
    expect(text).toContain("https://app.example/club/confirm#t");
    expect(text).toContain("STOP");
  });
  it("validates campaigns, settings and the confirmation token shape", () => {
    const base = {
      operationId: "5b0c7a7e-5d0e-4a37-9f0e-3b7f3f0d7b11",
      expectedVersion: 0,
      campaign: {
        id: "5b0c7a7e-5d0e-4a37-9f0e-3b7f3f0d7b12",
        name: "Martes",
        channels: ["sms"],
        body: "Hola {{name}}",
      },
    };
    expect(campaignInput.parse(base).campaign.segment).toEqual({});
    expect(() =>
      campaignInput.parse({
        ...base,
        campaign: { ...base.campaign, channels: ["email"] },
      }),
    ).toThrow();
    expect(() =>
      campaignInput.parse({
        ...base,
        campaign: { ...base.campaign, channels: ["sms", "sms"] },
      }),
    ).toThrow();
    expect(() =>
      campaignInput.parse({
        ...base,
        campaign: { ...base.campaign, body: "x".repeat(601) },
      }),
    ).toThrow();
    expect(marketingSettings.parse({})).toEqual({
      enabled: false,
      frequencyCapDays: 30,
      attributionDays: 7,
      sendHour: 11,
    });
    expect(() => marketingSettings.parse({ sendHour: 23 })).toThrow();
    const id = "5b0c7a7e-5d0e-4a37-9f0e-3b7f3f0d7b11";
    expect(CONFIRM_TOKEN.test(`${id}.${id}.${"a".repeat(43)}`)).toBe(true);
    expect(CONFIRM_TOKEN.test(`${id}.${id}.short`)).toBe(false);
  });
});

describe("send switches", () => {
  it("web sees only the non-secret switches", () => {
    expect(sendChannels({})).toEqual([]);
    expect(sendChannels({ MARKETING_SMS_SEND: "1" })).toEqual(["sms"]);
    expect(sendChannels({ MARKETING_SMS_SEND: "true" })).toEqual([]);
    expect(
      sendChannels({ MARKETING_SMS_SEND: "1", MARKETING_WHATSAPP_SEND: "1" }),
    ).toEqual(["sms", "whatsapp"]);
  });
  it("the worker needs the switch and every credential", () => {
    const twilio = {
      TWILIO_ACCOUNT_SID: "synthetic",
      TWILIO_AUTH_TOKEN: "synthetic",
      TWILIO_MESSAGING_SERVICE_SID: "synthetic",
    };
    expect(providerConfig(twilio).sms).toBeNull();
    expect(
      providerConfig({ ...twilio, MARKETING_SMS_SEND: "1" }).sms,
    ).toBeTruthy();
    expect(
      providerConfig({
        MARKETING_SMS_SEND: "1",
        TWILIO_ACCOUNT_SID: "synthetic",
      }).sms,
    ).toBeFalsy();
    expect(
      providerConfig({ MARKETING_WHATSAPP_SEND: "1" }).whatsapp,
    ).toBeFalsy();
  });
});
