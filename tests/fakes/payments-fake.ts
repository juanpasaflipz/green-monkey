/**
 * In-process fake of the Mercado Pago Orders API (Point) and the Clip PinPad API (payments spec
 * §12.2 item 13, critic R10). One HTTP server: MP under /mp, Clip under /clip. The DB suites (and
 * the kiosk's, 039) point the worker at it with MERCADOPAGO_API_URL / CLIP_API_URL (loopback only,
 * server/payments/config.ts) and script it:
 *
 *   fake.next("mercadopago" | "clip", behaviour)  the next create answers with `behaviour`:
 *     "ok" (default), "queued2205", "busy" (Clip: reader offline), "rateLimit429",
 *     "server5xx", "timeout" (the connection drops with no answer: a lost create),
 *     "clipCreateTimeout" (alias of timeout for Clip), "belowMin"
 *   fake.approve(ref, {paid?, tip?, brand?, type?, last4?, fee?})   paid at the terminal
 *   fake.decline(ref) / fake.expire(ref) / fake.cancelOnTerminal(ref) / fake.refund(ref)
 *   fake.lateApproval(ref, ms, o?)                                 approve after ms
 *   fake.atTerminalUncancellable(ref)   MP status at_terminal with cancels refused; Clip DELETE 400
 *   fake.rateLimitReads(n)              the next n reads answer 429
 *   fake.violations                     contract breaches seen (missing or reused idempotency keys
 *                                       with a different body, bad auth headers): must stay empty
 *
 * It never answers like a real provider beyond what the adapters read (server/payments/worker/
 * {mercadopago,clip}.ts), and it never leaves loopback.
 */
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

export type Behaviour =
  | "ok"
  | "queued2205"
  | "busy"
  | "rateLimit429"
  | "server5xx"
  | "timeout"
  | "clipCreateTimeout"
  | "belowMin";
type Approval = {
  paid?: number;
  tip?: number;
  brand?: string;
  type?: "credit_card" | "debit_card" | "prepaid_card";
  last4?: string;
  fee?: number | null;
  externalReference?: string;
  terminalId?: string;
};
type Charge = {
  provider: "mercadopago" | "clip";
  id: string;
  reference: string;
  device: string;
  amount: number; // minor units (MP: total incl. tip; Clip: bill)
  tip: number;
  status: string;
  detail: string;
  approval: Approval | null;
  uncancellable: boolean;
  createdAt: number;
};

const pesos = (minor: number) => (minor / 100).toFixed(2);
const toMinor = (v: unknown) => Math.round(Number(v) * 100);

export type PaymentsFake = Awaited<ReturnType<typeof startPaymentsFake>>;

export async function startPaymentsFake(
  o: {
    mpToken?: string;
    mpSecret?: string;
    mpUserId?: string;
    mpSiteId?: string;
    clipKey?: string;
    clipSecret?: string;
  } = {},
) {
  const mp = {
    accessToken: o.mpToken ?? "APP_USR-fake-token-0000000000000000",
    webhookSecret: o.mpSecret ?? "fakeWebhookSecret0000000000000000",
    userId: o.mpUserId ?? "1000001",
    siteId: o.mpSiteId ?? "MLM",
    nickname: "RESTAURANTE_FICTICIO",
    terminals: [
      {
        id: "NEWLAND_N950__FAKE0001",
        operating_mode: "PDV",
        store_id: "1",
        pos_id: "2",
      },
      {
        id: "NEWLAND_N950__FAKE0002",
        operating_mode: "STANDALONE",
        store_id: "1",
        pos_id: "3",
      },
    ],
  };
  const clip = {
    apiKey: o.clipKey ?? "fake-clip-api-key",
    secretKey: o.clipSecret ?? "fake-clip-secret-key",
    readers: [
      {
        serial_number: "P8220724FAKE01",
        status: "active",
        updated_at: new Date().toISOString(),
      },
    ],
  };
  const queue: Record<"mercadopago" | "clip", Behaviour[]> = {
    mercadopago: [],
    clip: [],
  };
  const charges = new Map<string, Charge>();
  const idempotency = new Map<string, { body: string; chargeId: string }>();
  const violations: string[] = [];
  const requests: { method: string; path: string; idempotencyKey?: string }[] =
    [];
  let readLimit = 0;
  const timers = new Set<NodeJS.Timeout>();

  const byRef = (ref: string) =>
    [...charges.values()].find((c) => c.id === ref || c.reference === ref);
  const mutate = (ref: string, fn: (c: Charge) => void) => {
    const c = byRef(ref);
    if (!c) throw Error(`payments fake: no charge ${ref}`);
    fn(c);
    return c;
  };

  function mpOrder(c: Charge) {
    const approved = c.approval;
    const paid = approved?.paid ?? c.amount;
    return {
      id: c.id,
      type: "point",
      user_id: approved?.terminalId === "__other_user" ? "999" : mp.userId,
      external_reference: approved?.externalReference ?? c.reference,
      status: c.status,
      status_detail: c.detail,
      config: { point: { terminal_id: approved?.terminalId ?? c.device } },
      transactions: {
        payments: [
          {
            id: `PAY${c.id.slice(3)}`,
            amount: pesos(c.amount),
            ...(approved
              ? {
                  paid_amount: pesos(paid),
                  ...(approved.tip ? { tip_amount: pesos(approved.tip) } : {}),
                  reference_id: `9${c.id.replace(/\D/g, "").slice(0, 10) || "1"}`,
                  payment_method: {
                    id: approved.brand ?? "visa",
                    type: approved.type ?? "credit_card",
                    installments: 1,
                  },
                }
              : {}),
            status: c.status,
            status_detail: c.detail,
          },
        ],
      },
    };
  }
  function clipPayment(c: Charge) {
    const approved = c.approval;
    const status =
      c.status === "processed"
        ? "COMPLETED"
        : c.status === "canceled"
          ? "CANCELED"
          : c.status === "failed"
            ? "REJECTED"
            : c.status === "expired"
              ? "TIMEOUT_CANCELED"
              : "PENDING";
    const gross = approved?.paid ?? c.amount + c.tip;
    return {
      pinpad_request_id: c.id,
      reference: approved?.externalReference ?? c.reference,
      amount: pesos(c.amount),
      ...(approved
        ? { amount_paid: pesos(gross), tip_amount: pesos(gross - c.amount) }
        : {}),
      status,
      ...(approved
        ? {
            detail: {
              results: [
                {
                  id: randomUUID(),
                  transaction_id: randomUUID(),
                  status: "approved",
                  amount: gross / 100,
                  paid_amount: gross / 100,
                  net_amount: gross / 100,
                  currency: "MXN",
                  payment_method: {
                    id: approved.brand ?? "master",
                    type: approved.type ?? "debit_card",
                    card: {
                      last_digits: approved.last4 ?? "4444",
                      name: "\u0000".repeat(12),
                    },
                  },
                  device: { id: approved.terminalId ?? c.device },
                },
              ],
            },
          }
        : {}),
    };
  }

  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const key = req.headers["x-idempotency-key"] as string | undefined;
    requests.push({
      method: req.method ?? "",
      path: url.pathname,
      idempotencyKey: key,
    });

    // ---- Mercado Pago
    if (url.pathname.startsWith("/mp/")) {
      const path = url.pathname.slice(3);
      if (req.headers.authorization !== `Bearer ${mp.accessToken}`) {
        if (!String(req.headers.authorization ?? "").startsWith("Bearer "))
          violations.push(`mp auth header missing on ${path}`);
        return send(res, 401, { message: "invalid_token" });
      }
      if (req.method === "GET" && path === "/users/me")
        return send(res, 200, {
          id: Number(mp.userId),
          nickname: mp.nickname,
          site_id: mp.siteId,
        });
      if (req.method === "GET" && path === "/terminals/v1/list")
        return send(res, 200, {
          data: { terminals: mp.terminals },
          paging: { total: mp.terminals.length },
        });
      if (req.method === "PATCH" && path === "/terminals/v1/setup") {
        const t = (
          body.terminals as { id: string; operating_mode: string }[]
        )?.[0];
        const found = mp.terminals.find((x) => x.id === t?.id);
        if (!found) return send(res, 400, { message: "terminal not found" });
        if (
          t.operating_mode === "PDV" &&
          mp.terminals.some((x) => x.operating_mode === "PDV" && x.id !== t.id)
        )
          return send(res, 400, { message: "only one PDV terminal per pos" });
        found.operating_mode = t.operating_mode;
        return send(res, 200, { terminals: [found] });
      }
      if (req.method === "POST" && path === "/v1/orders") {
        if (!key) {
          violations.push("mp create without X-Idempotency-Key");
          return send(res, 400, { message: "missing idempotency key" });
        }
        const prior = idempotency.get(key);
        if (prior) {
          if (prior.body !== raw)
            violations.push(
              `mp idempotency key ${key} reused with another body`,
            );
          return send(res, 201, mpOrder(charges.get(prior.chargeId)!));
        }
        const behaviour = queue.mercadopago.shift() ?? "ok";
        if (behaviour === "timeout" || behaviour === "clipCreateTimeout") {
          // Created at the provider, answer lost.
          const c = newCharge("mercadopago", body, key);
          idempotency.set(key, { body: raw, chargeId: c.id });
          req.socket.destroy();
          return;
        }
        if (behaviour === "queued2205")
          return send(res, 409, {
            errors: [
              {
                code: "2205",
                message: "There is already a queued intent for the device",
              },
            ],
          });
        if (behaviour === "busy")
          return send(res, 400, {
            errors: [{ code: "terminal_busy", message: "terminal busy" }],
          });
        if (behaviour === "belowMin")
          return send(res, 400, {
            errors: [
              {
                code: "property_value",
                message: "invalid",
                details: [
                  "'$.transactions.payments[0].amount' must be greater than or equal to 5",
                ],
              },
            ],
          });
        if (behaviour === "rateLimit429") return send(res, 429, {});
        if (behaviour === "server5xx") return send(res, 503, {});
        const c = newCharge("mercadopago", body, key);
        idempotency.set(key, { body: raw, chargeId: c.id });
        return send(res, 201, mpOrder(c));
      }
      const order = /^\/v1\/orders\/([^/]+)(\/cancel)?$/.exec(path);
      if (order) {
        const c = charges.get(order[1]);
        if (!c) return send(res, 404, { message: "not found" });
        if (req.method === "GET") {
          if (readLimit > 0) {
            readLimit--;
            return send(res, 429, {});
          }
          return send(res, 200, mpOrder(c));
        }
        if (req.method === "POST" && order[2]) {
          if (!key) violations.push("mp cancel without X-Idempotency-Key");
          if (
            c.status === "created" ||
            (c.status === "at_terminal" &&
              req.headers["x-allow-cancelable-status"] === "at_terminal" &&
              !c.uncancellable)
          ) {
            c.status = "canceled";
            c.detail = "canceled";
            return send(res, 200, mpOrder(c));
          }
          return send(res, 409, {
            errors: [
              { code: "order_not_cancelable", message: "cannot cancel" },
            ],
          });
        }
      }
      const payment = /^\/v1\/payments\/(\d+)$/.exec(path);
      if (req.method === "GET" && payment) {
        const c = [...charges.values()].find(
          (x) =>
            x.approval &&
            `9${x.id.replace(/\D/g, "").slice(0, 10) || "1"}` === payment[1],
        );
        if (!c) return send(res, 404, {});
        const fee = c.approval?.fee;
        return send(res, 200, {
          id: Number(payment[1]),
          fee_details:
            fee === null || fee === undefined
              ? []
              : [{ type: "mercadopago_fee", amount: fee / 100 }],
          card: { last_four_digits: c.approval?.last4 ?? "4242" },
          payment_type_id: c.approval?.type ?? "credit_card",
        });
      }
      return send(res, 404, {});
    }

    // ---- Clip
    if (url.pathname.startsWith("/clip/")) {
      const path = url.pathname.slice(5);
      const expected = `Basic ${Buffer.from(`${clip.apiKey}:${clip.secretKey}`).toString("base64")}`;
      if (req.headers.authorization !== expected) {
        if (!String(req.headers.authorization ?? "").startsWith("Basic "))
          violations.push(`clip auth header missing on ${path}`);
        return send(res, 401, { code: "UNAUTHORIZED" });
      }
      if (req.method === "GET" && path === "/devices/status")
        return send(res, 200, clip.readers);
      if (req.method === "POST" && path === "/payment") {
        if (key)
          violations.push(
            "clip create carried an idempotency key Clip does not document",
          );
        const behaviour = queue.clip.shift() ?? "ok";
        if (behaviour === "timeout" || behaviour === "clipCreateTimeout") {
          newCharge("clip", body, null);
          req.socket.destroy();
          return;
        }
        if (behaviour === "busy")
          return send(res, 400, {
            code: "PINPAD_TERMINAL_TIMEOUT_EXCEPTION",
            message: "Unable to connect to pinpad terminal.",
          });
        if (behaviour === "rateLimit429") return send(res, 429, {});
        if (behaviour === "server5xx") return send(res, 503, {});
        const c = newCharge("clip", body, null);
        return send(res, 200, {
          pinpad_request_id: c.id,
          reference: c.reference,
          amount: pesos(c.amount),
          serial_number_pos: c.device,
        });
      }
      if (req.method === "GET" && path === "/payment") {
        const c = charges.get(url.searchParams.get("pinpadRequestId") ?? "");
        if (!c) return send(res, 404, { code: "PAYMENT_NOT_FOUND" });
        if (req.headers["pinpad-include-detail"] !== "true")
          violations.push("clip read without Pinpad-Include-Detail");
        if (readLimit > 0) {
          readLimit--;
          return send(res, 429, {});
        }
        return send(res, 200, clipPayment(c));
      }
      const bySerial = /^\/payment\/serial-number\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && bySerial) {
        const c = [...charges.values()].find(
          (x) =>
            x.provider === "clip" &&
            x.device === bySerial[1] &&
            x.status === "created",
        );
        if (!c)
          return send(res, 400, {
            code: "PAYMENT_REQUEST_ISSUE",
            message: "nothing to cancel",
          });
        c.status = "canceled";
        return send(res, 200, {
          pinpad_request_id: c.id,
          reference: c.reference,
          serial_number_pos: c.device,
        });
      }
      const del = /^\/payment\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && del) {
        const c = charges.get(del[1]);
        if (!c) return send(res, 404, { code: "PAYMENT_NOT_FOUND" });
        if (c.status !== "created" || c.uncancellable)
          return send(res, 400, {
            code: "PAYMENT_REQUEST_ISSUE",
            message:
              "The payment requested was removed or was taken successfully by CLIP POS",
          });
        c.status = "canceled";
        return send(res, 200, { pinpad_request_id: c.id });
      }
      return send(res, 404, {});
    }
    return send(res, 404, {});
  }

  function newCharge(
    provider: "mercadopago" | "clip",
    body: Record<string, unknown>,
    key: string | null,
  ): Charge {
    const id =
      provider === "mercadopago"
        ? `ORD${randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()}`
        : `pinpad-${randomUUID()}`;
    const c: Charge =
      provider === "mercadopago"
        ? {
            provider,
            id,
            reference: String(body.external_reference ?? key),
            device: String(
              (body.config as { point?: { terminal_id?: string } })?.point
                ?.terminal_id ?? "",
            ),
            amount: toMinor(
              (body.transactions as { payments: { amount: string }[] })
                .payments[0].amount,
            ),
            tip: 0,
            status: "created",
            detail: "created",
            approval: null,
            uncancellable: false,
            createdAt: Date.now(),
          }
        : {
            provider,
            id,
            reference: String(body.reference),
            device: String(body.serial_number_pos),
            amount: toMinor(body.amount),
            tip: body.tip_amount === undefined ? 0 : toMinor(body.tip_amount),
            status: "created",
            detail: "created",
            approval: null,
            uncancellable: false,
            createdAt: Date.now(),
          };
    charges.set(id, c);
    return c;
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      violations.push(`fake error: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const fake = {
    url: base,
    mpBase: `${base}/mp`,
    clipBase: `${base}/clip`,
    mp,
    clip,
    charges,
    requests,
    violations,
    next(provider: "mercadopago" | "clip", behaviour: Behaviour) {
      queue[provider].push(behaviour);
    },
    /** The charge pushed for an attempt (its external reference). */
    chargeFor(attemptId: string) {
      return (
        [...charges.values()].find((c) => c.reference === attemptId) ?? null
      );
    },
    atTerminal(ref: string) {
      return mutate(ref, (c) => {
        c.status = "at_terminal";
        c.detail = "at_terminal";
      });
    },
    approve(ref: string, a: Approval = {}) {
      return mutate(ref, (c) => {
        c.status = "processed";
        c.detail = "accredited";
        c.approval = { ...a };
      });
    },
    decline(ref: string) {
      return mutate(ref, (c) => {
        c.status = "failed";
        c.detail = "rejected";
      });
    },
    expire(ref: string) {
      return mutate(ref, (c) => {
        c.status = "expired";
        c.detail = "expired";
      });
    },
    cancelOnTerminal(ref: string) {
      return mutate(ref, (c) => {
        c.status = "canceled";
        c.detail = "canceled_on_terminal";
      });
    },
    refund(ref: string) {
      return mutate(ref, (c) => {
        c.status = "refunded";
        c.detail = "refunded";
        c.approval ??= {};
      });
    },
    atTerminalUncancellable(ref: string) {
      return mutate(ref, (c) => {
        c.status = "at_terminal";
        c.detail = "at_terminal";
        c.uncancellable = true;
      });
    },
    lateApproval(ref: string, ms: number, a: Approval = {}) {
      const t = setTimeout(() => {
        timers.delete(t);
        fake.approve(ref, a);
      }, ms);
      timers.add(t);
    },
    rateLimitReads(n: number) {
      readLimit = n;
    },
    /** An MP notification signed with the account's secret (what MP would send). */
    signMp(dataId: string, requestId: string, ts = String(Date.now())) {
      const v1 = createHmac("sha256", mp.webhookSecret)
        .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`)
        .digest("hex");
      return `ts=${ts},v1=${v1}`;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return fake;
}
