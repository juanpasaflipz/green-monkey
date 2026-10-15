# Launch hand-off

For the owner of the business, who launches production. The decision is **"we
prepare, you launch"**: the team prepares code, scripts and runbooks; every step that
needs your accounts, your credentials, your legal identity or your signature is yours.
This page lists those steps and the order in which to take them. It does not repeat
the runbooks; it links to their sections.

Production version of October 9, 2026. `main` carries the release (migrations 001–036,
every Wave 2 area, public ordering, the Wave 3 polish, flake, client-address and CFDI
rehearsal fixes and the restaurant-day acceptance gate; pull request #8, LD-64), and
staging and production run it.

- **Staging is cut over.** Steps 1–13 of [RUNBOOK.md, "Staging cutover"](RUNBOOK.md#staging-cutover)
  ran on October 6–7, 2026, including the rotations; staging deploys from `main` through
  GitHub Actions and its smoke is green. Step 14 (first backup, restore drill,
  `OPS_LIVE_ENVIRONMENTS=staging`) passed on October 8 (1.8). The record, without
  secrets, is in [STAGING.md](STAGING.md#wave-20-cutover-record). Step 15 (load test) is
  still open, with the other items in section 3.
- **Production is live (October 9, 2026, 07:35 Mexico City) at
  `https://app.greenmonkey.online`.** Section 2 steps 0–9 are done (LD-68, LD-69, LD-73):
  the Neon project and logins, Railway `web` and `worker`, the GitHub `production`
  environment, the custom domain (DNS-only), Google sign-in and the Facturapi User key
  (CFDI in test mode). The production deploy applied migrations 001–036, its smoke passed
  all six checks on the domain and the worker runs its jobs. The support operator login
  `gm_support_lead` is provisioned for the pilot's Pro grant (1.12).
  - **No restaurant is onboarded yet.** Owner signup stays paused (`signup_paused`)
    until the legal values are published (1.11, 1.12).
  - **Steps 10 and 11 done (2026-10-10).** The first production backup to your bucket
    `gm-prod-backups` and the production restore drill passed (all four checks, RTO
    162 s; [evidence](evidence/restore/2026-10-10-production.json)), and
    `OPS_LIVE_ENVIRONMENTS="staging production"` turned on the scheduled production
    backup and retention (1.8).
  - **What remains:** step 12 (the pilot, with
    [the cutover checklist for Juanberto's](#4-cutover-checklist-for-juanbertos)).
  - **Opened on your decision (LD-68).** Some of step 0's preconditions were still open at
    launch: the staging load test, the alert topic (1.7), the legal values (1.11, 1.12),
    the pilot hardware (1.16) and the contacts (1.17). They now gate step 12.

Dates on this page are UTC unless they say Mexico City. Each item in section 1 says
what was done on **staging** (and when) and what remains yours for **production**.
Where an area's own document is more detailed (CFDI, account and legal, public
ordering), that document is the authority.

The restaurant-side companion is [the pilot operating guide](PILOT_SOP.md) (Spanish).

## 1. What only you can supply or do

| # | Item | Staging | Production |
| --- | --- | --- | --- |
| 1.1 | Railway access and project tokens | Done (2026-10-06) | **Done (2026-10-08):** project token `github-cd-production` |
| 1.2 | Production domain and DNS (DNS-only) | Not needed (Railway domain) | **Done (2026-10-08):** `app.greenmonkey.online`, DNS-only; yours: revoke the temporary DNS token |
| 1.3 | Neon project and roles | Done (2026-10-06, cutover step 2) | **Done (2026-10-08)**; yours: revoke the temporary Neon API key |
| 1.4 | Rotate the exposed staging database passwords | Done (2026-10-07, cutover steps 11–13) | Nothing exposed; routine rotations only |
| 1.5 | Google OAuth client | Exists (prior staging client) | **Done:** production client on `web`; yours: rotate its secret at cutover |
| 1.6 | GitHub protection and environment secrets | Done (2026-10-07, cutover step 8) | **Done for the deploy (2026-10-08)**; R2 and alert values follow 1.7 and 1.8 |
| 1.7 | Alert channel (ntfy topic) | **Pending: none set** | **Pending: none set** |
| 1.8 | Backup encryption key (age) and off-platform storage (R2) | **Staging live 2026-10-08; production live 2026-10-10** (backup, retention and a passed restore drill each; scheduled) | Yours: the lifecycle rules on both buckets, `gm-prod-backups`'s retention lock on `monthly/`, the staging token's replacement before 2026-11-07, and rotating the production keys that passed through the chat |
| 1.9 | Error tracking (Sentry DSN): approve or decline | Off | Your decision |
| 1.10 | Secrets you generate | `SIGNING_KEYS` done (2026-10-07) | **Done (2026-10-08)**; yours: an offline copy of `CREDENTIAL_ENCRYPTION_KEY` |
| 1.11 | Legal entity data (LD-3) | Not set | **Not set: owner signup paused**; yours, after counsel (1.12) |
| 1.12 | Privacy notice publication (counsel) | — | Yours. Support operator for the Pro grant: **provisioned** (`gm_support_lead`) |
| 1.13 | An accountant's confirmation of IVA, CFDI and RESICO behaviour | — | Yours, before live CFDI |
| 1.14 | Facturapi keys and each restaurant's CSD | Test key in place (2026-10-07) | **User key done (2026-10-08): test mode**; live after the accountant (1.13); each restaurant's CSD |
| 1.15 | Stripe live mode | Sandbox | Not needed for the pilot launch |
| 1.16 | The pilot restaurant's printer and tablets | — | Yours: GHIA GTP801 through pos-lite's `ghia-web` queue, not yet test-printed |
| 1.17 | Contacts, escalation and the go-live decision | — | Yours |
| 1.18 | Custody of the `neondb_owner` password | Rotated 2026-10-07; held by the operator | Held by the operator, never displayed; yours: reset and keep it |
| 1.19 | The older staging Neon branch | **Done: both restore branches deleted (2026-10-07, 2026-10-08)** | — |
| 1.20 | Loyalty club inputs (038): the club reward and its cap (LD-72: one free product up to $150 by default), the restaurant's privacy-notice update that covers the club (counsel), the pos-lite export run at cutover and pos-lite's copy purged after it; the platform notice and DPA that cover the club are published first (1.12; the club refuses to turn on before, `loyalty_legal_required`) | — | Yours, before enabling the club |
| 1.21 | Kiosk self-checkout and menu photos (039; [1.16a](#116a-kiosk-self-checkout-the-media-bucket-and-the-field-checks-039)): a private R2 **media** bucket per environment with a bucket-scoped, non-expiring Object Read & Write token (R46); the R44a device rehearsal at both readers, then `PAYMENTS_PROVIDERS` on the production worker (a reviewed `railway.ts` change); the kiosk field checks and the R44b combined Wave 4 rehearsal; then the reviewed `railway.ts` change that sets `KIOSK_SELF_CHECKOUT_ENABLED` and `MENU_PHOTOS_ENABLED` to `"true"` in production | Switches on (`preserve()`, unset means on); integrated charging served (`mercadopago,clip`); yours: the media bucket and token, R44a and R44b | Switches `"false"` and `PAYMENTS_PROVIDERS` undeclared until R44a, the field checks and R44b pass; yours: the media bucket and token |

### 1.1 Railway access and project tokens

- **Staging: done (2026-10-06).** You supplied a Railway workspace token (LD-36). The
  pinned CLI (5.63.4) rejects workspace tokens for `whoami` and `list`, so the operator
  used Railway's public API, or `RAILWAY_API_TOKEN` per command, and minted a project
  token scoped to the staging environment (`github-cd-staging`), stored as the GitHub
  environment secret `RAILWAY_TOKEN` for `staging`.
- **Production: done (2026-10-08, LD-68).** The operator minted a project token scoped to
  the `production` environment of the same Railway project (`github-cd-production`,
  verified) with the workspace token and stored it as the `production` environment secret
  `RAILWAY_TOKEN` ([PROVISIONING.md §3](PROVISIONING.md#3-railway) step 2,
  [§7](PROVISIONING.md#7-github)). Railway's CLI treats `RAILWAY_TOKEN` (project token)
  and `RAILWAY_API_TOKEN` (account or workspace token) as the non-interactive
  alternatives to `railway login` and accepts only one of the two at a time.
- **How to verify.** Listing variable **names** works:
  `railway variable list --service web --environment production --json | jq -r 'keys[]'`.
  For the project token, the first production deploy passes its Railway sync step.

### 1.2 Production domain and DNS

- **Production: done (2026-10-08, LD-69).** `app.greenmonkey.online` is the custom domain
  of the production `web` service (the apex stays free). Cloudflare holds Railway's `CNAME`
  and `TXT` ownership records for it, both DNS-only, created with your temporary DNS
  token; Railway verified the domain and its certificate. `APP_URL` (both services and the
  GitHub `production` variable) was set to `https://app.greenmonkey.online` before the
  first deploy, so the smoke ran on the domain. On 2026-10-09
  `/api/ops/diagnostics/ip` returned the operator's own public address with source
  `x-real-ip`, and the domain serves HTTPS with HSTS and CSP. **Yours:** revoke the
  temporary Cloudflare DNS token; the records are in place.
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
- **Production: done (2026-10-08, LD-69).** Project `green-monkey-production` in
  `aws-us-east-1` (PostgreSQL 18), database `green_monkey_production`, 7-day history,
  daily and weekly snapshots kept 35 days, protected default branch; logins
  `gm_migrator`, `gm_production_app`, `gm_production_billing`, `gm_production_worker` and
  `gm_production_backup`. `provision-neon.sh` created the project but failed parsing
  `neonctl`'s JSON before its remaining steps; the lead finished them through the Neon
  API (follow-up: make the script's parsing robust). The owner connection and the logins
  are held by the operator outside the repository and were never displayed. **Yours:**
  revoke the temporary Neon API key (the production Neon steps are done), and reset and
  keep `neondb_owner` (1.18).
- **The procedure, for reference.** Production gets its own Neon project and
  least-privilege logins: `gm_migrator` owns the schema, `gm_production_app` serves traffic,
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

- **Production: done (before the 2026-10-09 go-live, LD-71).** Your production OAuth
  client is set on `web`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `GOOGLE_REDIRECT_URI=https://app.greenmonkey.online/api/auth/google/callback`.
  **Yours:** make sure the consent screen is published before the pilot owner signs up,
  and rotate the client secret at cutover, since it passed through a chat (LD-72; section
  4).
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
  also lists `restaurant-day`, `restaurant-day-cfdi` and `restaurant-day-payments` (the
  payments and kiosk branches P and S, LD-104). The lead re-applies it with
  `github-protect.sh` right after the release pull request merges (applying it earlier
  would block pull requests before the workflow exists on `main`; LD-57). See section 3.
- **Production: done for the deploy (2026-10-08, LD-69).** The `production` environment
  holds the secrets `RAILWAY_TOKEN` (1.1), `MIGRATION_DATABASE_URL` (`gm_migrator`, direct
  endpoint) and `BACKUP_DATABASE_URL`, and the variables `APP_URL`
  (`https://app.greenmonkey.online`), `PG_APP_USER` (`gm_production_app`) and
  `ALERT_WEBHOOK_KIND` (`ntfy`). **Still to add**, as
  [PROVISIONING.md §7](PROVISIONING.md#7-github) lists: the secrets `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY` and `ALERT_WEBHOOK_URL`, and the variables `R2_ACCOUNT_ID` and
  `R2_BUCKET` (1.7, 1.8). No Railway service holds the migration credential: both
  processes refuse it.
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
- **Production: live 2026-10-10.** You created the bucket `gm-prod-backups` and its
  bucket-scoped Object Read & Write token; its keys are the production environment's
  `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, with `R2_ACCOUNT_ID` and
  `R2_BUCKET=gm-prod-backups` as variables, and the same age key pair. The first backup,
  then the restore drill with your private key on Neon (all four checks passed, RTO
  162 s, pg_restore 134 s; [evidence](evidence/restore/2026-10-10-production.json)),
  then `OPS_LIVE_ENVIRONMENTS="staging production"` (LD-99). Production's default branch
  is protected, so Neon gives the drill's point-in-time branch its own role passwords;
  the drill reads them (`scripts/ops/branch-url.ts`). Still yours: the bucket's lifecycle
  rules (`daily/` 35 days, `monthly/` 1900 days) and the 5-year retention lock on
  `monthly/` in the dashboard (the bucket was created by hand, not by
  `provision-r2.sh --lock`); and, because the token and keys were pasted in the chat,
  a new token at cutover (1.5).
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

**Production: set on 2026-10-08 (LD-68, LD-69).** The operator generated `SIGNING_KEYS`
and `JWT_SECRET` (on `web`) and `CREDENTIAL_ENCRYPTION_KEY` (on `worker`); they are held
outside the repository. **Yours:** take the offline copy of `CREDENTIAL_ENCRYPTION_KEY`.

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
- **Production: not set (2026-10-09).** Owner signup answers `signup_paused`, so no
  restaurant can be onboarded yet; the Juanberto's pilot waits for these values.
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
  Cloudflare, GitHub, Facturapi), the support-transfer and ARCO wording (LD-32) and the
  loyalty club paragraphs of version `2026-10-09` (privacy §5–§6, DPA §2, §6, §11;
  [ACCOUNT_AND_LEGAL.md](ACCOUNT_AND_LEGAL.md#the-loyalty-club-038)). No restaurant can
  turn the club on until this set is published (`loyalty_legal_required`). Ask counsel
  too about the club's two retention choices: an order's call name (a member's first
  name) stays on past orders after an ARCO deletion as a sales record, and marketing
  opt-ins are unverified until a double opt-in exists (LOYALTY.md "Privacy").
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
  get Pro from a support operator. **Production: the operator login `gm_support_lead` is
  provisioned** (`npm run support:provision`, kept on the operator's computer, never on
  Railway). On the day the owner signs up, run
  `npm run support -- grant-entitlement --tenant <id> --until <date>` for the pilot (at
  most 90 days, renewable before the end date; every run is visible to the owner).
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
- **Production: User key done, test mode (2026-10-08, LD-68, LD-69).** Your Facturapi
  User key is `FACTURAPI_API_KEY` on the production worker, with
  `CREDENTIAL_ENCRYPTION_KEY` (1.10), so the `organizations` provider is active.
  `CFDI_LIVE_ENABLED` stays unset until the accountant signs off (1.13). Juanberto's gets
  its own new Facturapi organization when the owner activates CFDI in the POS and uploads
  its CSD. The organization live key you sent first was neither stored nor used (this
  provider needs the User key): renew it, since it passed through the chat. Rotate the
  User key at cutover for the same reason; the operator then updates the worker variable
  (section 4).
- **The production rules, for reference** (worker variables; a deployed web refuses all
  of them, `forbidden_credential_in_process`;
  [CFDI.md, "Environment matrix"](CFDI.md#environment-matrix) and
  ["Onboarding runbook"](CFDI.md#onboarding-runbook)):
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
  follows [PILOT_SOP.md §1–§2](PILOT_SOP.md#1-impresión-y-equipo) (paper width, no
  margins, 100 % scale; cutting and the cash-drawer kick belong to the OS print queue;
  silent printing is unconfirmed).
- **Juanberto's (LD-70 B1, LD-71).** A GHIA GTP801 (80 mm, USB) on the store Mac. The
  vendor's Gainscha macOS driver does not work with it (it sends Star raster), so the Mac
  keeps pos-lite's `ghia-web` CUPS queue (installed by pos-lite's
  `print-bridge/install-ghia-web.sh`) as the system default, and pos-lite's macOS print
  pieces are not uninstalled at cutover. Every document opens the print dialog; there is
  no silent printing in the pilot. `ghia-web` cuts after every Chrome page, so each
  station's comanda gets its own cut, and a document longer than the chosen page is cut
  mid-document; it never opens the drawer. An iPad cannot print to it (no AirPrint), and
  KDS sound, off by default, is switched on on the kitchen device
  ([PILOT_SOP.md §1.2](PILOT_SOP.md#12-configurar-la-impresora-del-piloto-ghia-gtp801-usb-mac-de-la-caja)).
- **How to verify.** The full test print in [PILOT_SOP.md §1.2](PILOT_SOP.md#12-configurar-la-impresora-del-piloto-ghia-gtp801-usb-mac-de-la-caja)
  step 10 passes on each device that prints (at Juanberto's, the store Mac), and one deliberate outage (router unplugged) is sold
  through and synced, as [PILOT_SOP.md §3](PILOT_SOP.md#3-conexión-y-venta-sin-conexión)
  describes. If the pilot uses QR or kiosk ordering, also run the field checks in
  [PUBLIC_ORDERING.md](PUBLIC_ORDERING.md#field-checks-before-printing-at-scale): a
  printed table card scanned by the diners' phone cameras keeps its `#` code, and a
  kiosk tablet uses its own browser profile.

### 1.16a Kiosk self-checkout: the media bucket and the field checks (039)

- **Why.** Kiosk card payment, photos and the tablet setup have never run on the real Tab S10 FE,
  the real Mercado Pago Point and Clip readers, or a real R2 bucket ([KIOSK.md](KIOSK.md)).
- **What only you can supply.** A private Cloudflare R2 bucket for menu photos, one per
  environment (separate from the backup buckets), and for each a **bucket-scoped Object Read &
  Write token that does not expire** (LD-66's backup token expires on 2026-11-07; do not repeat
  that). They go on web only, from your private file with `scripts/ops/railway-vars.sh <env>`
  under `# service: web`: `MEDIA_STORE=r2`, `MEDIA_R2_ACCOUNT_ID` (the 32-character account
  ID), `MEDIA_R2_BUCKET`, `MEDIA_R2_ACCESS_KEY_ID`, `MEDIA_R2_SECRET_ACCESS_KEY`
  ([INFRASTRUCTURE.md](INFRASTRUCTURE.md)). `.railway/railway.ts` declares all five as
  `preserve()`, so a deploy keeps them (KIOSK-OPS-1). Set all five together. `MEDIA_STORE=r2`
  without the four values stops the web from starting (`media_store_invalid`). Without them, photos
  are unavailable (uploads answer `media_store_not_configured`), and the kiosk and the QR menu
  work without photos.
- **Prerequisites, in order (KIOSK-OPS-6).** Kiosk card payment in production needs
  integrated charging on the production worker. `kioskState` reads the providers the worker
  publishes at boot (`payments_platform.providers`), and `railway.ts` leaves `PAYMENTS_PROVIDERS`
  undeclared in production until R44a passes. Until then the kiosk offers only «Pagar en caja»
  even with a paired tablet and an open till, and Configuración's station row says «Mercado
  Pago no está activo en este servidor» (KIOSK-UX-10).
  1. **R44a**, payments' real-device rehearsal at both readers on staging
     ([RUNBOOK.md](RUNBOOK.md) "Payments: real-device rehearsal").
  2. **`PAYMENTS_PROVIDERS` on the production worker:** one reviewed change to its
     `railway.ts` line, so production declares the providers, then a production deploy. Check
     `/capabilities`: `mercadopago` and `clip` stop answering `worker_not_configured`. The owner
     connects the production accounts and adds the terminals (RUNBOOK step 2).
  3. **The media bucket and token** for each environment (below), set with `railway-vars.sh`.
  4. **The field checks** below, on staging with the real tablet and readers.
  5. **R44b, the combined Wave 4 rehearsal** (critic R44(b); staging, the Tab S10 FE, both
     readers; low-value real charges refunded in the provider apps; evidence kept locally in
     the LD-67 pattern):
     - kiosk spec §8.4 (the field checks);
     - a club member identified at the kiosk, linked and stamped, once paid by card at the kiosk
       and once at the counter (KIOSK-UX-01);
     - a platform order;
     - a drawer close whose batch totals include the kiosk reader and its «Del kiosco» line;
     - a corte reprint.
  6. **The switch-on:** the reviewed `railway.ts` change described in the next bullet.
- **Production stays off until these checks pass.** `.railway/railway.ts` declares
  `KIOSK_SELF_CHECKOUT_ENABLED` and `MENU_PHOTOS_ENABLED` as `"false"` in production (on in
  staging). When steps 1–5 above have passed, and the production bucket is set, one reviewed
  change to `railway.ts` (production declares `"true"`)
  and a production deploy switch them on: [RUNBOOK.md](RUNBOOK.md) "Kiosk self-checkout and
  menu photos". Never set them by hand in production: the next deploy's apply puts back what
  `railway.ts` says. Exception (owner's decision, 2026-10-15): `MENU_PHOTOS_ENABLED` is `"true"`
  in production ahead of these steps, since photos need only step 3's media bucket; card at the
  kiosk stays `"false"` until steps 1–5 pass.
- **Counsel.** The kiosk's club lookup shows counts and a masked phone only (no name, no
  enrolment, critic R21); the tablet stores one binding cookie and no IP. Counsel confirms the
  restaurant's privacy notice covers the club lookup at a public screen (LD-3 list), and reviews
  the kiosk lines of the platform documents' version `2026-10-11` (KIOSK-OPS-2): the `gm_kiosk`
  cookie in privacy §9 and the self-service tablets category in DPA §2, and Cloudflare's scope
  widened to backups and menu photos in privacy §5 and DPA §6
  ([ACCOUNT_AND_LEGAL.md](ACCOUNT_AND_LEGAL.md)).
- **Field checks (gate before the pilot uses the kiosk; kiosk spec §8.4), recorded here:**
  - On the Tab S10 FE: app pinning with PIN and the exit attempts (back, home and recents gestures,
    notification shade); fullscreen re-entry after the system bars return; the wake lock over
    8 hours on the charger; reboot recovery (re-pin); the heartbeat in Configuración; the reload
    when a new build ships; Chrome auto-update behaviour.
  - With the real terminals: one Mercado Pago Point and one Clip sale, a decline, an on-device
    cancel, a timeout (3 minutes, then «La terminal sigue procesando…»), a busy terminal; the MP
    device in PDV mode (parity B2).
  - The KDS auto-print of a kiosk order on the GHIA `ghia-web` queue (B1).
  - A photo upload from the iPad's camera roll: no WebKit browser encodes WebP on a canvas, so the
    iPad uploads JPEG variants (LD-91, KIOSK-UX-11); check the photo shows on the QR menu and the
    kiosk, and that `/media/<asset>/card.jpg` answers `image/jpeg`.

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
- **Production: yours.** The owner connection from provisioning (1.3) is held by the
  operator outside the repository and was never displayed (LD-69). Reset the password and
  keep it in your password manager; hand it to the operator for each owner step and reset
  it afterwards if you prefer.

### 1.19 The older staging Neon branch

- **Done.** Both restore branches taken before the staging changes are deleted with your
  approval: `pre-cutover-staging-2026-10-06` on 2026-10-07 (LD-53) and
  `pre-021-staging-backup-2026-09-30` on 2026-10-08 (LD-65). The project keeps only its
  primary branch, so no branch carries the pre-rotation passwords any more.

## 2. Launch sequence

Production repeats what staging needed, in the same order. Each step names the runbook
section that holds the commands and the staging step it mirrors; do not start a step
before the previous one is verified.

**Production status (October 9, 2026).** Steps 0–9 are done; 10–12 remain.

| Step | Status |
| --- | --- |
| 0 | Opened on your decision to launch (LD-68). Still open then, and now gating step 12: staging step 15 (load test), 1.7, 1.11, 1.12, 1.16 and 1.17 |
| 1 | Done 2026-10-08 (1.3) |
| 2 | Done 2026-10-08 (1.1) |
| 3 | Done 2026-10-08: a plan that only creates `web` and `worker`, applied; the re-plan was up to date |
| 4 | Done 2026-10-08: `web` has `DATABASE_URL`, `PG_APP_USER`, `SIGNING_KEYS`, `JWT_SECRET`, `APP_URL` and Google (1.5); `worker` has `WORKER_DATABASE_URL`, `APP_URL`, `CREDENTIAL_ENCRYPTION_KEY` and the Facturapi User key (1.14). Billing off; no legal values (1.11); no `ALERT_WEBHOOK_URL` (1.7) |
| 5 | Done 2026-10-08 (1.6) |
| 6 | Not recorded as run: production held no data before the first deploy, so there was nothing to check (see the step) |
| 7 | Done 2026-10-09: the first dispatch (2026-10-08) stopped in the deploy guard before changing anything (git authentication on a private repository; fixed in PR #11). Run 37937786778 deployed `739131a` outside service hours on the empty database and applied migrations 001–036 as `gm_migrator`, with grants |
| 8 | Done 2026-10-09: all six smoke checks green on the custom domain; by hand, `/api/health` ok, web and worker on `739131a`, ops status not degraded (database ok, schema ready, worker jobs on). The ntfy test waits for 1.7 |
| 9 | Done 2026-10-08, before step 7: the domain was wired first, so the first deploy and its smoke already ran on `https://app.greenmonkey.online`; DNS-only checked by hand on 2026-10-09 (1.2) |
| 10 | Open: needs `gm-backups-production` and its token (1.8) |
| 11 | Open: after step 10 |
| 12 | Open: the pilot, with [the cutover checklist for Juanberto's](#4-cutover-checklist-for-juanbertos) |

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
12. **Pilot.** For Juanberto's, follow [the cutover checklist](#4-cutover-checklist-for-juanbertos)
    alongside this step. The legal values are published (1.11, 1.12); the restaurant owner
    signs up with Google on their own phone (currency MXN, time zone, business cutoff);
    support grants Pro (1.12); staff and PINs in Equipo; devices paired and printers
    configured ([PILOT_SOP.md §1–§2](PILOT_SOP.md#1-impresión-y-equipo), 1.16); fiscal profile and
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
PILOT_SOP test print and outage drill; any stop condition of
[the cutover checklist](#4-cutover-checklist-for-juanbertos) is not met.

## 3. Not merged or not verified

As of October 9, 2026:

- **Production:** live since October 9 (section 2, steps 0–9). Steps 10–12 remain: no
  production backup or restore drill yet, the scheduled production jobs are off
  (`OPS_LIVE_ENVIRONMENTS` is `staging`), no restaurant is onboarded and owner signup is
  paused until the legal values are published.
- **Restaurant-day gate (LD-57, LD-59, LD-60, LD-64):** required on `main` since the
  release merged (pull request #8; the ruleset requires `qualify`, `security`,
  `restaurant-day` and `restaurant-day-cfdi`), with `RD_NIGHTLY_REF=main`. `deploy.yml`
  does not yet require the gate before a production dispatch (ops follow-up). The `RD_*`
  repository variables hold a fictional set. `FACTURAPI_TEST_KEY` is not a GitHub secret,
  so `restaurant-day-cfdi` reports skipped in CI.
- **Staging, still pending:** the load test `target` and `stress` and the pool decision,
  including public ordering's polls (step 15, PUBLIC-OPS-7); the alert webhook and the
  Railway deploy webhook (step 10; needs 1.7); the R2 lifecycle rules and the token
  renewal before 2026-11-07 (1.8); the CFDI organizations-provider rehearsal (1.14).
- **CFDI against the real sandbox:** the shared-sandbox flows passed locally on
  2026-10-07 (LD-51); staging runs `sandbox_shared` with your test key, and production
  runs the `organizations` provider in test mode with no restaurant activated yet. Not
  rehearsed: the organizations provider (a restaurant's organization, CSD, going live),
  live cancellation acceptance, credit notes and substitution, the RESICO monthly close,
  real email, receptor-name validation, Base vs Importe rounding (1.13, 1.14).
- **Wave 4 (LD-71, LD-72):** payments part 1 (migration 037: the "paid by platform"
  tender with per-platform prices, named terminals and batch totals at close) and the
  loyalty club (038) ship with the first Wave 4 release. Integrated Clip and Mercado
  Pago Point charging (payments part 2) and the kiosk (039) are still being built and come
  before the pilot; part 2 also needs the real-device rehearsal with you at both terminals
  ([RUNBOOK.md](RUNBOOK.md), "R44a").
- **Owner inputs not yet given:** legal values and counsel review (1.11, 1.12),
  accountant sign-off (1.13), the production R2 bucket and token (1.8), the alert topic
  (1.7), the Sentry decision (1.9), contacts (1.17), and for the kiosk (1.21, 1.16a) the R2
  media bucket and its non-expiring token per environment plus the R44a and R44b rehearsals
  at both readers. These come before production's `PAYMENTS_PROVIDERS` and the kiosk
  switch-on. Housekeeping: revoke the temporary
  Neon API key and Cloudflare DNS token (1.2, 1.3), take the offline copy of
  `CREDENTIAL_ENCRYPTION_KEY` (1.10), and rotate at cutover every credential that passed
  through a chat (1.5, 1.14).
- **Hardware:** the GTP801 prints from Chrome through `ghia-web` for pos-lite, but no
  Green Monkey document has been printed on it yet; tablets and a real outage are not
  checked (1.16). QR scanners and printed cards are field checks.

## 4. Cutover checklist for Juanberto's

Juanberto's moves from pos-lite (`juanbertos.desktop.kitchen`) to Green Monkey for the
pilot. This list comes from the parity review (LD-70) and your decisions (LD-71, LD-72).
It goes with section 2 step 12; it does not replace it. The restaurant-side procedures
are in [PILOT_SOP.md](PILOT_SOP.md) (Spanish). The cutover day itself, in order (stop
pos-lite, settle its kiosk orders, MP intents, the club import, payments, test charges, the
kiosk, the club, go live, and the follow-ups), is the one runbook in
[MIGRATION.md, «Día de cambio»](MIGRATION.md#día-de-cambio-cutover-runbook-critic-r43)
(critic R43); this list holds what must be ready before it.

**Wave 4.** Payments part 1 (037) and the loyalty club (038) reach production with the
first Wave 4 release; items 9 and 10 set them up. Integrated Clip and Mercado Pago
Point charging and the kiosk (039) are not live yet and come before the pilot; this list
is updated when they reach production.

### 4.1 Before day one

1. **Menu, imported from pos-lite.** «Importar menú de POS Lite» brings the categories,
   products, option groups and options in one reviewed step
   ([MENU.md, «Importar el menú de POS Lite»](MENU.md#importar-el-menú-de-pos-lite)). On
   2026-10-14 pos-lite's active menu was 6 categories, 28 products and 5 attached groups with
   19 options. Then, in the menu editor:
   - check every price line by line against pos-lite, products and options alike;
   - confirm each category's station on the import screen (Bebidas → Barra) and fix any
     product that belongs to the other station (a line, combos included, belongs to one
     station);
   - create a "Varios" open-price product with its ceiling, for anything not on the menu.
     QR and kiosk catalogs never show open-price products
     ([MENU.md, "Selling with choices, combos and open price"](MENU.md#selling-with-choices-combos-and-open-price));
   - map pos-lite's free-text recipe units to g, kg, ml, l or piezas as you create each
     stock item. The unit locks once the item has a movement or is used in a recipe
     ([MENU.md, "Ingredients and the stock engine"](MENU.md#ingredients-and-the-stock-engine)).
2. **Staff and PINs.** Every employee is enrolled again with a new PIN (there is no
   employee import); only the owner adds staff or resets PINs.
3. **Devices, links and cards on the new domain.** Nothing carries over from
   `juanbertos.desktop.kitchen`. On `https://app.greenmonkey.online`, re-issue:
   - every device pairing ([PILOT_SOP.md §2](PILOT_SOP.md#2-tablets-y-vinculación)), then
     each device's print settings and, on the kitchen device, KDS sound (both are kept per
     device and browser);
   - every bookmark and home-screen icon;
   - every printed QR table card and every kiosk link, generated again in Green Monkey.
     Juanberto's publishes its own privacy-notice URL before any card is printed
     ([PUBLIC_ORDERING.md](PUBLIC_ORDERING.md#field-checks-before-printing-at-scale)).
4. **Printer on the store Mac.** pos-lite's `ghia-web` queue stays and is the system
   default; none of pos-lite's macOS print pieces is uninstalled
   ([PILOT_SOP.md §1.2](PILOT_SOP.md#12-configurar-la-impresora-del-piloto-ghia-gtp801-usb-mac-de-la-caja)).
5. **Money defaults, set with the owner** (LD-70, parity review §4 item 14;
   [DISCOUNTS.md](DISCOUNTS.md), "Controls"). Write down the owner's choice for each:

   | Setting (as the app shows it) | Where | Factory default | What the default means |
   | --- | --- | --- | --- |
   | Cajero and Mesero: "Hasta (% por cuenta)" and "Y hasta (importe por cuenta)" | Configuración → "Descuentos y corte de caja" | 0 % / $0 | Every discount by a cashier or server needs a manager's PIN |
   | "Corte ciego: el conteo se captura sin ver el efectivo esperado" | Same panel | On | The person counting does not see the expected cash |
   | "Pueden ver el efectivo esperado durante el turno" | Same panel | Gerente (the owner always) | Cashiers and servers do not see it |
   | "Pueden cerrar caja (además de gerentes)" | Same panel | None | A manager closes every drawer, on that device |
   | "Bloqueo automático" | Configuración → Dispositivos → Editar, per device | 3 minutes; kitchen never | A register locks after 180 s without use |

6. **CFDI and the global invoice.**
   - Day one does not need CFDI: once "Datos fiscales" is complete, every sale gets its
     fiscal ticket with a folio. Until live CFDI, a customer's invoice goes through the
     accountant's existing process ([PILOT_SOP.md §6](PILOT_SOP.md#6-lo-que-todavía-no-está-en-esta-versión)).
   - The owner activates CFDI in test mode and uploads the CSD (1.14); the accountant
     reviews test documents (1.13); live mode only after the sign-off.
   - **Who issues the global invoice: the accountant**, for every range Green Monkey's
     live globals do not cover. pos-lite has no periodic global invoice (it stamps a
     "Público en general" CFDI per order on request); Green Monkey issues globals
     automatically, but only in live mode and only for tickets from the date chosen at
     "Pasar a modo real" in **"Incluir en las facturas globales los tickets desde"**.
   - **Set that date to the cutover date.** The app accepts a date from the start of the
     current global period to today (`cfdi_live_from_invalid`). If live mode comes in a
     later period, the cutover date is no longer accepted: choose that period's start,
     and the accountant covers Green Monkey's tickets from the cutover to that date.
   - Before day one, write down with the accountant who issues the global for each range,
     so no income is declared twice or left out: pos-lite's sales before the cutover;
     Green Monkey's tickets from the cutover to the live date; Green Monkey's tickets
     after it.
   - The printer test and the outage drill are real sales with real folios. Run them
     before the cutover date and give their folios to the accountant.
7. **Mercado Pago Point mode for manual-terminal periods.** Until integrated charging is
   live in Green Monkey, card sales use "Terminal externa": the cashier keys the amount on
   the terminal, then records its reference.
   - pos-lite switched Juanberto's Point to PDV (integrated) mode, in which the terminal
     takes charges pushed by the point-of-sale integration. Mercado Pago's documentation
     says a terminal can be switched to STANDALONE to keep charging when the integration
     is interrupted, and must be returned to PDV afterwards. Every mode change takes
     effect only after the terminal restarts.
   - pos-lite's account screen lists the account's devices as "Integrada (lista para el
     POS)" or "Independiente — no visible para el POS". Its only button, "Activar para el
     POS", switches to PDV.
   - STANDALONE goes through pos-lite's `POST /api/payments/mp/devices/operating-mode`
     with `operating_mode: "STANDALONE"` and the `device_id`
     (`server/routes/payments.js`, about lines 1483–1505). It needs a pos-lite session with
     POS access on a Pro tenant and pos-lite's Mercado Pago connection. Per Mercado
     Pago's documentation, the terminal's own settings or the Mercado Pago panel can
     also switch the mode.
   - Before the cutover, put the Point in STANDALONE, restart it and test a keyed
     charge; test a keyed charge on the Clip terminal too. When Green Monkey's integrated
     Point charging is live, its documentation will say when to return to PDV (Mercado
     Pago allows one PDV terminal per point of sale).
8. **Credentials.** Rotate at cutover every credential that passed through a chat: the
   Google client secret (1.5) and the Facturapi keys (1.14).

9. **Terminals and delivery platforms (037).** In «Configuración → Pagos con tarjeta y
   plataformas» ([PILOT_SOP.md §8](PILOT_SOP.md#8-terminales-y-plataformas),
   [PAYMENTS.md](PAYMENTS.md)):
   - name each card terminal with its fee, and choose each register tablet's default
     terminal;
   - platforms start **switched off**: turn on Uber Eats, Rappi and DiDi Food, with their
     estimated commission; leave «Otra» off unless another platform really sends orders;
   - where a platform's prices differ from the counter's, enter them in «Precios por
     plataforma». A platform with its own prices accepts only orders rung at its list;
     options always use the counter price;
   - with the accountant, confirm the SAT payment form for platform-paid orders (31,
     recommended) (1.13).

   At payment, Uber Eats, Rappi and DiDi need the platform's order number, and a platform
   payment is never accepted on a dine-in order. A drawer close with named terminals asks
   for the batch total of every terminal that took money, or of none.
10. **Loyalty club (038)**, in this order ([LOYALTY.md](LOYALTY.md), "Runbooks";
    [PILOT_SOP.md §9](PILOT_SOP.md#9-club-de-lealtad)):
    1. publish the legal set of version 2026-10-09 that covers the club (1.11, 1.12):
       until it is published, the club cannot be turned on (`loyalty_legal_required`);
    2. update Juanberto's own privacy notice to cover the club (counsel, 1.20);
    3. save the club's settings: stamps per card as in pos-lite, and the reward (one free
       product, capped at $150 by default; 1.20);
    4. on the cutover day, run `scripts/loyalty/poslite-export.sql` against pos-lite and
       import the file in «Configuración › Club de lealtad › Importar socios de POS
       Lite», confirming the restaurant; check the counts, attest, then turn the club on;
    5. purge pos-lite's copy of the members afterwards (1.20).

### 4.2 pos-lite after the cutover: running, read-only

No one sells in pos-lite after the cutover, and its kiosk stays off: two order systems
would mean two kitchen queues. pos-lite stays up for:

- **history:** sales and reports before the cutover (Green Monkey's reports start empty);
- **old CFDIs and their invoice links:** the CFDIs stamped by pos-lite and its unexpired
  `/invoice/:token` links (72 h by default), handled in pos-lite or the Facturapi
  dashboard;
- **wallet passes and `/gr` review links**, which pos-lite serves;
- **loyalty, until the members are imported (4.1 item 10):** stamp cards in pos-lite with
  its manual stamp. Recommended (LD-70 B6): honor a completed card in Green Monkey as an
  audited discount with the reason "Cliente frecuente" or "Promoción";
- **the Mercado Pago Point mode switch** (4.1 item 7), which needs its Mercado Pago
  connection;
- **the store Mac's print pieces:** `ghia-web` and its filter, `termica` and the print
  bridge.

### 4.3 Stop conditions

Do not cut over, and do not start the pilot, until each of these passes on the
production devices:

- **The test prints** on the store Mac through `ghia-web`, as
  [PILOT_SOP.md §1.2](PILOT_SOP.md#12-configurar-la-impresora-del-piloto-ghia-gtp801-usb-mac-de-la-caja)
  step 10 lists them:
  - a receipt;
  - a pre-bill ("Cuenta");
  - a comanda with kitchen and bar, each station cut apart;
  - a reprint;
  - an offline comanda;
  - the longest realistic document, in one piece.
- **The outage drill:** with the router unplugged, sell offline and print the offline
  comanda. Once the connection is back, every sale syncs, as
  [PILOT_SOP.md §3](PILOT_SOP.md#3-conexión-y-venta-sin-conexión) describes (1.16).
- **KDS sound** works on the kitchen device.
- **The menu price check** (4.1 item 1) is complete and the owner has signed it off.
