import { expect, it } from "vitest";
import { isolatedTarget } from "./isolated-target";
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
