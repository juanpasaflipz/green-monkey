import { describe, expect, it } from "vitest";
import {
  assertSaasTaxReady,
  checkoutTaxParams,
  publicSaasTax,
  saasTaxConfig,
  trialTaxParams,
} from "../server/saas-tax";
import {
  accountWebConfig,
  accountWorkerConfig,
} from "../server/account-config";
import { legalConfig } from "../server/legal";

const legal = {
  LEGAL_ENTITY_NAME: "Restaurantes Unidos S.A. de C.V.",
  LEGAL_ENTITY_ADDRESS: "Av. Reforma 222, Juárez, 06600 Ciudad de México",
  LEGAL_PRIVACY_CONTACT_EMAIL: "privacidad@restaurantes-unidos.mx",
  LEGAL_JURISDICTION: "Ciudad de México",
};

describe("SaaS tax mode (GAP-6)", () => {
  it("off by default sends no tax params", () => {
    for (const env of [{}, { SAAS_TAX_MODE: "off" }, { SAAS_TAX_MODE: "" }]) {
      const c = saasTaxConfig(env, "worker");
      expect(c.mode).toBe("off");
      expect(trialTaxParams(c)).toEqual({});
      expect(checkoutTaxParams(c)).toEqual({});
      expect(c.collectTaxId).toBe(false);
    }
    expect(publicSaasTax(saasTaxConfig({}, "web"))).toEqual({
      mode: "off",
      ratePercent: null,
      collectTaxId: false,
      taxProfileEnabled: false,
      cfdiEnabled: false,
    });
  });

  it("tax_rate requires a txr id", () => {
    expect(() =>
      saasTaxConfig({ SAAS_TAX_MODE: "tax_rate" }, "worker"),
    ).toThrow("saas_tax_configuration_invalid");
    expect(() =>
      saasTaxConfig(
        { SAAS_TAX_MODE: "tax_rate", STRIPE_TAX_RATE_ID: "price_123" },
        "worker",
      ),
    ).toThrow("saas_tax_configuration_invalid");
    expect(() => saasTaxConfig({ SAAS_TAX_MODE: "stripe_tax" }, "web")).toThrow(
      "saas_tax_configuration_invalid",
    );
    const c = saasTaxConfig(
      { SAAS_TAX_MODE: "tax_rate", STRIPE_TAX_RATE_ID: "txr_1Abc" },
      "worker",
    );
    expect(trialTaxParams(c)).toEqual({ "default_tax_rates[0]": "txr_1Abc" });
  });

  it("collectTaxId defaults true in tax_rate", () => {
    const env = { SAAS_TAX_MODE: "tax_rate", STRIPE_TAX_RATE_ID: "txr_1Abc" };
    expect(checkoutTaxParams(saasTaxConfig(env, "worker"))).toEqual({
      "subscription_data[default_tax_rates][0]": "txr_1Abc",
      "tax_id_collection[enabled]": "true",
      "customer_update[name]": "auto",
      "customer_update[address]": "auto",
      billing_address_collection: "required",
    });
    expect(
      checkoutTaxParams(
        saasTaxConfig({ ...env, SAAS_COLLECT_TAX_ID: "false" }, "worker"),
      ),
    ).toEqual({ "subscription_data[default_tax_rates][0]": "txr_1Abc" });
  });

  it("web config never reads STRIPE_TAX_RATE_ID; worker config requires it in tax_rate mode", () => {
    const web = saasTaxConfig(
      {
        SAAS_TAX_MODE: "tax_rate",
        STRIPE_TAX_RATE_ID: "txr_1Abc",
        SAAS_TAX_PROFILE_ENABLED: "true",
      },
      "web",
    );
    expect(web).toEqual({
      mode: "tax_rate",
      taxRateId: null,
      collectTaxId: true,
      taxProfileEnabled: true,
    });
    expect(publicSaasTax(web).ratePercent).toBe(16);
    expect(() =>
      saasTaxConfig({ SAAS_TAX_MODE: "tax_rate" }, "web"),
    ).not.toThrow();
    expect(
      saasTaxConfig({ SAAS_TAX_PROFILE_ENABLED: "true" }, "worker")
        .taxProfileEnabled,
    ).toBe(false);
  });

  it("assertSaasTaxReady requires tax_rate + published entity + RFC", () => {
    const rate = { SAAS_TAX_MODE: "tax_rate", STRIPE_TAX_RATE_ID: "txr_1Abc" };
    const withRfc = legalConfig({ ...legal, LEGAL_ENTITY_RFC: "EKU9003173C9" });
    expect(() => assertSaasTaxReady(rate, withRfc)).not.toThrow();
    expect(() => assertSaasTaxReady({}, withRfc)).toThrow(
      "saas_tax_required_for_live_billing",
    );
    expect(() => assertSaasTaxReady(rate, legalConfig(legal))).toThrow(
      "saas_tax_required_for_live_billing",
    );
    expect(() => assertSaasTaxReady(rate, legalConfig({}))).toThrow(
      "saas_tax_required_for_live_billing",
    );
  });

  it("startup validators refuse what the modules would reject (C-9)", () => {
    expect(() => accountWebConfig({}, "development")).not.toThrow();
    expect(() =>
      accountWebConfig({ SAAS_TAX_MODE: "vat" }, "production"),
    ).toThrow("saas_tax_configuration_invalid");
    expect(() =>
      accountWorkerConfig({ SAAS_TAX_MODE: "tax_rate" }, "production"),
    ).toThrow("saas_tax_configuration_invalid");
    expect(() =>
      accountWorkerConfig(
        { SAAS_TAX_MODE: "tax_rate", STRIPE_TAX_RATE_ID: "txr_9" },
        "production",
      ),
    ).not.toThrow();
  });
});
