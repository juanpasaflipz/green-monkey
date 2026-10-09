// Provider notifications, web side (payments spec §9.2): pre-auth
// POST /api/payments/webhooks/:provider/:hook. The web never trusts a notification and never
// changes an attempt here: it screens the request (token format, per-IP and per-hook limits, body
// size), resolves the restaurant by the hook hash (037 policy payment_hook_lookup), matches the
// notified id against that account's live attempts (policy payment_hook_attempts), queues a
// payments_webhook job and wakes the worker. The worker verifies MP's x-signature with the sealed
// secret and re-reads the provider before acting; a Clip notification is only a hint to re-read.
// The answer is always 200 with an empty body: it never reveals whether a hook or an id exists,
// and MP retries anything else (it needs an answer within 22 s).
import type express from "express";
import type postgres from "postgres";
import { tenant, type Tx } from "../db.js";
import { enqueueJob } from "../jobs.js";
import { clientIp, log } from "../logging.js";
import { HOOK_TOKEN, hookHash } from "./providers.js";
import { wakeWorker } from "./wake.js";
import { PAYMENTS_LIMITS, type Provider } from "../../shared/payments.js";

type Counter = { at: number; n: number };
/** A fixed one-minute window per key, bounded in size (the oldest key goes first). */
function limiter(perMinute: number, maxKeys = 10_000) {
  const counts = new Map<string, Counter>();
  return (key: string): boolean => {
    const now = Date.now();
    const c = counts.get(key);
    if (!c || now - c.at >= 60_000) {
      counts.delete(key);
      counts.set(key, { at: now, n: 1 });
      if (counts.size > maxKeys) counts.delete(counts.keys().next().value!);
      return true;
    }
    c.n++;
    return c.n <= perMinute;
  };
}
/** IPv6 clients are grouped per /56 (LD-46), IPv4 per address. */
function ipKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const parts = ip.split(":");
  return parts.slice(0, 4).join(":").replace(/..$/, "00");
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** "ts=…,v1=…" split for the job payload; the worker verifies it (format only here). */
function signatureParts(header: string | undefined) {
  if (!header || header.length > 512) return { ts: null, v1: null };
  let ts: string | null = null,
    v1: string | null = null;
  for (const part of header.split(",")) {
    const [k, ...rest] = part.split("=");
    const v = rest.join("=").trim();
    if (k.trim() === "ts" && /^\d{1,20}$/.test(v)) ts = v;
    if (k.trim() === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1 = v.toLowerCase();
  }
  return { ts, v1 };
}

/** The notified id: MP sends ?data.id=… (query first, lower-cased by the worker's manifest). */
function mpDataId(req: express.Request): {
  id: string | null;
  fromQuery: boolean;
} {
  const q = req.query as Record<string, unknown>;
  const fromQuery =
    str(q["data.id"]) ??
    str((q.data as Record<string, unknown> | undefined)?.id);
  if (fromQuery) return { id: fromQuery, fromQuery: true };
  const body = req.body as { data?: { id?: unknown } } | undefined;
  return { id: str(body?.data?.id), fromQuery: false };
}

type Match = { tenantId: string; attemptIds: string[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the hook to its account and the notified id to one live attempt of that account, in a
 * transaction that sets only app.payment_hook_hash (no tenant): the two 037 lookup policies show
 * exactly that account and its attempts. When no attempt has that reference, the attempts left
 * unknown without one (a lost create answer, a dead push) are the candidates the worker checks the
 * notified id against (P2-MONEY-2, P2-PROVIDERS-9): for MP the one its data.external_reference
 * names, for Clip (whose notification carries only the id) up to three. null when nothing matches.
 */
async function match(
  sql: postgres.Sql,
  provider: Provider,
  token: string,
  reference: string,
  externalReference: string | null,
): Promise<Match | null> {
  const hash = hookHash(token);
  return (await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.payment_hook_hash', ${hash}, true)`;
    const [account] =
      await tx`select tenant_id,provider,state from payment_provider_accounts
      where hook_hash=${hash}`;
    if (!account || account.provider !== provider || account.state !== "active")
      return null;
    const [attempt] = await tx`select id from payment_attempts
      where tenant_id=${account.tenant_id} and provider=${provider}
        and lower(provider_reference)=lower(${reference})
        and state in ('sending','pending','unknown') limit 1`;
    if (attempt)
      return {
        tenantId: account.tenant_id as string,
        attemptIds: [attempt.id as string],
      };
    if (provider === "mercadopago" && !externalReference) return null;
    const orphans =
      provider === "mercadopago"
        ? await tx`select id from payment_attempts
            where tenant_id=${account.tenant_id} and provider=${provider}
              and id=${externalReference} and provider_reference is null and state='unknown'`
        : await tx`select id from payment_attempts
            where tenant_id=${account.tenant_id} and provider=${provider}
              and provider_reference is null and state='unknown'
            order by created_at desc limit 3`;
    return orphans.length
      ? {
          tenantId: account.tenant_id as string,
          attemptIds: orphans.map((o) => o.id as string),
        }
      : null;
  })) as Match | null;
}

export function webhookRoute(sql: postgres.Sql) {
  const perIp = limiter(PAYMENTS_LIMITS.webhookPerIpPerMinute);
  const perHook = limiter(PAYMENTS_LIMITS.webhookPerHookPerMinute);
  return async (req: express.Request, res: express.Response) => {
    const done = (reason: string) => {
      if (reason !== "queued") log.info("payments_webhook_dropped", { reason });
      res.status(200).set("Cache-Control", "no-store").end();
    };
    try {
      const provider = req.params.provider;
      const token = String(req.params.hook ?? "");
      if (
        (provider !== "mercadopago" && provider !== "clip") ||
        !HOOK_TOKEN.test(token)
      )
        return done("format");
      if (!perIp(ipKey(clientIp(req)))) return done("rate_ip");
      if (!perHook(token)) return done("rate_hook");
      const length = Number(req.get("content-length") ?? 0);
      if (
        length > PAYMENTS_LIMITS.webhookBodyBytes ||
        JSON.stringify(req.body ?? {}).length > PAYMENTS_LIMITS.webhookBodyBytes
      )
        return done("body_size");
      if (provider === "mercadopago") {
        const q = req.query as Record<string, unknown>;
        const body = (req.body ?? {}) as { type?: unknown; action?: unknown };
        const type = str(q.type) ?? str(q.topic) ?? str(body.type);
        const action = str(body.action);
        if (type !== "order" && !(action ?? "").startsWith("order."))
          return done("topic");
        const dataId = mpDataId(req);
        if (!dataId.id || !ID.test(dataId.id)) return done("format");
        if (!dataId.fromQuery) log.info("mp_webhook_no_query_id", {});
        // MP's order notification may carry data.external_reference (the attempt id): only a
        // candidate; the worker verifies the signature and reads the order before adopting it.
        const external = str(
          (req.body as { data?: { external_reference?: unknown } } | undefined)
            ?.data?.external_reference,
        );
        const m = await match(
          sql,
          "mercadopago",
          token,
          dataId.id,
          external && UUID.test(external) ? external : null,
        );
        if (!m) return done("no_match");
        const requestId = req.get("x-request-id")?.slice(0, 100) ?? null;
        const attemptId = m.attemptIds[0];
        await tenant(sql, m.tenantId, (tx) =>
          enqueueJob(
            tx,
            { tenantId: m.tenantId },
            {
              kind: "payments_webhook",
              dedupeKey:
                `hook:${attemptId}:${requestId ?? `${dataId.id}:${Date.now()}`}`.slice(
                  0,
                  200,
                ),
              payload: {
                attemptId,
                source: "mercadopago",
                dataId: dataId.id,
                requestId,
                ...signatureParts(req.get("x-signature")),
              },
            },
          ),
        );
      } else {
        const body = (req.body ?? {}) as { id?: unknown };
        const id = str(body.id);
        if (!id || !ID.test(id)) return done("format");
        const m = await match(sql, "clip", token, id, null);
        if (!m) return done("no_match");
        await tenant(sql, m.tenantId, async (tx) => {
          for (const attemptId of m.attemptIds)
            await enqueueJob(
              tx,
              { tenantId: m.tenantId },
              {
                kind: "payments_webhook",
                dedupeKey: `hook:${attemptId}:clip:${Date.now()}`,
                payload: { attemptId, source: "clip", dataId: id },
              },
            );
        });
      }
      wakeWorker();
      return done("queued");
    } catch (error) {
      log.warn("payments_webhook_failed", {}, error);
      return done("error");
    }
  };
}
