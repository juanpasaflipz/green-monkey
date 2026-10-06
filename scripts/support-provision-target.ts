/**
 * Which databases `npm run support:provision` may create operator logins on
 * (account 031, LD-32 OPS-1, LD-34 Q19). Pure, so tests/support-cli.test.ts
 * checks it without a database.
 *
 * - The databases ops provisioning creates: scripts/ops/provision-neon.sh
 *   names each environment's database green_monkey_<env> with
 *   <env> = [a-z][a-z0-9]{1,20} (docs/PROVISIONING.md: green_monkey_production,
 *   green_monkey_staging).
 * - Local and acceptance databases: green_monkey_dev and
 *   green_monkey_<name>_dev (green_monkey_acceptance_dev,
 *   green_monkey_account_dev).
 *
 * Whatever the name, SUPPORT_PROVISION_TARGET must repeat the owner URL's
 * exact host:port/database: the interlock that keeps a copied owner URL from
 * provisioning on the wrong cluster (D16).
 */
export const OPS_DATABASE = /^\/green_monkey_[a-z][a-z0-9]{1,20}$/;
export const LOCAL_DATABASE = /^\/green_monkey(_[a-z]+)?_dev$/;

export function supportProvisionTarget(
  ownerUrl: string,
  expected: string | undefined,
): { target: string; database: string } {
  const owner = new URL(ownerUrl);
  const target = `${owner.hostname}:${owner.port || "5432"}${owner.pathname}`;
  if (
    !expected ||
    expected !== target ||
    !(OPS_DATABASE.test(owner.pathname) || LOCAL_DATABASE.test(owner.pathname))
  )
    throw Error("explicit_support_provision_target_required");
  return { target, database: owner.pathname.slice(1) };
}
