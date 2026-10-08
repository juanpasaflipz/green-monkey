import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import {
  isNoTransaction,
  readMigrations,
  splitStatements,
  type MigrationFile,
} from "../server/ops/schema.js";
import { retentionRules } from "../server/ops/retention.js";
import {
  createdTables,
  destructive,
  dmlStatements,
  dmlTables,
  lintMigrations,
  RLS_ALLOWLIST,
  RULES_FROM,
  rlsTables,
  scan,
} from "../scripts/ops/migrations-lint.js";

/**
 * Migration rules for every area (wave 1 contract §1.3 plus the runner's
 * constraints); the rules live in scripts/ops/migrations-lint.ts so any track
 * can run them on its own directory. Files numbered 022 and later follow
 * them; earlier files predate the rules and are only checked for names and
 * transactions.
 */
const files = readMigrations();
const ruled = files.filter((f) => f.number >= RULES_FROM);
const findings = lintMigrations(files);
const rule = (name: string) => findings.filter((f) => f.rule === name);

const base = files.filter((f) => f.number < RULES_FROM);
const fixture = (name: string, body: string): MigrationFile => ({
  name,
  number: Number(name.slice(0, 3)),
  body,
  hash: "fixture",
  transactional: !isNoTransaction(body),
});
/** Findings for one extra file linted together with the bundled 001-021. */
const lintWith = (name: string, body: string) =>
  lintMigrations([...base, fixture(name, body)]).filter((f) => f.file === name);

const tenantScope = (t: string) =>
  `EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',${t});`;

describe("migrations lint", () => {
  it("file names match NNN_name.sql with unique numbers", () => {
    const names = readdirSync("migrations").filter((n) => n.endsWith(".sql"));
    expect(names.length).toBe(files.length);
    for (const name of names) expect(name).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
    const numbers = files.map((f) => f.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("the bundled migrations pass every rule", () => {
    expect(findings).toEqual([]);
  });

  it("migrations ≥ 022 start with SET LOCAL lock_timeout (wave 1 contract §1.3)", () => {
    expect(ruled.map((f) => f.name)).toContain("022_ops.sql");
    expect(rule("lock_timeout")).toEqual([]);
    expect(
      lintWith("030_x.sql", "CREATE INDEX x_a ON jobs(state);\n").map(
        (f) => f.rule,
      ),
    ).toEqual(["lock_timeout"]);
    expect(
      lintWith("030_x.sql", "-- header\nSET LOCAL lock_timeout = '5s';\n"),
    ).toEqual([]);
  });

  it("transactional files contain no CONCURRENTLY/BEGIN/COMMIT", () => {
    expect(rule("transaction_control")).toEqual([]);
    expect(
      lintWith(
        "030_x.sql",
        "SET LOCAL lock_timeout = '5s';\nCREATE INDEX CONCURRENTLY x ON jobs(state);\n",
      ).map((f) => f.rule),
    ).toEqual(["transaction_control"]);
    expect(
      lintWith(
        "030_x.sql",
        "SET LOCAL lock_timeout = '5s';\nCREATE TABLE x();\nCOMMIT;\n",
      ).map((f) => f.rule),
    ).toContain("transaction_control");
  });

  it("no-transaction files contain only concurrent index/validate statements split by gm:statement-break", () => {
    expect(
      isNoTransaction(
        "-- note\n-- gm:no-transaction\nCREATE INDEX CONCURRENTLY x ON t(a);",
      ),
    ).toBe(true);
    expect(isNoTransaction("CREATE TABLE t();\n-- gm:no-transaction")).toBe(
      false,
    );
    expect(
      splitStatements(
        "-- gm:no-transaction\nA;\n-- gm:statement-break\nB;\n-- gm:statement-break\n",
      ),
    ).toEqual(["-- gm:no-transaction\nA;", "B;"]);
    expect(rule("no_transaction_statement")).toEqual([]);
    expect(
      lintWith(
        "030_x.sql",
        "-- gm:no-transaction\nCREATE INDEX CONCURRENTLY a ON jobs(state);\nCREATE INDEX CONCURRENTLY b ON jobs(kind);\n",
      ).map((f) => f.rule),
    ).toEqual(["no_transaction_statement"]);
  });

  it("the scanner keeps strings, drops comments and lifts dollar-quoted bodies", () => {
    const { code, bodies } = scan(
      "-- a comment with $$ and ;\nSELECT 'it''s; $$ fine';\nDO $tag$ BEGIN PERFORM 1; END $tag$;\n/* block ; */ SELECT $1;",
    );
    expect(code).not.toMatch(/comment|block/);
    expect(code).toContain("'it''s; $$ fine'");
    expect(code).toContain("DO $q0$;");
    expect(code).toContain("SELECT $1;");
    expect(bodies).toEqual([" BEGIN PERFORM 1; END "]);
  });

  it("recognises every RLS table of the bundled migrations, including DO loops (OPS-R1 regression)", () => {
    // tests/ops-db.ts proves on a live database that every public table
    // except schema_migrations forces RLS; the parser must see the same.
    const forced = new Set<string>(),
      enabled = new Set<string>();
    for (const f of files) {
      const r = rlsTables(f.body);
      r.force.forEach((t) => forced.add(t));
      r.enable.forEach((t) => enabled.add(t));
    }
    const created = files.flatMap((f) => createdTables(f.body));
    expect(created).toContain("devices");
    for (const table of created.filter((t) => !RLS_ALLOWLIST.has(t))) {
      expect(enabled.has(table), `${table} enable`).toBe(true);
      expect(forced.has(table), `${table} force`).toBe(true);
    }
  });

  it("new tables in ≥ 022 enable and force RLS (allowlist: schema_grants)", () => {
    expect(rule("rls_on_new_table")).toEqual([]);
    const columns =
      "(tenant_id uuid NOT NULL REFERENCES restaurants(id), id uuid NOT NULL, PRIMARY KEY (tenant_id, id))";
    // The standard DO loop (001, 023, 025, 026) passes.
    expect(
      lintWith(
        "030_x.sql",
        `SET LOCAL lock_timeout = '5s';
CREATE TABLE pin_like${columns};
CREATE TABLE codes_like${columns};
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pin_like','codes_like'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  ${tenantScope("t")}
 END LOOP;
END $$;`,
      ),
    ).toEqual([]);
    // Literal statements pass too.
    expect(
      lintWith(
        "030_x.sql",
        `SET LOCAL lock_timeout = '5s';
CREATE TABLE public.literal_like${columns};
ALTER TABLE literal_like ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.literal_like FORCE ROW LEVEL SECURITY;`,
      ),
    ).toEqual([]);
    // A table left out of the loop, or a loop without FORCE, fails.
    const missing = lintWith(
      "030_x.sql",
      `SET LOCAL lock_timeout = '5s';
CREATE TABLE listed${columns};
CREATE TABLE forgotten${columns};
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['listed'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
 END LOOP;
END $$;
CREATE TABLE schema_grants_like_allowlisted_by_name_only${columns};`,
    ).map((f) => f.detail);
    expect(missing).toEqual(
      expect.arrayContaining([
        "listed: force row level security",
        "forgotten: enable row level security",
        "forgotten: force row level security",
      ]),
    );
    expect(missing).not.toContain("listed: enable row level security");
  });

  it("backfill DML runs with NO FORCE / FORCE row level security on every table it writes or reads (OPS-R2)", () => {
    expect(rule("backfill_owner_pattern")).toEqual([]);
    // access 023 as written: two UPDATEs on devices with no owner pattern.
    const access = lintWith(
      "023_x.sql",
      `SET LOCAL lock_timeout = '5s';
ALTER TABLE devices ADD COLUMN kind text;
UPDATE devices SET kind = CASE WHEN name = 'Owner browser' THEN 'personal' ELSE 'terminal' END;
UPDATE devices SET token_expires_at = now() + interval '30 days' WHERE active;`,
    );
    expect(access.map((f) => f.detail)).toEqual([
      "devices: ALTER TABLE devices NO FORCE ROW LEVEL SECURITY around the backfill",
      "devices: ALTER TABLE devices FORCE ROW LEVEL SECURITY around the backfill",
    ]);
    // service 024 as written: the CTE reads tenders, the UPDATE writes orders.
    const service = `WITH money AS (
  SELECT o.tenant_id, o.id, coalesce(sum(t.amount), 0) AS paid
  FROM orders o LEFT JOIN tenders t ON t.tenant_id = o.tenant_id AND t.order_id = o.id
  GROUP BY o.tenant_id, o.id)
UPDATE orders o SET check_state = 'closed' FROM money m
WHERE m.tenant_id = o.tenant_id AND m.id = o.id AND m.paid >= o.total;`;
    expect(dmlTables(dmlStatements(service)[0])).toEqual({
      target: "orders",
      reads: ["tenders"],
    });
    const flagged = lintWith(
      "024_x.sql",
      `SET LOCAL lock_timeout = '5s';\n${service}`,
    ).map((f) => f.detail.split(":")[0]);
    expect([...new Set(flagged)].sort()).toEqual(["orders", "tenders"]);
    // Wrapping only the written table still leaves the read table hidden.
    expect(
      lintWith(
        "024_x.sql",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE orders NO FORCE ROW LEVEL SECURITY;
${service}
ALTER TABLE orders FORCE ROW LEVEL SECURITY;`,
      ).map((f) => f.detail.split(":")[0]),
    ).toEqual(["tenders", "tenders"]);
    // The owner pattern on both passes (menu 025's reference form).
    expect(
      lintWith(
        "024_x.sql",
        `SET LOCAL lock_timeout = '5s';
ALTER TABLE orders NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenders NO FORCE ROW LEVEL SECURITY;
${service}
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
ALTER TABLE tenders FORCE ROW LEVEL SECURITY;`,
      ),
    ).toEqual([]);
    // DML in a DO block runs at migration time and is checked as well.
    expect(
      lintWith(
        "030_x.sql",
        `SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  UPDATE stock_items SET name = name WHERE false;
END $$;`,
      ).map((f) => f.detail.split(":")[0]),
    ).toEqual(["stock_items", "stock_items"]);
    // Function bodies run later, inside a tenant transaction: not backfills.
    expect(
      lintWith(
        "030_x.sql",
        `SET LOCAL lock_timeout = '5s';
CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE stock_items SET name = name WHERE id = NEW.id; RETURN NEW; END $$;`,
      ),
    ).toEqual([]);
    // Tables without forced RLS (and CTE names) need nothing.
    expect(
      lintWith(
        "030_x.sql",
        "SET LOCAL lock_timeout = '5s';\nWITH x AS (SELECT 1 AS n) UPDATE schema_migrations SET name = name FROM x WHERE false;",
      ),
    ).toEqual([]);
  });

  it("destructive DDL requires gm:contract-approved", () => {
    expect(destructive("ALTER TABLE t DROP COLUMN c;")).toHaveLength(1);
    expect(destructive("ALTER TABLE t RENAME TO u;")).toHaveLength(1);
    expect(
      destructive("ALTER TABLE t ALTER COLUMN c TYPE bigint;"),
    ).toHaveLength(1);
    expect(
      destructive(
        "ALTER TABLE t DROP CONSTRAINT t_kind_check; ALTER TABLE t ADD CONSTRAINT t_kind_check CHECK (kind IN ('a','b'));",
      ),
    ).toHaveLength(0);
    expect(destructive("DROP INDEX old_idx;")).toHaveLength(1);
    expect(rule("destructive_ddl")).toEqual([]);
    expect(
      lintWith(
        "030_x.sql",
        "SET LOCAL lock_timeout = '5s';\nALTER TABLE jobs DROP COLUMN payload;",
      ).map((f) => f.rule),
    ).toEqual(["destructive_ddl"]);
    expect(
      lintWith(
        "030_x.sql",
        "-- gm:contract-approved (lead, 2026-10-05)\nSET LOCAL lock_timeout = '5s';\nALTER TABLE jobs DROP COLUMN payload;",
      ),
    ).toEqual([]);
  });

  it("no migration names the runtime login: only scripts/grants.sql grants it, as PG_APP_USER (CFDIFIX-R2-1)", () => {
    expect(rule("runtime_role_named")).toEqual([]);
    const named = (body: string, name = "037_x.sql") =>
      lintWith(name, "SET LOCAL lock_timeout = '5s';\n" + body).filter(
        (f) => f.rule === "runtime_role_named",
      );
    // 036 as commit 0c964c7 shipped it: staging's migrate failed with 42704.
    expect(
      named(
        "GRANT UPDATE (next_self_invoice_policy, next_self_invoice_days, next_portal_reissue_global,\n  next_self_invoice_from) ON cfdi_settings TO gm_app;\n",
      ),
    ).toEqual([
      {
        file: "037_x.sql",
        rule: "runtime_role_named",
        detail:
          "gm_app: the runtime login is granted only by scripts/grants.sql (PG_APP_USER), never by a migration",
      },
    ]);
    // Any environment's login, quoted, in a DO block's EXECUTE string or a function body.
    for (const [body, role] of [
      ['GRANT SELECT ON jobs TO "gm_staging_app";', "gm_staging_app"],
      ["REVOKE UPDATE ON jobs FROM GM_PROD_APP;", "gm_prod_app"],
      [
        "DO $$ BEGIN EXECUTE format('GRANT SELECT ON %I TO gm_app', 'jobs'); END $$;",
        "gm_app",
      ],
      [
        "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN\n  -- runs as the owner\n  PERFORM pg_has_role('gm_t1a2b3_app_r20261007', 'gm_jobs_worker', 'member');\nEND $f$;",
        "gm_t1a2b3_app_r20261007",
      ],
      ["ALTER POLICY p ON jobs TO gm_x_app_next;", "gm_x_app_next"],
    ])
      expect(named(body).map((f) => f.detail.split(":")[0])).toEqual([role]);
    // Before 022 too: the rule has no start number.
    expect(
      lintMigrations([fixture("010_x.sql", "GRANT SELECT ON jobs TO gm_app;")])
        .filter((f) => f.rule === "runtime_role_named")
        .map((f) => f.file),
    ).toEqual(["010_x.sql"]);
    // Comments may name it; capability roles and look-alikes are not the runtime login.
    expect(
      named(
        "-- the runtime role (gm_app) gets its UPDATE from scripts/grants.sql\n/* never TO gm_staging_app */\nGRANT SELECT ON jobs TO gm_jobs_worker, gm_support, gm_backup_reader;\nCOMMENT ON TABLE jobs IS 'gm_application jobs';\nDO $$ BEGIN\n  -- not gm_app\n  PERFORM 1;\nEND $$;",
      ),
    ).toEqual([]);
  });

  it("the runtime login is read as a whole name where SQL names a role, through quoted names and escaped spellings; a table or column that looks like it is not the login (CFDIFIX-R3-2)", () => {
    const named = (body: string) =>
      lintWith("037_x.sql", "SET LOCAL lock_timeout = '5s';\n" + body)
        .filter((f) => f.rule === "runtime_role_named")
        .map((f) => f.detail.split(":")[0]);
    // A double-quoted name is one token: a `--` or `/*` inside it comments nothing out.
    expect(scan('GRANT SELECT ON "odd--name" TO gm_app;').code).toBe(
      'GRANT SELECT ON "odd--name" TO gm_app;',
    );
    for (const body of [
      'GRANT SELECT ON "odd--name" TO gm_app;',
      'GRANT SELECT ON "odd/*name" TO gm_app; -- */',
      'ALTER TABLE "a"")--" OWNER TO gm_app;',
    ])
      expect(named(body), body).toEqual(["gm_app"]);
    // U&"…" and U&'…' (UESCAPE included) and E'…' are read decoded.
    expect(
      scan(`U&"gm\\005fapp" U&'d!0061t!+000061' UESCAPE '!' E'it\\'s'`).code,
    ).toBe(`"gm_app" 'data' 'it''s'`);
    for (const [body, role] of [
      ['GRANT SELECT ON jobs TO U&"gm\\005fapp";', "gm_app"],
      ['GRANT SELECT ON jobs TO u&"gm_\\0061pp";', "gm_app"],
      [
        `GRANT SELECT ON jobs TO U&"gm!005fstaging!+00005fapp" UESCAPE '!';`,
        "gm_staging_app",
      ],
      [
        "DO $$ BEGIN PERFORM pg_has_role(U&'gm\\005fapp', 'gm_jobs_worker', 'member'); END $$;",
        "gm_app",
      ],
      [
        "DO $$ BEGIN EXECUTE E'GRANT SELECT ON jobs TO gm\\137app'; END $$;",
        "gm_app",
      ],
      [
        "DO $$ BEGIN EXECUTE E'GRANT SELECT ON jobs TO gm\\x5fprod\\u005fapp'; END $$;",
        "gm_prod_app",
      ],
    ] as const)
      expect(named(body), body).toEqual([role]);
    // Every place SQL names a role.
    for (const body of [
      "ALTER TABLE jobs OWNER TO gm_app;",
      "CREATE POLICY p ON jobs FOR SELECT TO gm_app USING (true);",
      "GRANT gm_app TO gm_migrator;",
      "REVOKE ADMIN OPTION FOR gm_app FROM gm_migrator;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE gm_migrator GRANT SELECT ON TABLES TO gm_app;",
      "ALTER ROLE gm_app SET statement_timeout = '10s';",
      "SET ROLE gm_app;",
      "CREATE SCHEMA s AUTHORIZATION gm_app;",
      "REASSIGN OWNED BY gm_app TO gm_migrator;",
      "DO $$ BEGIN EXECUTE format('GRANT SELECT ON %I TO %I', 'jobs', 'gm_app'); END $$;",
      "DO $$ BEGIN EXECUTE 'GRANT SELECT ON jobs TO ' || quote_ident('gm_app'); END $$;",
      "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'gm_app') THEN NULL; END IF; END $$;",
      "DO $$ BEGIN PERFORM 'gm_app'::regrole; END $$;",
      "DO $$ BEGIN PERFORM set_config('role', 'gm_app', true); END $$;",
    ])
      expect(named(body), body).toEqual(["gm_app"]);
    // A table, column or index named like it, in statements, strings and a DO loop, is not.
    expect(
      named(
        [
          "CREATE TABLE gm_app_settings (id uuid PRIMARY KEY, gm_app text);",
          "CREATE INDEX gm_app_settings_id ON gm_app_settings (id);",
          "ALTER TABLE gm_app_settings ENABLE ROW LEVEL SECURITY;",
          "ALTER TABLE gm_app_settings FORCE ROW LEVEL SECURITY;",
          "GRANT SELECT ON gm_app_settings TO gm_jobs_worker;",
          "REVOKE UPDATE (gm_app) ON gm_app_settings FROM gm_support;",
          "COMMENT ON TABLE gm_app_settings IS 'gm_app_settings';",
          "SELECT gm_app FROM gm_app_settings ORDER BY gm_app;",
          "DO $$ DECLARE t text; BEGIN\n  FOREACH t IN ARRAY ARRAY['gm_app_settings'] LOOP\n    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);\n  END LOOP;\nEND $$;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("022 creates only hot-path indexes and no CHECK constraints (wave 1 contract)", () => {
    expect(rule("ops_022_scope")).toEqual([]);
    expect(
      lintWith(
        "022_x.sql",
        "SET LOCAL lock_timeout = '5s';\nALTER TABLE jobs ADD CONSTRAINT j CHECK (attempts >= 0);",
      ).map((f) => f.rule),
    ).toEqual(["ops_022_scope", "ops_022_scope"]);
  });

  it("retention touches only the allow-listed tables and terminal rows", () => {
    expect(retentionRules.map((r) => r.table)).toEqual([
      "oauth_login_attempts",
      "jobs",
    ]);
    const jobs = retentionRules.find((r) => r.table === "jobs")!.predicate;
    expect(jobs).toMatch(/state IN \('done', 'dead'\)/);
    expect(jobs).toMatch(/interval '30 days'/);
    expect(jobs).not.toMatch(/blocked|available|queued|running/);
    const oauth = retentionRules.find(
      (r) => r.table === "oauth_login_attempts",
    )!.predicate;
    expect(oauth).toMatch(/consumed_at IS NOT NULL OR expires_at < now\(\)/);
  });
});
