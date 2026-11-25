# Green Monkey: fix plan for Claude Code handoff

Written 2026-11-25 from the production-readiness audit of 2026-11-24.
Targets: Juanberto's live on Green Monkey 2026-12-01; public launch 2027-01-15.

**Status of this plan:** it is built from the audit report only. The findings were not
re-checked against the repo when this was written, so step 0 of every task is
"confirm the finding still holds on current `main`".

## Ground rules for Claude Code

- One branch and one PR per task, branched from `main`. Never push to `main`.
- Never touch production: no deploys, no production migrations, no secret changes.
  Anything marked **JUAN** is his to do; stop and ask when a task depends on it.
- Never print, commit or log secrets. Test keys only.
- Use Node 24 (the project requirement; on Node 22, 17 unit tests fail on `navigator.locks`).
- A task is done when: typecheck, lint, unit tests, build and `npm audit` pass, the PR
  description says what was verified and how, and this file's checkbox is ticked.
- Migrations stay additive-only (production schema is currently ahead of production code).
- If a finding turns out to be wrong or already fixed, note it here and move on.

## Phase 0: unblock production (JUAN, today)

- [ ] **J1. Read the worker's Railway logs** from 2026-11-16 ~12:00 UTC onward and paste the
      crash/exit lines to Claude Code. The worker has been stale since 11-16 12:33 UTC.
- [ ] **J2. Rotate `RAILWAY_TOKEN`** in Railway and update the GitHub Actions secret.
      The 11-17 deploy ran migrations and then failed with `Invalid RAILWAY_TOKEN`.
- [ ] **J3. Add a required reviewer** to the GitHub `production` environment
      (Settings > Environments). Today the only gate is a typed phrase plus scripts.

## Phase 1: restore production (before 12-01)

- [ ] **1.1 Worker outage root cause.** Needs J1. Find why the worker stopped on 11-16, fix
      it, add a regression test. PR #36 is not the fix (it only changes wake-up frequency
      and the outage predates it). Close alert issue #34 only after `/status` reports the
      worker healthy for 24h.
- [ ] **1.2 Deploy preflight.** Make the production deploy workflow validate the Railway
      token (and any other deploy credential) *before* running migrations, so a bad token
      can never again leave the schema ahead of the code.
- [ ] **1.3 Fix the flaky nightly end-to-end test.** The "after the outage" scenario hit
      rate limits on 11-20 and 11-24. Make the test deterministic (isolated limiter state,
      or test-only limits); do not loosen production limits.
- [ ] **1.4 Redeploy.** Needs J2, 1.1 and 1.3. Re-run the nightly E2E on `aed5c02` or newer.
      **JUAN** triggers the deploy. Confirm production then carries #32 (dependency
      security update) and #36, and that code and schema versions match.
- [ ] **1.5 Alerts that get seen.** Issue #34 collected 60 comments unnoticed. Route uptime
      and backup failures to a channel Juan reads (email or WhatsApp), with a repeat
      interval. Needs Juan's decision on escalation contacts (J6).

## Phase 2: safety guards (before 12-01)

- [ ] **2.1 `APP_ENV` guard (medium).** `server/config-rules.ts:210`: strict production
      checks only run when `APP_ENV` is set. Refuse to start when it is missing or not a
      known value. Add tests for missing, invalid and each valid value.
- [x] **2.2 Sentry (narrowed scope — owner declined the mandatory part).** The audit found
      `server/instrument.ts` loading `@sentry/node` only if installed, with the package
      absent from `package.json` and the lockfile; that part still held on current `main`.
      The audit's original text also asked to "fail startup in production if the DSN is
      absent," which the owner explicitly declined: `docs/LAUNCH_HANDOFF.md` 1.9 lists the
      Sentry DSN as "Off — Your decision" (still undecided), and enabling error tracking is
      a material DPA change needing 15 days' notice to customers
      (`docs/decisions/LEAD_DECISIONS.md` LD-32/LD-37, `docs/ACCOUNT_AND_LEGAL.md`) — Sentry
      is listed as a processor "only if approved." Making the dependency mandatory would
      force that undecided call. Implemented instead: `@sentry/node` is now a real,
      declared dependency (`package.json`/`package-lock.json`), `server/instrument.ts`
      imports it statically instead of a conditional dynamic `import()`, and its
      `beforeSend`/`dataCollection` options were updated for the v11 API while preserving
      the old restrictive (no default PII) behavior. Error tracking stays fully gated on
      `SENTRY_DSN` being set and off by default; no "fail startup without a DSN" check was
      added. Staging verification and the mandatory check remain explicitly out of scope
      per the owner's decision.
      PR: #41
- [ ] **2.3 `npm start` parity.** Make `npm start` use the same instrumentation preload as
      the Docker image.
- [ ] **2.4 Mercado Pago webhook replay (low).** Add a freshness window on the signed
      timestamp plus idempotency on the event id.
- [ ] **2.5 `GET /api/jobs` (low).** Return an explicit column list, not whole rows.
- [ ] **2.6 Shared rate limits (low).** Limits live in each server's memory, so they multiply
      with replicas and reset on deploy. Move them to a shared store (Postgres is already
      there; propose the design in the PR before building).
- [ ] **2.7 Pin Node.** Add `.nvmrc` / `engines` for Node 24 if missing, so local runs match CI.

## Phase 3: operational confidence (before 12-01 where marked)

- [ ] **3.1 Backup timing (before 12-01).** Production backups succeed but start 8-12h late
      because of GitHub cron delays. Move the trigger to a reliable scheduler (Railway cron
      or similar) and alert when a backup is more than 2h late.
- [ ] **3.2 Staging backup failure.** Diagnose the 11-22 failure, fix, close issue #30.
- [ ] **3.3 Restore drill with real data (before 12-01).** The only production drill (Oct 10)
      restored zero orders on schema 038. Script a drill that restores the latest backup
      into a scratch database on the current schema and checks row counts and a sample
      order. **JUAN** runs it against production backups; record the result in the docs.
- [ ] **3.4 Load test and pool sizing (before 01-15).** `docs/LOAD_TEST.md:82-83` still lists
      the staging load test and connection pool sizing as pending. Run on staging, record
      numbers, set the pool size from them.

## Phase 4: paid features

Juanberto's needs these working on 12-01; public sign-ups need them by 01-15.
All stay behind their flags until each passes end to end in test mode, then live.

- [ ] **4.1 Real CFDI.** Electronic invoicing has never passed for real. Get one invoice
      stamped in the Facturapi sandbox, then one live. Needs J4 and J5.
- [ ] **4.2 Live billing (PR #33).** Rebase, review, get it green, merge. Needs Juan's Stripe
      live activation (J7).
- [ ] **4.3 Card payments.** Kiosk card payments, Mercado Pago and Clip are switched off.
      Enable one at a time in test mode, then on real hardware (J8).

## Phase 5: docs

- [ ] **5.1 Reconcile the docs with git history.** `RELEASE.md` and `LAUNCH_HANDOFF.md` say
      PR #25 is not merged, but production runs it. Sweep all of `docs/` for similar
      contradictions.
- [ ] **5.2 Update the go/no-go.** `docs/PILOT_RELEASE_CANDIDATE.md:89` says NO-GO. Rewrite the
      checklist from this plan and flip it only when every pre-12-01 item is ticked.

## Owner items only Juan can do

- [ ] **J4.** Accountant review of VAT and invoicing (meeting planned early December).
- [ ] **J5.** Live invoicing keys and each restaurant's signing certificate (CSD).
- [ ] **J6.** Decide escalation contacts for alerts.
- [ ] **J7.** Stripe live activation on the right account.
- [ ] **J8.** Full-shift rehearsal on real hardware at Juanberto's.
- [ ] **J9.** Legal counsel review.

## Suggested order

Today: J1, J2, J3. In parallel Claude Code starts 2.1, 2.2, 2.3, 1.2, 1.3 (no dependencies).
Then 1.1 > 1.4 > 3.1, 3.3, 1.5 > Phase 4 > 2.4-2.7, 3.2, 3.4 > Phase 5.

## Kickoff prompt for Claude Code

> Read `POS/FIX_PLAN.md`. Follow its ground rules. Start with tasks 2.1, 2.2, 2.3, 1.2 and
> 1.3: for each, first confirm the finding on current `main`, then open one PR per task.
> Tick the checkbox and add the PR number when each is ready for review. Stop and ask me
> for anything marked JUAN.
