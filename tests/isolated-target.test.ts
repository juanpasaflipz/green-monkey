import { expect, it } from "vitest";
import { isolatedTarget, requireWorker } from "./isolated-target";
const env = {
  TEST_DATABASE_URL: "postgresql://app:fixture@pool.neon.tech/app_test",
  TEST_MIGRATION_DATABASE_URL:
    "postgresql://owner:fixture@direct.neon.tech/app_test",
  TEST_DATABASE_HOST_ALLOWLIST: "pool.neon.tech:5432/app_test",
  TEST_MIGRATION_DATABASE_HOST_ALLOWLIST: "direct.neon.tech:5432/app_test",
};
it("accepts explicit pooled and direct test targets", () => {
  expect(isolatedTarget(env).runtime).toBe(env.TEST_DATABASE_URL);
});
it.each([
  { NODE_ENV: "production" },
  { TEST_MIGRATION_DATABASE_HOST_ALLOWLIST: "" },
  { TEST_DATABASE_HOST_ALLOWLIST: "" },
  {
    TEST_MIGRATION_DATABASE_URL:
      "postgresql://owner:fixture@other.neon.tech/app_test",
  },
  { TEST_DATABASE_URL: "postgresql://app:fixture@pool.neon.tech/app_staging" },
  {
    TEST_MIGRATION_DATABASE_URL:
      "postgresql://owner:fixture@direct.neon.tech/other_test",
  },
])("refuses a mismatched or unauthorized target %j", (override) => {
  expect(() => isolatedTarget({ ...env, ...override })).toThrow();
});

it("derives the jobs worker login for a loopback target and needs TEST_WORKER_DATABASE_URL elsewhere", () => {
  const local = {
    TEST_DATABASE_URL:
      "postgresql://gm_app:local-only-green-monkey@127.0.0.1:55439/green_monkey_test",
    TEST_MIGRATION_DATABASE_URL:
      "postgresql://gm_provisioner:local-only-provisioner@127.0.0.1:55439/green_monkey_test",
    TEST_DATABASE_HOST_ALLOWLIST: "127.0.0.1:55439/green_monkey_test",
  };
  expect(isolatedTarget(local).worker).toBe(
    "postgresql://gm_worker:local-only-worker@127.0.0.1:55439/green_monkey_test",
  );
  expect(isolatedTarget(env).worker).toBeUndefined();
  expect(() => requireWorker(isolatedTarget(env))).toThrow(
    "TEST_WORKER_DATABASE_URL required for a non-loopback test target",
  );
  const worker = "postgresql://jobs:fixture@pool.neon.tech/app_test";
  expect(
    isolatedTarget({ ...env, TEST_WORKER_DATABASE_URL: worker }).worker,
  ).toBe(worker);
  expect(
    requireWorker(isolatedTarget({ ...env, TEST_WORKER_DATABASE_URL: worker })),
  ).toBe(worker);
});
it.each([
  "postgresql://jobs:fixture@other.neon.tech/app_test",
  "postgresql://jobs:fixture@pool.neon.tech/other_test",
  "postgresql://jobs:fixture@pool.neon.tech:6543/app_test",
])("refuses a worker URL on another target %s", (url) => {
  expect(() =>
    isolatedTarget({ ...env, TEST_WORKER_DATABASE_URL: url }),
  ).toThrow();
});
