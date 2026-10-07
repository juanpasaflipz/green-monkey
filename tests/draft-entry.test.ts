// LD-48 (POLISH-UX-5, POLISH-UX-6): a Borradores entry whose order is gone names its order
// and tells a screen reader why it can only be discarded.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Order } from "../shared/domain";

vi.mock("../src/offline", async () => ({
  db: (await import("./offline-fake-db")).fakeDb,
}));

import {
  DraftGoneEntry,
  draftEntryText,
  draftItemsText,
} from "../src/features/DraftEntry";
import { parkedOrderLabel } from "../src/features/offline/format";
import {
  parkedOrderRef,
  parkedOrderValue,
  type LocalOrderView,
} from "../src/offline-records";

const today = "2026-10-06";

describe("Borradores entries (LD-48)", () => {
  it("a round parked for a local order keeps its provisional number, so the entry still names the order once it is gone (POLISH-UX-6)", () => {
    const local = {
      id: "00000000-0000-4000-8000-000000000077",
      number: 0,
      businessDate: today,
      offline: {
        provisionalNumber: "B-07",
        soldAt: "2026-10-06T18:00:00.000Z",
        localOperationId: "00000000-0000-4000-8000-000000000077",
        cachedAt: null,
        serverOrderId: null,
      },
    } as unknown as LocalOrderView;
    // As Selling stores it, and as Borradores reads it back.
    const stored = parkedOrderRef(
      JSON.parse(JSON.stringify(parkedOrderValue(local))),
    );
    expect(stored).toEqual({
      id: local.id,
      number: 0,
      businessDate: today,
      provisionalNumber: "B-07",
    });
    // The local order's record was archived: the order is gone everywhere.
    const label = parkedOrderLabel({ kind: "gone" }, stored, today, "es");
    expect(label).toBe("B-07");
    expect(draftEntryText({ label, name: "Mesa 4", lines: 2 }, "es")).toBe(
      "B-07 · ronda sin enviar · Mesa 4 · 2 productos",
    );
    // From another business day it is dated, like the projection was.
    expect(
      parkedOrderLabel(
        { kind: "gone" },
        { ...stored!, businessDate: "2026-10-05" },
        today,
        "es",
      ),
    ).toBe("B-07 · 5 oct");
    // A server order stores no provisional number.
    expect(
      parkedOrderValue({
        id: "o",
        number: 12,
        businessDate: today,
      } as Order),
    ).toEqual({ id: "o", number: 12, businessDate: today });
  });

  it("the entry counts its products in the singular and the plural (POLISH-UX-6)", () => {
    expect(draftItemsText(1, "es")).toBe("1 producto");
    expect(draftItemsText(3, "es")).toBe("3 productos");
    expect(draftItemsText(1, "en")).toBe("1 item");
    expect(draftItemsText(3, "en")).toBe("3 items");
    expect(draftEntryText({ label: null, name: "", lines: 1 }, "es")).toBe(
      "Orden · 1 producto",
    );
    expect(draftEntryText({ label: "#12", name: "Ana", lines: 1 }, "en")).toBe(
      "#12 · unsent round · Ana · 1 item",
    );
  });

  it("the gone entry's discard button names its draft and is described by why it is gone (POLISH-UX-5)", () => {
    const html = renderToStaticMarkup(
      createElement(DraftGoneEntry, {
        draftId: "d1",
        text: "B-07 · ronda sin enviar · Mesa 4 · 1 producto",
        locale: "es",
        autoFocus: false,
        onDiscard: () => {},
      }),
    );
    const reason =
      /<p class="warning-panel" role="status" id="([^"]+)">La orden de este borrador ya no existe en este dispositivo ni en el servidor\.<\/p>/.exec(
        html,
      );
    expect(reason).not.toBeNull();
    const button = /<button[^>]*>/.exec(html)![0];
    expect(button).toContain(`aria-describedby="${reason![1]}"`);
    expect(button).toContain(
      'aria-label="Descartar borrador: B-07 · ronda sin enviar · Mesa 4 · 1 producto"',
    );
    // Selling finds the entry after a discard to move the focus.
    expect(html).toMatch(/^<div class="draft-gone" data-draft-entry="d1">/);
  });
});
