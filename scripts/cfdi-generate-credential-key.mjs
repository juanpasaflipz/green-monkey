#!/usr/bin/env node
// Prints one CREDENTIAL_ENCRYPTION_KEY entry for the cfdi worker: "YYYY-MM-DD-<6 hex>:<43-char
// base64url>" (32 random bytes). The kid is unique even for two rotations on the same day: a kid is
// never reused with another secret (CFDI-SECRETS-5). Prepend it to the existing value to rotate
// ("new,old"), redeploy the worker, run `npm run cfdi:rekey`, then drop the old entry
// (docs/CFDI.md, "Credential key rotation"). The value is a secret: paste it into the worker's
// environment only, never into a file or log.
/* global process */
import { randomBytes } from "node:crypto";

const day = new Date().toISOString().slice(0, 10);
const kid = `${day}-${randomBytes(3).toString("hex")}`;
process.stdout.write(`${kid}:${randomBytes(32).toString("base64url")}\n`);
