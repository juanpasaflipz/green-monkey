import { describe, expect, it } from "vitest";
import express from "express";
import { trustProxy } from "../server/http.js";

describe("trust proxy", () => {
  it("trusts only loopback and Railway's edge subnet in production", () => {
    expect(trustProxy({ NODE_ENV: "production" })).toBe(
      "loopback, 100.0.0.0/8",
    );
    expect(trustProxy({ NODE_ENV: "development" })).toBe(false);
  });

  it("accepts explicit hop counts, subnet lists or false, never blanket true", () => {
    expect(trustProxy({ TRUST_PROXY: "2" })).toBe(2);
    expect(trustProxy({ TRUST_PROXY: "10.0.0.0/8" })).toBe("10.0.0.0/8");
    expect(trustProxy({ NODE_ENV: "production", TRUST_PROXY: "false" })).toBe(
      false,
    );
    expect(() => trustProxy({ TRUST_PROXY: "true" })).toThrow();
  });

  it("derives the client from the proxy hop, ignoring spoofed left entries", () => {
    const app = express();
    app.set("trust proxy", trustProxy({ NODE_ENV: "production" }));
    const compile = app.get("trust proxy fn") as (
      addr: string,
      i: number,
    ) => boolean;
    expect(compile("100.64.0.7", 0)).toBe(true);
    expect(compile("203.0.113.9", 1)).toBe(false);
  });
});
