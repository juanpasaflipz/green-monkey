/**
 * The restore drill's connection to its point-in-time branch, as the source's backup login.
 * Neon gives every branch of a protected parent its own role passwords ("a unique role
 * password has been generated for the new branch"), so the source URL's password is refused
 * there (28P01; the production drill on 2026-10-10). `neonctl connection-string <branch>
 * --role-name … --database-name …` reveals the branch's own password for that role; this
 * takes its host and password and keeps the source URL's login, database and parameters
 * (sslmode and the rest), which also works for an unprotected parent.
 */
export function branchBackupUrl(
  source: URL,
  branchConnectionString: string,
): URL {
  const branch = new URL(branchConnectionString.trim());
  if (!branch.hostname || !branch.password)
    throw Error("branch connection string has no host or password");
  if (
    decodeURIComponent(branch.username) !== decodeURIComponent(source.username)
  )
    throw Error("branch connection string names another role");
  const url = new URL(source.href);
  url.hostname = branch.hostname;
  url.port = branch.port;
  url.password = branch.password;
  return url;
}
