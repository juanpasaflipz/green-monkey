import type { Tx } from "../server/db.js";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { password, hash } from "../server/auth.js";
export async function demoFixtures(
  sql: postgres.Sql,
  credentials: { owner: string; cashier: string; kitchen: string },
  requireEmpty = false,
) {
  await sql.begin(async (raw) => {
    const tx = raw as Tx;
    if (requireEmpty) {
      await tx`select pg_advisory_xact_lock(7102482)`;
      const [count] =
        await tx`select count(*)::int as count from organizations`;
      if (count.count) throw Error("Fixture target must be empty");
    }
    await tx`insert into organizations(id,name) values('10000000-0000-4000-8000-000000000000','Grupo demo ficticio') on conflict do nothing`;
    for (let n = 1; n <= 2; n++) {
      const tenantId = `10000000-0000-4000-8000-00000000000${n}`;
      await tx`insert into restaurants(id,organization_id,name) values(${tenantId},'10000000-0000-4000-8000-000000000000',${n === 1 ? "Casa del Bosque · Demo" : "Jardín Sur · Demo"}) on conflict do nothing`;
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      const employeeId = `20000000-0000-4000-8000-00000000000${n}`;
      for (const [idx, role, login, secret, name] of [
        [0, "owner", "owner", credentials.owner, "Alex Demo"],
        [1, "cashier", "cashier", credentials.cashier, "Dani Demo"],
        [2, "kitchen", "kitchen", credentials.kitchen, "Cocina Demo"],
      ] as const) {
        const eid =
          idx === 0
            ? employeeId
            : `20000000-0000-4000-800${idx}-00000000000${n}`;
        await tx`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${tenantId},${eid},${name},${login},${password(secret)},${role}) on conflict do nothing`;
      }
      const deviceId = `30000000-0000-4000-8000-00000000000${n}`;
      await tx`insert into devices(tenant_id,id,name,token_hash) values(${tenantId},${deviceId},'Caja demo',${hash("unpaired-demo")}) on conflict do nothing`;
      // Floor plan: "Salón" holds Mesa 01-06 and "Terraza" Mesa 07-08.
      const areas = [
        [`45000000-0000-4000-800${n}-000000000001`, "Salón"],
        [`45000000-0000-4000-800${n}-000000000002`, "Terraza"],
      ];
      for (const [k, [aid, name]] of areas.entries())
        await tx`insert into dining_areas(tenant_id,id,name,position) values(${tenantId},${aid},${name},${k + 1}) on conflict do nothing`;
      for (let i = 1; i <= 8; i++)
        await tx`insert into dining_tables(tenant_id,id,name,area_id,position) values(${tenantId},${`40000000-0000-4000-800${n}-${String(i).padStart(12, "0")}`},${"Mesa " + String(i).padStart(2, "0")},${areas[i <= 6 ? 0 : 1][0]},${i <= 6 ? i : i - 6}) on conflict do nothing`;
      const rawId = `50000000-0000-4000-8000-00000000000${n}`,
        preparedId = `50000000-0000-4000-8001-00000000000${n}`,
        quesoId = `50000000-0000-4000-8002-00000000000${n}`;
      for (const [sid, name, unit, kind, quantity] of [
        [rawId, "Maíz", "kg", "raw", "100"],
        [preparedId, "Tortilla preparada", "piece", "prepared", "1000"],
        [quesoId, "Queso Oaxaca", "kg", "raw", "5"],
      ]) {
        await tx`insert into stock_items(tenant_id,id,name,unit,kind,threshold) values(${tenantId},${sid},${name},${unit},${kind},10) on conflict do nothing`;
        await tx`insert into stock_movements(tenant_id,id,stock_id,quantity,cause,cause_id,reason,actor_id) values(${tenantId},${randomUUID()},${sid},${quantity},'opening','demo','Fictional opening balance',${employeeId}) on conflict do nothing`;
      }
      // Categories in today's alphabetical POS order (ids 8000000…-800n-…k).
      const categories = [
        ["Antojitos", "Small plates"],
        ["Bebidas", "Drinks"],
        ["Bowls", "Bowls"],
        ["Combos", "Combos"],
        ["Postres", "Desserts"],
        ["Tacos", "Tacos"],
        ["Varios", "Misc."],
      ].map(([es, en], k) => ({
        id: `80000000-0000-4000-800${n}-${String(k + 1).padStart(12, "0")}`,
        name: { es, en },
        position: k + 1,
      }));
      for (const c of categories)
        await tx`insert into menu_categories(tenant_id,id,name_es,name_en,position) values(${tenantId},${c.id},${c.name.es},${c.name.en},${c.position}) on conflict do nothing`;
      const option = (
        id: string,
        es: string,
        en: string,
        price = 0,
        extra: Record<string, unknown> = {},
      ) => ({ id, name: { es, en }, price, available: true, ...extra });
      const groupId = (k: number) =>
        `90000000-0000-4000-800${n}-${String(k).padStart(12, "0")}`;
      const choiceId = (k: number) =>
        `71000000-0000-4000-800${n}-${String(k).padStart(12, "0")}`;
      const groups = {
        // Keeps the original option-id scheme of "Taco de asada" (product 1).
        salsa: {
          id: groupId(1),
          name: { es: "Elige tu salsa", en: "Choose your salsa" },
          min: 1,
          max: 1,
          repeat: false,
          options: [
            ["Salsa verde", "Green salsa"],
            ["Salsa roja", "Red salsa"],
            ["Sin salsa", "No salsa"],
          ].map(([es, en], j) =>
            option(
              `70000000-0000-4001-800${n}-${String(j + 1).padStart(12, "0")}`,
              es,
              en,
            ),
          ),
        },
        extras: {
          id: groupId(2),
          name: { es: "Extras", en: "Extras" },
          min: 0,
          max: 2,
          repeat: false,
          options: [
            option(choiceId(1), "Queso", "Cheese", 1500, {
              cost: 400,
              recipe: [{ stockId: quesoId, quantity: "0.03" }],
            }),
            option(choiceId(2), "Aguacate", "Avocado", 2000),
          ],
        },
        comboTacos: {
          id: groupId(3),
          name: { es: "Tacos del combo", en: "Combo tacos" },
          min: 3,
          max: 3,
          repeat: true,
          options: [
            option(choiceId(3), "Taco de hongos", "Mushroom taco"),
            option(choiceId(4), "Taco de asada", "Grilled beef taco", 500),
          ],
        },
        comboDrink: {
          id: groupId(4),
          name: { es: "Bebida del combo", en: "Combo drink" },
          min: 1,
          max: 1,
          repeat: false,
          options: [
            option(choiceId(5), "Jamaica", "Hibiscus"),
            option(choiceId(6), "Limonada", "Lemonade"),
          ],
        },
      };
      for (const g of Object.values(groups)) {
        const { id: gid, ...data } = g;
        await tx`insert into modifier_groups(tenant_id,id,data) values(${tenantId},${gid},${tx.json(data)}) on conflict do nothing`;
      }
      const compiled = (...list: (typeof groups)[keyof typeof groups][]) =>
        list.map((g) => ({ ...g, version: 1 }));
      const names: [string, string, number, string][] = [
        ["Taco de hongos", "Mushroom taco", 4500, "Tacos"],
        ["Taco de asada", "Grilled beef taco", 5500, "Tacos"],
        ["Quesadilla de flor", "Squash blossom quesadilla", 6500, "Antojitos"],
        ["Bowl de la casa", "House bowl", 12500, "Bowls"],
        ["Agua de jamaica", "Hibiscus agua fresca", 3500, "Bebidas"],
        ["Limonada natural", "Fresh lemonade", 4000, "Bebidas"],
        ["Café de olla", "Spiced coffee", 3800, "Bebidas"],
        ["Flan de vainilla", "Vanilla flan", 5500, "Postres"],
        ["Guacamole", "Guacamole", 7500, "Antojitos"],
        ["Combo del bosque", "Forest combo", 11000, "Combos"],
        ["Ensalada verde", "Green salad", 9500, "Bowls"],
        ["Brownie de cacao", "Cacao brownie", 6000, "Postres"],
        ["Varios", "Misc.", 0, "Varios"],
      ];
      const position = (i: number) =>
        names
          .filter(([, , , c]) => c === names[i][3])
          .map(([es]) => es)
          .sort((a, b) => a.localeCompare(b, "es"))
          .indexOf(names[i][0]) + 1;
      for (let i = 0; i < names.length; i++) {
        const [es, en, price, catEs] = names[i];
        const category = categories.find((c) => c.name.es === catEs)!;
        const pid = `60000000-0000-4000-800${n}-${String(i + 1).padStart(12, "0")}`;
        const productGroups =
          i === 1
            ? compiled(groups.salsa, groups.extras)
            : i === 9
              ? compiled(groups.comboTacos, groups.comboDrink)
              : [];
        const open = es === "Varios";
        const data = {
          id: pid,
          name: { es, en },
          categoryId: category.id,
          category: category.name,
          categoryPosition: category.position,
          position: position(i),
          kind: i === 9 ? "combo" : "item",
          price,
          openAmount: open,
          openMax: open ? 200000 : null,
          available: true,
          archived: false,
          station: i >= 4 && i <= 6 ? "bar" : "kitchen",
          groupIds: productGroups.map((g) => g.id),
          groups: productGroups,
          cost: open ? null : Math.round(price * 0.3),
          version: 1,
          recipe: i < 3 ? [{ stockId: preparedId, quantity: "1" }] : [],
        };
        await tx`insert into catalog(tenant_id,id,data) values(${tenantId},${pid},${tx.json(data)}) on conflict do nothing`;
      }
    }
  });
}
