// Loyalty (038 §6): the pos-lite export schema, the import preview and its pages, against the
// fictional fixture export (tests/fixtures/poslite-loyalty-export.json; no real member data).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  IMPORT_PAGE_SIZE,
  importPageInput,
  importPages,
  importVerified,
  posLiteExport,
  previewLoyaltyImport,
  toConfirmNote,
  type ImportRow,
} from "../shared/loyalty-import";

const file = posLiteExport.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/poslite-loyalty-export.json", import.meta.url),
      "utf8",
    ),
  ),
);
const now = Date.parse("2026-10-09T18:00:00.000Z");
const preview = (policy: "recent" | "all" | "none" = "recent", stampsRequired = 10) =>
  previewLoyaltyImport(file, { policy, now, stampsRequired });

describe("pos-lite export file", () => {
  it("parses the fixture and refuses another source or a missing summary", () => {
    expect(file.members).toHaveLength(10);
    expect(posLiteExport.safeParse({ ...file, source: "pos-lite" }).success).toBe(false);
    const { summary: _summary, ...rest } = file;
    expect(posLiteExport.safeParse(rest).success).toBe(false);
  });
});

describe("previewLoyaltyImport", () => {
  it("accepts valid members in E.164 and rejects bad phones, duplicates, other countries and empty names with a reason", () => {
    const p = preview();
    expect(p.accepted.map((r) => r.legacyId)).toEqual(["101", "102", "103", "107", "108", "110"]);
    expect(p.rejected.map((r) => [r.legacyId, r.reason])).toEqual([
      ["104", "phone"],
      ["105", "duplicate"],
      ["106", "country"],
      ["109", "name"],
    ]);
    const beto = p.accepted.find((r) => r.legacyId === "102")!;
    expect(beto).toMatchObject({ phone: "+525550001002", name: "Beto Ficticio" });
    expect(p.accepted.find((r) => r.legacyId === "103")!.phone).toBe("+525550001003");
    expect(p.accepted.find((r) => r.legacyId === "107")!.phone).toBe("+12125550147");
    for (const r of p.rejected) expect(r.maskedPhone).toMatch(/^···· [0-9]{1,4}$/);
  });

  it("legacy figures: visits, spend in minor units, last visit; pos-lite's SMS opt-in is evidence only", () => {
    const ana = preview().accepted.find((r) => r.legacyId === "101")!;
    expect(ana).toMatchObject({ visits: 12, spend: 123450, stamps: 7, smsOptIn: true });
    expect(ana.lastVisitAt).toBe("2026-09-30T19:00:00.000Z");
    expect(Object.keys(ana)).not.toContain("marketingOptIn");
  });

  it("reward policy 'recent': only a card completed in the last 90 days with no visit since and not marked redeemed; the rest are listed to confirm", () => {
    const p = preview("recent");
    const rewards = Object.fromEntries(p.accepted.map((r) => [r.legacyId, r.rewards]));
    expect(rewards).toEqual({ "101": 0, "102": 1, "103": 0, "107": 0, "108": 0, "110": 0 });
    expect(p.toConfirm.map((c) => c.legacyId)).toEqual(["103"]);
    // The member's row carries the dates to keep on its import ledger row (LOYALTY-OPS-2).
    expect(p.accepted.find((r) => r.legacyId === "103")!.toConfirm).toEqual(["2026-01-10"]);
    expect(p.accepted.find((r) => r.legacyId === "102")!.toConfirm).toBeUndefined();
    expect(toConfirmNote(["2026-01-10", ""])).toBe("Premios de POS Lite por confirmar: 2026-01-10, sin fecha");
    expect(toConfirmNote([])).toBe("");
    expect(toConfirmNote(Array(20).fill("2026-01-10")).length).toBeLessThanOrEqual(200);
  });

  it("policy 'all' grants every completed card not marked redeemed; 'none' grants nothing and lists them", () => {
    const all = preview("all");
    expect(all.accepted.reduce((a, r) => a + r.rewards, 0)).toBe(2);
    expect(all.toConfirm).toEqual([]);
    const none = preview("none");
    expect(none.accepted.reduce((a, r) => a + r.rewards, 0)).toBe(0);
    expect(none.toConfirm.map((c) => c.legacyId).sort()).toEqual(["102", "103"]);
  });

  it("the file's summary checks against its rows; a tampered summary fails the checksum", () => {
    expect(preview().fileSummaryOk).toBe(true);
    const bad = { ...file, summary: { ...file.summary, activeCardStamps: 23 } };
    expect(previewLoyaltyImport(bad, { policy: "recent", now, stampsRequired: 10 }).fileSummaryOk).toBe(false);
  });

  it("expected totals after the commit, with overflow converted to rewards at the club's stamps_required", () => {
    expect(preview().expected).toEqual({
      members: 6,
      importStamps: 17,
      importRewards: 1,
      stamps: 17,
      rewards: 1,
    });
    // At 5 stamps a card, Ana's 7 become 1 reward and 2 stamps; Gil's 5 become 1 reward.
    expect(preview("recent", 5).expected).toEqual({
      members: 6,
      importStamps: 17,
      importRewards: 1,
      stamps: 7,
      rewards: 3,
    });
  });

  it("counts members with no visit in 24 months (redacted at the next cleanup) and suggests settings from pos-lite's config", () => {
    const p = preview();
    expect(p.stale).toBe(1);
    expect(p.suggested).toEqual({
      stampsRequired: 10,
      stampThreshold: 40000,
      rewardDescription: "Free item of your choice",
    });
  });

  it("importVerified: equal server totals verify; any difference is named", () => {
    const p = preview();
    const status = { batchId: "b", ...p.expected };
    expect(importVerified(p, status)).toEqual([]);
    expect(importVerified(p, { ...status, stamps: 16 })).toEqual(["stamps 16≠17"]);
  });
});

describe("pages", () => {
  it("splits rows into pages of 500 that each fit the commit schema and the 256 KB body limit", () => {
    const rows: ImportRow[] = Array.from({ length: 1234 }, (_, i) => ({
      legacyId: String(i + 1),
      phone: "+52" + String(5550000000 + i),
      name: "Socio de prueba con un nombre largo " + i,
      smsOptIn: true,
      joinedAt: "2025-01-01T00:00:00.000Z",
      lastVisitAt: "2026-09-01T00:00:00.000Z",
      visits: 99,
      spend: 999999,
      stamps: 9,
      rewards: 1,
    }));
    const pages = importPages(rows);
    expect(pages.map((p) => p.length)).toEqual([IMPORT_PAGE_SIZE, IMPORT_PAGE_SIZE, 234]);
    const body = {
      batchHash: "a".repeat(64),
      sourceTenantId: "fixture",
      targetTenantId: "10000000-0000-4000-8000-000000000001",
      policy: "recent",
      stampsRequired: 10,
      page: 0,
      pages: pages.length,
      rows: pages[0],
    };
    expect(importPageInput.safeParse(body).success).toBe(true);
    // The stamps per card the preview used travels with every page (LOYALTY-OPS-3).
    const { stampsRequired: _omitted, ...without } = body;
    void _omitted;
    expect(importPageInput.safeParse(without).success).toBe(false);
    expect(JSON.stringify(body).length).toBeLessThan(256 * 1024);
    expect(importPageInput.safeParse({ ...body, page: 3 }).success).toBe(false);
    expect(importPageInput.safeParse({ ...body, rows: [{ ...pages[0][0], phone: "5550000000" }] }).success).toBe(false);
  });
});
