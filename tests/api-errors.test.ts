import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type express from "express";
import { z } from "zod";
import {
  apiErrorHandler,
  BODY_PARSER_ERRORS,
  classifyApiError,
} from "../server/api-errors.js";
import { BODY_REJECTIONS, setLogSink } from "../server/logging.js";
import { errorText, supportReferenceOf } from "../src/i18n";
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

  it("body-parser's other client errors answer their 4xx and log at info; a stream the server itself consumed stays a 500 error line (POL-R3-3)", () => {
    // Types and statuses as body-parser documents and raises them
    // (expressjs/body-parser README "Errors"; body-parser 2.3.0, raw-body 3.0.2).
    const expected: [string, number, string][] = [
      ["request.size.invalid", 400, "request_size_invalid"],
      ["encoding.unsupported", 415, "unsupported_encoding"],
      ["charset.unsupported", 415, "unsupported_charset"],
      ["parameters.too.many", 413, "too_many_parameters"],
    ];
    for (const [type, status, code] of expected) {
      expect(classifyApiError(bodyParserError(type, status)), type).toEqual({
        status,
        code,
      });
      lines.length = 0;
      const open = fakeExchange({ destroyed: false, writable: true });
      apiErrorHandler(
        bodyParserError(type, status),
        open.req,
        open.res,
        () => {},
      );
      expect(open.sent.status, type).toBe(status);
      expect(open.sent.body, type).toMatchObject({ error: code });
      expect(lines, type).toEqual([
        expect.objectContaining({
          level: "info",
          message: "request_rejected",
          status,
          code,
        }),
      ]);
      // The client shows the translated text with its support reference.
      expect(errorText[code]?.[0], code).toBeTruthy();
      expect(errorText[code]?.[1], code).toBeTruthy();
      expect(
        supportReferenceOf(
          Object.assign(new Error(code), {
            status,
            requestId: "3f2a9c1b-7d4e-4c2a-9b1e-0123456789ab",
          }),
        ),
        code,
      ).toBe("3F2A9C1B");
    }
    // Every body-parser answer is logged at info (one list for both files).
    for (const { code } of Object.values(BODY_PARSER_ERRORS))
      expect(BODY_REJECTIONS.has(code), code).toBe(true);
    // stream.encoding.set (500): this server's own middleware decoded the
    // request stream before the parser, a server bug, not the client's.
    lines.length = 0;
    const bug = fakeExchange({ destroyed: false, writable: true });
    apiErrorHandler(
      bodyParserError("stream.encoding.set", 500),
      bug.req,
      bug.res,
      () => {},
    );
    expect(bug.sent.status).toBe(500);
    expect(bug.sent.body).toMatchObject({ error: "internal_error" });
    expect(lines.at(-1)).toMatchObject({
      level: "error",
      message: "request_failed",
      code: "internal_error",
    });
  });
});
