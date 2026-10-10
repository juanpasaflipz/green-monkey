/**
 * Restaurant-day go-live gate (specs/acceptance.md): two complete business days
 * for two fictional restaurants created from nothing through the real UI, on a
 * production-mode web + worker with a demo-free database. Run it only through
 * playwright.restaurant-day.config.ts (`npm run test:acceptance:day`).
 */
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OUT,
  STATE_FILE,
  runBranch,
  type RunState,
} from "../restaurant-day/env.js";
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
import {
  setupA,
  setupB,
  setupL,
  setupP,
  setupS,
} from "../restaurant-day/setup-flows.js";
import { preflight } from "../restaurant-day/preflight.js";
import { serviceB } from "../restaurant-day/service-b.js";
import { crossRestaurant } from "../restaurant-day/cross.js";
import {
  assertTimingBudgets,
  serviceA1,
  serviceA2,
  timings,
} from "../restaurant-day/service-a.js";
import { serviceA4, serviceA5 } from "../restaurant-day/close-a.js";
import { serviceA3 } from "../restaurant-day/outage.js";
import { serviceL } from "../restaurant-day/club-l.js";
import { serviceP } from "../restaurant-day/payments-p.js";
import { EXPECTED_P } from "../restaurant-day/expected-p.js";
import { oracleP } from "../restaurant-day/oracle-p.js";
import { serviceS } from "../restaurant-day/kiosk-s.js";
import { EXPECTED_S } from "../restaurant-day/expected-s.js";
import { oracleS } from "../restaurant-day/oracle-s.js";

test.skip(
  process.env.RD_ACCEPTANCE !== "1",
  "Runs only via playwright.restaurant-day.config.ts (npm run test:acceptance:day)",
);
test.describe.configure({ mode: "serial" });

/**
 * Branch P (payments spec §12.4, LD-80) is its own CI job (restaurant-day-payments): it runs G1
 * and Restaurant P alone against the payments fake; the A/B job never runs P.
 */
const BRANCH_P = runBranch() === "P";
const ONLY_P = "branch P runs Restaurant P alone (LD-80)";

const devices: Partial<Record<DeviceName, Device>> = {};
let state: RunState;
let baseUrl = "";

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

test.beforeAll(async () => {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  baseUrl = state.baseUrl;
  run.branch = state.branch;
});

test.afterEach(async () => {
  saveState();
  writeArtifacts();
  assertNoViolations();
  assertLogs();
});

test.afterAll(async () => {
  for (const d of Object.values(devices))
    await d?.context.close().catch(() => {});
  // RD_SOFT (local triage) is never a pass.
  expect(
    run.soft,
    "RD_SOFT findings: see test-results/restaurant-day/soft-findings.txt",
  ).toBe(0);
});

test.describe("restaurant day", () => {
  let dev: Devices;
  test.beforeAll(async ({ browser }) => {
    dev = async (name) =>
      (devices[name] ??= await newDevice(browser, name, baseUrl));
  });

  test("G1 preflight and oracle self-check", async ({ request }) => {
    test.setTimeout(60_000);
    run.step = "A0";
    // §5.1: the oracle reproduces the published tables before any browser work.
    expect(oracleDay(), "oracle vs expected.ts").toEqual(expectedDay());
    writeFileSync(
      resolve(OUT, "oracle.json"),
      JSON.stringify(oracle(), null, 2),
    );
    run.step = "G1";
    expect(existsSync(resolve(OUT, "d22.log")), "G1.9 D22 refusal check").toBe(
      true,
    );
    await preflight(dev, request, state);
  });

  test.describe("A: Taquería Nopal Azul", () => {
    test.skip(BRANCH_P, ONLY_P);
    test("A setup (A1–A9)", async () => {
      test.setTimeout(8 * 60_000);
      await setupA(dev, state, saveState);
    });
    test("A service, part 1 (A10)", async () => {
      test.setTimeout(10 * 60_000);
      await serviceA1(dev, state);
    });
    test("A shift (A11–A12)", async () => {
      test.setTimeout(7 * 60_000);
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
      test.info().annotations.push({
        type: "timing",
        description: budgets.rows.join("\n"),
      });
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
    test.skip(BRANCH_P, ONLY_P);
    test("B setup (B1–B5)", async () => {
      test.setTimeout(8 * 60_000);
      await setupB(dev, state, saveState);
    });
    test("B service and close (B6–B7)", async () => {
      test.setTimeout(10 * 60_000);
      await serviceB(dev, state);
    });
  });

  test("X1 cross-restaurant isolation", async () => {
    test.skip(BRANCH_P, ONLY_P);
    test.setTimeout(3 * 60_000);
    await crossRestaurant(dev, state);
  });

  // Branch L (loyalty spec §9.4, LD-80): the club runs in its own restaurant, so
  // A's and B's sales, tables and literal tables never meet it.
  test.describe("L: Tortas El Mezquite", () => {
    test.skip(BRANCH_P, ONLY_P);
    test("L setup (L1–L2)", async () => {
      test.setTimeout(5 * 60_000);
      await setupL(dev, state, saveState);
    });
    test("L club day (L3–L8)", async () => {
      test.setTimeout(6 * 60_000);
      await serviceL(dev, state);
    });
  });

  // Branch P (payments spec §12.4, LD-80): integrated card charging in its own restaurant, against
  // the payments fake, with its own hand-typed table (expected-p.ts) and DB checks (DP1-DP6).
  test.describe("P: Fonda La Ceiba", () => {
    test.skip(
      !BRANCH_P,
      "branch P runs only in the restaurant-day-payments job",
    );
    test("P setup (P1–P2) and the P oracle self-check", async () => {
      test.setTimeout(6 * 60_000);
      run.step = "P0";
      expect(oracleP(), "oracle P vs expected-p.ts").toEqual(EXPECTED_P);
      await setupP(dev, state, saveState);
    });
    test("P payments day (P3–P6)", async () => {
      test.setTimeout(12 * 60_000);
      await serviceP(dev, state);
    });
  });

  // Branch S (kiosk self-checkout 039, critic R47, LD-80/LD-89): its own restaurant, after P in
  // the same job against the same payments fake, with its own hand-typed table (expected-s.ts)
  // and DB checks (DS1-DS6).
  test.describe("S: Antojitos La Pitaya", () => {
    test.skip(
      !BRANCH_P,
      "branch S runs after branch P in the restaurant-day-payments job",
    );
    test("S setup (S1–S2) and the S oracle self-check", async () => {
      test.setTimeout(6 * 60_000);
      run.step = "S0";
      expect(oracleS(), "oracle S vs expected-s.ts").toEqual(EXPECTED_S);
      await setupS(dev, state, saveState);
    });
    test("S kiosk day (S3–S6)", async () => {
      test.setTimeout(12 * 60_000);
      await serviceS(dev, state);
    });
  });
});
