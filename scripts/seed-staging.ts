import "dotenv/config";
import postgres from "postgres";
import { demoFixtures } from "./demo-fixtures.js";
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw Error("Explicit migration URL required");
const target = new URL(url);
const identity =
  target.hostname + ":" + (target.port || "5432") + target.pathname;
if (
  process.env.FIXTURE_TARGET_ALLOWLIST !== identity ||
  !/^\/green_monkey_(staging|test)$/.test(target.pathname)
)
  throw Error(
    "Only explicitly allowlisted staging/test fixture targets are accepted",
  );
const owner = process.env.FIXTURE_OWNER_PASSWORD;
const cashier = process.env.FIXTURE_CASHIER_PIN;
const kitchen = process.env.FIXTURE_KITCHEN_PIN;
if (
  !owner ||
  owner.length < 24 ||
  !cashier ||
  !kitchen ||
  !/^\d{6}$/.test(cashier) ||
  !/^\d{6}$/.test(kitchen) ||
  cashier === kitchen
)
  throw Error(
    "Generated owner password and distinct six-digit staff PINs required",
  );
const sql = postgres(url, { max: 1 });
try {
  await demoFixtures(sql, { owner, cashier, kitchen }, true);
  console.log(
    "Fictional fixtures installed on an empty isolated target; credentials are not logged",
  );
} finally {
  await sql.end();
}
