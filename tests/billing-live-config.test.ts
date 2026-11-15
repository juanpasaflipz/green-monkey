import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config-rules.js";

// Fictional values only: a made-up entity, SAT's public test RFC and fixture keys.
const signingKeys = `k1:${Buffer.alloc(32, 7).toString("base64url")}`;
const billingUrl =
  "postgresql://gm_production_billing:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_production";
const legal = {
  LEGAL_ENTITY_NAME: "Mango Azul Servicios Digitales",
  LEGAL_ENTITY_ADDRESS:
    "Avenida Los Pinos 45, Col. Moderna, 03510 Ciudad de México, CDMX",
  LEGAL_ENTITY_RFC: "EKU9003173C9",
  LEGAL_PRIVACY_CONTACT_EMAIL: "privacidad@mangoazul.mx",
  LEGAL_JURISDICTION: "Ciudad de México",
};
const production = {
  APP_ENV: "production",
  NODE_ENV: "production",
  APP_URL: "https://app.example.com",
};
const liveWeb = {
  ...production,
  DATABASE_URL:
    "postgresql://gm_production_app:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_production",
  JWT_SECRET: "x".repeat(40),
  SIGNING_KEYS: signingKeys,
  BILLING_LIVE_ENABLED: "true",
  BILLING_DATABASE_URL: billingUrl,
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  SAAS_TAX_MODE: "tax_rate",
};
const liveWorker = {
  ...production,
  PROCESS_KIND: "worker",
  WORKER_DATABASE_URL:
    "postgresql://gm_production_worker:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_production",
  BILLING_LIVE_ENABLED: "true",
  BILLING_DATABASE_URL: billingUrl,
  STRIPE_SECRET_KEY: "sk_live_x",
  STRIPE_EXPECTED_ACCOUNT_ID: "acct_x",
  STRIPE_PRICE_PRO_MONTHLY: "price_m",
  STRIPE_PRICE_PRO_ANNUAL: "price_y",
  STRIPE_PORTAL_CONFIG_ID: "bpc_x",
  SAAS_TAX_MODE: "tax_rate",
  STRIPE_TAX_RATE_ID: "txr_x",
  ...legal,
};

describe("live billing configuration", () => {
  it("starts web and worker with a complete live configuration", () => {
    const web = loadConfig(liveWeb, "web");
    expect(web.billingMode).toBe("live");
    expect(web.billingDatabaseUrl).toContain("gm_production_billing");
    expect(loadConfig(liveWorker, "worker").billingMode).toBe("live");
  });
  it("refuses live billing outside production", () => {
    expect(() =>
      loadConfig({ ...liveWorker, APP_ENV: "staging" }, "worker"),
    ).toThrow("billing_live_production_only");
  });
  it("refuses both billing switches at once", () => {
    expect(() =>
      loadConfig({ ...liveWorker, BILLING_SANDBOX_ENABLED: "true" }, "worker"),
    ).toThrow("billing_mode_conflict");
  });
  it("refuses a test key with live billing and a live key with sandbox billing", () => {
    expect(() =>
      loadConfig({ ...liveWorker, STRIPE_SECRET_KEY: "sk_test_x" }, "worker"),
    ).toThrow("stripe_live_key_required");
    const { BILLING_LIVE_ENABLED: _live, ...rest } = liveWorker;
    expect(() =>
      loadConfig({ ...rest, BILLING_SANDBOX_ENABLED: "true" }, "worker"),
    ).toThrow("stripe_sandbox_key_required");
  });
  it("refuses live billing without IVA or without the legal entity's RFC on the worker", () => {
    expect(() =>
      loadConfig({ ...liveWorker, SAAS_TAX_MODE: "off" }, "worker"),
    ).toThrow("saas_tax_required_for_live_billing");
    const { LEGAL_ENTITY_RFC: _rfc, ...noRfc } = liveWorker;
    expect(() => loadConfig(noRfc, "worker")).toThrow(
      "saas_tax_required_for_live_billing",
    );
    const { LEGAL_ENTITY_NAME: _name, ...unpublished } = liveWorker;
    expect(() => loadConfig(unpublished, "worker")).toThrow(
      "saas_tax_required_for_live_billing",
    );
    expect(() =>
      loadConfig({ ...liveWeb, SAAS_TAX_MODE: "off" }, "web"),
    ).toThrow("saas_tax_required_for_live_billing");
  });
  it("still refuses the billing login on production web while billing is off", () => {
    const { BILLING_LIVE_ENABLED: _live, ...off } = liveWeb;
    expect(() => loadConfig(off, "web")).toThrow(
      "forbidden_credential_in_process: BILLING_DATABASE_URL",
    );
  });
});
