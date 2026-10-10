/**
 * Branch P's expected day (payments spec §12.4, LD-80), typed in by hand from scenario-p.ts and
 * the rules in oracle-p.ts (double entry, acceptance §5.1): the P self-check and
 * tests/restaurant-day-oracle.test.ts require oracleP() to equal it. Restaurants A, B and L keep
 * their own tables in expected.ts, untouched.
 *
 * Worked figures: IVA 16 % extracted per ticket (R6), e.g. $135.00 → tax $18.62, base $116.38.
 * Fees half-up on amount + tip: Clip 3.6 % of $135.00 + $20.00 tip = $155.00 → $5.58 (5.58); of
 * $245.00 = $8.82 (8.82); BBVA 1.75 % of $110.00 = $1.93 (1.925 → 1.93); MP's own fee on P1,
 * $5.81, as the provider reports it (its 3.5 % estimate would be $5.60). Commissions on the
 * amount: Uber Eats 30 % of $175.00 = $52.50, Rappi 25 % of $150.00 = $37.50, DiDi Food 22 % of
 * $250.00 = $55.00. Ulises refunds $50.00 of P7 (Rappi): the platform pays it back, so Rappi's net
 * is $100.00, its commission stays $37.50 and expected cash stays $1,170.00. FormaPago: P1 credit
 * 04, P2 debit 28, P3 and P5 (no card type) the card form 04, P4 cash 01, P6-P8 the platform form
 * 31; the global's largest net ticket is P8's $250.00 (DiDi Food) → 31, over 8 concepts totalling
 * $1,380.00 − $50.00 = $1,330.00.
 */
export const EXPECTED_P = {
  tickets: [
    {
      folio: "P-000001",
      number: 1,
      total: "$145.00",
      base: "$125.00",
      tax: "$20.00",
    },
    {
      folio: "P-000002",
      number: 2,
      total: "$135.00",
      base: "$116.38",
      tax: "$18.62",
    },
    {
      folio: "P-000003",
      number: 3,
      total: "$110.00",
      base: "$94.83",
      tax: "$15.17",
    },
    {
      folio: "P-000004",
      number: 4,
      total: "$170.00",
      base: "$146.55",
      tax: "$23.45",
    },
    {
      folio: "P-000005",
      number: 5,
      total: "$245.00",
      base: "$211.21",
      tax: "$33.79",
    },
    {
      folio: "P-000006",
      number: 6,
      total: "$175.00",
      base: "$150.86",
      tax: "$24.14",
    },
    {
      folio: "P-000007",
      number: 7,
      total: "$150.00",
      base: "$129.31",
      tax: "$20.69",
    },
    {
      folio: "P-000008",
      number: 8,
      total: "$250.00",
      base: "$215.52",
      tax: "$34.48",
    },
  ],
  tenders: [
    {
      order: "P1",
      method: "external",
      amount: "$145.00",
      tip: "$15.00",
      terminal: "MP Mostrador",
      platform: null,
      card: "visa credit 4242",
      fee: "$5.81",
      feeSource: "provider",
    },
    {
      order: "P2",
      method: "external",
      amount: "$135.00",
      tip: "$20.00",
      terminal: "Clip Mostrador",
      platform: null,
      card: "visa debit 4444",
      fee: "$5.58",
      feeSource: "estimated",
    },
    {
      order: "P3",
      method: "external",
      amount: "$110.00",
      tip: "$0.00",
      terminal: "BBVA",
      platform: null,
      card: null,
      fee: "$1.93",
      feeSource: "estimated",
    },
    {
      order: "P4",
      method: "cash",
      amount: "$170.00",
      tip: "$0.00",
      terminal: null,
      platform: null,
      card: null,
      fee: null,
      feeSource: null,
    },
    {
      order: "P5",
      method: "external",
      amount: "$245.00",
      tip: "$0.00",
      terminal: "Clip Mostrador",
      platform: null,
      card: null,
      fee: "$8.82",
      feeSource: "estimated",
    },
    {
      order: "P6",
      method: "platform",
      amount: "$175.00",
      tip: "$0.00",
      terminal: null,
      platform: "uber_eats",
      card: null,
      fee: "$52.50",
      feeSource: "estimated",
    },
    {
      order: "P7",
      method: "platform",
      amount: "$150.00",
      tip: "$0.00",
      terminal: null,
      platform: "rappi",
      card: null,
      fee: "$37.50",
      feeSource: "estimated",
    },
    {
      order: "P8",
      method: "platform",
      amount: "$250.00",
      tip: "$0.00",
      terminal: null,
      platform: "didi_food",
      card: null,
      fee: "$55.00",
      feeSource: "estimated",
    },
  ],
  attempts: [
    {
      order: "P1",
      terminal: "mp",
      state: "settled",
      errorCode: null,
      resolution: null,
    },
    {
      order: "P2",
      terminal: "clip",
      state: "settled",
      errorCode: null,
      resolution: null,
    },
    {
      order: "P4",
      terminal: "mp",
      state: "declined",
      errorCode: "payments_card_declined",
      resolution: null,
    },
    {
      order: "P5",
      terminal: "clip",
      state: "settled",
      errorCode: "payments_clip_create_outcome_unknown",
      resolution: "recorded",
    },
  ],
  corteZ: {
    cash: {
      opening: "$1,000.00",
      sales: "$170.00",
      expected: "$1,170.00",
      counted: "$1,170.00",
      difference: "$0.00",
    },
    terminal: {
      count: 4,
      sales: "$635.00",
      tips: "$35.00",
      net: "$670.00",
      reported: "$670.00",
      byTerminal: {
        "MP Mostrador (1)": { net: "$160.00", batch: "$160.00", fees: "$5.81" },
        "Clip Mostrador (2)": {
          net: "$400.00",
          batch: "$400.00",
          fees: "$14.40",
        },
        "BBVA (1)": { net: "$110.00", batch: "$110.00", fees: "$1.93" },
      },
    },
    platforms: {
      "Uber Eats (1)": { net: "$175.00", commission: "$52.50" },
      "Rappi (1)": { net: "$100.00", commission: "$37.50" },
      "DiDi Food (1)": { net: "$250.00", commission: "$55.00" },
    },
    payments: 8,
    folios: "P-000001 a P-000008",
    tickets: 8,
  },
  finance: {
    byTerminal: [
      ["MP Mostrador", "1", "$145.00", "$15.00", "$0.00", "$5.81", "$154.19"],
      [
        "Clip Mostrador",
        "2",
        "$380.00",
        "$20.00",
        "$0.00",
        "$14.40 (estimadas)",
        "$385.60",
      ],
      [
        "BBVA",
        "1",
        "$110.00",
        "$0.00",
        "$0.00",
        "$1.93 (estimadas)",
        "$108.07",
      ],
    ],
    byPlatform: [
      ["Uber Eats", "1", "$175.00", "$0.00", "$52.50", "$175.00", "$122.50"],
      ["Rappi", "1", "$150.00", "$50.00", "$37.50", "$100.00", "$62.50"],
      ["DiDi Food", "1", "$250.00", "$0.00", "$55.00", "$250.00", "$195.00"],
    ],
    byMethod: [
      ["Efectivo", "1", "$170.00", "$0.00", "$0.00", "$170.00"],
      [
        "Terminal bancaria externa",
        "4",
        "$635.00",
        "$35.00",
        "$0.00",
        "$670.00",
      ],
      ["Plataforma", "3", "$575.00", "$0.00", "$50.00", "$525.00"],
    ],
    byMethodTotal: ["Total", "8", "$1,380.00", "$35.00", "$50.00", "$1,365.00"],
    collected: "$1,380.00",
  },
  refunds: [
    {
      order: 7,
      amount: "$50.00",
      cash: "$0.00",
      external: "$0.00",
      platform: "$50.00",
      reason: "quality",
      note: "Rappi devolvió parte del pozole",
      actor: "Ulises Báez",
    },
  ],
  cfdi: {
    forms: {
      "P-000001": "04",
      "P-000002": "28",
      "P-000003": "04",
      "P-000004": "01",
      "P-000005": "04",
      "P-000006": "31",
      "P-000007": "31",
      "P-000008": "31",
    },
    global: { form: "31", concepts: 8, total: "$1,330.00" },
  },
  exception: { number: 5, amount: "$245.00", terminal: "Clip Mostrador" },
};

/**
 * The payments fake's charges at the end of branch P's day, per device in creation order
 * (P2V-GATE-5), typed in by hand: MP's amount is the total with the tip; Clip's is the bill, its
 * tip apart. P4's card was refused; P5's answer was lost after the reader took it, and the
 * reader completed it after Ulises recorded it from Clip's history. A duplicate push would add a
 * row.
 */
export const FAKE_CHARGES_P: Record<
  string,
  { order: string; amount: number; tip: number; status: string }[]
> = {
  NEWLAND_N950__FAKE0001: [
    { order: "P1", amount: 16000, tip: 0, status: "processed" },
    { order: "P4", amount: 17000, tip: 0, status: "failed" },
  ],
  P8220724FAKE01: [
    { order: "P2", amount: 13500, tip: 2000, status: "processed" },
    { order: "P5", amount: 24500, tip: 0, status: "processed" },
  ],
};
