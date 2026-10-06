#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}
export PG_BIN
bash scripts/local-db.sh
"$PG_BIN/psql" -h "$PWD/work/pg-socket" -p 55439 -U gm_provisioner -d postgres -v ON_ERROR_STOP=1 -f scripts/provision-local.sql
# Capability roles (gm_jobs_worker, gm_support, ...) before the grants below: the
# "-- 2.0 jobs worker" block of scripts/grants.sql refuses to apply without them.
"$PG_BIN/psql" -h "$PWD/work/pg-socket" -p 55439 -U gm_provisioner -d postgres -v ON_ERROR_STOP=1 -f scripts/ops/sql/globals.sql
"$PG_BIN/psql" -h "$PWD/work/pg-socket" -p 55439 -U gm_provisioner -d postgres -v ON_ERROR_STOP=1 -c "GRANT gm_jobs_worker TO gm_worker"
export ALLOW_DEMO_SEED=green-monkey-local
for database in green_monkey_dev green_monkey_test; do
  export MIGRATION_DATABASE_URL="postgresql://gm_provisioner:local-only-provisioner@127.0.0.1:55439/$database"
  npm run db:migrate
  npm run db:seed
  "$PG_BIN/psql" -h "$PWD/work/pg-socket" -p 55439 -U gm_provisioner -d "$database" -v ON_ERROR_STOP=1 -f scripts/grants.sql
done
existing_env=0
[ -f .env ] && existing_env=1
if [ ! -f .env ]; then
python3 - <<'PY'
from pathlib import Path
import datetime
import secrets
Path('.env').write_text('''NODE_ENV=development
PORT=3001
APP_URL=http://127.0.0.1:3001
DATABASE_URL=postgresql://gm_app:local-only-green-monkey@127.0.0.1:55439/green_monkey_dev
MIGRATION_DATABASE_URL=postgresql://gm_provisioner:local-only-provisioner@127.0.0.1:55439/green_monkey_dev
ALLOW_DEMO_SEED=green-monkey-local
TEST_DATABASE_URL=postgresql://gm_app:local-only-green-monkey@127.0.0.1:55439/green_monkey_test
TEST_MIGRATION_DATABASE_URL=postgresql://gm_provisioner:local-only-provisioner@127.0.0.1:55439/green_monkey_test
TEST_DATABASE_HOST_ALLOWLIST=127.0.0.1:55439/green_monkey_test
DEMO_TENANT_ID=10000000-0000-4000-8000-000000000001
ACCESS_STEP_UP_SECONDS=1800
ACCESS_IDLE_LOCK_DEFAULT_SECONDS=0
WORKER_DATABASE_URL=postgresql://gm_worker:local-only-worker@127.0.0.1:55439/green_monkey_dev
SIGNING_KEYS=local-'''+datetime.date.today().strftime('%Y%m%d')+':'+secrets.token_urlsafe(32)+'''
JWT_SECRET='''+secrets.token_hex(32)+'\n')
Path('.env').chmod(0o600)
PY
fi
printf '%s\n' 'Local fixtures ready. Existing .env was preserved; confirm it points to the isolated local targets before starting the app.'
if [ "$existing_env" = 1 ]; then
  printf '%s\n' 'Existing .env was preserved; add WORKER_DATABASE_URL and SIGNING_KEYS (see .env.example) to run `npm run worker` with jobs and the v2 keyring.'
fi
