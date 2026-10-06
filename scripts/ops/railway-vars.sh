#!/usr/bin/env bash
# User-run: sets Railway service variables from a private file without ever
# printing values or putting them on a command line (values go via stdin).
#   scripts/ops/railway-vars.sh <environment> <file> [--dry-run]
# The file holds NAME=value lines grouped under "# service: web" or
# "# service: worker" headers. Uses the linked project and RAILWAY_TOKEN.
# --skip-deploys: variables apply on the next deploy.
set -euo pipefail
environment=${1:-}; file=${2:-}; dry_run=false
[ "${3:-}" = "--dry-run" ] && dry_run=true
[[ "$environment" =~ ^[a-z][a-z0-9-]*$ ]] && [ -f "$file" ] || { echo "usage: $0 <environment> <file> [--dry-run]" >&2; exit 2; }
service=""
count=0
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^#[[:space:]]*service:[[:space:]]*([a-z][a-z0-9-]*)[[:space:]]*$ ]]; then
    service=${BASH_REMATCH[1]}; continue
  fi
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  name=${line%%=*}; value=${line#*=}
  [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "invalid variable name on a line of $file" >&2; exit 1; }
  [ -n "$service" ] || { echo "$name appears before any '# service:' header" >&2; exit 1; }
  if $dry_run; then
    echo "DRY-RUN: set $name on $service ($environment)"
  else
    printf '%s' "$value" | railway variable set "$name" --stdin --service "$service" \
      --environment "$environment" --skip-deploys > /dev/null
    echo "set $name on $service ($environment)"
  fi
  count=$((count + 1))
done < "$file"
echo "$count variables processed"
