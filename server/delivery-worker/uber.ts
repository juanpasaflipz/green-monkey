import type { Page } from "playwright-core";
import type { DeliveryStore } from "../../shared/delivery.js";
import { DeliveryError } from "../delivery/parse.js";

export const UBER_REPORTS = "https://merchants.ubereats.com/manager/reports";

async function reports(page: Page) {
  await page.goto(UBER_REPORTS, { waitUntil: "domcontentloaded" });
  try {
    await page
      .getByRole("button", { name: "Create report", exact: true })
      .waitFor();
  } catch {
    throw new DeliveryError(
      /auth|login|sign.in/.test(page.url())
        ? "delivery_reconnect"
        : "delivery_portal_changed",
    );
  }
}

export async function uberStores(page: Page): Promise<DeliveryStore[]> {
  await reports(page);
  await page
    .getByRole("button", { name: "Create report", exact: true })
    .click();
  await page
    .getByRole("button", { name: "No stores selected", exact: true })
    .click();
  const items = page.getByRole("button", { name: "List item", exact: true });
  await items.first().waitFor();
  const stores: DeliveryStore[] = [];
  for (const item of await items.all()) {
    const name = (await item.getByRole("paragraph").first().innerText()).trim();
    if (name && name !== "Select all") {
      const paragraphs = await item.getByRole("paragraph").allTextContents();
      const address = paragraphs[1]?.trim();
      if (!address) throw new DeliveryError("delivery_store_invalid");
      const reportLabel = `${name} (${address})`;
      stores.push({ id: reportLabel, name, reportLabel });
    }
  }
  if (
    !stores.length ||
    stores.length > 100 ||
    new Set(stores.map((s) => s.id)).size !== stores.length
  )
    throw new DeliveryError("delivery_store_invalid");
  return stores;
}

/** Reports can take hours. Revisit a matching request; never generate one on every poll. */
export async function uberExport(
  page: Page,
  store: DeliveryStore,
  day: string,
  checkpoint: {
    alreadyRequested: boolean;
    forceFresh?: boolean;
    excludedRows?: string[];
    beforeRequest: (excludedRows: string[]) => Promise<void>;
    beforeDownload: (singleStore: boolean) => Promise<void>;
  },
): Promise<"requested" | "downloaded" | "pending"> {
  await reports(page);
  const date = new Date(day + "T12:00:00Z");
  const label = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const excludedRows = [...(checkpoint.excludedRows ?? [])];
  for (let index = 0; index < 20; index++) {
    const rows = page
      .getByRole("row")
      .filter({ hasText: "Payment details" })
      .filter({ hasText: label })
      .filter({ hasText: store.name });
    for (const row of await rows.all()) {
      const cells = row.getByRole("columnheader").or(row.getByRole("cell"));
      if ((await cells.count()) !== 7) continue;
      if (
        (await cells.nth(1).innerText()).trim() !== "Payment details" ||
        (await cells.nth(2).innerText()).trim() !== label ||
        !store.reportLabel ||
        (await cells.nth(3).innerText()).trim() !== store.reportLabel
      )
        continue;
      // Use only identifying cells, excluding download/status controls that change
      // while a report is generated. An indistinguishable new row stays pending.
      const identity = JSON.stringify(
        await cells
          .allTextContents()
          .then((values) => values.slice(0, 4).map((value) => value.trim())),
      );
      if (checkpoint.forceFresh && !checkpoint.alreadyRequested) {
        excludedRows.push(identity);
        continue;
      }
      if (excludedRows.includes(identity)) continue;
      const download = row.getByRole("button", {
        name: "Download CSV",
        exact: true,
      });
      if ((await download.count()) && (await download.isEnabled())) {
        await checkpoint.beforeDownload(true);
        await download.click();
        return "downloaded";
      }
      if (
        await row
          .getByRole("button", { name: "Request again", exact: true })
          .count()
      )
        continue;
      return "pending";
    }
    const next = page.getByRole("button", { name: /next page/i });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    if (index === 19) throw new DeliveryError("delivery_report_ambiguous");
    const before = await page.getByRole("row").allTextContents();
    await next.click();
    let changed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (
        JSON.stringify(await page.getByRole("row").allTextContents()) !==
        JSON.stringify(before)
      ) {
        changed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!changed) throw new DeliveryError("delivery_portal_changed");
  }
  // An ambiguous request timeout must not create another export on every poll.
  if (checkpoint.alreadyRequested) return "pending";
  await page
    .getByRole("button", { name: "Create report", exact: true })
    .click();
  await page.getByText("Payments", { exact: true }).locator("..").click();
  const payment = page.getByText("Payment details", { exact: true });
  await payment.waitFor();
  // The portal's checkbox has no accessible name; bind it to the visible label's row.
  await payment.locator("..").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "No stores selected", exact: true })
    .click();
  let item = page
    .getByRole("button", { name: "List item", exact: true })
    .filter({ has: page.getByText(store.name, { exact: true }) });
  if (store.reportLabel) {
    const address = store.reportLabel.slice(store.name.length + 2, -1);
    item = item.filter({ has: page.getByText(address, { exact: true }) });
  }
  if ((await item.count()) !== 1)
    throw new DeliveryError("delivery_store_invalid");
  await item.click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Select a date range.", exact: true })
    .click();
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(date);
  const month = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC",
  }).format(date);
  const n = date.getUTCDate(),
    suffix =
      n % 100 >= 11 && n % 100 <= 13
        ? "th"
        : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  const dateText = `${weekday}, ${month} ${n}${suffix} ${date.getUTCFullYear()}. It's available.`;
  const start = page.getByRole("button", {
    name: `Choose ${dateText}`,
    exact: true,
  });
  for (let i = 0; i < 12 && !(await start.count()); i++)
    await page
      .getByRole("button", { name: "Previous month.", exact: true })
      .click();
  await start.click();
  await page
    .getByRole("button", {
      name: `Selected start date. ${dateText}`,
      exact: true,
    })
    .click();
  const url = new URL(page.url());
  if (
    url.searchParams.get("start") !== day ||
    url.searchParams.get("end") !== day
  )
    throw new DeliveryError("delivery_report_scope");
  await checkpoint.beforeRequest(excludedRows);
  await page
    .getByRole("button", { name: "Create report", exact: true })
    .click();
  await page.getByRole("tab", { name: "Available", exact: true }).waitFor();
  return "requested";
}
