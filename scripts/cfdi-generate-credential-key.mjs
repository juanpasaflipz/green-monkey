#!/usr/bin/env node
// Prints one CREDENTIAL_ENCRYPTION_KEY entry for the cfdi worker: "YYYY-MM:<43-char base64url>"
// (32 random bytes). Prepend it to the existing value to rotate ("new,old"), redeploy the worker,
// run `npm run cfdi:rekey`, then drop the old entry (docs/CFDI.md, "Credential key rotation").
// The value is a secret: paste it into the worker's environment only, never into a file or log.
/* global process */
import { randomBytes } from "node:crypto";

const now = new Date();
const kid = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
process.stdout.write(`${kid}:${randomBytes(32).toString("base64url")}\n`);
