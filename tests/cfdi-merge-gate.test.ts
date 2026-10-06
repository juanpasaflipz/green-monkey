// cfdi merge gate (review CFDI-R5), kept as a regression guard after the fiscal/discounts merge:
// no compat shim, 027 stand-in or shim import may come back, fiscal's recordRefundTax calls
// enqueueCfdiRefund, the worker reads 028's refunds.method, the stamping browser tests skip only
// for a missing local worker, and the status lines no longer say the flows wait for a rebase.
// Pure: reads files only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? name === "node_modules"
        ? []
        : files(path)
      : /\.(ts|tsx)$/.test(name)
        ? [path]
        : [];
  });

const SHIMS = [
  "server/compat/cfdi-fiscal.ts",
  "src/compat/cfdi-fiscal.ts",
  "tests/fixtures/cfdi/fiscal-027-standin.sql",
];
/** The status lines that describe CFDI's delivery state. */
const STATUS_DOCS = [
  "docs/DELIVERY_STATUS.md",
  "docs/FEATURE_MATRIX.md",
  "docs/COMPLETION_LEDGER.md",
];
const PENDING =
  /pending the fiscal(?: 027)?(?:\/| and )discounts(?: 028)? rebase/i;
const cfdiLine = (doc: string) =>
  read(doc)
    .split("\n")
    .find((l) => l.startsWith("| CFDI invoice")) ?? "";

describe("cfdi merge gate (CFDI-R5)", () => {
  it("fiscal 027's leaf reader is in the tree", () => {
    expect(existsSync("server/fiscal-read.ts")).toBe(true);
  });

  it("no cfdi compat shim, stand-in or shim import remains", () => {
    for (const shim of SHIMS) expect(existsSync(shim), shim).toBe(false);
    const importers = [...files("server"), ...files("src"), ...files("tests")]
      .filter((f) => f !== join("tests", "cfdi-merge-gate.test.ts"))
      .filter((f) =>
        /compat\/cfdi-fiscal|fiscal-027-standin|fiscalTablesPresent/.test(
          read(f),
        ),
      );
    expect(importers).toEqual([]);
  });

  it("recordRefundTax enqueues the credit-note decision (enqueueCfdiRefund) and the worker reads 028's refunds.method", () => {
    expect(read("server/fiscal.ts")).toMatch(/enqueueCfdiRefund\(tx, /);
    expect(read("server/cfdi/worker/freeze.ts")).toMatch(
      /select method from refunds where id =/,
    );
  });

  it("the stamping browser tests no longer skip for a missing fiscal, and the status lines were re-verified", () => {
    expect(read("tests/browser/cfdi.spec.ts")).not.toMatch(/needs fiscal 027/);
    for (const doc of STATUS_DOCS)
      expect(cfdiLine(doc), doc).not.toMatch(PENDING);
  });
});
