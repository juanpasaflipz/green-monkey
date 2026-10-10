/**
 * Restaurant-day branch S (kiosk self-checkout, migration 039; critic R47, lead decisions LD-80
 * and LD-89): Restaurant S and its day, pure data. Money is integer centavos. It runs in the
 * restaurant-day-payments job right after branch P, against the same payments fake, in its own
 * restaurant, so Restaurants A, B, L and P and their literal tables never meet it. Names, PINs
 * and phones are fictional and contain none of the G3 denylisted words (§3.7); the card data is
 * the providers' test data (visa 4242 and 4444) and the provider credentials are the fake's own
 * ("…-not-real").
 *
 * The day: guests order on two bound kiosk tablets, «Entrada» on the Mercado Pago reader and
 * «Terraza» on the Clip reader, both receiving into the one register's drawer, and pay by card;
 * each paid order reaches the kitchen with no staff tap (LD-72, on payment only). One charge is
 * approved after its product was 86'd (review) and an operator's «Reintentar» settles it once the
 * product is back; another is approved after a price rose and the manager accepts it with the
 * kiosk payment, collecting the difference in cash (critic R13). A guest adds a suggested side, and
 * a club member identifies at the kiosk, which shows counts and a masked phone only (critic R20).
 */
import type { ProductDef, Staff, StockDef, GroupDef } from "./scenario.js";

export const RESTAURANT_S = {
  owner: {
    name: "Fernanda Ríos Calderón",
    email: "fernanda.rios@lapitaya.invalid",
    subjectSeed: "restaurant-day/owner-s",
  },
  name: "Antojitos La Pitaya",
  timezone: "America/Mexico_City",
  fiscal: {
    rfc: "XIA190128J61",
    legalName: "Antojitos La Pitaya",
    regime: "601",
    regimeLabel: "601 — General de Ley Personas Morales",
    receiptRegime: "601 General de Ley Personas Morales",
    zip: "06700",
    street: "Calle Colima 418",
    neighborhood: "Roma Norte",
    municipality: "Cuauhtémoc",
    state: "Ciudad de México",
    series: "S",
  },
  staff: [
    {
      key: "fernanda",
      name: "Fernanda Ríos Calderón",
      role: "owner",
      roleLabel: "Propietario",
      pin: "582147",
    },
    {
      key: "saul",
      name: "Saúl Medina Ortiz",
      role: "manager",
      roleLabel: "Responsable",
      pin: "316804",
    },
    {
      key: "ines",
      name: "Inés Carrillo",
      role: "cashier",
      roleLabel: "Cajero",
      pin: "940263",
    },
  ] satisfies Staff[],
  devices: ["Caja"],
  stock: [] as StockDef[],
  groups: [] as GroupDef[],
  categories: ["Platillos", "Bebidas", "Acompañantes"],
  products: [
    {
      id: "QQ",
      name: "Quesadilla de queso",
      category: "Platillos",
      kind: "product",
      price: 6000,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 1800,
      tax: "default",
    },
    {
      id: "TM",
      name: "Torta de milanesa",
      category: "Platillos",
      kind: "product",
      price: 9500,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 3100,
      tax: "default",
    },
    {
      id: "AH",
      name: "Agua de horchata",
      category: "Bebidas",
      kind: "product",
      price: 3000,
      station: "Barra",
      groups: [],
      recipe: [],
      cost: 600,
      tax: "default",
    },
    {
      id: "PF",
      name: "Papas fritas",
      category: "Acompañantes",
      kind: "product",
      price: 4500,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 1200,
      tax: "default",
    },
  ] satisfies ProductDef[],
  openingCash: 50000,
  /** Saúl counts exactly what the drawer expects (no difference to review). */
  countedCash: 51500,
  /** The restaurant's own privacy notice (the club needs it before it can be turned on). */
  privacyNoticeUrl: "https://lapitaya.invalid/aviso-de-privacidad",
};

export type TerminalKeyS = "mp" | "clip";

/**
 * Configuración › Pagos con tarjeta y plataformas, as the owner sets it up for the kiosks:
 * Mercado Pago and Clip connected with the fake's credentials, one device each as a terminal.
 */
export const PAYMENTS_S = {
  credentials: {
    mercadopago: {
      token: "rd-mp-access-token-not-real-0000",
      secret: "testWebhookSecretNotReal0000",
      account: "RESTAURANTE_FICTICIO",
    },
    clip: {
      key: "test-clip-api-key-not-real",
      secret: "test-clip-secret-key-not-real",
    },
  },
  terminals: {
    mp: {
      name: "MP Kiosco",
      provider: "mercadopago",
      device: "NEWLAND_N950__FAKE0001",
      feeText: "3.5",
      feeBp: 350,
    },
    clip: {
      name: "Clip Kiosco",
      provider: "clip",
      device: "P8220724FAKE01",
      feeText: "3.6",
      feeBp: 360,
    },
  } as Record<
    TerminalKeyS,
    {
      name: string;
      provider: "mercadopago" | "clip";
      device: string;
      feeText: string;
      feeBp: number;
    }
  >,
};

/** The two kiosks (links and their stations): each reader, both into the register's drawer. */
export const KIOSKS_S = {
  entrada: { label: "Entrada", terminal: "mp" as TerminalKeyS },
  terraza: { label: "Terraza", terminal: "clip" as TerminalKeyS },
} as const;
export type KioskKeyS = keyof typeof KIOSKS_S;

/** Configuración › Kiosco de autoservicio. */
export const KIOSK_SETTINGS_S = {
  paymentMode: "Tarjeta en el kiosco o en caja",
  askFulfillment: true,
  suggestions: true,
  /** «Sugerencias del carrito»: the side guests are offered under «¿Algo más?». */
  cartSuggestions: ["PF"],
};

/** Configuración › Club de lealtad: one stamp per paid order (no extra-stamp threshold). */
export const CLUB_S = {
  programName: "Club La Pitaya",
  stampsRequired: 6,
  threshold: 0,
  member: {
    name: "Rodrigo Salas",
    firstName: "Rodrigo",
    /** 555-0100 to 555-0199 are the numbers reserved for fiction. */
    phone: "5555550147",
    /** The keypad's display after ten digits (KIOSK-UX-16: one dot per digit, the last four). */
    masked: "•••••• 01 47 · 10/10",
  },
};

/**
 * How one kiosk order of branch S is paid and resolved:
 * - `approved`: the card is approved on the station's reader; the settle creates the order;
 * - `retry`: the product is 86'd while the guest pays, the charge is approved (review,
 *   kiosk_settle_unavailable); the owner puts the product back and the cashier's
 *   «Reintentar» (no PIN) creates the order;
 * - `acceptWithRest`: the product's price rises while the guest pays (review,
 *   kiosk_settle_price_changed); the manager's «Aceptar con el pago del kiosco» accepts the hold
 *   at today's price with the charge as its card tender and collects the difference in cash.
 */
export type ResolutionS =
  | { kind: "approved" }
  | { kind: "retry"; product: string }
  | {
      kind: "acceptWithRest";
      product: string;
      newPrice: number;
      note: string;
      /** The cash the guest hands over for the difference. */
      received: number;
    };

export type OrderS = {
  id: string;
  /** The order number the settle or the accept gives it, in the order the day creates them. */
  number: number;
  kiosk: KioskKeyS;
  fulfillment: "here" | "to_go";
  name: string;
  /** Lines the guest adds from the menu. */
  lines: { product: string; qty: number }[];
  /** A product the guest adds from «¿Algo más?» (a suggestion line). */
  suggestion?: string;
  /** The guest identifies as a club member at the welcome screen first. */
  member?: true;
  card: { brand: "visa"; type: "credit_card" | "debit_card"; last4: string };
  resolution: ResolutionS;
};

/** Branch S's order book, in the order the day plays it. */
export const ORDERS_S: OrderS[] = [
  {
    id: "S1",
    number: 1,
    kiosk: "entrada",
    fulfillment: "here",
    name: "Lucía",
    lines: [{ product: "QQ", qty: 1 }],
    suggestion: "PF",
    card: { brand: "visa", type: "credit_card", last4: "4242" },
    resolution: { kind: "approved" },
  },
  {
    id: "S2",
    number: 2,
    kiosk: "terraza",
    fulfillment: "to_go",
    name: "Rodrigo",
    lines: [
      { product: "TM", qty: 1 },
      { product: "AH", qty: 1 },
    ],
    member: true,
    card: { brand: "visa", type: "debit_card", last4: "4444" },
    resolution: { kind: "approved" },
  },
  {
    id: "S3",
    number: 3,
    kiosk: "entrada",
    fulfillment: "here",
    name: "Paola",
    lines: [{ product: "QQ", qty: 2 }],
    card: { brand: "visa", type: "credit_card", last4: "4242" },
    resolution: { kind: "retry", product: "QQ" },
  },
  {
    id: "S4",
    number: 4,
    kiosk: "terraza",
    fulfillment: "to_go",
    name: "Tomás",
    lines: [{ product: "TM", qty: 1 }],
    card: { brand: "visa", type: "credit_card", last4: "4242" },
    resolution: {
      kind: "acceptWithRest",
      product: "TM",
      newPrice: 11000,
      note: "Subió el precio de la torta; se cobra la diferencia en efectivo",
      received: 2000,
    },
  },
];
