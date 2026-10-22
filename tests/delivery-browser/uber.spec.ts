import { test, expect } from "@playwright/test";
import { uberExport } from "../../server/delivery-worker/uber";
const day = "2026-10-21",
  store = {
    id: "Synthetic Cafe",
    name: "Synthetic Cafe",
    reportLabel: "Synthetic Cafe (123 Example St)",
  };
function html(cell: "td" | "th", rows: string[]) {
  return `<button id="create">Create report</button><table>${rows.map((action) => `<tr>${["Report", "Payment details", "Oct 21, 2026", "Synthetic Cafe (123 Example St)", "Ready", "Generated", action].map((s) => `<${cell}>${s}</${cell}>`).join("")}</tr>`).join("")}</table>
 <script>document.addEventListener('click',e=>{document.body.dataset.clicked=e.target.textContent})</script>`;
}
for (const cell of ["td", "th"] as const)
  test(`matches existing exports with ${cell} cells and skips expired rows`, async ({
    page,
  }) => {
    await page.route("https://merchants.ubereats.com/manager/reports", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: html(cell, [
          "<button>Request again</button>",
          "<button>Download CSV</button>",
        ]),
      }),
    );
    let saved = false;
    const result = await uberExport(page, store, day, {
      alreadyRequested: false,
      beforeRequest: async () => {
        throw Error("duplicate request");
      },
      beforeDownload: async () => {
        expect(
          await page.locator("body").getAttribute("data-clicked"),
        ).toBeNull();
        saved = true;
      },
    });
    expect(result).toBe("downloaded");
    expect(saved).toBe(true);
    await expect(page.locator("body")).toHaveAttribute(
      "data-clicked",
      "Download CSV",
    );
  });
test("a missing generated report is polled without another request", async ({
  page,
}) => {
  await page.route("https://merchants.ubereats.com/manager/reports", (r) =>
    r.fulfill({ contentType: "text/html", body: html("td", []) }),
  );
  expect(
    await uberExport(page, store, day, {
      alreadyRequested: true,
      beforeRequest: async () => {
        throw Error("duplicate request");
      },
      beforeDownload: async () => {
        throw Error("unexpected download");
      },
    }),
  ).toBe("pending");
  await expect(page.locator("body")).not.toHaveAttribute("data-clicked");
});
test("failure to persist the download checkpoint prevents the click", async ({
  page,
}) => {
  await page.route("https://merchants.ubereats.com/manager/reports", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: html("td", ["<button>Download CSV</button>"]),
    }),
  );
  await expect(
    uberExport(page, store, day, {
      alreadyRequested: false,
      beforeRequest: async () => {},
      beforeDownload: async () => {
        throw Error("lease lost");
      },
    }),
  ).rejects.toThrow("lease lost");
  await expect(page.locator("body")).not.toHaveAttribute("data-clicked");
});
test("refresh polling never downloads an excluded older export", async ({
  page,
}) => {
  await page.route("https://merchants.ubereats.com/manager/reports", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: html("td", ["<button>Download CSV</button>"]),
    }),
  );
  expect(
    await uberExport(page, store, day, {
      alreadyRequested: true,
      forceFresh: true,
      excludedRows: [
        JSON.stringify([
          "Report",
          "Payment details",
          "Oct 21, 2026",
          "Synthetic Cafe (123 Example St)",
        ]),
      ],
      beforeRequest: async () => {
        throw Error("duplicate request");
      },
      beforeDownload: async () => {
        throw Error("stale export");
      },
    }),
  ).toBe("pending");
  await expect(page.locator("body")).not.toHaveAttribute("data-clicked");
});
