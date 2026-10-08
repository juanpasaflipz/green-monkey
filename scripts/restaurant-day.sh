#!/usr/bin/env bash
# Restaurant-day go-live gate (specs/acceptance.md §2, §13): build, then the
# browser suite with its dedicated config (global setup resets the disposable
# green_monkey_acceptance_dev, provisions support instead of seeding, and starts
# a production-mode web + worker), then the DB reconciliation suite.
#
#   RD_LEGAL_ENTITY_NAME=… RD_LEGAL_ENTITY_ADDRESS=… RD_LEGAL_PRIVACY_CONTACT_EMAIL=… \
#   RD_LEGAL_JURISDICTION=… RD_SUPPORT_EMAIL=… RD_SUPPORT_PHONE=… RD_SUPPORT_HOURS=… \
#   [RD_PG_PORT=55439] [TEST_BASE_URL=http://127.0.0.1:3390] bash scripts/restaurant-day.sh
#
# The RD_* values are legal and support values that production mode publishes:
# the vendor's real ones (spec §3.3) or a plausible fictional set kept only in
# the repository variables (LD-3; never copied to Railway). Production refuses
# placeholder words and the CI literals of tests/fixtures/legal-ci.ts (account
# §2.2, ACC-18), and a gate that cannot publish its documents fails at G1.6.
# Never source an env/*.env file or ./.env for this run (§13.4).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TEST_BASE_URL:=http://127.0.0.1:3390}"
: "${APP_URL:=https://${TEST_BASE_URL#http://}}"
export RD_ACCEPTANCE=1 TEST_PRODUCTION=1 TEST_BASE_URL APP_URL

missing=()
for name in LEGAL_ENTITY_NAME LEGAL_ENTITY_ADDRESS LEGAL_PRIVACY_CONTACT_EMAIL LEGAL_JURISDICTION \
  SUPPORT_EMAIL SUPPORT_PHONE SUPPORT_HOURS; do
  source_name="RD_$name"
  if [ -z "${!source_name:-}" ]; then missing+=("$source_name"); else export "$name=${!source_name}"; fi
done
if [ -n "${RD_LEGAL_ENTITY_RFC:-}" ]; then export LEGAL_ENTITY_RFC="$RD_LEGAL_ENTITY_RFC"; fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "restaurant-day: missing ${missing[*]} (legal and support values production publishes; never the CI literals)" >&2
  exit 2
fi
# LD-22: legal-ci.sh keeps every value already set; without "off" it would
# export LEGAL_UNPUBLISHED_SIGNUP=allow, which production logs at error level.
export LEGAL_UNPUBLISHED_SIGNUP=off
if [ -f tests/fixtures/legal-ci.sh ]; then
  # shellcheck source=/dev/null
  . tests/fixtures/legal-ci.sh
fi

npm run build

status=0
npx playwright test -c playwright.restaurant-day.config.ts || status=$?
if [ "$status" -eq 0 ]; then
  npm run -s test:db:restaurant-day || status=$?
else
  echo "restaurant-day: browser suite failed; the DB reconciliation suite needs a complete day and was not run" >&2
fi
if [ -s test-results/restaurant-day/waivers.txt ]; then
  echo "WAIVED: $(paste -sd, test-results/restaurant-day/waivers.txt)"
fi
exit "$status"
