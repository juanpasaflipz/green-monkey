#!/usr/bin/env node
/* global process */
// Prints one SIGNING_KEYS entry, "<kid>:<base64url of 32 random bytes>", to stdout only.
// The kid "k<YYYYMMDD>-<4 hex>" matches /^[a-z0-9-]{1,32}$/. Never paste it into a command line;
// put it in the private file read by scripts/ops/railway-vars.sh. Rotation: docs/RUNBOOK.md
// "Signing keys".
import { randomBytes } from "node:crypto";
const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
process.stdout.write(
  `k${day}-${randomBytes(2).toString("hex")}:${randomBytes(32).toString("base64url")}\n`,
);
