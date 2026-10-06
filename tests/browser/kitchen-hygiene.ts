import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

/**
 * Persistent-database hygiene for the kitchen display (W3-2, LD-42).
 *
 * The browser suite also runs against long-lived databases (a staging-like
 * target, or the local fixture across several runs without a reset). Every
 * round a test sends to the kitchen stays open until someone delivers it, so
 * without cleanup each run left dozens of tickets on the demo restaurant's
 * KDS: later runs met ambiguous locators, leftover voided lines and, at the
 * feed cap, screens that no longer showed new tickets.
 *
 * kitchenHygiene() registers, for the spec file (or describe) that calls it,
 * a beforeEach that notes the kitchen feed as the test starts and an
 * afterEach that delivers, as the demo owner, every open round the test
 * created: pending cancellations are acknowledged first, then each round goes
 * to ready and delivered through the same API the KDS uses. A round that
 * cannot be delivered fails the test softly (the test's own error, if any,
 * stays the first one reported).
 *
 * The cleanup signs in once per worker in a browser context of its own, so it
 * never depends on the state a test left its pages in.
 */

const TENANT =
  process.env.DEMO_TENANT_ID ?? "10000000-0000-4000-8000-000000000001";
const OWNER = { login: "owner", secret: "demo-green-monkey" };
/** Rounds created this long before the test's first feed read still count (DB vs app clock). */
const CLOCK_MARGIN_MS = 2000;

type FeedRound = {
  id: string;
  orderNumber: number;
  callName: string;
  state: string;
  createdAt: string;
  pendingVoids: unknown[];
};
type Feed = { serverTime: string; rounds: FeedRound[] };

let owner: { browser: Browser; context: BrowserContext; page: Page } | null =
  null;

/** The cleanup's owner page (signed in on its own paired browser context). */
async function ownerPage(browser: Browser, baseURL: string, fresh = false) {
  if (owner && (fresh || owner.browser !== browser)) {
    await owner.context.close().catch(() => {});
    owner = null;
  }
  if (!owner) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto("/api/health");
    const status = await page.evaluate(
      async ({ tenantId, login, secret }) =>
        (
          await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenantId, login, secret }),
          })
        ).status,
      { tenantId: TENANT, ...OWNER },
    );
    if (status !== 200) {
      await context.close();
      throw Error(`kitchen hygiene: owner sign-in answered ${status}`);
    }
    owner = { browser, context, page };
  }
  return owner.page;
}

/** GET /api/service/kitchen (every station) as the cleanup owner. */
async function feed(page: Page): Promise<Feed> {
  return page.evaluate(async () => {
    const r = await fetch("/api/service/kitchen?station=all");
    if (!r.ok) throw Error(`kitchen feed ${r.status}`);
    return r.json();
  });
}

async function withOwner<T>(
  browser: Browser,
  baseURL: string,
  fn: (page: Page) => Promise<T>,
) {
  try {
    return await fn(await ownerPage(browser, baseURL));
  } catch {
    // The session may have ended (a test signed the device out, the server
    // restarted): sign in again once.
    return fn(await ownerPage(browser, baseURL, true));
  }
}

/** Open rounds on the KDS that the test created (not open before it, created after it began). */
function created(f: Feed, before: { ids: Set<string>; since: number }) {
  return f.rounds.filter(
    (r) => !before.ids.has(r.id) && Date.parse(r.createdAt) >= before.since,
  );
}

/** Delivers the rounds a test created; returns those still open. */
async function deliver(
  page: Page,
  before: { ids: Set<string>; since: number },
): Promise<string[]> {
  for (let pass = 0; pass < 3; pass++) {
    const mine = created(await feed(page), before);
    if (!mine.length) return [];
    await page.evaluate(async (rounds) => {
      const s = await (await fetch("/api/session")).json();
      const post = (path: string, body: object = {}) =>
        fetch("/api" + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": s.csrf,
          },
          body: JSON.stringify({ operationId: crypto.randomUUID(), ...body }),
        });
      for (const r of rounds) {
        // A pending cancellation blocks delivery (SVC-K6); acknowledging the
        // last item of a round may also complete it, so re-read next pass.
        if (r.pendingVoids.length) {
          await post(`/kitchen/${r.id}/voids/ack`);
          continue;
        }
        if (r.state === "active")
          await post(`/kitchen/${r.id}`, { state: "ready" });
        await post(`/kitchen/${r.id}`, { state: "completed" });
      }
    }, mine);
  }
  return created(await feed(page), before).map(
    (r) => `#${r.orderNumber} ${r.callName} (${r.state})`,
  );
}

/**
 * Registers the per-test cleanup in the calling spec file or describe. Call
 * it once at the top level of every spec whose tests send rounds to the
 * kitchen of the demo restaurant.
 */
export function kitchenHygiene() {
  let before: { ids: Set<string>; since: number } | null = null;
  test.beforeEach(async ({ browser, baseURL }) => {
    before = null;
    const f = await withOwner(browser, baseURL!, feed);
    before = {
      ids: new Set(f.rounds.map((r) => r.id)),
      since: Date.parse(f.serverTime) - CLOCK_MARGIN_MS,
    };
  });
  test.afterEach(async ({ browser, baseURL }) => {
    const start = before;
    if (!start) return;
    const left = await withOwner(browser, baseURL!, (page) =>
      deliver(page, start),
    );
    expect
      .soft(left, "kitchen rounds this test opened are delivered (W3-2)")
      .toEqual([]);
  });
}
