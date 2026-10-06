import type postgres from "postgres";
import type { Tx } from "./db.js";
import type { GoogleAttemptStore } from "./google-identity.js";

export function googleAttemptStore(sql: postgres.Sql): GoogleAttemptStore {
  async function scoped<T>(
    stateHash: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(stateHash))
      throw Error("google_login_invalid");
    return sql.begin(async (raw) => {
      const tx = raw as Tx;
      await tx`select set_config('app.auth_state_hash',${stateHash},true)`;
      return fn(tx);
    }) as Promise<T>;
  }
  return {
    async create(attempt) {
      await scoped(attempt.stateHash, async (tx) => {
        await tx`insert into oauth_login_attempts(state_hash,browser_hash,nonce,verifier,expires_at)
          values(${attempt.stateHash},${attempt.browserHash},${attempt.nonce},${attempt.verifier},clock_timestamp()+interval '10 minutes')`;
      });
    },
    async consume(stateHash, browserHash, _now) {
      return scoped(stateHash, async (tx) => {
        // UPDATE obtains the row lock and rechecks the predicate after waiting.
        // The database clock is authoritative for expiry across server instances.
        const [row] =
          await tx`update oauth_login_attempts set consumed_at=clock_timestamp()
          where state_hash=${stateHash} and browser_hash=${browserHash}
            and consumed_at is null and expires_at>clock_timestamp()
          returning *`;
        if (!row) return null;
        return {
          stateHash: row.state_hash,
          browserHash: row.browser_hash,
          nonce: row.nonce,
          verifier: row.verifier,
          expiresAt: row.expires_at.getTime(),
        };
      });
    },
  };
}
