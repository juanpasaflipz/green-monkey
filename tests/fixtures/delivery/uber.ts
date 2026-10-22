// Synthetic merchant data only.
export const uberHeaders = [
  "Store Name",
  "Store UUID",
  "Workflow ID",
  "Order Date",
  "Order Status",
  "Currency Code",
  "Sales (incl. VAT)",
  "Total Sales after Adjustments (incl. VAT)",
  "Total payout",
];
export function uberFixture(day = "2026-10-21", rows?: string[][]) {
  const [year, month, date] = day.split("-");
  return Buffer.from(
    [
      uberHeaders,
      ...(rows ?? [
        [
          "Synthetic Cafe",
          "store-one",
          "order-1",
          `${month}/${date}/${year}`,
          "Completed",
          "MXN",
          "129.00",
          "119.00",
          "80.25",
        ],
        [
          "Synthetic Cafe",
          "store-one",
          "",
          `${month}/${date}/${year}`,
          "",
          "MXN",
          "0",
          "0",
          "-2.25",
        ],
      ]),
    ]
      .map((r) => r.join(","))
      .join("\n"),
  );
}
