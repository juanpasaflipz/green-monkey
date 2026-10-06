#!/usr/bin/env bash
# User-run (never from CI): protects main with ops/github/main-ruleset.json and
# creates the staging/production environments, each limited to a custom
# deployment branch policy that allows exactly the branch main (PLATFORM-CI-2).
# "Protected branches only" is not used: main is protected by a ruleset, not a
# classic branch protection rule, and GitHub lets every branch deploy when no
# branch protection rule exists. The policy is read back and the script fails
# unless it is exactly { custom, branch:main }.
# Prints the secret/variable commands to run afterwards; never prints values.
#   GITHUB_REPOSITORY=owner/repo scripts/ops/github-protect.sh [--dry-run]
# Requires the GitHub CLI authenticated as a repository admin. A 403 means the
# plan does not offer rulesets or environment branch policies on private
# repositories (see PROVISIONING.md section 7: then MIGRATION_DATABASE_URL must
# not be set as an environment secret).
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
# The alert steps of backup.yml, uptime.yml and retention.yml file issues with this label.
run gh label create ops-alert --repo "$repo" --color B60205 \
  --description "Automated operations alert" --force
for environment in staging production; do
  # >>> deployment-branch-policy (executed by tests/workflows.test.ts)
  policies="repos/$repo/environments/$environment/deployment-branch-policies"
  custom=(gh api -X PUT "repos/$repo/environments/$environment"
    -F "deployment_branch_policy[protected_branches]=false"
    -F "deployment_branch_policy[custom_branch_policies]=true")
  if $dry_run; then
    run "${custom[@]}"
    run gh api -X POST "$policies" -f name=main -f type=branch
    continue
  fi
  "${custom[@]}" >/dev/null
  # Exactly one policy: the branch main. Anything else (another branch, a
  # pattern, a tag) is deleted.
  have_main=false
  while read -r id type name; do
    [ -n "${id:-}" ] || continue
    if [ "$type" = branch ] && [ "$name" = main ]; then
      have_main=true
    else
      echo "removing deployment policy $type:$name from $environment"
      gh api -X DELETE "$policies/$id" >/dev/null
    fi
  done < <(gh api --paginate "$policies" --jq '.branch_policies[] | "\(.id) \(.type) \(.name)"')
  $have_main || gh api -X POST "$policies" -f name=main -f type=branch >/dev/null
  # Read back: custom policies on, protected-branches mode off, and only main.
  mode=$(gh api "repos/$repo/environments/$environment" \
    --jq '.deployment_branch_policy | "protected=\(.protected_branches) custom=\(.custom_branch_policies)"')
  allowed=$(gh api --paginate "$policies" --jq '.branch_policies[] | "\(.type):\(.name)"' | sort | paste -sd, -)
  if [ "$mode" != "protected=false custom=true" ] || [ "$allowed" != "branch:main" ]; then
    echo "environment $environment: deployment branch policy is '$mode' allowing '$allowed'; expected custom with exactly branch:main" >&2
    exit 1
  fi
  echo "environment $environment: deployments only from branch main"
  # <<< deployment-branch-policy
done
cat <<'NEXT'
Next, per environment (values come from the private provisioning files; type
them at the prompt or pipe them on stdin, never on the command line):
  gh secret set RAILWAY_TOKEN --env <staging|production>
  gh secret set MIGRATION_DATABASE_URL --env <staging|production>   (stdin; PROVISIONING.md section 7)
  gh secret set BACKUP_DATABASE_URL --env <staging|production>
  gh secret set R2_ACCESS_KEY_ID --env <staging|production>
  gh secret set R2_SECRET_ACCESS_KEY --env <staging|production>
  gh secret set ALERT_WEBHOOK_URL --env <staging|production>
  gh variable set APP_URL --env <staging|production>
  gh variable set PG_APP_USER --env <staging|production>   (gm_<env>_app)
  gh variable set ALERT_WEBHOOK_KIND --env <staging|production>   (ntfy)
  gh variable set R2_ACCOUNT_ID --env <staging|production>
  gh variable set R2_BUCKET --env <staging|production>
Repository variables (exact versions, verified with `npx @railway/cli@X config --help`):
  gh variable set RAILWAY_CLI_VERSION
  gh variable set RAILWAY_IAC_VERSION
Once an environment's secrets are set and one manual backup and one manual
retention run have passed, turn on its scheduled backup and retention (and,
for production, the hourly uptime check):
  gh variable set OPS_LIVE_ENVIRONMENTS --body "staging"
  gh variable set OPS_LIVE_ENVIRONMENTS --body "staging production"
NEXT
