// cfdifix (LD-51): unit checks for the fixes from the real-sandbox CFDI rehearsal. Pure: no
// database, no network (the Facturapi client runs against a stubbed fetch).
//   F1 the self-invoicing deadline's global bound per periodicity, and when it prints its time;
//   F2 when a periodicity change may apply at once;
//   F3 the stamping issuer facts in the shared sandbox and what the worker publishes of them;
//   F7 the cancellation acuse's UUIDs;
//   F12 the issuance tick's key;
//   F13 the Facturapi log id of successful answers and the job's one info line.
import { describe, expect, it } from "vitest";
import {
  deadlineShowsTime,
  effectiveSelfInvoiceDeadline,
  globalBuildAt,
  periodicityChangeNow,
  type SelfInvoiceGlobalBound,
} from "../shared/cfdi";
import { dedupe } from "../server/cfdi/jobs";
import { stampingFacts, type FiscalFacts } from "../server/cfdi/store";
import { sharedIssuerOf } from "../server/cfdi/worker/org";
import { acuseMatches, acuseUuids } from "../server/cfdi/xml";
import { createFacturapiClient } from "../server/cfdi/facturapi";
import {
  recordProviderResponse,
  traceDocument,
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
  it("the receipt and the portal print the time when the deadline falls on the business date or the next day", () => {
    expect(deadlineShowsTime(window("day").deadline, date, TZ)).toBe(true);
    expect(deadlineShowsTime(window("week").deadline, date, TZ)).toBe(false);
    expect(
      deadlineShowsTime("2026-11-01T05:59:59.999Z", "2026-10-31", TZ),
    ).toBe(true);
    expect(deadlineShowsTime("2026-11-01T05:59:59.999Z", date, TZ)).toBe(false);
  });
});

describe("LD-51 F2: a periodicity change applies at once only on an unshaped month", () => {
  // 7 October 2026, 12:00 local (18:00Z): the business day of 7 Oct runs since 04:00.
  const now = new Date("2026-10-07T18:00:00Z");
  const change = (o: {
    hasGlobals?: boolean;
    dates?: string[];
    from: "day" | "week" | "fortnight" | "month";
    to: "day" | "week" | "fortnight" | "month";
  }) =>
    periodicityChangeNow({
      hasGlobals: o.hasGlobals ?? false,
      dates: o.dates ?? [],
      from: o.from,
      to: o.to,
      timezone: TZ,
      cutoff: 240,
      now,
    });

  it("no global of the month and no ticket: at once, either way", () => {
    expect(change({ from: "month", to: "day" })).toBe(true);
    expect(change({ from: "day", to: "month" })).toBe(true);
  });
  it("a global document of the month (any status): from next month", () => {
    expect(change({ hasGlobals: true, from: "month", to: "day" })).toBe(false);
  });
  it("a ticket of 5 Oct would sit in a daily period due 7 Oct 04:00, already past: from next month", () => {
    expect(change({ dates: ["2026-10-05"], from: "month", to: "day" })).toBe(
      false,
    );
  });
  it("an overdue daily period is never hidden in a monthly one: from next month", () => {
    expect(change({ dates: ["2026-10-05"], from: "day", to: "month" })).toBe(
      false,
    );
  });
  it("a ticket of yesterday (its daily global due tomorrow 04:00) or today: at once", () => {
    expect(
      change({ dates: ["2026-10-06", "2026-10-07"], from: "month", to: "day" }),
    ).toBe(true);
    expect(
      change({ dates: ["2026-10-06"], from: "week", to: "fortnight" }),
    ).toBe(true);
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
  it("a fact Facturapi did not report falls back to the profile's, one by one", () => {
    expect(
      stampingFacts(
        facts,
        platform({
          legalName: null,
          taxId: null,
          regime: "601",
          postalCode: null,
        }),
        { source: "shared_sandbox" },
      ),
    ).toMatchObject({
      rfc: "XIQB891116QE4",
      regime: "601",
      postalCode: "42501",
    });
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

describe("LD-51 F12: the issuance tick's key", () => {
  it("one key per 10-minute bucket, short enough for the jobs table", () => {
    const key = dedupe.tickIssued(new Date("2026-10-07T18:43:10Z"));
    expect(key).toBe("tick:issued:2026-10-07T18:40");
    expect(`${key}:6a90ceec`.length).toBeLessThanOrEqual(200);
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
    return lines.filter((l) => l.message === "cfdi_job_done");
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
  it("outside a job a log id goes nowhere", () => {
    expect(() => recordProviderResponse({ logId: "log_x" })).not.toThrow();
  });
});
