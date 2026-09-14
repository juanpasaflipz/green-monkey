# Multi-tenant signup qualification — September 14, 2026

**PASS for the scoped staging flow: Google owner login → create one Free
restaurant → authorized POS access → logout and return.** This is not full
production release approval, multi-location qualification or billing acceptance.

Target: https://green-monkey-staging.up.railway.app. Railway deployment
`46cca000-9810-4451-a0fd-84c1d2e92855` serves application commit
`0fbc3e96f3b923767d4de465f8fd24c29539db62`; `/api/version` confirmed it.
Only isolated Neon `green_monkey_test` and `green_monkey_staging` were modified.
Both have migrations 001–010 and reviewed restricted runtime grants.

## Evidence

- All 17 operational DB scenarios passed against the Neon test pooled endpoint,
  including missing scope, two-tenant reads, tenant foreign keys, concurrency,
  rollback/context reset and immutable financial history.
- Google-attempt DB checks passed on Neon: browser binding, eight concurrent
  attempts, expiry, replay/restart rejection, RLS and restricted grants.
- Owner DB checks passed on Neon: issuer/subject identity, equal-email non-merging,
  four-way signup, membership denial, CSRF, Free default and owner/POS revocation.
- 13 deployed HTTP checks passed with two explicitly synthetic owner identities:
  isolated signup/catalogs/orders, idempotent signup, denied foreign restaurant
  entry/order/product use, Secure HttpOnly cookies and logout lineage. The second
  owner's session continued working after the first owner logged out.
  [HTTP evidence](evidence/staging/tenant-isolation.json).
- A real Google round trip succeeded through the deployed callback for the
  configured Google test user. The owner created “Green Monkey · Prueba de
  staging,” entered the owner workspace and selling screen, logged out and signed
  back in. The existing restaurant was reused. DB reconciliation confirmed one
  membership, an empty catalog/order history and no synthetic Pro entitlement.
  [Google evidence](evidence/staging/owner-google-signup.json) and
  [POS screenshot](evidence/staging/owner-google-pos.png).
- 94 existing unit tests and seven new test-target guard tests passed; typecheck
  and lint passed. The deployed application had passed its production build;
  Railway independently built and deployed it successfully.

The synthetic HTTP fixtures remain in staging for audit, including one unpaid
order. No real charges, live merchant changes or production deployment occurred.
The existing Google test-account restriction remains in effect.

## Safety and repeatability

A staging dump was saved privately before its migrations at
`work/qualification/staging-before-owner-signup.dump` (mode 0600). Neon reports
PostgreSQL 18.6, so the successful backup used the PostgreSQL 18 client. The first
attempt with PostgreSQL 16 was refused without changing staging. This run did not
perform a restore or application rollback rehearsal.

Source-only upload was created from the current repository; private environments,
Git history, database dumps and reference snapshots were excluded. Its SHA-256
manifest is in ignored `work/qualification/upload-manifest.json`. Saved Google
staging credentials were installed only on the named staging service.

Owner/OAuth DB scripts now accept an explicit pair of local or Neon test targets.
For Neon, provide `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`, and exact
`TEST_DATABASE_HOST_ALLOWLIST` / `TEST_MIGRATION_DATABASE_HOST_ALLOWLIST` entries
in `host:port/database` format. No hostname conversion or production fallback is
performed; mismatched database names and production mode are rejected.

Run `tests/staging-tenant-isolation.ts` with `.env.neon-staging` and
`QUALIFICATION_DATABASE_ALLOWLIST` matching the approved pooled staging target.
It creates labeled synthetic owners/tenants and retains their audit records;
it does not replace the separate real Google browser qualification.

## Still required

Multi-location creation/switching, invitations/account linking, complete Free
limits, subscription persistence/webhooks, offline switching/recovery, provider
qualification, restore/rollback rehearsal and broader acceptance/performance
coverage remain unfinished. The complete browser cash/KDS suite was not rerun
against staging during this scoped owner-access qualification.
