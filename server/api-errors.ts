import type express from "express";
import { ZodError } from "zod";
import { DomainError } from "../shared/domain.js";
import { logRequestError, requestIdOf } from "./logging.js";

/**
 * How the API answers an error that reached the final handler: a DomainError keeps its
 * status and code, a ZodError is invalid_input, and body-parser's typed errors
 * (expressjs/body-parser "Errors") map to their 4xx: a malformed body is invalid_json, an
 * oversized one payload_too_large, and a client that disconnected before sending the whole
 * body (`request.aborted`, 400) is request_aborted. Anything else is a 500 internal_error.
 */
export function classifyApiError(error: unknown): {
  status: number;
  code: string;
} {
  if (error instanceof DomainError)
    return { status: error.status, code: error.code };
  if (error instanceof ZodError) return { status: 400, code: "invalid_input" };
  const type = (error as { type?: unknown } | null | undefined)?.type;
  if (type === "entity.parse.failed")
    return { status: 400, code: "invalid_json" };
  if (type === "entity.too.large")
    return { status: 413, code: "payload_too_large" };
  if (type === "request.aborted")
    return { status: 400, code: "request_aborted" };
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
