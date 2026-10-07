/**
 * Restaurant-day go-live gate (specs/acceptance.md): two complete business days
 * for two fictional restaurants created from nothing through the real UI, on a
 * production-mode web + worker with a demo-free database. Run it only through
 * playwright.restaurant-day.config.ts (`npm run test:acceptance:day`).
 */
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT, STATE_FILE, type RunState } from "../restaurant-day/env.js";
import { oracle } from "../restaurant-day/oracle.js";
import { expectedDay, oracleDay } from "../restaurant-day/self-check.js";
import {
  guard,
  assertLogs,
  assertNoViolations,
  newDevice,
  run,
  writeArtifacts,
  type Device,
  type DeviceName,
  type Devices,
} from "../restaurant-day/ui.js";
import { setupA, setupB } from "../restaurant-day/setup-flows.js";
import { preflight } from "../restaurant-day/preflight.js";
import { serviceB } from "../restaurant-day/service-b.js";
import { assertTimingBudgets, serviceA1, serviceA2, timings } from "../restaurant-day/service-a.js";
import { serviceA4, serviceA5 } from "../restaurant-day/close-a.js";
import { serviceA3 } from "../restaurant-day/outage.js";

test.skip(
  process.env.RD_ACCEPTANCE !== "1",
  "Runs only via playwright.restaurant-day.config.ts (npm run test:acceptance:day)",
);
test.describe.configure({ mode: "serial" });

const devices: Partial<Record<DeviceName, Device>> = {};
let state: RunState;
let baseUrl = "";

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

test.beforeAll(async () => {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  baseUrl = state.baseUrl;
});

test.afterEach(async () => {
  saveState();
  writeArtifacts();
  assertNoViolations();
  assertLogs();
});

test.afterAll(async () => {
  for (const d of Object.values(devices)) await d?.context.close().catch(() => {});
  // RD_SOFT (local triage) is never a pass.
  expect(run.soft, "RD_SOFT findings: see test-results/restaurant-day/soft-findings.txt").toBe(0);
});

test.describe("restaurant day", () => {
  let dev: Devices;
  test.beforeAll(async ({ browser }) => {
    dev = async (name) => (devices[name] ??= await newDevice(browser, name, baseUrl));
  });

  test("G1 preflight and oracle self-check", async ({ request }) => {
    test.setTimeout(60_000);
    run.step = "A0";
    // §5.1: the oracle reproduces the published tables before any browser work.
    expect(oracleDay(), "oracle vs expected.ts").toEqual(expectedDay());
    writeFileSync(resolve(OUT, "oracle.json"), JSON.stringify(oracle(), null, 2));
    run.step = "G1";
    expect(existsSync(resolve(OUT, "d22.log")), "G1.9 D22 refusal check").toBe(true);
    await preflight(dev, request, state);
  });

  test.describe("A: Taquería Nopal Azul", () => {
    test("A setup (A1–A9)", async () => {
      test.setTimeout(8 * 60_000);
      await setupA(dev, state, saveState);
    });
    test("A service, part 1 (A10)", async () => {
      test.setTimeout(10 * 60_000);
      await serviceA1(dev, state);
    });
    test("A shift (A11–A12)", async () => {
      test.setTimeout(5 * 60_000);
      await serviceA2(dev);
    });
    test("A outage (A13)", async () => {
      test.setTimeout(6 * 60_000);
      await serviceA3(dev, state);
    });
    test("A after the outage (A14)", async () => {
      test.setTimeout(6 * 60_000);
      await serviceA4(dev, state);
      // §11: the five canonical samples (A03, A07, A11, A16, A24).
      run.step = "§11";
      run.timing = timings;
      const budgets = assertTimingBudgets();
      test.info().annotations.push({ type: "timing", description: budgets.rows.join("\n") });
      expect(timings).toHaveLength(5);
      await guard(["GAP-4", "DB-3", "FOH-10"], async () => {
        expect(budgets.problems, "§11 tap and latency budgets").toEqual([]);
      });
    });
    test("A close (A15)", async () => {
      test.setTimeout(5 * 60_000);
      await serviceA5(dev, state);
    });
  });

  test.describe("B: Restaurante Casa Jacaranda", () => {
    test("B setup (B1–B5)", async () => {
      test.setTimeout(8 * 60_000);
      await setupB(dev, state, saveState);
    });
    test("B service and close (B6–B7)", async () => {
      test.setTimeout(10 * 60_000);
      await serviceB(dev, state);
    });
  });
});
