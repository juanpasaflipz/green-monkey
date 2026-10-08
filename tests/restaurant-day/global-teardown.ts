/**
 * Restaurant-day global teardown (specs/acceptance.md §2): stops the web and
 * worker this run started (by PID, never by name), leaves their logs in
 * test-results/restaurant-day/ and removes the support operator file.
 */
import { rmSync } from "node:fs";
import { SUPPORT_ENV_FILE } from "./env.js";
import { PIDS_FILE, startedPids } from "./global-setup.js";

export default async function globalTeardown() {
  if (process.env.RD_KEEP_SERVERS === "1") return;
  const pids = startedPids();
  for (const pid of Object.values(pids))
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already stopped
    }
  // Graceful drain is bounded (RAILWAY_DEPLOYMENT_DRAINING_SECONDS); give it a moment.
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const alive = Object.values(pids).filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive.length) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const pid of Object.values(pids))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // stopped
    }
  rmSync(PIDS_FILE, { force: true });
  rmSync(SUPPORT_ENV_FILE, { force: true });
}
