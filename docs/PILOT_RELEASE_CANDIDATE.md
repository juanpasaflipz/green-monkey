# Green Monkey pilot release candidate — October 19, 2026

Status: candidate in qualification, **not deployed**. Branch `release/pilot-rc-2026-10-19` is based on main `db085ea783e46124a91892e2c8f68e357aea78d7`. Do not deploy the original divergent `release/v1` checkout. Do not merge this candidate until its release checks and pilot gates are accepted; a merge to main can trigger staging deployment.

## Reconciliation and preservation

The original `/Users/juan/Developer/green-monkey` checkout remains on `release/v1` at `1265d4e204c21925b77139cfd1cc1ab4e32ea21f`, with its uncommitted work and screenshots intact. Candidate work is isolated at `/Users/juan/Developer/green-monkey-pilot-rc`.

| Local work | Candidate treatment |
| --- | --- |
| Uncommitted loyalty engagement, digital card, referral, Wallet and messaging source, tests and assets | Applied on current main with a three-way patch and new files copied; original remains intact |
| Marketing redesign and styling | Already on main via #23; retained main plus the local loyalty plan description |
| Earlier kiosk implementation and alternative migration 039 | Superseded by main's integrated approved design and hardened backend; original branch remains available |
| Kiosk design prototype | Preserved under `prototypes/kiosk`, excluded from production image |
| Main kiosk, iOS shell, menu import and history features | Retained unchanged |
| Main migrations 001–041 | Retained byte-for-byte |
| New local `040_loyalty_engagement.sql` | Renumbered to `042_loyalty_engagement.sql`; never overwrites 040/041 history |
| Existing readiness/planning notes | Preserved; old deployment evidence is explicitly historical |

A binary patch and SHA-256 manifest of the original checkout are retained locally in `assets/outputs/green-monkey-pilot-rc-2026-10-19`. No private environment files, credentials or restaurant exports were copied into the candidate or sent to Claude.

## Database fixes

Wallet unregister now clears the push token and marks the registration inactive. Discovery and push delivery ignore inactive registrations; registering again reactivates the existing row. An APNs rejection only retires the exact token attempted, so a newer token survives. Member redaction still physically removes registrations through the restricted database trigger.

The application and worker keep the existing no-DELETE invariant. The grants manifest removes obsolete DELETE and broad UPDATE rights and grants only the columns the new loyalty operations need. The ops and migration permission tests are unchanged. Main's export catalogue resolves the old kiosk label failure; new loyalty credential tables are excluded from account exports and exportable tables have Spanish/English labels.

## Verification

All local database tests use disposable PostgreSQL 18 and synthetic records, with Node 24.21.0. No production database was used.

- Main 001–041 → candidate 042 upgrade: passed as non-superuser migrator.
- Fresh 001–042 installation: passed as non-superuser migrator.
- Type checks, lint, production build: passed.
- Unit tests: 111 files, 1,734 tests passed.
- Full `test:db:qualification`: passed, including ops, migration runner, backup/restore, account, loyalty, kiosk, menu import and both history suites.
- Compiled restart, access HTTP, account HTTP and graceful drain: passed.
- Final restricted-grants regression: ops, migration runner, loyalty (41 checks) and account suites passed.
- Production dependency audit: zero reported vulnerabilities.
- Browser acceptance and exact-commit release CI: pending; consult the candidate pull request before acceptance.

Claude reviewed the integration and soft unregister implementation independently in two passes and found no remaining integration blockers. The preservation check found zero changes to all 1,048 original tracked/untracked files and zero changes to main migrations 001–041. Accepted follow-ups for disabled Wallet: enforce inactive-state consistency with a database constraint, bound lifetime registration rows, and add real-device acceptance. Existing installed Apple passes can retain a cached display after member redaction (their checkout scan is invalid); card reissue requires adding the new pass. See [Loyalty](LOYALTY.md#engagement-extension-042).

## Pilot handoff gates

This candidate is for supervised pilot preparation, not a general SaaS launch approval. No enablement flags or deployed settings have been changed. Referrals, messaging and Wallet default off; kiosk self-checkout retains main's kill switch. The actual pilot feature scope still needs to match the restaurant's accepted operating plan.

Before cutover: complete the real tablet/printer and full-shift rehearsal; qualify physical integrated readers if included; reconcile imported menu/prices, taxes, opening cash and balances; confirm support coverage, alert receipt, fallback register and recovery procedure. Automated fake-provider checks do not qualify real payment hardware. A populated local restore test does not establish production recovery time or backup-key custody. Follow [Pilot SOP](PILOT_SOP.md), [launch handoff](LAUNCH_HANDOFF.md) and [load-test procedure](LOAD_TEST.md).

No deployment, main merge, production data change or external notification is authorized by this candidate document.
