// cfdi merge gate (review CFDI-R5). Until fiscal 027 is in this tree, cfdi's stamping, egresos,
// portal self-invoice, cancellation and printed block run on compat shims and a test-only 027
// stand-in, and three browser stamping tests skip. This test makes that state explicit and
// self-ending: the moment server/fiscal-read.ts lands (the rebase onto fiscal and discounts,
// docs/CFDI.md "Rebase onto fiscal and discounts"), it FAILS until every shim, the stand-in and
// the skip are gone, fiscal's recordRefundTax calls enqueueCfdiRefund, and the status lines no
// longer say the flows wait for the rebase. Pure: reads files only.
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

const FISCAL_MERGED = existsSync("server/fiscal-read.ts");
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
const PENDING = /pending the fiscal(?: 027)?(?:\/| and )discounts(?: 028)? rebase/i;
const cfdiLine = (doc: string) =>
  read(doc)
    .split("\n")
    .find((l) => l.startsWith("| CFDI invoice")) ?? "";

describe("cfdi merge gate (CFDI-R5)", () => {
  if (!FISCAL_MERGED) {
    it("before fiscal 027: the shims are the only bridge and every CFDI status line says the flows wait for the fiscal/discounts rebase", () => {
      for (const shim of SHIMS) expect(existsSync(shim), shim).toBe(true);
      for (const doc of STATUS_DOCS)
        expect(cfdiLine(doc), doc).toMatch(PENDING);
      // The browser stamping tests may only skip because fiscal is absent.
      expect(read("tests/browser/cfdi.spec.ts")).toMatch(
        /existsSync\(join\(process\.cwd\(\), "server\/fiscal-read\.ts"\)\)/,
      );
    });
    return;
  }

  it("after fiscal 027: no cfdi compat shim, stand-in or shim import remains", () => {
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

  it("after fiscal 027: recordRefundTax enqueues the credit-note decision (enqueueCfdiRefund) and the worker reads 028's refunds.method", () => {
    expect(read("server/fiscal.ts")).toMatch(/enqueueCfdiRefund\(tx, /);
    expect(read("server/cfdi/worker/freeze.ts")).toMatch(
      /select method from refunds where id =/,
    );
  });

  it("after fiscal 027: the stamping browser tests no longer skip for a missing fiscal, and the status lines were re-verified", () => {
    expect(read("tests/browser/cfdi.spec.ts")).not.toMatch(
      /needs fiscal 027/,
    );
    for (const doc of STATUS_DOCS)
      expect(cfdiLine(doc), doc).not.toMatch(PENDING);
  });
});
