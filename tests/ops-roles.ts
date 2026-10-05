import { randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * Disposable LOGIN roles for the ops DB suites, created through the isolated
 * test admin connection and dropped afterwards. Capability roles (NOLOGIN)
 * come from migrations; these logins only inherit them, like the provisioned
 * gm_<env>_worker and gm_<env>_backup logins.
 */
export async function disposableLogins(
  admin: postgres.Sql,
  runtimeUrl: string,
  specs: Record<string, string[]>,
) {
  const suffix = randomBytes(5).toString("hex");
  const database = new URL(runtimeUrl).pathname.slice(1);
  const created: { role: string; sql: postgres.Sql }[] = [];
  const logins: Record<
    string,
    { role: string; url: string; sql: postgres.Sql }
  > = {};
  try {
    for (const [name, memberships] of Object.entries(specs)) {
      const role = `gm_test_${name}_${suffix}`;
      const password = randomBytes(24).toString("hex");
      await admin.unsafe(
        `create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole nobypassrls`,
      );
      for (const capability of memberships)
        await admin.unsafe(`grant "${capability}" to "${role}"`);
      await admin.unsafe(
        `grant connect on database "${database}" to "${role}"`,
      );
      const u = new URL(runtimeUrl);
      u.username = role;
      u.password = password;
      const sql = postgres(u.href, { max: 4, onnotice: () => {} });
      created.push({ role, sql });
      logins[name] = { role, url: u.href, sql };
    }
  } catch (error) {
    await drop();
    throw error;
  }
  async function drop() {
    for (const { role, sql } of created.reverse()) {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await admin
        .unsafe(`revoke connect on database "${database}" from "${role}"`)
        .catch(() => undefined);
      await admin.unsafe(`drop owned by "${role}"`).catch(() => undefined);
      await admin
        .unsafe(`drop role if exists "${role}"`)
        .catch(() => undefined);
    }
  }
  return { logins, drop };
}

let checks = 0;
/** Runs one named check, printing PASS like the other DB suites. */
export async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log("PASS", name);
}
export const passed = () => checks;
