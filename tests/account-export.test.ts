import { describe, expect, it } from "vitest";
import {
  CSV_BOM,
  EXPORT_COLUMN_DENY,
  EXPORT_TABLE_DENYLIST,
  csvCell,
  csvRow,
  exportFilename,
} from "../shared/account-export";

describe("owner data export encoding (GAP-5)", () => {
  it("csvCell quotes commas, quotes and newlines", () => {
    expect(csvCell("Tacos, salsa")).toBe('"Tacos, salsa"');
    expect(csvCell('Dijo "hola"')).toBe('"Dijo ""hola"""');
    expect(csvCell("línea\nnueva")).toBe('"línea\nnueva"');
    expect(csvRow(["a", 1, null])).toBe("a,1,\r\n");
  });

  it("neutralizes = + - @ tab CR prefixes", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("+52 55")).toBe(`"'+52 55"`);
    expect(csvCell("-sum")).toBe(`"'-sum"`);
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    expect(csvCell("\tx")).toBe(`"'\tx"`);
    expect(csvCell("\rx")).toBe(`"'\rx"`);
    // Numbers stay numbers, negative ones included (PostgreSQL numeric is text).
    expect(csvCell("-12.500000")).toBe("-12.500000");
    expect(csvCell(-1250)).toBe("-1250");
  });

  it("null → empty, Date → ISO, objects → JSON", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(new Date("2026-10-05T12:00:00Z"))).toBe(
      "2026-10-05T12:00:00.000Z",
    );
    expect(csvCell({ es: "Tacos", n: 2 })).toBe('"{""es"":""Tacos"",""n"":2}"');
    expect(csvCell([1, 2])).toBe('"[1,2]"');
    expect(csvCell(true)).toBe("true");
  });

  it("CSV starts with BOM", () => {
    expect(CSV_BOM).toBe("﻿");
  });

  it("column deny regex excludes secret_hash, token_hash, csrf", () => {
    for (const column of [
      "secret_hash",
      "token_hash",
      "csrf",
      "code_hash",
      "evidence_hash",
      "browser_token_hash",
      "client_secret",
    ])
      expect(EXPORT_COLUMN_DENY.test(column), column).toBe(true);
    for (const column of ["hashtag", "tenant_id", "total", "token_expires_at"])
      expect(EXPORT_COLUMN_DENY.test(column), column).toBe(
        column === "token_expires_at",
      );
  });

  it("filename slug and date", () => {
    expect(exportFilename("Taquería El Güero", "2026-10-05")).toBe(
      "green-monkey-taqueria-el-guero-20261005.json",
    );
    expect(exportFilename("Taquería El Güero", "2026-10-05", "orders")).toBe(
      "green-monkey-taqueria-el-guero-orders-20261005.csv",
    );
    expect(exportFilename("¡¡!!", "2026-01-31")).toBe(
      "green-monkey-restaurante-20260131.json",
    );
  });

  it("denylist contains cfdi_secrets and cfdi_files", () => {
    expect(EXPORT_TABLE_DENYLIST.has("cfdi_secrets")).toBe(true);
    expect(EXPORT_TABLE_DENYLIST.has("cfdi_files")).toBe(true);
    for (const table of [
      "sessions",
      "operations",
      "owner_location_commands",
      "restaurant_invitations",
      "support_actions",
    ])
      expect(EXPORT_TABLE_DENYLIST.has(table), table).toBe(true);
    for (const table of [
      "pin_throttles",
      "device_pairing_codes",
      "offline_lease_renewals",
    ])
      expect(EXPORT_TABLE_DENYLIST.has(table), table).toBe(false);
  });
});
