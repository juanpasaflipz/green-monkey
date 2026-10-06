#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.nvm/nvm.sh"
nvm use 24
export NODE_ENV=production
export PORT=3002
export APP_URL=http://127.0.0.1:3002
# Local fixture only: demo form for the fictional tenant, a long step-up window
# and no default auto-lock, as the browser suites expect.
export DEMO_TENANT_ID=${DEMO_TENANT_ID:-10000000-0000-4000-8000-000000000001}
export ACCESS_STEP_UP_SECONDS=${ACCESS_STEP_UP_SECONDS:-1800}
export ACCESS_IDLE_LOCK_DEFAULT_SECONDS=${ACCESS_IDLE_LOCK_DEFAULT_SECONDS:-0}
# account (031): the fictional legal/support set CI publishes, so signup and the
# legal, account and landing suites run as in CI (LD-3; test values only).
source tests/fixtures/legal-ci.sh
exec node --watch-path=build build/server/index.js
