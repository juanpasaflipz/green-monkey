// First import of both entry points (server/index.ts and server/worker.ts) and
// imported by nothing else. Loading dotenv here, before any other module is
// evaluated, keeps module-level reads such as auth.ts cookieOptions correct
// when NODE_ENV comes from .env (SEC-9).
import "dotenv/config";
import {
  ConfigError,
  detectKind,
  loadConfig,
  type Config,
} from "./config-rules.js";

export type { AppEnv, Config, ProcessKind } from "./config-rules.js";
export { loadConfig } from "./config-rules.js";

function load(): Config {
  const kind = detectKind(process.env, process.argv[1]);
  try {
    return loadConfig(process.env, kind);
  } catch (error) {
    // One redacted line: the code names variables, never values.
    process.stdout.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "error",
        message: "config_invalid",
        service: kind,
        env: process.env.APP_ENV || "development",
        code:
          error instanceof ConfigError ? error.code : "config_load_failed",
      }) + "\n",
    );
    process.exit(1);
  }
}

export const config: Config = load();
