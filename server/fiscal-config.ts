// fiscal (027) startup check (contract C-9): one pure call between config-rules.ts's web
// markers. Imports only config-error.ts (config-rules.ts imports this module).
import { ConfigError } from "./config-error.js";

/**
 * FISCAL_TICKETS_ENABLED (web, registered by Wave 2.0): "true", "false" or unset/empty (on).
 * Anything else is refused at startup, so a typo can never silently keep the kill switch off
 * or on. issueDueTicket reads the value at call time.
 */
export function fiscalWebConfig(env: NodeJS.ProcessEnv, _appEnv: string) {
  const value = env.FISCAL_TICKETS_ENABLED;
  if (value && value !== "true" && value !== "false")
    throw new ConfigError("invalid_fiscal_tickets_enabled");
}
