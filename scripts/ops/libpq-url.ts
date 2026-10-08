/**
 * Connection string for libpq command-line tools (pg_restore, psql, pg_dump).
 * provision-roles.ts writes URLs with sslmode=verify-full, which libpq checks
 * against ~/.postgresql/root.crt unless sslrootcert says otherwise; operator
 * workstations rarely have that file, so the restore drill's pg_restore failed
 * ("root certificate file … does not exist"). sslrootcert=system (libpq 16+)
 * uses the operating system's trusted roots, which Neon's certificates chain to.
 * An explicit sslrootcert and every other parameter are kept as written.
 */
export function libpqUrl(url: string): string {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  if (
    (mode === "verify-full" || mode === "verify-ca") &&
    !u.searchParams.has("sslrootcert")
  )
    u.searchParams.set("sslrootcert", "system");
  return u.href;
}
