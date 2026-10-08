// cfdi (030) unit tests 1-8 (spec §7.1): shared/cfdi.ts rules shared by web, worker and client.
// Pure: no database, no network.
import { describe, expect, it } from "vitest";
import {
  cfdiSettingsInput,
  firstOfNextMonth,
  firstReceptorError,
  formatTicketCode,
  globalPeriodFor,
  maskEmail,
  maskRfc,
  needsCardForm,
  nextPeriod,
  normalizeTicketCode,
  paymentFormFor,
  PERIOD_KEY,
  periodClosesAt,
  periodicityOn,
  receptorInput,
  receptorIssues,
  regimesFor,
  resicoWithholds,
  selfInvoiceDeadline,
  cancellationAllowed,
  cancellationDeadline,
  usesFor,
  usoCfdiAllowed,
  type Receptor,
} from "../shared/cfdi";
import { boundaries, businessDate } from "../shared/domain";
import {
  browserZoneWhereDailyEndsFirst,
  dailyEndsFirst,
  dayThreeOrLater,
  KIRITIMATI,
  MEXICO_CITY,
  PIN_HOLD_MS,
  zoneWhere,
} from "./fixtures/business-date-zones";

const receptor = (r: Partial<Receptor> = {}): Receptor =>
  receptorInput.parse({
    rfc: "URE180429TM6",
    legalName: "UNIVERSIDAD ROBOTICA ESPAÑOLA",
    regime: "601",
    postalCode: "86991",
    use: "G03",
    email: null,
    ...r,
  });
const codes = (r: Receptor, requireEmail = false) =>
  receptorIssues(r, { requireEmail }).map((i) => i.code);

describe("1. usoCfdiAllowed (shared/sat.ts, re-exported by shared/cfdi.ts)", () => {
  it("G01/G02/G03 only for business regimes; S01 for every receptor regime; 616 only S01; unknown uses refused", () => {
    for (const use of ["G01", "G02", "G03"]) {
      expect(usoCfdiAllowed("601", use)).toBe(true);
      expect(usoCfdiAllowed("626", use)).toBe(true);
      expect(usoCfdiAllowed("605", use)).toBe(false);
      expect(usoCfdiAllowed("616", use)).toBe(false);
    }
    for (const regime of ["601", "605", "616", "626"])
      expect(usoCfdiAllowed(regime, "S01")).toBe(true);
    expect(usoCfdiAllowed("601", "CP01")).toBe(false);
    expect(usesFor("616")).toEqual(["S01"]);
    expect(usesFor("612")).toEqual(["G03", "G01", "S01"]);
  });
});

describe("2. receptorIssues", () => {
  it("accepts a valid moral receptor with no issue", () => {
    expect(receptorIssues(receptor(), { requireEmail: false })).toEqual([]);
  });
  it("refuses the generic RFCs with cfdi_generic_rfc and malformed RFCs with cfdi_invalid_rfc", () => {
    expect(codes(receptor({ rfc: "XAXX010101000", regime: "616" }))).toContain(
      "cfdi_generic_rfc",
    );
    expect(codes(receptor({ rfc: "xexx010101000" }))).toContain(
      "cfdi_generic_rfc",
    );
    expect(codes(receptor({ rfc: "ABC" }))).toContain("cfdi_invalid_rfc");
    expect(codes(receptor({ rfc: "URE18O429TM6" }))).toContain(
      "cfdi_invalid_rfc",
    );
  });
  it("checks the régimen against the RFC kind and the uso against the régimen", () => {
    // 12-character RFC is a persona moral: 605 (sueldos) is física only.
    expect(codes(receptor({ regime: "605", use: "S01" }))).toEqual([
      "cfdi_regime_mismatch",
    ]);
    expect(codes(receptor({ regime: "999" }))).toContain("cfdi_invalid_regime");
    // A persona física (13 characters) in 612 may use G01; in 605 only S01.
    const fisica = receptor({
      rfc: "XIQB891116QE4",
      legalName: "BERENICE XIMO QUEZADA",
      regime: "605",
      use: "G03",
    });
    expect(codes(fisica)).toEqual(["cfdi_use_not_allowed"]);
    expect(regimesFor("XIQB891116QE4")).toContain("605");
    expect(regimesFor("URE180429TM6")).not.toContain("605");
  });
  it("checks the postal code and requires an email only in the portal", () => {
    expect(codes(receptor({ postalCode: "1234" }))).toEqual([
      "cfdi_invalid_postal_code",
    ]);
    expect(codes(receptor(), true)).toEqual(["cfdi_email_required"]);
    expect(codes(receptor({ email: "no-at-sign" }))).toEqual([
      "cfdi_invalid_email",
    ]);
    expect(codes(receptor({ email: "a@example.com" }), true)).toEqual([]);
  });
  it("the legal-name company suffix and the RFC check digit are warnings only", () => {
    const issues = receptorIssues(
      receptor({ legalName: "UNIVERSIDAD ROBOTICA ESPAÑOLA S.A. DE C.V." }),
      { requireEmail: false },
    );
    expect(issues).toEqual([
      { field: "legalName", code: "cfdiLegalNameSuffix", warning: true },
    ]);
    // Same pattern with a wrong homoclave digit: a warning, never a refusal.
    const digit = receptorIssues(receptor({ rfc: "URE180429TM5" }), {
      requireEmail: false,
    });
    expect(digit).toEqual([
      { field: "rfc", code: "cfdiRfcCheckDigit", warning: true },
    ]);
    expect(
      firstReceptorError(receptor({ rfc: "URE180429TM5" }), {
        requireEmail: false,
      }),
    ).toBeNull();
    expect(codes(receptor({ legalName: "   " }))).toEqual([
      "cfdi_invalid_legal_name",
    ]);
  });
  it("normalizes input: uppercase RFC, collapsed spaces, lowercase email", () => {
    const r = receptor({
      rfc: " ure180429tm6 ",
      legalName: "  UNIVERSIDAD   ROBOTICA  ESPAÑOLA ",
      email: " Facturas@Example.COM ",
    });
    expect(r.rfc).toBe("URE180429TM6");
    expect(r.legalName).toBe("UNIVERSIDAD ROBOTICA ESPAÑOLA");
    expect(r.email).toBe("facturas@example.com");
    expect(() =>
      receptorInput.parse({ ...r, extra: true } as unknown),
    ).toThrow();
  });
});

describe("3. globalPeriodFor", () => {
  it("day, fortnight and month periods with Meses and Año", () => {
    expect(globalPeriodFor("2026-10-04", "day")).toEqual({
      key: "D2026-10-04",
      periodicity: "day",
      from: "2026-10-04",
      to: "2026-10-04",
      months: "10",
      year: 2026,
    });
    expect(globalPeriodFor("2026-10-15", "fortnight")).toMatchObject({
      key: "F2026-10-1",
      from: "2026-10-01",
      to: "2026-10-15",
    });
    expect(globalPeriodFor("2026-10-16", "fortnight")).toMatchObject({
      key: "F2026-10-2",
      from: "2026-10-16",
      to: "2026-10-31",
    });
    expect(globalPeriodFor("2027-02-10", "fortnight")).toMatchObject({
      to: "2027-02-15",
    });
    expect(globalPeriodFor("2028-02-20", "fortnight")).toMatchObject({
      to: "2028-02-29",
    });
    expect(globalPeriodFor("2026-01-31", "month")).toEqual({
      key: "M2026-01",
      periodicity: "month",
      from: "2026-01-01",
      to: "2026-01-31",
      months: "01",
      year: 2026,
    });
  });
  it("week is Monday–Sunday clipped to the month: 2026-09-28..30 and 2026-10-01..04 are two periods", () => {
    const september = globalPeriodFor("2026-09-30", "week");
    const october = globalPeriodFor("2026-10-02", "week");
    expect(september).toMatchObject({
      key: "W2026-09-28",
      from: "2026-09-28",
      to: "2026-09-30",
      months: "09",
    });
    expect(october).toMatchObject({
      key: "W2026-10-01",
      from: "2026-10-01",
      to: "2026-10-04",
      months: "10",
    });
    expect(globalPeriodFor("2026-10-07", "week")).toMatchObject({
      key: "W2026-10-05",
      from: "2026-10-05",
      to: "2026-10-11",
    });
    expect(nextPeriod(september, "week").key).toBe("W2026-10-01");
    expect(nextPeriod(october, "week").key).toBe("W2026-10-05");
  });
  it("every key matches the database period_key pattern and periods tile the calendar", () => {
    for (const p of ["day", "week", "fortnight", "month"] as const) {
      let period = globalPeriodFor("2026-01-01", p);
      let seen = 0;
      while (period.from < "2027-01-01") {
        expect(period.key).toMatch(PERIOD_KEY);
        expect(period.from.slice(0, 7)).toBe(period.to.slice(0, 7));
        const next = nextPeriod(period, p);
        const gap =
          (Date.parse(next.from) - Date.parse(period.to)) / 86_400_000;
        expect(gap).toBe(1);
        period = next;
        seen++;
      }
      expect(seen).toBeGreaterThanOrEqual(12);
    }
    expect(() => globalPeriodFor("2026-13-01", "day")).toThrow();
  });
});

describe("4. periodClosesAt", () => {
  it("closes at the business-day cutoff after the last date, in the restaurant timezone", () => {
    const period = globalPeriodFor("2026-10-04", "day");
    expect(periodClosesAt(period, "America/Mexico_City", 240)).toBe(
      boundaries("2026-10-04", "America/Mexico_City", 240).end,
    );
    // Mexico City has no DST since 2022: 04:00 local = 10:00Z.
    expect(periodClosesAt(period, "America/Mexico_City", 240)).toBe(
      "2026-10-05T10:00:00Z",
    );
  });
  it("follows Tijuana's DST (UTC−7 in summer, UTC−8 in winter)", () => {
    expect(
      periodClosesAt(
        globalPeriodFor("2026-07-15", "day"),
        "America/Tijuana",
        0,
      ),
    ).toBe("2026-07-16T07:00:00Z");
    expect(
      periodClosesAt(
        globalPeriodFor("2026-12-15", "day"),
        "America/Tijuana",
        0,
      ),
    ).toBe("2026-12-16T08:00:00Z");
    // Month period closing on the night DST ends (2026-11-01 in Tijuana).
    expect(
      periodClosesAt(
        globalPeriodFor("2026-10-20", "month"),
        "America/Tijuana",
        120,
      ),
    ).toBe("2026-11-01T10:00:00Z");
  });
});

describe("5. periodicityOn", () => {
  it("switches on next_periodicity_from (first of next month) and never mid-month", () => {
    const s = {
      globalPeriodicity: "month" as const,
      nextPeriodicity: "day" as const,
      nextPeriodicityFrom: firstOfNextMonth("2026-10-17"),
    };
    expect(s.nextPeriodicityFrom).toBe("2026-11-01");
    expect(periodicityOn("2026-10-31", s)).toBe("month");
    expect(periodicityOn("2026-11-01", s)).toBe("day");
    expect(firstOfNextMonth("2026-12-31")).toBe("2027-01-01");
    expect(
      periodicityOn("2026-11-02", {
        globalPeriodicity: "week",
        nextPeriodicity: null,
        nextPeriodicityFrom: null,
      }),
    ).toBe("week");
  });
});

describe("CFDI-SAT-3: CFF art. 29-A cancellation deadline", () => {
  const MX = "America/Mexico_City";
  it("persona moral (12-character RFC): until the end of March of the next year, local time", () => {
    expect(
      cancellationDeadline("2026-11-20T18:00:00Z", "EKU9003173C9", MX),
    ).toBe("2027-04-01T06:00:00Z");
    expect(
      cancellationAllowed(
        "2026-11-20T18:00:00Z",
        "EKU9003173C9",
        MX,
        new Date("2027-04-01T05:59:59Z"),
      ),
    ).toBe(true);
    expect(
      cancellationAllowed(
        "2026-11-20T18:00:00Z",
        "EKU9003173C9",
        MX,
        new Date("2027-04-01T06:00:00Z"),
      ),
    ).toBe(false);
  });
  it("persona física (13 characters): until the end of April; an unknown RFC takes March", () => {
    expect(
      cancellationDeadline("2026-03-02T18:00:00Z", "GODE561231GR8", MX),
    ).toBe("2027-05-01T06:00:00Z");
    expect(cancellationDeadline("2026-03-02T18:00:00Z", null, MX)).toBe(
      "2027-04-01T06:00:00Z",
    );
  });
  it("the stamp year is the restaurant's local year: 31 December 23:30 in Mexico City is 2026", () => {
    expect(
      cancellationDeadline("2027-01-01T05:30:00Z", "EKU9003173C9", MX),
    ).toBe("2027-04-01T06:00:00Z");
    expect(cancellationAllowed(null, "EKU9003173C9", MX)).toBe(true);
  });
});

describe("6. selfInvoiceDeadline", () => {
  it("month policy ends 23:59:59.999 local on the last day of the purchase month", () => {
    expect(
      selfInvoiceDeadline("2026-10-04", "month", 30, "America/Mexico_City"),
    ).toBe("2026-11-01T05:59:59.999Z");
  });
  it("days policy counts from the business date; February of a leap year", () => {
    expect(
      selfInvoiceDeadline("2026-10-04", "days", 3, "America/Mexico_City"),
    ).toBe("2026-10-08T05:59:59.999Z");
    expect(
      selfInvoiceDeadline("2028-02-10", "month", 30, "America/Mexico_City"),
    ).toBe("2028-03-01T05:59:59.999Z");
    expect(
      selfInvoiceDeadline("2027-02-10", "month", 30, "America/Mexico_City"),
    ).toBe("2027-03-01T05:59:59.999Z");
  });
});

describe("7. normalizeTicketCode / formatTicketCode", () => {
  it("strips dashes and spaces, uppercases, maps O→0 and I/L→1, rejects wrong length or alphabet", () => {
    expect(normalizeTicketCode("7k3m-9qx2-pa8d")).toBe("7K3M9QX2PA8D");
    expect(normalizeTicketCode(" 7K3M 9QX2 PA8D ")).toBe("7K3M9QX2PA8D");
    expect(normalizeTicketCode("OOOO-IIII-LLLL")).toBe("000011111111");
    expect(normalizeTicketCode("7K3M-9QX2-PA8")).toBeNull();
    expect(normalizeTicketCode("7K3M-9QX2-PA8U")).toBeNull();
    expect(formatTicketCode("7K3M9QX2PA8D")).toBe("7K3M-9QX2-PA8D");
  });
  it("masks RFCs and emails for the public portal", () => {
    expect(maskRfc("URE180429TM6")).toBe("URE******TM6");
    expect(maskEmail("juan.perez@example.com")).toBe("j***@example.com");
    expect(maskEmail(null)).toBeNull();
  });
});

describe("8. paymentFormFor / needsCardForm", () => {
  it("the largest amount wins; a tie takes the earliest tender; external maps to the card form", () => {
    expect(
      paymentFormFor(
        [
          { method: "cash", amount: 100 },
          { method: "external", amount: 300 },
        ],
        "28",
      ),
    ).toBe("28");
    expect(
      paymentFormFor(
        [
          { method: "external", amount: 200 },
          { method: "cash", amount: 200 },
        ],
        "04",
      ),
    ).toBe("04");
    expect(
      paymentFormFor(
        [
          { method: "cash", amount: 150 },
          { method: "external", amount: 100 },
          { method: "external", amount: 100 },
        ],
        "04",
      ),
    ).toBe("04");
    expect(paymentFormFor([], "04")).toBe("01");
  });
  it("needsCardForm only when a card tender decides the form", () => {
    expect(needsCardForm([{ method: "cash", amount: 500 }])).toBe(false);
    expect(
      needsCardForm([
        { method: "cash", amount: 500 },
        { method: "external", amount: 100 },
      ]),
    ).toBe(false);
    expect(needsCardForm([{ method: "external", amount: 1 }])).toBe(true);
  });
});

describe("RESICO withholding rule (LD-16 L9)", () => {
  it("only a persona física in 626 invoicing a persona moral", () => {
    const resico = { regime: "626", rfc: "XIQB891116QE4" };
    expect(resicoWithholds(resico, "URE180429TM6")).toBe(true);
    expect(resicoWithholds(resico, "XIQB891116QE4")).toBe(false);
    expect(resicoWithholds(resico, "XAXX010101000")).toBe(false);
    expect(
      resicoWithholds({ regime: "626", rfc: "URE180429TM6" }, "EKU9003173C9"),
    ).toBe(false);
    expect(
      resicoWithholds({ regime: "612", rfc: "XIQB891116QE4" }, "EKU9003173C9"),
    ).toBe(false);
    expect(resicoWithholds({ regime: null, rfc: null }, "EKU9003173C9")).toBe(
      false,
    );
  });
});

describe("settings input", () => {
  it("is strict and normalizes the support email", () => {
    const parsed = cfdiSettingsInput.parse({
      operationId: "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
      expectedVersion: 1,
      enabled: true,
      globalPeriodicity: "month",
      globalAuto: true,
      conceptMode: "grouped",
      conceptDescription: "Consumo de alimentos y bebidas",
      cardPaymentForm: "04",
      defaultUse: "G03",
      selfInvoiceEnabled: true,
      selfInvoicePolicy: "month",
      selfInvoiceDays: 30,
      portalReissueGlobal: false,
      supportEmail: " Facturas@Example.com ",
    });
    expect(parsed.supportEmail).toBe("facturas@example.com");
    expect(() =>
      cfdiSettingsInput.parse({ ...parsed, defaultUse: "G02" }),
    ).toThrow();
    expect(() =>
      cfdiSettingsInput.parse({ ...parsed, selfInvoiceDays: 91 }),
    ).toThrow();
  });
});

describe("CFDIFIX-R2-6: date-bound checks pin their business date, never skip", () => {
  // Every 10 minutes over the two days before and after a month's start (UTC): a month, the year,
  // a short February and a leap one. Each moment reads several zones: a generous timeout.
  const around = (firstIso: string) =>
    Array.from(
      { length: (4 * 24 * 60) / 10 },
      (_, i) => Date.parse(firstIso) - 2 * 86_400_000 + i * 10 * 60_000,
    );
  const moments = [
    ...around("2026-11-01T00:00:00Z"),
    ...around("2027-01-01T00:00:00Z"),
    ...around("2027-03-01T00:00:00Z"),
    ...around("2028-03-01T00:00:00Z"),
  ];
  const slow = { timeout: 60_000 };
  const date = (ms: number, z: { timezone: string; cutoff: number }) =>
    businessDate(new Date(ms).toISOString(), z.timezone, z.cutoff);
  it(
    "the DB suite finds a zone for each rule at every moment, holding for the next 30 minutes",
    slow,
    () => {
      for (const now of moments)
        for (const rule of [dailyEndsFirst, dayThreeOrLater]) {
          const zone = zoneWhere(rule, { now });
          expect(zone, new Date(now).toISOString()).not.toBeNull();
          expect(rule(date(now, zone!), zone!)).toBe(true);
          expect(rule(date(now + PIN_HOLD_MS, zone!), zone!)).toBe(true);
        }
    },
  );
  it(
    "the browser check pins only ahead of the demo restaurant's date (activation dates its start), at 04:00 or global-setup's 10:00",
    slow,
    () => {
      for (const cutoff of [240, 600]) {
        const demo = { ...MEXICO_CITY, cutoff };
        for (const now of moments) {
          const zone = browserZoneWhereDailyEndsFirst(demo, now);
          const at = `${cutoff} ${new Date(now).toISOString()}`;
          expect(zone, at).not.toBeNull();
          expect(date(now, zone!) >= date(now, demo), at).toBe(true);
          for (const t of [now, now + PIN_HOLD_MS])
            expect(dailyEndsFirst(date(t, zone!), zone!), at).toBe(true);
          // On a month's last day the demo zone cannot run it: Kiritimati's 1st or 2nd does.
          if (!dailyEndsFirst(date(now, demo), demo))
            expect(zone, at).toEqual(KIRITIMATI);
        }
      }
    },
  );
});
