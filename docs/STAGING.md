# Staging operation and verification

Latest qualification, September 14: deployment
`46cca000-9810-4451-a0fd-84c1d2e92855` serves `0fbc3e9`, with migrations 001–010
and saved Google staging credentials. Real Google signup/entry/return and 13
deployed tenant-isolation checks passed. See
[tenancy qualification](TENANCY_QUALIFICATION.md) for evidence and limits;
the initial September 12 deployment details below are historical.

Staging is running at https://green-monkey-staging.up.railway.app. It is a development build with fictional restaurants and transactions, not a completed release or production cutover. Required feature gaps remain in [DELIVERY_STATUS.md](DELIVERY_STATUS.md).

## Targets

- Railway project: `9bd572ca-7c0b-41f8-8553-e69253e8e9e8` (`proactive-upliftment`).
- New staging environment: `9e87eafe-e620-40ad-98c2-2c541e1afaf7`.
- Web service: `cf91a7f0-e533-4354-baea-d5d56df6d3d9`.
- Initial successful deployment: `3a9fab03-b4af-449f-8a3f-31bcf543f664`.
- The supplied default `production` environment was not deployed.
- Separate Neon databases: `green_monkey_staging` and `green_monkey_test`. Separate login roles: `gm_staging_app` and `gm_test_app`. Neither owns tables, bypasses RLS, creates roles/databases, nor inherits privileged roles. Database CONNECT is revoked from PUBLIC on these new databases.
- Provisioning uses the verified direct endpoint; runtime uses the verified pooled endpoint. Both client connections negotiated TLS 1.3. No source database was used.

## Access

On the provisioning workstation, `.env.staging-access` holds the generated owner password and employee PINs, together with the URL and restaurant ID. The file is ignored by Git and readable only by its owner. The public local-demo password does not work in staging. Login as owner first to pair a browser before employee PIN access.

The other ignored files separate provisioning credentials, staging runtime credentials, test credentials, workspace API access and a staging-only Railway deployment token. Do not copy these files into source archives, screenshots or tickets.

## Reproducible database setup

Use Node 24. Create separate empty staging/test databases and restricted login roles on an approved new Neon target. Store explicit direct `MIGRATION_DATABASE_URL`, pooled `DATABASE_URL`, and matching `PG_APP_USER` in a private environment file. Do not source connection strings as shell commands. The following commands use Node's environment-file parser:

```sh
node --env-file=.env.neon-staging --import tsx scripts/migrate.ts
node --env-file=.env.neon-staging --import tsx scripts/grant-runtime.ts
node --env-file=.env.neon-test --import tsx scripts/migrate.ts
node --env-file=.env.neon-test --import tsx scripts/grant-runtime.ts
```

`grant-runtime.ts` reads the reviewed privilege manifest and safely substitutes quoted database/role identifiers. It refuses privileged roles and application-table owners.

Optional fictional fixtures require `FIXTURE_TARGET_ALLOWLIST` equal to the exact direct `host:port/database`, a database named `green_monkey_staging` or `green_monkey_test`, a generated `FIXTURE_OWNER_PASSWORD` of at least 24 characters and distinct six-digit `FIXTURE_CASHIER_PIN`/`FIXTURE_KITCHEN_PIN`. Existing organizations cause refusal; concurrent initialization is serialized. No legacy data or provider side effects are involved.

```sh
node --env-file=.env.neon-staging --import tsx scripts/seed-staging.ts
node --env-file=.env.neon-test --import tsx scripts/seed-staging.ts
node --env-file=.env.neon-test --import tsx tests/database.ts
```

The test environment file must include `TEST_DATABASE_URL` and the exact pooled target in `TEST_DATABASE_HOST_ALLOWLIST`. Tests reject production mode, missing allowlists and database names without `_test`.

## Deployment

Railway builds the Dockerfile with the committed lockfile, executes the migration runner before starting the compiled API, and checks `/api/health`. Set `NODE_ENV=production`, `PORT=3001`, `APP_URL` to the staging origin, runtime `DATABASE_URL`, `PG_APP_USER`, a generated `JWT_SECRET`, and the separate migration URL. Optional providers remain disabled.

The current one-service pre-deploy setup makes the migration URL available in the container environment; the web application never instantiates that connection or falls back to it. A separately scoped migration job is preferable before production qualification.

Use a staging-scoped `RAILWAY_TOKEN` for CLI uploads. The supplied workspace token worked through the API, but CLI workspace operations returned unauthorized even with CLI 5.54.0. There is no need to change the workspace token to deploy with the scoped token.

```sh
railway up --detach --project 9bd572ca-7c0b-41f8-8553-e69253e8e9e8 \
  --environment 9e87eafe-e620-40ad-98c2-2c541e1afaf7 \
  --service cf91a7f0-e533-4354-baea-d5d56df6d3d9
```

The initial upload used an explicit source-only allowlist: application source, build configuration, migrations, scripts and lockfile. Environment files, local work, Git history and source snapshots were excluded. Its local SHA-256 manifest is in `work/staging-upload-manifest.json`. This was a local source upload, not a GitHub push; `/api/version` may report `unknown` for the Git commit.

Railway CLI reports that `railway.json` remains supported until December 1, 2026 but is deprecated in favor of its new infrastructure-as-code format. The successful staging build used the existing configuration. Migrate and validate that format before the deadline.

## Checks and evidence

On September 12, 2026 Mexico City time (September 13 UTC):

- Five checksummed migrations applied to both databases; 17 integration checks passed on Neon test, including pooled transaction-local tenant isolation, concurrent cash/stock operations, rollback and immutable history.
- Typecheck, lint, 14 domain tests and local production build passed. Railway independently completed Docker build and reported successful deployment.
- Live browser smoke passed owner login, secure HttpOnly cookies, anonymous-session rejection, modifier selection, kitchen acknowledgement/readiness, cash payment and receipt.
- Selling screenshots at 1440×900, 1024×768, 768×1024 and 390×844 had no page-wide overflow. Keyboard search passed; automated WCAG-tagged axe checks on the selling state reported zero violations. No browser page errors were recorded.
- Database reconciliation independently confirmed one 9000-minor-unit cash tender for the 9000-minor-unit smoke order. Kitchen remained ready while the unacknowledged bar round remained active, preserving separate preparation/payment lifecycles. The initialized-target fixture guard also refused a repeat seed.
- Evidence is in `docs/evidence/staging/`, including `smoke.json`, `persistence.json` and screenshots. The smoke run deliberately created a fictional cash sale and drawer; it does not exercise real payment processing or hardware printing.

To rerun the smoke, provide `STAGING_URL`, matching `STAGING_ORIGIN_ALLOWLIST`, and generated fixture owner password in the private staging file:

```sh
node --env-file=.env.neon-staging scripts/staging-smoke.mjs
```

A smoke success does not imply full acceptance. Staging backup/restore and rollback rehearsal, full offline/reconnection and split/refund browser suites on the cloud target, sustained performance, provider sandboxes, physical printing and all remaining matrix gaps still require qualification.
