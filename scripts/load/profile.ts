/**
 * Load profiles (GAP-4). target = 30 restaurants × 800 orders/day with 15% of
 * the day's orders in the peak hour and two KDS screens each; stress = 3× the
 * target order rate; smoke = a 60 s CI check on 3 restaurants.
 */
export interface LoadProfile {
  name: string;
  tenants: number;
  ordersPerDay: number;
  peakHourShare: number;
  kdsScreensPerTenant: number;
  kdsPollMs: number;
  roundsPerOrder: number;
  splitShare: number;
  cardShare: number;
  tablesPollMs: number;
  durationSec: number;
  rampSec: number;
}

const target: LoadProfile = {
  name: "target",
  tenants: 30,
  ordersPerDay: 800,
  peakHourShare: 0.15,
  kdsScreensPerTenant: 2,
  kdsPollMs: 1500,
  roundsPerOrder: 1.4,
  splitShare: 0.1,
  cardShare: 0.4,
  tablesPollMs: 10_000,
  durationSec: 15 * 60,
  rampSec: 2 * 60,
};

export const profiles: Record<string, LoadProfile> = {
  // A higher order rate so a 60 s CI run always exercises the order,
  // round, payment and KDS paths (about 25 orders/min per restaurant).
  smoke: {
    ...target,
    name: "smoke",
    tenants: 3,
    ordersPerDay: 10_000,
    durationSec: 60,
    rampSec: 5,
  },
  target,
  stress: { ...target, name: "stress", ordersPerDay: target.ordersPerDay * 3 },
};

/** docs/ACCEPTANCE.md performance budgets. */
export const thresholds = {
  readP95Ms: 400,
  mutationP95Ms: 700,
  kdsAppearanceP95Ms: 2000,
  maxErrorRate: 0.001,
};

/** Orders per second for one restaurant at peak. */
export const peakRate = (p: LoadProfile) =>
  (p.ordersPerDay * p.peakHourShare) / 3600;
