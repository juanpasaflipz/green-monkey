# Locations, invitations and switching

Item 2 continuation, September 14, 2026. Local implementation and isolated Neon
tests pass; staging rollout and deployed qualification are next. Item 1 remains
qualified on staging. This is not production or live billing approval.

Owners can open account management, create an additional location in their
organization, obtain a billing quote and explicitly confirm its immediate amount
and new recurring total. Pro is required on the source restaurant. Additional
locations remain inactive until a canonical Stripe read confirms the quantity
update. They share the original trial end or renewal date; no second trial starts.
Mid-cycle activation uses immediate proration, shown before confirmation.

Migrations 014 and 015 add pending activation, immutable location commands,
email-bound invitations, persistent browser device mappings and durable quote,
update and watcher operations. They are applied to local dev/test, Neon test and
staging. Staging was backed up first to the private mode-0600 file
`work/locations/staging-before-locations.dump`; the new application is pending rollout.
Billing remains sandbox-only. The restricted billing worker alone can activate
locations and project entitlements. Every billed location shares the organization
subscription; any billed location can open its Portal.

Stripe qualification found two important contracts. No-card trials configured to
cancel without a payment method have no upcoming invoice to preview, so their
quantity quote is zero and preserves the original trial. Failed paid updates keep
their correlation metadata inside `pending_update` until payment succeeds. The
worker recognizes that marker, offers a validated hosted invoice link, and retains
the original invoice ID to recognize voided/expired updates. An HTTP success alone
never activates a location. Evidence: `evidence/stripe-sandbox-locations.json`.
Both standalone synthetic subscriptions were canceled after verification.

Owners generate copyable invitation links for a specified Google email and role
(manager, cashier, server or kitchen). No emails are sent. Invitations expire in
seven days and can be revoked before acceptance. Acceptance requires the fresh
verified email from the current Google session, consumes the invitation atomically,
and supports safe retries. Existing members do not gain a different role by replay.
Invited users can still create their own original restaurant independently.

Restaurant entry reuses the browser's device for each account/location. Switching
requires connectivity and blocks unresolved payments or queued sales from another
location. Tabs receive a session-generation notification; API requests also carry
the displayed tenant/session IDs so stale tabs fail closed. Account sign-out clears
the cached session and notifies other tabs. Draft and queue records are retained.
Wider offline recovery remains item 4, including lost browser storage/device root
and unresolved queue recovery beyond the tested switching paths.

Verification includes 115 unit tests; local and Neon owner-management/billing
tests for concurrent retries, ownership, CSRF, restricted grants, delayed activation,
device reuse and invitation acceptance; and all 13 local browser scenarios.
The browser owner scenario includes actual application invitation creation/revoke,
pending location creation, synthetic quote/consent, switching and stale-tab checks,
plus accessibility scans. The provider proof is separate from mocked UI quotes.
`tests/staging-locations.ts` prepares the explicit staging-only HTTP/provider check
with synthetic identities and retained audit fixtures. It must not target live data.

Remaining sequence: deploy and qualify item 2, then complete Free limits (3),
offline recovery (4), and production qualification (5). Free team/register limits
and production infrastructure/provider prerequisites are not qualified here.
