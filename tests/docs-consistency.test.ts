// W3-1 docs pass (polish spec item 10; LD-17, LD-16 L8, LD-43 PUB-R3-L2, wave 3 plan
// "Deferred beyond v1"): the operator documents agree with the runbook, the pilot guide and
// the app's own copy.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strings } from "../src/i18n";

const doc = (path: string) => readFileSync(path, "utf8");
/** The text of one "## " section of a markdown document. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end < 0 ? undefined : end);
}

describe("operator docs consistency (W3-1 docs pass)", () => {
  it("STAGING's credential rotation log cites RUNBOOK's staging cutover step numbers", () => {
    const cutover = section(doc("docs/RUNBOOK.md"), "Staging cutover");
    const step = (pattern: RegExp) => {
      const line = cutover
        .split("\n")
        .find((l) => /^\s*\d+\.\s/.test(l) && pattern.test(l));
      expect(line, String(pattern)).toBeTruthy();
      return Number(/^\s*(\d+)\./.exec(line!)![1]);
    };
    const app = step(/Rotate `gm_staging_app`/);
    const billing = step(/Rotate the billing login/);
    const owner = step(/Rotate the `neondb_owner` password/);
    expect([app, billing, owner]).toEqual([11, 12, 13]);
    const log = section(doc("docs/STAGING.md"), "Credential rotation log");
    const cited = (role: string) =>
      Number(
        new RegExp("`" + role + "`.*cutover step (\\d+)").exec(log)?.[1] ?? NaN,
      );
    expect([
      cited("gm_staging_app"),
      cited("gm_staging_billing"),
      cited("neondb_owner"),
    ]).toEqual([app, billing, owner]);
  });

  it("README and OPERATIONS link the pilot guide and the launch hand-off", () => {
    expect(doc("README.md")).toContain("](docs/PILOT_SOP.md)");
    expect(doc("README.md")).toContain("](docs/LAUNCH_HANDOFF.md)");
    expect(doc("docs/OPERATIONS.md")).toContain("](PILOT_SOP.md)");
    expect(doc("docs/OPERATIONS.md")).toContain("](LAUNCH_HANDOFF.md)");
  });

  it("RUNBOOK's open follow-ups list every limitation deferred beyond v1, each with its risk", () => {
    const followUps = section(doc("docs/RUNBOOK.md"), "Open follow-ups");
    const rows = followUps.split("\n").filter((l) => l.startsWith("| "));
    for (const item of [
      /keyed digests \(access A1\)/,
      /LD-16 L4/,
      /FISCAL-OFFLINE-3/,
      /PLATFORM-ROLES-2/,
      /PLATFORM-ROLES-4/,
      /PLATFORM-CI-8/,
    ]) {
      const row = rows.find((r) => item.test(r));
      expect(row, String(item)).toBeTruthy();
      expect(row, String(item)).toContain("Deferred beyond v1");
      expect(row, String(item)).toContain("Risk until then:");
    }
  });

  it("PLANS_AND_SIGNUP quotes the kill switch's copy; 'próximamente' only where B4 is reverted (PUB-R3-L2)", () => {
    const plans = doc("docs/PLANS_AND_SIGNUP.md").replace(/\s+/g, " ");
    expect(plans).toContain(`"${strings.es.accountPublicOrderingOff}"`);
    expect(plans).toContain(`"${strings.es.accountPublicOrderingSoon}"`);
    expect(plans).toMatch(
      /próximamente\." shows only on a deployment where B4/,
    );
    expect(plans).not.toMatch(/kill\s+switch, under which[^.]*próximamente/);
  });

  it("REPORTS and SERVICE describe silent printing as PILOT_SOP §1.3 does: unconfirmed, never a requirement", () => {
    for (const path of ["docs/REPORTS.md", "docs/SERVICE.md"]) {
      const text = doc(path).replace(/\s+/g, " ");
      expect(text, path).not.toMatch(
        /(needs|requires)[^.]{0,80}--kiosk-printing/,
      );
      expect(text, path).toMatch(/PILOT_SOP §1\.3\]\(PILOT_SOP\.md\)/);
    }
    expect(doc("docs/PILOT_SOP.md")).toContain(
      "**Hoy no existe una forma confirmada de imprimir sin diálogo.**",
    );
  });

  it("SERVICE's rollover paragraph says what ships: kitchen paper and Vender's notices are dated (LD-44, LD-48; POLISH-UX-1, POLISH-MONEY-1)", () => {
    const text = doc("docs/SERVICE.md").replace(/\s+/g, " ");
    expect(text).not.toContain("Printed documents keep");
    expect(text).not.toMatch(/keep the plain number/);
    expect(text).toContain(
      'every comanda and cancellation chit for an order from another business day prints "#10 · 5 oct"',
    );
    expect(text).toContain(
      '"La orden #10 · 5 oct llegó a cocina mientras cambiabas de cuenta"',
    );
    expect(text).toMatch(/keeps the plain number is the KDS \*\*Recientes\*\*/);
    // The code the paragraph describes: kitchen paper is labelled with the dated helper,
    // and the Recientes feed has no business date to show.
    for (const path of [
      "src/features/KitchenTicket.tsx",
      "src/features/printing/cancellations.ts",
    ])
      expect(doc(path), path).toMatch(/label: orderNumberLabel\(/);
    const recent = doc("shared/service.ts").match(
      /export type KitchenRecent = \{[^}]*\}/,
    )?.[0];
    expect(recent).toBeDefined();
    expect(recent).not.toContain("businessDate");
  });

  it("PILOT_SOP tells the cashier to read out the support reference and shows the dated order number; RUNBOOK does not claim the reference ends the notice (LD-48, POLISH-UX-3)", () => {
    const sop = doc("docs/PILOT_SOP.md");
    const call = section(sop, "7. A quién llamar").replace(/\s+/g, " ");
    const shown = strings.es.opsSupportReference.replace("{ref}", "3F2A9C1B");
    expect(call).toContain(`Si el mensaje rojo dice «${shown}»`);
    expect(call).toMatch(
      /díctala letra por letra: es lo primero que soporte busca/,
    );
    expect(call).toContain("«Sincronización»");
    const close = sop
      .slice(sop.indexOf("\n### 4.3 Cerrar turno\n"), sop.indexOf("\n## 5."))
      .replace(/\s+/g, " ");
    expect(close).toContain(`«${strings.es.businessCutoff}»`);
    expect(close).toContain("«#10 · 5 oct»");
    const signals = section(doc("docs/RUNBOOK.md"), "Signals").replace(
      /\s+/g,
      " ",
    );
    expect(signals).not.toMatch(/ends with "Referencia de soporte/);
    expect(signals).toContain(`includes "${shown}"`);
  });

  it("the DocRow decision for the receipt documents is recorded (LD-16 L8)", () => {
    const status = doc("docs/DELIVERY_STATUS.md");
    expect(status).toMatch(
      /`DocRow` is not adopted in the receipt, the fiscal ticket or the refund slip in v1 \(LD-16 L8\)/,
    );
    expect(doc("docs/REPORTS.md")).not.toContain(
      "deferred to Wave 3, LD-16 L8",
    );
  });
});
