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
import { serviceA1 } from "../restaurant-day/service-a.js";

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
  });

  test.describe("B: Restaurante Casa Jacaranda", () => {
    test("B setup (B1–B5)", async () => {
      test.setTimeout(8 * 60_000);
      await setupB(dev, state, saveState);
    });
  });
});
