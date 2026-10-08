/**
 * The customer self-invoicing portal (spec §2.7, §4.7.2). Pre-auth, no cookies, no session.
 *
 * Tenant resolution: the printed 12-character code (a 60-bit bearer secret) is looked up through
 * fiscal_tickets' cfdi_self_invoice_lookup policy with app.self_invoice_code set, never with a
 * SECURITY DEFINER function (LD-12). Everything after runs inside tenant(sql, tenantId) with a
 * synthetic session used only by once() (no audit row is ever written for a portal action; its
 * history is cfdi_events with no actor).
 *
 * Tokens (server/tokens.ts, Wave 2.0 (g)): a request token "cfdi-portal" {tid, did, tkt} lives
 * CFDI_INVOICE_LINK_EXPIRY_HOURS; a download token "cfdi-portal-file" {tid, did} 15 minutes; one
 * purpose never opens the other. Limits: per IP (express-rate-limit keyed on clientIp, IPv6 /56,
 * LD-9/LD-11) and a durable 5 submissions per ticket per 24 h.
 */
import type express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type postgres from "postgres";
import { DomainError, id, type Session } from "../../shared/domain.js";
import {
  CFDI_USES,
  firstReceptorError,
  normalizeTicketCode,
  portalAccessInput,
  portalInvoiceInput,
  type CardForm,
  type PortalDocumentStatus,
  type PortalTicketView,
} from "../../shared/cfdi.js";
import { restaurantPrivacyUrl } from "../account-settings.js";
import { tenant, type Tx } from "../db.js";
import { clientIp, ipHash, log, requestIdOf, routeLabel } from "../logging.js";
import { once } from "../orders.js";
import { seal, unseal } from "../tokens.js";
import { cfdiWebConfig } from "./config.js";
import { createInvoiceRequest } from "./requests.js";
import {
  cfdiState,
  fiscalFacts,
  loadDocument,
  portalReissues,
  portalStatus,
  filesStored,
  ticketFacts,
  ticketView,
  type DocumentRow,
} from "./store.js";

/** Per-IP limits (spec §2.7): lookups, submissions, RFC access and status/file polls. */
export const PORTAL_LIMITS = { lookup: 30, submit: 6, access: 10, status: 60 };

export function portalLimiter(name: string, limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req), 56),
    handler: (req, res) => {
      log.warn("rate_limited", {
        limiter: name,
        route: routeLabel(req),
        ipHash: ipHash(clientIp(req)),
      });
      res
        .status(429)
        .json({ error: "rate_limited", requestId: requestIdOf(req) });
    },
  });
}

type RequestClaims = { tid: string; did: string; tkt: string };
type FileClaims = { tid: string; did: string };

function linkExpirySeconds(): number {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env))
    env[k] = v === undefined || v.trim() === "" ? undefined : v;
  const appEnv = (env.APP_ENV ?? "development") as Parameters<
    typeof cfdiWebConfig
  >[1];
  return cfdiWebConfig(env, appEnv).linkExpiryHours * 3600;
}

/** The tenant and ticket of a printed code, or null (one lookup statement, no tenant set). */
export async function resolveTicketCode(
  sql: postgres.Sql,
  raw: string,
): Promise<{ tenantId: string; ticketId: string } | null> {
  const code = normalizeTicketCode(raw);
  if (!code) return null;
  return sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.self_invoice_code', ${code}, true)`;
    const [r] =
      await tx`select tenant_id, id from fiscal_tickets where self_invoice_code = ${code}`;
    return r
      ? { tenantId: r.tenant_id as string, ticketId: r.id as string }
      : null;
  }) as Promise<{ tenantId: string; ticketId: string } | null>;
}

/** A session-shaped value for once() only (spec cfdi-rebase S14): never audited. */
async function portalSession(tx: Tx, tenantId: string): Promise<Session> {
  const [r] = await tx`
    select r.name, r.currency, r.timezone, r.cutoff,
      (select e.id from employees e where e.tenant_id = r.id and e.role = 'owner'
        order by e.id limit 1) as owner_id
    from restaurants r where r.id = ${tenantId}`;
  if (!r) throw new DomainError("cfdi_portal_code_not_found", 404);
  return {
    id: "portal",
    tenantId,
    employeeId: r.owner_id ?? tenantId,
    name: "portal",
    role: "portal",
    deviceId: "portal",
    expiresAt: "",
    offlineUntil: "",
    csrf: "",
    restaurant: {
      name: r.name,
      currency: r.currency,
      timezone: r.timezone,
      cutoff: r.cutoff,
    },
  };
}

async function requireCode(sql: postgres.Sql, code: string) {
  const found = await resolveTicketCode(sql, code);
  if (!found) throw new DomainError("cfdi_portal_code_not_found", 404);
  return found;
}

function requestToken(tid: string, did: string, tkt: string): string {
  return seal("cfdi-portal", { tid, did, tkt } satisfies RequestClaims, {
    ttlSeconds: linkExpirySeconds(),
  });
}

/** A fresh 15-minute download token on every read (the page asks again before a download). */
async function statusOf(
  tx: Tx,
  doc: DocumentRow,
  tid: string,
): Promise<PortalDocumentStatus> {
  const valid = doc.status === "valid" || doc.status === "canceling";
  return portalStatus(
    doc,
    valid
      ? seal("cfdi-portal-file", { tid, did: doc.id } satisfies FileClaims, {
          ttlSeconds: 900,
        })
      : null,
    valid && (await filesStored(tx, doc.id)),
  );
}

/** GET /api/cfdi/portal/tickets/:code */
export async function portalTicket(
  sql: postgres.Sql,
  code: string,
): Promise<PortalTicketView> {
  const { tenantId, ticketId } = await requireCode(sql, code);
  return tenant(sql, tenantId, async (tx) => {
    const state = await cfdiState(tx);
    if (
      !state.platform ||
      state.platform.provider === "disabled" ||
      !state.settings
    )
      throw new DomainError("cfdi_portal_unavailable", 409);
    const facts = await fiscalFacts(tx);
    const t = await ticketFacts(tx, ticketId, state.settings.mode);
    const view = await ticketView(tx, t, state, facts, {
      viewer: null,
      portal: true,
    });
    const { documents: _d, covering, orderId: _o, ...rest } = view;
    void _d;
    void _o;
    let latest: PortalDocumentStatus | null = null;
    // Status only; downloading needs the RFC (POST …/access). Without a covering invoice, the
    // ticket's newest portal request, so a customer who comes back sees why it failed
    // (CFDI-UX-3).
    const [newest] =
      covering?.kind === "invoice"
        ? [{ id: covering.documentId }]
        : await tx`
            select d.id from cfdi_document_tickets c
            join cfdi_documents d on d.tenant_id = c.tenant_id and d.id = c.document_id
            where c.ticket_id = ${ticketId} and d.kind = 'invoice' and d.source = 'portal'
            order by d.created_at desc limit 1`;
    if (newest) {
      const doc = await loadDocument(tx, newest.id as string);
      // Before the RFC check: status and reason only, no masked RFC or email and no UUID
      // (CFDI-SECRETS-3: a masked company RFC leaves only its date digits to guess).
      if (doc)
        latest = {
          ...portalStatus(doc, null),
          rfcMasked: "",
          emailMasked: null,
          uuid: null,
        };
    }
    // account (031): the restaurant's own privacy notice, as the QR/kiosk pages link it; null
    // until the owner sets one (the portal then shows cfdiPortalPrivacyFallback).
    const privacyUrl = await restaurantPrivacyUrl(tx);
    return {
      ...rest,
      // Self-invoicing off: the portal says to ask at the restaurant.
      eligibility: state.settings.selfInvoiceEnabled
        ? rest.eligibility
        : "disabled",
      supportEmail: state.settings.supportEmail,
      privacyUrl,
      allowedUses: [...CFDI_USES],
      sandbox: state.organization?.source === "shared_sandbox",
      timezone: facts.timezone,
      latest,
    };
  });
}

/** POST /api/cfdi/portal/tickets/:code/invoices */
export async function portalSubmit(
  sql: postgres.Sql,
  code: string,
  raw: unknown,
): Promise<{ requestToken: string; document: PortalDocumentStatus }> {
  const p = portalInvoiceInput.parse(raw);
  const issue = firstReceptorError(p.receptor, { requireEmail: true });
  if (issue) throw new DomainError(issue.code, 400);
  const { tenantId, ticketId } = await requireCode(sql, code);
  const result = await tenant(sql, tenantId, async (tx) => {
    const s = await portalSession(tx, tenantId);
    const r = await once(
      tx,
      s,
      p.operationId,
      "cfdi.portal.invoice",
      { ...p, ticketId },
      async () => {
        const state = await cfdiState(tx);
        if (!state.settings)
          throw new DomainError("cfdi_portal_unavailable", 409);
        const cardForm: CardForm | null =
          p.cardForm === "unknown"
            ? state.settings.cardPaymentForm
            : (p.cardForm ?? null);
        try {
          const created = await createInvoiceRequest(tx, {
            tenantId,
            actorId: null,
            source: "portal",
            ticketId,
            receptor: p.receptor,
            cardForm,
            confirmPreStart: false,
            // The terms in force or a change that waits (CFDIFIX-R3-1), as the deadline counts.
            reissueGlobal: portalReissues(state.settings),
          });
          return { documentId: created.documentId };
        } catch (e) {
          if (
            e instanceof DomainError &&
            ["cfdi_unavailable", "cfdi_disabled", "cfdi_not_ready"].includes(
              e.code,
            )
          )
            throw new DomainError("cfdi_portal_unavailable", 409);
          throw e;
        }
      },
    );
    const doc = (await loadDocument(tx, r.documentId))!;
    return { documentId: doc.id, status: await statusOf(tx, doc, tenantId) };
  });
  return {
    requestToken: requestToken(tenantId, result.documentId, ticketId),
    document: result.status,
  };
}

/** GET /api/cfdi/portal/requests/:token */
export async function portalRequestStatus(
  sql: postgres.Sql,
  token: string,
): Promise<PortalDocumentStatus> {
  const c = unseal<RequestClaims>("cfdi-portal", token);
  if (!c || !id.safeParse(c.tid).success || !id.safeParse(c.did).success)
    throw new DomainError("unauthorized", 401);
  return tenant(sql, c.tid, async (tx) => {
    const doc = await loadDocument(tx, c.did);
    if (!doc) throw new DomainError("unauthorized", 401);
    return statusOf(tx, doc, c.tid);
  });
}

/** POST /api/cfdi/portal/tickets/:code/access {rfc}: a request token for the ticket's invoice. */
export async function portalAccess(
  sql: postgres.Sql,
  code: string,
  raw: unknown,
): Promise<{ requestToken: string }> {
  const p = portalAccessInput.parse(raw);
  const { tenantId, ticketId } = await requireCode(sql, code);
  const did = await tenant(sql, tenantId, async (tx) => {
    const [r] = await tx`
      select d.id from cfdi_document_tickets c
      join cfdi_documents d on d.tenant_id = c.tenant_id and d.id = c.document_id
      where c.ticket_id = ${ticketId} and d.kind = 'invoice' and d.receptor_rfc = ${p.rfc}
        and d.status in ('valid','canceling')
      order by d.created_at desc limit 1`;
    return (r?.id as string | undefined) ?? null;
  });
  if (!did) throw new DomainError("cfdi_portal_rfc_mismatch", 404);
  return { requestToken: requestToken(tenantId, did, ticketId) };
}

/** GET /api/cfdi/portal/files/:token/:format: bytes read in tenant(), written after it returns. */
export async function portalFile(
  sql: postgres.Sql,
  token: string,
  format: string,
): Promise<{ content: Buffer; contentType: string; filename: string }> {
  if (format !== "pdf" && format !== "xml")
    throw new DomainError("not_found", 404);
  const c = unseal<FileClaims>("cfdi-portal-file", token);
  if (!c || !id.safeParse(c.tid).success || !id.safeParse(c.did).success)
    throw new DomainError("unauthorized", 401);
  return tenant(sql, c.tid, async (tx) => {
    const doc = await loadDocument(tx, c.did);
    if (!doc || !["valid", "canceling"].includes(doc.status))
      throw new DomainError("unauthorized", 401);
    const [file] = await tx`
      select content from cfdi_files where document_id = ${doc.id} and format = ${format}`;
    if (!file) throw new DomainError("cfdi_file_not_ready", 409);
    const name =
      `${doc.receptorRfc ?? "CFDI"}_${doc.series ?? ""}${doc.folioNumber ?? ""}`.replace(
        /[^A-Za-z0-9_&-]/g,
        "",
      );
    return {
      content: Buffer.from(file.content),
      contentType: format === "pdf" ? "application/pdf" : "application/xml",
      filename: `${name}.${format}`,
    };
  });
}

/** Wraps an async handler: errors go to the app's error middleware (stable codes). */
export function handle(
  fn: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function sendFile(
  res: express.Response,
  f: { content: Buffer; contentType: string; filename: string },
) {
  res.setHeader("Content-Type", f.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(f.content);
}
