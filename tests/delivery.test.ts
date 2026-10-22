import { describe, it, expect, vi, afterEach } from "vitest";
import { minor, parseUberReport } from "../server/delivery/parse.js";
import { deliveryCommand, validDeliveryLiveUrl } from "../shared/delivery.js";
import { EXPORT_TABLE_DENYLIST } from "../shared/account-export.js";
import { BrowserbaseDriver } from "../server/delivery-worker/browserbase.js";
import { uberFixture, uberHeaders } from "./fixtures/delivery/uber.js";

afterEach(() => vi.unstubAllGlobals());
describe("delivery reports", () => {
  it("accepts a different-width descriptive preamble but rejects malformed data rows", () => {
    const original = uberFixture().toString();
    expect(
      parseUberReport(
        Buffer.from("Payment details\n" + original),
        "2026-10-21",
        "Synthetic Cafe",
      ).orderCount,
    ).toBe(1);
    expect(() =>
      parseUberReport(
        Buffer.from(original + "\nshort,row"),
        "2026-10-21",
        "Synthetic Cafe",
      ),
    ).toThrow("delivery_report_schema");
    expect(() =>
      parseUberReport(Buffer.from('"unclosed'), "2026-10-21", "Synthetic Cafe"),
    ).toThrow("delivery_report_schema");
  });
  it("sums exact cents including non-order fees without inflating order count", () => {
    expect(
      parseUberReport(uberFixture(), "2026-10-21", "Synthetic Cafe"),
    ).toMatchObject({
      orderCount: 1,
      gross: 12900,
      adjusted: 11900,
      payout: 7800,
      currency: "MXN",
    });
    expect(minor("0.29")).toBe(29);
  });
  it.each(["1,234.00", "1e2", "NaN", "0.001", "9007199254740992"])(
    "rejects ambiguous or unsafe money %s",
    (v) => expect(() => minor(v)).toThrow(),
  );
  it("rejects wrong date, store, currency, duplicate completed order, missing schema and unproven empty reports", () => {
    const original = uberFixture().toString();
    for (const changed of [
      original.replaceAll("10/21/2026", "10/20/2026"),
      original.replaceAll("Synthetic Cafe", "Other Cafe"),
      original.replaceAll("MXN", "USD"),
      original + "\n" + original.split("\n")[1],
      original.replace("Store UUID", "Other"),
      uberHeaders.join(","),
    ])
      expect(() =>
        parseUberReport(Buffer.from(changed), "2026-10-21", "Synthetic Cafe"),
      ).toThrow();
  });
  it("is deterministic on retry", () =>
    expect(
      parseUberReport(uberFixture(), "2026-10-21", "Synthetic Cafe"),
    ).toEqual(parseUberReport(uberFixture(), "2026-10-21", "Synthetic Cafe")));
  it("requires versioned consent and protects browser credentials from owner exports", () => {
    expect(deliveryCommand.safeParse({ action: "connect" }).success).toBe(
      false,
    );
    expect(EXPORT_TABLE_DENYLIST.has("delivery_connections")).toBe(true);
    expect(EXPORT_TABLE_DENYLIST.has("delivery_browser_contexts")).toBe(true);
  });
  it("rejects live-view redirect lookalikes and non-HTTPS URLs", () => {
    expect(
      validDeliveryLiveUrl("https://www.browserbase.com/sessions/test"),
    ).toBe(true);
    for (const url of [
      "http://browserbase.com/sessions/x",
      "https://browserbase.com.attacker.test/sessions/x",
      "https://user@browserbase.com/sessions/x",
      "javascript:alert(1)",
      "https://browserbase.com:444/sessions/x",
    ])
      expect(validDeliveryLiveUrl(url)).toBe(false);
  });
  it("requests binary download content and never enables recordings", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            downloads: [{ id: "file1", filename: "report.csv", size: 3 }],
            total: 1,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("csv"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "session1" })));
    vi.stubGlobal("fetch", fetcher);
    const driver = new BrowserbaseDriver("synthetic-key", "synthetic-project"),
      signal = new AbortController().signal;
    expect(
      Buffer.from((await driver.download("session1", signal))!).toString(),
    ).toBe("csv");
    expect(fetcher.mock.calls[1][1].headers.Accept).toBe(
      "application/octet-stream",
    );
    await driver.createSession("context1", signal);
    expect(
      JSON.parse(fetcher.mock.calls[2][1].body).browserSettings,
    ).toMatchObject({
      recordSession: false,
      logSession: false,
      solveCaptchas: false,
      context: { id: "context1", persist: true },
    });
  });
});
