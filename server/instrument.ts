// Preloaded with `node --import ./build/server/instrument.js <entry>` by the
// Dockerfile and the Railway start commands, so it runs before any
// application module:
//   1. server/config.ts loads .env and validates the environment, which makes
//      module-level reads such as auth.ts cookieOptions see the final
//      NODE_ENV (SEC-9) and refuses forbidden credentials (DB-1).
//   2. A stamped build (scripts/ops/stamp-build.mjs) becomes the commit that
//      /api/version reports, instead of a hand-set variable (OPS-1).
//   3. Optional error tracking: when SENTRY_DSN is set, unexpected errors are
//      forwarded to Sentry with secrets scrubbed. `@sentry/node` is a
//      declared dependency, but reporting stays off until an owner sets
//      SENTRY_DSN (docs/LAUNCH_HANDOFF.md 1.9: that approval is still
//      pending, so this does not turn error tracking on by itself).
//   4. The web logs its active signing kids (never key material), so a
//      reverted SIGNING_KEYS after an emergency rotation is visible in the
//      logs (PLATFORM-KEYS-1, docs/RUNBOOK.md "Signing keys").
import "./config.js";
import * as Sentry from "@sentry/node";
import { config } from "./config.js";
import { buildInfo } from "./build-info.js";
import { keyringSummary } from "./keyring.js";
import { log, redact, setErrorReporter } from "./logging.js";

const info = buildInfo();
if (info.commit !== "local") process.env.RAILWAY_GIT_COMMIT_SHA = info.commit;

if (config.kind === "web")
  try {
    log.info("signing_keys_active", keyringSummary());
  } catch (error) {
    log.warn("signing_keys_unavailable", {
      code: (error as { code?: unknown })?.code,
    });
  }

if (process.env.SENTRY_DSN) {
  // @sentry/node is a declared dependency, so the import above always
  // resolves; the try/catch here only guards against Sentry.init itself
  // throwing (for example, a malformed DSN), so a bad value can never take
  // startup down with it.
  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.APP_ENV || "development",
      release: info.commit,
      // @sentry/node v11 removed `sendDefaultPii: false` in favor of
      // `dataCollection`, whose own default is *more* permissive (it
      // auto-collects cookies, headers, request/response bodies, user IP,
      // database query data...). This block reproduces the old restrictive
      // default by hand so upgrading the dependency never silently widens
      // what leaves the process for a feature that is already gated on an
      // explicit owner decision (docs/LAUNCH_HANDOFF.md 1.9).
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        queues: false,
        genAI: { inputs: false, outputs: false },
        graphQL: { document: false, variables: false },
      },
      beforeSend: (event: Sentry.ErrorEvent) => {
        delete (event as { request?: unknown }).request;
        return redact(event) as Sentry.ErrorEvent;
      },
    });
    setErrorReporter((error, attrs) =>
      Sentry.captureException(error, { extra: attrs }),
    );
    log.info("error_tracking_enabled", { provider: "sentry" });
  } catch (error) {
    log.warn("error_tracking_unavailable", { provider: "sentry" }, error);
  }
}
