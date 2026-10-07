// cfdifix (LD-51): unit checks for the fixes from the real-sandbox CFDI rehearsal. Pure: no
// database, no network (the Facturapi client runs against a stubbed fetch).
//   F1 the self-invoicing deadline's global bound per periodicity, and when it prints its time;
//   F2 when a periodicity change may apply at once, and why it waits (CFDIFIX-1: never a
//      deadline a receipt already printed brought forward);
//   F3 the stamping issuer facts in the shared sandbox and what the worker publishes of them;
//   F7 the cancellation acuse's UUIDs;
//   F12 the issuance tick's key and when it runs (LD-55);
//   F13 the Facturapi log id of every answer and the job's one log line (LD-55 OPS-1);
//   LD-55 the deadline's time, and a self-invoicing change that waits (FISCAL-1, FISCAL-5).
import { describe, expect, it } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  businessDayStart,
  deadlineShowsTime,
  effectiveSelfInvoiceDeadline,
  globalBuildAt,
  selfInvoiceChangeFrom,
  periodicityChangeBlock,
  periodicityChangeNow,
  type SelfInvoiceGlobalBound,
} from "../shared/cfdi";
import { dedupe, issuedTickPrefix, issuedTickRunAt } from "../server/cfdi/jobs";
import {
  sharedIssuerComplete,
  stampingFacts,
  type FiscalFacts,
} from "../server/cfdi/store";
import { classifyFacturapiError } from "../server/cfdi/errors";
import { sharedIssuerOf } from "../server/cfdi/worker/org";
import { acuseMatches, acuseUuids } from "../server/cfdi/xml";
import { createFacturapiClient } from "../server/cfdi/facturapi";
import {
  recordProviderResponse,
  traceDocument,
  traceFailure,
  traceQuiet,
} from "../server/cfdi/worker/runtime";
import { traced } from "../server/cfdi/worker/register";
import type { JobContext, JobOutcome } from "../server/jobs";

const TZ = "America/Mexico_City"; // UTC−6 all year since 2022
const bound = (
  over: Partial<SelfInvoiceGlobalBound> = {},
): SelfInvoiceGlobalBound => ({
  globalPeriodicity: "day",
  nextPeriodicity: null,
  nextPeriodicityFrom: null,
  cutoff: 240,
  graceMinutes: 60,
  ...over,
});
const at = (iso: string) => Date.parse(iso);

describe("LD-51 F1: the self-invoicing deadline ends when the ticket's global is built", () => {
  // Wednesday 7 October 2026, business day cut at 04:00 local (10:00Z), grace 60 minutes.
  const date = "2026-10-07";
  const window = (
    periodicity: SelfInvoiceGlobalBound["globalPeriodicity"],
    policy: "month" | "days" = "month",
    days = 30,
  ) =>
    effectiveSelfInvoiceDeadline(date, {
      policy,
      days,
      timezone: TZ,
      global: {
        globalAt: globalBuildAt(
          date,
          bound({ globalPeriodicity: periodicity }),
          TZ,
        ),
      },
    });

  it("day: the close of the business day (8 Oct 04:00) + 60 min, before the month policy", () => {
    const w = window("day");
    expect(w.bound).toBe("global");
    expect(at(w.deadline)).toBe(at("2026-10-08T11:00:00Z"));
  });
  it("week: Monday 5 to Sunday 11 October, built 12 Oct 05:00 local", () => {
    const w = window("week");
    expect(w.bound).toBe("global");
    expect(at(w.deadline)).toBe(at("2026-10-12T11:00:00Z"));
  });
  it("fortnight: 1–15 October, built 16 Oct 05:00 local", () => {
    const w = window("fortnight");
    expect(w.bound).toBe("global");
    expect(at(w.deadline)).toBe(at("2026-10-16T11:00:00Z"));
  });
  it("month: built 1 Nov 05:00 local, after the month policy (31 Oct 23:59:59.999 local), which wins", () => {
    const w = window("month");
    expect(w.bound).toBe("policy");
    expect(at(w.deadline)).toBe(at("2026-11-01T05:59:59.999Z"));
  });
  it("a 3-day policy (10 Oct 23:59:59.999 local) wins over a weekly global and loses to a daily one", () => {
    expect(at(window("week", "days", 3).deadline)).toBe(
      at("2026-10-11T05:59:59.999Z"),
    );
    expect(window("week", "days", 3).bound).toBe("policy");
    expect(window("day", "days", 3).bound).toBe("global");
  });
  it("without a bound (the portal reissues globals, or a status cached before cfdifix) the policy alone", () => {
    for (const global of [null, undefined])
      expect(
        effectiveSelfInvoiceDeadline(date, {
          policy: "month",
          days: 30,
          timezone: TZ,
          global,
        }),
      ).toEqual({ deadline: "2026-11-01T05:59:59.999Z", bound: "policy" });
  });
  it("a period row's close + grace gives the same instant as the computed build", () => {
    expect(
      at(
        effectiveSelfInvoiceDeadline(date, {
          policy: "month",
          days: 30,
          timezone: TZ,
          global: { closesAt: "2026-10-08T10:00:00.000Z", graceMinutes: 60 },
        }).deadline,
      ),
    ).toBe(at(window("day").deadline));
  });
  it("the bound follows a pending periodicity from its first day, and the worker's grace", () => {
    const pending = bound({
      globalPeriodicity: "month",
      nextPeriodicity: "day",
      nextPeriodicityFrom: "2026-11-01",
      graceMinutes: 0,
    });
    expect(at(globalBuildAt("2026-10-30", pending, TZ))).toBe(
      at("2026-11-01T10:00:00Z"),
    );
    expect(at(globalBuildAt("2026-11-02", pending, TZ))).toBe(
      at("2026-11-03T10:00:00Z"),
    );
  });
  it("the receipt and the portal print the time whenever the global ends the window (LD-55 CFDIFIX-FISCAL-1 / UX-1), and for a policy deadline on the business date or the next day", () => {
    // Every global-bound deadline is the period's close + grace (05:00 here), never the whole day.
    expect(deadlineShowsTime(window("day").deadline, date, TZ)).toBe(true);
    expect(deadlineShowsTime(window("week").deadline, date, TZ)).toBe(true);
    expect(deadlineShowsTime(window("fortnight").deadline, date, TZ)).toBe(
      true,
    );
    // A 3-day window cut by a monthly global (30 Oct + 3 days > 1 Nov 05:00).
    const monthDays = effectiveSelfInvoiceDeadline("2026-10-30", {
      policy: "days",
      days: 3,
      timezone: TZ,
      global: {
        globalAt: globalBuildAt(
          "2026-10-30",
          bound({ globalPeriodicity: "month" }),
          TZ,
        ),
      },
    });
    expect(monthDays.bound).toBe("global");
    expect(deadlineShowsTime(monthDays.deadline, "2026-10-30", TZ)).toBe(true);
    // The policy's end of day: with the time only on the purchase date or the next day.
    expect(
      deadlineShowsTime("2026-11-01T05:59:59.999Z", "2026-10-31", TZ),
    ).toBe(true);
    expect(deadlineShowsTime("2026-11-01T05:59:59.999Z", date, TZ)).toBe(false);
    expect(deadlineShowsTime(window("month").deadline, date, TZ)).toBe(false);
  });
});

describe("LD-55 CFDIFIX-FISCAL-5 / UX-4: a self-invoicing change that would shorten printed deadlines waits", () => {
  // Wednesday 7 October 2026, cutoff 04:00, grace 60, weekly globals.
  const date = "2026-10-07";
  const weekly = globalBuildAt(date, bound({ globalPeriodicity: "week" }), TZ);
  const fromAt = businessDayStart("2026-11-01", TZ, 240); // 1 Nov 04:00 local
  it("before the change applies, the later of the new terms' deadline and the current one cut at its start", () => {
    // Reissue on (policy alone, 31 Oct) → off (weekly global, 12 Oct 05:00), from 1 Nov: the
    // customer keeps 31 Oct.
    const w = effectiveSelfInvoiceDeadline(date, {
      policy: "month",
      days: 30,
      timezone: TZ,
      global: null,
      pending: {
        policy: "month",
        days: 30,
        global: { globalAt: weekly },
        fromAt,
      },
    });
    expect(w).toEqual({
      deadline: "2026-11-01T05:59:59.999Z",
      bound: "policy",
    });
    // A ticket of 31 Oct with a 30-day window → 3 days, from 1 Nov: cut at 1 Nov 04:00 (later
    // than its new 3 Nov end? no: the new end, 3 Nov 23:59, is later and wins).
    const d = effectiveSelfInvoiceDeadline("2026-10-31", {
      policy: "days",
      days: 30,
      timezone: TZ,
      pending: { policy: "days", days: 3, fromAt },
    });
    expect(at(d.deadline)).toBe(at("2026-11-04T05:59:59.999Z"));
    // A 30-day window → reissue off with weekly globals: the current one is cut at the change.
    const cut = effectiveSelfInvoiceDeadline("2026-10-20", {
      policy: "days",
      days: 30,
      timezone: TZ,
      pending: {
        policy: "days",
        days: 30,
        global: {
          globalAt: globalBuildAt(
            "2026-10-20",
            bound({ globalPeriodicity: "week" }),
            TZ,
          ),
        },
        fromAt,
      },
    });
    expect(cut).toEqual({
      deadline: Temporal.Instant.from(fromAt).toString(),
      bound: "policy",
    });
    expect(deadlineShowsTime(cut.deadline, "2026-10-20", TZ)).toBe(true);
  });
  it("the change applies from the first business day starting at or after the latest deadline it would shorten", () => {
    // A policy end of day (31 Oct 23:59:59.999 local) → 1 Nov.
    expect(selfInvoiceChangeFrom("2026-11-01T05:59:59.999Z", TZ, 240)).toBe(
      "2026-11-01",
    );
    // A global build (12 Oct 05:00 local, after the 04:00 cutoff) → 13 Oct.
    expect(selfInvoiceChangeFrom("2026-10-12T11:00:00.000Z", TZ, 240)).toBe(
      "2026-10-13",
    );
    // Exactly a business day's start (1 Nov 04:00 local) → that day.
    expect(selfInvoiceChangeFrom(fromAt, TZ, 240)).toBe("2026-11-01");
  });
});

describe("LD-51 F2: a periodicity change applies at once only on an unshaped month", () => {
  // 7 October 2026, 12:00 local (18:00Z): the business day of 7 Oct runs since 04:00.
  const now = new Date("2026-10-07T18:00:00Z");
  type P = "day" | "week" | "fortnight" | "month";
  const block = (o: {
    hasGlobals?: boolean;
    dates?: string[];
    from: P;
    to: P;
    policy?: "month" | "days";
    days?: number;
    now?: Date;
  }) =>
    periodicityChangeBlock({
      hasGlobals: o.hasGlobals ?? false,
      dates: o.dates ?? [],
      from: o.from,
      to: o.to,
      timezone: TZ,
      cutoff: 240,
      selfInvoice: {
        policy: o.policy ?? "month",
        days: o.days ?? 30,
        graceMinutes: 60,
      },
      now: o.now ?? now,
    });
  const change = (o: Parameters<typeof block>[0]) =>
    periodicityChangeNow({
      hasGlobals: o.hasGlobals ?? false,
      dates: o.dates ?? [],
      from: o.from,
      to: o.to,
      timezone: TZ,
      cutoff: 240,
      selfInvoice: {
        policy: o.policy ?? "month",
        days: o.days ?? 30,
        graceMinutes: 60,
      },
      now: o.now ?? now,
    });

  it("no global of the month and no ticket: at once, either way", () => {
    expect(change({ from: "month", to: "day" })).toBe(true);
    expect(change({ from: "day", to: "month" })).toBe(true);
    expect(block({ from: "month", to: "day" })).toBeNull();
  });
  it("a global document of the month (any status): from next month", () => {
    expect(change({ hasGlobals: true, from: "month", to: "day" })).toBe(false);
    expect(block({ hasGlobals: true, from: "day", to: "month" })).toBe(
      "globals",
    );
  });
  it("a ticket of 5 Oct would sit in a daily period due 7 Oct 04:00, already past: from next month", () => {
    expect(block({ dates: ["2026-10-05"], from: "month", to: "day" })).toBe(
      "overdue",
    );
  });
  it("an overdue daily period is never hidden in a monthly one: from next month", () => {
    expect(block({ dates: ["2026-10-05"], from: "day", to: "month" })).toBe(
      "overdue",
    );
  });
  it("CFDIFIX-1: activated 7 Oct with monthly globals, a sale on 7 Oct, a switch to daily on 8 Oct at 12:00: the receipt printed 31 Oct, the daily global would end it 8 Oct 05:00, so the change waits", () => {
    expect(
      block({
        dates: ["2026-10-07"],
        from: "month",
        to: "day",
        now: new Date("2026-10-08T18:00:00Z"),
      }),
    ).toBe("deadline");
  });
  it("CFDIFIX-1: month → day with yesterday's or today's ticket (no period overdue) brings their deadline forward: from next month", () => {
    expect(block({ dates: ["2026-10-06"], from: "month", to: "day" })).toBe(
      "deadline",
    );
    expect(block({ dates: ["2026-10-07"], from: "month", to: "day" })).toBe(
      "deadline",
    );
    expect(block({ dates: ["2026-10-06"], from: "month", to: "week" })).toBe(
      "deadline",
    );
    expect(
      block({ dates: ["2026-10-06"], from: "fortnight", to: "week" }),
    ).toBe("deadline");
  });
  it("CFDIFIX-1: a change that keeps or lengthens every deadline applies at once", () => {
    expect(
      change({ dates: ["2026-10-06", "2026-10-07"], from: "day", to: "month" }),
    ).toBe(true);
    expect(
      change({ dates: ["2026-10-06"], from: "week", to: "fortnight" }),
    ).toBe(true);
    // A one-day policy (7 Oct 23:59) ends before either global: nothing moves.
    expect(
      change({
        dates: ["2026-10-06"],
        from: "month",
        to: "fortnight",
        policy: "days",
        days: 1,
      }),
    ).toBe(true);
    // ... but a daily global (7 Oct 05:00) would end it earlier.
    expect(
      block({
        dates: ["2026-10-06"],
        from: "month",
        to: "day",
        policy: "days",
        days: 1,
      }),
    ).toBe("deadline");
  });
  it("CFDIFIX-1: on the last day of a month a monthly and a daily global of that day close together: today's tickets keep their deadline, an earlier day's does not", () => {
    const lastDay = new Date("2026-10-31T18:00:00Z");
    expect(
      change({ dates: ["2026-10-31"], from: "month", to: "day", now: lastDay }),
    ).toBe(true);
    expect(
      block({
        dates: ["2026-10-30", "2026-10-31"],
        from: "month",
        to: "day",
        now: lastDay,
      }),
    ).toBe("deadline");
  });
});

describe("LD-51 F3: the shared sandbox stamps as the platform's test organization", () => {
  const facts: FiscalFacts = {
    tradeName: "Taquería Ficticia",
    currency: "MXN",
    timezone: TZ,
    cutoff: 240,
    version: 2,
    rfc: "XIQB891116QE4",
    legalName: "BERENICE XIMO QUEZADA",
    regime: "626",
    postalCode: "42501",
    address: {},
  };
  const platform = (sharedIssuer: {
    legalName: string | null;
    taxId: string | null;
    regime: string | null;
    postalCode: string | null;
  }) => ({
    provider: "sandbox_shared" as const,
    liveEnabled: false,
    uploadKid: null,
    uploadPublicJwk: null,
    sharedOrgId: "org1",
    globalGraceMinutes: 60,
    sharedIssuer,
    workerVersion: "test",
    updatedAt: "2026-10-07T00:00:00.000Z",
  });
  const shared = platform({
    legalName: "PLATAFORMA DE PRUEBA",
    taxId: "EKU9003173C9",
    regime: "601",
    postalCode: "01000",
  });

  it("an own organization stamps with the restaurant's profile (organizations mode unchanged)", () => {
    expect(stampingFacts(facts, shared, { source: "own" })).toBe(facts);
    expect(stampingFacts(facts, null, { source: "shared_sandbox" })).toBe(
      facts,
    );
  });
  it("the shared organization's régimen, RFC and postal code decide the retention and LugarExpedicion", () => {
    expect(
      stampingFacts(facts, shared, { source: "shared_sandbox" }),
    ).toMatchObject({
      rfc: "EKU9003173C9",
      regime: "601",
      postalCode: "01000",
      timezone: TZ,
    });
  });
  it("the shared issuer is taken as a whole or not at all (LD-55 CFDIFIX-FISCAL-6): a missing fact means the profile's three, never a mix of two taxpayers", () => {
    // Régimen 626 reported but the RFC not: the profile's RFC (a persona física) must not meet
    // the shared organization's régimen in the RESICO decision.
    for (const missing of [
      { legalName: null, taxId: null, regime: "626", postalCode: "01000" },
      {
        legalName: null,
        taxId: "EKU9003173C9",
        regime: null,
        postalCode: "01000",
      },
      {
        legalName: null,
        taxId: "EKU9003173C9",
        regime: "601",
        postalCode: null,
      },
    ])
      expect(
        stampingFacts(facts, platform(missing), { source: "shared_sandbox" }),
      ).toMatchObject({
        rfc: "XIQB891116QE4",
        regime: "626",
        postalCode: "42501",
      });
    expect(sharedIssuerComplete(null)).toBe(false);
    expect(
      sharedIssuerComplete({
        legalName: null,
        taxId: "EKU9003173C9",
        regime: "601",
        postalCode: "01000",
      }),
    ).toBe(true);
  });
  it("the worker publishes only facts with the shape cfdi_platform accepts (036 CHECKs)", () => {
    const org = (legal: Record<string, unknown> | null) =>
      sharedIssuerOf({
        id: "org1",
        is_production_ready: false,
        pending_steps: [],
        legal: legal as never,
      } as never);
    expect(
      org({
        legal_name: " PLATAFORMA DE PRUEBA ",
        tax_id: "eku9003173c9",
        tax_system: "601",
        address: { zip: "01000" },
      }),
    ).toEqual({
      legalName: "PLATAFORMA DE PRUEBA",
      taxId: "EKU9003173C9",
      regime: "601",
      postalCode: "01000",
    });
    expect(
      org({
        legal_name: "",
        tax_id: "NOT AN RFC",
        tax_system: "60",
        address: { zip: "1000" },
      }),
    ).toEqual({ legalName: null, taxId: null, regime: null, postalCode: null });
    expect(org(null)).toEqual({
      legalName: null,
      taxId: null,
      regime: null,
      postalCode: null,
    });
  });
});

describe("LD-51 F7: a cancellation acuse counts only when it names the document", () => {
  const uuid = "6A90CEEC-1D2E-4F3A-9B8C-7D6E5F4A3B2C";
  const bytes = (s: string) => new TextEncoder().encode(s);
  const sat = (named: string) =>
    bytes(
      `<?xml version="1.0" encoding="utf-8"?><Acuse xmlns:xsd="http://www.w3.org/2001/XMLSchema" Fecha="2026-10-07T12:00:00" RfcEmisor="EKU9003173C9">` +
        `<Folios xmlns="http://cancelacfd.sat.gob.mx"><UUID>${named}</UUID><EstatusUUID>201</EstatusUUID></Folios>` +
        `<Signature Id="SelloSAT" xmlns="http://www.w3.org/2000/09/xmldsig#"><SignatureValue>x</SignatureValue></Signature></Acuse>`,
    );

  it("reads Folios/UUID in SAT's namespace, a prefixed element and a UUID attribute; EstatusUUID never counts", () => {
    expect(acuseUuids(sat(uuid.toLowerCase()))).toEqual([uuid]);
    expect(
      acuseUuids(
        bytes(
          `<s:Acuse xmlns:s="urn:x"><s:Folios><s:UUID> ${uuid} </s:UUID><s:EstatusUUID>201</s:EstatusUUID></s:Folios></s:Acuse>`,
        ),
      ),
    ).toEqual([uuid]);
    expect(
      acuseUuids(
        bytes(`<Acuse><Folios UUID="${uuid}" EstatusUUID="201"/></Acuse>`),
      ),
    ).toEqual([uuid]);
  });
  it("matches the document's UUID in any case, and refuses another CFDI's (Facturapi's test-mode sample)", () => {
    expect(acuseMatches(sat(uuid), uuid.toLowerCase())).toBe(true);
    expect(
      acuseMatches(sat("1A2B3C4D-0000-4000-8000-0000000000AA"), uuid),
    ).toBe(false);
    expect(acuseMatches(sat(uuid), null)).toBe(false);
  });
  it("a file that is not UTF-8, declares a DTD or names nothing matches nothing", () => {
    expect(acuseUuids(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual([]);
    expect(
      acuseUuids(
        bytes(
          `<!DOCTYPE Acuse [<!ENTITY u "${uuid}">]><Acuse><UUID>&u;</UUID></Acuse>`,
        ),
      ),
    ).toEqual([]);
    expect(acuseUuids(bytes("%PDF-1.4"))).toEqual([]);
  });
});

describe("LD-51 F12 / LD-55: the issuance tick's key and time", () => {
  const order = "6a90ceec-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
  it("one bucket per 30 minutes; the key carries the issuing order (only that operation can meet it, CFDIFIX-CONCURRENCY-1), short enough for the jobs table", () => {
    const key = dedupe.tickIssued(new Date("2026-10-07T18:43:10Z"), order);
    expect(key).toBe(`tick:issued:2026-10-07T18:30:${order}`);
    expect(
      key.startsWith(issuedTickPrefix(new Date("2026-10-07T18:30:00Z"))),
    ).toBe(true);
    expect(
      key.startsWith(issuedTickPrefix(new Date("2026-10-07T18:59:59Z"))),
    ).toBe(true);
    expect(
      key.startsWith(issuedTickPrefix(new Date("2026-10-07T19:00:00Z"))),
    ).toBe(false);
    expect(key.length).toBeLessThanOrEqual(200);
  });
  it("the tick is due 10 minutes after its bucket ends, never at once (CFDIFIX-FISCAL-4, OPS-2)", () => {
    expect(
      issuedTickRunAt(new Date("2026-10-07T18:43:10Z")).toISOString(),
    ).toBe("2026-10-07T19:10:00.000Z");
    expect(
      issuedTickRunAt(new Date("2026-10-07T18:30:00Z")).toISOString(),
    ).toBe("2026-10-07T19:10:00.000Z");
    expect(
      issuedTickRunAt(new Date("2026-10-07T18:59:59.999Z")).toISOString(),
    ).toBe("2026-10-07T19:10:00.000Z");
  });
});

describe("LD-51 F13: Facturapi's log id and the job's one info line", () => {
  const org = {
    id: "5a2a307be93a2f00129ea035",
    is_production_ready: false,
    pending_steps: [],
  };
  const clientWith = (
    headers: Record<string, string>,
    seen: { logId: string | null; status: number }[],
    observer?: () => void,
  ) =>
    createFacturapiClient({
      baseUrl: "http://127.0.0.1:4799/v2",
      fetch: (async () =>
        new Response(JSON.stringify(org), {
          status: 200,
          headers: { "content-type": "application/json", ...headers },
        })) as typeof fetch,
      onResponse: (m) => {
        seen.push(m);
        observer?.();
      },
    });
  const key = { kind: "test" as const, secret: "sk_test_cfdifix" };

  it("an error answer reports its X-Facturapi-Log-Id too, and the error carries it (LD-55 CFDIFIX-OPS-1)", async () => {
    const seen: { logId: string | null; status: number }[] = [];
    const client = createFacturapiClient({
      baseUrl: "http://127.0.0.1:4799/v2",
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: false, message: "RFC inválido", status: 400 }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-facturapi-log-id": "log_refused_1",
            },
          },
        )) as typeof fetch,
      onResponse: (m) => seen.push(m),
    });
    const error = await client.me(key).catch((e: unknown) => e);
    expect(seen).toEqual([{ logId: "log_refused_1", status: 400 }]);
    expect((error as { logId?: string }).logId).toBe("log_refused_1");
    expect(classifyFacturapiError(error).logId).toBe("log_refused_1");
  });
  it("every 2xx answer reports its X-Facturapi-Log-Id; none, or one that is not a token, reads null", async () => {
    const seen: { logId: string | null; status: number }[] = [];
    await clientWith({ "x-facturapi-log-id": "log_abc123" }, seen).me(key);
    await clientWith({}, seen).me(key);
    await clientWith({ "x-facturapi-log-id": "sk_test secret here" }, seen).me(
      key,
    );
    expect(seen).toEqual([
      { logId: "log_abc123", status: 200 },
      { logId: null, status: 200 },
      { logId: null, status: 200 },
    ]);
  });
  it("an observer that throws never breaks the call", async () => {
    const answer = await clientWith(
      { "x-facturapi-log-id": "log_1" },
      [],
      () => {
        throw new Error("observer");
      },
    ).me(key);
    expect(answer.id).toBe(org.id);
  });

  const run = async (
    outcome: JobOutcome,
    body: () => void,
    payload: Record<string, unknown> = {
      documentId: "d0c00000-0000-4000-8000-000000000001",
    },
    message = "cfdi_job_done",
  ) => {
    const lines: { message: string; attrs: Record<string, unknown> }[] = [];
    const ctx = {
      job: {
        id: "j1",
        kind: "cfdi_stamp",
        tenantId: "t1",
        payload,
        attempts: 1,
      },
      log: {
        info: (message: string, attrs: Record<string, unknown> = {}) =>
          lines.push({ message, attrs }),
        debug: () => {},
        warn: () => {},
        error: () => {},
        child() {
          return this;
        },
      },
    } as unknown as JobContext;
    const handler = traced(async () => {
      body();
      await Promise.resolve();
      recordProviderResponse({ logId: "log_after_await" });
      return outcome;
    });
    expect(await handler(ctx)).toEqual(outcome);
    return lines.filter((l) => l.message === message);
  };

  it("a job that ends done logs one info line: its document, payload ids and every answer's log id", async () => {
    const lines = await run({ status: "done" }, () =>
      recordProviderResponse({ logId: "log_first" }),
    );
    expect(lines).toEqual([
      {
        message: "cfdi_job_done",
        attrs: {
          documentId: "d0c00000-0000-4000-8000-000000000001",
          outcome: "ok",
          facturapiLogIds: ["log_first", "log_after_await"],
        },
      },
    ]);
    const cancel = await run(
      { status: "done" },
      () => traceDocument("d0c00000-0000-4000-8000-000000000002"),
      { cancellationId: "c4a00000-0000-4000-8000-000000000001" },
    );
    expect(cancel[0].attrs).toMatchObject({
      documentId: "d0c00000-0000-4000-8000-000000000002",
      cancellationId: "c4a00000-0000-4000-8000-000000000001",
    });
  });
  it("a retry, a dead job or a mere hand-over logs no such line", async () => {
    expect(
      await run({ status: "retry", code: "cfdi_provider_timeout" }, () => {}),
    ).toEqual([]);
    expect(
      await run({ status: "dead", code: "cfdi_attempts_exhausted" }, () => {}),
    ).toEqual([]);
    expect(await run({ status: "done" }, () => traceQuiet())).toEqual([]);
  });
  it("a job that failed its document (done), retries or dies logs cfdi_job_failed with its outcome, code and the refused answer's log id, never cfdi_job_done (LD-55 CFDIFIX-OPS-1)", async () => {
    const refused = () => {
      recordProviderResponse({ logId: "log_refused", status: 400 });
      traceFailure("cfdi_receptor_rfc_invalid", "log_refused");
    };
    expect(await run({ status: "done" }, refused)).toEqual([]);
    const failed = await run(
      { status: "done" },
      refused,
      undefined,
      "cfdi_job_failed",
    );
    expect(failed).toEqual([
      {
        message: "cfdi_job_failed",
        attrs: {
          documentId: "d0c00000-0000-4000-8000-000000000001",
          outcome: "document_failed",
          code: "cfdi_receptor_rfc_invalid",
          logId: "log_refused",
          facturapiLogIds: ["log_refused", "log_after_await"],
        },
      },
    ]);
    const retry = await run(
      { status: "retry", code: "cfdi_provider_unavailable" },
      () => recordProviderResponse({ logId: "log_503", status: 503 }),
      undefined,
      "cfdi_job_failed",
    );
    expect(retry[0].attrs).toMatchObject({
      outcome: "retry",
      code: "cfdi_provider_unavailable",
      logId: "log_503",
    });
    const dead = await run(
      { status: "dead", code: "cfdi_attempts_exhausted" },
      () => {},
      undefined,
      "cfdi_job_failed",
    );
    expect(dead[0].attrs).toMatchObject({
      outcome: "dead",
      code: "cfdi_attempts_exhausted",
      logId: null,
    });
    expect(
      await run(
        { status: "done" },
        () => traceQuiet(),
        undefined,
        "cfdi_job_failed",
      ),
    ).toEqual([]);
  });
  it("outside a job a log id goes nowhere", () => {
    expect(() => recordProviderResponse({ logId: "log_x" })).not.toThrow();
  });
});
