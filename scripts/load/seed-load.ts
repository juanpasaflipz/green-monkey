// Seeds LOAD-NN restaurants for the load test (scripts/load/run-load.ts).
//   LOAD_MIGRATION_DATABASE_URL  owner/admin connection to the target database
//   LOAD_TARGET_ALLOWLIST        exact host:port/database of that target
//   LOAD_PROFILE                 smoke | target | stress (number of tenants)
//   JWT_SECRET                   the target server's: pairing codes are HMACs under it
// Refuses databases not named *_test, *_load or *_staging and APP_ENV=production.
// Re-running refreshes credentials; fixture.json (0600, gitignored) holds them,
// plus one single-use pairing code per simulated browser (register and KDS
// screens), each valid for ACCESS.pairingCodeMinutes: run load:run within that.
import "dotenv/config";
import postgres from "postgres";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { password } from "../../server/auth.js";
import {
  generatePairingCode,
  pairingHash,
} from "../../server/access-pairing.js";
import { ACCESS } from "../../shared/access.js";
import type { Tx } from "../../server/db.js";
import {
  databaseIdentity,
  databaseTls,
  withoutParams,
} from "../../server/db-support.js";
import { profiles } from "./profile.js";

const url = process.env.LOAD_MIGRATION_DATABASE_URL;
const profile = profiles[process.env.LOAD_PROFILE ?? "smoke"];
if (!url) throw Error("LOAD_MIGRATION_DATABASE_URL required");
if (!profile) throw Error("LOAD_PROFILE must be smoke, target or stress");
if (process.env.APP_ENV === "production")
  throw Error("load seeding refused in production");
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
  throw Error("JWT_SECRET of the target server required (32+ characters)");
const identity = databaseIdentity(url);
if (process.env.LOAD_TARGET_ALLOWLIST !== identity)
  throw Error(
    "LOAD_TARGET_ALLOWLIST must equal the exact target host:port/database",
  );
if (!/_(test|load|staging)$/.test(new URL(url).pathname))
  throw Error(
    "load seeding only targets *_test, *_load or *_staging databases",
  );

const pad = (n: number, width = 12) => String(n).padStart(width, "0");
const tenantId = (n: number) => `a0000000-0000-4000-8000-${pad(n)}`;
const orgId = (n: number) => `a1000000-0000-4000-8000-${pad(n)}`;
const employeeId = (index: number, n: number) =>
  `a2000000-000${index}-4000-8000-${pad(n)}`;
const pin = () => String(randomInt(100000, 1000000));

const target = new URL(url);
const sql = postgres(withoutParams(target).href, {
  max: 1,
  ssl: databaseTls(target),
  onnotice: () => {},
});
const fixture: Record<string, unknown>[] = [];
try {
  for (let n = 1; n <= profile.tenants; n++) {
    const id = tenantId(n);
    const name = `LOAD-${String(n).padStart(2, "0")}`;
    const credentials = {
      owner: {
        employeeId: employeeId(0, n),
        login: "owner",
        secret: randomBytes(18).toString("base64url"),
      },
      cashier: {
        employeeId: employeeId(1, n),
        login: "cashier",
        secret: pin(),
      },
      kitchen: [
        { employeeId: employeeId(2, n), login: "kitchen1", secret: pin() },
        { employeeId: employeeId(3, n), login: "kitchen2", secret: pin() },
      ],
    };
    // One code per simulated browser: the register, then each KDS screen.
    const pairingCodes = Array.from(
      { length: 1 + profile.kdsScreensPerTenant },
      generatePairingCode,
    );
    const products: {
      id: string;
      price: number;
      groups: { options: string[] }[];
    }[] = [];
    const tables: string[] = [];
    await sql.begin(async (raw) => {
      const tx = raw as Tx;
      await tx`select set_config('app.tenant_id', ${id}, true)`;
      await tx`insert into organizations(id,name) values(${orgId(n)},${name}) on conflict do nothing`;
      await tx`insert into restaurants(id,organization_id,name) values(${id},${orgId(n)},${name}) on conflict do nothing`;
      const staff = [
        ["owner", credentials.owner, "Load owner"],
        ["cashier", credentials.cashier, "Load cashier"],
        ["kitchen", credentials.kitchen[0], "Load kitchen 1"],
        ["kitchen", credentials.kitchen[1], "Load kitchen 2"],
      ] as const;
      for (const [role, c, display] of staff)
        await tx`
          insert into employees(tenant_id,id,name,login,secret_hash,role)
          values(${id},${c.employeeId},${display},${c.login},${password(c.secret)},${role})
          on conflict (tenant_id,id) do update set secret_hash=excluded.secret_hash, active=true`;
      // Browsers pair with single-use codes (023_access), like a real
      // terminal; owner-password pairing is the demo tenant's only. Earlier
      // seeds' unused codes are cancelled so at most these stay open. The
      // seeding role may bypass RLS, so every statement names the tenant.
      await tx`
        update device_pairing_codes set cancelled_at=now(), cancelled_by=${credentials.owner.employeeId}
        where tenant_id=${id} and consumed_at is null and cancelled_at is null`;
      for (const [index, code] of pairingCodes.entries()) {
        const codeId = randomUUID();
        const deviceName = index === 0 ? "LOAD Caja" : `LOAD KDS ${index}`;
        await tx`
          insert into device_pairing_codes(tenant_id,id,code_hash,device_name,created_by,expires_at)
          values(${id},${codeId},${pairingHash(code)},${deviceName},${credentials.owner.employeeId},
            now()+make_interval(mins=>${ACCESS.pairingCodeMinutes}))`;
        await tx`
          insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
          values(${id},${randomUUID()},${credentials.owner.employeeId},'access.pairing_code_created',${codeId},
            ${tx.json({ id: codeId, deviceName, source: "load_seed" })})`;
      }
      await tx`
        insert into restaurant_entitlements(tenant_id,status,access_until,source)
        values(${id},'active',now()+interval '1 year','fixture')
        on conflict(tenant_id) do update set status='active', access_until=excluded.access_until, source='fixture'`;
      for (let t = 1; t <= 15; t++) {
        const table = `a3000000-${pad(t, 4)}-4000-8000-${pad(n)}`;
        tables.push(table);
        await tx`insert into dining_tables(tenant_id,id,name) values(${id},${table},${"Mesa " + String(t).padStart(2, "0")}) on conflict do nothing`;
      }
      for (let p = 1; p <= 40; p++) {
        const pid = `a4000000-${pad(p, 4)}-4000-8000-${pad(n)}`;
        const required = p <= 6;
        const options = required
          ? [1, 2, 3].map((o) => ({
              id: `a5000000-${pad(p, 4)}-400${o}-8000-${pad(n)}`,
              name: { es: `Opción ${o}`, en: `Option ${o}` },
              price: o === 3 ? 500 : 0,
              available: true,
            }))
          : [];
        const price = 3000 + ((p * 731) % 12000);
        const data = {
          id: pid,
          name: { es: `Producto ${p}`, en: `Product ${p}` },
          category: {
            es: `Categoría ${1 + (p % 6)}`,
            en: `Category ${1 + (p % 6)}`,
          },
          price,
          available: true,
          station: p % 4 === 0 ? "bar" : "kitchen",
          groups: required
            ? [
                {
                  id: randomUUID(),
                  name: { es: "Elige", en: "Choose" },
                  min: 1,
                  max: 1,
                  options,
                },
              ]
            : [],
          cost: Math.round(price * 0.3),
          version: 1,
          recipe: [],
        };
        await tx`insert into catalog(tenant_id,id,data) values(${id},${pid},${tx.json(data)}) on conflict (tenant_id,id) do update set data=excluded.data`;
        products.push({
          id: pid,
          price,
          groups: required ? [{ options: options.map((o) => o.id) }] : [],
        });
      }
    });
    fixture.push({
      tenantId: id,
      name,
      ...credentials,
      pairingCodes,
      products,
      tables,
    });
  }
  mkdirSync("work/load", { recursive: true, mode: 0o700 });
  writeFileSync(
    "work/load/fixture.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        target: identity,
        tenants: fixture,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      message: "load_seeded",
      profile: profile.name,
      tenants: fixture.length,
      target: identity,
    }),
  );
} finally {
  await sql.end();
}
