/**
 * Branch S's expected day (kiosk self-checkout, 039; critic R47; LD-80), typed in by hand from
 * scenario-s.ts and the rules in oracle-s.ts (double entry, acceptance §5.1): the S self-check
 * and tests/restaurant-day-oracle.test.ts require oracleS() to equal it. Restaurants A, B, L and
 * P keep their own tables, untouched.
 *
 * Worked figures: S1 $60.00 + the suggested $45.00 side = $105.00; S2 $95.00 + $30.00 =
 * $125.00; S3 2 × $60.00 = $120.00; S4 was charged $95.00 and accepted at today's $110.00, the
 * $15.00 difference paid in cash. IVA 16 % extracted per ticket (R6): $105.00 → $14.48 (1448.28),
 * $125.00 → $17.24 (1724.14), $120.00 → $16.55 (1655.17), $110.00 → $15.17 (1517.24). Fees
 * half-up on the amount (no tips at a kiosk): MP 3.5 % of $105.00 = $3.68 (367.5 → 368) and of
 * $120.00 = $4.20; Clip 3.6 % of $125.00 = $4.50 and of $95.00 = $3.42 (342.0). MP's two kiosk
 * tenders net $225.00 with $7.88 of fees, Clip's $220.00 with $7.92; the drawer expects $500.00 +
 * $15.00 = $515.00.
 */
export const EXPECTED_S = {
  tickets: [
    {
      folio: "S-000001",
      number: 1,
      total: "$105.00",
      base: "$90.52",
      tax: "$14.48",
    },
    {
      folio: "S-000002",
      number: 2,
      total: "$125.00",
      base: "$107.76",
      tax: "$17.24",
    },
    {
      folio: "S-000003",
      number: 3,
      total: "$120.00",
      base: "$103.45",
      tax: "$16.55",
    },
    {
      folio: "S-000004",
      number: 4,
      total: "$110.00",
      base: "$94.83",
      tax: "$15.17",
    },
  ],
  tenders: [
    {
      order: "S1",
      method: "external",
      amount: "$105.00",
      terminal: "MP Kiosco",
      card: "visa credit 4242",
      fee: "$3.68",
    },
    {
      order: "S2",
      method: "external",
      amount: "$125.00",
      terminal: "Clip Kiosco",
      card: "visa debit 4444",
      fee: "$4.50",
    },
    {
      order: "S3",
      method: "external",
      amount: "$120.00",
      terminal: "MP Kiosco",
      card: "visa credit 4242",
      fee: "$4.20",
    },
    {
      order: "S4",
      method: "external",
      amount: "$95.00",
      terminal: "Clip Kiosco",
      card: "visa credit 4242",
      fee: "$3.42",
    },
    {
      order: "S4",
      method: "cash",
      amount: "$15.00",
      terminal: null,
      card: null,
      fee: null,
    },
  ],
  attempts: [
    {
      order: "S1",
      terminal: "mp",
      amount: "$105.00",
      state: "settled",
      errorCode: null,
      resolution: null,
    },
    {
      order: "S2",
      terminal: "clip",
      amount: "$125.00",
      state: "settled",
      errorCode: null,
      resolution: null,
    },
    {
      order: "S3",
      terminal: "mp",
      amount: "$120.00",
      state: "settled",
      errorCode: "kiosk_settle_unavailable",
      resolution: null,
    },
    {
      order: "S4",
      terminal: "clip",
      amount: "$95.00",
      state: "settled",
      errorCode: "kiosk_settle_price_changed",
      resolution: "recorded",
    },
  ],
  holds: [
    {
      order: "S1",
      number: 1,
      decisionSource: "kiosk",
      mode: "dine_in",
      acceptedTotal: "$105.00",
    },
    {
      order: "S2",
      number: 2,
      decisionSource: "kiosk",
      mode: "takeaway",
      acceptedTotal: "$125.00",
    },
    {
      order: "S3",
      number: 3,
      decisionSource: "kiosk",
      mode: "dine_in",
      acceptedTotal: "$120.00",
    },
    {
      order: "S4",
      number: 4,
      decisionSource: "staff",
      mode: "takeaway",
      acceptedTotal: "$110.00",
    },
  ],
  corteZ: {
    cash: {
      opening: "$500.00",
      sales: "$15.00",
      expected: "$515.00",
      counted: "$515.00",
      difference: "$0.00",
    },
    terminal: {
      count: 4,
      sales: "$445.00",
      tips: "$0.00",
      net: "$445.00",
      reported: "$445.00",
      byTerminal: {
        "Clip Kiosco (2)": {
          net: "$220.00",
          batch: "$220.00",
          kiosk: "Del kiosco: 2 · $220.00",
          fees: "$7.92",
        },
        "MP Kiosco (2)": {
          net: "$225.00",
          batch: "$225.00",
          kiosk: "Del kiosco: 2 · $225.00",
          fees: "$7.88",
        },
      },
    },
    payments: 5,
    folios: "S-000001 a S-000004",
    tickets: 4,
  },
  finance: {
    byTerminal: [
      [
        "Clip Kiosco",
        "2",
        "$220.00",
        "$0.00",
        "$0.00",
        "$7.92 (estimadas)",
        "$212.08",
      ],
      [
        "MP Kiosco",
        "2",
        "$225.00",
        "$0.00",
        "$0.00",
        "$7.88 (estimadas)",
        "$217.12",
      ],
    ],
    byMethod: [
      ["Efectivo", "1", "$15.00", "$0.00", "$0.00", "$15.00"],
      [
        "Terminal bancaria externa",
        "4",
        "$445.00",
        "$0.00",
        "$0.00",
        "$445.00",
      ],
    ],
    byMethodTotal: ["Total", "5", "$460.00", "$0.00", "$0.00", "$460.00"],
  },
  kioskReport: {
    orders: "4",
    paidAtKiosk: "4",
    paidAtCounter: "1",
    reviewOpen: "0",
    reviewResolved: "2",
    refunded: "0",
    refundedAmount: "$0.00",
    suggestionLines: "1",
    suggestionAmount: "$45.00",
  },
  exceptions: {
    review: [
      { number: 3, amount: "$120.00", terminal: "MP Kiosco" },
      { number: 4, amount: "$95.00", terminal: "Clip Kiosco" },
    ],
    recorded: [{ number: 4, amount: "$95.00", terminal: "Clip Kiosco" }],
  },
  club: {
    before: "0 de 6 sellos",
    masked: "•••••• 01 47 · 10/10",
    stampsAfter: 1,
  },
};

/**
 * The payments fake's charges for Restaurant S per device, in creation order (they follow branch
 * P's on the same devices): MP's amount is the total (no tip at a kiosk); Clip's is the bill.
 */
export const FAKE_CHARGES_S: Record<
  string,
  { order: string; amount: number; tip: number; status: string }[]
> = {
  NEWLAND_N950__FAKE0001: [
    { order: "S1", amount: 10500, tip: 0, status: "processed" },
    { order: "S3", amount: 12000, tip: 0, status: "processed" },
  ],
  P8220724FAKE01: [
    { order: "S2", amount: 12500, tip: 0, status: "processed" },
    { order: "S4", amount: 9500, tip: 0, status: "processed" },
  ],
};
