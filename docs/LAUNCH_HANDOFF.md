# Launch hand-off

For the owner of the business, who launches production. The decision is **"we
prepare, you launch"**: the team prepares code, scripts and runbooks; every step that
needs your accounts, your credentials, your legal identity or your signature is yours.
This page lists those steps and the order in which to take them. It does not repeat
the runbooks; it links to their sections.

Release version of October 8, 2026, written against `integration/v1` (migrations
through 036; every Wave 2 area, public ordering, the Wave 3 polish, flake, client-address
and CFDI rehearsal fixes and the restaurant-day acceptance gate merged). `main` carries
everything through migration 035; the release pull request brings 036 and the gate.

- **Staging is cut over.** Steps 1–13 of [RUNBOOK.md, "Staging cutover"](RUNBOOK.md#staging-cutover)
  ran on October 6–7, 2026, including the rotations; staging deploys from `main` through
  GitHub Actions and its smoke is green. The record, without secrets, is in
  [STAGING.md](STAGING.md#wave-20-cutover-record). Steps 14 (backup and restore drill)
  and 15 (load test) are still open, with the other items in section 3.
- **Production is not launched.** Nothing has run against it. You launch it, following
  section 2, which mirrors what staging actually needed.

Dates on this page are UTC unless they say Mexico City. Each item in section 1 says
what was done on **staging** (and when) and what remains yours for **production**.
Where an area's own document is more detailed (CFDI, account and legal, public
ordering), that document is the authority.

The restaurant-side companion is [the pilot operating guide](PILOT_SOP.md) (Spanish).

## 1. What only you can supply or do

| # | Item | Staging | Production |
| --- | --- | --- | --- |
| 1.1 | Railway access and project tokens | Done (2026-10-06) | Yours: production project token |
| 1.2 | Production domain and DNS (DNS-only) | Not needed (Railway domain) | Yours |
| 1.3 | Neon project and roles | Done (2026-10-06, cutover step 2) | Yours |
| 1.4 | Rotate the exposed staging database passwords | Done (2026-10-07, cutover steps 11–13) | Nothing exposed; routine rotations only |
| 1.5 | Google OAuth client | Exists (prior staging client) | Yours |
| 1.6 | GitHub protection and environment secrets | Done (2026-10-07, cutover step 8) | Yours: production environment secrets and variables |
| 1.7 | Alert channel (ntfy topic) | **Pending: none set** | Yours |
| 1.8 | Backup encryption key (age) and off-platform storage (R2) | **Staging live 2026-10-08** (backup, retention and a passed restore drill; scheduled); lifecycle rules, token renewal before 2026-11-07 and production remain | Yours |
| 1.9 | Error tracking (Sentry DSN): approve or decline | Off | Your decision |
| 1.10 | Secrets you generate | `SIGNING_KEYS` done (2026-10-07) | Yours |
| 1.11 | Legal entity data (LD-3) | Not set | Yours, after counsel (1.12) |
| 1.12 | Privacy notice publication (counsel) | — | Yours |
| 1.13 | An accountant's confirmation of IVA, CFDI and RESICO behaviour | — | Yours, before live CFDI |
| 1.14 | Facturapi keys and each restaurant's CSD | Test key in place (2026-10-07) | Yours: User key, then live |
| 1.15 | Stripe live mode | Sandbox | Not needed for the pilot launch |
| 1.16 | The pilot restaurant's printer and tablets | — | Yours |
| 1.17 | Contacts, escalation and the go-live decision | — | Yours |
| 1.18 | Custody of the `neondb_owner` password | Rotated 2026-10-07; held by the operator | Yours |
| 1.19 | The older staging Neon branch | **Done: both restore branches deleted (2026-10-07, 2026-10-08)** | — |

### 1.1 Railway access and project tokens

- **Staging: done (2026-10-06).** You supplied a Railway workspace token (LD-36). The
  pinned CLI (5.63.4) rejects workspace tokens for `whoami` and `list`, so the operator
  used Railway's public API, or `RAILWAY_API_TOKEN` per command, and minted a project
  token scoped to the staging environment (`github-cd-staging`), stored as the GitHub
  environment secret `RAILWAY_TOKEN` for `staging`.
- **Production: yours.** A project token scoped to the `production` environment of the
  same Railway project, stored as the `production` environment secret `RAILWAY_TOKEN`
  ([PROVISIONING.md §3](PROVISIONING.md#3-railway) step 2,
  [§7](PROVISIONING.md#7-github)). Mint it yourself in the dashboard, or let the operator
  mint it with the workspace token. Railway's CLI treats `RAILWAY_TOKEN` (project token)
  and `RAILWAY_API_TOKEN` (account or workspace token) as the non-interactive
  alternatives to `railway login` and accepts only one of the two at a time.
- **How to verify.** Listing variable **names** works:
  `railway variable list --service web --environment production --json | jq -r 'keys[]'`.
  For the project token, the first production deploy passes its Railway sync step.

### 1.2 Production domain and DNS

- **Why.** Deployed processes refuse to start without an `https` `APP_URL`
  (`server/config-rules.ts`). The Google OAuth redirect must share `APP_URL`'s origin,
  and session cookies are `Secure`. Staging uses its Railway domain and needs none of
  this.
- **Where it goes.**
  - The domain itself (for example `app.<your-domain>`) and the Cloudflare zone are
    yours ([PROVISIONING.md §0](PROVISIONING.md#0-decisions-defaults-chosen-so-work-is-not-blocked)).
  - Railway: add the custom domain to the `web` service only. Domains are deliberately
    not in IaC; the manual settings are in
    [RUNBOOK.md, "Manual Railway settings"](RUNBOOK.md#manual-railway-settings-not-expressible-in-iac).
  - Cloudflare: create **both** records Railway shows, the `CNAME` and the `TXT`
    ownership record (the domain answers 404 until the `TXT` record verifies).
  - **DNS-only, never proxied (LD-46, LD-49).** Leave the records' proxy status off
    (grey cloud). Railway's edge sends the client's address in `X-Real-IP`, and every
    per-IP limit (PIN sign-in, pairing, public ordering, the CFDI portal, account and
    ops limits) and every `ipHash` in the logs keys on it. Proxied through Cloudflare,
    `X-Real-IP` would be a Cloudflare address shared by many clients, and the deploy
    smoke cannot tell the difference
    ([RUNBOOK.md, "Client address"](RUNBOOK.md#client-address)).
  - Variables: `APP_URL=https://<domain>` on both services, the GitHub environment
    variable `APP_URL`, and `GOOGLE_REDIRECT_URI` (1.5). Section 2, step 9, says when.
- **How to verify.** Railway shows the domain verified with a certificate;
  `curl -s https://<domain>/api/ops/status` answers; the deploy smoke passes its
  client-IP check; `GET https://<domain>/api/ops/diagnostics/ip` from your phone shows
  `peerTrusted: true`, `source: "x-real-ip"` and your phone's own public address.

### 1.3 Neon project and roles

- **Staging: done (2026-10-06, cutover step 2).** `provision-roles.ts --env staging`
  ran as `neondb_owner`: capability roles from `globals.sql` (`gm_jobs_worker`,
  `gm_support` and the others), the `gm_migrator` login with the tables' ownership, the
  worker's jobs login `gm_staging_worker` and the backup login `gm_staging_backup`.
- **Production: yours.** Production gets its own Neon project and least-privilege
  logins: `gm_migrator` owns the schema, `gm_production_app` serves traffic,
  `gm_production_worker` runs the worker's jobs, and the billing and backup logins
  each have one job ([INFRASTRUCTURE.md, "Neon connections"](INFRASTRUCTURE.md#neon-connections)).
  - Your Neon organization, plan and region: Launch (7-day history) or Scale (30-day),
    `aws-us-east-1` to match Railway `us-east4`
    ([PROVISIONING.md §0](PROVISIONING.md#0-decisions-defaults-chosen-so-work-is-not-blocked)).
  - `NEON_API_KEY`, `NEON_ORG_ID` and a pinned `NEONCTL_VERSION` for
    `scripts/ops/provision-neon.sh` ([§1](PROVISIONING.md#1-neon-project)), which writes
    the owner connection to `.env.neon-owner-production`.
  - `scripts/ops/provision-roles.ts --env production` ([§2](PROVISIONING.md#2-roles)),
    `--dry-run` first. It runs `globals.sql` and `database-grants.sql` in one
    transaction and creates the logins, writing `.env.provisioned-production` (0600)
    before that transaction opens; a re-run only appends missing keys. Provision before
    the first production deploy: the `-- 2.0 jobs worker` block of `scripts/grants.sql`
    refuses to apply until `globals.sql` has run, and the deploy then stops before
    Railway.
  - Then reset the `neondb_owner` password and keep it yourself (1.18).
- **How to verify.** The script asserts that no login is privileged and that only
  `gm_migrator` owns tables. As `neondb_owner`:
  `select rolname, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname like 'gm\_%'`
  shows `false` in every privilege column. The first migration run refuses a privileged
  login by itself ([RELEASE.md, "Migrations"](RELEASE.md#migrations)).

### 1.4 Rotate the exposed staging database passwords

- **Staging: done (2026-10-07, about 04:05 UTC, cutover steps 11–13; LD-47).** The
  `gm_staging_app` and `gm_staging_billing` passwords exposed on September 30 no longer
  work anywhere on the staging branch:
  - runtime: `gm_staging_app` → `gm_staging_app_r20261007` (`DATABASE_URL` and
    `PG_APP_USER` on `web`, GitHub variable `PG_APP_USER`), finalized: the old login is
    dropped;
  - billing: `gm_staging_billing` → `gm_staging_billing_r20261007` (`web` and
    `worker`), finalized;
  - `neondb_owner`: a new password set by SQL (`ALTER ROLE … WITH PASSWORD`, which Neon
    supports); the old one is refused (1.18).

  The runtime finalize first refused on a legacy schema grant whose grantor was
  `pg_database_owner`, made before the cutover; the lead cleared it in one verified
  transaction, and `rotate-db-login.ts --finalize` now handles that case itself
  ([RUNBOOK.md, "Credential rotation"](RUNBOOK.md#credential-rotation) step 3). The
  record is in [STAGING.md, "Credential rotation log"](STAGING.md#credential-rotation-log).
  The older Neon branch still carries the old passwords (1.19).
- **Production: nothing was exposed.** Rotate on schedule or after an incident with the
  same procedure ([RUNBOOK.md, "Credential rotation"](RUNBOOK.md#credential-rotation)).
- **How to verify (staging, as `neondb_owner`).**
  `select rolname from pg_roles where rolname in ('gm_staging_app','gm_staging_billing')`
  returns no rows, and the staging smoke passes.

### 1.5 Google OAuth production client

- **Why.** Owners sign up and enter with Google, and each environment needs its own
  OAuth client ([README](../README.md), "Owner signup"). Staging keeps the client it
  already had.
- **Where it goes.** Google Cloud console, a production OAuth web client with redirect
  `https://<domain>/api/auth/google/callback`; `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` on `web`; publish the consent screen
  before inviting real owners
  ([PROVISIONING.md §5](PROVISIONING.md#5-google-oauth-production-client)).
- **How to verify.** On the production domain, the Google button appears and a test
  owner reaches the POS and returns.

### 1.6 GitHub protection and environment secrets

- **Staging: done (2026-10-07, cutover step 8).** `scripts/ops/github-protect.sh` ran
  without a 403, so the plan supports it: the `main` ruleset (pull request required,
  squash or rebase, linear history, required checks `qualify` and `security`, strict),
  and the `staging` and `production` environments deploy only from `main`. The
  `staging` environment holds the secrets `RAILWAY_TOKEN`, `MIGRATION_DATABASE_URL`
  and `BACKUP_DATABASE_URL` and the variables `APP_URL`, `PG_APP_USER` and
  `ALERT_WEBHOOK_KIND`; the repository variables pin `RAILWAY_CLI_VERSION` and
  `RAILWAY_IAC_VERSION`.
- **Required checks after the release merge (lead, not you).** `ops/github/main-ruleset.json`
  also lists `restaurant-day` and `restaurant-day-cfdi`. The lead re-applies it with
  `github-protect.sh` right after the release pull request merges (applying it earlier
  would block pull requests before the workflow exists on `main`; LD-57). See section 3.
- **Production: yours.** The `production` environment has no secrets or variables yet.
  Set them as [PROVISIONING.md §7](PROVISIONING.md#7-github) lists: the secrets
  `RAILWAY_TOKEN` (1.1), `MIGRATION_DATABASE_URL` (`gm_migrator`, direct endpoint, from
  `.env.provisioned-production` on stdin, never on the command line),
  `BACKUP_DATABASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
  `ALERT_WEBHOOK_URL`; the variables `APP_URL`, `PG_APP_USER` (`gm_production_app`),
  `ALERT_WEBHOOK_KIND` (`ntfy`), `R2_ACCOUNT_ID` and `R2_BUCKET`. No Railway service
  holds the migration credential: both processes refuse it.
- **How to verify.** `gh secret list --env production` lists the names;
  `gh variable list --env production` shows `PG_APP_USER`; a pull request shows the
  required checks.

### 1.7 Alert channel (ntfy topic)

- **Staging: pending.** No alert webhook is set: the worker watchdog, the jobs runner,
  retention and the backup and uptime workflows have nowhere to send alerts yet, and the
  Railway deploy webhook (cutover step 10) waits for the same topic.
- **What you supply (both environments).**
  - A long, random ntfy topic: topic names on ntfy.sh are public and the name works as
    a password, so it must not be guessable. One topic per environment, or one shared
    topic, is your choice.
  - `ALERT_WEBHOOK_URL` (and `ALERT_WEBHOOK_KIND=ntfy`) on both services. It must be
    `https` (`alert_webhook_https_required`).
  - The GitHub environment secret `ALERT_WEBHOOK_URL` (the deploy job's retention pass
    and the daily retention workflow alert through it,
    [RUNBOOK.md, "Retention"](RUNBOOK.md#retention)), and Railway's project deploy
    webhook ([RUNBOOK.md, "Manual Railway settings"](RUNBOOK.md#manual-railway-settings-not-expressible-in-iac)).
  - Subscribe the first responder's phone ([PROVISIONING.md §8](PROVISIONING.md#8-monitoring)).
- **How to verify.** `curl -d "Green Monkey: prueba" <topic URL>` reaches the subscribed
  phone. [RUNBOOK.md, "Signals"](RUNBOOK.md#signals) says what each later alert means.

### 1.8 Backup encryption key (age) and off-platform storage (R2)

- **Why.** Nightly dumps are encrypted to a key that never enters GitHub, Railway or any
  server; losing every copy makes the dumps unreadable
  ([BACKUP_RESTORE.md, "Key custody"](BACKUP_RESTORE.md#key-custody)). The Código
  Fiscal de la Federación (art. 30) requires keeping accounting records for five years.
- **Staging: configured on 2026-10-08 (LD-66).** You created `gm-backups-staging`
  and an R2 **Object Read & Write** token; its S3 keys are the staging environment
  secrets, `R2_ACCOUNT_ID`/`R2_BUCKET` the variables, and your age public key is in
  `ops/backup/age-recipients.txt` (one key pair serves staging and production; the
  private key stays with you). Still yours: the bucket's lifecycle rules in the
  dashboard (`daily/` 35 days, `monthly/` 1900 days; the token cannot manage them), and
  **replacing the token before it expires on 2026-11-07** with a bucket-scoped Object
  Read & Write token without expiry (send it to the operator, who updates the two
  secrets). The first manual backup, the first Retention dispatch and the restore drill
  (with your private key, on Neon: all four checks passed, RTO 117 s;
  [evidence](evidence/restore/2026-10-08-staging.json)) ran on 2026-10-08, and
  `OPS_LIVE_ENVIRONMENTS=staging` turned on the scheduled staging jobs (LD-67).
- **What you supply.**
  1. **The R2 buckets.** One per environment: `gm-backups-staging` and
     `gm-backups-production`, created by `scripts/ops/provision-r2.sh <env>` with their
     lifecycle rules (`daily/` kept 35 days, `monthly/` about 5.2 years); production
     adds `--lock` (a 5-year retention lock on `monthly/`). Either you run it yourself
     after `npx wrangler login`, or you give the operator a **temporary** Cloudflare API
     token with the account permission "Workers R2 Storage Write" (it can create
     buckets and set their rules), which `wrangler` reads from `CLOUDFLARE_API_TOKEN`
     together with `CLOUDFLARE_ACCOUNT_ID`; revoke that token once the buckets exist.
  2. **One R2 API token per bucket** (Cloudflare dashboard → R2 → Manage API tokens):
     permission **Object Read & Write**, "Apply to specific buckets only", that bucket
     alone. Its **Access Key ID** and **Secret Access Key** become the environment
     secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; the secret is shown only
     once.
  3. **Your Cloudflare Account ID** (dashboard overview), for the environment variable
     `R2_ACCOUNT_ID`; `R2_BUCKET` is the bucket's name
     ([PROVISIONING.md §6](PROVISIONING.md#6-backups)).
  4. **The age key pair, made offline by you.** On a machine you control:
     `age-keygen -o <offline path>/green-monkey-backup.key`, then
     `age-keygen -y <offline path>/green-monkey-backup.key` prints the public line.
     **Share only that `age1…` public line**; it is committed to
     `ops/backup/age-recipients.txt` (the backup workflow refuses to run until one is
     there). The private key stays with you: password manager plus a printed copy, and
     a second recipient for a recovery holder if you choose.

  Hand the token values over through your password manager or another private channel,
  never in a chat, ticket or email body. The restore drill decrypts a dump, so the
  holder of the private key (you, or the recovery holder) runs that step on a machine
  they control.
- **How to verify.**
  `echo ok | age -R ops/backup/age-recipients.txt | age -d -i <offline key>` prints
  `ok`. Then Actions → Backup → staging, by hand, and the restore drill
  ([BACKUP_RESTORE.md, "Restore rehearsal"](BACKUP_RESTORE.md#restore-rehearsal-quarterly-and-before-launch));
  production repeats it in section 2, step 10.

### 1.9 Error tracking (Sentry DSN): approve or decline

- **Why.** Optional. With `SENTRY_DSN` set, unexpected server errors go to Sentry with
  the request removed and secrets scrubbed (`server/instrument.ts`). It is a third-party
  processor of operational data, so it is your decision (and your counsel's, for 1.12).
- **Where it goes.** `SENTRY_DSN` on both services. `@sentry/node` is **not** a declared
  dependency; once you approve, the team adds it in a reviewed change. Declining needs
  nothing: error tracking stays off.
- **How to verify.** The deploy logs show `error_tracking_enabled`;
  `error_tracking_unavailable` means the DSN is set but the package is missing.

### 1.10 Secrets you generate

Only someone with production access can set these, so they are yours to generate, set
from a private file with `scripts/ops/railway-vars.sh` (never on the command line), and
keep where noted.

- `JWT_SECRET` on `web`: at least 32 characters or the web refuses to start;
  [PROVISIONING.md §3](PROVISIONING.md#3-railway) asks for 64+ random characters. It
  still keys the pairing-code, PIN-fingerprint, invitation and transfer digests, so
  rotate it only together with an emergency signing-key rotation
  ([RUNBOOK.md, "Signing keys"](RUNBOOK.md#signing-keys)). A deployed web refuses the
  CI, local-only and documented placeholder values (`placeholder_jwt_secret`); a
  deployed worker refuses the variable.
- `SIGNING_KEYS` on `web`: one entry printed by
  `node scripts/ops/generate-signing-key.mjs`. **Staging: set on 2026-10-07 (cutover
  step 7).** A deployed web refuses to start without it (`missing_signing_keys`), with
  a malformed one (`invalid_signing_keys`) or with a placeholder (the committed CI
  keyring, a `ci-`/`local-`/`test-` kid, or a secret that decodes to printable text);
  never copy `SIGNING_KEYS` from staging, a track or a CI env file. After any change,
  never roll back from the Railway dashboard (it restores the old variables; RUNBOOK
  "Rollback").
- `CREDENTIAL_ENCRYPTION_KEY` on `worker`: generated with
  `node scripts/cfdi-generate-credential-key.mjs`; it seals each restaurant's Facturapi
  keys. Required together with the Facturapi User key for the `organizations`
  provider (1.14; [CFDI.md, "Environment matrix"](CFDI.md#environment-matrix)). Keep
  an offline copy: restoring those keys from a backup needs it. Staging's shared
  sandbox does not use it, so it is not set there.
- **How to verify.** Both services start (no `ConfigError` code in the deploy logs), the
  deploy smoke passes, and a freshly issued `gm_session` cookie starts with `v2.`
  ([PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal) step 4).

### 1.11 Legal entity data (LD-3)

- **Why.** The platform privacy notice, terms and data-processing agreement read the
  legal entity, address and support contact from configuration; production values come
  from you, and CI and the restaurant-day gate use fictional values (lead decision
  LD-3). The staging cutover did not set them.
- **Where it goes.** `web` variables: required `LEGAL_ENTITY_NAME`,
  `LEGAL_ENTITY_ADDRESS`, `LEGAL_PRIVACY_CONTACT_EMAIL`, `LEGAL_JURISDICTION`; optional
  `LEGAL_ENTITY_RFC`, `LEGAL_PRIVACY_CONTACT_NAME`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`
  (E.164, no spaces), `SUPPORT_WHATSAPP`, `SUPPORT_HOURS`, `SUPPORT_HOURS_EN`,
  `SUPPORT_URL`. [ACCOUNT_AND_LEGAL.md](ACCOUNT_AND_LEGAL.md) is the authoritative list
  with each format. A missing, malformed or placeholder-looking value (or a test/demo
  word in production) counts as missing, and the pages stay unpublished. Leave
  `LEGAL_UNPUBLISHED_SIGNUP` unset in production (it is ignored there anyway).
- **Order.** Setting these values in production **publishes** the documents: do it only
  after your counsel approved the text (1.12). Until then leave them unset; the POS
  works and only new owner signups wait.
- **How to verify.** `GET https://<domain>/api/account-config` reports
  `"legal":{"status":"published",…}`; the web logs carry no
  `legal_documents_unpublished` line; the legal pages show your values; owner signup is
  open ([RELEASE.md, "Go-live checklist"](RELEASE.md#go-live-checklist-account-and-legal)).

### 1.12 Privacy notice publication

- **Why.** Mexican data-protection law (LFPDPPP) requires the notice where personal
  data is collected; production refuses new Google accounts while no notice is
  published.
- **Where it goes.** **Before** the 1.11 values go to production, a Mexican
  data-protection lawyer reviews the notice text (integral and simplified), the terms
  and the data-processing agreement ("contrato de encargo") published at
  `/legal/privacidad`, `/legal/terminos` and `/legal/encargo-de-datos` (English at
  `/legal/privacy`, `/legal/terms`, `/legal/data-processing`), including the
  billing-data consent box, the processor list (Google, Stripe, Neon, Railway,
  Cloudflare, GitHub, Facturapi) and the support-transfer and ARCO wording (LD-32).
  The text is versioned code (`shared/legal.ts`); any change counsel asks for ships as
  a new version (set its `version`, `announcedAt` and `effectiveFrom` to the
  publication date: nothing is in force before it, so nothing needs 15 days' notice).
  Include your decision on Sentry (1.9): if approved, it joins the processor lists in
  that same version.
- **QR and kiosk ordering's diner data (032–034, on for every Pro restaurant).** Give
  counsel this list too, so the platform notice and the guidance for each restaurant's
  own notice cover it (LD-41, PUBLIC-OPS-5):
  - the diner's optional **name** and kitchen **note** on each held order
    (`public_order_holds`). The hold's copy is blanked after **30 days** by the daily
    retention, in any state, or earlier on an ARCO request
    ([PUBLIC_ORDERING.md](PUBLIC_ORDERING.md), "Redacting a hold (ARCO)";
    [OPERATIONS.md](OPERATIONS.md), "ARCO requests"). Once staff accept it, the name and
    note also become the order's call name and note, part of the restaurant's sales
    record, kept with its orders;
  - **`ipHash`** in the `rate_limited` and `public_order_limited` log lines: a 48-bit
    unsalted SHA-256 prefix of the client address (the real client's address since
    LD-46). For IPv4 it can be reversed by enumeration, so it is pseudonymous personal
    data. Logs stay in Railway for the plan's period
    ([RUNBOOK.md](RUNBOOK.md), "Log retention"); record which plan production runs on;
  - each restaurant is the controller for its diners: Configuración and the table QR
    dialogs warn while a restaurant has not set its own notice URL.
- **How to verify.** The three pages open on the production domain with your values;
  the simplified notice appears next to the Google button and restaurant signup; a test
  signup records its acceptance.
- **Pilot restaurants and Pro.** Billing stays disabled at launch, so pilot restaurants
  get Pro from a support operator: provision one operator login
  (`npm run support:provision`, kept on the operator's computer, never on Railway),
  then `npm run support -- grant-entitlement --tenant <id> --until <date>` per pilot
  (at most 90 days, renewable before the end date; every run is visible to the owner).
  Runbook: [OPERATIONS.md](OPERATIONS.md) ("Support").

### 1.13 An accountant's confirmation of IVA, CFDI and RESICO behaviour

- **Why.** Fiscal tickets (027) and CFDI (030, 036) issue documents in the restaurant's
  name; a Mexican accountant confirms their rules before live CFDI (lead decision LD-16,
  item L9).
- **What to confirm** (with the references to show the accountant):
  - IVA is always extracted from tax-inclusive prices, once per category, with the
    documented rounding ([FISCAL.md, "Rounding rule"](FISCAL.md#rounding-rule) and
    ["How money changes affect tax"](FISCAL.md#how-money-changes-affect-tax-the-reconciliation-contract)).
  - The 8 % border-region rate and its expiry date in code,
    `BORDER_STIMULUS_VALID_UNTIL = 2026-12-31`, for border pilots
    ([FISCAL.md, "Verification record"](FISCAL.md#verification-record)). For each border
    restaurant (lead decision LD-25): its place-of-issue postal code carries the SAT
    `c_CodigoPostal` "Estímulo Franja Fronteriza" mark, and its RFC is in the LCO with
    mark 2; the PAC rejects 8 % otherwise, and the app checks only that the postal code
    is in a border state. If no DOF extension is published, border tenants switch to
    16 % on 2027-01-01 (dated check in [RUNBOOK.md](RUNBOOK.md#deploy-window)).
  - Multi-branch RFCs: every ticket prints the issuing branch's address when "Este RFC
    tiene más de una sucursal" is ticked (CFF art. 29-A fr. I).
  - Customer invoices, the global invoice (PUBLICO EN GENERAL) with its periodicity, the
    self-invoicing deadline it bounds, and credit notes for refunds
    ([CFDI.md, "Integration with fiscal, discounts and reports"](CFDI.md#integration-with-fiscal-discounts-and-reports),
    ["Global periods"](CFDI.md#global-periods)), including late offline sales that land
    in a supplementary global part for their own day
    ([OFFLINE_RECOVERY.md, "Late sales and the global invoice"](OFFLINE_RECOVERY.md#late-sales-and-the-global-invoice)).
  - **The FormaPago of orders paid by a delivery platform** (payments 037, LD-71): the
    restaurant setting «Forma de pago SAT para pedidos pagados por plataforma» defaults to
    31 «Intermediario pagos» (alternatives 03, 04, 28; never 99, since every CFDI is PUE),
    and platform tickets go in the normal global invoice
    ([PAYMENTS.md, "CFDI"](PAYMENTS.md#cfdi)). The accountant confirms the form, and that
    the platform's commission (documented by the platform's own CFDI de retenciones) stays
    outside the restaurant's sale. Before CFDI goes live, stamp in the Facturapi sandbox one
    platform ticket individually and one inside a global, both with FormaPago 31, and check
    the PAC accepts them (PAYMENTS-FISCAL-4; the DB suite covers 31 and 03 only against the
    Facturapi fake). Platform modifier prices stay the counter ones: the pilot keeps the
    platform's extras at the counter price, or charges the difference as an open-price line
    (PAYMENTS-FISCAL-5, [PILOT_SOP.md §8](PILOT_SOP.md#8-terminales-y-plataformas)).
  - **RESICO ISR withholding is modelled (030, LD-16 L9) and sandbox-verified on
    2026-10-07.** A nominative invoice from a persona física in régimen 626 to a persona
    moral carries a 1.25 % ISR retention per concept, on the concept's base
    ([CFDI.md, "Regulatory and provider model"](CFDI.md#regulatory-and-provider-model)); in
    the lead's local rehearsal against the real Facturapi sandbox (LD-51) a portal
    invoice to a persona moral stamped it exactly. The accountant still confirms the rule
    before the pilot (which restaurants are 626, and that the retention applies to them
    as modelled), and the **RESICO monthly global close**, which no rehearsal has run.
  - **Receptor names are not checked in Facturapi's test mode** (LD-51 F5): a test
    invoice stamps whatever name the customer typed, so the name check
    (`cfdi_receptor_name_mismatch`, "Escríbelo exactamente como en tu Constancia de
    Situación Fiscal") cannot be rehearsed before live mode. Confirm with Facturapi how
    live mode reports a name that does not match the RFC, and tell staff the first such
    refusals may appear after go-live.
  - **Base and Importe rounding of tax-inclusive concepts** (decision D18, LD-51 F6):
    the app sends each concept at its tax-inclusive price and Facturapi derives the
    concept's Base and IVA Importe; the app compares the stamped totals with fiscal's
    figures (`amount_check`). The accountant (or Facturapi) confirms on a sandbox XML
    that the per-concept Base/Importe rounding is acceptable before the pilot.
  - The USD cash procedure for border restaurants
    ([PILOT_SOP.md §5.1](PILOT_SOP.md#51-dólares-en-efectivo-restaurantes-de-la-frontera)):
    which exchange rate to use and how to keep the paper log.
- **How to verify.** A written sign-off (email is enough) kept with the launch records,
  after the accountant has seen sandbox test documents. The LD-51 rehearsal's files
  carry your own taxpayer identity (1.14): they stay local; show them to the accountant
  yourself if you use them. No live CFDI before the sign-off.

### 1.14 Facturapi keys and each restaurant's CSD

- **Why.** CFDI stamping goes through Facturapi. Live mode is not enabled anywhere.
- **Staging: test key in place (2026-10-07, cutover step 7).** `FACTURAPI_TEST_KEY` on
  the staging `worker`, so staging runs the shared sandbox (`sandbox_shared`): every
  restaurant stamps test CFDIs through the test key's organization, which is the
  issuer. **Decided (LD-51 F4, LD-53):** that organization is registered with your own
  taxpayer identity, so it appears on every staging test CFDI and in the CFDI panel; you
  accepted that, and the test key stays. The rehearsal files that carry that identity
  stay local, out of the repository and out of anything shared. A dedicated Facturapi
  organization with a SAT test identity remains possible later (give the staging
  worker its test key; nothing else changes).
- **Rehearsed so far (LD-51, local, against the real sandbox, 2026-10-07):** activation,
  five sales, portal invoices to a persona física and a persona moral (RESICO retention
  exact), a cancellation with motive 02, a daily global with one concept per ticket and
  a supplementary part from a late offline sale: all nine goals passed. Its findings are
  fixed with migration 036 and two review rounds (LD-55, LD-58, LD-62), verified against
  the Facturapi fake. **Not rehearsed:** the `organizations` provider (your User key, a
  restaurant's CSD upload, going live), a cancellation that needs the receptor's
  acceptance in live mode, credit notes and substitution, the RESICO monthly close, real
  email delivery, receptor-name validation (1.13) and Base vs Importe rounding (1.13).
  See [CFDI.md](CFDI.md) "Open items".
- **Production: yours** (worker variables; a deployed web refuses all of them,
  `forbidden_credential_in_process`; [CFDI.md, "Environment matrix"](CFDI.md#environment-matrix)
  and ["Onboarding runbook"](CFDI.md#onboarding-runbook)):
  - Your Facturapi account and its **User key** (`sk_user_…`) as `FACTURAPI_API_KEY`
    on the production worker, with `CREDENTIAL_ENCRYPTION_KEY` (1.10): the
    `organizations` provider, one Facturapi organization per restaurant, each starting
    in test mode. Production refuses a test key on its own
    (`cfdi_shared_sandbox_not_allowed`).
  - `CFDI_LIVE_ENABLED=true` on the production worker only when you decide to go live
    (after 1.13); it is refused anywhere else (`cfdi_live_not_allowed`).
  - **Each restaurant's CSD** (Certificado de Sello Digital: the `.cer`, the `.key` and
    the key's password; not the e.firma, which the restaurant uses to request the CSD
    from SAT). The restaurant owner uploads it in the app's CFDI settings (owner, PIN
    step-up); the worker sends it to that restaurant's Facturapi organization once.
  - Optionally, before the pilot, the same User key and a `CREDENTIAL_ENCRYPTION_KEY` on
    the **staging** worker for the organizations-provider rehearsal (section 3).
- **How to verify.** The worker starts without a CFDI configuration error; the CFDI
  settings show test mode; a test invoice stamps; after go-live the accountant reviews
  the first real invoice.

### 1.15 Stripe live mode

- **Why.** Live Pro subscriptions. **Not needed for the pilot launch:** production
  launches with billing disabled (`BILLING_SANDBOX_ENABLED` unset;
  [PROVISIONING.md §3](PROVISIONING.md#3-railway) step 4; [RUNBOOK.md, "Open follow-ups"](RUNBOOK.md#open-follow-ups)
  DB-1), today's billing code cannot use live keys ([README](../README.md), "Billing
  implementation in progress"), and pilots get Pro through an audited support grant
  (1.12). Staging keeps its Stripe sandbox keys on the worker (cutover step 7).
- **Where it goes.** In the Stripe Dashboard, complete account activation: business
  type, tax and business details, the representative's identity verification,
  customer-facing information, a bank account for payouts and two-step authentication
  (Stripe's "Go live" documentation). The live secret key, account id, prices and
  portal configuration go to the worker, and the live webhook signing secret to web
  (`STRIPE_WEBHOOK_SECRET`), only when a post-launch billing area adds live mode. Stripe
  issues separate test and live signing secrets, so the test-mode value cannot be
  reused.
- **How to verify.** The Dashboard shows the account activated for live payments with a
  verified payout bank account; its account id is the one you will set as
  `STRIPE_EXPECTED_ACCOUNT_ID`.

### 1.16 The pilot restaurant's printer and tablets

- **Why.** Real tablets, real 58/80 mm thermal printers and a real internet outage are
  release gates that have never been checked
  ([OFFLINE_RECOVERY.md, "Verification"](OFFLINE_RECOVERY.md#verification);
  [SERVICE.md](SERVICE.md)).
- **Where it goes.** You buy or choose the devices with the restaurant; the installer
  follows [PILOT_SOP.md §1–§2](PILOT_SOP.md#1-impresión-y-equipo) (OS driver: paper
  width, no margins, 100 % scale, auto-cut and cash-drawer kick are driver features;
  silent printing is unconfirmed).
- **How to verify.** The full test print in [PILOT_SOP.md §1.2](PILOT_SOP.md#12-configurar-la-impresora-térmica-58-u-80-mm-en-el-sistema-operativo)
  step 10 passes on each device, and one deliberate outage (router unplugged) is sold
  through and synced, as [PILOT_SOP.md §3](PILOT_SOP.md#3-conexión-y-venta-sin-conexión)
  describes. If the pilot uses QR or kiosk ordering, also run the field checks in
  [PUBLIC_ORDERING.md](PUBLIC_ORDERING.md#field-checks-before-printing-at-scale): a
  printed table card scanned by the diners' phone cameras keeps its `#` code, and a
  kiosk tablet uses its own browser profile.

### 1.17 Contacts, escalation and the go-live decision

- Fill in [RUNBOOK.md, "Contacts and escalation"](RUNBOOK.md#contacts-and-escalation)
  (first responder, backup responder, hours) and the restaurant's table in
  [PILOT_SOP.md §7](PILOT_SOP.md#7-a-quién-llamar).
- The launch itself (M11 in [COMPLETION_LEDGER.md](COMPLETION_LEDGER.md)) is your
  recorded decision ([PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal)
  step 5).

### 1.18 Custody of the `neondb_owner` password

- **Why.** `neondb_owner` is Neon's owner role: it bypasses row-level security and can
  change every role. The team needs it only for owner steps (provisioning, rotations,
  the DB-9 check, a restore drill); nothing deployed holds it.
- **Staging.** Rotated on 2026-10-07 by SQL (cutover step 13); the new value is held by
  the operator, outside the repository. You may reset it at any time from the Neon
  console (the branch's Roles page), with the API, or with `ALTER ROLE … WITH PASSWORD`;
  the new password applies to the next connection. If you do, give the operator the
  new value only when an owner step needs it.
- **Production: yours.** Reset it right after provisioning (1.3) and keep it in your
  password manager; hand it to the operator for each owner step and reset it afterwards
  if you prefer.

### 1.19 The older staging Neon branch

- **Done.** Both restore branches taken before the staging changes are deleted with your
  approval: `pre-cutover-staging-2026-10-06` on 2026-10-07 (LD-53) and
  `pre-021-staging-backup-2026-09-30` on 2026-10-08 (LD-65). The project keeps only its
  primary branch, so no branch carries the pre-rotation passwords any more.

## 2. Launch sequence

Production repeats what staging needed, in the same order. Each step names the runbook
section that holds the commands and the staging step it mirrors; do not start a step
before the previous one is verified.

0. **Preconditions.**
   - The release pull request (`release/v1` → `main`) merged and its automatic staging
     deploy green: that deploy applies 036 and marks its SHA with the
     `deploy/staging` status.
   - The `restaurant-day` and `restaurant-day-cfdi` required checks applied, and two
     consecutive green CI runs of the restaurant-day gate
     ([RELEASE.md, "Restaurant-day gate"](RELEASE.md#restaurant-day-gate-githubworkflowsrestaurant-dayyml)).
   - Staging steps 14 and 15: the first staging backup and restore drill (1.8) and the
     load test with the pool decision ([LOAD_TEST.md](LOAD_TEST.md)).
   - Items 1.1–1.12, 1.16 and 1.17 done for production. 1.13 (accountant) and live
     CFDI may follow the launch, before step 12 turns live CFDI on.
1. **Neon production roles.** [PROVISIONING.md §1](PROVISIONING.md#1-neon-project) and
   [§2](PROVISIONING.md#2-roles): `provision-neon.sh production`, then
   `provision-roles.ts --env production`, `--dry-run` first each time; then reset
   `neondb_owner` (1.3, 1.18). Staging: cutover step 2.
2. **Production project token.** [PROVISIONING.md §3](PROVISIONING.md#3-railway)
   steps 1–2: a Railway project token scoped to `production` (1.1), for the GitHub
   secret of step 5. Staging: the `github-cd-staging` token.
3. **Inventory, then `config plan`, then apply.** [RUNBOOK.md, "Staging cutover"](RUNBOOK.md#staging-cutover)
   steps 4–6 with `--environment production`: list both services' variable **names**
   (never values); every name `.railway/railway.ts` does not declare is planned as a
   deletion. On a fresh environment the plan should show only additions
   ([PROVISIONING.md §3](PROVISIONING.md#3-railway) step 3); apply with
   `--confirm-destructive` only if its deletions are exactly names you wrote down, as on
   staging (whose deletions were exactly the 7 retired and 2 leftover names). Any other
   deletion: stop. A second plan must show no changes.
4. **`railway-vars.sh production`** from a private file
   ([PROVISIONING.md §3](PROVISIONING.md#3-railway) step 4; staging: cutover step 7):
   - `web`: `SIGNING_KEYS` and `JWT_SECRET` (1.10), `DATABASE_URL` and `PG_APP_USER`,
     `APP_URL` (the Railway domain until step 9), Google OAuth (1.5);
   - `worker`: `WORKER_DATABASE_URL`, `APP_URL`, `ALERT_WEBHOOK_URL` (1.7);
   - billing per its state: disabled at launch, so `BILLING_SANDBOX_ENABLED` unset, no
     `BILLING_DATABASE_URL` on `web` (it refuses to start with it while billing is off)
     and no Stripe keys (1.15);
   - CFDI: the Facturapi User key and `CREDENTIAL_ENCRYPTION_KEY` on `worker` for the
     `organizations` provider (1.14); `CFDI_LIVE_ENABLED` not yet;
   - legal values per LD-3 only once counsel has approved the text (1.11, 1.12);
   - never `MIGRATION_DATABASE_URL` on any service.
   Then the manual settings in [RUNBOOK.md](RUNBOOK.md#manual-railway-settings-not-expressible-in-iac).
5. **GitHub production environment secrets and variables** (1.6;
   [PROVISIONING.md §7](PROVISIONING.md#7-github); staging: cutover step 8).
   `github-protect.sh` already limits `production` to `main`; do not add `production`
   to `OPS_LIVE_ENVIRONMENTS` yet.
6. **DB-9 check on production.** [RUNBOOK.md, "DB-9 validation"](RUNBOOK.md#db-9-validation),
   as `neondb_owner`, never `gm_migrator`; it must return no rows (PUBLIC-OPS-8;
   staging: 0 rows on 2026-10-07). On a database the first deploy has not created yet
   there are no tables to check (the query reports a missing relation); it matters
   whenever production already holds data.
7. **Dispatch the production deploy.** Actions → Deploy → Run workflow with the full
   SHA that carries the `deploy/staging` status, and the phrase
   `deploy <sha7> to production`
   ([RELEASE.md, "Continuous delivery"](RELEASE.md#continuous-delivery-githubworkflowsdeployyml)).
   Dispatch it **before 07:00 Mexico City**: the deploy job migrates as `gm_migrator`
   before it touches Railway, and migrations 027, 030, 032 and 034 belong before
   breakfast service ([RUNBOOK.md, "Deploy window"](RUNBOOK.md#deploy-window)). If the
   migrate step fails, nothing on Railway changes. Staging: cutover step 9 (deploys of
   October 7).
8. **Smoke.** The workflow runs `scripts/ops/smoke.mjs --expect-commit <sha>` against
   `APP_URL` (live commit, health, worker on the same commit with its jobs runner on,
   client IP, malformed JSON, session required). Then by hand the go-live checks of
   [PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal) steps 2 and 4:
   `/api/ops/status` not degraded, `worker_ready` with `jobs:true`, a fresh
   `gm_session` cookie starting with `v2.`, the ntfy test (1.7). A failed `client_ip`
   check stops the launch ([RUNBOOK.md, "Client address"](RUNBOOK.md#client-address);
   staging's first deploy failed it until LD-46).
9. **DNS, DNS-only.** [PROVISIONING.md §4](PROVISIONING.md#4-domain-and-tls) and
   [§5](PROVISIONING.md#5-google-oauth-production-client) (1.2, 1.5): the custom domain
   on `web`, the `CNAME` and `TXT` records in Cloudflare with the proxy **off**; then
   `APP_URL` on both services and the GitHub variable, and `GOOGLE_REDIRECT_URI` with the
   Google client's redirect, all on the new domain. Dispatch the same SHA again so the
   smoke runs against the domain, and check `/api/ops/diagnostics/ip` by hand from your
   own connection.
10. **First backup and restore drill.** Actions → Backup → production, by hand; then the
    restore rehearsal from that dump
    ([BACKUP_RESTORE.md, "Restore rehearsal"](BACKUP_RESTORE.md#restore-rehearsal-quarterly-and-before-launch)),
    with RTO/RPO written to `docs/evidence/restore/`; then Actions → Retention →
    production, by hand, which must be green
    ([RELEASE.md, "Retention"](RELEASE.md#retention-githubworkflowsretentionyml)).
11. **`OPS_LIVE_ENVIRONMENTS`.** Only now
    `gh variable set OPS_LIVE_ENVIRONMENTS --body "staging production"` (staging once its
    own drill passed), which turns on the nightly backup, the hourly uptime check and
    the daily retention run at 05:15 Mexico City
    ([PROVISIONING.md §7](PROVISIONING.md#7-github)).
12. **Pilot.** The restaurant owner signs up with Google on their own phone (currency
    MXN, time zone, business cutoff); support grants Pro (1.12); staff and PINs in
    Equipo; devices paired and printers configured
    ([PILOT_SOP.md §1–§2](PILOT_SOP.md#1-impresión-y-equipo), 1.16); fiscal profile and
    CFDI activation in test mode with the restaurant's CSD (1.14); the accountant reviews
    test documents (1.13). Live CFDI (`CFDI_LIVE_ENABLED=true` on the production worker,
    then the restaurant's own "Pasar a modo real") only when the accountant agrees. Run
    the first service day with the first responder on call
    ([RUNBOOK.md, "Signals"](RUNBOOK.md#signals),
    ["The POS is down" playbook](RUNBOOK.md#the-pos-is-down-playbook)), and record the
    M11 decision and evidence ([PROVISIONING.md §10](PROVISIONING.md#10-first-deploy-and-rehearsal)
    step 5).

**Rollback, if needed.** [RUNBOOK.md, "Rollback"](RUNBOOK.md#rollback): redeploy an
older SHA that was live on staging (it keeps the live Railway configuration); never
roll back from the Railway dashboard; migrations are expand-only and are never reverted
by hand; data is repaired only by the reviewed single-tenant procedure
([BACKUP_RESTORE.md](BACKUP_RESTORE.md#single-tenant-repair-manual-reviewed)). QR and
kiosk ordering turn off with `PUBLIC_ORDERING_ENABLED=false` on `web`
([RUNBOOK.md, "Online ordering abuse"](RUNBOOK.md#online-ordering-abuse) step 6). While
the restaurant waits, it sells offline or on paper
([PILOT_SOP.md §3](PILOT_SOP.md#3-conexión-y-venta-sin-conexión)).

**Stop conditions.** Stop and do not continue when: a `config plan` shows a deletion
you did not expect; the DB-9 check returns rows; a migration or the smoke fails; the
restore drill does not reproduce the control totals; the domain is proxied; the
accountant has not signed off (no live CFDI); the pilot devices have not passed the
PILOT_SOP test print and outage drill.

## 3. Not merged or not verified

As of October 8, 2026:

- **Production:** not launched; nothing has run against it. The `production` GitHub
  environment has no secrets or variables, and section 2 has not started.
- **Release pull request:** `integration/v1` carries what `main` does not yet: migration
  036 (CFDI rehearsal fixes), the restaurant-day gate and its workflow, and the
  formatting-only commit. `main` (and therefore staging) is at migration 035; staging
  applies 036 when the release merges.
- **Restaurant-day gate (LD-57, LD-59, LD-60):** passes locally (branch N twice in a row,
  branch K against the Facturapi fake;
  [ACCEPTANCE_STATUS.md](ACCEPTANCE_STATUS.md#restaurant-day-go-live-gate-specsacceptancemd-v11)).
  Still open: the lead applies the `restaurant-day` and `restaurant-day-cfdi` required
  checks right after the release pull request merges; two consecutive green CI runs;
  `RD_NIGHTLY_REF` for the nightly run; `deploy.yml` does not yet require the gate
  before a production dispatch (ops follow-up). The `RD_*` repository variables hold a
  fictional set. `FACTURAPI_TEST_KEY` is not a GitHub secret, so `restaurant-day-cfdi`
  reports skipped in CI.
- **Staging, still pending:** the first backup and the restore drill, then the first
  Retention dispatch and `OPS_LIVE_ENVIRONMENTS=staging` (cutover step 14; needs 1.8);
  the load test `target` and `stress` and the pool decision, including public ordering's
  polls (step 15, PUBLIC-OPS-7); the alert webhook and the Railway deploy webhook
  (step 10; needs 1.7); the older Neon branch (1.19); the CFDI organizations-provider
  rehearsal (1.14).
- **CFDI against the real sandbox:** the shared-sandbox flows passed locally on
  2026-10-07 (LD-51); staging runs `sandbox_shared` with your test key. Not rehearsed:
  the organizations provider (User key, CSD, going live), live cancellation acceptance,
  credit notes and substitution, the RESICO monthly close, real email, receptor-name
  validation, Base vs Importe rounding (1.13, 1.14).
- **Owner inputs not yet given:** legal values and counsel review (1.11, 1.12),
  accountant sign-off (1.13), Facturapi User key (1.14), Sentry decision (1.9),
  contacts (1.17).
- **Hardware:** physical printers, tablets, silent printing and a real outage: not
  checked (1.16). QR scanners and printed cards are field checks.
