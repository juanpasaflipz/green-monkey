/**
 * The fictional-but-plausible legal and support values CI uses (account §2.2,
 * LD-3). The canonical copy lives in server/legal-ci.ts, so production can
 * refuse it (ACC-18); .github/workflows/qualification.yml sets the same
 * literals on the browser and account-http steps, and tests/legal.test.ts
 * proves NODE_ENV=production publishes them while APP_ENV=production refuses
 * them. They are FICTIONAL test values: never copy them to Railway or any
 * deployed environment.
 */
export { LEGAL_CI_ENV } from "../../server/legal-ci.js";
