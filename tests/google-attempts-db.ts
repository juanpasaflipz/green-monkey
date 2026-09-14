import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { connect, checkRole } from "../server/db.js";
import { googleAttemptStore } from "../server/google-attempt-store.js";

const { runtime, migration } = isolatedTarget(process.env);
const sql = connect(runtime),
  admin = postgres(migration, { max: 1 });
const store = googleAttemptStore(sql);
const attempt = () => ({
  stateHash: randomBytes(32).toString("base64url"),
  browserHash: randomBytes(32).toString("base64url"),
  nonce: "fixture-nonce",
  verifier: "fixture-verifier",
  expiresAt: Date.now() + 600_000,
});
const a = attempt(),
  b = attempt(),
  expired = attempt();
try {
  await checkRole(sql);
  await store.create(a);
  await store.create(b);
  await store.create(expired);
  assert.equal(
    (await sql`select * from oauth_login_attempts`).length,
    0,
    "missing scope fails closed",
  );
  await assert.rejects(
    sql`insert into oauth_login_attempts(state_hash,browser_hash,nonce,verifier,expires_at) values(${attempt().stateHash},${a.browserHash},'n','v',now()+interval '1 minute')`,
    /row-level security/,
  );
  assert.equal(
    await store.consume(a.stateHash, b.browserHash, Date.now()),
    null,
    "another browser cannot consume the attempt",
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.consume(a.stateHash, a.browserHash, Date.now()),
    ),
  );
  assert.equal(
    results.filter(Boolean).length,
    1,
    "one concurrent callback wins",
  );
  // A new store represents a restarted process; replay stays consumed in PG.
  assert.equal(
    await googleAttemptStore(sql).consume(
      a.stateHash,
      a.browserHash,
      Date.now(),
    ),
    null,
  );
  assert.ok(
    await store.consume(b.stateHash, b.browserHash, Date.now()),
    "other browser remains independent",
  );
  await admin`update oauth_login_attempts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '10 minutes' where state_hash=${expired.stateHash}`;
  assert.equal(
    await store.consume(expired.stateHash, expired.browserHash, Date.now()),
    null,
  );
  await assert.rejects(
    sql`update oauth_login_attempts set expires_at=now()+interval '1 day'`,
    /permission denied/,
  );
  console.log(
    "Google attempt DB checks passed: RLS, browser binding, 8-way replay, restart, expiry and least privilege.",
  );
} finally {
  await admin`delete from oauth_login_attempts where state_hash in (${a.stateHash},${b.stateHash},${expired.stateHash})`;
  await sql.end();
  await admin.end();
}
