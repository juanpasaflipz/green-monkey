/** Explicit allowlists for both sides of a local or Neon test connection pair.
 * No production/default URL fallback and no inferred pooled/direct hostname.
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
  return { runtime, migration };
}
