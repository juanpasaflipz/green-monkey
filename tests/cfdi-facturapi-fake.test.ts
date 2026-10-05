// The deterministic Facturapi fake (tests/fakes/facturapi-fake.ts) driven through the real client,
// builders and XML parser, in process (no sockets). These pin the fake's behaviour that DB and
// browser suites will rely on; they say nothing about Facturapi itself (see the contract tests).
import { describe, expect, it } from "vitest";
import {
  buildGlobalRequests,
  buildInvoiceRequest,
  canonicalTax,
  netGroups,
} from "../server/cfdi/build";
import { classifyFacturapiError } from "../server/cfdi/errors";
import {
  createFacturapiClient,
  FacturapiError,
  type FacturapiKey,
} from "../server/cfdi/facturapi";
import type { FInvoiceInput } from "../server/cfdi/facturapi-schema";
import { parseCfdiTotals } from "../server/cfdi/xml";
import { createFacturapiFake, FAKE_BASE_URL } from "./fakes/facturapi-fake";
import {
  cfdiPayload,
  fakeId,
  ISSUER_POSTAL_CODE,
  RECEPTOR_MORAL,
  taxedLine,
  USER_KEY,
} from "./fixtures/cfdi";

const NOW = new Date("2026-10-05T18:00:00.000Z");
const enc = (s: string) => new TextEncoder().encode(s);

/** The fake's synthetic CSD format (real X.509 files are exercised by the CSD step's fixtures). */
function csd(
  o: {
    rfc?: string;
    serial?: string;
    from?: string;
    until?: string;
    type?: "fiel";
    password?: string;
    keySerial?: string;
    keyPassword?: string;
  } = {},
) {
  const serial = o.serial ?? "30001000000500003416";
  const password = o.password ?? "12345678a";
  return {
    cer: enc(
      `FAKE-CSD;rfc=${o.rfc ?? "EKU9003173C9"};serial=${serial};from=${o.from ?? "2023-05-18T11:43:51Z"};until=${o.until ?? "2027-05-18T11:43:51Z"}${o.type ? ";type=" + o.type : ""}`,
    ),
    key: enc(
      `FAKE-KEY;serial=${o.keySerial ?? serial};password=${o.keyPassword ?? password}`,
    ),
    password,
  };
}

const LEGAL = {
  name: "La Fonda de Prueba",
  legal_name: "ESCUELA KEMPER URGATE",
  tax_system: "601",
  address: { zip: ISSUER_POSTAL_CODE },
};

function setup() {
  const fake = createFacturapiFake({ now: NOW });
  const client = createFacturapiClient({
    fetch: fake.fetch,
    baseUrl: FAKE_BASE_URL,
    userAgent: "green-monkey/test",
    timeouts: { standardMs: 60, longMs: 90 },
  });
  return { fake, client };
}

async function failure(p: Promise<unknown>): Promise<FacturapiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FacturapiError) return e;
    throw e;
  }
  throw new Error("expected a FacturapiError");
}

/** A provisioned organization (legal data, CSD) and its test key. */
async function organization(
  s: ReturnType<typeof setup>,
  name = "La Fonda · GM-0b6a1a8e",
) {
  const org = await s.client.createOrganization(USER_KEY, { name });
  await s.client.updateLegal(USER_KEY, org.id, LEGAL);
  await s.client.uploadCertificate(USER_KEY, org.id, csd());
  const test: FacturapiKey = {
    kind: "test",
    secret: await s.client.getTestApiKey(USER_KEY, org.id),
  };
  return { org, test };
}

function invoiceBody(
  legalName = RECEPTOR_MORAL.legalName,
  gross = 11600,
): FInvoiceInput {
  return buildInvoiceRequest({
    docId: fakeId(),
    payload: cfdiPayload({
      lines: [taxedLine(gross, "iva16"), taxedLine(5000, "iva0")],
    }),
    receptor: { ...RECEPTOR_MORAL, legalName },
    settings: {
      conceptMode: "grouped",
      conceptDescription: "Consumo de alimentos y bebidas",
    },
    issuerPostalCode: ISSUER_POSTAL_CODE,
    cardForm: "04",
    timezone: "America/Mexico_City",
  }).body;
}

function globalBody(): FInvoiceInput {
  return buildGlobalRequests({
    docIds: () => fakeId(),
    tickets: [101, 102, 103].map((n) => ({
      id: fakeId(),
      folio: `A-000${n}`,
      groups: netGroups(
        [
          {
            category: "iva16",
            gross: 1000 + n,
            tax: Math.round(((1000 + n) * 16) / 116),
          },
          { category: "iva0", gross: 500, tax: 0 },
        ],
        [],
      ),
      payments: [{ method: "cash", amount: 1500 + n }],
    })),
    period: { periodicity: "day", months: "10", year: 2026 },
    issuerPostalCode: ISSUER_POSTAL_CODE,
    cardForm: "04",
  })[0].body;
}

describe("Facturapi fake: organizations", () => {
  it("provisions an organization with the user key: create, find by name, legal data, CSD, test key, me, manifesto, live key", async () => {
    const s = setup();
    const { org, test } = await organization(s);
    expect(org.id).toMatch(/^[0-9a-f]{24}$/);
    expect(
      (await s.client.listOrganizations(USER_KEY, "GM-0b6a1a8e")).map(
        (o) => o.id,
      ),
    ).toEqual([org.id]);
    expect(await s.client.listOrganizations(USER_KEY, "otra")).toEqual([]);
    expect(test.secret).toMatch(/^sk_test_/);
    const me = await s.client.me(test);
    expect(me).toMatchObject({
      id: org.id,
      is_production_ready: false,
      pending_steps: [{ type: "manifiesto" }],
      legal: { legal_name: "ESCUELA KEMPER URGATE", tax_id: "EKU9003173C9" },
      certificate: {
        has_certificate: true,
        serial_number: "30001000000500003416",
        expires_at: "2027-05-18T11:43:51.000Z",
      },
    });
    s.fake.signManifesto(org.id);
    expect(
      (await s.client.getOrganization(USER_KEY, org.id)).is_production_ready,
    ).toBe(true);
    const live1 = await s.client.createLiveApiKey(USER_KEY, org.id);
    const live2 = await s.client.createLiveApiKey(USER_KEY, org.id);
    expect(live1).toMatch(/^sk_live_/);
    expect(live2).not.toBe(live1);
    // Creating a live key does not invalidate the previous one (documented).
    expect((await s.client.me({ kind: "live", secret: live1 })).id).toBe(
      org.id,
    );
    expect((await s.client.me({ kind: "live", secret: live2 })).id).toBe(
      org.id,
    );
  });

  it("a lost createOrganization response leaves exactly one organization, found again by name", async () => {
    const s = setup();
    const name = "FAKE LOST RESPONSE · GM-0b6a1a8e";
    const e = await failure(s.client.createOrganization(USER_KEY, { name }));
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: true,
      unknownOutcome: true,
    });
    const found = await s.client.listOrganizations(USER_KEY, name);
    expect(found).toHaveLength(1);
    expect(s.fake.organizations.size).toBe(1);
  });

  it("CSD upload errors map to the documented codes", async () => {
    const s = setup();
    const org = await s.client.createOrganization(USER_KEY, { name: "Org" });
    const cases: [ReturnType<typeof csd>, string][] = [
      [csd({ keyPassword: "otra" }), "cfdi_csd_password"],
      [csd({ keySerial: "30001000000500009999" }), "cfdi_csd_key_mismatch"],
      [csd({ until: "2026-01-01T00:00:00Z" }), "cfdi_csd_expired"],
      [csd({ from: "2026-12-01T00:00:00Z" }), "cfdi_csd_not_yet_valid"],
      [csd({ type: "fiel" }), "cfdi_csd_is_fiel"],
      [
        { cer: enc("not a certificate"), key: enc("nope"), password: "x" },
        "cfdi_csd_invalid",
      ],
    ];
    for (const [files, code] of cases) {
      const e = await failure(
        s.client.uploadCertificate(USER_KEY, org.id, files),
      );
      expect(classifyFacturapiError(e), code).toMatchObject({
        retry: false,
        code,
      });
    }
    await s.client.uploadCertificate(USER_KEY, org.id, csd());
    const other = await failure(
      s.client.uploadCertificate(
        USER_KEY,
        org.id,
        csd({ rfc: "URE180429TM6" }),
      ),
    );
    expect(classifyFacturapiError(other).code).toBe("cfdi_csd_rfc_mismatch");
    // A test key can read its organization but never configure it.
    const test: FacturapiKey = {
      kind: "test",
      secret: await s.client.getTestApiKey(USER_KEY, org.id),
    };
    const direct = await s.fake.fetch(
      `${FAKE_BASE_URL}/organizations/${org.id}/legal`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${test.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(LEGAL),
      },
    );
    expect(direct.status).toBe(403);
  });
});

describe("Facturapi fake: invoices", () => {
  it("stamps an invoice whose XML carries the request's concepts and the amounts cfdi expects", async () => {
    const s = setup();
    const { test } = await organization(s);
    const body = invoiceBody();
    const { httpStatus, invoice } = await s.client.createInvoice(test, body);
    expect(httpStatus).toBe(200);
    expect(invoice).toMatchObject({
      status: "valid",
      livemode: false,
      series: "F",
      folio_number: 1,
      external_id: body.external_id,
      total: 166,
    });
    expect(invoice.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(invoice.stamp?.date).toBe(NOW.toISOString());
    const xml = new TextDecoder().decode(
      await s.client.download(test, invoice.id, "xml"),
    );
    const totals = parseCfdiTotals(xml);
    expect(totals).toMatchObject({
      version: "4.0",
      type: "I",
      series: "F",
      folio: "1",
      total: 16600,
      taxTraslados: canonicalTax(body),
      uuid: invoice.uuid!.toUpperCase(),
    });
    expect(totals.taxTraslados).toBe(1600);
    expect(totals.concepts.map((c) => c.noIdentificacion)).toEqual([
      "A-000123",
      "A-000123",
    ]);
    expect(xml).toContain('UsoCFDI="G03"');
    expect(xml).toContain('LugarExpedicion="42501"');
    const pdf = await s.client.download(test, invoice.id, "pdf");
    expect(new TextDecoder().decode(pdf.subarray(0, 8))).toBe("%PDF-1.4");
    // Idempotent: the same idempotency_key returns the same invoice and stamps nothing new.
    const again = await s.client.createInvoice(test, body);
    expect(again.invoice.id).toBe(invoice.id);
    expect(s.fake.invoices.size).toBe(1);
    expect(
      (await s.client.findInvoiceByExternalId(test, body.external_id))?.id,
    ).toBe(invoice.id);
    expect(await s.client.findInvoiceByExternalId(test, fakeId())).toBeNull();
    // The next invoice of the series gets the next folio.
    expect(
      (await s.client.createInvoice(test, invoiceBody())).invoice.folio_number,
    ).toBe(2);
  });

  it("stamps a global invoice (InformacionGlobal, PUBLICO EN GENERAL) and refuses one without the global node", async () => {
    const s = setup();
    const { test } = await organization(s);
    const body = globalBody();
    const { invoice } = await s.client.createInvoice(test, body);
    const xml = new TextDecoder().decode(
      await s.client.download(test, invoice.id, "xml"),
    );
    expect(xml).toContain(
      '<cfdi:InformacionGlobal Periodicidad="01" Meses="10" Año="2026"/>',
    );
    expect(xml).toContain('Rfc="XAXX010101000" Nombre="PUBLICO EN GENERAL"');
    const totals = parseCfdiTotals(xml);
    expect(totals.concepts.map((c) => c.noIdentificacion)).toEqual([
      "A-000101",
      "A-000101",
      "A-000102",
      "A-000102",
      "A-000103",
      "A-000103",
    ]);
    expect(totals.taxTraslados).toBe(canonicalTax(body));
    expect(invoice.series).toBe("FG");
    const withoutGlobal = { ...globalBody() };
    delete withoutGlobal.global;
    const e = await failure(s.client.createInvoice(test, withoutGlobal));
    expect(e).toMatchObject({
      status: 400,
      code: "invalid_request",
      path: "global",
    });
  });

  it("magic receptor names produce the documented provider errors", async () => {
    const s = setup();
    const { test } = await organization(s);
    const cases: [
      string,
      Partial<ReturnType<typeof classifyFacturapiError>>,
    ][] = [
      [
        "FAKE NAME MISMATCH SA",
        {
          retry: false,
          code: "cfdi_receptor_name_mismatch",
          path: "customer.legal_name",
        },
      ],
      [
        "FAKE RFC NOT FOUND",
        {
          retry: false,
          code: "cfdi_receptor_rfc_not_found",
          path: "customer.tax_id",
        },
      ],
      [
        "FAKE ZIP MISMATCH",
        {
          retry: false,
          code: "cfdi_receptor_zip_mismatch",
          path: "customer.address.zip",
        },
      ],
      [
        "FAKE REGIME MISMATCH",
        {
          retry: false,
          code: "cfdi_receptor_regime_mismatch",
          path: "customer.tax_system",
        },
      ],
      ["FAKE PAC REJECT", { retry: false, code: "cfdi_stamping_rejected" }],
      ["FAKE STAMP FAILED", { retry: false, code: "cfdi_stamping_failed" }],
      [
        "FAKE UNAVAILABLE",
        {
          retry: true,
          code: "cfdi_provider_unavailable",
          unknownOutcome: true,
        },
      ],
      [
        "FAKE RATE LIMIT",
        { retry: true, code: "cfdi_provider_rate_limited", afterMs: 1000 },
      ],
    ];
    for (const [name, expected] of cases)
      expect(
        classifyFacturapiError(
          await failure(s.client.createInvoice(test, invoiceBody(name))),
        ),
        name,
      ).toMatchObject(expected);
    expect(s.fake.invoices.size).toBe(0);
    // Real receptor rules: a régimen the RFC kind cannot have, a use the régimen does not allow.
    const wrongRegime = {
      ...invoiceBody(),
      customer: { ...invoiceBody().customer, tax_system: "612" },
    };
    expect(
      (await failure(s.client.createInvoice(test, wrongRegime))).code,
    ).toBe("tax_system_not_allowed_for_tax_id");
    const base = invoiceBody();
    const wrongUse: FInvoiceInput = {
      ...base,
      use: "G03",
      customer: {
        ...base.customer,
        tax_id: "XIQB891116QE4",
        tax_system: "616",
      },
    };
    expect(await failure(s.client.createInvoice(test, wrongUse))).toMatchObject(
      { code: "invalid_request", path: "use" },
    );
  });

  it("a timeout after the invoice was created is adopted by external_id; a dropped response is replayed by the idempotency key", async () => {
    const s = setup();
    const { test } = await organization(s);
    const body = invoiceBody("FAKE TIMEOUT RECEPTOR");
    const e = await failure(s.client.createInvoice(test, body));
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: true,
      code: "cfdi_provider_timeout",
      unknownOutcome: true,
    });
    const adopted = await s.client.findInvoiceByExternalId(
      test,
      body.external_id,
    );
    expect(adopted).toMatchObject({
      status: "valid",
      external_id: body.external_id,
    });
    const retried = await s.client.createInvoice(test, body);
    expect(retried.invoice.id).toBe(adopted!.id);
    expect(s.fake.invoices.size).toBe(1);

    const lost = invoiceBody("FAKE LOST RESPONSE RECEPTOR");
    expect((await failure(s.client.createInvoice(test, lost))).code).toBe(
      "cfdi_provider_network",
    );
    expect((await s.client.createInvoice(test, lost)).invoice.external_id).toBe(
      lost.external_id,
    );
    expect(s.fake.invoices.size).toBe(2);
    const posts = s.fake.requests.filter(
      (r) => r.method === "POST" && r.path === "/v2/invoices",
    );
    expect(posts.map((r) => r.status)).toEqual(["hang", 200, "drop", 200]);
    expect(posts[0].idempotencyKey).toBe(body.idempotency_key);
  });

  it("202 pending is recovered at the next read (or fails), like Facturapi's recovery", async () => {
    const s = setup();
    const { test } = await organization(s);
    const pending = await s.client.createInvoice(
      test,
      invoiceBody("FAKE PENDING"),
    );
    expect(pending.httpStatus).toBe(202);
    expect(pending.invoice.status).toBe("pending");
    expect(pending.invoice.uuid ?? null).toBeNull();
    const recovered = await s.client.getInvoice(test, pending.invoice.id);
    expect(recovered.status).toBe("valid");
    expect(recovered.uuid).toBeTruthy();
    const failing = await s.client.createInvoice(
      test,
      invoiceBody("FAKE PENDING FAILED"),
    );
    expect(
      (await s.client.refreshInvoiceStatus(test, failing.invoice.id)).status,
    ).toBe("failed");
  });

  it("FAKE ROUNDING stamps a different IVA than canonicalTax (an amount_check 'differs' case)", async () => {
    const s = setup();
    const { test } = await organization(s);
    const body = invoiceBody("FAKE ROUNDING", 11599);
    const { invoice } = await s.client.createInvoice(test, body);
    const totals = parseCfdiTotals(
      await s.client.download(test, invoice.id, "xml"),
    );
    expect(totals.taxTraslados).not.toBe(canonicalTax(body));
    expect(totals.total).toBe(11599 + 5000);
  });

  it("cancellation: immediate within 24 h, receptor acceptance after that for nominative totals over $1,000, substitution rules and acuse", async () => {
    const s = setup();
    const { test } = await organization(s);
    const first = (await s.client.createInvoice(test, invoiceBody())).invoice;
    expect(
      (
        await s.client
          .downloadCancellationReceipt(test, first.id, "xml")
          .catch((e) => e)
      ).code,
    ).toBe("invoice_cancellation_receipt_unavailable");
    const canceled = await s.client.cancelInvoice(test, first.id, {
      motive: "02",
    });
    expect(canceled).toMatchObject({
      status: "canceled",
      cancellation_status: "accepted",
    });
    expect(
      new TextDecoder().decode(
        await s.client.downloadCancellationReceipt(test, first.id, "xml"),
      ),
    ).toContain(first.uuid!.toUpperCase());
    expect(
      (await failure(s.client.cancelInvoice(test, first.id, { motive: "02" })))
        .code,
    ).toBe("invoice_not_cancelable");

    // More than 24 h later, a nominative invoice above $1,000.00 needs the receptor's acceptance.
    const big = (
      await s.client.createInvoice(
        test,
        invoiceBody(RECEPTOR_MORAL.legalName, 116_000),
      )
    ).invoice;
    const substitute = (await s.client.createInvoice(test, invoiceBody()))
      .invoice;
    s.fake.advance(25 * 3600_000);
    expect(
      (
        await failure(
          s.client.cancelInvoice(test, big.id, {
            motive: "01",
            substitution: fakeId(),
          }),
        )
      ).code,
    ).toBe("substitution_invoice_not_found");
    const requested = await s.client.cancelInvoice(test, big.id, {
      motive: "01",
      substitution: substitute.uuid!,
    });
    expect(requested).toMatchObject({
      status: "valid",
      cancellation_status: "pending",
    });
    expect(
      (await failure(s.client.cancelInvoice(test, big.id, { motive: "02" })))
        .code,
    ).toBe("invoice_cancellation_in_progress");
    expect(await s.client.getInvoice(test, big.id)).toMatchObject({
      status: "canceled",
      cancellation_status: "accepted",
    });

    // A rejected request leaves the invoice valid.
    const rejected = (
      await s.client.createInvoice(test, invoiceBody("FAKE REJECT CANCEL"))
    ).invoice;
    expect(
      await s.client.cancelInvoice(test, rejected.id, { motive: "02" }),
    ).toMatchObject({ cancellation_status: "pending" });
    expect(await s.client.getInvoice(test, rejected.id)).toMatchObject({
      status: "valid",
      cancellation_status: "rejected",
    });

    // Público en general (globals) never needs acceptance.
    const global = (await s.client.createInvoice(test, globalBody())).invoice;
    s.fake.advance(48 * 3600_000);
    expect(
      await s.client.cancelInvoice(test, global.id, { motive: "02" }),
    ).toMatchObject({ status: "canceled" });
  });

  it("email: delivered and recorded, bounces fail, a pending invoice cannot be sent", async () => {
    const s = setup();
    const { test } = await organization(s);
    const inv = (await s.client.createInvoice(test, invoiceBody())).invoice;
    await s.client.sendByEmail(test, inv.id, ["cliente@example.com"]);
    expect(s.fake.emails).toEqual([
      { invoiceId: inv.id, to: ["cliente@example.com"] },
    ]);
    expect(
      classifyFacturapiError(
        await failure(
          s.client.sendByEmail(test, inv.id, ["bounce@example.com"]),
        ),
      ).code,
    ).toBe("cfdi_email_delivery_failed");
    const pending = (
      await s.client.createInvoice(test, invoiceBody("FAKE PENDING"))
    ).invoice;
    expect(
      classifyFacturapiError(
        await failure(
          s.client.sendByEmail(test, pending.id, ["c@example.com"]),
        ),
      ).code,
    ).toBe("cfdi_email_not_allowed");
  });

  it("strict environments: test and live invoices are separate, live needs a production-ready organization, other organizations' invoices are invisible", async () => {
    const s = setup();
    const { org, test } = await organization(s);
    const live: FacturapiKey = {
      kind: "live",
      secret: await s.client.createLiveApiKey(USER_KEY, org.id),
    };
    expect(
      classifyFacturapiError(
        await failure(s.client.createInvoice(live, invoiceBody())),
      ).code,
    ).toBe("cfdi_org_not_ready");
    s.fake.signManifesto(org.id);
    const liveInvoice = (await s.client.createInvoice(live, invoiceBody()))
      .invoice;
    expect(liveInvoice.livemode).toBe(true);
    expect(liveInvoice.folio_number).toBe(1);
    const testInvoice = (await s.client.createInvoice(test, invoiceBody()))
      .invoice;
    expect(testInvoice.folio_number).toBe(1);
    expect(
      (await failure(s.client.getInvoice(test, liveInvoice.id))).status,
    ).toBe(404);
    expect(
      (await failure(s.client.getInvoice(live, testInvoice.id))).status,
    ).toBe(404);
    const { test: otherTest } = await organization(s, "Otra · GM-11111111");
    expect(
      (await failure(s.client.getInvoice(otherTest, testInvoice.id))).status,
    ).toBe(404);
    // A user key never issues invoices (the client refuses before; the fake refuses too).
    const direct = await s.fake.fetch(
      `${FAKE_BASE_URL}/invoices/${testInvoice.id}`,
      {
        headers: { authorization: `Bearer ${USER_KEY.secret}` },
      },
    );
    expect(direct.status).toBe(403);
    // Revoked and unknown live keys.
    expect(
      classifyFacturapiError(
        await failure(
          s.client.getInvoice(
            { kind: "test", secret: "sk_test_revoked1" },
            testInvoice.id,
          ),
        ),
      ).code,
    ).toBe("cfdi_org_key_invalid");
    expect(
      classifyFacturapiError(
        await failure(
          s.client.listOrganizations(
            { kind: "user", secret: "sk_user_revoked1" },
            "x",
          ),
        ),
      ).code,
    ).toBe("cfdi_provider_auth_failed");
    expect(
      (await failure(s.client.me({ kind: "live", secret: "sk_live_unknown" })))
        .code,
    ).toBe("api_key_invalid");
  });

  it("an unknown sk_test_ key is a ready shared sandbox organization (FACTURAPI_TEST_KEY)", async () => {
    const s = setup();
    const shared: FacturapiKey = {
      kind: "test",
      secret: "sk_test_shared_box",
    };
    const me = await s.client.me(shared);
    expect(me.legal).toMatchObject({
      legal_name: "ESCUELA KEMPER URGATE",
      tax_id: "EKU9003173C9",
    });
    expect((await s.client.me(shared)).id).toBe(me.id);
    expect(
      (await s.client.createInvoice(shared, invoiceBody())).invoice.status,
    ).toBe("valid");
    expect(await s.client.listOrganizations(USER_KEY, "")).toEqual([]);
  });

  it("queued faults apply to matching requests only, then stop", async () => {
    const s = setup();
    const { test } = await organization(s);
    s.fake.fault({
      op: "invoices.create",
      fault: "stamp_rejected",
      times: 2,
      match: { global: true },
    });
    expect(
      (await s.client.createInvoice(test, invoiceBody())).invoice.status,
    ).toBe("valid");
    for (let i = 0; i < 2; i++)
      expect(
        (await failure(s.client.createInvoice(test, globalBody()))).code,
      ).toBe("invoice_stamping_validation_error");
    expect(
      (await s.client.createInvoice(test, globalBody())).invoice.status,
    ).toBe("valid");
    expect(() =>
      s.fake.fault({ op: "invoices.create", fault: "nope" as never }),
    ).toThrow();
    // The same control API is reachable over the fake's HTTP surface.
    const res = await s.fake.fetch(
      `${FAKE_BASE_URL.replace(/\/v2$/, "")}/__fake/faults`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "invoices.create", fault: "unavailable" }),
      },
    );
    expect(res.status).toBe(204);
    expect(
      (await failure(s.client.createInvoice(test, invoiceBody()))).status,
    ).toBe(503);
    expect(
      (await s.fake.fetch(`${FAKE_BASE_URL}/../__fake/state`)).status,
    ).toBe(200);
  });

  it("messages follow Accept-Language, and two fakes with the same seed and clock are identical", async () => {
    const en = createFacturapiFake({ now: NOW });
    const client = createFacturapiClient({
      fetch: en.fetch,
      baseUrl: FAKE_BASE_URL,
      locale: "en",
      userAgent: "t",
    });
    const e = await failure(
      client.listOrganizations(
        { kind: "user", secret: "sk_user_revoked1" },
        "x",
      ),
    );
    expect(e.message).toBe("The provided user key is invalid.");

    const run = async () => {
      const s = setup();
      const { test } = await organization(s);
      const body = invoiceBody();
      const { invoice } = await s.client.createInvoice(test, {
        ...body,
        external_id: fakeId(77),
        idempotency_key: fakeId(77),
      });
      return [invoice.id, invoice.uuid, test.secret];
    };
    expect(await run()).toEqual(await run());
  });
});
