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
  // The Railway preDeploy (migrate, then grants) runs in the worker service.
  MIGRATION_DATABASE_URL:
    "postgresql://gm_migrator:pw@ep-x.us-east-1.aws.neon.tech/green_monkey_production",
};
const billingWorker = {
  ...deployedWorker,
  BILLING_SANDBOX_ENABLED: "true",
  BILLING_DATABASE_URL:
    "postgresql://gm_production_billing:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_production",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_EXPECTED_ACCOUNT_ID: "acct_x",
  STRIPE_PRICE_PRO_MONTHLY: "price_m",
  STRIPE_PRICE_PRO_ANNUAL: "price_y",
  STRIPE_PORTAL_CONFIG_ID: "bpc_x",
};

describe("process configuration", () => {
  it("deployed web refuses migration, backup and provisioning URLs and STRIPE_SECRET_KEY (DB-1/OPS-8 regression)", () => {
    expect(forbiddenCredentials.web).toEqual([
      "MIGRATION_DATABASE_URL",
      "BACKUP_DATABASE_URL",
      "PROVISION_DATABASE_URL",
      "STRIPE_SECRET_KEY",
    ]);
    expect(loadConfig(deployedWeb, "web").deployed).toBe(true);
    for (const name of forbiddenCredentials.web)
      expect(
        () =>
          loadConfig({ ...deployedWeb, [name]: "postgresql://x@y/z" }, "web"),
        name,
      ).toThrow(`forbidden_credential_in_process: ${name}`);
  });

  it("deployed worker refuses the runtime, backup and provisioning URLs", () => {
    expect(loadConfig(deployedWorker, "worker")).toMatchObject({
      kind: "worker",
      databaseUrl: null,
      billingDatabaseUrl: null,
    });
    expect(loadConfig(billingWorker, "worker").billingDatabaseUrl).toContain(
      "gm_production_billing",
    );
    for (const name of [
      "DATABASE_URL",
      "BACKUP_DATABASE_URL",
      "PROVISION_DATABASE_URL",
    ])
      expect(
        () =>
          loadConfig(
            { ...deployedWorker, [name]: "postgresql://x@y/z" },
            "worker",
          ),
        name,
      ).toThrow(`forbidden_credential_in_process: ${name}`);
  });

  it("production web holds the cross-tenant billing login only while billing is enabled (DB-1 follow-up)", () => {
    const production = {
      ...deployedWeb,
      APP_ENV: "production",
      APP_URL: "https://app.example.com",
      BILLING_DATABASE_URL: billingWorker.BILLING_DATABASE_URL,
    };
    for (const disabled of [undefined, "false", ""])
      expect(
        () =>
          loadConfig(
            { ...production, BILLING_SANDBOX_ENABLED: disabled },
            "web",
          ),
        String(disabled),
      ).toThrow("forbidden_credential_in_process: BILLING_DATABASE_URL");
    expect(
      loadConfig(
        {
          ...production,
          BILLING_SANDBOX_ENABLED: "true",
          STRIPE_WEBHOOK_SECRET: "whsec_x",
        },
        "web",
      ).billingDatabaseUrl,
    ).toContain("gm_production_billing");
    // Staging keeps tolerating an unused login (billing toggled off there).
    expect(
      loadConfig(
        {
          ...deployedWeb,
          BILLING_DATABASE_URL: billingWorker.BILLING_DATABASE_URL,
        },
        "web",
      ).billingDatabaseUrl,
    ).toBeNull();
    // The worker is not internet-facing.
    const { BILLING_SANDBOX_ENABLED: _on, ...idleWorker } = billingWorker;
    expect(loadConfig(idleWorker, "worker").billingDatabaseUrl).toBeNull();
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
    expect(c).toMatchObject({
      appEnv: "development",
      deployed: false,
      port: 3001,
    });
  });

  it("requires APP_URL over https and NODE_ENV=production when deployed", () => {
    const { APP_URL: _drop, ...noUrl } = deployedWeb;
    expect(() => loadConfig(noUrl, "web")).toThrow("missing_app_url");
    expect(() =>
      loadConfig(
        { ...deployedWeb, APP_URL: "http://staging.example.com" },
        "web",
      ),
    ).toThrow("app_url_https_required");
    expect(() =>
      loadConfig({ ...deployedWeb, NODE_ENV: "development" }, "web"),
    ).toThrow("node_env_production_required");
    expect(() =>
      loadConfig({ ...deployedWeb, JWT_SECRET: "short" }, "web"),
    ).toThrow("missing_jwt_secret");
  });

  it("requires the billing login and webhook secret in web and provider keys in the worker", () => {
    expect(() =>
      loadConfig({ ...deployedWeb, BILLING_SANDBOX_ENABLED: "true" }, "web"),
    ).toThrow("missing_billing_database_url");
    expect(() =>
      loadConfig(
        {
          ...deployedWeb,
          BILLING_SANDBOX_ENABLED: "true",
          BILLING_DATABASE_URL: billingWorker.BILLING_DATABASE_URL,
        },
        "web",
      ),
    ).toThrow("missing_stripe_webhook_secret");
    const { STRIPE_SECRET_KEY: _key, ...noKey } = billingWorker;
    expect(() => loadConfig(noKey, "worker")).toThrow(
      "missing_stripe_secret_key",
    );
  });

  it("rejects sslmode=disable for non-loopback hosts (OPS-14)", () => {
    expect(() =>
      loadConfig(
        {
          ...web,
          DATABASE_URL: "postgresql://u:p@db.example.com/x?sslmode=disable",
        },
        "web",
      ),
    ).toThrow("database_tls_required");
    expect(
      loadConfig(
        {
          ...web,
          DATABASE_URL: "postgresql://u:p@127.0.0.1/x?sslmode=disable",
        },
        "web",
      ).databaseUrl,
    ).toContain("127.0.0.1");
  });

  it("treats empty strings as unset and validates enumerations", () => {
    expect(loadConfig({ ...web, APP_ENV: "" }, "web").appEnv).toBe(
      "development",
    );
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
    expect(detectKind({ PROCESS_KIND: "worker" }, "/x/index.js")).toBe(
      "worker",
    );
    const local = loadConfig({ PORT: "3001" }, "worker");
    expect(local).toMatchObject({ port: 3002, dbPoolMax: 4, drainSeconds: 30 });
    expect(
      loadConfig(
        { ...deployedWeb, WORKER_URL: "http://worker.railway.internal:3002" },
        "web",
      ).workerUrl,
    ).toBe("http://worker.railway.internal:3002");
    expect(loadConfig({ ...deployedWorker, PORT: "3005" }, "worker").port).toBe(
      3005,
    );
    expect(
      loadConfig(
        { ...deployedWorker, ALERT_WEBHOOK_URL: "https://ntfy.sh/topic" },
        "worker",
      ).alertWebhook,
    ).toEqual({ url: "https://ntfy.sh/topic", kind: "ntfy" });
  });

  it("errors name variables, never their values", () => {
    try {
      loadConfig(
        { ...deployedWeb, STRIPE_SECRET_KEY: "sk_live_supersecret" },
        "web",
      );
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
