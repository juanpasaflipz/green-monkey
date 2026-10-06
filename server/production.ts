/**
 * Whether this process serves production: Railway's `production` environment
 * or APP_ENV=production (server/config-rules.ts), whichever says so, in any
 * case. Read from the environment at call time. Pure: access's demo-access
 * refusal (D22) and the keyring's refusal of legacy tokens (LD-8 D5) share it.
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.RAILWAY_ENVIRONMENT_NAME?.trim().toLowerCase() === "production" ||
    env.APP_ENV?.trim().toLowerCase() === "production"
  );
}
