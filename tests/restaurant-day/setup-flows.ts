/**
 * Restaurant setup through the UI (specs/acceptance.md A1-A9, B1-B5, and
 * branch L's L1-L2): owner signup with legal acceptance, support grant, fiscal
 * profile, staff, money controls, menu, devices and sign-in. No UUID is typed
 * and no demo data used.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { expect, type Locator, type Page } from "@playwright/test";
import { connect } from "../../server/db.js";
import { signInGoogleOwner } from "../../server/owner-accounts.js";
import { supportDatabaseUrl, type RunState } from "./env.js";
import {
  RESTAURANT_A,
  RESTAURANT_B,
  RESTAURANT_L,
  URL_NAMESPACE,
} from "./scenario.js";
import {
  allowing,
  checkpoint,
  escapeRe,
  logLine,
  readApi,
  run,
  typePin,
  type Device,
  type Devices,
} from "./ui.js";
import { activateCfdi } from "./cfdi-k.js";

type Restaurant =
  | typeof RESTAURANT_A
  | typeof RESTAURANT_B
  | typeof RESTAURANT_L;

/** RFC 4122 UUIDv5 (§3.7: Google subjects). */
export function uuidv5(name: string, namespace = URL_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name, "utf8")]))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** F1: the documented substitute for Google's external flow (owner.spec pattern). */
async function googleOwner(owner: Device, r: Restaurant, baseUrl: string) {
  const sql = connect(process.env.RD_RUNTIME_DATABASE_URL!);
  try {
    const cookie = await signInGoogleOwner(sql, {
      issuer: "https://accounts.google.com",
      subject: uuidv5(r.owner.subjectSeed),
      email: r.owner.email,
      name: r.owner.name,
    });
    await owner.context.addCookies([
      {
        name: "gm_account",
        value: cookie,
        url: new URL(baseUrl).origin,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ]);
  } finally {
    await sql.end();
  }
}

/** A1.2-A1.5 / B1.1: restaurant signup with legal acceptance through the UI. */
async function signup(
  owner: Device,
  r: Restaurant,
  cutoff: string,
  checkpointId?: string,
) {
  const page = owner.page;
  await page.goto("/app");
  const name = label(page, "Nombre del restaurante");
  await expect(name).toBeVisible();
  await expect(page.locator("#signup-privacy-notice")).toHaveCount(0);
  await name.fill(r.name);
  await page.getByText("Moneda y horario", { exact: true }).click();
  await expect(label(page, "Moneda")).toHaveValue("MXN");
  await label(page, "Zona horaria").fill(r.timezone);
  await label(page, "Inicio del día operativo").fill(cutoff);
  for (const day of [
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado",
    "Domingo",
  ])
    await expect(
      page.getByRole("checkbox", { name: day, exact: true }),
    ).toBeChecked();
  if (checkpointId) await checkpoint(owner, checkpointId);
  const create = page.getByRole("button", {
    name: "Crear restaurante gratis",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "Acepto los Términos del servicio y el Contrato de encargo de datos de mi restaurante.",
      exact: true,
    })
    .check();
  await expect(create).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Leí el Aviso de privacidad.", exact: true })
    .check();
  // Built after the spec's A1.4 (account 031, LD-32 UX-3): the express billing
  // consent is its own required box (docs/ACCEPTANCE_STATUS.md, restaurant-day).
  await expect(create).toBeDisabled();
  const consent = page.getByRole("checkbox", {
    name: /^Consiento expresamente/,
  });
  await consent.check();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator(".scope")).toContainText(r.name);
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toHaveCount(1);
}

/** A2 / B1.3: the tenant id is read from Ayuda y soporte, as support would get it. */
async function readTenantId(owner: Device, checkpointId?: string) {
  const page = owner.page;
  await page.getByRole("button", { name: "Ayuda", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Ayuda y soporte" });
  await expect(help).toBeVisible();
  for (const label of ["Correo", "Teléfono", "Horario"])
    await expect(help.getByText(new RegExp(`^${label}:`))).toBeVisible();
  for (const doc of [
    "Aviso de privacidad",
    "Términos del servicio",
    "Contrato de encargo de datos",
  ])
    await expect(help.getByRole("link", { name: doc })).toBeVisible();
  await expect(
    help.getByText("ID del dispositivo", { exact: true }),
  ).toBeVisible();
  await expect(help.getByText(/^Versión de la app: /)).toBeVisible();
  if (checkpointId) await checkpoint(owner, checkpointId);
  const id = (
    await help
      .locator("dt", { hasText: "ID del restaurante" })
      .locator("+ dd code")
      .innerText()
  ).trim();
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  await help.getByRole("button", { name: "Copiar", exact: true }).click();
  await expect(help.getByText("Copiado", { exact: true })).toBeVisible();
  await help.getByRole("button", { name: "Cerrar", exact: true }).click();
  return id;
}

/** F2: the vendor support CLI grants Pro (account §4.9), confirmed with the restaurant name. */
async function grantPro(
  tenantId: string,
  r: Restaurant,
  businessDate: string,
  runId: string,
) {
  const until = new Date(`${businessDate}T12:00:00Z`);
  until.setUTCDate(until.getUTCDate() + 60);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/support.ts",
      "grant-entitlement",
      "--tenant",
      tenantId,
      "--until",
      until.toISOString().slice(0, 10),
      "--operator",
      "Puerta de aceptación",
      "--ticket",
      `RD-${runId}`,
      "--reason",
      "Piloto: acceso Pro para validación de un día completo de operación",
    ],
    {
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME ?? "",
        SUPPORT_DATABASE_URL: supportDatabaseUrl(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "",
    answered = false;
  child.stderr.on("data", (b) => (stderr += b));
  child.stdout.on("data", (b) => {
    stdout += b;
    // The operator answers the prompt with the exact restaurant name.
    if (!answered && stdout.includes("para confirmar:")) {
      answered = true;
      child.stdin.end(r.name + "\n");
    }
  });
  const code = await new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  logLine(
    "support-cli.log",
    `$ support grant-entitlement (${r.name})\n${stdout}${stderr}`,
  );
  expect(code, stderr).toBe(0);
  expect(stdout).toContain(r.name);
}

async function openSettings(page: Page) {
  await page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Configuración" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configuración", level: 1 }),
  ).toBeVisible();
}

const money = (centavos: number) => (centavos / 100).toFixed(2);
/**
 * A form control by the start of its label. The app wraps controls in their
 * <label>, so a select's or a filled input's accessible name also carries its
 * value ("Moneda MXN"); anchoring at the start keeps the match unambiguous.
 */
export function label(scope: Page | Locator, text: string) {
  // "(?! en inglés)": the optional English twin of a name field.
  return scope.getByLabel(new RegExp("^" + escapeRe(text) + "(?! en inglés)"));
}
const quantity = (q: number) => String(q);

/** Menú e inventario sub-navigation (the rail and the operations tabs also say "Mesas"). */
async function menuNav(
  page: Page,
  item: "Menú" | "Insumos" | "Existencias" | "Mesas",
) {
  await page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Menú e inventario" })
    .click();
  await page
    .getByRole("navigation", { name: "Menú e inventario" })
    .getByRole("button", { name: item, exact: true })
    .click();
}

/** A3 / B1.5: Configuración → Datos fiscales. */
async function fiscalProfile(
  owner: Device,
  r: Restaurant,
  checkpointId: string,
) {
  const page = owner.page;
  await openSettings(page);
  const panel = page.getByRole("region", { name: "Datos fiscales" });
  await expect(panel.getByText("Incompleto", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(
      "Se imprimen en cada ticket. Escríbelos exactamente como aparecen en tu Constancia de Situación Fiscal.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    panel.getByText("Aún no se han emitido tickets.", { exact: true }),
  ).toBeVisible();
  const f = r.fiscal;
  const save = panel.getByRole("button", {
    name: "Guardar datos fiscales",
    exact: true,
  });
  if (r === RESTAURANT_A) {
    // A3.2 negative: generic RFC and a 4-digit postal code are refused inline.
    await label(panel, "RFC").fill("XAXX010101000");
    await label(panel, "Código postal del lugar de expedición").fill("0670");
    await save.click();
    await expect(
      panel.getByRole("alert").filter({
        hasText:
          "No uses un RFC genérico (XAXX010101000 o XEXX010101000) como RFC del restaurante.",
      }),
    ).toBeVisible();
    await expect(
      panel
        .getByRole("alert")
        .filter({ hasText: "El código postal debe tener 5 dígitos." }),
    ).toBeVisible();
    await expect(panel.getByText("Incompleto", { exact: true })).toBeVisible();
  }
  await label(panel, "RFC").fill(f.rfc);
  await label(panel, "Nombre o razón social").fill(f.legalName);
  const regime = label(panel, "Régimen fiscal");
  const offered = (await regime.locator("option").allInnerTexts())
    .map((o) => o.slice(0, 3))
    .filter((c) => /^\d{3}$/.test(c));
  // A and L are personas morales; B is a persona física.
  if (r !== RESTAURANT_B) {
    expect(offered).toEqual(
      expect.arrayContaining(["601", "603", "620", "622", "623", "624", "626"]),
    );
    expect(offered).not.toContain("612");
  } else expect(offered.sort()).toEqual(["612", "621", "625", "626"]);
  await regime.selectOption({ label: f.regimeLabel });
  await label(panel, "Código postal del lugar de expedición").fill(f.zip);
  await label(panel, "Calle y número").fill(f.street);
  await label(panel, "Colonia").fill(f.neighborhood);
  await label(panel, "Municipio o alcaldía").fill(f.municipality);
  await label(panel, "Estado").fill(f.state);
  await label(panel, "Serie de tickets (opcional)").fill(f.series);
  await expect(panel.getByText(/dígito verificador no coincide/)).toHaveCount(
    0,
  );
  const tax = label(panel, "Impuesto predeterminado de los productos");
  // A and L: the rest of the country (IVA 16%); B: the border region.
  if (r !== RESTAURANT_B) {
    await expect(
      panel.getByRole("radio", { name: "Resto del país (IVA 16%)" }),
    ).toBeChecked();
    await expect(tax).toHaveValue("iva16");
  } else {
    await panel
      .getByRole("radio", { name: "Región fronteriza norte (estímulo IVA 8%)" })
      .check();
    await save.click();
    await expect(
      panel
        .getByRole("alert")
        .filter({
          hasText:
            "Confirma que la sucursal está en la región fronteriza y en el padrón del estímulo.",
        }),
    ).toBeVisible();
    await panel
      .getByRole("checkbox", {
        name: "Confirmo que esta sucursal está en la región fronteriza y que está inscrita en el padrón de beneficiarios del estímulo.",
      })
      .check();
    await expect(
      panel.getByText(
        "El estímulo publicado en el DOF está vigente hasta el 31/12/2026. Confirma su vigencia con tu contador.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await tax.selectOption({ label: "IVA 8% (región fronteriza)" });
  }
  await save.click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Datos fiscales guardados" }),
  ).toBeVisible();
  await expect(panel.getByText("Completo", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(
      "Los precios del menú son finales e incluyen IVA. El IVA se calcula a partir del precio.",
      { exact: true },
    ),
  ).toBeVisible();
  await checkpoint(owner, checkpointId, { settle: panel });
}

/** A4 / B2.1: Equipo. The owner's own PIN first, then the employees. */
async function staff(owner: Device, r: Restaurant, checkpointId?: string) {
  const page = owner.page;
  await page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Equipo" })
    .click();
  const team = page.getByRole("region", { name: "Equipo" });
  const own = r.staff[0]!;
  await team.getByRole("button", { name: `Editar ${own.name}` }).click();
  const edit = page.getByRole("dialog", { name: `Editar a ${own.name}` });
  const pinForm = edit.getByRole("form", {
    name: "Mi PIN para terminales compartidas",
  });
  await label(pinForm, "PIN nuevo (6 a 8 dígitos)").fill(own.pin);
  await label(pinForm, "Confirma el PIN").fill(own.pin);
  await pinForm
    .getByRole("button", { name: "Guardar PIN", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: /^PIN actualizado\./ }),
  ).toBeVisible();
  if (await edit.isVisible())
    await edit.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(
    team.getByRole("row", { name: new RegExp(`^${own.name}`) }),
  ).toContainText("Google y PIN");
  for (const [i, person] of r.staff.slice(1).entries()) {
    await team
      .getByRole("button", { name: "Agregar empleado", exact: true })
      .click();
    const add = page.getByRole("dialog", { name: "Agregar empleado" });
    if (r === RESTAURANT_A && i === 1) {
      // A4.3 negatives: a short PIN, then a mismatched confirmation.
      await label(add, "Nombre").fill(person.name);
      await label(add, "PIN nuevo (6 a 8 dígitos)").fill("1234");
      await label(add, "Confirma el PIN").fill("1234");
      await add.getByRole("button", { name: /^Guardar/ }).click();
      await expect(
        add
          .getByRole("alert")
          .filter({ hasText: "El PIN debe tener de 6 a 8 dígitos." }),
      ).toBeVisible();
      if (checkpointId) await checkpoint(owner, checkpointId, { settle: add });
      await label(add, "PIN nuevo (6 a 8 dígitos)").fill(person.pin);
      await label(add, "Confirma el PIN").fill(
        person.pin.split("").reverse().join(""),
      );
      await add.getByRole("button", { name: /^Guardar/ }).click();
      await expect(
        add.getByRole("alert").filter({ hasText: "Los PIN no coinciden." }),
      ).toBeVisible();
    }
    await label(add, "Nombre").fill(person.name);
    await label(add, "Rol").selectOption({ label: person.roleLabel });
    await label(add, "PIN nuevo (6 a 8 dígitos)").fill(person.pin);
    await label(add, "Confirma el PIN").fill(person.pin);
    await add.getByRole("button", { name: /^Guardar/ }).click();
    await expect(add).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: `${person.name} se agregó.` }),
    ).toBeVisible();
  }
  const rows = team.locator("tbody tr");
  await expect(rows).toHaveCount(r.staff.length);
  for (const person of r.staff) {
    const row = team.getByRole("row", { name: new RegExp(`^${person.name}`) });
    await expect(row).toContainText("Activo");
    await expect(row).toContainText(person.roleLabel);
    // "PIN", then the built muted line "PIN del {date}" (StaffManagement).
    if (person.role !== "owner")
      await expect(row.getByRole("cell").nth(5)).toHaveText(/^PIN(PIN del |$)/);
  }
  await expect(team.getByRole("columnheader", { name: "Permiso" })).toHaveCount(
    0,
  );
}

/** A4.5 / B2.2: money controls defaults, then cashiers may close a drawer. */
async function moneyControls(owner: Device) {
  const page = owner.page;
  await openSettings(page);
  const panel = page.getByRole("region", {
    name: "Descuentos y corte de caja",
  });
  const limits = panel.getByRole("group", {
    name: "Descuentos sin autorización de gerente",
  });
  await expect(limits).toContainText(
    "Por cuenta: se suman los descuentos que el personal aplica sin autorización en la misma cuenta.",
  );
  for (const role of ["Cajero", "Mesero"]) {
    await expect(
      panel.getByLabel(`${role} · Hasta (% por cuenta)`),
    ).toHaveValue("0");
    await expect(
      panel.getByLabel(`${role} · Y hasta (importe por cuenta)`),
    ).toHaveValue("0.00");
  }
  await expect(
    panel.getByRole("checkbox", {
      name: "Corte ciego: el conteo se captura sin ver el efectivo esperado",
    }),
  ).toBeChecked();
  const expected = panel.getByRole("group", {
    name: "Pueden ver el efectivo esperado durante el turno",
  });
  await expect(
    expected.getByRole("checkbox", { name: "Gerente" }),
  ).toBeChecked();
  await expect(
    expected.getByRole("checkbox", { name: "Cajero" }),
  ).not.toBeChecked();
  await expect(
    expected.getByRole("checkbox", { name: "Mesero" }),
  ).not.toBeChecked();
  const close = panel.getByRole("group", {
    name: "Pueden cerrar caja (además de gerentes)",
  });
  await expect(
    close.getByRole("checkbox", { name: "Cajero" }),
  ).not.toBeChecked();
  await expect(
    close.getByRole("checkbox", { name: "Mesero" }),
  ).not.toBeChecked();
  await close.getByRole("checkbox", { name: "Cajero" }).check();
  await panel
    .getByRole("button", { name: "Guardar controles", exact: true })
    .click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Controles guardados" }),
  ).toBeVisible();
}

/** A5 / B4: Insumos → "Nuevo insumo". */
async function stockItems(owner: Device, r: Restaurant, checkpointId?: string) {
  const page = owner.page;
  await menuNav(page, "Insumos");
  await expect(
    page.getByRole("radio", {
      name: /^Permitir la venta y marcar la diferencia \(recomendado\)/,
    }),
  ).toBeChecked();
  for (const [i, s] of r.stock.entries()) {
    await page
      .getByRole("button", { name: "Nuevo insumo", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Nuevo insumo" });
    await label(dialog, "Nombre del insumo *").fill(s.name);
    await label(dialog, "Unidad de inventario").selectOption({
      label: s.unitLabel,
    });
    await label(dialog, "Tipo de insumo").selectOption({ label: s.kind });
    await label(dialog, "Punto de reorden").fill(quantity(s.reorder));
    await label(dialog, "Nivel par (existencia objetivo)").fill(
      quantity(s.par),
    );
    await label(dialog, "Existencia inicial").fill(quantity(s.opening));
    if (checkpointId && i === 0)
      await checkpoint(owner, checkpointId, { settle: dialog });
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const row = page.getByRole("row", {
      name: new RegExp(`^${s.name.replace(/[()]/g, "\\$&")}`),
    });
    await expect(row.getByRole("cell").nth(2)).toHaveText(
      new Intl.NumberFormat("es-MX").format(s.opening),
    );
  }
  if (r === RESTAURANT_A)
    await expect(page.getByRole("row", { name: /^Suadero/ })).not.toContainText(
      "Negativo",
    );
}

type RecipeEntry = {
  stock: string;
  qty: number;
  typed: { value: string; unit: string };
};
/** The recipe editor names units by symbol, except pieces (RecipeEditor unitLabel). */
const RECIPE_UNIT: Record<string, string> = {
  g: "g",
  kg: "kg",
  l: "l",
  ml: "ml",
  pieza: "piezas",
};
async function fillRecipe(
  scope: Locator,
  r: Restaurant,
  recipe: RecipeEntry[],
) {
  for (const [i, e] of recipe.entries()) {
    const n = i + 1;
    const s = r.stock.find((x) => x.id === e.stock)!;
    const unit = RECIPE_UNIT[s.unit]!;
    await scope
      .getByRole("button", { name: "Agregar insumo", exact: true })
      .click();
    await label(scope, `Insumo ${n}`).selectOption({
      label: `${s.name} (${unit})`,
    });
    // A unit with no sibling (piezas) has a single, disabled choice.
    const entry = label(scope, `Unidad ${n}`);
    if (await entry.isEnabled())
      await entry.selectOption({ label: RECIPE_UNIT[e.typed.unit]! });
    else
      await expect(entry.locator("option:checked")).toHaveText(
        RECIPE_UNIT[e.typed.unit]!,
      );
    await label(scope, `Cantidad ${n}`).fill(e.typed.value);
    await expect(
      scope.getByText(
        `= ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(e.qty)} ${unit}`,
        {
          exact: true,
        },
      ),
    ).toBeVisible();
  }
}

/** A6 / B4: Menú → Modificadores. */
async function modifierGroups(
  owner: Device,
  r: Restaurant,
  checkpointId?: string,
) {
  const page = owner.page;
  await menuNav(page, "Menú");
  await page.getByRole("tab", { name: "Modificadores" }).click();
  for (const g of r.groups) {
    await page
      .getByRole("button", {
        name: "Nuevo grupo de modificadores",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Nuevo grupo de modificadores",
    });
    if (g.template)
      await label(dialog, "Plantillas").selectOption({ label: g.template });
    await label(dialog, "Nombre del grupo").fill(g.name);
    await label(dialog, "Mínimo a elegir").fill(String(g.min));
    await label(dialog, "Máximo a elegir").fill(String(g.max));
    if (g.repeat)
      await dialog
        .getByRole("checkbox", {
          name: "Permitir repetir una opción (ej. 2 de asada)",
        })
        .check();
    for (const [i, o] of g.options.entries()) {
      const n = i + 1;
      if (!(await label(dialog, `Opción ${n}`).count()))
        await dialog
          .getByRole("button", { name: "Agregar opción", exact: true })
          .click();
      await label(dialog, `Opción ${n}`).fill(o.name);
      await label(dialog, `Precio extra ${n}`).fill(money(o.price));
      await label(dialog, `Costo extra ${n}`).fill(o.cost ? money(o.cost) : "");
      if (o.recipe.length) {
        const recipe = dialog
          .locator(".menu-option-row")
          .nth(i)
          .locator("details.menu-option-recipe");
        await recipe.locator("summary").click();
        await fillRecipe(recipe, r, o.recipe);
      }
    }
    await expect(
      dialog.getByText(`Regla: ${g.ruleText}`, { exact: true }),
    ).toBeVisible();
    if (checkpointId && g.id === "G5")
      await checkpoint(owner, checkpointId, { settle: dialog });
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const card = page
      .locator(".menu-group-card")
      .filter({
        has: page.getByRole("heading", { name: g.name, exact: true }),
      });
    await expect(card.locator(".menu-rule")).toHaveText(g.ruleText);
    await expect(
      card.getByText("Se usa en 0 productos", { exact: true }),
    ).toBeVisible();
  }
}

/** A7 / B4: categories in order, then products. */
async function categoriesAndProducts(
  owner: Device,
  r: Restaurant,
  checkpointId?: string,
) {
  const page = owner.page;
  await page.getByRole("tab", { name: "Categorías" }).click();
  for (const c of r.categories) {
    await page
      .getByRole("button", { name: "Nueva categoría", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Nueva categoría" });
    await label(dialog, "Nombre de la categoría").fill(c);
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Cambios guardados" }),
    ).toBeVisible();
  }
  await page.getByRole("tab", { name: "Productos" }).click();
  for (const p of r.products) {
    await page
      .getByRole("button", { name: "Nuevo producto", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Nuevo producto" });
    await label(dialog, "Nombre en español *").fill(p.name);
    await label(dialog, "Categoría *").selectOption({ label: p.category });
    await label(dialog, "Se prepara en").selectOption({ label: p.station });
    if (p.kind === "combo")
      await dialog.getByRole("radio", { name: "Combo", exact: true }).check();
    if (p.price === null) {
      await dialog
        .getByRole("checkbox", {
          name: /^Precio abierto \(se captura al vender\)/,
        })
        .check();
      await label(dialog, "Importe máximo permitido *").fill(money(p.openMax!));
    } else
      await label(dialog, "Precio al cliente (con IVA) *").fill(money(p.price));
    const groups = p.kind === "combo" && r === RESTAURANT_A ? ["G2"] : p.groups;
    for (const gid of groups) {
      const g = r.groups.find((x) => x.id === gid)!;
      await label(dialog, "Agregar grupo").selectOption({
        label: `${g.name} · ${g.ruleText}`,
      });
    }
    if (p.recipe.length)
      await fillRecipe(
        dialog.locator("fieldset", {
          hasText: "Receta (descuenta inventario)",
        }),
        r,
        p.recipe,
      );
    if (p.cost !== null)
      await label(dialog, "Costo estimado por unidad").fill(money(p.cost));
    if (p.tax === "iva0")
      await label(dialog, "Impuesto").selectOption({ label: "IVA 0%" });
    else await expect(label(dialog, "Impuesto")).toHaveValue("default");
    if (r === RESTAURANT_B && p.tax !== "iva0") {
      // B4.1: the border restaurant's default is IVA 8%, which is selectable here.
      await expect(
        label(dialog, "Impuesto").locator("option:checked"),
      ).toHaveText(
        "Predeterminado del restaurante (IVA 8% (región fronteriza))",
      );
      await expect(
        label(dialog, "Impuesto")
          .locator("option", { hasText: "IVA 8% (región fronteriza)" })
          .last(),
      ).not.toHaveAttribute("disabled", "");
    }
    if (p.kind === "combo" && r === RESTAURANT_A) {
      // A7.c3 (FIT-4): a combo needs a required group.
      await dialog
        .getByRole("button", { name: "Guardar", exact: true })
        .click();
      await expect(
        dialog
          .getByRole("alert")
          .filter({
            hasText: "Un combo necesita al menos un grupo obligatorio.",
          }),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Quitar grupo Extras" }).click();
      for (const gid of p.groups) {
        const g = r.groups.find((x) => x.id === gid)!;
        await label(dialog, "Agregar grupo").selectOption({
          label: `${g.name} · ${g.ruleText}`,
        });
      }
    }
    if (checkpointId && p.id === "TP")
      await checkpoint(owner, checkpointId, { settle: dialog });
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Cambios guardados" }),
    ).toBeVisible();
  }
}

/** A8.1 / B5.1: a pairing code from Dispositivos on the owner's device. */
async function pairingCode(
  owner: Device,
  deviceName: string,
  checkpointId?: string,
) {
  const page = owner.page;
  await openSettings(page);
  const devices = page.getByRole("region", { name: "Dispositivos" });
  await devices
    .getByRole("button", { name: "Vincular un dispositivo", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Vincular un dispositivo" });
  await label(dialog, "Nombre del dispositivo").fill(deviceName);
  await dialog
    .getByRole("button", { name: "Generar código", exact: true })
    .click();
  const code = (await dialog.locator(".pairing-code-value").innerText()).trim();
  expect(code).toMatch(/^[0-9A-HJ-KMNP-TV-Z]{4}-[0-9A-HJ-KMNP-TV-Z]{4}$/);
  await expect(dialog.getByRole("timer")).toHaveText(/^Vence en 9:5\d$/);
  if (checkpointId) await checkpoint(owner, checkpointId, { settle: dialog });
  return { code, dialog };
}

/** A8.2 / B5.1: the terminal types the code (lower case, a space for the hyphen). */
async function pair(
  terminal: Device,
  code: string,
  restaurant: string,
  deviceName: string,
  checkpointId?: string,
) {
  const page = terminal.page;
  await page.goto("/app");
  await expect(page.getByLabel("Código de vinculación")).toBeVisible();
  if (checkpointId) await checkpoint(terminal, checkpointId);
  await page
    .getByLabel("Código de vinculación")
    .fill(code.toLowerCase().replace("-", " "));
  await page.getByRole("button", { name: "Vincular", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Dispositivo vinculado a ${restaurant}.` }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "¿Quién entra?" }),
  ).toBeVisible();
  await expect(
    page.getByText(`Dispositivo: ${deviceName}`, { exact: true }),
  ).toBeVisible();
}

/** Roster sign-in with the keypad (A8.5). */
export async function signIn(terminal: Device, name: string, pin: string) {
  const page = terminal.page;
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await typePin(terminal, page, name, pin);
  run.lastAuthAt[`${name}@${terminal.name}`] = Date.now();
}

/** A2.4: the plan and the account console show the support grant (GAP-5). */
async function proGranted(owner: Device, runId: string, businessDate: string) {
  const page = owner.page;
  await page.reload();
  await openSettings(page);
  const plan = page.getByRole("region", { name: "Plan y suscripción" });
  await expect(
    plan.getByRole("heading", { name: "Pro", exact: true }),
  ).toBeVisible();
  // Built: the access-until instant with a Spanish month name ("6 dic 2026,
  // 4:00 a.m."), business date + 60 days at the 04:00 support cutoff (D17).
  const until = new Date(`${businessDate}T12:00:00Z`);
  until.setUTCDate(until.getUTCDate() + 60);
  const month = [
    "ene",
    "feb",
    "mar",
    "abr",
    "may",
    "jun",
    "jul",
    "ago",
    "sept?",
    "oct",
    "nov",
    "dic",
  ][until.getUTCMonth()];
  await expect(
    plan.getByText(
      new RegExp(
        `^Pro otorgado por soporte · Acceso hasta: ${until.getUTCDate()} ${month}\\.? ${until.getUTCFullYear()}`,
      ),
    ),
  ).toBeVisible();
  await page.goto("/app?account=1");
  const heading = page.getByRole("heading", {
    name: "Acciones de soporte",
    exact: true,
  });
  await expect(heading).toBeVisible();
  const log = heading.locator("xpath=following-sibling::ul[1]");
  await expect(log.locator("li")).toHaveCount(1);
  await expect(log).toContainText(`RD-${runId}`);
  await page.goto("/app");
  await expect(page.locator(".scope")).toBeVisible();
}

/** A product row in Menú → Productos. */
function productRow(page: Page, name: string) {
  return page
    .locator("li.menu-row")
    .filter({
      has: page.locator("strong", {
        hasText: new RegExp(`^${escapeRe(name)}$`),
      }),
    });
}

/** A7.c1, A7.c2 and the group usage counts after A7. */
async function productChecks(owner: Device, r: Restaurant) {
  const page = owner.page;
  const name = (id: string) => r.products.find((p) => p.id === id)!.name;
  for (const id of ["TP", "TS"]) {
    await expect(
      productRow(page, name(id)).locator(".menu-badges"),
    ).toContainText("2 modificadores");
    await expect(
      productRow(page, name(id)).locator(".menu-badges"),
    ).toContainText("Receta");
  }
  await expect(
    productRow(page, name("CP")).locator(".menu-badges"),
  ).toContainText("Combo");
  await expect(productRow(page, name("VA")).locator(".menu-price")).toHaveText(
    "Precio abierto · máx. $300.00",
  );
  // A7.c2: the 0% product keeps its tax; IVA 8% is only for the border region.
  await page
    .getByRole("button", { name: `Editar ${name("TK")}`, exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Editar producto" });
  const tax = label(editor, "Impuesto");
  await expect(tax).toHaveValue("iva0");
  await expect(tax.locator("option:checked")).toHaveText("IVA 0%");
  await expect(
    tax.locator("option", { hasText: "IVA 8% (región fronteriza)" }),
  ).toHaveAttribute("disabled", "");
  await expect(
    editor.getByText(
      "El precio ya incluye este impuesto. Solo disponible en región fronteriza.",
    ),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole("tab", { name: "Modificadores" }).click();
  const uses: Record<string, number> = {};
  for (const p of r.products)
    for (const g of p.groups) uses[g] = (uses[g] ?? 0) + 1;
  for (const g of r.groups) {
    const card = page
      .locator(".menu-group-card")
      .filter({
        has: page.getByRole("heading", { name: g.name, exact: true }),
      });
    await expect(
      card.getByText(`Se usa en ${uses[g.id] ?? 0} productos`, { exact: true }),
    ).toBeVisible();
  }
}

/** A8.3: a terminal's roster lists the restaurant's staff and never offers Google. */
async function rosterChecks(terminal: Device, r: Restaurant) {
  const page = terminal.page;
  const roster = page.locator(".roster .roster-person");
  await expect(roster).toHaveCount(r.staff.length);
  for (const person of r.staff) {
    const button = page
      .locator(".roster-person")
      .filter({ hasText: person.name });
    await expect(button.locator(".roster-role")).toHaveText(person.roleLabel);
  }
  await expect(
    page.getByText(
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continuar con Google" }),
  ).toHaveCount(0);
}

/** A9.1: no kitchen ticket and no payment before the drawer opens (MON-8). */
async function noSaleWithoutDrawer(
  caja: Device,
  cocina: Device,
  r: Restaurant,
) {
  const page = caja.page;
  const tp = r.products.find((p) => p.id === "TP")!;
  await productCard(page, tp.name).click();
  const picker = page.getByRole("dialog", { name: tp.name });
  await picker.getByRole("radio", { name: /^Maíz/ }).check();
  await picker
    .getByRole("button", { name: "Agregar a la orden", exact: true })
    .click();
  await expect(picker).toHaveCount(0);
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const pay = page.getByRole("dialog", { name: "Cobrar" });
  await expect(
    pay.getByText("Abre caja en este dispositivo antes de cobrar.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    pay.getByRole("button", { name: "Ir a Caja", exact: true }),
  ).toBeVisible();
  await expect(
    pay.getByRole("button", { name: "Confirmar cobro" }),
  ).toBeDisabled();
  await pay.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(pay).toHaveCount(0);
  // Two kitchen polls (3 s apart, the KDS interval) both read an empty feed.
  let empty = 0;
  await expect
    .poll(
      async () => {
        const feed = (await readApi(cocina, "/api/service/kitchen?station=all"))
          .body;
        if (feed.rounds.length)
          throw Error("A9.1: a kitchen ticket appeared without a payment");
        return ++empty;
      },
      { intervals: [3_000], timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(2);
  // The built cart has no "Vaciar": the line's minus stepper removes a single unit.
  await page
    .getByRole("button", { name: `Cantidad − ${tp.name}`, exact: true })
    .click();
  await expect(
    page.getByText("La siguiente buena orden empieza aquí."),
  ).toBeVisible();
}

/** A9.2 / B5.2: Caja → Abrir caja with the opening float. */
export async function openDrawer(
  caja: Device,
  opening: number,
  checkpointId?: string,
) {
  const page = caja.page;
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Fondo inicial", { exact: true })
    .fill(money(opening));
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(
    page.getByText("Caja abierta", { exact: true }).first(),
  ).toBeVisible();
  if (checkpointId) await checkpoint(caja, checkpointId);
}

/** A product card in Vender (its accessible name starts with the category). */
export function productCard(page: Page, name: string) {
  return page
    .locator("button.product")
    .filter({
      has: page.locator("strong", {
        hasText: new RegExp(`^${escapeRe(name)}$`),
      }),
    });
}

export async function setupA(dev: Devices, state: RunState, save: () => void) {
  const r = RESTAURANT_A;
  const owner = await dev("ownerA");
  run.step = "A1";
  await googleOwner(owner, r, state.baseUrl);
  await signup(owner, r, state.cutoffA, "A1-signup");
  const cookies = await owner.context.cookies();
  for (const name of ["gm_device", "gm_session", "gm_owner_browser"])
    expect(
      cookies.find((c) => c.name === name),
      `A1.5 ${name} Secure on 127.0.0.1`,
    ).toMatchObject({ secure: true });
  // From the browser itself: Chromium sends Secure cookies to http://127.0.0.1
  // (a potentially trustworthy origin); Playwright's API client does not.
  expect(
    await owner.page.evaluate(async () => (await fetch("/api/session")).status),
  ).toBe(200);
  run.step = "A2";
  state.tenantA = await readTenantId(owner, "A2-help");
  save();
  await grantPro(state.tenantA, r, state.businessDateA, state.runId);
  await proGranted(owner, state.runId, state.businessDateA);
  run.step = "A3";
  await fiscalProfile(owner, r, "A3-fiscal");
  run.step = "A4";
  await staff(owner, r, "A4-staff");
  await moneyControls(owner);
  run.step = "A5";
  await stockItems(owner, r, "A5-stock");
  run.step = "A6";
  await modifierGroups(owner, r, "A6-groups");
  run.step = "A7";
  await categoriesAndProducts(owner, r, "A7-products");
  await productChecks(owner, r);
  run.step = "A8";
  const caja = await dev("cajaA");
  {
    const { code, dialog } = await pairingCode(owner, "Caja 1", "A8-pair-code");
    await pair(caja, code, r.name, "Caja 1", "A8-gate");
    await expect(
      dialog.getByRole("status").filter({ hasText: "Vinculado: Caja 1" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  }
  await rosterChecks(caja, r);
  // GAP-2: a terminal never starts the owner's Google flow.
  await caja.page.goto("/api/auth/google/start");
  await expect(caja.page).toHaveURL(/\/app\?auth_error=terminal$/);
  await caja.page.goto("/app");
  const cocina = await dev("cocinaA");
  const respaldo = await dev("respaldoA");
  for (const [device, name] of [
    [cocina, "Cocina"],
    [respaldo, "Caja 2 (respaldo)"],
  ] as const) {
    const { code, dialog } = await pairingCode(owner, name);
    await pair(device, code, r.name, name);
    await expect(
      dialog.getByRole("status").filter({ hasText: `Vinculado: ${name}` }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  }
  // A8.5: Diego signs in with the keypad; no restaurant ID is typed anywhere.
  const diego = r.staff.find((p) => p.key === "diego")!;
  await signIn(caja, diego.name, diego.pin);
  await expect(
    caja.page.getByRole("heading", { name: "Vender", level: 1 }),
  ).toBeVisible();
  // A7.c5: Vender lists the categories in the menu's order (after the "all" chip); the
  // open-price product shows "Precio abierto" instead of a price and the combo its tag.
  {
    const chips = await caja.page.locator(".categories button").allInnerTexts();
    expect(chips.slice(1).map((c) => c.trim())).toEqual(r.categories);
    const card = (id: string) =>
      caja.page.locator("button.product").filter({
        has: caja.page.locator("strong", {
          hasText: new RegExp(
            `^${escapeRe(r.products.find((p) => p.id === id)!.name)}$`,
          ),
        }),
      });
    await expect(card("VA").locator(".product-price")).toHaveText(
      "Precio abierto",
    );
    await expect(card("CP").locator(".product-tag")).toHaveText("Combo");
  }
  // A8.6: a wrong code on an unpaired device.
  const probe = await dev("probe");
  await probe.page.goto("/app");
  await allowing(
    [{ method: "POST", url: /\/api\/access\/pair$/, status: 400 }],
    async () => {
      await probe.page.getByLabel("Código de vinculación").fill("ZZZZ-ZZZZ");
      await probe.page
        .getByRole("button", { name: "Vincular", exact: true })
        .click();
      await expect(
        probe.page
          .getByRole("alert")
          .filter({
            hasText: "El código no es válido o ya venció. Pide uno nuevo.",
          }),
      ).toBeVisible();
    },
  );
  // A8.7: the kitchen signs in to an empty display.
  const hugo = r.staff.find((p) => p.key === "hugo")!;
  await signIn(cocina, hugo.name, hugo.pin);
  await expect(
    cocina.page.getByText("No hay tickets pendientes.", { exact: true }),
  ).toBeVisible();
  await checkpoint(cocina, "A8-kds-empty");
  // A8.8: one wrong PIN does not lock (SEC-2).
  const paola = r.staff.find((p) => p.key === "paola")!;
  await respaldo.page
    .getByRole("button", { name: new RegExp(`^${paola.name}`) })
    .click();
  await allowing(
    [{ method: "POST", url: /\/api\/access\/pin$/, status: 401 }],
    async () => {
      await typePin(respaldo, respaldo.page, paola.name, "000000");
      await expect(
        respaldo.page.getByRole("alert").filter({ hasText: "PIN incorrecto." }),
      ).toBeVisible();
    },
  );
  await expect(
    respaldo.page.getByLabel(`PIN de ${paola.name}`, { exact: true }),
  ).toHaveValue("");
  await respaldo.page
    .getByRole("button", { name: "Elegir a otra persona", exact: true })
    .click();
  await owner.page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Equipo" })
    .click();
  await expect(
    owner.page
      .getByRole("region", { name: "Equipo" })
      .getByRole("row", { name: new RegExp(`^${paola.name}`) }),
  ).toContainText("Activo");
  // A8.9: the device list.
  await openSettings(owner.page);
  const list = owner.page.getByRole("region", { name: "Dispositivos" });
  const device = (name: string) =>
    list
      .locator("li.device-row")
      .filter({
        has: owner.page.locator("strong", {
          hasText: new RegExp(`^${escapeRe(name)}$`),
        }),
      });
  await expect(device("Caja 1")).toContainText("Terminal compartida");
  await expect(device("Caja 1")).toContainText("Activo");
  await expect(device("Caja 1")).toContainText(`En uso por ${diego.name}`);
  await expect(device("Cocina")).toContainText(`En uso por ${hugo.name}`);
  await expect(device("Caja 2 (respaldo)")).toContainText(
    "Terminal compartida",
  );
  await expect(device("Caja 2 (respaldo)")).toContainText("Activo");
  await expect(device("Caja 2 (respaldo)")).not.toContainText("En uso por");
  const mine = list
    .locator("li.device-row")
    .filter({ hasText: "Este dispositivo" });
  await expect(mine).toContainText(`Personal · ${r.owner.name}`);
  await expect(list.locator("li.device-row")).toHaveCount(4);
  await checkpoint(owner, "A8-devices", { settle: list });
  run.step = "A9";
  await noSaleWithoutDrawer(caja, cocina, r);
  await openDrawer(caja, r.openingCash, "A9-cash");
}

/** B3 (§7.3): areas and tables in Menú e inventario → Mesas, then the operational view. */
async function floor(owner: Device, r: typeof RESTAURANT_B) {
  const page = owner.page;
  await menuNav(page, "Mesas");
  await expect(
    page.getByRole("heading", { name: "Mesas y áreas" }),
  ).toBeVisible();
  for (const a of r.areas) {
    await page.getByRole("button", { name: "Nueva área", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Nueva área" });
    await label(dialog, "Nombre del área").fill(a.name);
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  for (const a of r.areas) {
    await page
      .getByRole("button", { name: "Agregar varias mesas", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Agregar varias mesas" });
    await label(dialog, "Área").selectOption({ label: a.name });
    await label(dialog, "Prefijo").fill(a.prefix);
    await label(dialog, "Desde").fill(String(a.from));
    await label(dialog, "Hasta").fill(String(a.to));
    await label(dialog, "Lugares").fill(String(a.seats));
    await expect(
      dialog.getByText(
        `Se crearán: ${a.prefix} ${a.from} … ${a.prefix} ${a.to} (${a.to - a.from + 1} mesas)`,
        { exact: true },
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await checkpoint(owner, "B3-floor");
}

export async function setupB(dev: Devices, state: RunState, save: () => void) {
  const r = RESTAURANT_B;
  const owner = await dev("ownerB");
  run.step = "B1.1";
  await googleOwner(owner, r, state.baseUrl);
  await signup(owner, r, state.cutoffB);
  run.step = "B1.3";
  state.tenantB = await readTenantId(owner);
  expect(state.tenantB).not.toBe(state.tenantA);
  save();
  run.step = "B1.4";
  await grantPro(state.tenantB, r, state.businessDateB, state.runId);
  await proGranted(owner, state.runId, state.businessDateB);
  run.step = "B1.5";
  await fiscalProfile(owner, r, "B1-fiscal-border");
  // B1.6, branch K only: CFDI in test mode before any sale.
  if (run.branch === "K") await activateCfdi(owner, state);
  run.step = "B2.1";
  await staff(owner, r);
  run.step = "B2.2";
  await moneyControls(owner);
  run.step = "B3";
  await floor(owner, r);
  run.step = "B4.1";
  await stockItems(owner, r);
  await modifierGroups(owner, r);
  await categoriesAndProducts(owner, r);
  run.step = "B5.1";
  const pairs = [
    ["cajaB", "Caja"],
    ["sofiaB", "Comandera 1"],
    ["tomasB", "Comandera 2"],
    ["cocinaB", "Cocina"],
  ] as const;
  for (const [name, deviceName] of pairs) {
    const device = await dev(name);
    const { code, dialog } = await pairingCode(owner, deviceName);
    await pair(device, code, r.name, deviceName);
    await expect(
      dialog
        .getByRole("status")
        .filter({ hasText: `Vinculado: ${deviceName}` }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  }
  const sofiaB = await dev("sofiaB");
  await checkpoint(sofiaB, "B5-roster-phone");
  const person = (key: string) => r.staff.find((p) => p.key === key)!;
  for (const [name, key] of [
    ["cajaB", "karla"],
    ["sofiaB", "sofia"],
    ["tomasB", "tomas"],
    ["cocinaB", "ramon"],
  ] as const) {
    const device = await dev(name);
    const who = person(key);
    if (name === "sofiaB") {
      await device.page
        .getByRole("button", { name: new RegExp(`^${who.name}`) })
        .click();
      for (const key of await device.page.locator(".keypad button").all()) {
        const box = await key.boundingBox();
        expect(
          box?.height ?? 0,
          "B5.1: PinPad keys are at least 44 px tall",
        ).toBeGreaterThanOrEqual(44);
      }
      await typePin(device, device.page, who.name, who.pin);
      run.lastAuthAt[`${who.name}@${device.name}`] = Date.now();
    } else await signIn(device, who.name, who.pin);
  }
  run.step = "B3.4";
  const caja = await dev("cajaB");
  await caja.page.getByRole("button", { name: "Mesas", exact: true }).click();
  const cards = caja.page.locator("article.table-card");
  await expect(cards).toHaveCount(12);
  await expect(cards.first()).toHaveAccessibleName("Mesa 1");
  for (const card of await cards.all())
    await expect(card).toContainText("Disponible");
  await checkpoint(caja, "B3-tables-empty");
  run.step = "B5.2";
  await openDrawer(caja, r.openingCash);
}

/**
 * Branch L (loyalty spec §9.4, lead decision LD-80): Restaurant L, created like
 * A and B (signup, support grant, fiscal profile, staff, menu, a paired
 * register), with Mariana signed in at an open drawer. Its club is turned on by
 * the owner in the next test (tests/restaurant-day/club-l.ts).
 */
export async function setupL(dev: Devices, state: RunState, save: () => void) {
  const r = RESTAURANT_L;
  const owner = await dev("ownerL");
  run.step = "L1.1";
  await googleOwner(owner, r, state.baseUrl);
  await signup(owner, r, state.cutoffL);
  run.step = "L1.2";
  state.tenantL = await readTenantId(owner);
  expect(state.tenantL).not.toBe(state.tenantA);
  expect(state.tenantL).not.toBe(state.tenantB);
  save();
  run.step = "L1.3";
  await grantPro(state.tenantL, r, state.businessDateL, state.runId);
  await proGranted(owner, state.runId, state.businessDateL);
  run.step = "L1.4";
  await fiscalProfile(owner, r, "L1-fiscal");
  run.step = "L2.1";
  await staff(owner, r);
  run.step = "L2.2";
  await menuNav(owner.page, "Menú");
  await categoriesAndProducts(owner, r);
  run.step = "L2.3";
  const caja = await dev("cajaL");
  {
    const { code, dialog } = await pairingCode(owner, "Caja");
    await pair(caja, code, r.name, "Caja");
    await expect(
      dialog.getByRole("status").filter({ hasText: "Vinculado: Caja" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
  }
  await rosterChecks(caja, r);
  const mariana = r.staff.find((p) => p.key === "mariana")!;
  await signIn(caja, mariana.name, mariana.pin);
  await expect(
    caja.page.getByRole("heading", { name: "Vender", level: 1 }),
  ).toBeVisible();
  run.step = "L2.4";
  await openDrawer(caja, r.openingCash);
}
