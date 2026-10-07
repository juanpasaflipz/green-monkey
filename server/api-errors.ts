import type express from "express";
import { ZodError } from "zod";
import { DomainError } from "../shared/domain.js";
import { logRequestError, requestIdOf } from "./logging.js";

/**
 * body-parser's client errors by `type`, with the status body-parser itself gives them
 * (expressjs/body-parser README "Errors", checked against the installed body-parser 2.3.0
 * and raw-body 3.0.2): each is the client's request, never a server failure, so it is
 * answered with its 4xx and logged at info (BODY_REJECTIONS in logging.ts, POL-R3-3).
 * `stream.encoding.set` and `stream.not.readable` (500) mean this server's own middleware
 * consumed or decoded the request stream first: a server bug, so they stay 500
 * internal_error with their error line.
 */
export const BODY_PARSER_ERRORS: Readonly<
  Record<string, { status: number; code: string }>
> = {
  // The body is not valid JSON.
  "entity.parse.failed": { status: 400, code: "invalid_json" },
  // Larger than express.json's limit (256 kB).
  "entity.too.large": { status: 413, code: "payload_too_large" },
  // The client disconnected before sending the whole body.
  "request.aborted": { status: 400, code: "request_aborted" },
  // The body received does not match its Content-Length.
  "request.size.invalid": { status: 400, code: "request_size_invalid" },
  // A Content-Encoding the parser cannot inflate.
  "encoding.unsupported": { status: 415, code: "unsupported_encoding" },
  // A Content-Type charset the parser does not read (JSON: utf-*).
  "charset.unsupported": { status: 415, code: "unsupported_charset" },
  // More fields than a urlencoded parser's parameterLimit.
  "parameters.too.many": { status: 413, code: "too_many_parameters" },
};

/**
 * How the API answers an error that reached the final handler: a DomainError keeps its
 * status and code, a ZodError is invalid_input, and body-parser's client errors map to
 * their 4xx (BODY_PARSER_ERRORS: a malformed body is invalid_json, an oversized one
 * payload_too_large, a client that disconnected mid-body request_aborted, and so on).
 * Anything else is a 500 internal_error.
 */
export function classifyApiError(error: unknown): {
  status: number;
  code: string;
} {
  if (error instanceof DomainError)
    return { status: error.status, code: error.code };
  if (error instanceof ZodError) return { status: 400, code: "invalid_input" };
  const type = (error as { type?: unknown } | null | undefined)?.type;
  if (typeof type === "string" && Object.hasOwn(BODY_PARSER_ERRORS, type))
    return { ...BODY_PARSER_ERRORS[type] };
  return { status: 500, code: "internal_error" };
}

/** True while the client can still receive an answer on this response's socket. */
function answerable(res: express.Response) {
  const socket = res.socket;
  return (
    !res.headersSent &&
    !res.destroyed &&
    !!socket &&
    !socket.destroyed &&
    socket.writable
  );
}

/**
 * The API's final error handler. Every answer carries the request id (the X-Request-Id
 * header and `requestId` in the body) that the request log uses, so the client's support
 * reference matches the log line (RUNBOOK "Signals"). An aborted body is logged at info and
 * answered only if the socket is still writable: the client is usually gone, and nothing
 * failed on the server (SEC-8 logging rules in logRequestError).
 */
export function apiErrorHandler(
  error: unknown,
  req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) {
  // The id from the request log (X-Railway-Request-Id when present), so the
  // client's support reference matches the log line.
  const requestId = requestIdOf(req);
  const { status, code } = classifyApiError(error);
  // Logged with name, message, stack, route template and SQLSTATE for a 500;
  // never request bodies, cookies or the raw path (SEC-8).
  logRequestError(error, req, { status, code });
  if (code === "request_aborted" && !answerable(res)) return;
  if (!res.headersSent) res.setHeader("X-Request-Id", requestId);
  res.status(status).json({ error: code, requestId });
}
