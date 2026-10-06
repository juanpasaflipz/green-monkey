import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  publicOrderingEnabled,
  publicOrderingGate,
} from "../server/account-settings";
import { accountWebConfig } from "../server/account-config";
import { loadConfig } from "../server/config-rules";
import { LINK_HEADER } from "../shared/public-ordering";

describe("PUBLIC_ORDERING_ENABLED interim switch (SEC-7 / FIT-11 / FOH-13)", () => {
  it("publicOrderingEnabled: unset is false when APP_ENV=production and true otherwise; explicit true/false win; other values throw public_ordering_flag_invalid", () => {
    expect(publicOrderingEnabled({})).toBe(true);
    expect(publicOrderingEnabled({ APP_ENV: "staging" })).toBe(true);
    expect(publicOrderingEnabled({ APP_ENV: "production" })).toBe(false);
    expect(
      publicOrderingEnabled({
        APP_ENV: "production",
        PUBLIC_ORDERING_ENABLED: " ",
      }),
    ).toBe(false);
    expect(
      publicOrderingEnabled({
        APP_ENV: "production",
        PUBLIC_ORDERING_ENABLED: "true",
      }),
    ).toBe(true);
    expect(publicOrderingEnabled({ PUBLIC_ORDERING_ENABLED: " false " })).toBe(
      false,
    );
    for (const bad of ["1", "yes", "TRUE", "off"]) {
      expect(() =>
        publicOrderingEnabled({ PUBLIC_ORDERING_ENABLED: bad }),
      ).toThrow("public_ordering_flag_invalid");
      expect(() =>
        accountWebConfig({ PUBLIC_ORDERING_ENABLED: bad }, "production"),
      ).toThrow("public_ordering_flag_invalid");
    }
  });

  it("an invalid flag fails web startup through the config validator", () => {
    expect(() =>
      loadConfig(
        {
          DATABASE_URL: "postgresql://gm_app:x@127.0.0.1:5432/green_monkey_dev",
          JWT_SECRET: "x".repeat(40),
          PUBLIC_ORDERING_ENABLED: "maybe",
        },
        "web",
      ),
    ).toThrow("public_ordering_flag_invalid");
  });

  it("publicOrderingGate disabled answers 404 {error:'public_ordering_disabled'} and never calls next; enabled calls next", async () => {
    const app = express();
    let reached = 0;
    app.use("/off", publicOrderingGate({ PUBLIC_ORDERING_ENABLED: "false" }));
    app.use("/on", publicOrderingGate({ PUBLIC_ORDERING_ENABLED: "true" }));
    app.use((_req, res) => {
      reached++;
      res.json({ ok: true });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Public ordering (032) routes: the link token travels in a header.
    const headers = { [LINK_HEADER]: "A".repeat(22) };
    try {
      const off = await fetch(base + "/off/menu", { headers });
      expect(off.status).toBe(404);
      expect(await off.json()).toEqual({ error: "public_ordering_disabled" });
      const post = await fetch(base + "/off/orders", {
        method: "POST",
        headers,
      });
      expect(post.status).toBe(404);
      expect(reached).toBe(0);
      const on = await fetch(base + "/on/menu", { headers });
      expect(on.status).toBe(200);
      expect(reached).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
