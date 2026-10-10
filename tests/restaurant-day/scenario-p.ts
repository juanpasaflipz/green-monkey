/**
 * Restaurant-day branch P (payments spec §12.4, lead decision LD-80): Restaurant P and its day,
 * pure data. Money is integer centavos. It runs in its own CI job against the payments fake
 * (tests/fakes/payments-fake.ts), so Restaurants A, B and L and their literal tables never meet
 * it. Names, PINs and references are fictional and contain none of the G3 denylisted words
 * (§3.7); the card data is the providers' test data (visa 4242 and 4444) and the provider
 * credentials are the fake's own ("…-not-real").
 */
import type { ProductDef, Staff, StockDef, GroupDef } from "./scenario.js";

export const RESTAURANT_P = {
  owner: {
    name: "Rebeca Montaño Villalobos",
    email: "rebeca.montano@laceiba.invalid",
    subjectSeed: "restaurant-day/owner-p",
  },
  name: "Fonda La Ceiba",
  timezone: "America/Mexico_City",
  fiscal: {
    rfc: "URE180429TM6",
    legalName: "Fonda La Ceiba",
    regime: "601",
    regimeLabel: "601 — General de Ley Personas Morales",
    receiptRegime: "601 General de Ley Personas Morales",
    zip: "06140",
    street: "Calle Amsterdam 210",
    neighborhood: "Hipódromo",
    municipality: "Cuauhtémoc",
    state: "Ciudad de México",
    series: "P",
  },
  staff: [
    {
      key: "rebeca",
      name: "Rebeca Montaño Villalobos",
      role: "owner",
      roleLabel: "Propietario",
      pin: "713046",
    },
    {
      key: "ulises",
      name: "Ulises Báez",
      role: "manager",
      roleLabel: "Responsable",
      pin: "269581",
    },
    {
      key: "ximena",
      name: "Ximena Torres",
      role: "cashier",
      roleLabel: "Cajero",
      pin: "845302",
    },
  ] satisfies Staff[],
  devices: ["Caja"],
  stock: [] as StockDef[],
  groups: [] as GroupDef[],
  categories: ["Platillos", "Bebidas"],
  products: [
    {
      id: "EV",
      name: "Enchiladas verdes",
      category: "Platillos",
      kind: "product",
      price: 11000,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 3800,
      tax: "default",
    },
    {
      id: "PR",
      name: "Pozole rojo",
      category: "Platillos",
      kind: "product",
      price: 13500,
      station: "Cocina",
      groups: [],
      recipe: [],
      cost: 4600,
      tax: "default",
    },
    {
      id: "AT",
      name: "Agua de tamarindo",
      category: "Bebidas",
      kind: "product",
      price: 3500,
      station: "Barra",
      groups: [],
      recipe: [],
      cost: 700,
      tax: "default",
    },
  ] satisfies ProductDef[],
  openingCash: 100000,
  /** Ulises counts exactly what the drawer expects (no difference to review). */
  countedCash: 117000,
};

export type TerminalKey = "mp" | "clip" | "bbva";
export type PlatformKey = "uber_eats" | "rappi" | "didi_food";

/**
 * Configuración › Pagos con tarjeta y plataformas, as the owner sets it up: Mercado Pago and Clip
 * connected with the fake's credentials and one device each added as a terminal, a manual bank
 * terminal, three platforms with their estimated commission and the platform prices.
 */
export const PAYMENTS_P = {
  credentials: {
    mercadopago: {
      // Not "TEST-…": the production-mode web refuses MP test tokens for Point; the fake is
      // started with this one (PAYMENTS_FAKE_MP_TOKEN).
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
      name: "MP Mostrador",
      provider: "mercadopago",
      device: "NEWLAND_N950__FAKE0001",
      feeText: "3.5",
      feeBp: 350,
    },
    clip: {
      name: "Clip Mostrador",
      provider: "clip",
      device: "P8220724FAKE01",
      feeText: "3.6",
      feeBp: 360,
    },
    bbva: {
      name: "BBVA",
      provider: null,
      device: null,
      feeText: "1.75",
      feeBp: 175,
    },
  } as Record<
    TerminalKey,
    {
      name: string;
      provider: "mercadopago" | "clip" | null;
      device: string | null;
      feeText: string;
      feeBp: number;
    }
  >,
  platforms: {
    uber_eats: { label: "Uber Eats", commissionText: "30", commissionBp: 3000 },
    rappi: { label: "Rappi", commissionText: "25", commissionBp: 2500 },
    didi_food: { label: "DiDi Food", commissionText: "22", commissionBp: 2200 },
  } as Record<
    PlatformKey,
    { label: string; commissionText: string; commissionBp: number }
  >,
  /** Product id → platform → price (centavos). Only these products sell on that platform. */
  prices: {
    EV: { uber_eats: 13000, didi_food: 12500 },
    PR: { rappi: 15000 },
    AT: { uber_eats: 4500 },
  } as Record<string, Partial<Record<PlatformKey, number>>>,
};

/**
 * How one order of branch P is paid:
 * - `integrated`: «Tarjeta» → an integrated terminal → «Enviar a …»; the fake approves (card,
 *   and MP's own fee when given), declines, or loses Clip's answer after the reader took it
 *   (`unknown`: a manager records it with the provider's reference);
 * - `manual`: «Tarjeta» → the manual terminal, with the approval reference;
 * - `declinedThenCash`: an integrated charge the card refuses, then «Otra forma de pago» → cash;
 * - `platform`: the order rung at the platform's prices, paid by the platform.
 */
export type PaymentP =
  | {
      kind: "integrated";
      terminal: "mp" | "clip";
      tip?: number;
      card: {
        brand: "visa";
        type: "credit_card" | "debit_card";
        last4: string;
      };
      /** MP reports its fee; Clip's is estimated from the terminal's rate. */
      providerFee?: number;
    }
  | {
      kind: "unknown";
      terminal: "clip";
      /** The manager's «Resolver cobro»: the reference from the provider's history. */
      reference: string;
      note: string;
    }
  | { kind: "manual"; terminal: "bbva"; reference: string }
  | { kind: "declinedThenCash"; terminal: "mp"; bill: number }
  | { kind: "platform"; platform: PlatformKey; orderNumber: string };

export type OrderP = {
  id: string;
  number: number;
  lines: { product: string; qty: number }[];
  payment: PaymentP;
};

/** Branch P order book: Ximena sells every order at the one register. */
export const ORDERS_P: OrderP[] = [
  {
    id: "P1",
    number: 1,
    lines: [
      { product: "EV", qty: 1 },
      { product: "AT", qty: 1 },
    ],
    payment: {
      kind: "integrated",
      terminal: "mp",
      tip: 1500,
      card: { brand: "visa", type: "credit_card", last4: "4242" },
      // Not the 3.5 % estimate ($5.60): the amount alone shows MP's own fee was used (GATE-6).
      providerFee: 581,
    },
  },
  {
    id: "P2",
    number: 2,
    lines: [{ product: "PR", qty: 1 }],
    payment: {
      kind: "integrated",
      terminal: "clip",
      // Clip takes the tip apart (tip_amount) and its fee is estimated on bill + tip (GATE-6).
      tip: 2000,
      card: { brand: "visa", type: "debit_card", last4: "4444" },
    },
  },
  {
    id: "P3",
    number: 3,
    lines: [{ product: "EV", qty: 1 }],
    payment: { kind: "manual", terminal: "bbva", reference: "100003" },
  },
  {
    id: "P4",
    number: 4,
    lines: [
      { product: "PR", qty: 1 },
      { product: "AT", qty: 1 },
    ],
    payment: { kind: "declinedThenCash", terminal: "mp", bill: 200 },
  },
  {
    id: "P5",
    number: 5,
    lines: [
      { product: "EV", qty: 1 },
      { product: "PR", qty: 1 },
    ],
    payment: {
      kind: "unknown",
      terminal: "clip",
      reference: "AUT100005",
      note: "Aprobado en el lector; lo confirmé en el historial de Clip",
    },
  },
  {
    id: "P6",
    number: 6,
    lines: [
      { product: "EV", qty: 1 },
      { product: "AT", qty: 1 },
    ],
    payment: {
      kind: "platform",
      platform: "uber_eats",
      orderNumber: "UE-1006",
    },
  },
  {
    id: "P7",
    number: 7,
    lines: [{ product: "PR", qty: 1 }],
    payment: { kind: "platform", platform: "rappi", orderNumber: "RP-1007" },
  },
  {
    id: "P8",
    number: 8,
    lines: [{ product: "EV", qty: 2 }],
    payment: {
      kind: "platform",
      platform: "didi_food",
      orderNumber: "DD-1008",
    },
  },
];

/**
 * Branch P's refund (payments spec §12.4; P2V-GATE-3): after the service Ulises refunds part of
 * a platform order through the refund dialog («Por importe»). The platform pays it back, so it is
 * never cash: expected cash does not move, and the platform's net drops.
 */
export const REFUNDS_P = [
  {
    id: "RP1",
    order: "P7",
    actor: "ulises",
    amount: 5000,
    reasonLabel: "Producto con defecto o queja",
    reasonCode: "quality",
    explanation: "Rappi devolvió parte del pozole",
  },
] as const;

/**
 * The CFDI forms of payment (SAT FormaPago, c_FormaPago) the restaurant's settings give, as
 * cfdi_settings sets them by default (030/037): an external tender with no card type takes the
 * card form 04, a platform tender the platform form 31.
 */
export const CFDI_FORMS_P = { card: "04", platform: "31" } as const;
