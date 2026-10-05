// Railway infrastructure as code (replaces railway.json, which Railway stops
// reading on 2026-12-01). Authored with the `railway` package's `railway/iac`
// module (docs.railway.com/infrastructure-as-code); reviewed with
// `railway config plan` and applied by .github/workflows/deploy.yml with
// `railway config apply --yes` (never --confirm-destructive).
//
// Not expressible here and kept as documented manual settings (RUNBOOK.md):
// restart policy, region, custom domains, serverless sleep (off), and the
// deploy webhook. Domains are deliberately omitted so an apply never removes
// one. Service names must match the existing services (rename in the
// dashboard first; IDs and domains are kept).
import { defineRailway, preserve, project, service } from "railway/iac";

export default defineRailway((ctx) => {
  const production = ctx.environment === "production";
  const common = {
    NODE_ENV: "production",
    APP_ENV: production ? "production" : "staging",
    LOG_LEVEL: "info",
    APP_URL: preserve(),
    SENTRY_DSN: preserve(),
    ALERT_WEBHOOK_URL: preserve(),
    ALERT_WEBHOOK_KIND: preserve(),
    BILLING_SANDBOX_ENABLED: preserve(),
    // Cross-tenant billing login: production web refuses it while billing is
    // disabled (open DB-1 follow-up, RUNBOOK.md "Open follow-ups").
    BILLING_DATABASE_URL: preserve(),
  };

  // Internet-facing API: runtime role, billing login for owner billing
  // commands and the webhook secret. Never the migration owner credential or
  // the Stripe secret key (server/config-rules.ts refuses them).
  const web = service("web", {
    // Source omitted: deploy.yml uploads the stamped build (`railway up --ci`).
    start: "node --import ./build/server/instrument.js build/server/index.js",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    replicas: 1, // in-memory rate limits; see RUNBOOK.md before scaling
    env: {
      ...common,
      PROCESS_KIND: "web",
      PORT: "3001",
      DB_POOL_MAX: "20",
      DB_STATEMENT_TIMEOUT_MS: "10000",
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "20",
      RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: "10",
      WORKER_URL: "http://worker.railway.internal:3002",
      DATABASE_URL: preserve(),
      PG_APP_USER: preserve(),
      JWT_SECRET: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      GOOGLE_REDIRECT_URI: preserve(),
      STRIPE_WEBHOOK_SECRET: preserve(),
      // Areas append their web variables here with preserve().
      // access (docs/ACCESS.md "Configuration"): step-up window and default
      // terminal auto-lock, both optional (defaults 120 s and 180 s).
      ACCESS_STEP_UP_SECONDS: preserve(),
      ACCESS_IDLE_LOCK_DEFAULT_SECONDS: preserve(),
      // The fictional demo tenant exists only on staging: production never
      // declares it, so a value set there is planned as a deletion and the
      // server refuses to start with it (contracts D22).
      ...(production ? {} : { DEMO_TENANT_ID: preserve() }),
    },
  });

  // Not internet-facing (no domain). Its preDeploy runs the migrations, then
  // the runtime grants, then retention, as the non-superuser gm_migrator, so
  // the owner credential never reaches the web service. A failing preDeploy
  // stops the deploy; the web's readiness waits for the new schema.
  const worker = service("worker", {
    start: "node --import ./build/server/instrument.js build/server/worker.js",
    preDeploy: "node build/scripts/migrate.js --grants --retention",
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
    replicas: 1,
    env: {
      ...common,
      PROCESS_KIND: "worker",
      PORT: "3002",
      DB_POOL_MAX: "4",
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30",
      MIGRATION_DATABASE_URL: preserve(),
      PG_APP_USER: preserve(),
      STRIPE_SECRET_KEY: preserve(),
      STRIPE_EXPECTED_ACCOUNT_ID: preserve(),
      STRIPE_PRICE_PRO_MONTHLY: preserve(),
      STRIPE_PRICE_PRO_ANNUAL: preserve(),
      STRIPE_PORTAL_CONFIG_ID: preserve(),
    },
  });

  return project("proactive-upliftment", { resources: [web, worker] });
});
