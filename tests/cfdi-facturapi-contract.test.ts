// Contract tests for the Facturapi client (cfdi spec §7.2). An injected fetch records every request
// and replays authored fixtures (tests/fixtures/facturapi, provenance docs@1c2e617); nothing here
// reaches the network. Request shapes are checked against the vendored OpenAPI v2 subset.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildEgresoRequest,
  buildGlobalRequests,
  buildInvoiceRequest,
  netGroups,
} from "../server/cfdi/build";
import { classifyFacturapiError } from "../server/cfdi/errors";
import {
  assertLivemode,
  createFacturapiClient,
  FACTURAPI_BASE_URL,
  FacturapiError,
  keyKindOf,
  resolveBaseUrl,
  stampFacts,
  type FacturapiKey,
} from "../server/cfdi/facturapi";
import {
  cancelQuery,
  customerInput,
  emailInput,
  invoiceInput,
  invoiceResponse,
  itemInput,
  legalInput,
  organizationCreateInput,
  organizationResponse,
  productInput,
  taxInput,
} from "../server/cfdi/facturapi-schema";
import {
  cfdiPayload,
  fakeId,
  ISSUER_POSTAL_CODE,
  LIVE_KEY,
  RECEPTOR_MORAL,
  taxedLine,
  TEST_KEY,
  USER_KEY,
} from "./fixtures/cfdi";

const DIR = "tests/fixtures/facturapi";
type Envelope = {
  provenance: string;
  source: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  note: string;
  sdk_fields?: string[];
};
const fixture = (name: string): Envelope =>
  JSON.parse(readFileSync(join(DIR, name), "utf8")) as Envelope;
const subset = JSON.parse(
  readFileSync(join(DIR, "openapi-v2-subset.json"), "utf8"),
);
const BASE = FACTURAPI_BASE_URL;

// ---------------------------------------------------------------------------------------------
// Recording fetch
// ---------------------------------------------------------------------------------------------

type Recorded = {
  method: string;
  url: URL;
  headers: Headers;
  json?: unknown;
  form?: FormData;
};
type Reply =
  | Envelope
  | ((r: Recorded, signal: AbortSignal | null) => Promise<Response> | Response);

function respond(e: Envelope): Response {
  const isBinary = !(e.headers["content-type"] ?? "").includes("json");
  return new Response(isBinary ? (e.body as string) : JSON.stringify(e.body), {
    status: e.status,
    headers: e.headers,
  });
}

function replay(...replies: Reply[]) {
  const calls: Recorded[] = [];
  const queue = [...replies];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const type = request.headers.get("content-type") ?? "";
    const recorded: Recorded = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      ...(type.startsWith("application/json")
        ? { json: await request.json() }
        : {}),
      ...(type.startsWith("multipart/form-data")
        ? { form: await request.formData() }
        : {}),
    };
    calls.push(recorded);
    const next = queue.shift();
    if (!next)
      throw new Error(
        "unexpected request " + request.method + " " + request.url,
      );
    return typeof next === "function"
      ? next(recorded, init?.signal ?? null)
      : respond(next);
  };
  const client = createFacturapiClient({
    fetch: fetchImpl as typeof fetch,
    baseUrl: BASE,
    userAgent: "green-monkey/test",
    timeouts: { standardMs: 50, longMs: 80 },
  });
  return { client, calls };
}

/** Rejects with the abort reason once the request is aborted (a provider that never answers). */
const hang = (_: Recorded, signal: AbortSignal | null) =>
  new Promise<Response>((_resolve, reject) => {
    // Like fetch: an already-aborted signal rejects at once.
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

async function failure(p: Promise<unknown>): Promise<FacturapiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FacturapiError) return e;
    throw e;
  }
  throw new Error("expected a FacturapiError");
}

function invoiceBody(over: Record<string, unknown> = {}) {
  return {
    ...(fixture("invoice-valid.json").body as Record<string, unknown>),
    ...over,
  };
}

const sampleInvoice = () =>
  buildInvoiceRequest({
    docId: "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
    payload: cfdiPayload({
      lines: [
        taxedLine(11600, "iva16"),
        taxedLine(5000, "iva0"),
        taxedLine(2000, "exempt"),
      ],
      payments: [
        { method: "external", amount: 12000 },
        { method: "cash", amount: 6600 },
      ],
    }),
    receptor: RECEPTOR_MORAL,
    settings: {
      conceptMode: "grouped",
      conceptDescription: "Consumo de alimentos y bebidas",
    },
    issuerPostalCode: ISSUER_POSTAL_CODE,
    cardForm: "04",
    timezone: "America/Mexico_City",
    replacesUuid: "39c85a3f-275b-4341-b259-e8971d9f8a94",
  }).body;

const sampleGlobal = () =>
  buildGlobalRequests({
    docIds: () => fakeId(),
    tickets: [
      {
        id: fakeId(),
        folio: "A-000101",
        groups: netGroups(
          [
            { category: "iva16", gross: 11600, tax: 1600 },
            { category: "iva0", gross: 3000, tax: 0 },
          ],
          [],
        ),
        payments: [{ method: "cash", amount: 14600 }],
      },
    ],
    period: { periodicity: "day", months: "10", year: 2026 },
    issuerPostalCode: ISSUER_POSTAL_CODE,
    cardForm: "04",
  })[0].body;

const sampleEgreso = (kind: "invoice" | "global") =>
  buildEgresoRequest({
    docId: fakeId(),
    folio: "A-000123",
    parent: {
      kind,
      uuid: "39c85a3f-275b-4341-b259-e8971d9f8a94",
      receptor: kind === "invoice" ? RECEPTOR_MORAL : null,
      paymentForm: "28",
    },
    refund: {
      method: "external",
      groups: [{ category: "iva16", gross: 5800, tax: 800 }],
    },
    issuerPostalCode: ISSUER_POSTAL_CODE,
    cardForm: "04",
  }).body;

// ---------------------------------------------------------------------------------------------
// The vendored OpenAPI subset: pointer resolution and a structural checker
// ---------------------------------------------------------------------------------------------

type Schema = Record<string, any>;

function pointer(doc: unknown, ptr: string): unknown {
  if (!ptr.startsWith("/")) throw new Error("bad pointer " + ptr);
  return ptr
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<any>((node, key) => (node == null ? undefined : node[key]), doc);
}

function deref(s: Schema | undefined): Schema | undefined {
  let node = s;
  for (let i = 0; node && node.$ref && i < 20; i++)
    node = pointer(subset, node.$ref.slice(1)) as Schema;
  return node;
}

/** The schema and every allOf/oneOf/anyOf branch (refs resolved), depth-first. */
function branches(s: Schema | undefined, out: Schema[] = []): Schema[] {
  const node = deref(s);
  if (!node || out.includes(node)) return out;
  out.push(node);
  for (const key of ["allOf", "oneOf", "anyOf"])
    for (const sub of (node[key] ?? []) as Schema[]) branches(sub, out);
  if (node.discriminator?.mapping && !node.properties)
    branches(
      { $ref: Object.values(node.discriminator.mapping)[0] as string },
      out,
    );
  return out;
}

function propertiesOf(schemas: Schema[]): Map<string, Schema[]> {
  const props = new Map<string, Schema[]>();
  for (const b of schemas)
    for (const [name, sub] of Object.entries(
      (b.properties ?? {}) as Record<string, Schema>,
    ))
      props.set(name, [...(props.get(name) ?? []), sub]);
  return props;
}

const typeOf = (v: unknown) =>
  Array.isArray(v)
    ? "array"
    : v === null
      ? "null"
      : typeof v === "object"
        ? "object"
        : typeof v;

/**
 * Every field of `value` must be declared by the documented schema (pruned stubs count as
 * undocumented), and enum / maxLength / maxItems / type constraints must hold. `allowed` lists
 * dotted paths exempted (fields from the SDK types).
 */
function undocumented(
  schema: Schema | Schema[],
  value: unknown,
  path = "",
  allowed: string[] = [],
  problems: string[] = [],
): string[] {
  const all = (Array.isArray(schema) ? schema : [schema]).flatMap((s) =>
    branches(s),
  );
  if (all.some((s) => s["x-pruned"])) {
    problems.push(`${path || "(root)"}: schema not vendored`);
    return problems;
  }
  const t = typeOf(value);
  const declared = all
    .map((s) => s.type)
    .filter((x) => typeof x === "string") as string[];
  const compatible = (d: string) =>
    d === t || (d === "integer" && t === "number" && Number.isInteger(value));
  if (declared.length && !declared.some(compatible))
    problems.push(`${path}: ${t} is not ${declared.join("|")}`);
  for (const s of all) {
    if (
      Array.isArray(s.enum) &&
      t !== "object" &&
      t !== "array" &&
      !s.enum.includes(value)
    )
      problems.push(`${path}: ${JSON.stringify(value)} not in enum`);
    if (
      t === "string" &&
      typeof s.maxLength === "number" &&
      (value as string).length > s.maxLength
    )
      problems.push(`${path}: longer than ${s.maxLength}`);
    if (
      t === "array" &&
      typeof s.maxItems === "number" &&
      (value as unknown[]).length > s.maxItems
    )
      problems.push(`${path}: more than ${s.maxItems} items`);
  }
  if (t === "object") {
    const props = propertiesOf(all);
    for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
      const at = path ? `${path}.${key}` : key;
      if (allowed.includes(at)) continue;
      const subs = props.get(key);
      if (!subs) problems.push(`${at}: not in the documented schema`);
      else undocumented(subs, sub, at, allowed, problems);
    }
  }
  if (t === "array") {
    const items = all.map((s) => s.items).filter(Boolean) as Schema[];
    if (items.length)
      for (const item of value as unknown[])
        undocumented(items, item, path, allowed, problems);
  }
  return problems;
}

const schemaRef = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});

/** The response schema an envelope's `source` points at. */
function responseSchema(env: Envelope): Schema {
  const node = deref(
    pointer(subset, env.source.split("#")[1]) as Schema,
  ) as Schema;
  const content =
    node.content?.["application/json"] ??
    node.content?.["application/octet-stream"];
  return content?.schema as Schema;
}

/** Keys of a zod object schema (unwrapping optional). */
function zodShape(schema: z.ZodType): Record<string, z.ZodType> {
  let s: any = schema;
  for (let i = 0; i < 5 && s && !s.shape; i++)
    s = s.unwrap?.() ?? s.def?.innerType;
  return (s?.shape ?? {}) as Record<string, z.ZodType>;
}
function zodElement(schema: z.ZodType): z.ZodType {
  let s: any = schema;
  for (let i = 0; i < 5 && s && !s.element; i++)
    s = s.unwrap?.() ?? s.def?.innerType;
  return s.element as z.ZodType;
}

// ---------------------------------------------------------------------------------------------

describe("Facturapi fixtures (provenance)", () => {
  const files = readdirSync(DIR).filter(
    (f) => f.endsWith(".json") && f !== "openapi-v2-subset.json",
  );

  it("0. every fixture is an envelope with a docs@ or recorded@ provenance, and docs@ sources resolve in the vendored subset", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
    expect(subset["x-provenance"].commit).toMatch(/^1c2e617/);
    for (const name of files) {
      const env = fixture(name);
      expect(env.provenance, name).toMatch(
        /^(docs@[0-9a-f]{7}|recorded@\d{4}-\d{2}-\d{2})$/,
      );
      expect(Number.isInteger(env.status), name).toBe(true);
      expect(typeof env.headers, name).toBe("object");
      expect(env.body, name).toBeDefined();
      expect(env.note, name).toMatch(/\S/);
      if (env.provenance.startsWith("docs@")) {
        expect(env.provenance).toBe("docs@1c2e617");
        expect(env.source, name).toMatch(/^openapi_v2\.en\.yaml#\//);
        expect(pointer(subset, env.source.split("#")[1]), name).toBeDefined();
        expect(env.note, name).toMatch(/Authored|Verbatim|documented/);
      }
    }
  });

  it("0b. every body field is in the documented response schema (SDK-only fields listed explicitly)", () => {
    for (const name of files) {
      const env = fixture(name);
      const schema = responseSchema(env);
      expect(schema, name).toBeDefined();
      expect(
        undocumented(schema, env.body, "", env.sdk_fields ?? []),
        name,
      ).toEqual([]);
    }
  });

  it("0c. the response parsers accept the fixtures", () => {
    for (const name of [
      "invoice-valid.json",
      "invoice-pending.json",
      "invoice-canceled.json",
      "invoice-cancel-pending.json",
    ])
      expect(invoiceResponse.safeParse(fixture(name).body).success, name).toBe(
        true,
      );
    expect(
      organizationResponse.safeParse(fixture("organization.json").body).success,
    ).toBe(true);
  });
});

describe("Facturapi client contract", () => {
  it("1. createInvoice POSTs /v2/invoices with Bearer test key, Accept-Language es and a body that passes the strict schema", async () => {
    const { client, calls } = replay(fixture("invoice-valid.json"));
    const body = sampleInvoice();
    const result = await client.createInvoice(TEST_KEY, body);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe(`${BASE}/invoices`);
    expect(call.headers.get("authorization")).toBe(`Bearer ${TEST_KEY.secret}`);
    expect(call.headers.get("accept-language")).toBe("es");
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("user-agent")).toBe("green-monkey/test");
    expect(call.json).toEqual(body);
    expect(invoiceInput.safeParse(call.json).success).toBe(true);
    expect((call.json as { idempotency_key: string }).idempotency_key).toBe(
      (call.json as { external_id: string }).external_id,
    );
    expect(result.httpStatus).toBe(200);
    expect(result.invoice).toMatchObject({
      status: "valid",
      uuid: "39c85a3f-275b-4341-b259-e8971d9f8a94",
      folio_number: 914,
      series: "F",
      total: 116,
      livemode: false,
    });
  });

  it("1b. Accept-Language follows the client locale and the default User-Agent names the build", async () => {
    const calls: Request[] = [];
    const client = createFacturapiClient({
      locale: "en",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(new Request(input, init));
        return respond(fixture("invoice-valid.json"));
      }) as typeof fetch,
    });
    await client.getInvoice(TEST_KEY, "590ce6c56d04f840aa8438af");
    expect(calls[0].headers.get("accept-language")).toBe("en");
    expect(calls[0].headers.get("user-agent")).toMatch(/^green-monkey\/\S+$/);
    expect(calls[0].url).toBe(`${BASE}/invoices/590ce6c56d04f840aa8438af`);
  });

  it("2. request schema drift: every field cfdi can send exists in the vendored OpenAPI subset", () => {
    const ingreso = schemaRef("InvoiceIngresoInput");
    const egreso = schemaRef("InvoiceEgresoInput");
    const known = (schemas: Schema[], keys: string[], where: string) => {
      const props = propertiesOf(schemas.flatMap((s) => branches(s)));
      for (const k of keys) expect(props.has(k), `${where}.${k}`).toBe(true);
      return props;
    };
    // Header fields: ingreso has them all; egreso all but `global` (enforced by the schema refine).
    const header = Object.keys(zodShape(invoiceInput));
    const ingresoProps = known([ingreso], header, "InvoiceIngresoInput");
    known(
      [egreso],
      header.filter((k) => k !== "global"),
      "InvoiceEgresoInput",
    );
    expect(propertiesOf(branches(egreso)).has("global")).toBe(false);
    known(
      [schemaRef("CustomerCreateInput")],
      Object.keys(zodShape(customerInput)),
      "CustomerCreateInput",
    );
    const customerAddress = propertiesOf(
      branches(schemaRef("CustomerCreateInput")).flatMap((s) =>
        branches(s.properties?.address),
      ),
    );
    for (const k of Object.keys(zodShape(zodShape(customerInput).address)))
      expect(customerAddress.has(k), `customer.address.${k}`).toBe(true);
    known(
      [schemaRef("LineItemInput"), schemaRef("LineItemEgresoInput")],
      Object.keys(zodShape(itemInput)),
      "LineItemInput",
    );
    known(
      [schemaRef("ProductProperties")],
      Object.keys(zodShape(productInput)),
      "ProductProperties",
    );
    // Egreso products document every field except sku; the schema refine keeps sku off them.
    known(
      [schemaRef("ProductEgresoProperties")],
      Object.keys(zodShape(productInput)).filter((k) => k !== "sku"),
      "ProductEgresoProperties",
    );
    expect(
      propertiesOf(branches(schemaRef("ProductEgresoProperties"))).has("sku"),
    ).toBe(false);
    const egresoWithSku = structuredClone(sampleEgreso("invoice"));
    egresoWithSku.items[0].product.sku = "A-000123";
    expect(invoiceInput.safeParse(egresoWithSku).success).toBe(false);
    const ingresoWithoutSku = structuredClone(sampleInvoice());
    delete ingresoWithoutSku.items[0].product.sku;
    expect(invoiceInput.safeParse(ingresoWithoutSku).success).toBe(false);
    known([schemaRef("BaseTax")], Object.keys(zodShape(taxInput)), "BaseTax");
    const related = zodElement(zodShape(invoiceInput).related_documents);
    known(
      [schemaRef("RelatedDocumentInput")],
      Object.keys(zodShape(related)),
      "RelatedDocumentInput",
    );
    const globalProps = propertiesOf(branches(ingresoProps.get("global")![0]));
    for (const k of Object.keys(zodShape(zodShape(invoiceInput).global)))
      expect(globalProps.has(k), `global.${k}`).toBe(true);
    const addressProps = propertiesOf(
      ingresoProps.get("address")!.flatMap((s) => branches(s)),
    );
    expect(addressProps.has("zip")).toBe(true);
    known(
      [schemaRef("OrganizationLegalInput")],
      Object.keys(zodShape(legalInput)),
      "OrganizationLegalInput",
    );
    const legalAddress = propertiesOf(
      branches(schemaRef("OrganizationLegalInput")).flatMap((s) =>
        branches(s.properties?.address),
      ),
    );
    for (const k of Object.keys(zodShape(zodShape(legalInput).address)))
      expect(legalAddress.has(k), `legal.address.${k}`).toBe(true);
    known(
      [schemaRef("OrganizationCreateInput")],
      Object.keys(zodShape(organizationCreateInput)),
      "OrganizationCreateInput",
    );
    known(
      [schemaRef("OrganizationCertsInput")],
      ["cer", "key", "password"],
      "OrganizationCertsInput",
    );
    const emailBody =
      subset.paths["/invoices/{invoice_id}/email"].post.requestBody.content[
        "application/json"
      ].schema;
    known([emailBody], Object.keys(zodShape(emailInput)), "email body");
    const deleteParams = (
      subset.paths["/invoices/{invoice_id}"].delete.parameters as {
        name: string;
        in: string;
      }[]
    )
      .filter((p) => p.in === "query")
      .map((p) => p.name);
    for (const k of Object.keys(zodShape(cancelQuery)))
      expect(deleteParams).toContain(k);
  });

  it("2b. built invoice, global and egreso bodies pass the documented schemas (fields, enums, limits)", () => {
    expect(
      undocumented(schemaRef("InvoiceIngresoInput"), sampleInvoice()),
    ).toEqual([]);
    expect(
      undocumented(schemaRef("InvoiceIngresoInput"), sampleGlobal()),
    ).toEqual([]);
    expect(
      undocumented(schemaRef("InvoiceEgresoInput"), sampleEgreso("invoice")),
    ).toEqual([]);
    expect(
      undocumented(schemaRef("InvoiceEgresoInput"), sampleEgreso("global")),
    ).toEqual([]);
    // The checker does catch drift.
    expect(
      undocumented(schemaRef("InvoiceEgresoInput"), {
        ...sampleEgreso("global"),
        global: {},
      }),
    ).toContain("global: not in the documented schema");
    expect(
      undocumented(schemaRef("InvoiceIngresoInput"), {
        ...sampleInvoice(),
        payment_method: "PPX",
      }).join(),
    ).toMatch(/payment_method/);
  });

  it("3. createInvoice maps 200 valid, 202 pending, 400 with errors[] (pac), 409 idempotency_key_in_use, 429 Retry-After, network error and timeout", async () => {
    const body = sampleInvoice();

    let r = replay(fixture("invoice-valid.json"));
    expect((await r.client.createInvoice(TEST_KEY, body)).httpStatus).toBe(200);

    r = replay(fixture("invoice-pending.json"));
    const pending = await r.client.createInvoice(TEST_KEY, body);
    expect(pending.httpStatus).toBe(202);
    expect(pending.invoice.status).toBe("pending");
    expect(pending.invoice.uuid ?? null).toBeNull();

    r = replay(fixture("error-stamping-validation.json"));
    let e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({
      kind: "http",
      status: 400,
      code: "invoice_stamping_validation_error",
    });
    expect(e.details[0]).toMatchObject({ code: "402", source: "pac" });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: false,
      code: "cfdi_stamping_rejected",
      unknownOutcome: false,
    });

    r = replay(fixture("error-invalid-request.json"));
    e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({
      code: "invalid_request",
      path: "customer.email",
      logId: "log_authored_0001",
    });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: false,
      code: "cfdi_provider_invalid_request",
      path: "customer.email",
    });

    r = replay(fixture("error-idempotency-in-use.json"));
    e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({ status: 409, code: "idempotency_key_in_use" });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: true,
      afterMs: 15_000,
      unknownOutcome: true,
    });

    r = replay(fixture("error-rate-limited.json"));
    e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      retryAfterMs: 30_000,
    });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: true,
      afterMs: 30_000,
      code: "cfdi_provider_rate_limited",
    });

    r = replay(fixture("error-tax-id-not-found.json"));
    e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: false,
      code: "cfdi_receptor_rfc_not_found",
      path: "customer.tax_id",
    });

    r = replay(() => {
      throw new TypeError("fetch failed");
    });
    e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({
      kind: "network",
      status: 0,
      code: "cfdi_provider_network",
    });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: true,
      unknownOutcome: true,
    });

    r = replay(hang);
    e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({ kind: "timeout", code: "cfdi_provider_timeout" });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: true,
      unknownOutcome: true,
    });

    // A caller abort (shutdown or a lost lease) is an unknown outcome too, not a timeout.
    r = replay(hang);
    const controller = new AbortController();
    const aborted = failure(
      r.client.createInvoice(TEST_KEY, body, controller.signal),
    );
    controller.abort();
    expect(await aborted).toMatchObject({
      kind: "network",
      code: "cfdi_request_aborted",
    });

    // Unparseable error bodies keep the status.
    r = replay(() => new Response("<html>bad gateway</html>", { status: 502 }));
    e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({ kind: "http", status: 502, code: "http_502" });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: true,
      unknownOutcome: true,
    });

    // A 2xx the client cannot read: the invoice may exist, so the outcome is unknown.
    r = replay(
      () => new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    );
    e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({
      kind: "schema",
      status: 200,
      code: "cfdi_provider_schema",
    });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: false,
      unknownOutcome: true,
    });
  });

  it("3b. a documented-minimal invoice (id, created_at, livemode, status) parses; stampFacts requires uuid, total and a date only where a stamp is recorded", async () => {
    const minimal = {
      id: "590ce6c56d04f840aa8438af",
      created_at: "2026-10-05T18:00:00.000Z",
      livemode: false,
      status: "pending",
    };
    // A 202 pending object without total, date or type (CFDI-ADV-5).
    let r = replay(
      () => new Response(JSON.stringify(minimal), { status: 202 }),
    );
    const pending = await r.client.createInvoice(TEST_KEY, sampleInvoice());
    expect(pending).toMatchObject({
      httpStatus: 202,
      invoice: { status: "pending", cancellation_status: "none" },
    });
    // The same shape is found while adopting by external_id, so a document can always be adopted.
    const external = "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11";
    r = replay(
      () =>
        new Response(
          JSON.stringify({
            data: [{ ...minimal, external_id: external }],
          }),
          { status: 200 },
        ),
    );
    expect(
      await r.client.findInvoiceByExternalId(TEST_KEY, external),
    ).toMatchObject({ id: minimal.id, status: "pending" });

    // Recording a stamp: the documented valid example gives the facts in centavos.
    const valid = invoiceResponse.parse(fixture("invoice-valid.json").body);
    const facts = stampFacts(valid);
    expect(facts.uuid).toBe(valid.uuid);
    expect(facts.total).toBe(Math.round(valid.total! * 100));
    expect(facts.stampedAt).toBe(valid.stamp?.date ?? valid.date);
    // A "valid" invoice without uuid, total or any date is drift: an unreadable 2xx whose outcome
    // is unknown (adopt later), never a failure.
    for (const [over, what] of [
      [{ uuid: null }, "uuid"],
      [{ total: null }, "total"],
      [{ date: null, stamp: null }, "date"],
      [{ status: "pending" }, "status"],
    ] as const) {
      const broken = invoiceResponse.parse({
        ...(fixture("invoice-valid.json").body as object),
        ...over,
      });
      let thrown: unknown = null;
      try {
        stampFacts(broken);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, what).toBeInstanceOf(FacturapiError);
      expect(thrown, what).toMatchObject({
        kind: "schema",
        status: 200,
        code: "cfdi_provider_schema",
      });
      expect((thrown as Error).message).toContain(what);
      expect(classifyFacturapiError(thrown)).toMatchObject({
        retry: false,
        unknownOutcome: true,
      });
    }
  });

  it("4. cancelInvoice sends DELETE /invoices/{id}?motive=01&substitution=<uuid> and parses cancellation_status", async () => {
    const substitute = "8e5b2b7a-5c0f-4d1e-9b9a-1f2e3d4c5b6a";
    let r = replay(fixture("invoice-canceled.json"));
    const canceled = await r.client.cancelInvoice(
      TEST_KEY,
      "590ce6c56d04f840aa8438af",
      {
        motive: "01",
        substitution: substitute,
      },
    );
    expect(r.calls[0].method).toBe("DELETE");
    expect(r.calls[0].url.pathname).toBe(
      "/v2/invoices/590ce6c56d04f840aa8438af",
    );
    expect(Object.fromEntries(r.calls[0].url.searchParams)).toEqual({
      motive: "01",
      substitution: substitute,
    });
    expect(r.calls[0].headers.get("content-type")).toBeNull();
    expect(canceled).toMatchObject({
      status: "canceled",
      cancellation_status: "accepted",
    });

    r = replay(fixture("invoice-cancel-pending.json"));
    const requested = await r.client.cancelInvoice(
      TEST_KEY,
      "590ce6c56d04f840aa8438af",
      { motive: "02" },
    );
    expect(Object.fromEntries(r.calls[0].url.searchParams)).toEqual({
      motive: "02",
    });
    expect(requested).toMatchObject({
      status: "valid",
      cancellation_status: "pending",
    });

    // Motive 01 needs the substitute's UUID, and only motive 01 takes one: refused before any request.
    r = replay();
    expect(
      await failure(
        r.client.cancelInvoice(TEST_KEY, "590ce6c56d04f840aa8438af", {
          motive: "01",
        }),
      ),
    ).toMatchObject({
      kind: "schema",
      code: "cfdi_request_invalid",
    });
    expect(
      await failure(
        r.client.cancelInvoice(TEST_KEY, "590ce6c56d04f840aa8438af", {
          motive: "02",
          substitution: substitute,
        }),
      ),
    ).toMatchObject({ code: "cfdi_request_invalid" });
    expect(
      await failure(
        r.client.cancelInvoice(TEST_KEY, "../organizations", { motive: "02" }),
      ),
    ).toMatchObject({
      code: "cfdi_request_invalid",
    });
    expect(r.calls).toHaveLength(0);
  });

  it("5. uploadCertificate sends multipart cer (cer.cer), key (key.key) and password with the user key", async () => {
    const r = replay(fixture("organization.json"));
    const cer = new Uint8Array([0x30, 0x82, 0x01, 0x02]);
    const key = new Uint8Array([0x30, 0x82, 0x05, 0x06]);
    const org = await r.client.uploadCertificate(
      USER_KEY,
      "5a2a307be93a2f00129ea035",
      {
        cer,
        key,
        password: "12345678a",
      },
    );
    const call = r.calls[0];
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe(
      "/v2/organizations/5a2a307be93a2f00129ea035/certificate",
    );
    expect(call.headers.get("authorization")).toBe(`Bearer ${USER_KEY.secret}`);
    expect(call.headers.get("content-type")).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    const cerFile = call.form!.get("cer") as File;
    const keyFile = call.form!.get("key") as File;
    expect(cerFile.name).toBe("cer.cer");
    expect(keyFile.name).toBe("key.key");
    expect(new Uint8Array(await cerFile.arrayBuffer())).toEqual(cer);
    expect(new Uint8Array(await keyFile.arrayBuffer())).toEqual(key);
    expect(call.form!.get("password")).toBe("12345678a");
    expect([...call.form!.keys()].sort()).toEqual(["cer", "key", "password"]);
    expect(org.certificate).toMatchObject({
      has_certificate: true,
      serial_number: "20001000000300000000",
    });
    expect(org.legal?.tax_id).toBe("EKU9003173C9");

    const bad = replay(fixture("error-certificate-password.json"));
    const e = await failure(
      bad.client.uploadCertificate(LIVE_KEY, "5a2a307be93a2f00129ea035", {
        cer,
        key,
        password: "x",
      }),
    );
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: false,
      code: "cfdi_csd_password",
    });
    expect(e.message).not.toContain("12345678a");

    const none = replay();
    expect(
      await failure(
        none.client.uploadCertificate(TEST_KEY, "5a2a307be93a2f00129ea035", {
          cer,
          key,
          password: "x",
        }),
      ),
    ).toMatchObject({
      kind: "key",
      code: "cfdi_key_kind",
    });
    expect(none.calls).toHaveLength(0);
  });

  it("6. organization calls use sk_user_: create, list, get, legal, test key, live key; me uses the org key", async () => {
    const r = replay(
      fixture("organization.json"),
      fixture("organization-list.json"),
      fixture("organization.json"),
      fixture("organization.json"),
      fixture("apikey-test.json"),
      fixture("apikey-live.json"),
      fixture("organization.json"),
    );
    const { client, calls } = r;
    const created = await client.createOrganization(USER_KEY, {
      name: "La Fonda · GM-0b6a1a8e",
    });
    expect(created.id).toBe("5a2a307be93a2f00129ea035");
    const listed = await client.listOrganizations(
      USER_KEY,
      "La Fonda · GM-0b6a1a8e",
    );
    expect(listed.map((o) => o.id)).toEqual(["5a2a307be93a2f00129ea035"]);
    const got = await client.getOrganization(
      USER_KEY,
      "5a2a307be93a2f00129ea035",
    );
    expect(got).toMatchObject({
      is_production_ready: false,
      pending_steps: [{ type: "manifiesto" }],
    });
    const legal = {
      name: "La Fonda",
      legal_name: "ESCUELA KEMPER URGATE",
      tax_system: "601",
      address: {
        zip: "42501",
        street: "Calle Falsa",
        municipality: "Pachuca de Soto",
        state: "Hidalgo",
      },
    };
    await client.updateLegal(USER_KEY, "5a2a307be93a2f00129ea035", legal);
    expect(
      await client.getTestApiKey(USER_KEY, "5a2a307be93a2f00129ea035"),
    ).toBe("sk_test_API_KEY");
    expect(
      await client.createLiveApiKey(USER_KEY, "5a2a307be93a2f00129ea035"),
    ).toBe("sk_live_API_KEY");
    await client.me(TEST_KEY);

    expect(
      calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`),
    ).toEqual([
      "POST /v2/organizations",
      `GET /v2/organizations?q=${encodeURIComponent("La Fonda · GM-0b6a1a8e").replace(/%20/g, "+")}&limit=50`,
      "GET /v2/organizations/5a2a307be93a2f00129ea035",
      "PUT /v2/organizations/5a2a307be93a2f00129ea035/legal",
      "GET /v2/organizations/5a2a307be93a2f00129ea035/apikeys/test",
      "PUT /v2/organizations/5a2a307be93a2f00129ea035/apikeys/live",
      "GET /v2/organizations/me",
    ]);
    expect(calls[0].json).toEqual({ name: "La Fonda · GM-0b6a1a8e" });
    expect(calls[3].json).toEqual(legal);
    for (const c of calls.slice(0, 6))
      expect(c.headers.get("authorization")).toBe(`Bearer ${USER_KEY.secret}`);
    expect(calls[6].headers.get("authorization")).toBe(
      `Bearer ${TEST_KEY.secret}`,
    );

    // The key endpoints must return keys of the right environment.
    const wrong = replay({
      ...fixture("apikey-test.json"),
      body: "sk_live_API_KEY",
    });
    expect(
      await failure(
        wrong.client.getTestApiKey(USER_KEY, "5a2a307be93a2f00129ea035"),
      ),
    ).toMatchObject({
      kind: "schema",
      code: "cfdi_key_prefix",
    });
    // Facturapi's legal_name limit (100) is enforced before sending (spec R14).
    const long = replay();
    expect(
      await failure(
        long.client.updateLegal(USER_KEY, "5a2a307be93a2f00129ea035", {
          ...legal,
          legal_name: "X".repeat(101),
        }),
      ),
    ).toMatchObject({ code: "cfdi_request_invalid" });
    expect(long.calls).toHaveLength(0);
  });

  it("7. download xml/pdf return bytes; email; status refresh; lookup by external_id; cancellation receipt", async () => {
    const xml = '<?xml version="1.0"?><cfdi:Comprobante/>';
    const bin = (body: string, type: string): Envelope => ({
      provenance: "docs@1c2e617",
      source: "",
      status: 200,
      headers: { "content-type": type },
      body,
      note: "",
    });
    const r = replay(
      bin(xml, "application/octet-stream"),
      bin("%PDF-1.4\n%%EOF", "application/pdf"),
      bin("<Acuse/>", "application/xml"),
      fixture("email-ok.json"),
      fixture("invoice-valid.json"),
      fixture("invoice-list.json"),
      {
        ...fixture("invoice-list.json"),
        body: { page: 1, total_pages: 0, total_results: 0, data: [] },
      },
    );
    const { client, calls } = r;
    const id = "590ce6c56d04f840aa8438af";
    expect(
      new TextDecoder().decode(await client.download(TEST_KEY, id, "xml")),
    ).toBe(xml);
    expect(
      new TextDecoder().decode(await client.download(TEST_KEY, id, "pdf")),
    ).toMatch(/^%PDF/);
    expect(
      new TextDecoder().decode(
        await client.downloadCancellationReceipt(TEST_KEY, id, "xml"),
      ),
    ).toBe("<Acuse/>");
    await client.sendByEmail(TEST_KEY, id, [
      "cliente@example.com",
      "conta@example.com",
    ]);
    const refreshed = await client.refreshInvoiceStatus(TEST_KEY, id);
    expect(refreshed.status).toBe("valid");
    const docId = "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11";
    expect((await client.findInvoiceByExternalId(TEST_KEY, docId))?.id).toBe(
      id,
    );
    expect(await client.findInvoiceByExternalId(TEST_KEY, fakeId())).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `GET /v2/invoices/${id}/xml`,
      `GET /v2/invoices/${id}/pdf`,
      `GET /v2/invoices/${id}/cancellation_receipt/xml`,
      `POST /v2/invoices/${id}/email`,
      `PUT /v2/invoices/${id}/status`,
      "GET /v2/invoices",
      "GET /v2/invoices",
    ]);
    expect(calls[0].headers.get("accept")).toBe("*/*");
    expect(calls[3].json).toEqual({
      email: ["cliente@example.com", "conta@example.com"],
    });
    expect(Object.fromEntries(calls[5].url.searchParams)).toEqual({
      external_id: docId,
      limit: "10",
    });

    // Limits: an empty file is a provider fault; more than 10 recipients are refused locally.
    const empty = replay(bin("", "application/pdf"));
    expect(
      await failure(empty.client.download(TEST_KEY, id, "pdf")),
    ).toMatchObject({ kind: "schema" });
    const many = replay();
    expect(
      await failure(
        many.client.sendByEmail(
          TEST_KEY,
          id,
          Array.from({ length: 11 }, (_, i) => `c${i}@example.com`),
        ),
      ),
    ).toMatchObject({ code: "cfdi_request_invalid" });
    expect(many.calls).toHaveLength(0);
  });

  it("8. strict sandbox/live separation: wrong key kinds are refused before the call, wrong livemode after it", async () => {
    const body = sampleInvoice();
    const none = replay();
    // A user key on invoices, a live secret declared as test, a test secret declared as live.
    for (const key of [
      USER_KEY,
      { ...LIVE_KEY, kind: "test" },
      { ...TEST_KEY, kind: "live" },
      { kind: "test", secret: "sk_test_has spaces" },
      { kind: "test", secret: "pk_test_fixture" },
    ] as FacturapiKey[]) {
      const e = await failure(none.client.createInvoice(key, body));
      expect(e).toMatchObject({ kind: "key", code: "cfdi_key_kind" });
      expect(e.message).not.toContain(key.secret);
    }
    // Organization management never accepts an organization key.
    expect(
      await failure(none.client.createOrganization(TEST_KEY, { name: "X" })),
    ).toMatchObject({ kind: "key" });
    expect(
      await failure(
        none.client.getTestApiKey(LIVE_KEY, "5a2a307be93a2f00129ea035"),
      ),
    ).toMatchObject({ kind: "key" });
    expect(await failure(none.client.me(USER_KEY))).toMatchObject({
      kind: "key",
    });
    expect(none.calls).toHaveLength(0);

    // A test key that gets a live invoice back (or the reverse) is a permanent mismatch.
    let r = replay({
      ...fixture("invoice-valid.json"),
      body: invoiceBody({ livemode: true }),
    });
    let e = await failure(r.client.createInvoice(TEST_KEY, body));
    expect(e).toMatchObject({ kind: "schema", code: "cfdi_mode_mismatch" });
    expect(classifyFacturapiError(e)).toMatchObject({
      retry: false,
      unknownOutcome: true,
    });
    r = replay(fixture("invoice-valid.json"));
    e = await failure(
      r.client.getInvoice(LIVE_KEY, "590ce6c56d04f840aa8438af"),
    );
    expect(e.code).toBe("cfdi_mode_mismatch");
    r = replay({
      ...fixture("invoice-list.json"),
      body: { data: [invoiceBody({ livemode: true })] },
    });
    expect(
      (
        await failure(
          r.client.findInvoiceByExternalId(
            TEST_KEY,
            "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
          ),
        )
      ).code,
    ).toBe("cfdi_mode_mismatch");
    expect(() => assertLivemode({ livemode: false }, "live")).toThrow(
      FacturapiError,
    );
    expect(() => assertLivemode({ livemode: true }, "live")).not.toThrow();

    // Two stamped invoices for one external_id are never silently adopted.
    r = replay({
      ...fixture("invoice-list.json"),
      body: {
        data: [
          invoiceBody(),
          invoiceBody({
            id: "590ce6c56d04f840aa8438b9",
            uuid: "11111111-2222-4333-8444-555555555555",
          }),
        ],
      },
    });
    expect(
      (
        await failure(
          r.client.findInvoiceByExternalId(
            TEST_KEY,
            "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11",
          ),
        )
      ).code,
    ).toBe("cfdi_duplicate_external_id");

    // Base URL: the official one or a loopback fake, never another host.
    expect(resolveBaseUrl(undefined)).toBe(FACTURAPI_BASE_URL);
    expect(resolveBaseUrl(" ")).toBe(FACTURAPI_BASE_URL);
    expect(resolveBaseUrl(`${FACTURAPI_BASE_URL}/`)).toBe(FACTURAPI_BASE_URL);
    expect(resolveBaseUrl("http://127.0.0.1:4799/v2/")).toBe(
      "http://127.0.0.1:4799/v2",
    );
    expect(resolveBaseUrl("http://localhost:4799/v2")).toBe(
      "http://localhost:4799/v2",
    );
    for (const bad of [
      "https://evil.example/v2",
      "http://10.0.0.5/v2",
      "ftp://127.0.0.1/v2",
      "http://user:pw@127.0.0.1/v2",
      "not a url",
    ])
      expect(() => resolveBaseUrl(bad), bad).toThrow(
        "cfdi_base_url_not_allowed",
      );
    expect(() =>
      createFacturapiClient({
        baseUrl: "https://facturapi.io.evil.example/v2",
      }),
    ).toThrow("cfdi_base_url_not_allowed");
    // CFDI-ADV-6: a deployed process (APP_ENV staging or production) only ever uses the official
    // URL, so a loopback listener can never receive a provider key there.
    for (const appEnv of ["staging", "production", " production "]) {
      expect(resolveBaseUrl(undefined, appEnv)).toBe(FACTURAPI_BASE_URL);
      expect(resolveBaseUrl(`${FACTURAPI_BASE_URL}/`, appEnv)).toBe(
        FACTURAPI_BASE_URL,
      );
      for (const local of [
        "http://127.0.0.1:4799/v2",
        "http://localhost:4799/v2",
        "https://[::1]:4799/v2",
      ])
        expect(() => resolveBaseUrl(local, appEnv), appEnv).toThrow(
          "cfdi_base_url_not_allowed",
        );
    }
    for (const appEnv of [undefined, "", "development", "test"])
      expect(resolveBaseUrl("http://127.0.0.1:4799/v2", appEnv)).toBe(
        "http://127.0.0.1:4799/v2",
      );
    const saved = {
      APP_ENV: process.env.APP_ENV,
      FACTURAPI_BASE_URL: process.env.FACTURAPI_BASE_URL,
    };
    try {
      process.env.APP_ENV = "production";
      process.env.FACTURAPI_BASE_URL = "http://127.0.0.1:4799/v2";
      expect(() => createFacturapiClient()).toThrow(
        "cfdi_base_url_not_allowed",
      );
      expect(() =>
        createFacturapiClient({ baseUrl: "http://127.0.0.1:4799/v2" }),
      ).toThrow("cfdi_base_url_not_allowed");
      delete process.env.FACTURAPI_BASE_URL;
      expect(() => createFacturapiClient()).not.toThrow();
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }

    expect(keyKindOf("sk_user_x")).toBe("user");
    expect(keyKindOf("sk_test_x")).toBe("test");
    expect(keyKindOf("sk_live_x")).toBe("live");
    expect(keyKindOf("sk_prod_x")).toBeNull();
    expect(
      classifyFacturapiError(
        await failure(
          replay(fixture("error-api-key-invalid.json")).client.getInvoice(
            TEST_KEY,
            "590ce6c56d04f840aa8438af",
          ),
        ),
      ),
    ).toMatchObject({
      retry: false,
      code: "cfdi_org_key_invalid",
    });
  });
});
