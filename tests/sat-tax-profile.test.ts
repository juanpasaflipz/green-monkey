import { describe, expect, it } from "vitest";
import { SAAS_CFDI_USES, taxProfileInput } from "../server/tax-profile";

const base = {
  organizationId: "10000000-0000-4000-8000-0000000000aa",
  expectedVersion: 0,
  rfc: "EKU9003173C9",
  legalName: "ESCUELA KEMPER URGATE",
  taxRegime: "601",
  postalCode: "06000",
  cfdiUse: "G03",
  invoiceEmail: "facturas@escuela-kemper.mx",
};
const issues = (value: unknown) => {
  const r = taxProfileInput.safeParse(value);
  return r.success
    ? []
    : [...new Set(r.error.issues.map((i) => i.path.join(".")))];
};

describe("SaaS billing profile validation (shared/sat.ts)", () => {
  it("accepts a valid persona moral profile and normalizes the RFC", () => {
    const r = taxProfileInput.parse({ ...base, rfc: " eku9003173c9 " });
    expect(r.rfc).toBe("EKU9003173C9");
  });

  it("tax profile schema uses shared/sat.ts: generic RFC refused, régimen/RFC kind mismatch refused, uso CFDI filtered by usoCfdiAllowed (616 → S01 only), G02 not offered", () => {
    expect(issues({ ...base, rfc: "XAXX010101000" })).toEqual(["rfc"]);
    expect(issues({ ...base, rfc: "EKU9013173C9" })).toEqual(["rfc"]);
    // 605 (sueldos y salarios) is persona física only.
    expect(issues({ ...base, taxRegime: "605" })).toEqual(["taxRegime"]);
    // A persona física under 616 may only use S01.
    const fisica = { ...base, rfc: "XIQB891116QE4", taxRegime: "616" };
    expect(issues({ ...fisica, cfdiUse: "G03" })).toEqual(["cfdiUse"]);
    expect(issues({ ...fisica, cfdiUse: "S01" })).toEqual([]);
    expect(SAAS_CFDI_USES).not.toContain("G02");
    expect(issues({ ...base, cfdiUse: "G02" })).toEqual(["cfdiUse"]);
    expect(issues({ ...base, postalCode: "0600" })).toEqual(["postalCode"]);
    expect(issues({ ...base, taxRegime: "999" })).toEqual(["taxRegime"]);
  });
});
