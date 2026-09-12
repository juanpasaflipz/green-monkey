import type { Tx } from "../server/db.js";
import "dotenv/config";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { password, hash } from "../server/auth.js";
const url = process.env.MIGRATION_DATABASE_URL;
if (!url || process.env.ALLOW_DEMO_SEED !== "green-monkey-local")
  throw Error("Explicit isolated demo seed authorization required");
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("Demo seed only supports localhost");
const sql = postgres(url, { max: 1 });
export const tenantA = "10000000-0000-4000-8000-000000000001";
try {
  await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`insert into organizations(id,name) values('10000000-0000-4000-8000-000000000000','Grupo demo ficticio') on conflict do nothing`;
    for (let n = 1; n <= 2; n++) {
      const tenantId = `10000000-0000-4000-8000-00000000000${n}`;
      await tx`insert into restaurants(id,organization_id,name) values(${tenantId},'10000000-0000-4000-8000-000000000000',${n === 1 ? "Casa del Bosque · Demo" : "Jardín Sur · Demo"}) on conflict do nothing`;
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      const employeeId = `20000000-0000-4000-8000-00000000000${n}`;
      for (const [idx, role, login, secret, name] of [
        [0, "owner", "owner", "demo-green-monkey", "Alex Demo"],
        [1, "cashier", "cashier", "123456", "Dani Demo"],
        [2, "kitchen", "kitchen", "654321", "Cocina Demo"],
      ] as const) {
        const eid =
          idx === 0
            ? employeeId
            : `20000000-0000-4000-800${idx}-00000000000${n}`;
        await tx`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${tenantId},${eid},${name},${login},${password(secret)},${role}) on conflict do nothing`;
      }
      const deviceId = `30000000-0000-4000-8000-00000000000${n}`;
      await tx`insert into devices(tenant_id,id,name,token_hash) values(${tenantId},${deviceId},'Caja demo',${hash("unpaired-demo")}) on conflict do nothing`;
      for (let i = 1; i <= 8; i++)
        await tx`insert into dining_tables(tenant_id,id,name) values(${tenantId},${`40000000-0000-4000-800${n}-${String(i).padStart(12, "0")}`},${"Mesa " + String(i).padStart(2, "0")}) on conflict do nothing`;
      const rawId = `50000000-0000-4000-8000-00000000000${n}`,
        preparedId = `50000000-0000-4000-8001-00000000000${n}`;
      for (const [sid, name, unit, kind, quantity] of [
        [rawId, "Maíz", "kg", "raw", "100"],
        [preparedId, "Tortilla preparada", "piece", "prepared", "1000"],
      ]) {
        await tx`insert into stock_items(tenant_id,id,name,unit,kind,threshold) values(${tenantId},${sid},${name},${unit},${kind},10) on conflict do nothing`;
        await tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id) values(${tenantId},${randomUUID()},${sid},${quantity},'opening','demo','Fictional opening balance',${employeeId}) on conflict do nothing`;
      }
      const names = [
        ["Taco de hongos", "Mushroom taco", 4500, "Tacos", "Tacos"],
        ["Taco de asada", "Grilled beef taco", 5500, "Tacos", "Tacos"],
        [
          "Quesadilla de flor",
          "Squash blossom quesadilla",
          6500,
          "Antojitos",
          "Small plates",
        ],
        ["Bowl de la casa", "House bowl", 12500, "Bowls", "Bowls"],
        ["Agua de jamaica", "Hibiscus agua fresca", 3500, "Bebidas", "Drinks"],
        ["Limonada natural", "Fresh lemonade", 4000, "Bebidas", "Drinks"],
        ["Café de olla", "Spiced coffee", 3800, "Bebidas", "Drinks"],
        ["Flan de vainilla", "Vanilla flan", 5500, "Postres", "Desserts"],
        ["Guacamole", "Guacamole", 7500, "Antojitos", "Small plates"],
        ["Combo del bosque", "Forest combo", 11000, "Combos", "Combos"],
        ["Ensalada verde", "Green salad", 9500, "Bowls", "Bowls"],
        ["Brownie de cacao", "Cacao brownie", 6000, "Postres", "Desserts"],
      ];
      for (let i = 0; i < names.length; i++) {
        const [es, en, price, catEs, catEn] = names[i];
        const pid = `60000000-0000-4000-800${n}-${String(i + 1).padStart(12, "0")}`;
        const opts = [
          ["Salsa verde", "Green salsa", 0],
          ["Salsa roja", "Red salsa", 0],
          ["Sin salsa", "No salsa", 0],
        ].map(([es, en, price], j) => ({
          id: `70000000-0000-400${i}-800${n}-${String(j + 1).padStart(12, "0")}`,
          name: { es, en },
          price,
          available: true,
        }));
        const data = {
          id: pid,
          name: { es, en },
          category: { es: catEs, en: catEn },
          price,
          available: true,
          station: i >= 4 && i <= 6 ? "bar" : "kitchen",
          groups:
            i === 1
              ? [
                  {
                    id: randomUUID(),
                    name: { es: "Elige tu salsa", en: "Choose your salsa" },
                    min: 1,
                    max: 1,
                    options: opts,
                  },
                ]
              : [],
          cost: Math.round(Number(price) * 0.3),
          version: 1,
          recipe: i < 3 ? [{ stockId: preparedId, quantity: "1" }] : [],
        };
        await tx`insert into catalog(tenant_id,id,data) values(${tenantId},${pid},${tx.json(data)}) on conflict do nothing`;
      }
    }
  });
  console.log(
    "Fictional demo seed ready. Owner: owner / demo-green-monkey; cashier PIN: 123456; kitchen PIN: 654321.",
  );
} finally {
  await sql.end();
}
