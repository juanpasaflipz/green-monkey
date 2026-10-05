import { afterEach, describe, expect, it } from "vitest";
import {
  errorAttrs,
  log,
  redact,
  reportError,
  requestContext,
  setErrorReporter,
  setLogSink,
} from "../server/log.js";

function capture() {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return lines;
}

afterEach(() => {
  setLogSink(null);
  setErrorReporter(null);
  delete process.env.LOG_LEVEL;
});

describe("structured logger", () => {
  it("redacts secret-looking keys, postgres URLs and Stripe tokens", () => {
    const out = redact({
      password: "hunter2",
      sessionToken: "abc",
      cookie: "gm_session=x",
      Authorization: "Bearer x",
      csrf: "y",
      pin: "1234",
      sentryDsn: "https://k@o.ingest.sentry.io/1",
      apiKey: "k",
      nested: {
        url: "postgresql://gm_app:s3cret@db.example.neon.tech/green_monkey",
        text: "key sk_live_abcDEF123 and whsec_abc and rk_test_xyz here",
        safe: "tenant 10000000-0000-4000-8000-000000000001",
      },
    }) as Record<string, any>;
    for (const key of [
      "password",
      "sessionToken",
      "cookie",
      "Authorization",
      "csrf",
      "pin",
      "sentryDsn",
      "apiKey",
    ])
      expect(out[key], key).toBe("[redacted]");
    expect(out.nested.url).toBe(
      "postgresql://[redacted]@db.example.neon.tech/green_monkey",
    );
    expect(out.nested.text).toBe("key [redacted] and [redacted] and [redacted] here");
    expect(out.nested.safe).toContain("10000000-0000-4000-8000-000000000001");
  });

  it("truncates long strings and deep nesting", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 10; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(JSON.stringify(redact(deep))).toContain("[truncated]");
    expect((redact("x".repeat(5000)) as string).length).toBeLessThan(2100);
  });

  it("emits single-line JSON with level and message", () => {
    const lines = capture();
    log.info("hello_world", { count: 2, token: "nope" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      level: "info",
      message: "hello_world",
      count: 2,
      token: "[redacted]",
      service: "web",
    });
    expect(typeof record.time).toBe("string");
  });

  it("honours LOG_LEVEL", () => {
    const lines = capture();
    process.env.LOG_LEVEL = "warn";
    log.info("skipped");
    log.debug("skipped");
    log.warn("kept");
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(["kept"]);
  });

  it("includes requestId from the async context", async () => {
    const lines = capture();
    await requestContext.run(
      { requestId: "req-12345678", tenantId: "t-1" },
      async () => {
        await Promise.resolve();
        log.warn("inside");
      },
    );
    log.warn("outside");
    const [inside, outside] = lines.map((l) => JSON.parse(l));
    expect(inside).toMatchObject({ requestId: "req-12345678", tenantId: "t-1" });
    expect(outside.requestId).toBeUndefined();
  });

  it("describes errors with name, message, stack and SQLSTATE without secrets", () => {
    const error = Object.assign(
      new Error("connect to postgres://u:pw@host/db failed"),
      { code: "57P03" },
    );
    const attrs = errorAttrs(error);
    expect(attrs).toMatchObject({ errorName: "Error", pgCode: "57P03" });
    expect(String(attrs.errorMessage)).not.toContain("pw");
    expect(String(attrs.stack)).not.toContain("u:pw");
    expect(errorAttrs({ code: "ECONNREFUSED" })).toMatchObject({
      errorCode: "ECONNREFUSED",
    });
  });

  it("reportError logs and forwards to the tracker when installed", () => {
    const lines = capture();
    const seen: unknown[] = [];
    setErrorReporter((error, attrs) => seen.push([error, attrs]));
    const failure = new TypeError("boom");
    reportError(failure, { route: "/api/orders/:id", secret: "x" });
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "error",
      message: "unhandled_error",
      route: "/api/orders/:id",
      errorName: "TypeError",
      errorMessage: "boom",
      secret: "[redacted]",
    });
    expect(seen).toHaveLength(1);
    expect((seen[0] as any[])[1]).toMatchObject({ secret: "[redacted]" });
  });
});
