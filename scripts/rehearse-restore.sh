#!/usr/bin/env bash
# Only exercises the disposable localhost test cluster; never reads DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}
source_db=green_monkey_test
restore_db="green_monkey_restore_$(date -u +%Y%m%d%H%M%S)_test"
mkdir -p work/restore
connection=(-h "$PWD/work/pg-socket" -p 55439 -U gm_provisioner)
# Refuse to use any server other than the cluster owned by this checkout.
actual_directory=$("$PG_BIN/psql" "${connection[@]}" -d "$source_db" -Atc 'show data_directory')
[ "$actual_directory" = "$PWD/work/pgdata" ] || { echo 'Unexpected cluster; restore rehearsal refused.' >&2; exit 1; }
"$PG_BIN/pg_dump" "${connection[@]}" -d "$source_db" -Fc -f work/restore/test.dump
"$PG_BIN/createdb" "${connection[@]}" "$restore_db"
"$PG_BIN/pg_restore" "${connection[@]}" --exit-on-error -d "$restore_db" work/restore/test.dump
query="SELECT json_build_object('orders',(SELECT count(*) FROM orders),'tenders',(SELECT count(*) FROM tenders),'tender_amount',(SELECT coalesce(sum(amount),0) FROM tenders),'refund_amount',(SELECT coalesce(sum(amount),0) FROM refunds),'stock_quantity',(SELECT coalesce(sum(quantity),0) FROM stock_movements),'mappings',(SELECT count(*) FROM source_mappings),'migrations',(SELECT count(*) FROM schema_migrations))::text"
"$PG_BIN/psql" "${connection[@]}" -d "$source_db" -Atc "$query" > work/restore/source.json
"$PG_BIN/psql" "${connection[@]}" -d "$restore_db" -Atc "$query" > work/restore/restored.json
cmp work/restore/source.json work/restore/restored.json
printf '%s\n' "$restore_db" > work/restore/target.txt
printf 'Restored %s into %s; record counts and financial/stock control totals match.\n' "$source_db" "$restore_db"
cat work/restore/restored.json
