// Staff routes of public QR/kiosk ordering (032), under /api/ordering/*, so
// they never share a prefix with the pre-auth diner router (/api/public).
import type { RouteContext } from "../http.js";
import { publicOrderingEnabled } from "../account-settings.js";
import {
  createLink,
  createTableLinks,
  listLinks,
  orderingSettings,
  revokeLink,
  rotateLink,
  saveOrderingSettings,
  setPaused,
} from "../public-links.js";
import {
  acceptHold,
  claimHold,
  inbox,
  inboxSummary,
  rejectHold,
} from "../public-holds.js";
import { DomainError, id, type Session } from "../../shared/domain.js";
import {
  ORDERING_DEFAULTS,
  PUBLIC_LIMITS,
  type InboxSummary,
  type PublicSettingsView,
} from "../../shared/public-ordering.js";

/** Flag off: no query; the panel says "not available" and hides every action. */
const disabledSettings = (_s: Session): PublicSettingsView => ({
  available: false,
  pro: false,
  canEdit: false,
  canPause: false,
  paused: false,
  acceptingNow: false,
  reason: null,
  tablePolicy: ORDERING_DEFAULTS.tablePolicy,
  counterPolicy: ORDERING_DEFAULTS.counterPolicy,
  holdMinutes: ORDERING_DEFAULTS.holdMinutes,
  maxOrderTotal: ORDERING_DEFAULTS.maxOrderTotal,
  version: 0,
  limits: { ...PUBLIC_LIMITS.activeLinks },
});

const DISABLED_SUMMARY: InboxSummary = {
  available: false,
  active: false,
  pending: 0,
  oldestAt: null,
};

/** public ordering authenticated routes; no registerPreAuth (the diner router is mounted by server/index.ts). */
export function register({ app, route }: RouteContext) {
  // Account's kill switch, read once at boot (throws public_ordering_flag_invalid).
  const ENABLED = publicOrderingEnabled(process.env);
  const gate = () => {
    if (!ENABLED) throw new DomainError("public_ordering_disabled", 404);
  };
  // route() gives handlers no response object: link replies carry tokens, so
  // every /api/ordering response is marked no-store before the routes run.
  app.use("/api/ordering", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  route("get", "/ordering/settings", async (tx, s) =>
    ENABLED ? orderingSettings(tx, s) : disabledSettings(s),
  );
  route("post", "/ordering/settings", async (tx, s, req) => {
    gate();
    return saveOrderingSettings(tx, s, req.body);
  });
  route("post", "/ordering/pause", async (tx, s, req) => {
    gate();
    return setPaused(tx, s, req.body);
  });
  route("get", "/ordering/links", async (tx, s) => {
    gate();
    return listLinks(tx, s);
  });
  route("post", "/ordering/links", async (tx, s, req) => {
    gate();
    return createLink(tx, s, req.body);
  });
  route("post", "/ordering/links/tables", async (tx, s, req) => {
    gate();
    return createTableLinks(tx, s, req.body);
  });
  route("post", "/ordering/links/:id/rotate", async (tx, s, req) => {
    gate();
    return rotateLink(tx, s, id.parse(req.params.id));
  });
  route("post", "/ordering/links/:id/revoke", async (tx, s, req) => {
    gate();
    return revokeLink(tx, s, id.parse(req.params.id), req.body);
  });
  route("get", "/ordering/inbox", async (tx, s) => {
    gate();
    return inbox(tx, s);
  });
  route("get", "/ordering/inbox/summary", async (tx, s) =>
    ENABLED ? inboxSummary(tx, s) : DISABLED_SUMMARY,
  );
  route("post", "/ordering/holds/:id/accept", async (tx, s, req) => {
    gate();
    return acceptHold(tx, s, id.parse(req.params.id), req.body);
  });
  route("post", "/ordering/holds/:id/claim", async (tx, s, req) => {
    gate();
    return claimHold(tx, s, id.parse(req.params.id), req.body);
  });
  route("post", "/ordering/holds/:id/reject", async (tx, s, req) => {
    gate();
    return rejectHold(tx, s, id.parse(req.params.id), req.body);
  });
}
