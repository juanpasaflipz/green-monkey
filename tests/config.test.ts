import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConfigError,
  detectKind,
  forbiddenCredentials,
  loadConfig,
} from "../server/config-rules.js";
import { ConfigError as PureConfigError } from "../server/config-error.js";

const secret = "x".repeat(40);
// A synthetic keyring entry built at runtime (no key material is committed).
const signingKeys = (kid = "k1", fill = 7, bytes = 32) =>
  `${kid}:${Buffer.alloc(bytes, fill).toString("base64url")}`;
const web = {
  DATABASE_URL: "postgresql://gm_app:pw@127.0.0.1:5432/green_monkey_dev",
  JWT_SECRET: secret,
};
// PLATFORM-KEYS-3: a deployed web, staging included, requires SIGNING_KEYS, so
// the staging fixture carries a keyring (deliberate behaviour change).
const deployedWeb = {
  ...web,
  APP_ENV: "staging",
  NODE_ENV: "production",
  APP_URL: "https://staging.example.com",
  DATABASE_URL:
    "postgresql://gm_staging_app:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_staging",
  SIGNING_KEYS: signingKeys(),
};
const workerDatabaseUrl =
  "postgresql://gm_production_worker:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey_production";
// Migrations run in GitHub Actions (Wave 2.0 (l)): a deployed worker now
// refuses MIGRATION_DATABASE_URL, so the fixture no longer carries it.
// PLATFORM-OPS-4: a deployed worker requires its jobs login, so it carries
// WORKER_DATABASE_URL (deliberate behaviour change).
const deployedWorker = {
  APP_ENV: "production",
  NODE_ENV: "production",
  APP_URL: "https://app.example.com",
  PROCESS_KIND: "worker",
  WORKER_DATABASE_URL: workerDatabaseUrl,
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
      "WORKER_DATABASE_URL",
      "SUPPORT_DATABASE_URL",
      "FACTURAPI_API_KEY",
      "FACTURAPI_TEST_KEY",
      "CREDENTIAL_ENCRYPTION_KEY",
      "CFDI_LIVE_ENABLED",
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
    expect(forbiddenCredentials.worker).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "BACKUP_DATABASE_URL",
        "PROVISION_DATABASE_URL",
      ]),
    );
    for (const name of forbiddenCredentials.worker)
      expect(
        () =>
          loadConfig(
            { ...deployedWorker, [name]: "postgresql://x@y/z" },
            "worker",
          ),
        name,
      ).toThrow(`forbidden_credential_in_process: ${name}`);
  });

  it("deployed web refuses WORKER_DATABASE_URL, SUPPORT_DATABASE_URL, FACTURAPI_API_KEY, FACTURAPI_TEST_KEY, CREDENTIAL_ENCRYPTION_KEY and CFDI_LIVE_ENABLED (even 'false')", () => {
    for (const [name, value] of [
      ["WORKER_DATABASE_URL", workerDatabaseUrl],
      ["SUPPORT_DATABASE_URL", "postgresql://gm_support_x:pw@db/x"],
      ["FACTURAPI_API_KEY", "sk_live_fixture"],
      ["FACTURAPI_TEST_KEY", "sk_test_fixture"],
      ["CREDENTIAL_ENCRYPTION_KEY", "fixture"],
      ["CFDI_LIVE_ENABLED", "false"],
    ])
      for (const appEnv of ["staging", "production"])
        expect(
          () =>
            loadConfig(
              {
                ...deployedWeb,
                APP_ENV: appEnv,
                [name]: value,
              },
              "web",
            ),
          `${appEnv} ${name}`,
        ).toThrow(`forbidden_credential_in_process: ${name}`);
  });

  it("deployed worker refuses MIGRATION_DATABASE_URL, SUPPORT_DATABASE_URL, SIGNING_KEYS and JWT_SECRET (DB-1 regression, P-15)", () => {
    for (const name of [
      "MIGRATION_DATABASE_URL",
      "SUPPORT_DATABASE_URL",
      "SIGNING_KEYS",
      "JWT_SECRET",
    ]) {
      expect(forbiddenCredentials.worker).toContain(name);
      for (const appEnv of ["staging", "production"])
        expect(
          () =>
            loadConfig(
              {
                ...deployedWorker,
                APP_ENV: appEnv,
                [name]:
                  name === "JWT_SECRET"
                    ? secret
                    : name === "SIGNING_KEYS"
                      ? "k1:" + Buffer.alloc(32, 7).toString("base64url")
                      : "postgresql://gm_migrator:pw@ep-x.us-east-1.aws.neon.tech/x",
              },
              "worker",
            ),
          `${appEnv} ${name}`,
        ).toThrow(`forbidden_credential_in_process: ${name}`);
    }
  });

  it("development tolerates every one of them", () => {
    const all = Object.fromEntries(
      [...forbiddenCredentials.web, ...forbiddenCredentials.worker].map(
        (name) => [
          name,
          name.endsWith("DATABASE_URL")
            ? "postgresql://u:p@127.0.0.1:55439/green_monkey_dev"
            : name === "JWT_SECRET"
              ? secret
              : name === "SIGNING_KEYS" || name === "CREDENTIAL_ENCRYPTION_KEY"
                ? "k1:" + Buffer.alloc(32, 7).toString("base64url")
                : // cfdi (030) validates the shape of its own variables in
                  // every environment (server/cfdi/config.ts).
                  name === "FACTURAPI_API_KEY"
                  ? "sk_user_fixture"
                  : name === "FACTURAPI_TEST_KEY"
                    ? "sk_test_fixture"
                    : name === "CFDI_LIVE_ENABLED"
                      ? "false"
                      : "fixture",
        ],
      ),
    );
    for (const appEnv of [undefined, "development", "test"]) {
      expect(
        loadConfig({ ...all, APP_ENV: appEnv }, "web").deployed,
        `web ${appEnv}`,
      ).toBe(false);
      expect(
        loadConfig({ ...all, APP_ENV: appEnv }, "worker").workerDatabaseUrl,
        `worker ${appEnv}`,
      ).toBe("postgresql://u:p@127.0.0.1:55439/green_monkey_dev");
    }
  });

  it("the worker accepts WORKER_DATABASE_URL with database_tls_required and invalid_worker_database_url; the web's workerDatabaseUrl is null", () => {
    expect(
      loadConfig(
        { ...deployedWorker, WORKER_DATABASE_URL: workerDatabaseUrl },
        "worker",
      ).workerDatabaseUrl,
    ).toBe(workerDatabaseUrl);
    // PLATFORM-OPS-4: a deployed worker (staging or production) refuses to start
    // without its jobs login; unset and empty are the same. Development may run
    // without one (billing and watchdog only).
    const { WORKER_DATABASE_URL: _url, ...noJobsLogin } = deployedWorker;
    for (const appEnv of ["staging", "production"])
      for (const value of [undefined, "", "  "])
        expect(
          () =>
            loadConfig(
              { ...noJobsLogin, APP_ENV: appEnv, WORKER_DATABASE_URL: value },
              "worker",
            ),
          `${appEnv} ${JSON.stringify(value)}`,
        ).toThrow("missing_worker_database_url");
    for (const appEnv of [undefined, "development", "test"])
      expect(
        loadConfig({ PROCESS_KIND: "worker", APP_ENV: appEnv }, "worker")
          .workerDatabaseUrl,
        `${appEnv} without a jobs login`,
      ).toBeNull();
    expect(
      loadConfig({ PROCESS_KIND: "worker", WORKER_DATABASE_URL: "" }, "worker")
        .workerDatabaseUrl,
      "empty means unset",
    ).toBeNull();
    expect(() =>
      loadConfig(
        {
          ...deployedWorker,
          WORKER_DATABASE_URL: workerDatabaseUrl + "?sslmode=disable",
        },
        "worker",
      ),
    ).toThrow("database_tls_required");
    for (const bad of ["not a url", "https://example.com/db"])
      expect(
        () =>
          loadConfig({ ...deployedWorker, WORKER_DATABASE_URL: bad }, "worker"),
        bad,
      ).toThrow("invalid_worker_database_url");
    expect(
      loadConfig(
        {
          PROCESS_KIND: "worker",
          WORKER_DATABASE_URL:
            "postgresql://gm_worker:local-only-worker@127.0.0.1:55439/green_monkey_dev?sslmode=disable",
        },
        "worker",
      ).workerDatabaseUrl,
      "loopback needs no TLS",
    ).toContain("127.0.0.1");
    expect(loadConfig(deployedWeb, "web").workerDatabaseUrl).toBeNull();
    expect(
      loadConfig({ ...web, WORKER_DATABASE_URL: workerDatabaseUrl }, "web")
        .workerDatabaseUrl,
      "the web never uses it, even in development",
    ).toBeNull();
  });

  it("a deployed web (staging and production) requires SIGNING_KEYS; development does not (PLATFORM-KEYS-3)", () => {
    const { SIGNING_KEYS: _keys, ...noKeys } = deployedWeb;
    const production = {
      ...noKeys,
      APP_ENV: "production",
      APP_URL: "https://app.example.com",
    };
    expect(() => loadConfig(production, "web")).toThrow("missing_signing_keys");
    expect(() =>
      loadConfig({ ...production, SIGNING_KEYS: "" }, "web"),
    ).toThrow("missing_signing_keys");
    expect(
      loadConfig({ ...production, SIGNING_KEYS: signingKeys() }, "web").appEnv,
    ).toBe("production");
    // Staging rehearses production: it never falls back to a key derived from
    // JWT_SECRET, which would then sign cfdi-portal-file tokens (P-23).
    expect(() => loadConfig(noKeys, "web")).toThrow("missing_signing_keys");
    expect(() => loadConfig({ ...noKeys, SIGNING_KEYS: " " }, "web")).toThrow(
      "missing_signing_keys",
    );
    expect(loadConfig(deployedWeb, "web").appEnv).toBe("staging");
    expect(loadConfig(web, "web").appEnv).toBe("development");
    expect(loadConfig({ ...web, APP_ENV: "test" }, "web").appEnv).toBe("test");
    // Railway's production environment counts too, in any case, as it does
    // for the keyring (server/production.ts), so the web never boots into a
    // ring that refuses every signature (PLAT-R1), even with APP_ENV unset.
    expect(() =>
      loadConfig({ ...web, RAILWAY_ENVIRONMENT_NAME: "Production" }, "web"),
    ).toThrow("missing_signing_keys");
    // JWT_SECRET stays required next to SIGNING_KEYS (legacy tokens, lookup digests).
    const { JWT_SECRET: _jwt, ...noJwt } = production;
    expect(() =>
      loadConfig({ ...noJwt, SIGNING_KEYS: signingKeys() }, "web"),
    ).toThrow("missing_jwt_secret");
  });

  it("malformed SIGNING_KEYS → invalid_signing_keys: a short secret, a bad kid, a duplicate kid, the reserved kid jwt, six entries, a non-base64url secret", () => {
    for (const [label, value] of [
      ["short secret", signingKeys("k1", 7, 31)],
      ["bad kid", signingKeys("K_1")],
      ["kid too long", signingKeys("k".repeat(33))],
      ["duplicate kid", `${signingKeys("k1", 1)},${signingKeys("k1", 2)}`],
      ["reserved kid", signingKeys("jwt")],
      [
        "six entries",
        [1, 2, 3, 4, 5, 6].map((n) => signingKeys(`k${n}`, n)).join(","),
      ],
      ["non-base64url secret", `k1:${"a".repeat(43)}=`],
      ["no kid", Buffer.alloc(32, 7).toString("base64url")],
    ])
      for (const appEnv of ["development", "staging", "production"])
        expect(
          () =>
            loadConfig(
              {
                ...(appEnv === "development" ? web : deployedWeb),
                APP_ENV: appEnv,
                SIGNING_KEYS: value,
              },
              "web",
            ),
          `${appEnv} ${label}`,
        ).toThrow("invalid_signing_keys");
    expect(
      loadConfig(
        {
          ...deployedWeb,
          SIGNING_KEYS: [1, 2, 3, 4, 5]
            .map((n) => signingKeys(`k${n}`, n))
            .join(","),
        },
        "web",
      ).appEnv,
      "five entries are allowed",
    ).toBe("staging");
    // The error names the variable, never its value.
    try {
      loadConfig({ ...deployedWeb, SIGNING_KEYS: signingKeys("jwt") }, "web");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(
        Buffer.alloc(32, 7).toString("base64url"),
      );
    }
  });

  it("a deployed web refuses the committed CI keyring, fixture kids, text secrets and placeholder JWT_SECRETs; development accepts them (PLATFORM-CI-1, KEYS-5)", () => {
    // qualification.yml's synthetic entry, rebuilt here from its documented text
    // (the committed literal is allowlisted in .gitleaks.toml).
    const ciText = "synthetic-ci-only-never-use-outside-tests";
    const ciKeys = `ci-20261005:${Buffer.from(ciText).toString("base64url")}`;
    const text = (kid: string, value: string) =>
      `${kid}:${Buffer.from(value).toString("base64url")}`;
    const placeholders: [string, Record<string, string>, string][] = [
      ["the CI keyring", { SIGNING_KEYS: ciKeys }, "placeholder_signing_keys"],
      [
        "a ci- kid with random-looking bytes",
        { SIGNING_KEYS: signingKeys("ci-20261005") },
        "placeholder_signing_keys",
      ],
      [
        "a local- kid",
        { SIGNING_KEYS: signingKeys("local-dev") },
        "placeholder_signing_keys",
      ],
      [
        "a test- kid",
        { SIGNING_KEYS: signingKeys("test-1") },
        "placeholder_signing_keys",
      ],
      [
        "the CI text under a production-shaped kid",
        { SIGNING_KEYS: text("k20261005-ab12", ciText) },
        "placeholder_signing_keys",
      ],
      [
        "a typed passphrase (printable text)",
        {
          SIGNING_KEYS: text(
            "k20261005-ab12",
            "correct horse battery staple and more words",
          ),
        },
        "placeholder_signing_keys",
      ],
      [
        "a good key first and the CI key second",
        { SIGNING_KEYS: `${signingKeys()},${ciKeys}` },
        "placeholder_signing_keys",
      ],
      [
        "CI's JWT_SECRET",
        {
          JWT_SECRET:
            "synthetic-ci-only-never-use-outside-disposable-tests-123456789",
        },
        "placeholder_jwt_secret",
      ],
      [
        "a local-only JWT_SECRET",
        { JWT_SECRET: "local-only-jwt-secret-for-this-track-0123456789" },
        "placeholder_jwt_secret",
      ],
      [
        ".env.example's placeholder",
        {
          JWT_SECRET: "replace-with-an-environment-specific-random-secret",
        },
        "placeholder_jwt_secret",
      ],
      [
        "replace-me",
        { JWT_SECRET: "replace-me-replace-me-replace-me-replace-me" },
        "placeholder_jwt_secret",
      ],
    ];
    for (const [label, vars, code] of placeholders) {
      for (const appEnv of ["staging", "production"])
        expect(
          () =>
            loadConfig(
              {
                ...deployedWeb,
                APP_ENV: appEnv,
                APP_URL: "https://app.example.com",
                ...vars,
              },
              "web",
            ),
          `${appEnv}: ${label}`,
        ).toThrow(code);
      // Railway's production environment refuses them even without APP_ENV.
      expect(
        () =>
          loadConfig(
            { ...web, RAILWAY_ENVIRONMENT_NAME: "production", ...vars },
            "web",
          ),
        `RAILWAY_ENVIRONMENT_NAME=production: ${label}`,
      ).toThrow(code);
      // Local and CI runs (APP_ENV unset) keep using them.
      expect(
        loadConfig({ ...web, ...vars }, "web").appEnv,
        `development: ${label}`,
      ).toBe("development");
    }
    // generate-signing-key.mjs output (random bytes, k<YYYYMMDD>-<hex> kid) passes,
    // as does a two-key rotation ring.
    const random = (kid: string) =>
      `${kid}:${Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 129) % 256)).toString("base64url")}`;
    expect(
      loadConfig(
        {
          ...deployedWeb,
          SIGNING_KEYS: `${random("k20261005-ab12")},${signingKeys("k20261001-0f0f", 3)}`,
        },
        "web",
      ).appEnv,
    ).toBe("staging");
    // The error names the variable class, never the value.
    try {
      loadConfig({ ...deployedWeb, SIGNING_KEYS: ciKeys }, "web");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(ciText);
      expect(String((error as Error).message)).not.toContain(
        ciKeys.split(":")[1],
      );
    }
  });

  it("ConfigError from config-rules.ts is the class from config-error.ts", () => {
    expect(ConfigError).toBe(PureConfigError);
    let thrown: unknown;
    try {
      loadConfig({ ...web, APP_ENV: "prod" }, "web");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PureConfigError);
    expect(thrown).toMatchObject({
      code: "invalid_app_env",
      name: "ConfigError",
    });
  });

  it("each branch has exactly one area-config marker pair (source scan)", () => {
    const source = readFileSync("server/config-rules.ts", "utf8");
    const count = (marker: string) => source.split(marker).length - 1;
    for (const branch of ["web", "worker"]) {
      expect(count(`// >>> area config checks: ${branch} `), branch).toBe(1);
      expect(count(`// <<< area config checks: ${branch}\n`), branch).toBe(1);
      expect(
        source.indexOf(`// >>> area config checks: ${branch} `),
      ).toBeLessThan(source.indexOf(`// <<< area config checks: ${branch}\n`));
    }
    // The web pair sits inside the web branch, the worker pair after it.
    const webBranch = source.indexOf('if (kind === "web") {');
    const webReturn = source.indexOf("return Object.freeze", webBranch);
    const webMarker = source.indexOf("// >>> area config checks: web ");
    expect(webMarker).toBeGreaterThan(webBranch);
    expect(webMarker).toBeLessThan(webReturn);
    expect(
      source.indexOf("// >>> area config checks: worker "),
    ).toBeGreaterThan(webReturn);
    // config-rules.ts imports the class, never defines it (module cycles, C-9).
    expect(source).not.toMatch(/class ConfigError/);
    expect(readFileSync("server/config-error.ts", "utf8")).not.toMatch(
      /^import /m,
    );
  });

  it("production web holds the cross-tenant billing login only while billing is enabled (DB-1 follow-up)", () => {
    const production = {
      ...deployedWeb,
      APP_ENV: "production",
      APP_URL: "https://app.example.com",
      // Wave 2.0 (P-26): a production web requires SIGNING_KEYS.
      SIGNING_KEYS: signingKeys(),
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
