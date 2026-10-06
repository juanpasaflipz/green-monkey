// Preloaded with `node --import ./build/server/instrument.js <entry>` by the
// Dockerfile and the Railway start commands, so it runs before any
// application module:
//   1. server/config.ts loads .env and validates the environment, which makes
//      module-level reads such as auth.ts cookieOptions see the final
//      NODE_ENV (SEC-9) and refuses forbidden credentials (DB-1).
//   2. A stamped build (scripts/ops/stamp-build.mjs) becomes the commit that
//      /api/version reports, instead of a hand-set variable (OPS-1).
//   3. Optional error tracking: when SENTRY_DSN is set and @sentry/node is
//      installed, unexpected errors are forwarded with secrets scrubbed.
//   4. The web logs its active signing kids (never key material), so a
//      reverted SIGNING_KEYS after an emergency rotation is visible in the
//      logs (PLATFORM-KEYS-1, docs/RUNBOOK.md "Signing keys").
import "./config.js";
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
  // Not a declared dependency: install @sentry/node to enable. The specifier
  // is a variable so the build does not require the package.
  const specifier = "@sentry/node";
  try {
    const Sentry = await import(specifier);
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.APP_ENV || "development",
      release: info.commit,
      sendDefaultPii: false,
      beforeSend: (event: Record<string, unknown>) => {
        delete (event as { request?: unknown }).request;
        return redact(event);
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
