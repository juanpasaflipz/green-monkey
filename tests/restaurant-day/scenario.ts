/**
 * Restaurant-day scenario (specs/acceptance.md §6 and §7): pure data, copied
 * from the spec. Money is integer centavos; stock quantities are in the stock
 * item's own unit (kg, l, piezas). Names, PINs and references are fictional
 * and contain none of the G3 denylisted words (§3.7).
 */

export type Unit = "kg" | "l" | "pieza";
export type StockDef = {
  id: string;
  name: string;
  unit: Unit;
  /** "Unidad de inventario" option label */
  unitLabel: string;
  kind: "Preparado" | "Materia prima";
  reorder: number;
  par: number;
  opening: number;
};
/** A recipe entry: stock item id, quantity in the stock unit, and how the UI types it. */
export type RecipeEntry = {
  stock: string;
  qty: number;
  typed: { value: string; unit: "g" | "kg" | "l" | "ml" | "pieza" };
};
export type OptionDef = {
  name: string;
  price: number;
  cost: number;
  recipe: RecipeEntry[];
};
export type GroupDef = {
  id: string;
  name: string;
  min: number;
  max: number;
  repeat: boolean;
  template?: string;
  ruleText: string;
  options: OptionDef[];
};
export type ProductDef = {
  id: string;
  name: string;
  category: string;
  kind: "product" | "combo";
  /** null: open price */
  price: number | null;
  openMax?: number;
  station: "Cocina" | "Barra";
  groups: string[];
  recipe: RecipeEntry[];
  /** null: no estimated cost (excluded from COGS) */
  cost: number | null;
  tax: "default" | "iva0";
};
export type Staff = {
  key: string;
  name: string;
  role: "owner" | "manager" | "cashier" | "server" | "kitchen";
  roleLabel: "Propietario" | "Responsable" | "Cajero" | "Mesero" | "Cocina";
  pin: string;
};
export type Line = {
  product: string;
  qty: number;
  /** option names in group order; a repeat group lists each pick */
  options?: string[];
  /** open price, centavos */
  open?: number;
  note?: string;
};
export type Payment = {
  method: "cash" | "external";
  /** centavos; default: the whole due */
  amount?: number;
  tip?: number;
  /** quick-cash bill in pesos ("$200"); cash without it pays exact */
  bill?: number;
  ref?: string;
  /** B: pay these units by items ("Tostada de atún · 1") */
  units?: string[];
};
export type OrderDef = {
  id: string;
  number: number;
  lines: Line[];
  callName?: string;
  orderNote?: string;
  cashier: string;
  offline?: boolean;
  /** void after sending: [line index, units, stock returned] */
  voids?: Array<{
    line: number;
    units: number;
    restock: boolean;
    reason: string;
  }>;
  /** whole-check percent discount (basis points) */
  discountBps?: { bps: number; reason: string; reasonLabel: string };
  /** a 100% courtesy on one whole line */
  courtesy?: {
    line: number;
    reason: string;
    reasonLabel: string;
    note: string;
  };
  /** lines removed from the draft before sending (86) */
  removed?: number[];
  /**
   * Branch L (loyalty spec §9.4): what the cashier does at the "Cliente del club" prompt the
   * first line opens: enroll a new member, look one up by phone, or "Sin club".
   */
  club?: "enroll" | "lookup" | "skip";
  /** Branch L: "Canjear premio" on one unit of this line, after "Enviar productos primero". */
  reward?: { line: number };
  payment: Payment | null;
};

const g = (value: string): RecipeEntry["typed"] => ({ value, unit: "g" });
const pz = (value: string): RecipeEntry["typed"] => ({ value, unit: "pieza" });
const l = (value: string): RecipeEntry["typed"] => ({ value, unit: "l" });

export const RESTAURANT_A = {
  owner: {
    name: "Lucía Herrera Prado",
    email: "lucia.herrera@nopalazul.invalid",
    subjectSeed: "restaurant-day/owner-a",
  },
  name: "Taquería Nopal Azul",
  timezone: "America/Mexico_City",
  fiscal: {
    rfc: "EKU9003173C9",
    legalName: "Nopal Azul Alimentos",
    regime: "601",
    regimeLabel: "601 — General de Ley Personas Morales",
    receiptRegime: "601 General de Ley Personas Morales",
    zip: "06700",
    street: "Av. Álvaro Obregón 120",
    neighborhood: "Roma Norte",
    municipality: "Cuauhtémoc",
    state: "Ciudad de México",
    series: "A",
  },
  staff: [
    {
      key: "lucia",
      name: "Lucía Herrera Prado",
      role: "owner",
      roleLabel: "Propietario",
      pin: "905173",
    },
    {
      key: "marisol",
      name: "Marisol Vega",
      role: "manager",
      roleLabel: "Responsable",
      pin: "482613",
    },
    {
      key: "diego",
      name: "Diego Ramos",
      role: "cashier",
      roleLabel: "Cajero",
      pin: "391742",
    },
    {
      key: "paola",
      name: "Paola Núñez",
      role: "cashier",
      roleLabel: "Cajero",
      pin: "520386",
    },
    {
      key: "hugo",
      name: "Hugo Salinas",
      role: "kitchen",
      roleLabel: "Cocina",
      pin: "667129",
    },
  ] satisfies Staff[],
  devices: ["Caja 1", "Cocina", "Caja 2 (respaldo)"],
  stock: [
    {
      id: "S1",
      name: "Carne al pastor",
      unit: "kg",
      unitLabel: "kilogramos (kg)",
      kind: "Preparado",
      reorder: 1,
      par: 6,
      opening: 5,
    },
    {
      id: "S2",
      name: "Suadero",
      unit: "kg",
      unitLabel: "kilogramos (kg)",
      kind: "Preparado",
      reorder: 0.2,
      par: 3,
      opening: 0.5,
    },
    {
      id: "S3",
      name: "Tortilla de maíz",
      unit: "pieza",
      unitLabel: "piezas",
      kind: "Materia prima",
      reorder: 100,
      par: 800,
      opening: 600,
    },
    {
      id: "S4",
      name: "Tortilla de harina",
      unit: "pieza",
      unitLabel: "piezas",
      kind: "Materia prima",
      reorder: 30,
      par: 150,
      opening: 100,
    },
    {
      id: "S5",
      name: "Queso Oaxaca",
      unit: "kg",
      unitLabel: "kilogramos (kg)",
      kind: "Materia prima",
      reorder: 0.5,
      par: 3,
      opening: 2,
    },
    {
      id: "S6",
      name: "Aguacate",
      unit: "kg",
      unitLabel: "kilogramos (kg)",
      kind: "Materia prima",
      reorder: 0.3,
      par: 2,
      opening: 1,
    },
    {
      id: "S7",
      name: "Agua de horchata (base)",
      unit: "l",
      unitLabel: "litros (l)",
      kind: "Preparado",
      reorder: 4,
      par: 25,
      opening: 20,
    },
    {
      id: "S8",
      name: "Base de jamaica",
      unit: "l",
      unitLabel: "litros (l)",
      kind: "Preparado",
      reorder: 4,
      par: 25,
      opening: 20,
    },
  ] satisfies StockDef[],
  groups: [
    {
      id: "G1",
      name: "Tortilla",
      min: 1,
      max: 1,
      repeat: false,
      template: "Tortilla (maíz / harina)",
      ruleText: "Obligatorio · elige 1",
      options: [
        {
          name: "Maíz",
          price: 0,
          cost: 0,
          recipe: [{ stock: "S3", qty: 1, typed: pz("1") }],
        },
        {
          name: "Harina",
          price: 300,
          cost: 50,
          recipe: [{ stock: "S4", qty: 1, typed: pz("1") }],
        },
      ],
    },
    {
      id: "G2",
      name: "Extras",
      min: 0,
      max: 2,
      repeat: false,
      template: "Extras (queso, aguacate)",
      ruleText: "Opcional · hasta 2",
      options: [
        {
          name: "Queso",
          price: 1200,
          cost: 400,
          recipe: [{ stock: "S5", qty: 0.03, typed: g("30") }],
        },
        {
          name: "Aguacate",
          price: 1500,
          cost: 600,
          recipe: [{ stock: "S6", qty: 0.04, typed: g("40") }],
        },
      ],
    },
    {
      id: "G3",
      name: "Sabor",
      min: 1,
      max: 1,
      repeat: false,
      ruleText: "Obligatorio · elige 1",
      options: [
        {
          name: "Horchata",
          price: 0,
          cost: 0,
          recipe: [{ stock: "S7", qty: 0.4, typed: l("0.4") }],
        },
        {
          name: "Jamaica",
          price: 0,
          cost: 0,
          recipe: [{ stock: "S8", qty: 0.4, typed: l("0.4") }],
        },
      ],
    },
    {
      id: "G4",
      name: "Tamaño",
      min: 1,
      max: 1,
      repeat: false,
      ruleText: "Obligatorio · elige 1",
      options: [
        { name: "Chica", price: 0, cost: 0, recipe: [] },
        { name: "Grande", price: 1000, cost: 200, recipe: [] },
      ],
    },
    {
      id: "G5",
      name: "Tacos del combo",
      min: 3,
      max: 3,
      repeat: true,
      ruleText: "Obligatorio · elige 3 · puedes repetir",
      options: [
        {
          name: "Pastor",
          price: 0,
          cost: 0,
          recipe: [
            { stock: "S1", qty: 0.08, typed: g("80") },
            { stock: "S3", qty: 1, typed: pz("1") },
          ],
        },
        {
          name: "Suadero",
          price: 200,
          cost: 100,
          recipe: [
            { stock: "S2", qty: 0.08, typed: g("80") },
            { stock: "S3", qty: 1, typed: pz("1") },
          ],
        },
      ],
    },
    {
      id: "G6",
      name: "Bebida del combo",
      min: 1,
      max: 1,
      repeat: false,
      ruleText: "Obligatorio · elige 1",
      options: [
        {
          name: "Horchata",
          price: 0,
          cost: 0,
          recipe: [{ stock: "S7", qty: 0.4, typed: l("0.4") }],
        },
        {
          name: "Jamaica",
          price: 0,
          cost: 0,
          recipe: [{ stock: "S8", qty: 0.4, typed: l("0.4") }],
        },
      ],
    },
  ] satisfies GroupDef[],
  categories: [
    "Tacos",
    "Especialidades",
    "Combos",
    "Bebidas",
    "Tienda",
    "Varios",
  ],
  products: [
    {
      id: "TP",
      name: "Taco al pastor",
      category: "Tacos",
      kind: "product",
      price: 2800,
      station: "Cocina",
      groups: ["G1", "G2"],
      recipe: [{ stock: "S1", qty: 0.08, typed: g("80") }],
      cost: 900,
      tax: "default",
    },
    {
      id: "TS",
      name: "Taco de suadero",
      category: "Tacos",
      kind: "product",
      price: 3000,
      station: "Cocina",
      groups: ["G1", "G2"],
      recipe: [{ stock: "S2", qty: 0.08, typed: g("80") }],
      cost: 1000,
      tax: "default",
    },
    {
      id: "GR",
      name: "Gringa de pastor",
      category: "Especialidades",
      kind: "product",
      price: 6500,
      station: "Cocina",
      groups: ["G2"],
      recipe: [
        { stock: "S1", qty: 0.12, typed: g("120") },
        { stock: "S4", qty: 2, typed: pz("2") },
        { stock: "S5", qty: 0.05, typed: g("50") },
      ],
      cost: 2200,
      tax: "default",
    },
    {
      id: "CP",
      name: "Combo Pastor",
      category: "Combos",
      kind: "combo",
      price: 9900,
      station: "Cocina",
      groups: ["G5", "G6"],
      recipe: [],
      cost: 3000,
      tax: "default",
    },
    {
      id: "AF",
      name: "Agua fresca",
      category: "Bebidas",
      kind: "product",
      price: 3500,
      station: "Barra",
      groups: ["G3", "G4"],
      recipe: [],
      cost: 600,
      tax: "default",
    },
    {
      id: "TK",
      name: "Tortillas de maíz 1 kg",
      category: "Tienda",
      kind: "product",
      price: 2600,
      station: "Cocina",
      groups: [],
      recipe: [{ stock: "S3", qty: 30, typed: pz("30") }],
      cost: 1400,
      tax: "iva0",
    },
    {
      id: "VA",
      name: "Varios",
      category: "Varios",
      kind: "product",
      price: null,
      openMax: 30000,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: null,
      tax: "default",
    },
  ] satisfies ProductDef[],
  openingCash: 150000,
  countedCash: 308430,
};

const TP_M: Line = { product: "TP", qty: 2, options: ["Maíz"] };
const TK1: Line = { product: "TK", qty: 1 };
const canonical = (): Line[] => [{ ...TP_M }, { ...TK1 }];

/** §6.6 order book A01–A26. Cashier is Diego unless stated. */
export const ORDERS_A: OrderDef[] = [
  {
    id: "A01",
    number: 1,
    cashier: "diego",
    callName: "Rocío",
    lines: [
      { product: "TP", qty: 3, options: ["Maíz"], note: "Sin cebolla" },
      { product: "AF", qty: 1, options: ["Horchata", "Chica"] },
    ],
    payment: { method: "cash", bill: 200 },
  },
  {
    id: "A02",
    number: 2,
    cashier: "diego",
    callName: "Andrés",
    lines: [
      { product: "TS", qty: 2, options: ["Harina", "Queso"] },
      { product: "AF", qty: 1, options: ["Jamaica", "Grande"] },
    ],
    payment: { method: "external", ref: "000102", tip: 1500 },
  },
  {
    id: "A03",
    number: 3,
    cashier: "diego",
    lines: canonical(),
    payment: { method: "cash" },
  },
  {
    id: "A04",
    number: 4,
    cashier: "diego",
    callName: "Valeria",
    orderNote: "ALERGIA: cacahuate",
    lines: [
      { product: "GR", qty: 1, options: ["Queso"] },
      { product: "AF", qty: 1, options: ["Jamaica", "Chica"] },
    ],
    payment: { method: "cash", bill: 150 },
  },
  {
    id: "A05",
    number: 5,
    cashier: "diego",
    callName: "Jorge",
    lines: [
      {
        product: "CP",
        qty: 1,
        options: ["Pastor", "Pastor", "Suadero", "Horchata"],
      },
      { ...TK1 },
    ],
    payment: { method: "external", ref: "000105" },
  },
  {
    id: "A06",
    number: 6,
    cashier: "diego",
    callName: "Luis",
    lines: [
      {
        product: "VA",
        qty: 1,
        open: 8450,
        note: "Enchiladas verdes, sin crema",
      },
      { product: "AF", qty: 1, options: ["Horchata", "Grande"] },
    ],
    payment: { method: "cash", tip: 1000, bill: 200 },
  },
  {
    id: "A07",
    number: 7,
    cashier: "diego",
    lines: canonical(),
    payment: { method: "cash", bill: 100 },
  },
  {
    id: "A08",
    number: 8,
    cashier: "diego",
    callName: "Ana",
    lines: [
      { product: "TP", qty: 3, options: ["Maíz"] },
      { product: "TS", qty: 1, options: ["Maíz"] },
    ],
    voids: [
      { line: 1, units: 1, restock: true, reason: "Cliente cambió de opinión" },
    ],
    payment: { method: "cash" },
  },
  {
    id: "A09",
    number: 9,
    cashier: "diego",
    callName: "Beto",
    lines: [
      { product: "GR", qty: 2 },
      { product: "AF", qty: 1, options: ["Jamaica", "Chica"] },
    ],
    voids: [
      { line: 0, units: 1, restock: false, reason: "Cliente ya no lo quiso" },
    ],
    payment: { method: "external", ref: "000109", tip: 1000 },
  },
  {
    id: "A10",
    number: 10,
    cashier: "diego",
    callName: "Familia Ortiz",
    lines: [
      { product: "TP", qty: 4, options: ["Maíz"] },
      { product: "AF", qty: 2, options: ["Horchata", "Chica"] },
    ],
    discountBps: {
      bps: 1000,
      reason: "regular_customer",
      reasonLabel: "Cliente frecuente",
    },
    payment: { method: "cash", bill: 200 },
  },
  {
    id: "A11",
    number: 11,
    cashier: "diego",
    lines: canonical(),
    payment: { method: "cash" },
  },
  {
    id: "A12",
    number: 12,
    cashier: "diego",
    callName: "Mariana",
    lines: [
      { product: "TS", qty: 2, options: ["Maíz"] },
      { product: "AF", qty: 1, options: ["Jamaica", "Grande"] },
    ],
    courtesy: {
      line: 1,
      reason: "courtesy",
      reasonLabel: "Cortesía de la casa",
      note: "Cortesía por espera",
    },
    payment: { method: "cash" },
  },
  {
    id: "A13",
    number: 13,
    cashier: "diego",
    callName: "Pedro",
    lines: [
      { product: "TS", qty: 1, options: ["Maíz"] },
      { product: "TP", qty: 2, options: ["Maíz"] },
    ],
    removed: [0],
    payment: { method: "external", ref: "000113" },
  },
  {
    id: "A14",
    number: 14,
    cashier: "diego",
    callName: "Iván",
    lines: [{ product: "GR", qty: 1, options: ["Aguacate"] }],
    voids: [
      { line: 0, units: 1, restock: true, reason: "Cliente cambió de opinión" },
    ],
    payment: null,
  },
  {
    id: "A15",
    number: 15,
    cashier: "diego",
    callName: "Doña Carmen",
    lines: [
      { product: "TK", qty: 2 },
      { product: "TP", qty: 1, options: ["Harina", "Queso"] },
    ],
    payment: { method: "cash", bill: 100 },
  },
  {
    id: "A16",
    number: 16,
    cashier: "diego",
    lines: canonical(),
    payment: { method: "cash", bill: 100 },
  },
  {
    id: "A17",
    number: 17,
    cashier: "paola",
    callName: "Karen",
    lines: [
      { product: "TP", qty: 1, options: ["Maíz", "Queso"] },
      { product: "TP", qty: 1, options: ["Maíz"] },
    ],
    payment: { method: "external", ref: "000117", tip: 700 },
  },
  {
    id: "A18",
    number: 18,
    cashier: "diego",
    callName: "Rubén",
    lines: [
      { product: "GR", qty: 1 },
      { product: "AF", qty: 1, options: ["Horchata", "Chica"] },
    ],
    payment: { method: "cash" },
  },
  {
    id: "A19",
    number: 19,
    cashier: "diego",
    callName: "Rodrigo",
    offline: true,
    lines: [
      { product: "TP", qty: 3, options: ["Maíz"], note: "Bien dorados" },
      { ...TK1 },
    ],
    payment: { method: "cash", bill: 200 },
  },
  {
    id: "A20",
    number: 20,
    cashier: "diego",
    offline: true,
    lines: canonical(),
    payment: { method: "cash" },
  },
  {
    id: "A21",
    number: 21,
    cashier: "diego",
    callName: "Elena",
    offline: true,
    lines: [
      {
        product: "CP",
        qty: 1,
        options: ["Pastor", "Pastor", "Pastor", "Jamaica"],
      },
    ],
    payment: { method: "external", ref: "000121", tip: 1000 },
  },
  {
    id: "A22",
    number: 22,
    cashier: "diego",
    callName: "Tere",
    offline: true,
    lines: [
      { product: "VA", qty: 1, open: 4500, note: "Consomé chico" },
      { product: "AF", qty: 1, options: ["Jamaica", "Chica"] },
    ],
    payment: { method: "cash", bill: 100 },
  },
  {
    id: "A23",
    number: 23,
    cashier: "diego",
    callName: "Sebastián",
    lines: [
      { product: "AF", qty: 2, options: ["Horchata", "Grande"] },
      { product: "GR", qty: 1, options: ["Aguacate"] },
    ],
    payment: { method: "external", ref: "000123", tip: 2000 },
  },
  {
    id: "A24",
    number: 24,
    cashier: "diego",
    lines: canonical(),
    payment: { method: "cash", bill: 100 },
  },
  {
    id: "A25",
    number: 25,
    cashier: "diego",
    callName: "Gerardo",
    lines: [
      { product: "TP", qty: 1, options: ["Harina"], note: "Salsa aparte" },
      { product: "TP", qty: 1, options: ["Maíz"] },
      { product: "AF", qty: 1, options: ["Jamaica", "Chica"] },
    ],
    payment: { method: "cash", bill: 500 },
  },
  {
    id: "A26",
    number: 26,
    cashier: "diego",
    callName: "Lupita",
    lines: [
      {
        product: "CP",
        qty: 1,
        options: ["Pastor", "Suadero", "Suadero", "Horchata"],
      },
      { ...TK1 },
    ],
    payment: { method: "external", ref: "000126" },
  },
];

export type RefundDef = {
  id: string;
  order: string;
  actor: string;
  approver: string;
  method: "cash" | "external";
  amount: number;
  reasonLabel: string;
  explanation: string;
  terminalRef?: string;
};
export const REFUNDS_A: RefundDef[] = [
  {
    id: "R1",
    order: "A06",
    actor: "marisol",
    approver: "marisol",
    method: "cash",
    amount: 4500,
    reasonLabel: "Producto con defecto o queja",
    explanation: "Bebida derramada",
  },
  {
    id: "R2",
    order: "A02",
    actor: "diego",
    approver: "marisol",
    method: "external",
    amount: 4500,
    reasonLabel: "Producto equivocado",
    explanation: "Taco equivocado",
    terminalRef: "R-000102",
  },
];

export const RESTAURANT_B = {
  owner: {
    name: "Bárbara Ximénez Quiroz",
    email: "barbara.ximenez@casajacaranda.invalid",
    subjectSeed: "restaurant-day/owner-b",
  },
  name: "Restaurante Casa Jacaranda",
  timezone: "America/Tijuana",
  fiscal: {
    rfc: "XIQB891116QE4",
    legalName: "Bárbara Ximénez Quiroz",
    regime: "612",
    regimeLabel:
      "612 — Personas Físicas con Actividades Empresariales y Profesionales",
    receiptRegime:
      "612 Personas Físicas con Actividades Empresariales y Profesionales",
    zip: "22000",
    street: "Av. Revolución 1050",
    neighborhood: "Zona Centro",
    municipality: "Tijuana",
    state: "Baja California",
    series: "J",
  },
  staff: [
    {
      key: "barbara",
      name: "Bárbara Ximénez Quiroz",
      role: "owner",
      roleLabel: "Propietario",
      pin: "718264",
    },
    {
      key: "ernesto",
      name: "Ernesto Lozano",
      role: "manager",
      roleLabel: "Responsable",
      pin: "734205",
    },
    {
      key: "karla",
      name: "Karla Medina",
      role: "cashier",
      roleLabel: "Cajero",
      pin: "846350",
    },
    {
      key: "sofia",
      name: "Sofía Arreola",
      role: "server",
      roleLabel: "Mesero",
      pin: "158024",
    },
    {
      key: "tomas",
      name: "Tomás Ibarra",
      role: "server",
      roleLabel: "Mesero",
      pin: "290617",
    },
    {
      key: "ramon",
      name: "Ramón Ochoa",
      role: "kitchen",
      roleLabel: "Cocina",
      pin: "573918",
    },
  ] satisfies Staff[],
  devices: ["Caja", "Comandera 1", "Comandera 2", "Cocina"],
  areas: [
    { name: "Salón", prefix: "Mesa", from: 1, to: 8, seats: 4 },
    { name: "Terraza", prefix: "Terraza", from: 1, to: 4, seats: 4 },
  ],
  stock: [
    {
      id: "T1",
      name: "Arrachera",
      unit: "kg",
      unitLabel: "kilogramos (kg)",
      kind: "Materia prima",
      reorder: 0,
      par: 0,
      opening: 3,
    },
    {
      id: "T2",
      name: "Filete de pescado",
      unit: "kg",
      unitLabel: "kilogramos (kg)",
      kind: "Materia prima",
      reorder: 0,
      par: 0,
      opening: 2,
    },
    {
      id: "T3",
      name: "Aguacate",
      unit: "kg",
      unitLabel: "kilogramos (kg)",
      kind: "Materia prima",
      reorder: 0,
      par: 0,
      opening: 2,
    },
    {
      id: "T4",
      name: "Limón",
      unit: "kg",
      unitLabel: "kilogramos (kg)",
      kind: "Materia prima",
      reorder: 0,
      par: 0,
      opening: 5,
    },
  ] satisfies StockDef[],
  groups: [
    {
      id: "H1",
      name: "Término",
      min: 1,
      max: 1,
      repeat: false,
      template: "Término (medio / tres cuartos / bien cocido)",
      ruleText: "Obligatorio · elige 1",
      options: [
        { name: "Medio", price: 0, cost: 0, recipe: [] },
        { name: "Tres cuartos", price: 0, cost: 0, recipe: [] },
        { name: "Bien cocido", price: 0, cost: 0, recipe: [] },
      ],
    },
    {
      id: "H2",
      name: "Guarnición",
      min: 1,
      max: 1,
      repeat: false,
      ruleText: "Obligatorio · elige 1",
      options: [
        { name: "Papas", price: 0, cost: 0, recipe: [] },
        { name: "Ensalada", price: 0, cost: 0, recipe: [] },
        { name: "Arroz", price: 0, cost: 0, recipe: [] },
      ],
    },
    {
      id: "H3",
      name: "Extras",
      min: 0,
      max: 2,
      repeat: false,
      ruleText: "Opcional · hasta 2",
      options: [
        { name: "Queso extra", price: 2000, cost: 600, recipe: [] },
        {
          name: "Aguacate extra",
          price: 2500,
          cost: 900,
          recipe: [{ stock: "T3", qty: 0.05, typed: g("50") }],
        },
      ],
    },
  ] satisfies GroupDef[],
  categories: ["Entradas", "Platos fuertes", "Bebidas", "Postres", "Tienda"],
  products: [
    {
      id: "GU",
      name: "Guacamole",
      category: "Entradas",
      kind: "product",
      price: 12000,
      station: "Cocina",
      groups: [],
      recipe: [{ stock: "T3", qty: 0.25, typed: g("250") }],
      cost: 3500,
      tax: "default",
    },
    {
      id: "TA",
      name: "Tostada de atún",
      category: "Entradas",
      kind: "product",
      price: 9500,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 3000,
      tax: "default",
    },
    {
      id: "AR",
      name: "Arrachera 300 g",
      category: "Platos fuertes",
      kind: "product",
      price: 34000,
      station: "Cocina",
      groups: ["H1", "H2"],
      recipe: [{ stock: "T1", qty: 0.3, typed: g("300") }],
      cost: 14000,
      tax: "default",
    },
    {
      id: "PZ",
      name: "Pescado zarandeado",
      category: "Platos fuertes",
      kind: "product",
      price: 29000,
      station: "Cocina",
      groups: ["H2"],
      recipe: [{ stock: "T2", qty: 0.45, typed: g("450") }],
      cost: 11000,
      tax: "default",
    },
    {
      id: "EN",
      name: "Enchiladas suizas",
      category: "Platos fuertes",
      kind: "product",
      price: 18000,
      station: "Cocina",
      groups: ["H3"],
      recipe: [],
      cost: 5000,
      tax: "default",
    },
    {
      id: "LI",
      name: "Limonada",
      category: "Bebidas",
      kind: "product",
      price: 4500,
      station: "Barra",
      groups: [],
      recipe: [{ stock: "T4", qty: 0.1, typed: g("100") }],
      cost: 800,
      tax: "default",
    },
    {
      id: "CE",
      name: "Cerveza artesanal",
      category: "Bebidas",
      kind: "product",
      price: 8500,
      station: "Barra",
      groups: [],
      recipe: [],
      cost: 3500,
      tax: "default",
    },
    {
      id: "FL",
      name: "Flan napolitano",
      category: "Postres",
      kind: "product",
      price: 7000,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 1800,
      tax: "default",
    },
    {
      id: "CA",
      name: "Café de Chiapas en grano 250 g",
      category: "Tienda",
      kind: "product",
      price: 15000,
      station: "Barra",
      groups: [],
      recipe: [],
      cost: 9000,
      tax: "iva0",
    },
  ] satisfies ProductDef[],
  openingCash: 200000,
  countedCash: 434500,
};

export type Round = { lines: Line[]; note?: string };
export type CheckDef = {
  id: string;
  number: number;
  table: string;
  /** table after a transfer */
  movedTo?: string;
  waiter: string;
  orderNote?: string;
  rounds: Round[];
  payments: Payment[];
};

/** §7.7 check book B1–B7 (Karla collects every payment). */
export const CHECKS_B: CheckDef[] = [
  {
    id: "B1",
    number: 1,
    table: "Mesa 1",
    waiter: "sofia",
    orderNote: "Cumpleaños: vela en el flan",
    rounds: [
      {
        lines: [
          { product: "GU", qty: 1, note: "Sin cilantro" },
          { product: "LI", qty: 4 },
        ],
      },
      {
        note: "Los fuertes juntos",
        lines: [
          { product: "AR", qty: 1, options: ["Medio", "Papas"] },
          { product: "AR", qty: 1, options: ["Tres cuartos", "Ensalada"] },
          { product: "PZ", qty: 1, options: ["Arroz"] },
          { product: "EN", qty: 1, options: ["Queso extra"] },
        ],
      },
      { note: "Con vela en uno", lines: [{ product: "FL", qty: 2 }] },
    ],
    payments: [
      { method: "external", amount: 60000, ref: "200101", tip: 9000 },
      { method: "external", amount: 60000, ref: "200102", tip: 9000 },
      { method: "cash", amount: 41000, tip: 5000, bill: 500 },
    ],
  },
  {
    id: "B2",
    number: 2,
    table: "Mesa 2",
    movedTo: "Terraza 1",
    waiter: "tomas",
    rounds: [
      {
        lines: [
          { product: "TA", qty: 2 },
          { product: "CE", qty: 2 },
        ],
      },
      { lines: [{ product: "EN", qty: 2 }] },
    ],
    payments: [
      {
        method: "external",
        ref: "200201",
        tip: 5400,
        units: [
          "Tostada de atún · 1",
          "Cerveza artesanal · 1",
          "Enchiladas suizas · 1",
        ],
      },
      { method: "cash", amount: 36000, bill: 400 },
    ],
  },
  {
    id: "B3",
    number: 3,
    table: "Mesa 3",
    waiter: "sofia",
    orderNote: "ALERGIA: mariscos",
    rounds: [
      {
        lines: [
          { product: "AR", qty: 1, options: ["Bien cocido", "Papas"] },
          { product: "LI", qty: 1 },
        ],
      },
    ],
    payments: [{ method: "external", amount: 38500, ref: "200301", tip: 5000 }],
  },
  {
    id: "B4",
    number: 4,
    table: "Terraza 2",
    waiter: "tomas",
    rounds: [
      { lines: [{ product: "CE", qty: 2 }] },
      {
        lines: [
          { product: "GU", qty: 1 },
          { product: "PZ", qty: 1, options: ["Papas"] },
        ],
      },
    ],
    payments: [{ method: "cash", amount: 58000, tip: 6000, bill: 700 }],
  },
  {
    id: "B5",
    number: 5,
    table: "Mesa 4",
    waiter: "sofia",
    rounds: [
      {
        lines: [
          { product: "LI", qty: 1 },
          { product: "CA", qty: 1 },
        ],
      },
      { lines: [{ product: "EN", qty: 1, options: ["Aguacate extra"] }] },
    ],
    payments: [{ method: "cash", amount: 40000, tip: 4000, bill: 500 }],
  },
  {
    id: "B6",
    number: 6,
    table: "Terraza 2",
    waiter: "tomas",
    rounds: [
      {
        lines: [
          { product: "TA", qty: 2 },
          { product: "LI", qty: 2 },
        ],
      },
    ],
    payments: [{ method: "external", amount: 28000, ref: "200601", tip: 2800 }],
  },
  {
    id: "B7",
    number: 7,
    table: "Mesa 5",
    waiter: "tomas",
    rounds: [
      {
        lines: [
          { product: "GU", qty: 1 },
          { product: "CE", qty: 3 },
        ],
      },
      { lines: [{ product: "FL", qty: 1 }] },
    ],
    payments: [{ method: "cash", amount: 44500, bill: 500 }],
  },
];

/**
 * Branch L (loyalty spec §9.4, lead decision LD-80): a third restaurant, created like A and B,
 * that runs the club through the UI: a member joins at the prompt, earns a full card, redeems it,
 * and a refund reverses one of her stamps. A counter service in Mexico City with a SAT test RFC;
 * no stock, modifiers or kitchen display (nothing here is about them).
 */
export const RESTAURANT_L = {
  owner: {
    name: "Inés Robledo Garza",
    email: "ines.robledo@elmezquite.invalid",
    subjectSeed: "restaurant-day/owner-l",
  },
  name: "Tortas El Mezquite",
  timezone: "America/Mexico_City",
  fiscal: {
    rfc: "IIA040805DZ4",
    legalName: "Tortas El Mezquite",
    regime: "601",
    regimeLabel: "601 — General de Ley Personas Morales",
    receiptRegime: "601 General de Ley Personas Morales",
    zip: "03100",
    street: "Av. Coyoacán 1435",
    neighborhood: "Del Valle",
    municipality: "Benito Juárez",
    state: "Ciudad de México",
    series: "L",
  },
  staff: [
    {
      key: "ines",
      name: "Inés Robledo Garza",
      role: "owner",
      roleLabel: "Propietario",
      pin: "604913",
    },
    {
      key: "joaquin",
      name: "Joaquín Peralta",
      role: "manager",
      roleLabel: "Responsable",
      pin: "582047",
    },
    {
      key: "mariana",
      name: "Mariana Ríos",
      role: "cashier",
      roleLabel: "Cajero",
      pin: "736158",
    },
  ] satisfies Staff[],
  devices: ["Caja"],
  stock: [] as StockDef[],
  groups: [] as GroupDef[],
  categories: ["Tortas", "Bebidas"],
  products: [
    {
      id: "TM",
      name: "Torta de milanesa",
      category: "Tortas",
      kind: "product",
      price: 9500,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 3200,
      tax: "default",
    },
    {
      id: "TC",
      name: "Torta cubana",
      category: "Tortas",
      kind: "product",
      price: 12000,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 4800,
      tax: "default",
    },
    {
      id: "RV",
      name: "Refresco de vidrio",
      category: "Bebidas",
      kind: "product",
      price: 3000,
      station: "Barra",
      groups: [],
      recipe: [],
      cost: 1100,
      tax: "default",
    },
  ] satisfies ProductDef[],
  openingCash: 100000,
};

/**
 * Restaurant L's club (Configuración › Club de lealtad): three stamps a card, one stamp per paid
 * purchase plus one per full $50.00 of its stamp base (non-platform tenders net of refunds), and
 * the default reward, one product up to $150.00. Rosa and her 55 5000 0xxx phone are fictional.
 */
export const CLUB_L = {
  programName: "Club El Mezquite",
  privacyNoticeUrl: "https://elmezquite.invalid/aviso-de-privacidad",
  stampsRequired: 3,
  threshold: 5000,
  rewardCap: 15000,
  rewardDescription: "Un producto gratis",
  member: { name: "Rosa Ibáñez", firstName: "Rosa", phone: "5550000271" },
};

/**
 * Branch L order book (Mariana collects every sale). L1: Rosa joins at the prompt and her first
 * purchase completes a card; L2: a walk-in answers "Sin club" and gets the join QR; L3: Rosa
 * redeems her reward on the torta cubana and pays the rest by card.
 */
export const ORDERS_L: OrderDef[] = [
  {
    id: "L1",
    number: 1,
    cashier: "mariana",
    callName: "Rosa",
    club: "enroll",
    lines: [
      { product: "TM", qty: 1 },
      { product: "RV", qty: 1 },
    ],
    payment: { method: "cash", bill: 200 },
  },
  {
    id: "L2",
    number: 2,
    cashier: "mariana",
    club: "skip",
    lines: [{ product: "TM", qty: 1 }],
    payment: { method: "cash", bill: 100 },
  },
  {
    id: "L3",
    number: 3,
    cashier: "mariana",
    callName: "Rosa",
    club: "lookup",
    reward: { line: 0 },
    lines: [
      { product: "TC", qty: 1 },
      { product: "RV", qty: 1 },
    ],
    payment: { method: "external", ref: "300003" },
  },
];

/** Branch L: a cash refund on L1 that lowers its stamp base below a threshold (Joaquín approves). */
export const REFUNDS_L: RefundDef[] = [
  {
    id: "RL1",
    order: "L1",
    actor: "mariana",
    approver: "joaquin",
    method: "cash",
    amount: 3000,
    reasonLabel: "Producto con defecto o queja",
    explanation: "Refresco sin gas",
  },
];

/** RFC 4122 UUIDv5 namespace for URLs (§3.7: Google subjects). */
export const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
