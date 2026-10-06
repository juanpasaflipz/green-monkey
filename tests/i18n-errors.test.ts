import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { areas, errorText, strings } from "../src/i18n";
import { labelledOperations, operationLabel } from "../src/labels";

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? files(path, pattern)
      : pattern.test(name)
        ? [path]
        : [];
  });
}
const source = (dirs: string[], pattern: RegExp) =>
  dirs
    .flatMap((d) => files(d, pattern))
    .map((f) => [f, readFileSync(f, "utf8")] as const);
const serverSources = source(["server", "shared"], /\.ts$/);

/**
 * Codes produced by the browser itself rather than by a server response, known
 * when service merges. Offline appends its transport codes at its merge.
 */
const clientCodes = [
  "offline_conflict",
  "payment_review_required",
  "switch_requires_connection",
  "pending_before_switch",
  "drawer_required",
  // offline (026): raised on the device through fail() and the charge guard,
  // which the Error("…") scan below does not see.
  "offline_amount_exceeds_due",
  "offline_amount_invalid",
  "offline_cart_blocked",
  "offline_check_paid",
  "offline_order_not_cached",
  "offline_order_outdated",
  "offline_payment_pending_for_order",
  "offline_record_invalid",
  "offline_round_other_employee_for_order",
  "offline_round_pending_for_order",
  "offline_round_review_for_order",
  "offline_split_unavailable",
  "offline_storage_full",
  "offline_table_service_off",
];
/** Machine-facing responses that no operator screen ever renders. */
const machineOnly = new Set(["stripe_webhook_invalid"]);
/**
 * Codes another area translates in its own module (wave contracts 3.12).
 * Until that area merges they are skipped here; once its module declares
 * them they are checked like every other code. `rate_limited` (ops's public
 * /api/ops/* limiter) is offline's; the two fiscal codes come from the pure
 * fiscal core (shared/fiscal.ts), which no route calls until fiscal 027.
 */
const ownedElsewhere: Record<string, keyof typeof areas> = {
  unauthorized: "access",
  session_changed: "access",
  missing_tenant: "access",
  self_disable: "access",
  invalid_modifier: "menu",
  invalid_quantity: "menu",
  invalid_recipe: "menu",
  invalid_unit: "menu",
  unavailable: "menu",
  rate_limited: "offline",
  fiscal_total_mismatch: "fiscal",
  fiscal_refund_exceeds: "fiscal",
  // Reports core (pure module); the full track owns the wording.
  reports_corte_hidden: "reports",
  reports_range_invalid: "reports",
};
const pendingElsewhere = (code: string) => {
  const owner = ownedElsewhere[code];
  return !!owner && !(code in areas[owner].errors);
};

describe("error translations", () => {
  it("every server DomainError code has Spanish and English text", () => {
    const codes = new Set(clientCodes);
    for (const [, text] of serverSources) {
      for (const m of text.matchAll(/DomainError\(\s*"([a-z_]+)"/g))
        codes.add(m[1]);
      for (const m of text.matchAll(/error:\s*"([a-z_]+)"/g)) codes.add(m[1]);
    }
    for (const [, text] of source(["src"], /\.tsx?$/))
      for (const m of text.matchAll(
        /(?:Api)?Error\(\s*"([a-z]+(?:_[a-z]+)+)"/g,
      ))
        codes.add(m[1]);
    const missing = [...codes]
      .filter((code) => !machineOnly.has(code) && !pendingElsewhere(code))
      .filter((code) => {
        const text = errorText[code];
        return !text || !text[0]?.trim() || !text[1]?.trim();
      })
      .sort();
    expect(missing).toEqual([]);
    expect(codes.size).toBeGreaterThan(40);
  });

  it("service strings are prefixed, unique and present in both locales", () => {
    const service = areas.service;
    expect(Object.keys(service.en).sort()).toEqual(
      Object.keys(service.es).sort(),
    );
    for (const locale of ["es", "en"] as const)
      for (const [key, text] of Object.entries(service[locale])) {
        expect(key.startsWith("service"), key).toBe(true);
        expect((text as string).trim(), `${locale}.${key}`).not.toBe("");
        expect(strings[locale][key as keyof typeof strings.es]).toBe(text);
      }
  });

  it("labels map every audit operation written by the server", () => {
    const operations = new Set<string>();
    for (const [, text] of serverSources) {
      for (const m of text.matchAll(
        /audit\(\s*tx,\s*\w+,\s*"([a-z_]+(?:\.[a-z_]+)*)"\s*,/g,
      ))
        operations.add(m[1]);
      for (const m of text.matchAll(
        /insert into audit\([^)]*\)\s*values\([^']*'([a-z_]+(?:\.[a-z_]+)+)'/gi,
      ))
        operations.add(m[1]);
    }
    // Dynamic operations are composed from a known prefix and value set.
    for (const kind of ["receipt", "waste", "count_adjust"])
      operations.add(`stock.${kind}`);
    for (const state of ["seen", "ready", "completed"])
      operations.add(`kitchen.${state}`);
    for (const action of ["start", "end"]) operations.add(`shift.${action}`);
    for (const task of ["kitchen", "stock"])
      operations.add(`offline.${task}_reviewed`);
    const fallback = operationLabel("not.an.operation", "es");
    const unlabelled = [...operations]
      .filter((op) => !labelledOperations.includes(op))
      .filter((op) => operationLabel(op, "es") === fallback);
    expect(unlabelled.sort()).toEqual([]);
    expect(operations.has("check.closed")).toBe(true);
    expect(operations.has("order.created")).toBe(true);
  });
});
