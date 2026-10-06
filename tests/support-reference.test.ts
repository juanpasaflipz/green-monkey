import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, responseError } from "../src/api";
import {
  errorNotice,
  supportReferenceOf,
  translateError,
  withSupportReference,
} from "../src/i18n";
import { log, requestContext, setLogSink } from "../server/logging.js";
import { supportReference } from "../shared/support";

// LD-17: RUNBOOK "Signals" tells a cashier to read out a "Referencia de soporte"; error
// notices for server errors now show it, and every log line of the request carries it.

const ID = "3f2a9c1b-7d4e-4c2a-9b1e-0123456789ab";

afterEach(() => {
  vi.unstubAllGlobals();
  setLogSink(null);
});

describe("support reference", () => {
  it("is the first 8 letters and digits of the request id, upper-cased to read aloud", () => {
    expect(supportReference(ID)).toBe("3F2A9C1B");
    expect(supportReference("ops-browser-check-0001")).toBe("OPSBROWS");
    expect(supportReference("ab_c-1")).toBe("ABC1");
  });

  it("server errors and unexpected 4xx show it after the translated text, in es and en", () => {
    const server = new ApiError("internal_error", 500, "server", ID);
    expect(errorNotice(server, "es")).toBe(
      `${translateError("internal_error", "es")} Referencia de soporte: 3F2A9C1B`,
    );
    expect(errorNotice(server, "en")).toBe(
      `${translateError("internal_error", "en")} Support reference: 3F2A9C1B`,
    );
    // A 4xx this client has no text for, and a malformed request.
    for (const unexpected of [
      new ApiError("some_new_code", 422, "domain", ID),
      new ApiError("invalid_input", 400, "domain", ID),
      new ApiError("server_draining", 503, "server", ID),
    ])
      expect(supportReferenceOf(unexpected)).toBe("3F2A9C1B");
  });

  it("domain answers, sign-in refusals, unsent requests and local errors carry none", () => {
    for (const quiet of [
      new ApiError("check_closed", 409, "domain", ID),
      new ApiError("session_expired", 401, "auth", ID),
      new ApiError("some_new_code", 401, "auth", ID),
      new ApiError("internal_error", 500, "server"),
      new ApiError("network_unavailable", 0, "network"),
      new Error("drawer_required"),
      "check_closed",
      null,
    ]) {
      expect(supportReferenceOf(quiet)).toBeNull();
      expect(errorNotice(quiet, "es")).not.toContain("Referencia de soporte");
    }
    // Same text as the code alone (the old call sites' translateError(e.message)).
    expect(errorNotice(new ApiError("check_closed", 409), "es")).toBe(
      translateError("check_closed", "es"),
    );
    expect(errorNotice(new Error("drawer_required"), "en")).toBe(
      translateError("drawer_required", "en"),
    );
  });

  it("api() keeps the request id from the error body, or from X-Request-Id when the body has none", async () => {
    const reply = (status: number, body: unknown, headers = {}) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json", ...headers },
            }),
        ),
      );
    const failure = async (p: Promise<unknown>) =>
      p.then(
        () => {
          throw Error("expected a failure");
        },
        (e: unknown) => e as ApiError,
      );
    reply(500, { error: "internal_error", requestId: ID });
    expect((await failure(api("/x", {}))).requestId).toBe(ID);
    reply(500, { error: "internal_error" }, { "x-request-id": "hdr-12345678" });
    const fromHeader = await failure(api("/x", {}));
    expect(fromHeader.requestId).toBe("hdr-12345678");
    expect(errorNotice(fromHeader, "es")).toContain(
      "Referencia de soporte: HDR12345",
    );
    reply(500, {}, { "x-request-id": ID });
    const bare = await failure(api("/x", {}));
    expect(bare.message).toBe("server_unavailable");
    expect(supportReferenceOf(bare)).toBe("3F2A9C1B");
  });

  it("the owner console's own fetches fail with the status and request id, so its notices carry the reference (POL-4)", () => {
    const json = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    // Body id first, else the header; the code falls back when the body has none.
    const fromBody = responseError(
      json(500, { error: "internal_error", requestId: ID }),
      { error: "internal_error", requestId: ID },
      "request_failed",
    );
    expect(fromBody).toMatchObject({
      message: "internal_error",
      status: 500,
      kind: "server",
      requestId: ID,
    });
    const fromHeader = responseError(
      json(502, {}, { "x-request-id": ID }),
      {},
      "request_failed",
    );
    expect(fromHeader).toMatchObject({
      message: "request_failed",
      status: 502,
      kind: "server",
      requestId: ID,
    });
    expect(errorNotice(fromHeader, "es")).toBe(
      `${translateError("request_failed", "es")} Referencia de soporte: 3F2A9C1B`,
    );
    // A screen's own generic text keeps its words and gains the reference.
    expect(withSupportReference("No se pudo entrar.", fromBody, "es")).toBe(
      "No se pudo entrar. Referencia de soporte: 3F2A9C1B",
    );
    expect(withSupportReference("Could not enter.", fromBody, "en")).toBe(
      "Could not enter. Support reference: 3F2A9C1B",
    );
    // Domain refusals, sign-in answers and network failures stay as they were.
    const refused = responseError(
      json(409, { error: "pro_required", requestId: ID }),
      { error: "pro_required", requestId: ID },
      "request_failed",
    );
    expect(refused).toMatchObject({ kind: "domain", status: 409 });
    expect(withSupportReference("No se pudo.", refused, "es")).toBe(
      "No se pudo.",
    );
    const auth = responseError(
      json(401, { error: "unauthorized", requestId: ID }),
      { error: "unauthorized", requestId: ID },
      "",
    );
    expect(auth.kind).toBe("auth");
    expect(withSupportReference("No se pudo.", auth, "es")).toBe("No se pudo.");
    expect(
      withSupportReference(
        "No se pudo.",
        new TypeError("Failed to fetch"),
        "es",
      ),
    ).toBe("No se pudo.");
  });

  it("every log line of a request carries supportRef, the value staff read out", () => {
    const lines: Record<string, unknown>[] = [];
    setLogSink((line) => lines.push(JSON.parse(line)));
    requestContext.run({ requestId: ID }, () => log.info("inside"));
    log.info("explicit", { requestId: "ops-browser-check-0001" });
    log.info("outside");
    expect(lines[0]).toMatchObject({ requestId: ID, supportRef: "3F2A9C1B" });
    expect(lines[1]).toMatchObject({ supportRef: "OPSBROWS" });
    expect(lines[2]).not.toHaveProperty("supportRef");
  });
});
