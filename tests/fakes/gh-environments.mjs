#!/usr/bin/env node
/* global process, console */
// Test double for the GitHub CLI used by scripts/ops/github-protect.sh
// (tests/workflows.test.ts). State lives in the JSON file $GH_FAKE_STATE:
//   { envs: { <name>: { policy: {protected_branches, custom_branch_policies},
//                       policies: [{ id, type, name }] } },
//     nextId, ignorePut?: boolean }
// Every call is appended to state.calls. `--jq` output goes through the real jq
// (raw strings, like gh).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.GH_FAKE_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls = [...(state.calls ?? []), args.join(" ")];
const save = () => writeFileSync(file, JSON.stringify(state));

function out(value, jq) {
  const json = JSON.stringify(value);
  process.stdout.write(
    jq
      ? execFileSync("jq", ["-r", jq], { input: json, encoding: "utf8" })
      : json + "\n",
  );
}

if (args[0] !== "api") {
  save();
  process.exit(0);
}
let method = "GET";
let path = "";
let jq = "";
const fields = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "-X") method = args[++i];
  else if (a === "--jq") jq = args[++i];
  else if (a === "--input") i++;
  else if (a === "--paginate") continue;
  else if (a === "-f" || a === "-F") {
    const [key, ...rest] = args[++i].split("=");
    const value = rest.join("=");
    fields[key] =
      a === "-F" && /^(true|false)$/.test(value) ? value === "true" : value;
  } else path = a;
}
const m = path.match(
  /^repos\/[^/]+\/[^/]+\/(rulesets|environments)(?:\/([^/]+))?(?:\/deployment-branch-policies(?:\/(\d+))?)?$/,
);
if (!m) {
  console.error(`fake gh: unknown path ${path}`);
  process.exit(9);
}
const [, area, name, id] = m;
if (area === "rulesets") {
  save();
  if (method === "GET") out([], jq);
  process.exit(0);
}
const env = (state.envs[name] ??= {
  policy: null,
  policies: [],
});
const isPolicies = path.includes("/deployment-branch-policies");
if (!isPolicies && method === "PUT") {
  if (!state.ignorePut)
    env.policy = {
      protected_branches:
        fields["deployment_branch_policy[protected_branches]"],
      custom_branch_policies:
        fields["deployment_branch_policy[custom_branch_policies]"],
    };
  save();
  out({ name, deployment_branch_policy: env.policy });
} else if (!isPolicies) {
  save();
  out({ name, deployment_branch_policy: env.policy }, jq);
} else if (method === "GET") {
  save();
  out({ total_count: env.policies.length, branch_policies: env.policies }, jq);
} else if (method === "POST") {
  const policy = {
    id: state.nextId++,
    type: fields.type ?? "branch",
    name: fields.name,
  };
  env.policies.push(policy);
  save();
  out(policy);
} else if (method === "DELETE") {
  env.policies = env.policies.filter((p) => String(p.id) !== id);
  save();
} else process.exit(9);
