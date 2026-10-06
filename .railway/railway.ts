// Railway infrastructure as code (replaces railway.json, which Railway stops reading on
// 2026-12-01). Authored with the `railway` package's `railway/iac` module
// (docs.railway.com/infrastructure-as-code); reviewed with `railway config plan` and applied
// by .github/actions/deploy with `railway config apply --yes` (never --confirm-destructive).
//
// Railway plans every variable a service has but this file does not declare as a deletion,
// so every variable the code reads is declared here (a literal or preserve()). Wave-2 areas
// never edit this file: Wave 2.0 registered their variables; a missing one is reported to the
// lead, who adds it on integration/v1 before that area merges (contract C-10).
//
// Migrations, grants and retention run in GitHub Actions as gm_migrator, so no service holds
// the schema-owner credential (DB-1; server/config-rules.ts refuses it in both processes), and
// the worker holds no signing key.
//
// Not expressible here and kept as documented manual settings (RUNBOOK.md): restart policy,
// region, custom domains, serverless sleep (off), and the deploy webhook. Domains are
// deliberately omitted so an apply never removes one. Service names must match the existing
// services (rename in the dashboard first; IDs and domains are kept).
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
    // account (031): SaaS tax mode; web copy and /api/account-config, worker checkout parameters.
    SAAS_TAX_MODE: preserve(),
    SAAS_COLLECT_TAX_ID: preserve(),
  };

  // Internet-facing API: runtime role, signing keys, the billing login for owner billing
  // commands (sandbox only) and the webhook secret. Never the migration owner, the worker
  // login, provider keys or the support login (server/config-rules.ts refuses them).
  const web = service("web", {
    // Source omitted: the deploy action uploads the stamped build (`railway up --ci`).
    start: "node --import ./build/server/instrument.js build/server/index.js",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    replicas: 1, // in-memory rate limits; see RUNBOOK.md before scaling
    env: {
      ...common,
      PROCESS_KIND: "web",
      PORT: "3001",
      DB_POOL_MAX: "20", // replaced by the GAP-4 gate evidence (ops.md §4.10)
      DB_STATEMENT_TIMEOUT_MS: "10000",
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "20",
      RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: "10",
      WORKER_URL: "http://worker.railway.internal:3002",
      DATABASE_URL: preserve(),
      PG_APP_USER: preserve(),
      // Legacy-format tokens (outside production) and the lookup digests (pairing codes,
      // PIN fingerprints, invitation and transfer tokens). Stays required in v1.
      JWT_SECRET: preserve(),
      // OPS-10 keyring "kid:base64url[,…]", first entry signs; required when APP_ENV=production.
      SIGNING_KEYS: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      GOOGLE_REDIRECT_URI: preserve(),
      STRIPE_WEBHOOK_SECRET: preserve(),
      // access (docs/ACCESS.md "Configuration"): step-up window and default
      // terminal auto-lock, both optional (defaults 120 s and 180 s).
      ACCESS_STEP_UP_SECONDS: preserve(),
      ACCESS_IDLE_LOCK_DEFAULT_SECONDS: preserve(),
      // fiscal (027): kill switch, default true.
      FISCAL_TICKETS_ENABLED: preserve(),
      // cfdi (030): self-invoice link lifetime in hours (1-168, default 72).
      CFDI_INVOICE_LINK_EXPIRY_HOURS: preserve(),
      // account (031): legal entity and support channels (LD-3). Missing or placeholder values
      // keep legal pages unpublished and pause signup in production.
      LEGAL_ENTITY_NAME: preserve(),
      LEGAL_ENTITY_ADDRESS: preserve(),
      LEGAL_ENTITY_RFC: preserve(),
      LEGAL_JURISDICTION: preserve(),
      LEGAL_PRIVACY_CONTACT_NAME: preserve(),
      LEGAL_PRIVACY_CONTACT_EMAIL: preserve(),
      LEGAL_UNPUBLISHED_SIGNUP: preserve(),
      SUPPORT_EMAIL: preserve(),
      SUPPORT_PHONE: preserve(),
      SUPPORT_WHATSAPP: preserve(),
      SUPPORT_URL: preserve(),
      SUPPORT_HOURS: preserve(),
      SUPPORT_HOURS_EN: preserve(),
      SAAS_TAX_PROFILE_ENABLED: preserve(),
      // account (031): QR/kiosk ordering gate; unset means off in production until wave 3.
      PUBLIC_ORDERING_ENABLED: preserve(),
      // The fictional demo tenant exists only on staging: production never
      // declares it, so a value set there is planned as a deletion and the
      // server refuses to start with it (contracts D22, access A2).
      ...(production ? {} : { DEMO_TENANT_ID: preserve() }),
    },
  });

  // Not internet-facing (no domain). No preDeploy: the deploy job migrates before uploading.
  const worker = service("worker", {
    start: "node --import ./build/server/instrument.js build/server/worker.js",
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
    replicas: 1,
    env: {
      ...common,
      PROCESS_KIND: "worker",
      PORT: "3002",
      DB_POOL_MAX: "4",
      // Matches the worker login's role default; tenant() sets it per transaction.
      DB_STATEMENT_TIMEOUT_MS: "30000",
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30",
      // gm_<env>_worker, member of gm_jobs_worker (pooled endpoint).
      WORKER_DATABASE_URL: preserve(),
      STRIPE_SECRET_KEY: preserve(),
      STRIPE_EXPECTED_ACCOUNT_ID: preserve(),
      STRIPE_PRICE_PRO_MONTHLY: preserve(),
      STRIPE_PRICE_PRO_ANNUAL: preserve(),
      STRIPE_PORTAL_CONFIG_ID: preserve(),
      // account (031): SaaS tax rate for checkout (worker only).
      STRIPE_TAX_RATE_ID: preserve(),
      // cfdi (030): provider keys and vault key live only here.
      FACTURAPI_API_KEY: preserve(),
      FACTURAPI_TEST_KEY: preserve(),
      CREDENTIAL_ENCRYPTION_KEY: preserve(),
      CFDI_LIVE_ENABLED: preserve(),
      CFDI_GLOBAL_GRACE_MINUTES: preserve(),
    },
  });

  return project("green-monkey", { resources: [web, worker] });
});
