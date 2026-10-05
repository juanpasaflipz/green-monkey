#!/usr/bin/env node
/* global process, console */
// Writes build-info.json for the revision being shipped. CD runs this before
// `railway up`, and CI before `docker build`, so /api/version reports the
// commit that was actually built.
// Usage: node scripts/ops/stamp-build.mjs <40-char commit sha> [output path]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [sha, output = "build-info.json"] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
  console.error(
    "usage: stamp-build.mjs <full 40-character lowercase commit sha>",
  );
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const info = {
  version: pkg.version,
  commit: sha,
  builtAt: new Date().toISOString(),
};
writeFileSync(resolve(output), JSON.stringify(info) + "\n");
console.log(JSON.stringify({ message: "build_stamped", ...info }));
