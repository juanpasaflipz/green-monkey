// LD-48 (POLISH-UX-9): the KDS "Impresión" dialog's silent-print hint is the auto-print
// checkbox's accessible description, so a screen reader reads it when the option is
// toggled, not only a sighted cook who reads the muted line below it.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Modal renders through a portal into a <dialog> (client only); here it is a plain wrapper.
vi.mock("../src/components/ui", () => ({
  Modal: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { "aria-label": title }, children),
  Button: ({ children }: { children: ReactNode }) =>
    createElement("button", { type: "button" }, children),
}));

import { PrintSettingsDialog } from "../src/print";
import { strings } from "../src/i18n";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(scope: "selling" | "kitchen", locale: "es" | "en") {
  return renderToStaticMarkup(
    createElement(PrintSettingsDialog, { locale, scope, close: () => {} }),
  );
}

describe("print settings dialog (POLISH-UX-9)", () => {
  for (const locale of ["es", "en"] as const)
    it(`the KDS auto-print checkbox is described by the silent-print hint (${locale})`, () => {
      const html = render("kitchen", locale);
      const checkbox = /<input type="checkbox"[^>]*>/.exec(html)?.[0];
      expect(checkbox).toBeDefined();
      const describedBy = /aria-describedby="([^"]+)"/.exec(checkbox!)?.[1];
      expect(describedBy, checkbox).toBeTruthy();
      // The element it points to is the hint, and holds exactly the hint's text.
      const target = new RegExp(
        `<p[^>]*id="${describedBy!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)</p>`,
      ).exec(html);
      expect(target?.[1]).toBe(
        escapeHtml(strings[locale].servicePrintSilentHint),
      );
      // Within the auto-print option's own label.
      expect(html).toContain(escapeHtml(strings[locale].servicePrintKdsAuto));
    });

  it("Vender's print settings have no silent-print hint and no dangling description", () => {
    const html = render("selling", "es");
    expect(html).not.toContain(escapeHtml(strings.es.servicePrintSilentHint));
    expect(html).not.toContain("aria-describedby");
  });
});
