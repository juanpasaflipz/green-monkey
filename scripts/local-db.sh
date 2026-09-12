#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}
mkdir -p work/pg-socket
if [ ! -f work/pgdata/PG_VERSION ]; then "$PG_BIN/initdb" -D work/pgdata --auth-local=trust --auth-host=scram-sha-256 -U gm_provisioner > work/initdb.log; fi
if "$PG_BIN/pg_ctl" -D work/pgdata status > /dev/null 2>&1; then exit 0; fi
"$PG_BIN/pg_ctl" -D work/pgdata -l work/postgres.log -o "-p 55439 -k $PWD/work/pg-socket -h 127.0.0.1" start
