# Launch hand-off (draft)

For the owner of the business, who launches production. The decision is **"we
prepare, you launch"**: the team prepares code, scripts and runbooks; every step that
needs your accounts, your credentials, your legal identity or your signature is yours.
This page lists those steps and the order in which to take them. It does not repeat
the runbooks; it links to their sections.

Draft of October 5, 2026, written against `integration/v1` (migrations through 026:
ops, access, service, menu and offline merged; Wave 2.0 platform prep merged, with no
migration of its own; fiscal, cfdi and reports exist as pure "core" modules only).
Nothing below has run against production, and the staging cutover has not happened yet
([STAGING.md](STAGING.md#deployment)).

**Dependency tags.** Each item says what it waits for:

| Tag | Meaning |
| --- | --- |
| **Now** | Possible today with the code on `integration/v1`. |
| **Wave 2.0** | Platform prep (jobs worker login, signing keyring, process rules, migrations moved to GitHub Actions). Merged into `integration/v1` (merge `56da932`, follow-up `c30da87`), so the items that waited for it are now **Now**. Not yet run on staging ([STAGING.md, "Wave 2.0 cutover record"](STAGING.md#wave-20-cutover-record)). |
| **027 / 028 / 029 / 030 / 031** | Wave 2 areas in merge order: fiscal, discounts, reports, cfdi, account. Not merged. |
| **Wave 3** | Acceptance suite and staging qualification after the last Wave 2 merge. Not started. |

**Registered and proposed names.** Wave 2.0 registered every Wave 2 Railway variable on
`integration/v1`: each is declared per service in `.railway/railway.ts` and has a
placeholder in `.env.example:144-189`, including those that fiscal (027), cfdi (030)
and account (031) will read. `SUPPORT_DATABASE_URL` (031's operator login) and
`FACTURAPI_BASE_URL` are deliberately never Railway variables (`.env.example:191-193`). Areas do not edit `.railway/railway.ts`; a missing name
goes to the lead (contract C-10). The process boundary is already enforced
(`server/config-rules.ts:64-86`), but what 030 and 031 do with their variables
(required values, further refusals, log codes) arrives only with their merge.
Behaviour and log codes marked *proposed* come from those specs, which are working
documents kept outside the repository, so they can still change. Once an area
merges, its own document is the authority.

**Lead decision LD-16.** It is recorded with the Wave 2 specs, outside the repository,
so this page states inline what it takes from it: the merge order Wave 2.0 → 027 →
028 → 029 → 030 → 031 (section 2, step 0); item L9, which puts the accountant's
review on your list (1.13); and, among its "Missing items", the `FACTURAPI_TEST_KEY`
for the staging rehearsal of the daily global invoice (1.14).

The restaurant-side companion is [the pilot operating guide](PILOT_SOP.md) (Spanish).

## 1. What only you can supply or do

| # | Item | Depends on |
| --- | --- | --- |
| 1.1 | Railway access (CLI login or a valid token) | Now |
| 1.2 | Production domain and DNS | Now |
| 1.3 | Neon production project and roles | Now |
| 1.4 | Rotate the exposed staging database passwords | Now (with the staging cutover) |
| 1.5 | Google OAuth production client | Now |
| 1.6 | GitHub plan, branch protection and environment secrets | Now |
| 1.7 | Alert channel (ntfy topic) | Now |
| 1.8 | Backup encryption key (age) and off-platform storage (R2) | Now |
| 1.9 | Error tracking (Sentry DSN): approve or decline | Now (decision); a dependency change follows |
| 1.10 | Production secrets you generate | Now; one more after 030 |
| 1.11 | Legal entity data (LD-3) | 031 |
| 1.12 | Privacy notice publication | 031 |
| 1.13 | An accountant's confirmation of IVA, CFDI and RESICO behaviour | Review now; test against 027 and 030 |
| 1.14 | Facturapi keys and each restaurant's CSD | 030 |
| 1.15 | Stripe live mode (identity verification, bank account) | Not needed for the pilot launch |
| 1.16 | The pilot restaurant's printer and tablets | Now |
| 1.17 | Contacts, escalation and the go-live decision | Now |

### 1.1 Railway access

- **Why.** Every Railway step needs an authenticated CLI: the production environment,
  `railway config plan` / `apply` of `.railway/railway.ts`, setting variables with
  `scripts/ops/railway-vars.sh`, and the project token that GitHub deploys with. The
  workstation's exported `RAILWAY_API_TOKEN` is currently **rejected** (CLI 5.63.1,
  [STAGING.md](STAGING.md) September 30 checkpoint); that upload used an interactive
  `railway login`.
- **Where it goes.**
  - On the operator workstation: an interactive `railway login`, or a new
    account/workspace token exported as `RAILWAY_API_TOKEN`. Remove or replace the
    rejected export first. Railway's CLI documentation treats `RAILWAY_TOKEN`
    (project token) and `RAILWAY_API_TOKEN` (account/workspace token) as the
    non-interactive alternatives to `railway login` and allows only one of the two at
    a time.
  - For CD: a project token scoped to the production environment, stored as the
    GitHub environment secret `RAILWAY_TOKEN`
    ([PROVISIONING.md §3](PROVISIONING.md#3-railway) step 2,
    [§7](PROVISIONING.md#7-github)). Pin the CLI with the repository variable
    `RAILWAY_CLI_VERSION`.
- **How to verify.** `npx @railway/cli@$RAILWAY_CLI_VERSION whoami` prints your account.
  Listing variable **names** only works:
  `railway variable list --service web --environment staging --json | jq -r 'keys[]'`
  ([RUNBOOK.md, "Staging cutover"](RUNBOOK.md#staging-cutover) step 4). For the
  project token, the first CD run passes its Railway sync step.

### 1.2 Production domain and DNS

- **Why.** Deployed processes refuse to start without an `https` `APP_URL`
  (`server/config-rules.ts:206-209`). The Google OAuth redirect must share
  `APP_URL`'s origin, and session cookies are `Secure`.
- **Where it goes.**
  - The domain itself (for example `app.<your-domain>`) and the Cloudflare zone are
    yours ([PROVISIONING.md §0](PROVISIONING.md#0-decisions-defaults-chosen-so-work-is-not-blocked)).
  - Railway: add the custom domain to the `web` service only. Domains are deliberately
    not in IaC (`.railway/railway.ts:15-18`); the manual settings are in
    [RUNBOOK.md, "Manual Railway settings"](RUNBOOK.md#manual-railway-settings-not-expressible-in-iac).
  - Cloudflare: create **both** records Railway shows, the `CNAME` and the `TXT`
    ownership record (Railway's documentation: the domain answers 404 until the `TXT`
    record verifies), DNS-only as [PROVISIONING.md §4](PROVISIONING.md#4-domain-and-tls)
    says.
  - Variables: `APP_URL=https://<domain>` on both services (`common`,
    `.railway/railway.ts:27`; placeholder at `.env.example:34`), the GitHub environment
    variable `APP_URL`, and `GOOGLE_REDIRECT_URI` (1.5).
- **How to verify.** Railway shows the domain verified with a certificate;
  `curl -s https://<domain>/api/ops/status` answers; the deploy smoke (section 2,
  step 7) passes its client-IP check.

### 1.3 Neon production project and roles

- **Why.** Production gets its own Neon project and least-privilege logins:
  `gm_migrator` owns the schema, `gm_production_app` serves traffic,
  `gm_production_worker` runs the worker's jobs, and the billing and backup logins
  each have one job ([INFRASTRUCTURE.md, "Neon connections"](INFRASTRUCTURE.md#neon-connections)).
- **Where it goes.**
  - Your Neon organization, plan and region: Launch (7-day history) or Scale (30-day),
    `aws-us-east-1` to match Railway `us-east4`
    ([PROVISIONING.md §0](PROVISIONING.md#0-decisions-defaults-chosen-so-work-is-not-blocked)).
  - `NEON_API_KEY`, `NEON_ORG_ID` and a pinned `NEONCTL_VERSION` for
    `scripts/ops/provision-neon.sh` ([§1](PROVISIONING.md#1-neon-project)), which writes
    the owner connection to `.env.neon-owner-production`.
  - `scripts/ops/provision-roles.ts` ([§2](PROVISIONING.md#2-roles)). In one
    transaction it runs `scripts/ops/sql/globals.sql` (cluster roles `gm_migrator`,
    `gm_billing_worker`, `gm_backup_reader`, `gm_jobs_worker` and `gm_support`,
    `globals.sql:16-25`) and `scripts/ops/sql/database-grants.sql` (`CONNECT` and
    schema `USAGE`/`CREATE` with grant option for `gm_migrator`, `CONNECT` and `USAGE`
    for `gm_billing_worker`, `gm_backup_reader` and `gm_jobs_worker` (`gm_support`'s
    come with 031), `CREATE` on the schema revoked from `PUBLIC`) and creates the
    logins. Before that transaction opens it writes `.env.provisioned-production`
    (0600), so a failed run does not roll the file back; a re-run only appends missing
    keys (`scripts/ops/provision-roles.ts:186-209`).
  - That includes the worker's jobs login `gm_production_worker`, a member of
    `gm_jobs_worker` only, with 30 s/8 s/60 s defaults
    (`scripts/ops/provision-roles.ts:56-60`, `:285`), whose URL is written as
    `WORKER_DATABASE_URL` (`:181`) for the `worker` service (section 2, step 2).
    Provision before the first production deploy: the `-- 2.0 jobs worker` block of
    `scripts/grants.sql` (`:51-59`) refuses to apply until `globals.sql` has run, and
    the deploy then stops before Railway.
  - Then reset the `neondb_owner` password and keep it offline. Neon's documentation:
    a reset from the console's Roles page, the API or `ALTER ROLE ... WITH PASSWORD`
    takes effect on the next connection.
- **How to verify.** `provision-roles.ts --dry-run` and then the real run complete; the
  script itself asserts that no login is privileged and that only `gm_migrator` owns
  tables. As `neondb_owner`:
  `select rolname, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname like 'gm\_%'`
  shows `false` in every privilege column. The first migration run (section 2, step 5)
  refuses a privileged login by itself ([RELEASE.md, "Migrations"](RELEASE.md#migrations)).

### 1.4 Rotate the exposed staging database passwords

- **Why.** The `gm_staging_app` and `gm_staging_billing` passwords were exposed in a
  working session on September 30 and must be rotated together with `DATABASE_URL`
  and `BILLING_DATABASE_URL`; private env files holding the old `neondb_owner`
  password are stale ([STAGING.md](STAGING.md)). The billing login reads billing
  tables across tenants.
- **Where it goes.** [RUNBOOK.md, "Credential rotation"](RUNBOOK.md#credential-rotation)
  (`scripts/ops/rotate-db-login.ts`, dual role, zero downtime) as steps 11–13 of the
  [staging cutover](RUNBOOK.md#staging-cutover): runtime login, billing login, then the
  `neondb_owner` password, kept offline. It needs the staging `neondb_owner`
  credential, which only you hold. Record each rotation, without secrets, in
  [STAGING.md, "Credential rotation log"](STAGING.md#credential-rotation-log).
- **How to verify.** After `--finalize`, as `neondb_owner`:
  `select rolname from pg_roles where rolname in ('gm_staging_app','gm_staging_billing')`
  returns no rows; the staging smoke passes; the log rows carry dates. The cutover
  must happen before Railway stops reading `railway.json` on 2026-12-01
  ([STAGING.md, "Deployment"](STAGING.md#deployment)).

### 1.5 Google OAuth production client

- **Why.** Owners sign up and enter with Google, and each environment needs its own
  OAuth client ([README](../README.md), "Owner signup").
- **Where it goes.** Google Cloud console, a production OAuth web client with redirect
  `https://<domain>/api/auth/google/callback`; `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` on `web` (`.railway/railway.ts:65-67`);
  publish the consent screen before inviting real owners
  ([PROVISIONING.md §5](PROVISIONING.md#5-google-oauth-production-client)).
- **How to verify.** On the production domain, the Google button appears and a test
  owner reaches the POS and returns.

### 1.6 GitHub plan, branch protection and environment secrets

- **Why.** CD deploys production only from a protected `main`, the backup and uptime
  workflows hold production secrets, and the deploy job and the daily retention
  workflow hold the schema-owner credential ([RELEASE.md](RELEASE.md)).
- **Where it goes.**
  - Rulesets on a private repository need a paid GitHub plan
    ([PROVISIONING.md §0](PROVISIONING.md#0-decisions-defaults-chosen-so-work-is-not-blocked)).
  - `scripts/ops/github-protect.sh`, then the production environment secrets and
    variables it prints (`scripts/ops/github-protect.sh:70-92`): the secrets
    `RAILWAY_TOKEN`, `MIGRATION_DATABASE_URL` (`gm_migrator`, direct endpoint, from
    `.env.provisioned-production` on stdin), `BACKUP_DATABASE_URL`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY` and `ALERT_WEBHOOK_URL`; the variables `APP_URL`,
    `PG_APP_USER` (`gm_production_app`), `ALERT_WEBHOOK_KIND` (optional, defaults to
    `ntfy`: `.github/workflows/deploy.yml:149`, `retention.yml:132`), `R2_ACCOUNT_ID`
    and `R2_BUCKET`; and the repository variables `RAILWAY_CLI_VERSION`,
    `RAILWAY_IAC_VERSION` ([§7](PROVISIONING.md#7-github)).
  - The production deploy job passes `MIGRATION_DATABASE_URL`, `PG_APP_USER` and the
    alert settings to the deploy action's migrate step
    (`.github/workflows/deploy.yml:145-149`, `.github/actions/deploy/action.yml:63-75`),
    and the retention workflow reads the secret too
    (`.github/workflows/retention.yml:127-132`). No Railway service holds the migration
    credential: both processes refuse it (`server/config-rules.ts:66`, `:81`).
- **How to verify.** `github-protect.sh --dry-run`, then the real run (a 403 means the
  plan lacks rulesets); `gh secret list --env production` lists the names, including
  `MIGRATION_DATABASE_URL`; `gh variable list --env production` shows `PG_APP_USER`;
  a pull request shows the required `qualify` and `security` checks.

### 1.7 Alert channel (ntfy topic)

- **Why.** The worker watchdog, the jobs runner, retention and the uptime and backup
  workflows alert through one webhook ([RUNBOOK.md, "Signals"](RUNBOOK.md#signals)).
- **Where it goes.**
  - A long, random ntfy topic: ntfy's terms say topic names on ntfy.sh are public and
    the name works as a password, so it must not be guessable.
  - `ALERT_WEBHOOK_URL` (and `ALERT_WEBHOOK_KIND=ntfy`) on both services (`common`,
    `.railway/railway.ts:29-30`; `.env.example:26-27`). It must be `https`
    (`server/config-rules.ts:221-228`, `alert_webhook_https_required`).
  - The GitHub environment secret `ALERT_WEBHOOK_URL` (the deploy job's retention pass
    and the daily retention workflow alert `retention_failed` through it,
    [RUNBOOK.md, "Retention"](RUNBOOK.md#retention)), and Railway's project deploy
    webhook ([RUNBOOK.md, "Manual Railway settings"](RUNBOOK.md#manual-railway-settings-not-expressible-in-iac)).
  - Subscribe the first responder's phone ([PROVISIONING.md §8](PROVISIONING.md#8-monitoring)).
- **How to verify.** `curl -d "Green Monkey: prueba" <topic URL>` (ntfy's documented
  publish) reaches the subscribed phone. [RUNBOOK.md, "Signals"](RUNBOOK.md#signals)
  says what each later alert means and who acts on it.

### 1.8 Backup encryption key (age) and off-platform storage (R2)

- **Why.** Nightly dumps are encrypted to a key that never enters GitHub, Railway or
  any server; losing every copy makes the dumps unreadable
  ([BACKUP_RESTORE.md, "Key custody"](BACKUP_RESTORE.md#key-custody)). The Código
  Fiscal de la Federación (art. 30) requires keeping accounting records for five years
  ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
- **Where it goes.**
  - `age-keygen -o <offline path>/green-monkey-backup.key` on your machine; keep it in
    your password manager plus a printed copy; add a second recipient for a recovery
    holder.
  - Commit only the public `age1…` line (`age-keygen -y <key>`) to
    `ops/backup/age-recipients.txt`; the backup workflow refuses to run until one is
    present (header of that file).
  - Your Cloudflare account: `scripts/ops/provision-r2.sh production --lock` and a
    token scoped to `gm-backups-production`, stored as the GitHub `R2_*` secrets
    ([PROVISIONING.md §6](PROVISIONING.md#6-backups)).
- **How to verify.**
  `echo ok | age -R ops/backup/age-recipients.txt | age -d -i <offline key>` prints
  `ok` (age's documented `-R` recipients file and `-d -i` decryption). Then the restore
  drill in section 2, step 8.

### 1.9 Error tracking (Sentry DSN): approve or decline

- **Why.** Optional. With `SENTRY_DSN` set, unexpected server errors go to Sentry with
  the request removed and secrets scrubbed (`server/instrument.ts:32-55`). It is a
  third-party processor of operational data, so it is your decision (and your
  counsel's, for 1.12).
- **Where it goes.** `SENTRY_DSN` on both services (`common`, `.railway/railway.ts:28`;
  `.env.example:24`). `@sentry/node` is **not** a declared dependency
  (`server/instrument.ts:33-35`); once you approve, the team adds it in a reviewed
  change. Declining needs nothing: error tracking stays off
  ([PROVISIONING.md §0](PROVISIONING.md#0-decisions-defaults-chosen-so-work-is-not-blocked)).
- **How to verify.** The deploy logs show `error_tracking_enabled`;
  `error_tracking_unavailable` means the DSN is set but the package is missing.

### 1.10 Production secrets you generate

Only someone with production access can set these, so they are yours to generate,
set from a private file with `scripts/ops/railway-vars.sh` (never on the command
line), and keep where noted.

- `JWT_SECRET` on `web`: at least 32 characters or the web refuses to start
  (`server/config-rules.ts:248-249`); [PROVISIONING.md §3](PROVISIONING.md#3-railway)
  asks for 64+ random characters. It still keys the pairing-code, PIN-fingerprint and
  invitation digests (and 031's transfer digests once it merges), so rotate it only together with an emergency
  signing-key rotation ([RUNBOOK.md, "Signing keys"](RUNBOOK.md#signing-keys) step 3).
  A deployed worker refuses it (`server/config-rules.ts:84`). A deployed web refuses
  the CI, local-only and documented placeholder values (`placeholder_jwt_secret`,
  `server/config-rules.ts:254-257`). **Now.**
- `SIGNING_KEYS` on `web` (`.railway/railway.ts:63-64`; `.env.example:148-151`): one
  entry printed by `node scripts/ops/generate-signing-key.mjs`, which signs cookies
  and links (`server/keyring.ts`). A deployed web, staging included, refuses to start
  without it (`missing_signing_keys`, `server/config-rules.ts:258-272`, which also
  applies the keyring's production test, `server/production.ts:7-12`), with a malformed
  one (`invalid_signing_keys`), or with a placeholder: the committed CI keyring, a
  `ci-`/`local-`/`test-` kid, or a secret that decodes to printable text
  (`placeholder_signing_keys`); never copy `SIGNING_KEYS` from a track or CI env file.
  A deployed worker refuses it (`server/config-rules.ts:83`). After any change, never
  roll back from the Railway dashboard (it restores the old variables; RUNBOOK
  "Rollback"). Rotation is routine, in two steps, or emergency
  ([RUNBOOK.md, "Signing keys"](RUNBOOK.md#signing-keys)). **Now.**
- `CREDENTIAL_ENCRYPTION_KEY` on `worker` (`kid:secret` list) will seal each
  restaurant's Facturapi keys (030). Keep an offline copy: restoring those keys from a backup needs it.
  Declared on `worker` (`.railway/railway.ts:128`; placeholder at
  `.env.example:187`) and refused by a deployed web (`server/config-rules.ts:74`);
  nothing reads it before **030**.
- **How to verify.** Both services start (no `missing_jwt_secret`,
  `missing_signing_keys` or other `ConfigError` code in the deploy logs), the deploy
  smoke passes, and a freshly issued `gm_session` cookie starts with `v2.`
  ([PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal) step 4).

### 1.11 Legal entity data (LD-3)

- **Why.** The platform privacy notice, terms and data-processing agreement read the
  legal entity, address and support contact from configuration; production values
  come from you, and CI uses fictional values flagged as such (lead decision LD-3).
- **Where it goes.** Web variables, registered by Wave 2.0 (declared with
  `preserve()` at `.railway/railway.ts:77-91`; placeholders at
  `.env.example:156-171`) but read by no code until account (031) merges. Per the
  031 spec (*proposed*): required `LEGAL_ENTITY_NAME`, `LEGAL_ENTITY_ADDRESS`,
  `LEGAL_PRIVACY_CONTACT_EMAIL`, `LEGAL_JURISDICTION`; optional `LEGAL_ENTITY_RFC`,
  `LEGAL_PRIVACY_CONTACT_NAME`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `SUPPORT_WHATSAPP`,
  `SUPPORT_HOURS`, `SUPPORT_HOURS_EN`, `SUPPORT_URL`. `LEGAL_UNPUBLISHED_SIGNUP`,
  also registered, is meant to have no effect in production (`.env.example:164-165`);
  leave it unset there. `docs/ACCOUNT_AND_LEGAL.md` (added by 031) will be the
  authoritative list. Per the spec, a value that looks like a placeholder counts as
  missing, and the pages stay unpublished.
  Until 031 merges, [PROVISIONING.md §9](PROVISIONING.md#9-legal-entity-values-lead-decision-ld-3)
  applies: confirm the values by hand.
- **How to verify.** The web logs carry no line saying the legal documents are
  unpublished (the 031 spec proposes the code `legal_documents_unpublished`, at error
  level in production; no branch has it yet, so check the name in
  `docs/ACCOUNT_AND_LEGAL.md` once 031 merges); the legal pages show your values;
  owner signup is open.

### 1.12 Privacy notice publication

- **Why.** Mexican data-protection law (LFPDPPP) requires the notice where personal
  data is collected; per the 031 spec, production refuses new Google accounts while no
  notice is published.
- **Where it goes.** Your counsel reviews the notice text (integral and simplified),
  the terms and the data-processing agreement ("contrato de encargo") that 031
  publishes from the 1.11 values, at the paths the spec plans: `/legal/privacidad`,
  `/legal/terminos`, `/legal/encargo-de-datos`. Include your decision on Sentry (1.9).
- **How to verify.** The three pages open on the production domain with your
  values; the simplified notice appears next to the Google button and restaurant
  signup; a test signup records its acceptance.

### 1.13 An accountant's confirmation of IVA, CFDI and RESICO behaviour

- **Why.** Fiscal tickets (027) and CFDI (030) issue documents in the restaurant's
  name; their rules must be confirmed by a Mexican accountant before a pilot. Lead
  decision LD-16 (item L9, see the dependency tags) puts this on your hand-off list
  explicitly.
- **What to confirm** (with the references to show the accountant):
  - IVA is always extracted from tax-inclusive prices, once per category, with the
    documented rounding ([FISCAL.md, "Rounding rule"](FISCAL.md#rounding-rule) and
    ["How money changes affect tax"](FISCAL.md#how-money-changes-affect-tax)).
  - The 8 % border-region rate and its expiry date in code,
    `BORDER_STIMULUS_VALID_UNTIL = 2026-12-31`, for border pilots
    ([FISCAL.md, "Verification record"](FISCAL.md#verification-record)). For each
    border restaurant (lead decision LD-25): its place-of-issue postal code carries the
    SAT `c_CodigoPostal` "Estímulo Franja Fronteriza" mark, and its RFC is in the LCO
    with mark 2; the PAC rejects 8 % otherwise, and the app checks only that the postal
    code is in a border state. If no DOF extension is published, border tenants switch
    to 16 % on 2027-01-01 (dated check in [RUNBOOK.md](RUNBOOK.md#deploy-window)).
  - Multi-branch RFCs: every ticket prints the issuing branch's address when "Este RFC
    tiene más de una sucursal" is ticked (CFF art. 29-A fr. I).
  - Customer invoices, the daily global invoice (PUBLICO EN GENERAL) and credit notes
    for refunds ([CFDI.md, "Builders"](CFDI.md#builders-fiscal-027-stays-the-system-of-record)),
    including late offline sales that land in a supplementary global part for their
    own day ([OFFLINE_RECOVERY.md, "Late sales and the global invoice"](OFFLINE_RECOVERY.md#late-sales-and-the-global-invoice)).
  - **RESICO ISR withholding is not modelled (open gap).** The CFDI core sends IVA
    traslado only and refuses withholdings (`server/cfdi/facturapi-schema.ts:32-38`,
    which marks them out of scope; `server/cfdi/build.ts` always sets
    `withholding: false`). Ask the accountant whether a pilot restaurant in régimen
    626 will invoice personas morales; if so, 030 needs a change before live CFDI.
  - The USD cash procedure for border restaurants
    ([PILOT_SOP.md §5.1](PILOT_SOP.md#51-dólares-en-efectivo-restaurantes-de-la-frontera)):
    which exchange rate to use and how to keep the paper log.
- **How to verify.** A written sign-off (email is enough) kept with the launch
  records, then the accountant's review of the staging test invoices from the Wave 3
  rehearsal (section 2, step 0). The IVA and CFDI behaviour above exists only after
  **027** and **030** merge, and RESICO withholding is in neither (see above); the
  rules can be reviewed now.

### 1.14 Facturapi keys and each restaurant's CSD

- **Why.** CFDI stamping goes through Facturapi. Today nothing calls it and live mode
  is not enabled ([CFDI.md](CFDI.md)).
- **Where it goes** (worker variables: Wave 2.0 declared `FACTURAPI_API_KEY`,
  `FACTURAPI_TEST_KEY`, `CREDENTIAL_ENCRYPTION_KEY` and `CFDI_LIVE_ENABLED` on
  `worker` (`.railway/railway.ts:125-129`; placeholders at `.env.example:185-188`),
  and a deployed web refuses all four (`server/config-rules.ts:72-75`,
  `forbidden_credential_in_process`). No code reads them before 030 merges; how 030
  uses them is per its spec):
  - Your Facturapi account and its **User key** (`sk_user_…`) as `FACTURAPI_API_KEY`
    on the production worker, with `CREDENTIAL_ENCRYPTION_KEY` (1.10): one Facturapi
    organization per restaurant, each starting in test mode.
  - A **test key** (`sk_test_…`) as `FACTURAPI_TEST_KEY` on the **staging** worker:
    the shared sandbox needed for the Wave 3 staging rehearsal of the daily global
    invoice (a "Missing items" entry of LD-16, see the dependency tags). Per the 030
    spec, production refuses a test key on its own.
  - `CFDI_LIVE_ENABLED=true` (its effect is *proposed* by the 030 spec) on the
    production worker only when you decide to go live; per the spec it is refused
    anywhere else (on `integration/v1` today, only the web refuses it,
    `server/config-rules.ts:75`; the other refusals arrive with 030).
  - **Each restaurant's CSD** (Certificado de Sello Digital: the `.cer`, the `.key` and
    the key's password; not the e.firma, which is what the restaurant uses to request
    the CSD from SAT). The restaurant owner uploads it in the app's CFDI settings
    (owner, PIN step-up), which sends it to that restaurant's Facturapi organization
    (Facturapi API: `PUT /organizations/{id}/certificate` with `cer`, `key`,
    `password`).
- **How to verify.** The worker starts without a CFDI configuration error; the CFDI
  settings show test mode; a staging test invoice stamps; after go-live the
  accountant reviews the first real invoice. **030.**

### 1.15 Stripe live mode

- **Why.** Live Pro subscriptions. **Not needed for the pilot launch:** production
  launches with `BILLING_SANDBOX_ENABLED=false` ([PROVISIONING.md §3](PROVISIONING.md#3-railway)
  step 4; [RUNBOOK.md, "Open follow-ups"](RUNBOOK.md#open-follow-ups) DB-1), today's
  billing code cannot use live keys ([README](../README.md), "Billing implementation in
  progress"), and per the 031 spec pilots get Pro through an audited support grant.
- **Where it goes.** In the Stripe Dashboard, complete account activation: business
  type, tax and business details, the representative's identity verification,
  customer-facing information, a bank account for payouts and two-step
  authentication (Stripe's "Go live" documentation). The live secret key, account id,
  prices and portal configuration go to the worker (`.railway/railway.ts:118-122`), and
  the live webhook signing secret goes to web (`STRIPE_WEBHOOK_SECRET`,
  `.railway/railway.ts:68`), only when a post-launch billing area adds live mode.
  Stripe issues separate test and live signing secrets for a webhook endpoint, so the
  test-mode value cannot be reused.
- **How to verify.** The Dashboard shows the account activated for live payments
  with a verified payout bank account; its account id is the one you will set as
  `STRIPE_EXPECTED_ACCOUNT_ID`.

### 1.16 The pilot restaurant's printer and tablets

- **Why.** Real tablets, real 58/80 mm thermal printers and a real internet outage
  are release gates that have never been checked
  ([OFFLINE_RECOVERY.md, "Verification"](OFFLINE_RECOVERY.md#verification);
  [SERVICE.md](SERVICE.md)).
- **Where it goes.** You buy or choose the devices with the restaurant; the installer
  follows [PILOT_SOP.md §1–§2](PILOT_SOP.md#1-impresión-y-equipo) (OS driver: paper
  width, no margins, 100 % scale, auto-cut and cash-drawer kick are driver features;
  silent printing is unconfirmed).
- **How to verify.** The full test print in [PILOT_SOP.md §1.2](PILOT_SOP.md#12-configurar-la-impresora-térmica-58-u-80-mm-en-el-sistema-operativo)
  step 10 passes on each device, and one deliberate outage (router unplugged) is sold
  through and synced, as [PILOT_SOP.md §3](PILOT_SOP.md#3-conexión-y-venta-sin-conexión)
  describes.

### 1.17 Contacts, escalation and the go-live decision

- Fill in [RUNBOOK.md, "Contacts and escalation"](RUNBOOK.md#contacts-and-escalation)
  (first responder, backup responder, hours) and the restaurant's table in
  [PILOT_SOP.md §7](PILOT_SOP.md#7-a-quién-llamar).
- The launch itself (M11 in [COMPLETION_LEDGER.md](COMPLETION_LEDGER.md)) is your
  recorded decision ([PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal)
  step 5).

## 2. Launch sequence

Each step names the runbook section that holds the commands. Do not start a step
before the previous one is verified.

0. **Preconditions.** Wave 2.0 (merged into `integration/v1`), then 027, 028, 029,
   030 and 031 merged in that order (lead decision LD-16, see the dependency tags),
   Wave 3 acceptance green, and `release/v1` on `main`. Staging cut over
   ([RUNBOOK.md, "Staging cutover"](RUNBOOK.md#staging-cutover), with its Wave 2.0
   deltas recorded in [STAGING.md](STAGING.md#wave-20-cutover-record)), including the
   rotations (1.4), the first staging backup and restore rehearsal (step 14) and the
   load test (step 15). The Wave 3 staging rehearsal of the daily global CFDI passed
   with `FACTURAPI_TEST_KEY` (1.14). Items 1.1–1.13 and 1.16 done.
1. **Provision Neon.** [PROVISIONING.md §1](PROVISIONING.md#1-neon-project) and
   [§2](PROVISIONING.md#2-roles) (`globals.sql` and `database-grants.sql` run inside
   `provision-roles.ts`, which also creates the `gm_production_worker` jobs login),
   `--dry-run` first each time; reset `neondb_owner` and keep it offline (1.3).
2. **Railway production environment.** [PROVISIONING.md §3](PROVISIONING.md#3-railway):
   `config plan` must show only additions; variables from a private file with
   `railway-vars.sh` (step 4 there: `SIGNING_KEYS` on `web`, `WORKER_DATABASE_URL` on
   `worker`, `MIGRATION_DATABASE_URL` on neither); the manual settings in
   [RUNBOOK.md](RUNBOOK.md#manual-railway-settings-not-expressible-in-iac).
3. **Domain, TLS and Google.** [PROVISIONING.md §4](PROVISIONING.md#4-domain-and-tls)
   and [§5](PROVISIONING.md#5-google-oauth-production-client) (1.2, 1.5).
4. **Backups, GitHub, monitoring, legal values.**
   [PROVISIONING.md §6](PROVISIONING.md#6-backups), [§7](PROVISIONING.md#7-github),
   [§8](PROVISIONING.md#8-monitoring), [§9](PROVISIONING.md#9-legal-entity-values-lead-decision-ld-3)
   (1.6–1.8, 1.11), including the `MIGRATION_DATABASE_URL` secret and the
   `PG_APP_USER` variable that step 5 needs. Do not add `production` to
   `OPS_LIVE_ENVIRONMENTS` yet.
5. **Migrate as `gm_migrator`, with grants.** Not a separate step: the Deploy job of
   step 6 runs `node build/scripts/migrate.js --grants --retention` from GitHub
   Actions, with the production environment's `MIGRATION_DATABASE_URL` secret and
   `PG_APP_USER` variable, before it changes anything on Railway
   (`.github/actions/deploy/action.yml:58-73`;
   [RELEASE.md, "Continuous delivery"](RELEASE.md#continuous-delivery-githubworkflowsdeployyml)).
   On the first production deploy it creates the schema on the empty database
   ([PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal) step 1). It
   refuses a missing secret, a pooled host and a privileged login, and commits the
   runtime grants (`scripts/grants.sql`) with the newest migration
   ([RELEASE.md, "Migrations"](RELEASE.md#migrations)); if it fails, nothing on
   Railway changes. No Railway service migrates: the worker has no `preDeploy`
   (`.railway/railway.ts:102`) and both processes refuse `MIGRATION_DATABASE_URL`
   (1.6). The same login runs the daily retention
   ([RELEASE.md, "Retention"](RELEASE.md#retention-githubworkflowsretentionyml)),
   whose production schedule stays off until step 8.
6. **Deploy.** Actions → Deploy → Run workflow with the full SHA that is live on
   staging, the phrase `deploy <sha7> to production`, outside 12:00–23:59
   America/Mexico_City ([RELEASE.md, "Continuous delivery"](RELEASE.md#continuous-delivery-githubworkflowsdeployyml),
   [RUNBOOK.md, "Deploy window"](RUNBOOK.md#deploy-window)).
7. **Smoke.** The workflow runs `scripts/ops/smoke.mjs --expect-commit <sha>` (live
   commit, health, worker, client IP, malformed JSON, session required;
   [PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal) step 2). Then
   by hand: `/api/ops/status` not degraded, `/api/version` shows the SHA, both Railway
   services healthy, the ntfy test (1.7), and the Wave 2.0 go-live checks of
   [PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal) step 4 (the
   worker logs `worker_ready` with `jobs:true`; a fresh `gm_session` cookie starts
   with `v2.`).
8. **Backup and restore drill.** Actions → Backup → production, by hand; then the
   restore rehearsal from that dump
   ([BACKUP_RESTORE.md, "Restore rehearsal"](BACKUP_RESTORE.md#restore-rehearsal-quarterly-and-before-launch)),
   with RTO/RPO written to `docs/evidence/restore/`. Then Actions → Retention →
   production, by hand, which must be green. Only then
   `gh variable set OPS_LIVE_ENVIRONMENTS --body "staging production"`, which turns on
   the nightly backup, the hourly uptime check and the daily retention run at 05:15
   Mexico City (`.github/workflows/retention.yml:24-26`, `:49-52`;
   [PROVISIONING.md §7](PROVISIONING.md#7-github)).
9. **Pilot restaurant setup.** The restaurant owner signs up with Google on their own
   phone (currency MXN, time zone, business cutoff); support grants Pro for the pilot
   (**031**); staff and PINs in Equipo; devices paired and printers configured
   ([PILOT_SOP.md §1–§2](PILOT_SOP.md#1-impresión-y-equipo)); fiscal profile (**027**)
   and CSD upload with CFDI in test mode (**030**, 1.14); the accountant reviews test
   documents (1.13).
10. **Go-live.** Turn on live CFDI (`CFDI_LIVE_ENABLED=true` on the production
    worker, a name Wave 2.0 registered and 030 gives its effect, see 1.14, and the
    restaurant's own go-live in its CFDI settings) when the accountant agrees. Run
    the first service day with the first responder on call
    ([RUNBOOK.md, "Signals"](RUNBOOK.md#signals),
    ["The POS is down" playbook](RUNBOOK.md#the-pos-is-down-playbook)), and record the
    M11 decision and evidence ([PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal)
    step 5).
11. **Rollback, if needed.** [RUNBOOK.md, "Rollback"](RUNBOOK.md#rollback): redeploy an
    older SHA that was live on staging (it keeps the live Railway configuration);
    migrations are expand-only and are never reverted by hand; data is repaired only
    by the reviewed single-tenant procedure
    ([BACKUP_RESTORE.md](BACKUP_RESTORE.md#single-tenant-repair-manual-reviewed)). While
    the restaurant waits, it sells offline or on paper
    ([PILOT_SOP.md §3](PILOT_SOP.md#3-conexión-y-venta-sin-conexión)).

**Stop conditions.** Stop and do not continue when: a `config plan` shows a deletion
you did not expect; a migration or the smoke fails; the restore drill does not
reproduce the control totals; the accountant has not signed off (no live CFDI); the
pilot devices have not passed the PILOT_SOP test print and outage drill.

## 3. Not merged or not verified as of this draft

- Wave 2.0 (platform: signing keyring, worker jobs login, process rules, migrations
  and retention in GitHub Actions) is merged into `integration/v1` but has not run on
  staging or production. No worker-only job kind is registered until 030
  (`server/worker.ts:24-25`).
- 027 fiscal, 028 discounts, 029 reports, 030 cfdi, 031 account and Wave 3
  acceptance: not merged. Until they are, production would have no fiscal tickets,
  invoices, discounts, reports, legal pages or support grants
  ([PILOT_SOP.md §6](PILOT_SOP.md#6-lo-que-todavía-no-está-en-esta-versión)).
- The staging cutover and its Wave 2.0 deltas, every staging run of these runbooks
  (including the first deploy from GitHub Actions and the first retention run), the
  Neon restore rehearsal and the R2 upload: not run ([RUNBOOK.md](RUNBOOK.md),
  [STAGING.md](STAGING.md#wave-20-cutover-record),
  [BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
- Physical printers, tablets, silent printing and a real outage: not checked (1.16).
