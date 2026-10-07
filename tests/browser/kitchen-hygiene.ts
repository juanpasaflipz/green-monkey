import { randomUUID } from "node:crypto";
import {
  test,
  expect,
  request,
  type APIRequestContext,
  type APIResponse,
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
 * a beforeEach that notes the kitchen feed and the offline review lane as the
 * test starts and an afterEach that, as the demo owner, first decides
 * "already served" for every offline sale the test left in the review lane
 * (the kitchen's own decision route, FLK-R8), then delivers every open round
 * the test created: pending cancellations are acknowledged first, then each
 * round goes to ready and delivered through the same API the KDS uses. A
 * round or review that cannot be settled fails the test softly (the test's
 * own error, if any, stays the first one reported).
 *
 * The cleanup signs in once per worker on an API request context of its own,
 * so it never depends on the state a test left its pages, devices or sessions
 * in, and it works the same in every browser project. It keeps the session
 * cookies itself and sends them on every call: the compiled server marks them
 * Secure, which WebKit's contexts and Playwright's cookie store (outside
 * "localhost") withhold from a plain-HTTP http://127.0.0.1 server.
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
/** A pending offline-sold round (GET /api/offline/kitchen, oldest 100). */
type Review = {
  roundId: string;
  orderNumber: number;
  name: string;
  syncedAt: string;
};
type Before = { ids: Set<string>; reviews: Set<string>; since: number };
type Owner = {
  api: APIRequestContext;
  baseURL: string;
  csrf: string;
  /** The session cookies, name to value, as the server last set them. */
  jar: Map<string, string>;
};

let owner: Owner | null = null;

/** Keeps the cookies a response sets. */
function keep(jar: Map<string, string>, r: APIResponse) {
  for (const h of r.headersArray())
    if (h.name.toLowerCase() === "set-cookie") {
      const pair = h.value.split(";")[0];
      const split = pair.indexOf("=");
      jar.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
    }
  return r;
}

/** One API call with the jar's cookies (and the CSRF token on a POST). */
async function call(
  o: Pick<Owner, "api" | "jar"> & { csrf?: string },
  method: "get" | "post",
  path: string,
  data?: object,
) {
  const cookie = [...o.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return keep(
    o.jar,
    await o.api[method]("/api" + path, {
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(o.csrf ? { "x-csrf-token": o.csrf } : {}),
      },
      ...(data ? { data } : {}),
    }),
  );
}

/** The cleanup's owner session (its own request context and cookies). */
async function signIn(baseURL: string, fresh = false): Promise<Owner> {
  if (owner && (fresh || owner.baseURL !== baseURL)) {
    await owner.api.dispose().catch(() => {});
    owner = null;
  }
  if (!owner) {
    const api = await request.newContext({ baseURL });
    const jar = new Map<string, string>();
    try {
      const login = await call({ api, jar }, "post", "/login", {
        tenantId: TENANT,
        ...OWNER,
      });
      if (login.status() !== 200)
        throw Error(
          `kitchen hygiene: owner sign-in answered ${login.status()}`,
        );
      const session = await call({ api, jar }, "get", "/session");
      if (!session.ok())
        throw Error(`kitchen hygiene: session answered ${session.status()}`);
      owner = { api, baseURL, jar, csrf: (await session.json()).csrf };
    } catch (e) {
      await api.dispose().catch(() => {});
      throw e;
    }
  }
  return owner;
}

async function read<T>(o: Owner, path: string): Promise<T> {
  const r = await call(o, "get", path);
  if (!r.ok())
    throw Error(`kitchen hygiene: GET ${path} answered ${r.status()}`);
  return r.json();
}

/** A KDS command as the owner; returns why it was refused, if it was. */
async function post(o: Owner, path: string, body: object = {}) {
  const r = await call(o, "post", path, {
    operationId: randomUUID(),
    ...body,
  });
  return r.ok() ? null : `POST ${path} ${r.status()} ${await r.text()}`;
}

/** GET /api/service/kitchen (every station) as the cleanup owner. */
const feed = (o: Owner) => read<Feed>(o, "/service/kitchen?station=all");

/** The review lane of offline sales the kitchen has not decided yet. */
const reviews = async (o: Owner) =>
  (await read<{ items: Review[] }>(o, "/offline/kitchen")).items;

async function withOwner<T>(baseURL: string, fn: (o: Owner) => Promise<T>) {
  try {
    return await fn(await signIn(baseURL));
  } catch {
    // The session may have ended (a test ended every session, the server
    // restarted): sign in again once.
    return fn(await signIn(baseURL, true));
  }
}

/** Open rounds on the KDS that the test created (not open before it, created after it began). */
function created(f: Feed, before: Before) {
  return f.rounds.filter(
    (r) => !before.ids.has(r.id) && Date.parse(r.createdAt) >= before.since,
  );
}

/** Offline sales the test left in the review lane (synced after it began). */
function reviewed(items: Review[], before: Before) {
  return items.filter(
    (r) =>
      !before.reviews.has(r.roundId) && Date.parse(r.syncedAt) >= before.since,
  );
}

/**
 * Settles the review lane entries and rounds a test created; returns those
 * still open, with any refused command.
 */
async function deliver(o: Owner, before: Before): Promise<string[]> {
  const refused: string[] = [];
  const note = (why: string | null) => why && refused.push(why);
  for (const r of reviewed(await reviews(o), before))
    note(
      await post(o, `/offline/kitchen/${r.roundId}/decision`, {
        decision: "already_served",
      }),
    );
  for (let pass = 0; pass < 3; pass++) {
    const mine = created(await feed(o), before);
    if (!mine.length) break;
    for (const r of mine) {
      // A pending cancellation blocks delivery (SVC-K6); acknowledging the
      // last item of a round may also complete it, so re-read next pass.
      if (r.pendingVoids.length) {
        note(await post(o, `/kitchen/${r.id}/voids/ack`));
        continue;
      }
      if (r.state === "active")
        note(await post(o, `/kitchen/${r.id}`, { state: "ready" }));
      note(await post(o, `/kitchen/${r.id}`, { state: "completed" }));
    }
  }
  const left = [
    ...reviewed(await reviews(o), before).map(
      (r) => `#${r.orderNumber} ${r.name} (offline review)`,
    ),
    ...created(await feed(o), before).map(
      (r) => `#${r.orderNumber} ${r.callName} (${r.state})`,
    ),
  ];
  return left.length ? [...left, ...refused] : [];
}

/**
 * Registers the per-test cleanup in the calling spec file or describe. Call
 * it once at the top level of every spec whose tests send rounds to the
 * kitchen of the demo restaurant.
 */
export function kitchenHygiene() {
  let before: Before | null = null;
  test.beforeEach(async ({ baseURL }) => {
    before = null;
    const [f, lane] = await withOwner(baseURL!, (o) =>
      Promise.all([feed(o), reviews(o)]),
    );
    before = {
      ids: new Set(f.rounds.map((r) => r.id)),
      reviews: new Set(lane.map((r) => r.roundId)),
      since: Date.parse(f.serverTime) - CLOCK_MARGIN_MS,
    };
  });
  test.afterEach(async ({ baseURL }) => {
    const start = before;
    if (!start) return;
    const left = await withOwner(baseURL!, (o) => deliver(o, start));
    expect
      .soft(
        left,
        "kitchen rounds and offline reviews this test opened are settled (W3-2)",
      )
      .toEqual([]);
  });
}
