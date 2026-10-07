/**
 * cfdi client (spec §7.1 items 23, 28, 29 and the receipt slot): ReceptorFields and the printed
 * block in Spanish and English, the Today alert mapping and text, the ticket-status hook and its
 * coverage helper, the order actions, the footer slot returning null, and the pure helpers of
 * the register, the settings panel and the portal. React renders through renderToStaticMarkup.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, Session } from "../shared/domain";
import type {
  CfdiAlertsView,
  CfdiDocumentSummary,
  CfdiDocumentView,
  CfdiSettingsView,
  CfdiStatusView,
  CfdiTicketView,
  Receptor,
} from "../shared/cfdi";
import type { FiscalTicketView } from "../shared/fiscal";

vi.mock("../src/offline", async () => ({
  db: (await import("./offline-fake-db")).fakeDb,
  scope: (s: { tenantId: string }) => s.tenantId,
}));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  api: vi.fn(),
}));
// useSyncExternalStore without a server snapshot cannot render on the server.
vi.mock("../src/connectivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connectivity")>()),
  useConnectivity: () => ({ canUseServer: true }),
}));

import { api } from "../src/api";
import { strings, translateError } from "../src/i18n";
import { cfdiReportAlerts } from "../server/cfdi/hooks";
import {
  cfdiReportAlertText,
  eventLabel,
  issueOfError,
  periodKeyLabel,
  amountDifference,
  periodLabel,
  withServerIssue,
} from "../src/features/cfdi/format";
import {
  cfdiTicketCovered,
  clearCfdiStatus,
  getCfdiStatus,
  loadCfdiTicketStatus,
  prefetchCfdiStatus,
  setCfdiStatus,
  startStatusRefresh,
  STATUS_REFRESH_MS,
  ticketStatusWanted,
  useCfdiTicketStatus,
  type StatusRefreshEnv,
} from "../src/features/cfdi/status";
import {
  emptyReceptor,
  ReceptorFields,
} from "../src/features/cfdi/ReceptorFields";
import {
  CfdiReceiptBlock,
  cfdiReceiptExtra,
} from "../src/features/cfdi/CfdiReceiptBlock";
import {
  CfdiOrderActions,
  TicketChip,
  ticketChip,
} from "../src/features/cfdi/CfdiOrderActions";
import {
  CreditNotesBlockNote,
  needsAcceptance,
  SubstitutionAlert,
  ticketsLabel,
} from "../src/features/cfdi/CfdiDocuments";
import {
  ActivationPeriodicity,
  cfdiBadge,
  OrganizationFacts,
  orgErrorText,
  PeriodicityStatus,
  SelfInvoiceBound,
  SelfInvoicePendingStatus,
  selfInvoiceShortens,
  settingsSavedNote,
  settling,
} from "../src/features/cfdi/CfdiSettings";
import { deadlineText } from "../src/features/cfdi/format";
import type { CfdiOrganizationView } from "../shared/cfdi";
import { CfdiCorteCoverage } from "../src/features/cfdi/CfdiCorteCoverage";
import { base64Of, passwordLifetimeMs } from "../src/features/cfdi/CsdUpload";
import {
  codeFromPath,
  portalFailure,
  portalMessage,
} from "../src/features/cfdi/SelfInvoicePortal";
import {
  awaitingFiles,
  inGlobalNotice,
} from "../src/features/cfdi/InvoiceDialog";
import { FiscalReceiptFooter } from "../src/features/fiscal/FiscalReceipt";
import { receptorFixable } from "../shared/cfdi";

const apiMock = vi.mocked(api);

const session = {
  id: "50000000-0000-4000-8000-000000000001",
  tenantId: "10000000-0000-4000-8000-000000000001",
  employeeId: "20000000-0000-4000-8000-000000000001",
  deviceId: "30000000-0000-4000-8000-000000000001",
  name: "Ana",
  role: "cashier",
  csrf: "csrf",
  expiresAt: "",
  offlineUntil: "",
  restaurant: {
    name: "Taquería Ficticia",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
} as Session;

const status = (over: Partial<CfdiStatusView> = {}): CfdiStatusView => ({
  available: true,
  provider: "organizations",
  enabled: true,
  mode: "live",
  ready: true,
  canInvoice: true,
  selfInvoice: { enabled: true, policy: "month", days: 30 },
  timezone: "America/Mexico_City",
  version: 3,
  ...over,
});

/** The print instant of the receipt checks: 4 Oct 2026 12:00 local, the ticket's business day. */
const PRINTED = Date.parse("2026-10-04T18:00:00Z");

const ticket = {
  id: "60000000-0000-4000-8000-000000000001",
  orderId: "70000000-0000-4000-8000-000000000001",
  folio: "A-000123",
  businessDate: "2026-10-04",
  selfInvoiceCode: "7K3M9QX2PA8D",
} as FiscalTicketView;

const order = (fiscal: unknown, over: Partial<Order> = {}): Order =>
  ({
    id: "70000000-0000-4000-8000-000000000001",
    state: "closed",
    paid: 11600,
    total: 11600,
    ...(fiscal === undefined ? {} : { fiscal }),
    ...over,
  }) as unknown as Order;

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(node);

beforeEach(() => {
  apiMock.mockReset();
  clearCfdiStatus();
});
afterEach(() => clearCfdiStatus());

describe("cfdi client: ReceptorFields (23)", () => {
  const receptor: Receptor = {
    ...emptyReceptor(),
    rfc: "EKU9003173C9",
    legalName: "ESCUELA KEMPER URGATE",
    regime: "601",
    postalCode: "42501",
  };
  it("renders the Spanish labels, the regimes for a moral RFC and the uses for the regime", () => {
    const out = html(
      createElement(ReceptorFields, {
        value: receptor,
        onChange: () => {},
        issues: [],
        locale: "es",
        requireEmail: false,
      }),
    );
    expect(out).toContain("Nombre o razón social");
    expect(out).toContain("Código postal del domicilio fiscal");
    expect(out).toContain("Correo electrónico (opcional)");
    expect(out).toContain("G03 — Gastos en general");
    expect(out).toContain('value="601"');
    // 605 (sueldos) is a persona-física regime: not offered for a 12-character RFC.
    expect(out).not.toContain('value="605"');
  });
  it("a field's issue and hint describe the control instead of naming it: the label holds only its text and control", () => {
    const out = html(
      createElement(ReceptorFields, {
        value: { ...receptor, rfc: "ABC" },
        onChange: () => {},
        issues: [{ field: "rfc", code: "cfdi_invalid_rfc" }],
        locale: "es",
        requireEmail: false,
      }),
    );
    expect(out).toMatch(
      /<label class="field"><span>RFC<\/span><input[^>]*><\/label>/,
    );
    expect(out).toMatch(/aria-describedby="[^"]*-rfc-issue"/);
    expect(out).toMatch(
      /<label class="field"><span>Nombre o razón social<\/span><input[^>]*aria-describedby="[^"]*-legalName-hint"[^>]*><\/label>/,
    );
  });
  it("CFDI-SECRETS-6: on a shared staff terminal the email and postal code keep no autofill history; the portal keeps the tokens", () => {
    const render = (shared: boolean) =>
      html(
        createElement(ReceptorFields, {
          value: receptor,
          onChange: () => {},
          issues: [],
          locale: "es",
          requireEmail: false,
          shared,
        }),
      );
    expect(render(true)).not.toMatch(/autoComplete="(email|postal-code)"/i);
    expect(render(false)).toMatch(/autoComplete="email"/i);
    expect(render(false)).toMatch(/autoComplete="postal-code"/i);
  });
  it("renders English labels, the required email and translated issues with warnings apart", () => {
    const out = html(
      createElement(ReceptorFields, {
        value: { ...receptor, legalName: "ESCUELA KEMPER URGATE SA DE CV" },
        onChange: () => {},
        issues: [
          { field: "rfc", code: "cfdi_invalid_rfc" },
          { field: "legalName", code: "cfdiLegalNameSuffix", warning: true },
        ],
        locale: "en",
        requireEmail: true,
      }),
    );
    expect(out).toContain("Name or legal name");
    expect(out).toContain("Email");
    expect(out).not.toContain("(optional)");
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('class="error" role="alert"');
    expect(out).toContain('class="cfdi-warning"');
    expect(out).toContain(strings.en.cfdiLegalNameSuffix);
    expect(out).not.toContain("Nombre o razón social");
  });
});

describe("cfdi client: printed block (23, 2.12)", () => {
  const origin = "https://pos.example.com";
  it("prints the QR, the grouped code, the URL and the deadline in Spanish", () => {
    const out = html(
      createElement(CfdiReceiptBlock, {
        ticket,
        status: status(),
        kind: "receipt",
        origin,
        now: PRINTED,
      }),
    );
    expect(out).toContain("¿Necesitas factura?");
    expect(out).toContain("Escanea o entra a pos.example.com/factura");
    expect(out).toContain("Código: 7K3M-9QX2-PA8D");
    expect(out).toContain("Disponible hasta el 31/10/2026");
    expect(out).toContain("<svg");
    expect(out).toContain("Código QR para facturar este ticket");
    expect(out).not.toContain("(modo prueba)");
  });
  it("adds (modo prueba) in test mode and stays Spanish (fiscal D10)", () => {
    const out = html(
      createElement(CfdiReceiptBlock, {
        ticket,
        status: status({ mode: "test" }),
        kind: "receipt",
        origin,
        now: PRINTED,
      }),
    );
    expect(out).toContain("(modo prueba)");
    expect(out).not.toContain("Need an invoice");
  });
  it("self-invoicing off asks at the counter; a local receipt waits for its folio", () => {
    expect(
      html(
        createElement(CfdiReceiptBlock, {
          ticket,
          status: status({
            selfInvoice: { enabled: false, policy: "month", days: 30 },
          }),
          kind: "receipt",
          origin,
          now: PRINTED,
        }),
      ),
    ).toContain("Pídela en caja con el folio A-000123.");
    // CFDI-UX-12: an organization that is not ready prints no QR either.
    const notReady = html(
      createElement(CfdiReceiptBlock, {
        ticket,
        status: status({ ready: false }),
        kind: "receipt",
        origin,
        now: PRINTED,
      }),
    );
    expect(notReady).toContain("Pídela en caja con el folio A-000123.");
    expect(notReady).not.toContain("<svg");
    expect(
      html(
        createElement(CfdiReceiptBlock, {
          ticket: null,
          status: status(),
          kind: "local",
          origin,
        }),
      ),
    ).toContain("pide tu ticket con folio cuando se sincronice");
  });
  it("the footer slot returns null (never an empty element) when CFDI is off or for a pre-bill", () => {
    const p = (kind: "receipt" | "check" | "local", o = order({ ticket })) => ({
      order: o,
      kind,
      reprint: false,
      locale: "es" as const,
    });
    expect(cfdiReceiptExtra(p("receipt"))).toBeNull();
    setCfdiStatus(status({ available: false }));
    expect(cfdiReceiptExtra(p("receipt"))).toBeNull();
    setCfdiStatus(status({ enabled: false }));
    expect(cfdiReceiptExtra(p("receipt"))).toBeNull();
    setCfdiStatus(status());
    expect(cfdiReceiptExtra(p("check"))).toBeNull();
    expect(cfdiReceiptExtra(p("receipt", order({ ticket: null })))).toBeNull();
    expect(cfdiReceiptExtra(p("receipt", order(undefined)))).toBeNull();
    expect(cfdiReceiptExtra(p("receipt"))).not.toBeNull();
    expect(cfdiReceiptExtra(p("local", order(undefined)))).not.toBeNull();
  });
  it("CFDI-UX-6: fiscal's footer prints cfdi's line on a local (offline) receipt, which has no ticket, and on no other ticketless receipt", () => {
    setCfdiStatus(status());
    const local = order(undefined, { state: "local" } as Partial<Order>);
    const footer = (kind: "local" | "receipt") =>
      html(
        createElement(FiscalReceiptFooter, {
          order: local,
          kind,
          reprint: false,
          locale: "es",
          extra: cfdiReceiptExtra({
            order: local,
            kind,
            reprint: false,
            locale: "es",
          }),
        }),
      );
    expect(footer("local")).toContain(
      "pide tu ticket con folio cuando se sincronice",
    );
    expect(footer("receipt")).not.toContain("cuando se sincronice");
  });
});

describe("cfdi client: Today alerts (28)", () => {
  const zero: CfdiAlertsView = {
    overdueGlobals: 0,
    failedDocuments: 0,
    stuckDocuments: 0,
    rejectedSubstitutions: 0,
    csdExpiresSoon: false,
    mode: "live",
  };
  it("maps the attention counts to the four codes and omits zeros", () => {
    expect(cfdiReportAlerts(zero)).toEqual([]);
    expect(
      cfdiReportAlerts({
        overdueGlobals: 2,
        failedDocuments: 1,
        stuckDocuments: 3,
        rejectedSubstitutions: 1,
        csdExpiresSoon: true,
        mode: "test",
      }),
    ).toEqual([
      { code: "cfdi_global_overdue", count: 2 },
      { code: "cfdi_documents_attention", count: 4 },
      { code: "cfdi_substitution_rejected", count: 1 },
      { code: "cfdi_csd_expiring", count: 1 },
    ]);
  });
  it("returns [] when CFDI is not enabled (mode null)", () => {
    expect(
      cfdiReportAlerts({ ...zero, overdueGlobals: 5, mode: null }),
    ).toEqual([]);
  });
  it("has Spanish and English text for each code and null for other codes", () => {
    for (const code of [
      "cfdi_global_overdue",
      "cfdi_documents_attention",
      "cfdi_substitution_rejected",
      "cfdi_csd_expiring",
    ]) {
      const es = cfdiReportAlertText({ code, count: 3 }, "es");
      const en = cfdiReportAlertText({ code, count: 3 }, "en");
      expect(es).toBeTruthy();
      expect(en).toBeTruthy();
      expect(es).not.toBe(en);
      expect(es).not.toContain("{n}");
      expect(en).not.toContain("{n}");
    }
    expect(
      cfdiReportAlertText({ code: "cfdi_global_overdue", count: 3 }, "es"),
    ).toContain("3 facturas globales");
    expect(
      cfdiReportAlertText({ code: "missing_tickets", count: 1 }, "es"),
    ).toBeNull();
  });
});

describe("cfdi client: ticket status (29)", () => {
  const view = (covering: CfdiTicketView["covering"]): CfdiTicketView =>
    ({ ticketId: ticket.id, covering }) as CfdiTicketView;
  it("asks nothing without an id or while CFDI is unavailable", () => {
    expect(ticketStatusWanted(null, status())).toBe(false);
    expect(ticketStatusWanted(ticket.id, null)).toBe(false);
    expect(ticketStatusWanted(ticket.id, status({ available: false }))).toBe(
      false,
    );
    expect(ticketStatusWanted(ticket.id, status())).toBe(true);
    function Probe({ id }: { id: string | null }) {
      return createElement("i", null, String(useCfdiTicketStatus(id)));
    }
    expect(html(createElement(Probe, { id: null }))).toBe("<i>null</i>");
    setCfdiStatus(status({ available: false }));
    expect(html(createElement(Probe, { id: ticket.id }))).toBe("<i>null</i>");
    expect(apiMock).not.toHaveBeenCalled();
  });
  it("loads one view and returns null on any error", async () => {
    const v = view(null);
    apiMock.mockResolvedValueOnce(v);
    await expect(loadCfdiTicketStatus(ticket.id)).resolves.toBe(v);
    expect(apiMock).toHaveBeenCalledWith(
      `/cfdi/tickets/${ticket.id}`,
      undefined,
      { signal: undefined },
    );
    apiMock.mockRejectedValueOnce(new Error("forbidden"));
    await expect(loadCfdiTicketStatus(ticket.id)).resolves.toBeNull();
    apiMock.mockRejectedValueOnce(new Error("network_unavailable"));
    await expect(loadCfdiTicketStatus(ticket.id)).resolves.toBeNull();
  });
  it("a valid invoice or global covers the ticket; anything else does not", () => {
    const c = (kind: "invoice" | "global", st: string) =>
      view({
        documentId: "d",
        kind,
        status: st,
        label: "F-1",
        periodKey: null,
      });
    expect(cfdiTicketCovered(c("invoice", "valid"))).toBe(true);
    expect(cfdiTicketCovered(c("global", "valid"))).toBe(true);
    expect(cfdiTicketCovered(c("invoice", "stamping"))).toBe(false);
    expect(cfdiTicketCovered(c("global", "canceling"))).toBe(false);
    expect(cfdiTicketCovered(view(null))).toBe(false);
    expect(cfdiTicketCovered(null)).toBe(false);
  });
  it("prefetch stores the status and falls back to the cached copy; kitchen never asks", async () => {
    apiMock.mockResolvedValueOnce(status({ version: 7 }));
    await prefetchCfdiStatus(session);
    expect(getCfdiStatus()?.version).toBe(7);
    clearCfdiStatus();
    apiMock.mockRejectedValueOnce(new Error("network_unavailable"));
    await prefetchCfdiStatus(session);
    expect(getCfdiStatus()?.version).toBe(7);
    clearCfdiStatus();
    await prefetchCfdiStatus(session, { cacheOnly: true });
    expect(getCfdiStatus()?.version).toBe(7);
    apiMock.mockClear();
    await expect(
      prefetchCfdiStatus({ ...session, role: "kitchen" }),
    ).resolves.toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });
  it("CFDIFIX-3: a signed-in device refreshes the status on focus, visibility, the connection's return and every 5 minutes, one request at a time, never offline, hidden or blocked, and stops once its session is gone", async () => {
    const handlers = new Map<string, () => void>();
    let interval: { ms: number; fn: () => void } | null = null;
    let online = true;
    let visible = true;
    let blocked = false;
    let signedIn = true;
    let removed = 0;
    const env: StatusRefreshEnv = {
      on(event, fn) {
        handlers.set(event, fn);
        return () => {
          handlers.delete(event);
          removed++;
        };
      },
      visible: () => visible,
      online: () => online,
      every(ms, fn) {
        interval = { ms, fn };
        return () => {
          interval = null;
          removed++;
        };
      },
    };
    let release: () => void = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const stop = startStatusRefresh({
      env,
      signedIn: async () => signedIn,
      paused: () => blocked,
      refresh,
    });
    expect(interval!.ms).toBe(STATUS_REFRESH_MS);
    expect(STATUS_REFRESH_MS).toBe(5 * 60_000);
    expect([...handlers.keys()].sort()).toEqual([
      "focus",
      "online",
      "visibilitychange",
    ]);
    handlers.get("focus")!();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    // One at a time: a trigger while a refresh is in flight is dropped.
    interval!.fn();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await settle();
    interval!.fn();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
    release();
    await settle();
    online = false;
    interval!.fn();
    visible = false;
    online = true;
    handlers.get("visibilitychange")!();
    visible = true;
    blocked = true;
    handlers.get("online")!();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
    blocked = false;
    handlers.get("visibilitychange")!();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(3);
    release();
    await settle();
    // Signed out (or another employee): it stops for good, removing every listener.
    signedIn = false;
    handlers.get("focus")!();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(handlers.size).toBe(0);
    expect(interval).toBeNull();
    expect(removed).toBe(4);
    stop();
    expect(removed).toBe(4);
  });
  it("CFDIFIX-3: a failing session check stops it too; a failed refresh keeps it running", async () => {
    const handlers = new Map<string, () => void>();
    const env: StatusRefreshEnv = {
      on(event, fn) {
        handlers.set(event, fn);
        return () => handlers.delete(event);
      },
      visible: () => true,
      online: () => true,
      every: () => () => {},
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const failing = vi.fn(async () => {
      throw new Error("network_unavailable");
    });
    startStatusRefresh({
      env,
      signedIn: async () => true,
      paused: () => false,
      refresh: failing,
    });
    handlers.get("focus")!();
    await settle();
    handlers.get("focus")!();
    await settle();
    expect(failing).toHaveBeenCalledTimes(2);
    handlers.clear();
    const refresh = vi.fn(async () => {});
    startStatusRefresh({
      env,
      signedIn: async () => {
        throw new Error("indexeddb blocked");
      },
      paused: () => false,
      refresh,
    });
    handlers.get("focus")!();
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });
});

describe("cfdi client: order actions (2.5)", () => {
  const render = (o: Order, online?: boolean) =>
    html(
      createElement(CfdiOrderActions, {
        order: o,
        session,
        locale: "es",
        variant: "detail",
        online,
      }),
    );
  it("renders nothing unless this employee can invoice and fiscal's view is present", () => {
    expect(render(order({ ticket }))).toBe("");
    setCfdiStatus(status({ canInvoice: false }));
    expect(render(order({ ticket }))).toBe("");
    setCfdiStatus(status());
    expect(render(order(undefined))).toBe("");
    expect(render(order({ ticket }, { state: "local" }))).toBe("");
  });
  it("shows Facturar, disabled with 'Requiere conexión.' offline, and the missing-ticket hint", () => {
    setCfdiStatus(status());
    expect(render(order({ ticket }))).toContain(">Facturar</button>");
    const offline = render(order({ ticket }), false);
    expect(offline).toContain("disabled");
    expect(offline).toContain("Requiere conexión.");
    expect(render(order({ ticket: null }))).toContain("Sin ticket fiscal.");
    expect(render(order({ ticket: null }, { paid: 0 }))).toBe("");
  });
  it("its variant never adds a bare class the receipt's `.receipt` hook would match", () => {
    setCfdiStatus(status());
    for (const variant of ["receipt", "detail"] as const)
      for (const o of [order({ ticket }), order({ ticket: null })]) {
        const markup = html(
          createElement(CfdiOrderActions, {
            order: o,
            session,
            locale: "es",
            variant,
          }),
        );
        const classes = /class="([^"]*cfdi-order-actions[^"]*)"/.exec(
          markup,
        )?.[1];
        expect(classes?.split(" ")).not.toContain("receipt");
        expect(classes?.split(" ")).toContain(`cfdi-order-actions-${variant}`);
      }
  });
  it("the chip's label is visually hidden text, never an aria-label on a generic span (CFDI-R2-7)", () => {
    const markup = html(
      createElement(TicketChip, {
        view: { eligibility: "available", covering: null } as CfdiTicketView,
        locale: "es",
      }),
    );
    expect(markup).toContain(
      '<span class="sr-only">Factura del ticket: </span>',
    );
    expect(markup).toContain("Sin facturar");
    expect(markup).not.toContain("aria-label");
  });
  it("chips follow the ticket view", () => {
    const v = (over: Partial<CfdiTicketView>) =>
      ({ eligibility: "available", covering: null, ...over }) as CfdiTicketView;
    expect(ticketChip(v({}), "es").text).toBe("Sin facturar");
    expect(ticketChip(v({ eligibility: "invoicing" }), "es").text).toBe(
      "Facturando…",
    );
    expect(
      ticketChip(
        v({
          eligibility: "invoiced",
          covering: {
            documentId: "d",
            kind: "invoice",
            status: "valid",
            label: "F-12",
            periodKey: null,
          },
        }),
        "es",
      ).text,
    ).toBe("Facturado F-12");
    expect(
      ticketChip(
        v({
          eligibility: "in_global",
          covering: {
            documentId: "d",
            kind: "global",
            status: "valid",
            label: "G-3",
            periodKey: "M2026-10",
          },
        }),
        "es",
      ).text,
    ).toBe("En factura global Octubre 2026");
    expect(ticketChip(v({ eligibility: "fully_refunded" }), "en").text).toBe(
      strings.en.cfdiChipRefunded,
    );
  });
});

describe("cfdi client: helpers", () => {
  it("period labels", () => {
    expect(
      periodLabel(
        { periodicity: "month", from: "2026-10-01", to: "2026-10-31" },
        "es",
      ),
    ).toBe("Octubre 2026");
    expect(
      periodLabel(
        { periodicity: "week", from: "2026-10-05", to: "2026-10-11" },
        "es",
      ),
    ).toBe("Semana 5–11 oct 2026");
    expect(
      periodLabel(
        { periodicity: "fortnight", from: "2026-10-01", to: "2026-10-15" },
        "es",
      ),
    ).toBe("1ª quincena oct 2026");
    expect(periodKeyLabel("D2026-10-04", "es")).toBe("4 oct 2026");
    expect(periodKeyLabel("F2026-10-2", "es")).toBe("2ª quincena oct 2026");
    expect(periodKeyLabel(null, "es")).toBe("");
    // CFDI-UX-8: a week shows its real range, clipped at the end of the month.
    expect(periodKeyLabel("W2026-10-05", "es")).toBe("Semana 5–11 oct 2026");
    expect(periodKeyLabel("W2026-08-31", "es")).toBe("Semana 31–31 ago 2026");
  });
  it("a provider error path highlights its receptor field once", () => {
    const issue = issueOfError({
      code: "cfdi_receptor_name_mismatch",
      path: "customer.legal_name",
    });
    expect(issue).toEqual({
      field: "legalName",
      code: "cfdi_receptor_name_mismatch",
    });
    expect(issueOfError({ code: "x", path: "items.0.product" })).toBeNull();
    expect(issueOfError(null)).toBeNull();
    expect(withServerIssue([], issue)).toEqual([issue]);
    const own = {
      field: "legalName" as const,
      code: "cfdi_invalid_legal_name",
    };
    expect(withServerIssue([own], issue)).toEqual([own]);
    const warn = {
      field: "legalName" as const,
      code: "cfdiLegalNameSuffix",
      warning: true as const,
    };
    expect(withServerIssue([warn], issue)).toEqual([issue]);
  });
  it("register: ticket folios and the acceptance warning", () => {
    const d = (over: Partial<CfdiDocumentSummary>) =>
      ({ ticketFolios: [], ticketCount: 0, ...over }) as CfdiDocumentSummary;
    expect(
      ticketsLabel(d({ ticketFolios: ["A-000123"], ticketCount: 1 })),
    ).toBe("A-000123");
    expect(
      ticketsLabel(
        d({ ticketFolios: ["A-000101", "A-000187"], ticketCount: 87 }),
      ),
    ).toBe("A-000101 … A-000187 (87)");
    expect(ticketsLabel(d({}))).toBe("");
    const now = Date.parse("2026-10-05T12:00:00Z");
    const doc = (total: number, stampedAt: string) =>
      ({ kind: "invoice", total, stampedAt }) as CfdiDocumentView;
    expect(needsAcceptance(doc(100_001, "2026-10-04T11:00:00Z"), now)).toBe(
      true,
    );
    expect(needsAcceptance(doc(100_000, "2026-10-04T11:00:00Z"), now)).toBe(
      false,
    );
    expect(needsAcceptance(doc(500_000, "2026-10-05T11:00:00Z"), now)).toBe(
      false,
    );
  });
  it("register: two valid invoices for one sale show the alert with its ways out (CFDI-R3-1)", () => {
    const doc = (over: Partial<CfdiDocumentView>) =>
      ({
        id: "0b8c4a2e-0000-4000-8000-000000000001",
        kind: "invoice",
        series: "F",
        folioNumber: 12,
        ticketFolios: ["A-000123"],
        cancellation: null,
        waitingSubstituteId: "0b8c4a2e-0000-4000-8000-000000000002",
        canRequestAgain: true,
        ...over,
      }) as CfdiDocumentView;
    const html = (d: CfdiDocumentView, locale: "es" | "en" = "es") =>
      renderToStaticMarkup(
        createElement(SubstitutionAlert, {
          doc: d,
          locale,
          busy: false,
          open: () => {},
          requestAgain: () => {},
        }),
      );
    const cancellation = (status: string) =>
      ({
        motive: "01",
        status,
        reason: "CP",
        requestedAt: "2026-10-05T12:00:00Z",
        processedAt: "2026-10-05T12:30:00Z",
        substituteDocumentId: "0b8c4a2e-0000-4000-8000-000000000002",
        errorCode: status === "failed" ? "cfdi_cancel_rejected_provider" : null,
      }) as CfdiDocumentView["cancellation"];
    const rejected = html(doc({ cancellation: cancellation("expired") }));
    expect(rejected).toContain('role="alert"');
    expect(rejected).toContain(
      "El cliente rechazó la cancelación de F-12. Hay dos facturas vigentes para el ticket A-000123",
    );
    expect(rejected).toContain(strings.es.cfdiOpenSubstitute);
    expect(rejected).toContain(strings.es.cfdiCancelAgain);
    // Refused by the provider: the same two ways out, without blaming the customer.
    const refused = html(
      doc({ cancellation: cancellation("failed"), canRequestAgain: false }),
      "en",
    );
    expect(refused).toContain("The cancellation of F-12 did not complete.");
    expect(refused).toContain(strings.en.cfdiOpenSubstitute);
    expect(refused).not.toContain(strings.en.cfdiCancelAgain);
    expect(html(doc({ waitingSubstituteId: null }))).toBe("");
  });
  it("credit notes: the register says why Cancelar and Sustituir are missing, the dialog says how a credited global is invoiced, and no message tells staff to cancel credit notes (CFDI-INT-1)", () => {
    const html = (
      over: Partial<CfdiDocumentView>,
      locale: "es" | "en" = "es",
    ) =>
      renderToStaticMarkup(
        createElement(CreditNotesBlockNote, {
          doc: {
            kind: "invoice",
            creditNotesBlock: true,
            ...over,
          } as CfdiDocumentView,
          locale,
        }),
      );
    expect(html({})).toContain(strings.es.cfdiCreditNotesBlockInvoice);
    expect(html({}, "en")).toContain(strings.en.cfdiCreditNotesBlockInvoice);
    expect(html({ kind: "global" })).toContain(
      strings.es.cfdiCreditNotesBlockGlobal,
    );
    expect(html({ creditNotesBlock: false })).toBe("");
    expect(
      inGlobalNotice({ reissueRoute: "cancel", reissueReason: null }),
    ).toBe("cfdiInGlobalManager");
    expect(
      inGlobalNotice({
        reissueRoute: "credit_note",
        reissueReason: "deadline",
      }),
    ).toBe("cfdiInGlobalCreditNote");
    expect(
      inGlobalNotice({
        reissueRoute: "credit_note",
        reissueReason: "credit_notes",
      }),
    ).toBe("cfdiInGlobalHasCreditNotes");
    // A credit note is never canceled on its own (LD-33): no text may ask for it.
    const impossible =
      /cancela(las)? primero|canc[eé]lalas|cancel (them|the related credit notes)/i;
    for (const locale of ["es", "en"] as const)
      for (const text of [
        translateError("cfdi_has_credit_notes", locale),
        translateError("cfdi_global_has_credit_notes", locale),
        strings[locale].cfdiCreditNotesBlockInvoice,
        strings[locale].cfdiCreditNotesBlockGlobal,
        strings[locale].cfdiInGlobalHasCreditNotes,
      ])
        expect(text).not.toMatch(impossible);
  });
  it("settings: an organization error without a code reads as a translated message, never the bare generic error (CFDI-INT-6)", () => {
    for (const locale of ["es", "en"] as const) {
      expect(orgErrorText(null, locale)).toBe(
        translateError("cfdi_unexpected_error", locale),
      );
      expect(orgErrorText(null, locale)).not.toBe(strings[locale].error);
      expect(orgErrorText("cfdi_provider_unavailable", locale)).toBe(
        translateError("cfdi_provider_unavailable", locale),
      );
      expect(orgErrorText("cfdi_provider_unavailable", locale)).not.toBe(
        strings[locale].error,
      );
    }
  });
  it("settings: badge and polling decisions", () => {
    const view = (over: Partial<CfdiSettingsView>) =>
      ({
        prerequisites: {
          platform: true,
          fiscalComplete: true,
          currency: true,
          legalNameLength: true,
          regime: "601",
        },
        settings: { enabled: true, mode: "test", liveRequested: null },
        organization: {
          status: "ready",
          csd: { status: "valid", lastUpload: null },
        },
        attention: {
          overdueGlobals: 0,
          failedDocuments: 0,
          stuckDocuments: 0,
          rejectedSubstitutions: 0,
          csdExpiresSoon: false,
        },
        ...over,
      }) as unknown as CfdiSettingsView;
    expect(cfdiBadge(view({})).key).toBe("cfdiBadgeTest");
    expect(
      cfdiBadge(
        view({
          prerequisites: {
            platform: false,
            fiscalComplete: true,
            currency: true,
            legalNameLength: true,
            regime: null,
          },
        }),
      ).key,
    ).toBe("cfdiBadgeUnavailable");
    expect(cfdiBadge(view({ settings: null })).key).toBe("cfdiBadgeOff");
    expect(
      cfdiBadge(
        view({
          attention: {
            overdueGlobals: 1,
            failedDocuments: 0,
            stuckDocuments: 0,
            rejectedSubstitutions: 0,
            csdExpiresSoon: false,
          },
        }),
      ),
    ).toEqual({ key: "cfdiBadgeAttention", tone: "red" });
    expect(settling(view({}))).toBe(false);
    expect(
      settling(
        view({
          organization: {
            status: "provisioning",
            csd: { status: "missing", lastUpload: null },
          } as unknown as CfdiSettingsView["organization"],
        }),
      ),
    ).toBe(true);
    expect(settling(null)).toBe(false);
  });
  it("corte coverage renders the three lines", () => {
    const out = html(
      createElement(CfdiCorteCoverage, {
        coverage: {
          mode: "live",
          tickets: 10,
          invoiced: 2,
          globalized: 7,
          uncovered: 1,
          invoicedTotal: 23200,
          globalTotal: 81200,
        },
        locale: "es",
      }),
    );
    expect(out).toContain("Facturación (CFDI)");
    expect(out).toContain("Facturados a clientes: 2 tickets");
    expect(out).toContain("En factura global: 7 tickets");
    expect(out).toContain("Sin factura todavía: 1 tickets");
  });
  it("CSD files are sent as base64 and the portal reads its code from the path", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(base64Of(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
    expect(codeFromPath("/f/7K3M9QX2PA8D")).toBe("7K3M9QX2PA8D");
    expect(codeFromPath("/factura")).toBeNull();
    expect(portalMessage("request_failed", "es")).toBe(
      strings.es.cfdiPortalRequestFailed,
    );
    expect(portalMessage("cfdi_portal_code_not_found", "en")).toContain("12");
  });
  it("CFDI-UX-2/UX-5: the portal offers 'Corregir mis datos' only for data the customer can fix, says the restaurant failed otherwise, and words transport codes for customers", () => {
    expect(receptorFixable({ code: "cfdi_receptor_name_mismatch" })).toBe(true);
    expect(receptorFixable({ code: "cfdi_invalid_rfc" })).toBe(true);
    expect(receptorFixable({ code: "cfdi_use_not_allowed" })).toBe(true);
    expect(
      receptorFixable({
        code: "cfdi_stamping_rejected",
        path: "customer.tax_id",
      }),
    ).toBe(true);
    expect(receptorFixable({ code: "cfdi_csd_expired" })).toBe(false);
    expect(receptorFixable({ code: "cfdi_org_tax_info_invalid" })).toBe(false);
    expect(receptorFixable(null)).toBe(false);
    const csd = portalFailure({ code: "cfdi_csd_expired", path: null }, "es");
    expect(csd).toEqual({
      text: strings.es.cfdiPortalRestaurantFailed,
      fixable: false,
    });
    expect(
      portalFailure({ code: "cfdi_receptor_zip_mismatch", path: null }, "es")
        .fixable,
    ).toBe(true);
    expect(portalMessage("network_unavailable", "es")).toBe(
      strings.es.cfdiPortalOffline,
    );
    expect(portalMessage("rate_limited", "en")).toBe(
      strings.en.cfdiPortalRateLimited,
    );
    expect(portalMessage("network_unavailable", "es")).not.toContain(
      "vendiendo",
    );
  });
  it("CFDI-MONEY-3: the amount check line compares the pre-retention total, then the IVA", () => {
    // RESICO: Total 11,455 after 145 of ISR withheld; expected 11,600 before it.
    expect(
      amountDifference({
        total: 11455,
        withheld: 145,
        expectedTotal: 11600,
        tax: 1600,
        expectedTax: 1601,
      }),
    ).toEqual({ kind: "tax", amount: 1 });
    expect(
      amountDifference({
        total: 11599,
        withheld: 0,
        expectedTotal: 11600,
        tax: 1600,
        expectedTax: 1600,
      }),
    ).toEqual({ kind: "total", amount: 1 });
    expect(
      amountDifference({
        total: 11455,
        withheld: 145,
        expectedTotal: 11600,
        tax: 1600,
        expectedTax: 1600,
      }),
    ).toBeNull();
  });
  it("CFDI-UX-4: a valid document waits for both files before the dialog links them", () => {
    const doc = (files: string[], status = "valid") =>
      ({ status, files }) as unknown as Parameters<typeof awaitingFiles>[0];
    expect(awaitingFiles(doc([]))).toBe(true);
    expect(awaitingFiles(doc(["xml"]))).toBe(true);
    expect(awaitingFiles(doc(["xml", "pdf"]))).toBe(false);
    expect(awaitingFiles(doc([], "failed"))).toBe(false);
  });
  it("CFDI-R10: a typed CSD password never outlives the idle lock (at most 2 minutes untouched)", () => {
    expect(passwordLifetimeMs(60)).toBe(60_000);
    expect(passwordLifetimeMs(900)).toBe(120_000);
    expect(passwordLifetimeMs(null)).toBe(120_000);
    expect(passwordLifetimeMs(0)).toBe(120_000);
    expect(passwordLifetimeMs(1)).toBe(5_000);
  });
  it("CFDI-R2: the history names a recovery the tick's sweep queued", () => {
    expect(eventLabel("recovery_queued", "es")).toBe(
      "Reanudado automáticamente",
    );
    expect(eventLabel("recovery_queued", "en")).toBe("Resumed automatically");
  });
});

describe("LD-51 (cfdifix): the printed deadline, the issuer block and the periodicity field", () => {
  const origin = "https://pos.example.com";
  const bound = {
    globalPeriodicity: "day" as const,
    nextPeriodicity: null,
    nextPeriodicityFrom: null,
    cutoff: 240,
    graceMinutes: 60,
  };
  it("F1: with a daily global the receipt prints the global's build (next day 05:00), with its time", () => {
    const out = html(
      createElement(CfdiReceiptBlock, {
        ticket,
        status: status({
          selfInvoice: {
            enabled: true,
            policy: "month",
            days: 30,
            globalBound: bound,
          },
        }),
        kind: "receipt",
        origin,
        now: PRINTED,
      }),
    );
    // Business date 4 Oct 2026, cut at 04:00: the daily global is built 5 Oct 05:00 local.
    expect(out).toContain("Disponible hasta el 05/10/2026 a las 05:00");
  });
  it("F1: with a monthly global the month policy ends first: the date alone, as before", () => {
    const out = html(
      createElement(CfdiReceiptBlock, {
        ticket,
        status: status({
          selfInvoice: {
            enabled: true,
            policy: "month",
            days: 30,
            globalBound: { ...bound, globalPeriodicity: "month" },
          },
        }),
        kind: "receipt",
        origin,
        now: PRINTED,
      }),
    );
    expect(out).toContain("Disponible hasta el 31/10/2026");
    expect(out).not.toContain(" a las ");
  });
  it("F1: a weekly global with a 30-day policy prints the Sunday close + grace date", () => {
    const out = html(
      createElement(CfdiReceiptBlock, {
        ticket,
        status: status({
          selfInvoice: {
            enabled: true,
            policy: "days",
            days: 30,
            globalBound: { ...bound, globalPeriodicity: "week" },
          },
        }),
        kind: "receipt",
        origin,
        now: PRINTED,
      }),
    );
    // Sunday 4 October closes its week: built 5 Oct 05:00, the next day, so with its time.
    expect(out).toContain("Disponible hasta el 05/10/2026 a las 05:00");
  });
  it("F1: the portal's deadline text, in Spanish and English", () => {
    expect(
      deadlineText(
        "2026-10-05T11:00:00Z",
        "2026-10-04",
        "America/Mexico_City",
        "es",
      ),
    ).toBe("05/10/2026 a las 05:00");
    expect(
      deadlineText(
        "2026-10-05T11:00:00Z",
        "2026-10-04",
        "America/Mexico_City",
        "en",
      ),
    ).toMatch(/^10\/05\/2026 at 0?5:00\sAM$/);
    expect(
      deadlineText(
        "2026-11-01T05:59:59.999Z",
        "2026-10-04",
        "America/Mexico_City",
        "es",
      ),
    ).toBe("31/10/2026");
  });
  it("F1: the settings say how the periodicity bounds self-invoicing", () => {
    expect(
      html(
        createElement(SelfInvoiceBound, {
          periodicity: "day",
          graceMinutes: 60,
          locale: "es",
        }),
      ),
    ).toContain("al cierre del día del consumo más 60 min");
    expect(
      html(
        createElement(SelfInvoiceBound, {
          periodicity: "month",
          graceMinutes: 30,
          locale: "en",
        }),
      ),
    ).toContain("at the close of the month of purchase plus 30 min");
  });
  it("CFDIFIX-6: the bound names the periodicity in force, and a different one chosen or pending gets its own sentence", () => {
    const out = html(
      createElement(SelfInvoiceBound, {
        periodicity: "month",
        next: "day",
        graceMinutes: 60,
        locale: "es",
      }),
    );
    expect(out).toContain("al cierre del mes del consumo más 60 min");
    expect(out).toContain(
      "Con periodicidad diaria: al cierre del día del consumo más 60 min.",
    );
    const same = html(
      createElement(SelfInvoiceBound, {
        periodicity: "day",
        next: "day",
        graceMinutes: 60,
        locale: "es",
      }),
    );
    expect(same).not.toContain("Con periodicidad");
  });
  it("CFDIFIX-11: a deadline already past when the receipt prints (yesterday's check paid after its daily global was built) asks at the counter instead", () => {
    const daily = status({
      selfInvoice: {
        enabled: true,
        policy: "month",
        days: 30,
        globalBound: bound,
      },
    });
    // Business date 4 Oct: its daily global is built 5 Oct 05:00 local (11:00Z).
    const late = html(
      createElement(CfdiReceiptBlock, {
        ticket,
        status: daily,
        kind: "receipt",
        origin,
        now: Date.parse("2026-10-05T11:30:00Z"),
      }),
    );
    expect(late).toContain("Pídela en caja con el folio A-000123.");
    expect(late).not.toContain("Disponible hasta");
    expect(late).not.toContain("<svg");
    const onTime = html(
      createElement(CfdiReceiptBlock, {
        ticket,
        status: daily,
        kind: "receipt",
        origin,
        now: Date.parse("2026-10-05T10:59:00Z"),
      }),
    );
    expect(onTime).toContain("Disponible hasta el 05/10/2026 a las 05:00");
  });

  const org = (
    over: Partial<CfdiOrganizationView> = {},
  ): CfdiOrganizationView => ({
    source: "own",
    status: "ready",
    provisioned: true,
    errorCode: null,
    taxId: null,
    sharedIssuer: null,
    legalSyncedVersion: 1,
    fiscalProfileVersion: 2,
    csd: {
      status: "missing",
      serial: null,
      validUntil: null,
      lastUpload: null,
    },
    productionReady: false,
    pendingSteps: [],
    checkedAt: null,
    lastEvent: null,
    ...over,
  });
  it("F9: the issuer RFC reads pending until Facturapi reports it, then shows it", () => {
    const pending = html(
      createElement(OrganizationFacts, {
        org: org({
          csd: {
            status: "valid",
            serial: "30001000000500003416",
            validUntil: "2030-01-01T00:00:00.000Z",
            lastUpload: null,
          },
        }),
        locale: "es",
      }),
    );
    expect(pending).toContain("RFC del emisor");
    expect(pending).toContain("Pendiente: Facturapi aún no lo reporta");
    const known = html(
      createElement(OrganizationFacts, {
        org: org({ taxId: "EKU9003173C9" }),
        locale: "es",
      }),
    );
    expect(known).toContain("EKU9003173C9");
    expect(known).not.toContain("Pendiente");
    // An own organization behind on its legal data still says it will be sent.
    expect(known).toContain(strings.es.cfdiLegalPending);
  });
  it("F3/F8: the shared sandbox shows the platform test organization as the issuer and no legal-sync note", () => {
    const out = html(
      createElement(OrganizationFacts, {
        org: org({
          source: "shared_sandbox",
          taxId: "EKU9003173C9",
          legalSyncedVersion: null,
          sharedIssuer: {
            legalName: "PLATAFORMA DE PRUEBA",
            taxId: "EKU9003173C9",
            regime: "601",
            postalCode: "01000",
            complete: true,
          },
        }),
        locale: "es",
      }),
    );
    expect(out).toContain("PLATAFORMA DE PRUEBA");
    expect(out).toContain("EKU9003173C9");
    expect(out).toContain("601 — General de Ley Personas Morales");
    expect(out).toContain("01000");
    expect(out).toContain("Emisor de prueba de la plataforma");
    expect(out).toContain(strings.es.cfdiSharedIssuerNote);
    expect(out).not.toContain(strings.es.cfdiLegalPending);
    expect(out).not.toContain("Datos fiscales enviados a Facturapi");
  });
  it("F10: the periodicity field states the current one and a pending change with its date", () => {
    expect(
      html(
        createElement(PeriodicityStatus, {
          settings: {
            globalPeriodicity: "month",
            nextPeriodicity: null,
            nextPeriodicityFrom: null,
          },
          businessDate: "2026-10-07",
          locale: "es",
        }),
      ),
    ).toContain("Periodicidad actual: mensual.");
    const pending = html(
      createElement(PeriodicityStatus, {
        settings: {
          globalPeriodicity: "month",
          nextPeriodicity: "day",
          nextPeriodicityFrom: "2026-11-01",
        },
        businessDate: "2026-10-07",
        locale: "es",
      }),
    );
    expect(pending).toContain("Periodicidad actual: mensual.");
    expect(pending).toContain("Cambia a diaria desde el 1 nov 2026.");
    expect(
      html(
        createElement(PeriodicityStatus, {
          settings: {
            globalPeriodicity: "week",
            nextPeriodicity: "fortnight",
            nextPeriodicityFrom: "2026-11-01",
          },
          businessDate: "2026-10-07",
          locale: "en",
        }),
      ),
    ).toContain("Current frequency: weekly. Changes to fortnightly on");
  });
  it("CFDIFIX-6: from its first day a pending change is the current one, before the tick promotes it", () => {
    const out = html(
      createElement(PeriodicityStatus, {
        settings: {
          globalPeriodicity: "month",
          nextPeriodicity: "day",
          nextPeriodicityFrom: "2026-11-01",
        },
        businessDate: "2026-11-01",
        locale: "es",
      }),
    );
    expect(out).toContain("Periodicidad actual: diaria.");
    expect(out).not.toContain("Cambia a");
  });
  it("CFDIFIX-5: a change that waits says why, while it is still the pending one", () => {
    const settings = {
      globalPeriodicity: "month" as const,
      nextPeriodicity: "day" as const,
      nextPeriodicityFrom: "2026-11-01",
    };
    const deferred = (reason: "globals" | "overdue" | "deadline") => ({
      at: "2026-10-07T18:00:00.000Z",
      from: "month" as const,
      to: "day" as const,
      nextFrom: "2026-11-01",
      reason,
      source: "save" as const,
    });
    const out = (
      reason: "globals" | "overdue" | "deadline",
      locale: "es" | "en",
    ) =>
      html(
        createElement(PeriodicityStatus, {
          settings: { ...settings, periodicityDeferred: deferred(reason) },
          businessDate: "2026-10-07",
          locale,
        }),
      );
    expect(out("deadline", "es")).toContain(
      "Cambia a diaria desde el 1 nov 2026. No se aplicó al momento: acortaría el plazo para autofacturar de tickets ya vendidos este mes.",
    );
    expect(out("globals", "es")).toContain(
      "No se aplicó al momento: el mes ya tiene una factura global.",
    );
    expect(out("overdue", "en")).toContain(
      "It did not apply at once: a ticket of the month would fall in a period whose global invoice is already overdue.",
    );
    // No pending change (the owner chose again), no reason.
    expect(
      html(
        createElement(PeriodicityStatus, {
          settings: {
            globalPeriodicity: "month",
            nextPeriodicity: null,
            nextPeriodicityFrom: null,
            periodicityDeferred: null,
          },
          businessDate: "2026-10-07",
          locale: "es",
        }),
      ),
    ).not.toContain("No se aplicó");
  });
  it("LD-55 CFDIFIX-UX-7: an own organization's pending RFC says the CSD upload confirms it, and an organization in error shows none", () => {
    const noCsd = html(
      createElement(OrganizationFacts, { org: org(), locale: "es" }),
    );
    expect(noCsd).toContain(
      "Pendiente: se confirma al subir tu certificado (CSD)",
    );
    expect(noCsd).not.toContain("Facturapi aún no lo reporta");
    const error = html(
      createElement(OrganizationFacts, {
        org: org({ status: "error", errorCode: "cfdi_org_key_invalid" }),
        locale: "es",
      }),
    );
    expect(error).not.toContain("Pendiente");
    expect(error).toContain('<dd class="muted">—</dd>');
    expect(
      html(createElement(OrganizationFacts, { org: org(), locale: "en" })),
    ).toContain("Pending: confirmed when you upload your certificate (CSD)");
  });
  it("LD-55 CFDIFIX-UX-6 / FISCAL-6: the shared issuer note says the rules follow the restaurant's own régimen, and says the profile stamps while Facturapi has not reported the test organization whole", () => {
    const shared = (complete: boolean) =>
      html(
        createElement(OrganizationFacts, {
          org: org({
            source: "shared_sandbox",
            taxId: "EKU9003173C9",
            legalSyncedVersion: null,
            sharedIssuer: {
              legalName: null,
              taxId: "EKU9003173C9",
              regime: complete ? "626" : null,
              postalCode: "01000",
              complete,
            },
          }),
          locale: "es",
        }),
      );
    expect(shared(true)).toContain(
      "La periodicidad y las demás reglas siguen tu propio régimen, que es el que aplicará en modo real.",
    );
    const partial = shared(false);
    expect(partial).toContain(strings.es.cfdiSharedIssuerFallback);
    expect(partial).toContain("se timbra con los datos de tu perfil fiscal");
    expect(partial).not.toContain("no se usan para timbrar");
  });
  it("LD-55 CFDIFIX-UX-3: RESICO's activation shows monthly and no 'you can change it later' hint", () => {
    const step = (resico: boolean) =>
      html(
        createElement(ActivationPeriodicity, {
          value: "day",
          onChange: () => {},
          resico,
          busy: false,
          graceMinutes: 60,
          locale: "es",
        }),
      );
    expect(step(true)).toContain(strings.es.cfdiResicoMonthly);
    expect(step(true)).not.toContain(strings.es.cfdiActivatePeriodicityHint);
    expect(step(false)).toContain(strings.es.cfdiActivatePeriodicityHint);
    expect(step(false)).not.toContain(strings.es.cfdiResicoMonthly);
  });
  it("LD-55 CFDIFIX-UX-2: the save's status says whether the periodicity applies today or waits, until when and why; and a self-invoicing change that waits", () => {
    const base = {
      enabled: true,
      mode: "test" as const,
      testFrom: "2026-10-01",
      liveFrom: null,
      liveRequested: null,
      globalPeriodicity: "month" as const,
      nextPeriodicity: null,
      nextPeriodicityFrom: null,
      globalAuto: true,
      conceptMode: "grouped" as const,
      conceptDescription: "Consumo",
      cardPaymentForm: "04" as const,
      defaultUse: "G03" as const,
      selfInvoiceEnabled: true,
      selfInvoicePolicy: "month" as const,
      selfInvoiceDays: 30,
      portalReissueGlobal: true,
      selfInvoicePending: null,
      supportEmail: null,
      version: 3,
      updatedAt: "2026-10-15T18:00:00.000Z",
      updatedByName: null,
      resicoMonthly: false,
      periodicityDeferred: null,
    };
    const deferred = settingsSavedNote(
      base,
      {
        ...base,
        nextPeriodicity: "day",
        nextPeriodicityFrom: "2026-11-01",
        periodicityDeferred: {
          at: "2026-10-15T18:00:00.000Z",
          from: "month",
          to: "day",
          nextFrom: "2026-11-01",
          reason: "deadline",
          source: "save",
        },
      },
      "2026-10-15",
      "es",
    );
    expect(deferred).toBe(
      "La periodicidad cambia a diaria desde el 1 nov 2026: acortaría el plazo para autofacturar de tickets ya vendidos este mes.",
    );
    expect(
      settingsSavedNote(
        base,
        { ...base, globalPeriodicity: "day" },
        "2026-10-15",
        "es",
      ),
    ).toBe("La periodicidad diaria aplica desde hoy.");
    expect(settingsSavedNote(base, base, "2026-10-15", "es")).toBe("");
    expect(
      settingsSavedNote(
        base,
        {
          ...base,
          selfInvoicePending: {
            policy: "month",
            days: 30,
            reissue: false,
            from: "2026-11-01",
          },
        },
        "2026-10-15",
        "es",
      ),
    ).toBe(
      "El cambio del plazo para autofacturarse aplica desde el 1 nov 2026: antes acortaría el plazo que ya imprimieron tickets vendidos.",
    );
    // The periodicity line can describe the select (aria-describedby).
    expect(
      html(
        createElement(PeriodicityStatus, {
          settings: base,
          businessDate: "2026-10-15",
          locale: "es",
          id: "periodicity-status",
        }),
      ),
    ).toContain('id="periodicity-status"');
  });
  it("LD-55 CFDIFIX-UX-4: the form warns when it shortens the self-invoicing deadline, and a change that waits says from when", () => {
    const on = {
      selfInvoicePolicy: "month" as const,
      selfInvoiceDays: 30,
      portalReissueGlobal: true,
    };
    expect(selfInvoiceShortens(on, { ...on, portalReissueGlobal: false })).toBe(
      true,
    );
    expect(
      selfInvoiceShortens(on, {
        ...on,
        selfInvoicePolicy: "days",
        selfInvoiceDays: 3,
      }),
    ).toBe(true);
    expect(
      selfInvoiceShortens(
        { ...on, selfInvoicePolicy: "days", selfInvoiceDays: 10 },
        { ...on, selfInvoicePolicy: "days", selfInvoiceDays: 20 },
      ),
    ).toBe(false);
    expect(selfInvoiceShortens({ ...on, portalReissueGlobal: false }, on)).toBe(
      false,
    );
    expect(
      html(
        createElement(SelfInvoicePendingStatus, {
          pending: {
            policy: "month",
            days: 30,
            reissue: false,
            from: "2026-11-01",
          },
          locale: "es",
        }),
      ),
    ).toContain(
      "Cambio pendiente del plazo para autofacturarse: aplica desde el 1 nov 2026",
    );
    expect(
      html(
        createElement(SelfInvoicePendingStatus, {
          pending: null,
          locale: "es",
        }),
      ),
    ).toBe("");
  });
  it("LD-55 CFDIFIX-FISCAL-1 / UX-1: a global-bound deadline prints its time whatever the day: a mid-week weekly sale, a fortnightly one, a 'days' window cut by a monthly global", () => {
    const receipt = (
      businessDate: string,
      periodicity: "week" | "fortnight" | "month",
      policy: "month" | "days" = "month",
      days = 30,
    ) =>
      html(
        createElement(CfdiReceiptBlock, {
          ticket: { ...ticket, businessDate } as FiscalTicketView,
          status: status({
            selfInvoice: {
              enabled: true,
              policy,
              days,
              globalBound: { ...bound, globalPeriodicity: periodicity },
            },
          }),
          kind: "receipt",
          origin,
          now: Date.parse(businessDate + "T18:00:00Z"),
        }),
      );
    // Wednesday 7 Oct, cutoff 04:00, grace 60: the week's global is built Monday 12 Oct 05:00.
    expect(receipt("2026-10-07", "week")).toContain(
      "Disponible hasta el 12/10/2026 a las 05:00",
    );
    expect(receipt("2026-10-07", "fortnight")).toContain(
      "Disponible hasta el 16/10/2026 a las 05:00",
    );
    expect(receipt("2026-10-30", "month", "days", 3)).toContain(
      "Disponible hasta el 01/11/2026 a las 05:00",
    );
    // The portal's and the staff dialog's text (deadlineText).
    expect(
      deadlineText(
        "2026-10-12T11:00:00Z",
        "2026-10-07",
        "America/Mexico_City",
        "es",
      ),
    ).toBe("12/10/2026 a las 05:00");
    expect(
      deadlineText(
        "2026-10-16T11:00:00Z",
        "2026-10-07",
        "America/Mexico_City",
        "en",
      ),
    ).toMatch(/^10\/16\/2026 at 0?5:00\sAM$/);
  });
  it("LD-55 CFDIFIX-FISCAL-5: while a self-invoicing change waits, the receipt prints the deadline both terms allow", () => {
    // Reissue on → off from 1 Nov (weekly globals): a sale of 7 Oct keeps 31 Oct.
    const out = html(
      createElement(CfdiReceiptBlock, {
        ticket: { ...ticket, businessDate: "2026-10-07" } as FiscalTicketView,
        status: status({
          selfInvoice: {
            enabled: true,
            policy: "month",
            days: 30,
            globalBound: null,
            pending: {
              policy: "month",
              days: 30,
              globalBound: { ...bound, globalPeriodicity: "week" },
              fromAt: "2026-11-01T10:00:00.000Z",
            },
          },
        }),
        kind: "receipt",
        origin,
        now: Date.parse("2026-10-07T18:00:00Z"),
      }),
    );
    expect(out).toContain("Disponible hasta el 31/10/2026");
    expect(out).not.toContain("12/10/2026");
  });
  it("LD-55 CFDIFIX-UX-5: the last live mismatch says the acuse will not be requested again and to contact support", () => {
    const es = eventLabel("acuse_mismatch_final", "es");
    expect(es).toBe(strings.es.cfdiEventAcuseMismatchFinal);
    expect(es).toContain("no se volverá a pedir automáticamente");
    expect(es).toContain("Contacta a soporte");
    expect(eventLabel("acuse_mismatch_final", "en")).toContain(
      "will not be requested again",
    );
  });
  it("F7: the register names the acuse that was not stored", () => {
    expect(eventLabel("acuse_mismatch", "es")).toBe(
      strings.es.cfdiEventAcuseMismatch,
    );
  });
  it("CFDIFIX-2: a live-mode mismatch never reads as test mode, and says it will be requested again", () => {
    const es = eventLabel("acuse_mismatch_live", "es");
    expect(es).toBe(strings.es.cfdiEventAcuseMismatchLive);
    expect(es).not.toContain("modo prueba");
    expect(es).toContain("se volverá a pedir");
    expect(eventLabel("acuse_mismatch_live", "en")).not.toContain("test mode");
  });
});
