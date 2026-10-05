import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectKind,
  forbiddenCredentials,
  loadConfig,
} from "../server/config-rules.js";

const secret = "x".repeat(40);
const web = {
  DATABASE_URL: "postgresql://gm_app:pw@127.0.0.1:5432/green_monkey_dev",
  JWT_SECRET: secret,
};
const deployedWeb = {
  ...web,
  APP_ENV: "staging",
  NODE_ENV: "production",
  APP_URL: "https://staging.example.com",
  DATABASE_URL:
    "postgresql://gm_staging_app:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_staging",
};
const deployedWorker = {
  APP_ENV: "production",
  NODE_ENV: "production",
  APP_URL: "https://app.example.com",
  PROCESS_KIND: "worker",
  WORKER_DATABASE_URL:
    "postgresql://gm_production_worker:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_production",
};

describe("process configuration", () => {
  it("deployed web refuses MIGRATION/BILLING/WORKER/BACKUP/PROVISION URLs and STRIPE_SECRET_KEY (SEC/DB-1 regression)", () => {
    expect(forbiddenCredentials.web).toEqual([
      "MIGRATION_DATABASE_URL",
      "BILLING_DATABASE_URL",
      "WORKER_DATABASE_URL",
      "BACKUP_DATABASE_URL",
      "PROVISION_DATABASE_URL",
      "STRIPE_SECRET_KEY",
    ]);
    expect(loadConfig(deployedWeb, "web").deployed).toBe(true);
    for (const name of forbiddenCredentials.web)
      expect(
        () => loadConfig({ ...deployedWeb, [name]: "postgresql://x@y/z" }, "web"),
        name,
      ).toThrow(`forbidden_credential_in_process: ${name}`);
  });

  it("deployed worker refuses DATABASE_URL and migration credentials", () => {
    expect(loadConfig(deployedWorker, "worker").kind).toBe("worker");
    for (const name of [
      "DATABASE_URL",
      "MIGRATION_DATABASE_URL",
      "BACKUP_DATABASE_URL",
      "PROVISION_DATABASE_URL",
    ])
      expect(
        () => loadConfig({ ...deployedWorker, [name]: "postgresql://x@y/z" }, "worker"),
        name,
      ).toThrow(`forbidden_credential_in_process: ${name}`);
  });

  it("development tolerates them", () => {
    const c = loadConfig(
      {
        ...web,
        MIGRATION_DATABASE_URL: "postgresql://p@127.0.0.1/x",
        STRIPE_SECRET_KEY: "sk_test_x",
      },
      "web",
    );
    expect(c).toMatchObject({ appEnv: "development", deployed: false, port: 3001 });
  });

  it("requires APP_URL over https and NODE_ENV=production when deployed", () => {
    const { APP_URL: _drop, ...noUrl } = deployedWeb;
    expect(() => loadConfig(noUrl, "web")).toThrow("missing_app_url");
    expect(() =>
      loadConfig({ ...deployedWeb, APP_URL: "http://staging.example.com" }, "web"),
    ).toThrow("app_url_https_required");
    expect(() =>
      loadConfig({ ...deployedWeb, NODE_ENV: "development" }, "web"),
    ).toThrow("node_env_production_required");
    expect(() => loadConfig({ ...deployedWeb, JWT_SECRET: "short" }, "web")).toThrow(
      "missing_jwt_secret",
    );
  });

  it("requires the webhook secret with billing in web and provider keys in the worker", () => {
    expect(() =>
      loadConfig({ ...deployedWeb, BILLING_SANDBOX_ENABLED: "true" }, "web"),
    ).toThrow("missing_stripe_webhook_secret");
    expect(() =>
      loadConfig({ ...deployedWorker, BILLING_SANDBOX_ENABLED: "true" }, "worker"),
    ).toThrow("missing_stripe_secret_key");
  });

  it("rejects sslmode=disable for non-loopback hosts (OPS-14)", () => {
    expect(() =>
      loadConfig(
        { ...web, DATABASE_URL: "postgresql://u:p@db.example.com/x?sslmode=disable" },
        "web",
      ),
    ).toThrow("database_tls_required");
    expect(
      loadConfig(
        { ...web, DATABASE_URL: "postgresql://u:p@127.0.0.1/x?sslmode=disable" },
        "web",
      ).databaseUrl,
    ).toContain("127.0.0.1");
  });

  it("treats empty strings as unset and validates enumerations", () => {
    expect(loadConfig({ ...web, APP_ENV: "" }, "web").appEnv).toBe("development");
    expect(() => loadConfig({ ...web, APP_ENV: "prod" }, "web")).toThrow(
      "invalid_app_env",
    );
    expect(() => loadConfig({ ...web, DATABASE_URL: "" }, "web")).toThrow(
      "missing_database_url",
    );
    expect(() => loadConfig({ ...web, DB_POOL_MAX: "0" }, "web")).toThrow(
      "invalid_db_pool_max",
    );
  });

  it("detects the worker by PROCESS_KIND or entry file and keeps worker ports apart", () => {
    expect(detectKind({}, "/app/build/server/index.js")).toBe("web");
    expect(detectKind({}, "/app/build/server/worker.js")).toBe("worker");
    expect(detectKind({ PROCESS_KIND: "worker" }, "/x/index.js")).toBe("worker");
    const local = loadConfig(
      { WORKER_DATABASE_URL: web.DATABASE_URL, PORT: "3001" },
      "worker",
    );
    expect(local).toMatchObject({ port: 3002, dbPoolMax: 6, drainSeconds: 30 });
    expect(loadConfig({ ...deployedWorker, PORT: "3005" }, "worker").port).toBe(3005);
    expect(
      loadConfig(
        { ...deployedWorker, ALERT_WEBHOOK_URL: "https://ntfy.sh/topic" },
        "worker",
      ).alertWebhook,
    ).toEqual({ url: "https://ntfy.sh/topic", kind: "ntfy" });
  });

  it("errors name variables, never their values", () => {
    try {
      loadConfig({ ...deployedWeb, STRIPE_SECRET_KEY: "sk_live_supersecret" }, "web");
    } catch (error) {
      expect(String(error)).not.toContain("supersecret");
    }
  });

  it("cookie Secure is true when NODE_ENV=production comes only from .env (SEC-9 regression)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-config-"));
    const tsx = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
    try {
      writeFileSync(
        join(dir, ".env"),
        [
          "NODE_ENV=production",
          `DATABASE_URL=${web.DATABASE_URL}`,
          `JWT_SECRET=${secret}`,
        ].join("\n") + "\n",
      );
      const probe = (first: string[]) => {
        const script = join(dir, "probe.mts");
        writeFileSync(
          script,
          first.map((m) => `import ${JSON.stringify(m)};`).join("\n") +
            `\nconst { cookieOptions } = await import(${JSON.stringify(
              pathToFileURL(resolve("server/auth.ts")).href,
            )});\nconsole.log(JSON.stringify({ secure: cookieOptions.secure }));\n`,
        );
        const env = { ...process.env };
        for (const key of [
          "NODE_ENV",
          "DATABASE_URL",
          "JWT_SECRET",
          "APP_ENV",
          "PROCESS_KIND",
        ])
          delete env[key];
        return JSON.parse(
          execFileSync(process.execPath, ["--import", tsx, script], {
            cwd: dir,
            env,
            encoding: "utf8",
          })
            .trim()
            .split("\n")
            .at(-1)!,
        );
      };
      // Control: auth.ts alone evaluates cookieOptions before .env is read.
      expect(probe([])).toEqual({ secure: false });
      expect(probe([pathToFileURL(resolve("server/config.ts")).href])).toEqual({
        secure: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
