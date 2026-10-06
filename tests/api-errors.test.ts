import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type express from "express";
import { z } from "zod";
import { apiErrorHandler, classifyApiError } from "../server/api-errors.js";
import { setLogSink } from "../server/logging.js";
import { DomainError } from "../shared/domain.js";

let lines: Record<string, any>[] = [];
beforeEach(() => {
  lines = [];
  process.env.LOG_LEVEL = "debug";
  setLogSink((line) => lines.push(JSON.parse(line)));
});
afterEach(() => {
  setLogSink(null);
  delete process.env.LOG_LEVEL;
});

/** body-parser's errors carry `type` and `status` (expressjs/body-parser "Errors"). */
const bodyParserError = (type: string, status: number) =>
  Object.assign(new Error(type), { type, status, expose: true });

function fakeExchange(socket: { destroyed: boolean; writable: boolean }) {
  const req = {
    method: "POST",
    baseUrl: "",
    route: undefined,
    get: () => undefined,
  } as unknown as express.Request;
  const sent: {
    status?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = { headers: {} };
  const res = {
    headersSent: false,
    destroyed: socket.destroyed,
    socket,
    setHeader(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as express.Response;
  return { req, res, sent };
}

describe("API error classification", () => {
  it("keeps domain codes, maps validation and body-parser errors to their 4xx, and everything else to 500", () => {
    expect(classifyApiError(new DomainError("check_closed", 409))).toEqual({
      status: 409,
      code: "check_closed",
    });
    const zod = z.object({ name: z.string() }).safeParse({}).error;
    expect(classifyApiError(zod)).toEqual({
      status: 400,
      code: "invalid_input",
    });
    expect(
      classifyApiError(bodyParserError("entity.parse.failed", 400)),
    ).toEqual({ status: 400, code: "invalid_json" });
    expect(classifyApiError(bodyParserError("entity.too.large", 413))).toEqual({
      status: 413,
      code: "payload_too_large",
    });
    expect(classifyApiError(bodyParserError("request.aborted", 400))).toEqual({
      status: 400,
      code: "request_aborted",
    });
    for (const unexpected of [new TypeError("boom"), null, undefined, "x"])
      expect(classifyApiError(unexpected)).toEqual({
        status: 500,
        code: "internal_error",
      });
  });

  it("request.aborted is logged at info and answered 400 only while the socket is writable (never a 500 error line)", () => {
    const aborted = bodyParserError("request.aborted", 400);
    const open = fakeExchange({ destroyed: false, writable: true });
    apiErrorHandler(aborted, open.req, open.res, () => undefined);
    expect(open.sent.status).toBe(400);
    expect(open.sent.body).toMatchObject({ error: "request_aborted" });
    expect(open.sent.headers["x-request-id"]).toBe(
      (open.sent.body as { requestId: string }).requestId,
    );
    const gone = fakeExchange({ destroyed: true, writable: false });
    apiErrorHandler(aborted, gone.req, gone.res, () => undefined);
    expect(gone.sent.status).toBeUndefined();
    expect(gone.sent.body).toBeUndefined();
    expect(lines).toHaveLength(2);
    for (const line of lines)
      expect(line).toMatchObject({
        level: "info",
        message: "request_rejected",
        status: 400,
        code: "request_aborted",
      });
    // An unexpected error is still a 500 with its error line.
    const failed = fakeExchange({ destroyed: false, writable: true });
    apiErrorHandler(new TypeError("boom"), failed.req, failed.res, () => {});
    expect(failed.sent.status).toBe(500);
    expect(lines.at(-1)).toMatchObject({
      level: "error",
      message: "request_failed",
      code: "internal_error",
    });
  });
});
