import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config-rules.js";

const web = {
  DATABASE_URL: "postgresql://gm_app:pw@127.0.0.1:5432/green_monkey_dev",
  JWT_SECRET: "x".repeat(40),
};

describe("FISCAL_TICKETS_ENABLED (fiscal 027 kill switch, contract C-9)", () => {
  it("accepts true, false, empty and unset on web", () => {
    for (const value of ["true", "false", "", undefined])
      expect(() =>
        loadConfig({ ...web, FISCAL_TICKETS_ENABLED: value }, "web"),
      ).not.toThrow();
  });

  it("refuses any other value at startup, naming the variable, never the value", () => {
    for (const value of ["False", "0", "no", "off", " true"])
      expect(() =>
        loadConfig({ ...web, FISCAL_TICKETS_ENABLED: value }, "web"),
      ).toThrow("invalid_fiscal_tickets_enabled");
  });
});
