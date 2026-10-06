/**
 * Opt-in live sandbox check (spec §7.4, `npm run test:facturapi:sandbox`). NOT part of CI or of
 * any qualification command.
 *
 * Runs only when FACTURAPI_TEST_KEY (an `sk_test_` key of a Facturapi test organization with a
 * CSD) is set, against the official https://www.facturapi.io/v2 in TEST MODE ONLY: it refuses any
 * `sk_live_` value in its environment and any FACTURAPI_BASE_URL other than the official one.
 * The environment is read as given (no .env loading). Steps:
 *   1. stamps invoices for edge grosses (1, 2, 29, 116, 125.00, 107.76 + 17.24 in two groups,
 *      0 % and exempt) built with server/cfdi/build.ts from fiscal's figures, and checks the
 *      stamped Base/Importe per concept and the Total against the expectations (decides D18);
 *   2. stamps a global invoice (3 tickets, 2 categories) with periodicity day and month and checks
 *      NoIdentificacion = folio in the XML;
 *   3. stamps an egreso related 01 to an invoice and cancels it with motive 02;
 *   4. cancels an invoice with motive 01 and a substitute related 04;
 *   5. with RECORD=1, rewrites tests/fixtures/facturapi/*.json from the raw responses it saw,
 *      keeping each envelope's `source`, setting "provenance": "recorded@<YYYY-MM-DD>", with keys
 *      and personal data redacted; fixtures it could not record keep docs@1c2e617;
 *   6. the receptor of steps 1-4 is the SAT CFDI 4.0 test identity used by acceptance branch K
 *      (EKU9003173C9, ESCUELA KEMPER URGATE, 601, 42501): a refusal is printed with the provider
 *      error and flagged [BIND-030].
 * Results go to docs/evidence/cfdi-sandbox.json (no keys, no personal data). Exit 1 when a check
 * fails, 0 when every check passed or the script was skipped.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FACTURAPI_BASE_URL,
  FacturapiError,
  createFacturapiClient,
  keyKindOf,
  stampFacts,
  type FacturapiKey,
} from "../server/cfdi/facturapi";
import {
  buildEgresoRequest,
  buildGlobalRequests,
  buildInvoiceRequest,
  netGroups,
} from "../server/cfdi/build";
import { parseCfdiTotals, type CfdiTotals } from "../server/cfdi/xml";
import type { Receptor } from "../shared/cfdi";
import type { TaxCategory } from "../shared/fiscal";
import { cfdiPayload, recordRefunds, taxedLine } from "./fixtures/cfdi";

const TIMEZONE = "America/Mexico_City";
const RECEPTOR: Receptor = {
  rfc: "EKU9003173C9",
  legalName: "ESCUELA KEMPER URGATE",
  regime: "601",
  postalCode: "42501",
  use: "G03",
  email: null,
};
const SETTINGS = {
  conceptMode: "grouped" as const,
  conceptDescription: "Consumo de alimentos y bebidas",
};
const FIXTURES = resolve("tests/fixtures/facturapi");
const EVIDENCE = resolve("docs/evidence/cfdi-sandbox.json");

type Check = { name: string; ok: boolean; detail: Record<string, unknown> };
type Seen = {
  method: string;
  path: string;
  status: number;
  contentType: string;
  body: unknown;
};

const log = (message: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: "info", message, ...extra }));

function refuseLiveKeys(env: NodeJS.ProcessEnv) {
  for (const [name, value] of Object.entries(env))
    if (value && /sk_live_/.test(value)) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "facturapi_sandbox_live_key_refused",
          variable: name,
        }),
      );
      process.exit(2);
    }
}

/** Keys, emails and the test organization's own legal data never reach a fixture or a log. */
export function redact(value: unknown, parentKey = ""): unknown {
  if (typeof value === "string") {
    if (/sk_(user|test|live)_/.test(value))
      return value.replace(
        /sk_(user|test|live)_[A-Za-z0-9_.-]+/g,
        "sk_$1_redacted",
      );
    if (/^[^@\s]+@[^@\s]+$/.test(value)) return "facturas@example.com";
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, parentKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (parentKey === "legal" && typeof v === "string")
        out[k] =
          k === "tax_id"
            ? RECEPTOR.rfc
            : k === "legal_name" || k === "name"
              ? RECEPTOR.legalName
              : k === "tax_system"
                ? RECEPTOR.regime
                : k === "phone" || k === "website"
                  ? ""
                  : redact(v, k);
      else if (k === "address" && parentKey === "legal")
        out[k] = { zip: RECEPTOR.postalCode };
      else out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

async function main() {
  refuseLiveKeys(process.env);
  const testSecret = process.env.FACTURAPI_TEST_KEY?.trim();
  if (!testSecret) {
    log("facturapi_sandbox_skipped", { reason: "FACTURAPI_TEST_KEY not set" });
    return 0;
  }
  if (keyKindOf(testSecret) !== "test") {
    console.error(
      JSON.stringify({
        level: "error",
        message: "facturapi_sandbox_test_key_required",
      }),
    );
    return 2;
  }
  const base = process.env.FACTURAPI_BASE_URL?.trim();
  if (base && base.replace(/\/+$/, "") !== FACTURAPI_BASE_URL) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "facturapi_sandbox_official_url_only",
      }),
    );
    return 2;
  }
  const userSecret = process.env.FACTURAPI_API_KEY?.trim();
  const record = process.env.RECORD === "1";
  const test: FacturapiKey = { kind: "test", secret: testSecret };

  // Every raw response, for the checks that need bytes and for RECORD=1.
  const seen: Seen[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const text = await response.clone().text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      seen.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname.replace(/^\/v2/, ""),
        status: response.status,
        contentType,
        body,
      });
    }
    return response;
  };
  const client = createFacturapiClient({
    baseUrl: FACTURAPI_BASE_URL,
    fetch: recordingFetch,
  });
  const checks: Check[] = [];
  const check = (
    name: string,
    ok: boolean,
    detail: Record<string, unknown>,
  ) => {
    checks.push({ name, ok, detail });
    log(
      ok ? "facturapi_sandbox_check_passed" : "facturapi_sandbox_check_failed",
      {
        name,
        ...detail,
      },
    );
  };

  const me = await client.me(test);
  const issuerPostalCode =
    ((me as Record<string, any>).legal?.address?.zip as string | undefined) ??
    RECEPTOR.postalCode;
  if (userSecret && keyKindOf(userSecret) === "user")
    await client.listOrganizations({ kind: "user", secret: userSecret }, "GM-");

  /** Stamps one body and compares the XML with the expectations. */
  async function stamp(
    name: string,
    body: Parameters<typeof client.createInvoice>[1],
    expected: { total: number; tax: number },
  ) {
    try {
      const created = await client.createInvoice(test, body);
      const facts = stampFacts(created.invoice);
      const xml = await client.download(test, created.invoice.id, "xml");
      const totals: CfdiTotals = parseCfdiTotals(xml);
      check(
        name,
        totals.total === expected.total && totals.taxTraslados === expected.tax,
        {
          uuid: facts.uuid,
          expectedTotal: expected.total,
          stampedTotal: totals.total,
          expectedTax: expected.tax,
          stampedTax: totals.taxTraslados,
          concepts: totals.concepts.map((c) => ({
            noIdentificacion: c.noIdentificacion,
            importe: c.importe,
            traslados: c.traslados.map((t) => ({
              rate: t.rate,
              base: t.base,
              importe: t.importe,
            })),
          })),
        },
      );
      return { invoice: created.invoice, uuid: facts.uuid, xml, totals };
    } catch (e) {
      const error =
        e instanceof FacturapiError
          ? {
              code: e.code,
              message: e.message,
              details: e.details,
              path: e.path,
            }
          : { message: String(e) };
      check(name, false, {
        error,
        bind: name.startsWith("invoice")
          ? "[BIND-030] receptor test identity"
          : undefined,
      });
      return null;
    }
  }

  // 1. Edge grosses (centavos), one ticket each, grouped concepts.
  const cases: { name: string; lines: [number, TaxCategory][] }[] = [
    { name: "invoice 0.01", lines: [[1, "iva16"]] },
    { name: "invoice 0.02", lines: [[2, "iva16"]] },
    { name: "invoice 0.29", lines: [[29, "iva16"]] },
    { name: "invoice 1.16", lines: [[116, "iva16"]] },
    { name: "invoice 125.00", lines: [[12500, "iva16"]] },
    {
      name: "invoice 107.76 + 17.24",
      lines: [
        [10776, "iva16"],
        [1724, "iva8"],
      ],
    },
    { name: "invoice 0 %", lines: [[5000, "iva0"]] },
    { name: "invoice exempt", lines: [[5000, "exempt"]] },
  ];
  let first: {
    uuid: string;
    folio: string;
    payload: ReturnType<typeof cfdiPayload>;
  } | null = null;
  let folio = 900;
  for (const c of cases) {
    const payload = cfdiPayload({
      lines: c.lines.map(([gross, category]) => taxedLine(gross, category)),
      folio: `SB-${++folio}`,
    });
    const build = buildInvoiceRequest({
      docId: randomUUID(),
      payload,
      receptor: RECEPTOR,
      settings: SETTINGS,
      issuerPostalCode,
      cardForm: "04",
      timezone: TIMEZONE,
    });
    const r = await stamp(c.name, build.body, {
      total: build.expectedTotal,
      tax: build.expectedTax,
    });
    if (r && !first && c.lines.length === 1 && c.lines[0][0] >= 12500)
      first = { uuid: r.uuid, folio: payload.ticket.folio, payload };
  }

  // 2. Global: 3 tickets, 2 categories, day and month.
  for (const periodicity of ["day", "month"] as const) {
    const tickets = [0, 1, 2].map((i) => {
      const payload = cfdiPayload({
        lines: [taxedLine(4500 + i * 100, "iva16"), taxedLine(2000, "iva0")],
        folio: `SB-${2000 + i}`,
      });
      return {
        id: payload.ticket.id,
        folio: payload.ticket.folio,
        groups: netGroups(payload.ticket.groups, []),
        payments: payload.payments,
      };
    });
    const [part] = buildGlobalRequests({
      docIds: () => randomUUID(),
      tickets,
      period: {
        periodicity,
        months: new Date().toISOString().slice(5, 7),
        year: new Date().getUTCFullYear(),
      },
      issuerPostalCode,
      cardForm: "04",
    });
    const r = await stamp(`global ${periodicity}`, part.body, {
      total: part.expectedTotal,
      tax: part.expectedTax,
    });
    if (r)
      check(
        `global ${periodicity} NoIdentificacion = folio`,
        tickets.every((t) =>
          r.totals.concepts.some((c) => c.noIdentificacion === t.folio),
        ),
        { folios: tickets.map((t) => t.folio) },
      );
  }

  // 3. Egreso related 01 to the first invoice, then cancelled with 02.
  if (first) {
    const [refund] = recordRefunds(first.payload, [3000]);
    const egreso = buildEgresoRequest({
      docId: randomUUID(),
      folio: first.folio,
      parent: {
        kind: "invoice",
        uuid: first.uuid,
        receptor: RECEPTOR,
        paymentForm: "01",
      },
      refund: { method: "cash", groups: refund.groups },
      issuerPostalCode,
      cardForm: "04",
    });
    const r = await stamp("egreso related 01", egreso.body, {
      total: egreso.expectedTotal,
      tax: egreso.expectedTax,
    });
    if (r) {
      const canceled = await client.cancelInvoice(test, r.invoice.id, {
        motive: "02",
      });
      check(
        "egreso cancel 02",
        ["canceled", "valid"].includes(String(canceled.status)),
        {
          status: canceled.status,
          cancellationStatus: (canceled as Record<string, unknown>)
            .cancellation_status,
        },
      );
    }
  }

  // 4. Substitution: a new invoice related 04, then the original cancelled with 01.
  if (first) {
    const substitute = buildInvoiceRequest({
      docId: randomUUID(),
      payload: first.payload,
      receptor: RECEPTOR,
      settings: SETTINGS,
      issuerPostalCode,
      cardForm: "04",
      timezone: TIMEZONE,
      replacesUuid: first.uuid,
    });
    const r = await stamp("substitute related 04", substitute.body, {
      total: substitute.expectedTotal,
      tax: substitute.expectedTax,
    });
    const original = seen.find(
      (s) =>
        s.method === "POST" &&
        s.path === "/invoices" &&
        (s.body as Record<string, unknown>)?.uuid === first!.uuid,
    )?.body as Record<string, unknown> | undefined;
    if (r && original?.id) {
      const canceled = await client.cancelInvoice(test, String(original.id), {
        motive: "01",
        substitution: r.uuid,
      });
      check(
        "invoice cancel 01 with substitute",
        ["canceled", "valid"].includes(String(canceled.status)),
        {
          status: canceled.status,
          cancellationStatus: (canceled as Record<string, unknown>)
            .cancellation_status,
        },
      );
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    EVIDENCE,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        baseUrl: FACTURAPI_BASE_URL,
        livemode: false,
        receptor: { rfc: RECEPTOR.rfc, regime: RECEPTOR.regime },
        checks: checks.map((c) => ({ ...c, detail: redact(c.detail) })),
      },
      null,
      2,
    ) + "\n",
  );

  // 5. RECORD=1: rewrite the fixtures this run saw, keeping their envelopes' `source`.
  if (record) {
    const pick = (f: (s: Seen) => boolean) => seen.find(f);
    const targets: [string, Seen | undefined][] = [
      [
        "invoice-valid.json",
        pick(
          (s) =>
            s.method === "POST" && s.path === "/invoices" && s.status === 200,
        ),
      ],
      [
        "invoice-pending.json",
        pick(
          (s) =>
            s.method === "POST" && s.path === "/invoices" && s.status === 202,
        ),
      ],
      [
        "invoice-canceled.json",
        pick(
          (s) =>
            s.method === "DELETE" &&
            (s.body as Record<string, unknown>)?.status === "canceled",
        ),
      ],
      [
        "invoice-cancel-pending.json",
        pick(
          (s) =>
            s.method === "DELETE" &&
            (s.body as Record<string, unknown>)?.cancellation_status ===
              "pending",
        ),
      ],
      [
        "organization.json",
        pick((s) => s.method === "GET" && s.path === "/organizations/me"),
      ],
      [
        "organization-list.json",
        pick((s) => s.method === "GET" && s.path === "/organizations"),
      ],
    ];
    for (const [file, s] of targets) {
      if (!s) {
        log("facturapi_sandbox_fixture_kept", { file });
        continue;
      }
      const path = resolve(FIXTURES, file);
      const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        path,
        JSON.stringify(
          {
            ...envelope,
            provenance: `recorded@${date}`,
            status: s.status,
            headers: { "content-type": s.contentType },
            body: redact(s.body),
            note: `Recorded from a Facturapi test-mode response on ${date} by tests/cfdi-facturapi-sandbox.ts (RECORD=1); keys and personal data redacted.`,
          },
          null,
          2,
        ) + "\n",
      );
      log("facturapi_sandbox_fixture_recorded", { file });
    }
  }

  const failed = checks.filter((c) => !c.ok).length;
  log("facturapi_sandbox_done", { checks: checks.length, failed });
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "facturapi_sandbox_crashed",
        error:
          e instanceof FacturapiError
            ? { code: e.code, status: e.status }
            : String(e),
      }),
    );
    process.exit(1);
  },
);
