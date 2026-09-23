#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}
export PG_BIN
bash scripts/local-db.sh
"$PG_BIN/psql" -h "$PWD/work/pg-socket" -p 55439 -U gm_provisioner -d postgres -v ON_ERROR_STOP=1 -f scripts/provision-local.sql
export ALLOW_DEMO_SEED=green-monkey-local
for database in green_monkey_dev green_monkey_test; do
  export MIGRATION_DATABASE_URL="postgresql://gm_provisioner:local-only-provisioner@127.0.0.1:55439/$database"
  npm run db:migrate
  npm run db:seed
  "$PG_BIN/psql" -h "$PWD/work/pg-socket" -p 55439 -U gm_provisioner -d "$database" -v ON_ERROR_STOP=1 -f scripts/grants.sql
done
if [ ! -f .env ]; then
python3 - <<'PY'
from pathlib import Path
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
JWT_SECRET='''+secrets.token_hex(32)+'\n')
Path('.env').chmod(0o600)
PY
fi
printf '%s\n' 'Local fixtures ready. Existing .env was preserved; confirm it points to the isolated local targets before starting the app.'
