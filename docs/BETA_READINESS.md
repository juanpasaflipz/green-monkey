# Beta readiness — historical deployment assessment

This preserves the earlier deployment assessment. For the reconciled, undeployed candidate and its current evidence, see [Pilot release candidate](PILOT_RELEASE_CANDIDATE.md). The deployed revision statements below are dated observations, not a statement of today's live revision.

Verdict: the deployed software passes its automated gates, but the complete
restaurant beta is **not yet verified ready**. Do not treat healthy infrastructure
or simulated reader tests as completion of the field rehearsal.

## Approved kiosk design — deployed October 19

Production now serves `8890b529d25056d8eb83aa79e6b2b5089aa25dcb`, merged in
[PR #22](https://github.com/juanpasaflipz/green-monkey/pull/22). The approved
`prototypes/kiosk` design from local `1265d4e` was adapted to the current
ordering/payment state machine in an isolated checkout. No backend contracts
or applied migrations were replaced. All kiosks receive the design regardless
of pairing or card enablement; production's served `PublicOrdering` bundle
contains `data-kiosk-design="approved-2026-10"`.

- [Main qualification](https://github.com/juanpasaflipz/green-monkey/actions/runs/39199057628)
  passed, including unit and DB suites, browser acceptance, load and image smoke.
- [Release restaurant-day and payment acceptance](https://github.com/juanpasaflipz/green-monkey/actions/runs/39192326671)
  passed; the optional real-CFDI branch was skipped.
- [Staging deployment](https://github.com/juanpasaflipz/green-monkey/actions/runs/39202411744)
  and [production deployment](https://github.com/juanpasaflipz/green-monkey/actions/runs/39261749039)
  passed on the same commit.
- A fresh production check at 2026-10-19 13:52 UTC verified the version, approved
  frontend marker, and all six HTTP smoke checks. See
  [release proof](evidence/beta/2026-10-19-approved-kiosk-release.json).

Local checks also passed: 1,728 unit tests, 23 kiosk/public-ordering Chromium
checks, four Chromium/iPad-WebKit ordering/design checks, and the unavailable-item
and tablet-grid regressions. Five native link-parsing tests passed on Simulator.
The iOS setup fix distinguishes the full kiosk URL from a station name or an
8-digit pairing code. The native app remains a web shell: restarting it loads
the new server design. Its updated native binary is installed on the test
simulator, not verified on the physical iPad. Native UI control failed before
we could visually confirm the integrated menu inside Simulator; WebKit browser
coverage passed. Hardware/payment field acceptance remains outstanding.

The root checkout's unrelated work was preserved. The release was prepared in
`work/kiosk-redesign`; do not deploy the divergent local `release/v1` backend or
its alternate migration 039.

## October 17 baseline evidence

| Gate | Observed result | Evidence |
| --- | --- | --- |
| Production runtime | Database OK, schema ready, worker healthy with jobs enabled; web and worker both `5f98db7`; not degraded | Live `/api/ops/status` and `/api/version`, October 17 |
| Fresh production smoke | All six checks passed: version, health, worker status, trusted client IP, malformed JSON rejection and session enforcement | [October 17 smoke](evidence/beta/2026-10-17-production-smoke.json) |
| Signup and legal publication | `legal.status=published`, `signupOpen=true`, support configured | Live `/api/account-config`; this verifies publication, not counsel approval or a fresh Google login |
| Exact-revision qualification | `qualify` and `security` succeeded, including DB suites, compiled browser checks, restart/drain, load smoke, Docker image, dependency audit and secret scan | [Qualification run](https://github.com/juanpasaflipz/green-monkey/actions/runs/38758006322) |
| Production deployment | Production job succeeded | [Deploy run](https://github.com/juanpasaflipz/green-monkey/actions/runs/38774167686) |
| Two consecutive restaurant-day runs | `restaurant-day` and `restaurant-day-payments` succeeded on both runs; nightly ref is `main`, no `RD_WAIVE` repository variable returned | [October 16](https://github.com/juanpasaflipz/green-monkey/actions/runs/38905966995), [October 17](https://github.com/juanpasaflipz/green-monkey/actions/runs/39035388098) |
| Latest restaurant-day details | 12 browser tests plus 23 reconciliation checks; payments/kiosk: 5 browser tests plus 14 reconciliation checks against fake providers | October 17 run logs |
| Backup and retention | Today's production backup and retention succeeded | [Backup](https://github.com/juanpasaflipz/green-monkey/actions/runs/39021924511), [retention](https://github.com/juanpasaflipz/green-monkey/actions/runs/39028318661) |
| External monitoring | Today's uptime check succeeded | [Uptime](https://github.com/juanpasaflipz/green-monkey/actions/runs/39032888934) |
| Restore | Historical production drill passed, reported RTO 162 seconds | [October 10 record](evidence/restore/2026-10-10-production.json); this predates migrations 039–041 and contains zero sales, so it is not a fresh populated-database drill |
| Separate local checkout | Typecheck, lint, all 1,562 unit tests and production build passed | October 17 local run; initial HTTP test failures were sandbox `listen EPERM`, resolved by rerunning with loopback permission; these results do not qualify the deployed source |

## Remaining gates and concrete completion criteria

1. **Alert delivery — receipt evidence needed.** The October 19 follow-up found
   `ALERT_WEBHOOK_URL` in the production GitHub environment; the earlier claim
   that it was absent was incorrect. Railway values and actual receipt have not
   been verified. Confirm the responder and destination, then authorize a test
   notification and confirm receipt on the responder's device. Procedure: [launch handoff §1.7](LAUNCH_HANDOFF.md#17-alert-channel-ntfy-topic).
2. **Restaurant hardware and full-shift rehearsal — evidence needed.** On the
   actual tablet/browser and GHIA printer, verify receipt, kitchen ticket,
   cancellation and reprint; then sale → kitchen → partial payment/refund →
   offline sale → reconnect without duplicate effects → drawer close and totals.
   Record devices, revision, operator and outcomes. Include the customer-facing
   kiosk if it is in the beta scope. [Pilot SOP](PILOT_SOP.md) and
   [cutover checklist](LAUNCH_HANDOFF.md#4-cutover-checklist-for-juanbertos).
3. **Integrated readers and kiosk card payments — field qualification pending.**
   The deployed revision's IaC keeps production kiosk self-checkout disabled and
   does not declare production `PAYMENTS_PROVIDERS`; menu photos are enabled.
   CI uses fake readers. Complete R44a at both physical readers and R44b for the
   combined kiosk/loyalty/close workflow before enabling those production paths.
   Earlier owner decisions require these for the full Juanberto's pilot; a smaller
   cash/external-terminal beta is a scope decision, not an automatic waiver.
   [Current deployed runbook](https://github.com/juanpasaflipz/green-monkey/blob/5f98db7100e54e93938e17a4ced46f667f8ea074/docs/RUNBOOK.md).
4. **Staging capacity qualification — not established.** CI passed only the
   3-tenant, 60-second load smoke. Run the documented target/stress profiles on an
   isolated staging fixture, including public-ordering traffic, and record pool
   size, p95 reads/mutations/KDS and error rate. No staging load run was performed
   in this assessment. [Load procedure](LOAD_TEST.md).
5. **Cutover and recovery evidence — confirm before replacing the old register.**
   Reconcile the restaurant's imported menu/prices, opening cash and enabled club
   data; record support coverage and fallback procedure. Rehearse restoring a
   current, populated isolated fixture through migration 041, preserving the
   existing backup key custody and retention requirements. No private restaurant
   exports were accessed in this assessment. [Migration runbook](MIGRATION.md).

Real CFDI was **skipped**, not passed, in both inspected restaurant-day runs.
Keep live CFDI outside any readiness claim until the organizations-provider/CSD
rehearsal and accountant approval are recorded. Live SaaS billing is likewise
not qualified by this assessment. Do not enable either to make a dashboard green.

## Rechecking the software gates

The existing smoke performs no sale or customer mutation:

```sh
node scripts/ops/smoke.mjs \
  --base-url https://app.greenmonkey.online \
  --expect-commit 5f98db7100e54e93938e17a4ced46f667f8ea074 --timeout 30
gh run list --workflow qualification.yml --limit 5
gh run list --workflow restaurant-day.yml --limit 5
gh run view <run-id> --json jobs
gh secret list --env production
```

Use the current production SHA when rechecking. Inspect individual jobs and
checked-out revisions: an overall green workflow can contain skipped provider
jobs. The open items above require their own evidence; rerunning CI cannot close
them.
