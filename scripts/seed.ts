import "dotenv/config";
import postgres from "postgres";
import { demoFixtures } from "./demo-fixtures.js";
const url = process.env.MIGRATION_DATABASE_URL;
if (!url || process.env.ALLOW_DEMO_SEED !== "green-monkey-local")
  throw Error("Explicit isolated demo seed authorization required");
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("Demo seed only supports localhost");
const sql = postgres(url, { max: 1 });
try {
  await demoFixtures(sql, {
    owner: "demo-green-monkey",
    cashier: "123456",
    kitchen: "654321",
  });
  await sql`insert into restaurant_entitlements(tenant_id,status,access_until,source)
    select id,'active',now()+interval '14 days','fixture' from restaurants
    on conflict(tenant_id) do nothing`;
  console.log(
    "Fictional demo seed ready. Owner: owner / demo-green-monkey; cashier PIN: 123456; kitchen PIN: 654321.",
  );
} finally {
  await sql.end();
}
