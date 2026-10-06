/** Startup configuration error. The code names variables, never values. Pure; imported by
 *  server/config-rules.ts and by area config validators (contract C-9), which must not import
 *  config-rules.ts (it imports them: a module cycle). */
export class ConfigError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "ConfigError";
  }
}
