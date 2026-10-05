#!/usr/bin/env bash
# User-run: creates the Neon project for one environment (OPS-13, DB-2):
# project green-monkey-<env>, database green_monkey_<env>, a 7-day history
# window (30 days with NEON_PLAN=scale), daily and weekly snapshots kept 35
# days, and a protected default branch. Writes the owner connection string to
# .env.neon-owner-<env> (0600, never overwritten) as PROVISION_DATABASE_URL
# for scripts/ops/provision-roles.ts. Prints ids and names only.
#   NEON_API_KEY=... NEON_ORG_ID=... scripts/ops/provision-neon.sh <env> [--dry-run]
# Required: NEONCTL_VERSION, the exact neonctl version you reviewed
# (MAJOR.MINOR.PATCH). The CLI runs with the API key, so it is pinned like the
# Railway CLI, never `latest` (OPS-R13).
# Optional: NEON_REGION (default aws-us-east-1), NEON_PLAN=scale.
set -euo pipefail
cd "$(dirname "$0")/../.."
env_name=${1:-}
[[ "$env_name" =~ ^[a-z][a-z0-9]{1,20}$ ]] || { echo "usage: $0 <env> [--dry-run]" >&2; exit 2; }
dry_run=false
[ "${2:-}" = "--dry-run" ] && dry_run=true
: "${NEON_API_KEY:?NEON_API_KEY required}" "${NEON_ORG_ID:?NEON_ORG_ID required}"
[[ "${NEONCTL_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "pin NEONCTL_VERSION to an exact version (MAJOR.MINOR.PATCH, the version you reviewed)" >&2; exit 2; }
region=${NEON_REGION:-aws-us-east-1}
history=604800
[ "${NEON_PLAN:-launch}" = "scale" ] && history=2592000
out=".env.neon-owner-$env_name"
[ -e "$out" ] && { echo "$out exists; refusing to overwrite" >&2; exit 1; }
neon() { npx -y "neonctl@$NEONCTL_VERSION" "$@"; }
api() {
  if $dry_run; then printf 'DRY-RUN: %s %s %s\n' "$1" "$2" "${3:-}"; return; fi
  curl -fsS -X "$1" "https://console.neon.tech/api/v2$2" \
    -H "Authorization: Bearer $NEON_API_KEY" -H 'Content-Type: application/json' \
    ${3:+-d "$3"} > /dev/null
}
if $dry_run; then
  echo "DRY-RUN: neon projects create --name green-monkey-$env_name --region-id $region --org-id <org> --output json"
  project=prj-dry-run; branch=br-dry-run
else
  created=$(neon projects create --name "green-monkey-$env_name" --region-id "$region" --org-id "$NEON_ORG_ID" --output json)
  project=$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.project.id)' "$created")
  branch=$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.branch.id)' "$created")
fi
echo "project $project, default branch $branch"
if $dry_run; then
  echo "DRY-RUN: neon databases create --project-id $project --name green_monkey_$env_name"
else
  neon databases create --project-id "$project" --name "green_monkey_$env_name" --output json > /dev/null
fi
api PATCH "/projects/$project" "{\"project\":{\"history_retention_seconds\":$history}}"
api PUT "/projects/$project/branches/$branch/backup_schedule" \
  '{"schedule":[{"frequency":"daily","hour":10,"retention_seconds":3024000},{"frequency":"weekly","day":1,"hour":11,"retention_seconds":3024000}]}'
api PATCH "/projects/$project/branches/$branch" '{"branch":{"protected":true}}'
if $dry_run; then
  echo "DRY-RUN: write $out with the direct owner connection (PROVISION_DATABASE_URL)"
else
  owner=$(neon connection-string "$branch" --project-id "$project" --database-name "green_monkey_$env_name")
  (umask 077; set -o noclobber; printf 'PROVISION_DATABASE_URL=%s\n' "$owner" > "$out")
fi
echo "history window ${history}s, snapshots daily+weekly (35 d), branch protected, owner URL in $out"
echo "Next: PROVISION_DATABASE_URL from $out → npx tsx scripts/ops/provision-roles.ts --env $env_name"
