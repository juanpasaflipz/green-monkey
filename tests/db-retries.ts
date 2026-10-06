import assert from "node:assert/strict";
import { dbRetryCount } from "../server/db.js";

/**
 * Runs a concurrency burst and asserts that tenant() caught no deadlock (40P01) or
 * serialization failure (40001) during it, retried or not: LO-R9 makes any of them in a
 * DB suite a bug, and a retried one is otherwise invisible (PLATFORM-LOCKS-3). The suites
 * run their checks one at a time, so the counter difference belongs to this burst.
 */
export async function noRetries<T>(
  label: string,
  burst: () => Promise<T>,
): Promise<T> {
  const before = dbRetryCount();
  const result = await burst();
  assert.equal(
    dbRetryCount() - before,
    0,
    `${label}: tenant() caught a deadlock or serialization failure (db_retry); LO-R9 makes it a bug`,
  );
  return result;
}
