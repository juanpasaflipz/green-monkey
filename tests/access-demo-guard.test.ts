import { describe, expect, it } from "vitest";
import { assertDemoAccessAllowed } from "../server/access";

const demo = "10000000-0000-4000-8000-000000000001";
const refusal = /DEMO_TENANT_ID must not be set in production/;

describe("demo access production refusal (contracts D22)", () => {
  it("refuses DEMO_TENANT_ID in Railway's production environment, in any case", () => {
    expect(() =>
      assertDemoAccessAllowed({
        DEMO_TENANT_ID: demo,
        RAILWAY_ENVIRONMENT_NAME: "Production",
      }),
    ).toThrow(refusal);
  });

  it("refuses DEMO_TENANT_ID when the ops configuration says APP_ENV=production", () => {
    expect(() =>
      assertDemoAccessAllowed({ DEMO_TENANT_ID: demo, APP_ENV: "production" }),
    ).toThrow(refusal);
    expect(() =>
      assertDemoAccessAllowed({
        DEMO_TENANT_ID: demo,
        APP_ENV: "production",
        RAILWAY_ENVIRONMENT_NAME: "staging",
      }),
    ).toThrow(refusal);
  });

  it("allows it locally and on staging, and allows production without it", () => {
    expect(() =>
      assertDemoAccessAllowed({ DEMO_TENANT_ID: demo }),
    ).not.toThrow();
    expect(() =>
      assertDemoAccessAllowed({
        DEMO_TENANT_ID: demo,
        APP_ENV: "staging",
        RAILWAY_ENVIRONMENT_NAME: "staging",
      }),
    ).not.toThrow();
    expect(() =>
      assertDemoAccessAllowed({
        DEMO_TENANT_ID: " ",
        APP_ENV: "production",
        RAILWAY_ENVIRONMENT_NAME: "production",
      }),
    ).not.toThrow();
  });
});
