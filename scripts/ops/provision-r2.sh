#!/usr/bin/env bash
# User-run: creates the encrypted-backup bucket for one environment on
# Cloudflare R2 with lifecycle rules (daily/ 35 days, monthly/ 1,900 days
# ≈ 5.2 years for CFF Art. 30) and an optional retention lock on monthly/.
#   scripts/ops/provision-r2.sh <staging|production> [--lock] [--dry-run]
# Requires wrangler authenticated to the Cloudflare account (npx wrangler login).
set -euo pipefail
env_name=${1:-}
[[ "$env_name" =~ ^(staging|production)$ ]] || { echo "usage: $0 <staging|production> [--lock] [--dry-run]" >&2; exit 2; }
shift
lock=false; dry_run=false
for arg in "$@"; do
  case "$arg" in
    --lock) lock=true ;;
    --dry-run) dry_run=true ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
bucket="gm-backups-$env_name"
run() { if $dry_run; then printf 'DRY-RUN: %s\n' "$*"; else "$@"; fi; }
run npx wrangler r2 bucket create "$bucket"
run npx wrangler r2 bucket lifecycle add "$bucket" daily-35 daily/ --expire-days 35 --abort-multipart-days 1
run npx wrangler r2 bucket lifecycle add "$bucket" monthly-5y monthly/ --expire-days 1900
if $lock; then
  # Objects under monthly/ cannot be deleted or overwritten for 5 years.
  run npx wrangler r2 bucket lock add "$bucket" monthly-lock monthly/ --retention-days 1825
fi
cat <<NEXT
Next (Cloudflare dashboard → R2 → Manage API tokens): create a token with
"Object Read & Write" scoped to $bucket only. Store its access key id and
secret as the GitHub environment secrets R2_ACCESS_KEY_ID and
R2_SECRET_ACCESS_KEY for "$env_name", and set the variables R2_ACCOUNT_ID and
R2_BUCKET=$bucket (scripts/ops/github-protect.sh lists the commands).
NEXT
