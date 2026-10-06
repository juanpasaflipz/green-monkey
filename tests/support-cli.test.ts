import { describe, expect, it } from "vitest";
import {
  parseSupportArgs,
  runSupportCommand,
  supportLinkOrigin,
  validateSupportArgs,
} from "../scripts/support-commands";

const ticketed = [
  "--operator",
  "Ana Soporte",
  "--ticket",
  "T-2041",
  "--reason",
  "Restaurante sin acceso al PIN del gerente",
];
const tenant = "10000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-05T12:00:00Z");
const validate = (argv: string[]) => {
  const { command, flags } = parseSupportArgs(argv);
  return validateSupportArgs(command, flags, now);
};

describe("vendor support CLI arguments (GAP-5)", () => {
  it("parses --flag value, --flag=value and boolean flags", () => {
    expect(
      parseSupportArgs([
        "lookup",
        "--email=ANA@X.MX",
        "--yes",
        "--ticket",
        "T-1",
      ]),
    ).toEqual({
      command: "lookup",
      flags: { email: "ANA@X.MX", yes: true, ticket: "T-1" },
    });
  });

  it("mutating commands require operator, ticket and reason", () => {
    for (const argv of [
      ["unlock-employee", "--tenant", tenant, "--login", "ana"],
      [
        "unlock-employee",
        "--tenant",
        tenant,
        "--login",
        "ana",
        "--operator",
        "Ana Soporte",
        "--ticket",
        "T-1",
        "--reason",
        "corto",
      ],
      [
        "unlock-employee",
        "--tenant",
        tenant,
        "--login",
        "ana",
        "--operator",
        "Ana Soporte",
        "--reason",
        "Bloqueado tras varios intentos",
      ],
    ])
      expect(() => validate(argv)).toThrow(
        /support_(flag_required|reason_invalid|ticket_invalid)/,
      );
    const ok = validate([
      "unlock-employee",
      "--tenant",
      tenant,
      "--login",
      "ana",
      ...ticketed,
    ]);
    expect(ok.request).toEqual({
      command: "unlock-employee",
      tenant,
      login: "ana",
    });
    expect(ok.operator.ticket).toBe("T-2041");
    // Lookups are ticketed too (one support_actions row each).
    expect(() => validate(["lookup", "--email", "a@b.mx"])).toThrow();
    expect(
      validate(["lookup", "--email", "A@B.MX", ...ticketed]).request,
    ).toEqual({ command: "lookup", by: "email", value: "a@b.mx" });
    expect(() =>
      validate([
        "lookup",
        "--email",
        "a@b.mx",
        "--tenant",
        tenant,
        ...ticketed,
      ]),
    ).toThrow("support_lookup_one_key");
  });

  it("transfer-ownership rejects --yes and hold < 24h", () => {
    const base = [
      "transfer-ownership",
      "--organization",
      tenant,
      "--to-email",
      "nueva@taqueria.mx",
      ...ticketed,
    ];
    expect(() => validate([...base, "--yes"])).toThrow(
      "support_yes_not_allowed",
    );
    expect(() => validate([...base, "--hold-hours", "23"])).toThrow(
      "support_hold_too_short",
    );
    expect(validate(base).request).toMatchObject({ holdHours: 72 });
    expect(validate([...base, "--hold-hours", "24"]).request).toMatchObject({
      holdHours: 24,
    });
  });

  it("grant-entitlement rejects > 90 days", () => {
    const grant = (until: string) =>
      validate([
        "grant-entitlement",
        "--tenant",
        tenant,
        "--until",
        until,
        ...ticketed,
      ]);
    expect(grant("2027-01-02").request).toMatchObject({ until: "2027-01-02" });
    expect(() => grant("2027-01-05")).toThrow("support_grant_too_long");
    expect(() => grant("2026-10-01")).toThrow("support_grant_in_past");
    expect(() => grant("2026-13-01")).toThrow("support_argument_invalid");
  });

  it("ARCO commands: rectify needs a new name or email, anonymize never takes --yes, emails are validated and lower-cased (LEGAL-5, DATA-1)", () => {
    const account = tenant;
    expect(() =>
      validate(["rectify-account", "--account", account, ...ticketed]),
    ).toThrow("support_rectify_nothing");
    expect(
      validate([
        "rectify-account",
        "--account",
        account,
        "--email",
        "Nueva@Correo.MX",
        ...ticketed,
      ]).request,
    ).toEqual({
      command: "rectify-account",
      account,
      name: null,
      email: "nueva@correo.mx",
    });
    expect(() =>
      validate([
        "rectify-account",
        "--account",
        account,
        "--email",
        "no-es-correo",
        ...ticketed,
      ]),
    ).toThrow("support_argument_invalid");
    expect(
      validate(["block-account", "--account", account, ...ticketed]).request,
    ).toEqual({ command: "block-account", account, offboarding: false });
    expect(
      validate([
        "block-account",
        "--account",
        account,
        "--offboarding",
        ...ticketed,
      ]).request,
    ).toMatchObject({ offboarding: true });
    expect(() =>
      validate([
        "anonymize-account",
        "--account",
        account,
        "--yes",
        ...ticketed,
      ]),
    ).toThrow("support_yes_not_allowed");
    expect(
      validate(["redact-email", "--email", "MARIA@Gmail.com", ...ticketed])
        .request,
    ).toEqual({ command: "redact-email", email: "maria@gmail.com" });
  });

  it("transfer-ownership prints its one-time link only on an https origin, before touching the database (OPS-5)", async () => {
    expect(supportLinkOrigin("https://pos.desktop.kitchen/")).toBe(
      "https://pos.desktop.kitchen",
    );
    expect(supportLinkOrigin("https://127.0.0.1:3390")).toBe(
      "https://127.0.0.1:3390",
    );
    for (const bad of [
      undefined,
      "",
      "http://localhost:3001",
      "http://pos.desktop.kitchen",
      "https://localhost:3001",
      "/app",
    ])
      expect(supportLinkOrigin(bad), String(bad)).toBeNull();
    const request = validate([
      "transfer-ownership",
      "--organization",
      tenant,
      "--to-email",
      "nueva@taqueria.mx",
      ...ticketed,
    ]);
    const untouched = new Proxy(
      {},
      {
        get() {
          throw Error("database touched");
        },
      },
    );
    await expect(
      runSupportCommand(untouched as never, request, {
        print: () => {},
        confirm: async () => true,
        appUrl: "http://localhost:3001",
      }),
    ).rejects.toThrow("support_app_url_required");
  });

  it("rejects unknown commands and malformed ids", () => {
    expect(() => validate(["drop-tenant", ...ticketed])).toThrow(
      "support_command_unknown",
    );
    expect(() =>
      validate([
        "set-free-device",
        "--tenant",
        "x",
        "--device",
        tenant,
        ...ticketed,
      ]),
    ).toThrow("support_argument_invalid");
  });
});
