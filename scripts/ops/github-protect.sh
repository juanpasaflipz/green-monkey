#!/usr/bin/env bash
# User-run (never from CI): protects main with ops/github/main-ruleset.json and
# creates the staging/production environments limited to protected branches.
# Prints the secret/variable commands to run afterwards; never prints values.
#   GITHUB_REPOSITORY=owner/repo scripts/ops/github-protect.sh [--dry-run]
# Requires the GitHub CLI authenticated as a repository admin. A 403 means the
# plan does not offer rulesets on private repositories (see PROVISIONING.md).
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=${GITHUB_REPOSITORY:-juanpasaflipz/green-monkey}
dry_run=false
[ "${1:-}" = "--dry-run" ] && dry_run=true
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "invalid GITHUB_REPOSITORY" >&2; exit 2; }
run() {
  if $dry_run; then printf 'DRY-RUN: %s\n' "$*"; else "$@"; fi
}
node -e 'JSON.parse(require("fs").readFileSync("ops/github/main-ruleset.json","utf8"))'
existing=$($dry_run && echo "" || gh api "repos/$repo/rulesets" --jq '.[] | select(.name=="main: reviewed, qualified, linear") | .id')
if [ -n "$existing" ]; then
  run gh api -X PUT "repos/$repo/rulesets/$existing" --input ops/github/main-ruleset.json
else
  run gh api -X POST "repos/$repo/rulesets" --input ops/github/main-ruleset.json
fi
# The alert steps of backup.yml and uptime.yml file issues with this label.
run gh label create ops-alert --repo "$repo" --color B60205 \
  --description "Automated operations alert" --force
for environment in staging production; do
  run gh api -X PUT "repos/$repo/environments/$environment" \
    -F "deployment_branch_policy[protected_branches]=true" \
    -F "deployment_branch_policy[custom_branch_policies]=false"
done
cat <<'NEXT'
Next, per environment (values come from the private provisioning files; type
them at the prompt, never on the command line):
  gh secret set RAILWAY_TOKEN --env <staging|production>
  gh secret set BACKUP_DATABASE_URL --env <staging|production>
  gh secret set R2_ACCESS_KEY_ID --env <staging|production>
  gh secret set R2_SECRET_ACCESS_KEY --env <staging|production>
  gh secret set ALERT_WEBHOOK_URL --env <staging|production>
  gh variable set APP_URL --env <staging|production>
  gh variable set R2_ACCOUNT_ID --env <staging|production>
  gh variable set R2_BUCKET --env <staging|production>
Repository variables (exact versions, verified with `npx @railway/cli@X config --help`):
  gh variable set RAILWAY_CLI_VERSION
  gh variable set RAILWAY_IAC_VERSION
Once an environment's secrets are set and one manual backup has passed, turn
on its scheduled backup (and, for production, the hourly uptime check):
  gh variable set OPS_LIVE_ENVIRONMENTS --body "staging"
  gh variable set OPS_LIVE_ENVIRONMENTS --body "staging production"
NEXT
