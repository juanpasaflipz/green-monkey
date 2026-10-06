/** Explicit allowlists for both sides of a local or Neon test connection pair.
 * No production/default URL fallback and no inferred pooled/direct hostname.
 *
 * `worker` is the jobs login (a gm_jobs_worker member) on the runtime target:
 * TEST_WORKER_DATABASE_URL when set (same host:port/database as
 * TEST_DATABASE_URL, on the same allowlist); otherwise, for a loopback target,
 * the runtime URL with the local gm_worker credentials that
 * scripts/provision-local.sql and CI create; otherwise undefined (see
 * requireWorker).
 */
export function isolatedTarget(env: NodeJS.ProcessEnv) {
  const runtime = env.TEST_DATABASE_URL;
  const migration = env.TEST_MIGRATION_DATABASE_URL;
  if (!runtime || !migration || env.NODE_ENV === "production")
    throw Error("Explicit isolated test URLs required");
  const u = new URL(runtime),
    m = new URL(migration);
  const identity = (url: URL) =>
    `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  const local =
    ["localhost", "127.0.0.1"].includes(u.hostname) &&
    u.hostname === m.hostname &&
    u.port === m.port;
  const cloud =
    u.hostname.endsWith(".neon.tech") &&
    m.hostname.endsWith(".neon.tech") &&
    env.TEST_MIGRATION_DATABASE_HOST_ALLOWLIST?.split(",").includes(
      identity(m),
    );
  if (
    !u.pathname.endsWith("_test") ||
    u.pathname !== m.pathname ||
    !env.TEST_DATABASE_HOST_ALLOWLIST?.split(",").includes(identity(u)) ||
    (!local && !cloud)
  )
    throw Error("Only explicitly allowlisted isolated test targets accepted");
  let worker: string | undefined;
  if (env.TEST_WORKER_DATABASE_URL) {
    const w = new URL(env.TEST_WORKER_DATABASE_URL);
    if (
      identity(w) !== identity(u) ||
      !env.TEST_DATABASE_HOST_ALLOWLIST?.split(",").includes(identity(w))
    )
      throw Error("Only explicitly allowlisted isolated test targets accepted");
    worker = env.TEST_WORKER_DATABASE_URL;
  } else if (local) {
    const w = new URL(runtime);
    w.username = "gm_worker";
    w.password = "local-only-worker";
    worker = w.href;
  }
  return { runtime, migration, worker };
}

/** The jobs worker URL of an isolated target, for suites that need it. */
export function requireWorker(target: { worker?: string }): string {
  if (!target.worker)
    throw Error(
      "TEST_WORKER_DATABASE_URL required for a non-loopback test target",
    );
  return target.worker;
}
