import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FACTURAPI_BASE_URL } from "../server/cfdi/facturapi";
import {
  billingConsentEvidence,
  legalConfig,
  legalContentHash,
  logLegalStartup,
  signupOpen,
} from "../server/legal";
import { setLogSink } from "../server/logging";
import {
  BILLING_CONSENT,
  CLUB_LEGAL_EFFECTIVE_FROM,
  CLUB_LEGAL_VERSION,
  clubLegalCovered,
  LEGAL_CONTENT,
  LEGAL_DOCUMENTS,
  MATERIAL_NOTICE_DAYS,
  PRIVACY_SIMPLIFIED,
  acceptancePending,
  acceptanceStatus,
  compareLegalVersions,
  legalInstant,
  legalSegments,
  legalText,
  materialChange,
  pendingDocuments,
  type LegalDocumentKey,
  type LegalDocumentMeta,
} from "../shared/legal";
import { KIOSK_COOKIE, KIOSK_COOKIE_MAX_AGE_SECONDS } from "../shared/kiosk";
import { LEGAL_CI_ENV } from "./fixtures/legal-ci";

const production = { NODE_ENV: "production" } as const;
const valid = {
  LEGAL_ENTITY_NAME: "Restaurantes Unidos S.A. de C.V.",
  LEGAL_ENTITY_ADDRESS: "Av. Reforma 222, Juárez, 06600 Ciudad de México",
  LEGAL_PRIVACY_CONTACT_EMAIL: "privacidad@restaurantes-unidos.mx",
  LEGAL_JURISDICTION: "Ciudad de México",
};
const logs: Record<string, unknown>[] = [];
setLogSink((line) => logs.push(JSON.parse(line)));
afterEach(() => {
  logs.length = 0;
});

describe("legal configuration (FIT-12, LD-3)", () => {
  it("publishes only when every required entity field is valid", () => {
    expect(legalConfig(valid).status).toBe("published");
    for (const name of Object.keys(valid)) {
      const c = legalConfig({ ...valid, [name]: "" });
      expect(c.status, name).toBe("unpublished");
      expect(c.missing).toEqual([name]);
      expect(c.entity).toBeNull();
    }
  });

  it("refuses placeholders, brackets and example domains", () => {
    for (const [name, value] of [
      ["LEGAL_ENTITY_NAME", "REPLACE_ME S.A."],
      ["LEGAL_ENTITY_NAME", "<nombre de la empresa>"],
      ["LEGAL_ENTITY_NAME", "Acme Restaurantes"],
      ["LEGAL_ENTITY_ADDRESS", "[domicilio pendiente de definir]"],
      ["LEGAL_ENTITY_ADDRESS", "Calle Lorem Ipsum 1, CDMX"],
      ["LEGAL_PRIVACY_CONTACT_EMAIL", "privacidad@example.com"],
      ["LEGAL_PRIVACY_CONTACT_EMAIL", "privacidad@empresa.test"],
      ["LEGAL_PRIVACY_CONTACT_EMAIL", "no-es-correo"],
      ["LEGAL_JURISDICTION", "TBD"],
    ] as const) {
      const c = legalConfig({ ...valid, [name]: value });
      expect(c.status, value).toBe("unpublished");
      expect(c.invalid, value).toContain(name);
    }
  });

  it("refuses placeholder markers as whole words but publishes real Spanish names that contain them (ACC-11)", () => {
    for (const [name, value] of [
      ["LEGAL_ENTITY_NAME", "TODO"],
      ["LEGAL_ENTITY_NAME", "TODO_RAZON_SOCIAL"],
      ["LEGAL_ENTITY_NAME", "Nombre (TODO)"],
      ["LEGAL_JURISDICTION", "tbd"],
      ["LEGAL_ENTITY_ADDRESS", "Sample Street 1, Ciudad de México"],
      ["LEGAL_ENTITY_NAME", "Dummy Foods S.A. de C.V."],
      ["LEGAL_ENTITY_NAME", "XXXXX S.A. de C.V."],
      ["LEGAL_ENTITY_NAME", "Restaurantes CHANGEME S.A."],
    ] as const) {
      const c = legalConfig({ ...valid, ...production, [name]: value });
      expect(c.status, value).toBe("unpublished");
      expect(c.invalid, value).toContain(name);
    }
    for (const [name, value] of [
      [
        "LEGAL_ENTITY_ADDRESS",
        "Calle Hidalgo 5, Centro, 23305 Todos Santos, B.C.S.",
      ],
      ["LEGAL_ENTITY_NAME", "Comida para Todos S.A. de C.V."],
      ["LEGAL_ENTITY_NAME", "Todo Fresco S.A. de C.V."],
      ["LEGAL_ENTITY_NAME", "Sacmex Alimentos S.A. de C.V."],
      ["LEGAL_JURISDICTION", "Todos Santos, Baja California Sur"],
    ] as const) {
      const c = legalConfig({ ...valid, ...production, [name]: value });
      expect(c.invalid, value).toEqual([]);
      expect(c.status, value).toBe("published");
    }
  });

  it("refuses test/demo words only in production", () => {
    const demo = { ...valid, LEGAL_ENTITY_NAME: "Demo Foods S.A. de C.V." };
    expect(legalConfig(demo).status).toBe("published");
    expect(legalConfig({ ...demo, ...production }).status).toBe("unpublished");
    expect(
      legalConfig({ ...valid, ...production, LEGAL_JURISDICTION: "Prueba" })
        .invalid,
    ).toEqual(["LEGAL_JURISDICTION"]);
  });

  it("the fictional CI value set publishes under NODE_ENV=production", () => {
    const c = legalConfig({ ...LEGAL_CI_ENV, ...production });
    expect(c.status).toBe("published");
    expect(c.missing).toEqual([]);
    expect(c.invalid).toEqual([]);
    expect(c.support.configured).toBe(true);
    expect(c.entity?.rfc).toBeNull();
  });

  it("production refuses the fictional CI set's identifying values (ACC-18)", () => {
    for (const where of [
      { APP_ENV: "production" },
      { RAILWAY_ENVIRONMENT_NAME: "production" },
    ]) {
      const c = legalConfig({ ...LEGAL_CI_ENV, ...production, ...where });
      expect(c.status).toBe("unpublished");
      expect(c.entity).toBeNull();
      expect(c.invalid.sort()).toEqual(
        [
          "LEGAL_ENTITY_ADDRESS",
          "LEGAL_ENTITY_NAME",
          "LEGAL_PRIVACY_CONTACT_EMAIL",
          "SUPPORT_EMAIL",
          "SUPPORT_PHONE",
        ].sort(),
      );
      expect(c.support.configured).toBe(false);
      // One copied value is enough to keep the documents unpublished, and
      // any address at the fictional domain counts.
      expect(
        legalConfig({
          ...valid,
          ...where,
          LEGAL_ENTITY_NAME: LEGAL_CI_ENV.LEGAL_ENTITY_NAME.toUpperCase(),
        }).invalid,
      ).toEqual(["LEGAL_ENTITY_NAME"]);
      expect(
        legalConfig({
          ...valid,
          ...where,
          LEGAL_PRIVACY_CONTACT_EMAIL: "datos@nopalverde.mx",
        }).status,
      ).toBe("unpublished");
      // A real set with the same jurisdiction and hours publishes.
      const real = legalConfig({
        ...valid,
        ...where,
        LEGAL_JURISDICTION: LEGAL_CI_ENV.LEGAL_JURISDICTION,
        SUPPORT_HOURS: LEGAL_CI_ENV.SUPPORT_HOURS,
      });
      expect(real.status).toBe("published");
      expect(real.support.hoursEs).toBe(LEGAL_CI_ENV.SUPPORT_HOURS);
    }
  });

  it("APP_ENV=production ignores LEGAL_UNPUBLISHED_SIGNUP=allow and logs it", () => {
    const allowed = legalConfig({ LEGAL_UNPUBLISHED_SIGNUP: "allow" });
    expect(signupOpen(allowed)).toBe(true);
    const env = { LEGAL_UNPUBLISHED_SIGNUP: "allow", APP_ENV: "production" };
    const c = legalConfig(env);
    expect(c.unpublishedSignupAllowed).toBe(false);
    expect(signupOpen(c)).toBe(false);
    logLegalStartup(c, env);
    expect(logs.map((l) => [l.level, l.message])).toEqual([
      ["error", "legal_documents_unpublished"],
      ["error", "legal_unpublished_signup_ignored"],
    ]);
    // Railway's production environment counts too.
    expect(
      legalConfig({
        LEGAL_UNPUBLISHED_SIGNUP: "allow",
        RAILWAY_ENVIRONMENT_NAME: "production",
      }).unpublishedSignupAllowed,
    ).toBe(false);
  });

  it("logLegalStartup names missing fields but never values", () => {
    const env = {
      ...valid,
      LEGAL_ENTITY_NAME: "",
      LEGAL_JURISDICTION: "<pendiente>",
    };
    logLegalStartup(legalConfig(env), env);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "warn",
      message: "legal_documents_unpublished",
      fields: ["LEGAL_ENTITY_NAME", "LEGAL_JURISDICTION"],
    });
    const text = JSON.stringify(logs);
    for (const value of Object.values(valid)) expect(text).not.toContain(value);
    expect(text).not.toContain("pendiente");
  });

  it("validates optional RFC formats (moral 12, física 13) with the fiscal core", () => {
    expect(
      legalConfig({ ...valid, LEGAL_ENTITY_RFC: "EKU9003173C9" }).entity?.rfc,
    ).toBe("EKU9003173C9");
    expect(
      legalConfig({ ...valid, LEGAL_ENTITY_RFC: "XIQB891116QE4" }).entity?.rfc,
    ).toBe("XIQB891116QE4");
    for (const bad of ["EKU9013173C9", "XAXX010101000", "EKU900317"]) {
      const c = legalConfig({ ...valid, LEGAL_ENTITY_RFC: bad });
      expect(c.status, bad).toBe("published");
      expect(c.entity?.rfc, bad).toBeNull();
      expect(c.invalid, bad).toEqual(["LEGAL_ENTITY_RFC"]);
    }
  });

  it("never exposes entity values when unpublished", () => {
    const c = legalConfig({ ...valid, LEGAL_JURISDICTION: "" });
    expect(c.entity).toBeNull();
    expect(JSON.stringify(c)).not.toContain(valid.LEGAL_ENTITY_NAME);
    expect(c.entityHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("entity hash changes when any field changes", () => {
    const base = legalConfig(valid).entityHash;
    expect(legalConfig(valid).entityHash).toBe(base);
    for (const [name, value] of Object.entries({
      LEGAL_ENTITY_NAME: "Otra Empresa S.A. de C.V.",
      LEGAL_ENTITY_ADDRESS: "Av. Insurgentes 1, Roma, 06700 Ciudad de México",
      LEGAL_ENTITY_RFC: "EKU9003173C9",
      LEGAL_PRIVACY_CONTACT_EMAIL: "datos@restaurantes-unidos.mx",
      LEGAL_PRIVACY_CONTACT_NAME: "Oficial de privacidad",
      LEGAL_JURISDICTION: "Guadalajara, Jalisco",
    }))
      expect(
        legalConfig({ ...valid, [name]: value }).entityHash,
        name,
      ).not.toBe(base);
  });

  it("validates support channels and drops invalid ones", () => {
    const c = legalConfig({
      ...valid,
      SUPPORT_PHONE: "5512345678",
      SUPPORT_WHATSAPP: "+525598765432",
      SUPPORT_URL: "http://ayuda.restaurantes-unidos.mx",
    });
    expect(c.support).toMatchObject({
      phone: null,
      whatsapp: "+525598765432",
      url: null,
      configured: true,
    });
    expect(c.invalid.sort()).toEqual(["SUPPORT_PHONE", "SUPPORT_URL"]);
    expect(legalConfig(valid).support.configured).toBe(false);
  });
});

describe("legal documents", () => {
  const current = { status: "published" as const, entityHash: "a".repeat(64) };
  const row = (version: string, over = {}) => ({
    version,
    entityHash: current.entityHash,
    published: true,
    ...over,
  });

  it("pendingDocuments: missing, older than requiresAcceptanceSince, unpublished acceptance after publish; an entity-only change is a notice, never pending (LEGAL-3)", () => {
    const v = LEGAL_DOCUMENTS.terms.version;
    expect(pendingDocuments({}, current)).toEqual(["terms", "privacy"]);
    expect(
      pendingDocuments({ terms: row(v), privacy: row(v) }, current),
    ).toEqual([]);
    expect(
      pendingDocuments({ terms: row("2026-01-01"), privacy: row(v) }, current),
    ).toEqual(["terms"]);
    expect(
      pendingDocuments(
        { terms: row(v), privacy: row(v, { entityHash: "b".repeat(64) }) },
        current,
      ),
    ).toEqual([]);
    expect(
      acceptanceStatus(
        "privacy",
        row(v, { entityHash: "b".repeat(64) }),
        current,
      ),
    ).toBe("entity_updated");
    expect(
      pendingDocuments(
        { terms: row(v, { published: false }), privacy: row(v) },
        current,
      ),
    ).toEqual(["terms"]);
    expect(
      pendingDocuments({}, { status: "unpublished", entityHash: "x" }),
    ).toEqual([]);
    expect(acceptancePending("dpa", null, current)).toBe(true);
  });

  it("a material change is announced first and gates only from effectiveFrom; an earlier missed material change stays required; a newer minor version is a notice (LEGAL-3, UX-4)", () => {
    const meta = LEGAL_DOCUMENTS.terms;
    const original = { ...meta };
    try {
      Object.assign(meta, {
        version: "2027-03-01",
        requiresAcceptanceSince: "2027-03-01",
        previousVersion: "2026-10-06",
        previousRequiresAcceptanceSince: "2026-10-06",
        announcedAt: "2027-03-01",
        effectiveFrom: "2027-03-16",
      } satisfies Partial<LegalDocumentMeta>);
      const accepted = row("2026-10-06");
      const before = legalInstant("2027-03-16") - 1;
      const after = legalInstant("2027-03-16");
      expect(acceptanceStatus("terms", accepted, current, before)).toBe(
        "announced",
      );
      expect(acceptancePending("terms", accepted, current, before)).toBe(false);
      // Nothing shows before announcedAt.
      expect(
        acceptanceStatus(
          "terms",
          accepted,
          current,
          legalInstant("2027-03-01") - 1,
        ),
      ).toBe("accepted");
      expect(acceptanceStatus("terms", accepted, current, after)).toBe(
        "required",
      );
      // An acceptance older than the previous material version was already
      // required: the new announcement does not relax it.
      expect(
        acceptanceStatus("terms", row("2026-01-01"), current, before),
      ).toBe("required");
      // Accepting the announced version early settles it.
      expect(
        acceptanceStatus("terms", row("2027-03-01"), current, before),
      ).toBe("accepted");
      // A minor version after it: shown, never asked again.
      Object.assign(meta, {
        version: "2027-04-01",
        previousVersion: "2027-03-01",
        previousRequiresAcceptanceSince: "2027-03-01",
        announcedAt: "2027-04-01",
        effectiveFrom: "2027-04-01",
      });
      expect(acceptanceStatus("terms", row("2027-03-01"), current, after)).toBe(
        "updated",
      );
      expect(materialChange(meta)).toBe(false);
    } finally {
      Object.assign(meta, original);
    }
  });

  it(`every material change is announced at least ${MATERIAL_NOTICE_DAYS} days before it takes effect (terms §13, privacy §12)`, () => {
    for (const doc of Object.keys(LEGAL_DOCUMENTS) as LegalDocumentKey[]) {
      const m = LEGAL_DOCUMENTS[doc];
      expect(m.announcedAt, doc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.effectiveFrom, doc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(legalInstant(m.effectiveFrom), doc).toBeGreaterThanOrEqual(
        legalInstant(m.announcedAt),
      );
      if (materialChange(m))
        expect(
          legalInstant(m.effectiveFrom) - legalInstant(m.announcedAt),
          `${doc} ${m.version}`,
        ).toBeGreaterThanOrEqual(MATERIAL_NOTICE_DAYS * 864e5);
      // The first version has nothing to announce; later ones name their predecessor.
      if (m.previousVersion === null)
        expect(m.previousRequiresAcceptanceSince, doc).toBeNull();
      else
        expect(
          compareLegalVersions(m.previousVersion, m.version),
          doc,
        ).toBeLessThan(0);
      expect(
        compareLegalVersions(m.requiresAcceptanceSince, m.version),
        doc,
      ).toBeLessThanOrEqual(0);
    }
    // The rule itself: a material change announced 14 days ahead fails it.
    const tooSoon = {
      ...LEGAL_DOCUMENTS.terms,
      version: "2027-03-01",
      requiresAcceptanceSince: "2027-03-01",
      previousVersion: "2026-10-06",
      announcedAt: "2027-03-01",
      effectiveFrom: "2027-03-15",
    };
    expect(materialChange(tooSoon)).toBe(true);
    expect(
      legalInstant(tooSoon.effectiveFrom) - legalInstant(tooSoon.announcedAt),
    ).toBeLessThan(MATERIAL_NOTICE_DAYS * 864e5);
  });

  it("the billing consent is its own required evidence while published, hashed with the privacy version (UX-3)", () => {
    const published = legalConfig(valid);
    expect(() =>
      billingConsentEvidence({ billingConsent: undefined }, published),
    ).toThrow("legal_acceptance_required");
    expect(
      billingConsentEvidence(
        { billingConsent: LEGAL_DOCUMENTS.privacy.version },
        published,
      ),
    ).toEqual({
      document: "billing_consent",
      version: LEGAL_DOCUMENTS.privacy.version,
    });
    expect(billingConsentEvidence(undefined, legalConfig({}))).toBeNull();
    expect(legalContentHash("billing_consent")).toMatch(/^[a-f0-9]{64}$/);
    expect(legalContentHash("billing_consent")).not.toBe(
      legalContentHash("privacy"),
    );
    // The notice's consent paragraph describes that separate box.
    const datos = LEGAL_CONTENT.privacy.es.sections
      .find((x) => x.id === "datos")!
      .paragraphs.join(" ");
    expect(datos).toContain("casilla propia, distinta de la que confirma");
    expect(BILLING_CONSENT.es).toMatch(/^Consiento expresamente/);
    expect(BILLING_CONSENT.en).toMatch(/^I expressly consent/);
  });

  it("processor lists name every external provider the platform uses: Facturapi for CFDI, backup storage and runs (LEGAL-2, UX-5, DATA-2)", () => {
    const text = (doc: LegalDocumentKey, id: string, locale: "es" | "en") =>
      LEGAL_CONTENT[doc][locale].sections
        .find((x) => x.id === id)!
        .paragraphs.join(" ");
    for (const locale of ["es", "en"] as const)
      for (const [doc, id] of [
        ["dpa", "subencargados"],
        ["privacy", "encargados-transferencias"],
      ] as const)
        for (const provider of [
          "Google",
          "Stripe",
          "Neon",
          "Railway",
          "Cloudflare",
          "GitHub",
          "Facturapi",
        ])
          expect(text(doc, id, locale), `${doc} ${locale}`).toContain(provider);
    expect(text("dpa", "objeto", "es")).toContain("Receptores de CFDI");
    expect(text("dpa", "objeto", "es")).toContain(
      "certificado de sello digital",
    );
    expect(text("dpa", "transferencias", "es")).toContain(
      "instrucción del responsable",
    );
    expect(text("dpa", "terminacion", "es")).toContain("1,900 días");
    expect(text("privacy", "conservacion", "es")).toContain("1,900 días");
    expect(text("privacy", "conservacion", "es")).toContain(
      "artículo 49 del Código de Comercio",
    );
  });

  it("the privacy notice and the DPA cover the loyalty club: data categories, processors, no transfers (critic R40, LOYALTY-PRIVACY-4)", () => {
    const text = (doc: LegalDocumentKey, id: string, locale: "es" | "en") =>
      LEGAL_CONTENT[doc][locale].sections
        .find((x) => x.id === id)!
        .paragraphs.join(" ")
        .toLowerCase();
    for (const [locale, club, phone, history, noTransfer] of [
      [
        "es",
        "club de lealtad",
        "teléfono",
        "historial de compras",
        "no se transfieren",
      ],
      [
        "en",
        "loyalty club",
        "phone",
        "purchase history",
        "neither transferred",
      ],
    ] as const) {
      expect(text("dpa", "objeto", locale)).toContain(club);
      expect(text("dpa", "objeto", locale)).toContain(phone);
      expect(text("dpa", "objeto", locale)).toContain(history);
      expect(text("dpa", "subencargados", locale)).toContain(club);
      expect(text("dpa", "transferencias", locale)).toContain(club);
      expect(text("dpa", "transferencias", locale)).toContain(noTransfer);
      expect(text("privacy", "encargados-transferencias", locale)).toContain(
        club,
      );
      expect(text("privacy", "restaurantes", locale)).toContain(club);
      expect(text("privacy", "restaurantes", locale)).toContain(history);
    }
    for (const d of ["privacy", "dpa"] as const)
      expect(
        compareLegalVersions(LEGAL_DOCUMENTS[d].version, CLUB_LEGAL_VERSION),
        d,
      ).toBeGreaterThanOrEqual(0);
  });

  it("enabling the club waits for the published documents that cover it, in effect (LOYALTY-PRIVACY-4)", () => {
    // The club's version's own effect: the documents in force are a later version (the payments
    // one, P2V-GATE-2) that keeps the club's paragraphs.
    const effective = legalInstant(CLUB_LEGAL_EFFECTIVE_FROM);
    expect(clubLegalCovered("unpublished", effective + 1)).toBe(false);
    expect(clubLegalCovered("published", effective + 1)).toBe(true);
    expect(clubLegalCovered("published", effective - 1)).toBe(false);
    // A DPA older than the club's version never covers it.
    const meta = LEGAL_DOCUMENTS.dpa;
    const original = { ...meta };
    try {
      Object.assign(meta, {
        version: "2026-10-06",
        effectiveFrom: "2026-10-06",
      });
      expect(clubLegalCovered("published", effective + 864e5)).toBe(false);
      // A later version keeps covering it from the day it is announced.
      Object.assign(meta, {
        version: "2026-11-01",
        announcedAt: "2026-11-01",
        effectiveFrom: "2026-11-16",
      });
      expect(clubLegalCovered("published", legalInstant("2026-11-02"))).toBe(
        true,
      );
    } finally {
      Object.assign(meta, original);
    }
  });

  it("the processor lists name every provider server/cfdi/config.ts configures (account 031 phase 2: Facturapi)", () => {
    // Each external CFDI provider the worker can be configured for appears in config.ts as a
    // <PROVIDER>_API_KEY / _TEST_KEY / _BASE_URL variable. A new one is a material DPA change
    // (15 days' notice, docs/ACCOUNT_AND_LEGAL.md "How to publish a new version"): name it here
    // and in both processor lists before the code ships.
    const DISPLAY: Record<string, string> = { FACTURAPI: "Facturapi" };
    const source = readFileSync("server/cfdi/config.ts", "utf8");
    const configured = new Set(
      [
        ...source.matchAll(/"([A-Z][A-Z0-9]*)_(?:API_KEY|TEST_KEY|BASE_URL)"/g),
      ].map((m) => m[1]),
    );
    expect([...configured]).toContain("FACTURAPI");
    const text = (doc: LegalDocumentKey, id: string, locale: "es" | "en") =>
      LEGAL_CONTENT[doc][locale].sections
        .find((x) => x.id === id)!
        .paragraphs.join(" ");
    for (const variable of configured) {
      const name = DISPLAY[variable];
      expect(
        name,
        `CFDI provider ${variable} has no processor name`,
      ).toBeTruthy();
      for (const locale of ["es", "en"] as const)
        for (const [doc, id] of [
          ["dpa", "subencargados"],
          ["privacy", "encargados-transferencias"],
        ] as const)
          expect(text(doc, id, locale), `${doc} ${locale}`).toContain(name);
    }
    // The official endpoint belongs to the named provider.
    expect(new URL(FACTURAPI_BASE_URL).hostname).toMatch(
      /(^|\.)facturapi\.io$/,
    );
  });

  it("the terms describe support-assisted and recovery-code transfers and operator access (UX-6)", () => {
    const cuentas = (locale: "es" | "en") =>
      LEGAL_CONTENT.terms[locale].sections
        .find((x) => x.id === "cuentas")!
        .paragraphs.join(" ");
    expect(cuentas("es")).toContain("códigos de recuperación");
    expect(cuentas("es")).toContain("72 horas");
    expect(cuentas("es")).toContain("Acciones de soporte");
    expect(cuentas("en")).toContain("recovery codes");
    expect(cuentas("en")).toContain("72 hours");
  });

  it("orders versions with numeric suffixes", () => {
    expect(compareLegalVersions("2026-10-05", "2026-10-05.1")).toBeLessThan(0);
    expect(
      compareLegalVersions("2026-10-05.10", "2026-10-05.2"),
    ).toBeGreaterThan(0);
    expect(compareLegalVersions("2026-11-01", "2026-10-30.9")).toBeGreaterThan(
      0,
    );
    expect(compareLegalVersions("2026-10-05", "2026-10-05")).toBe(0);
  });

  it("every document has identical es/en section ids and no empty text", () => {
    for (const doc of Object.keys(LEGAL_CONTENT) as LegalDocumentKey[]) {
      const { es, en } = LEGAL_CONTENT[doc];
      expect(
        en.sections.map((s) => s.id),
        doc,
      ).toEqual(es.sections.map((s) => s.id));
      for (const s of [...es.sections, ...en.sections]) {
        expect(s.title.trim(), `${doc}#${s.id}`).not.toBe("");
        expect(s.paragraphs.length, `${doc}#${s.id}`).toBeGreaterThan(0);
      }
      expect(LEGAL_DOCUMENTS[doc].version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(LEGAL_CONTENT.terms.es.sections.map((s) => s.id)).toContain(
      "ley-jurisdiccion",
    );
    expect(LEGAL_CONTENT.dpa.es.sections.map((s) => s.id)).toEqual([
      "partes",
      "objeto",
      "instrucciones",
      "confidencialidad",
      "seguridad",
      "subencargados",
      "vulneraciones",
      "arco",
      "terminacion",
      "auditoria",
      "transferencias",
    ]);
  });

  it("privacy notice contains Art. 15 sections responsable, datos, finalidades, limitar, arco, cambios", () => {
    const ids = LEGAL_CONTENT.privacy.es.sections.map((s) => s.id);
    for (const id of [
      "simplificado",
      "responsable",
      "datos",
      "finalidades",
      "limitar",
      "encargados-transferencias",
      "restaurantes",
      "arco",
      "revocacion",
      "cookies",
      "conservacion",
      "seguridad",
      "cambios",
      "autoridad",
    ])
      expect(ids).toContain(id);
    const responsable = LEGAL_CONTENT.privacy.es.sections.find(
      (s) => s.id === "responsable",
    )!;
    expect(responsable.paragraphs.join(" ")).toContain("{{entity.address}}");
  });

  it("simplified notice contains entity name and domicilio, the data and no-sensitive-data clause, purposes, limiting option and integral link (Art. 16-II with Art. 15 I-IV; LEGAL-1)", () => {
    const entity = legalConfig(valid).entity!;
    const es = legalText(PRIVACY_SIMPLIFIED.es, entity, "es");
    expect(es).toContain(valid.LEGAL_ENTITY_NAME);
    expect(es).toContain(`con domicilio en ${valid.LEGAL_ENTITY_ADDRESS}`);
    expect(es).toContain("identificador que te asigna Google");
    expect(es).toContain("no recabamos datos personales sensibles");
    const en = legalText(PRIVACY_SIMPLIFIED.en, entity, "en");
    expect(en).toContain(`with its address at ${valid.LEGAL_ENTITY_ADDRESS}`);
    expect(en).toContain("we collect no sensitive personal data");
    expect(es).toContain("crear y proteger tu cuenta");
    expect(es).toContain("No los usamos para publicidad");
    expect(es).toContain("limitar su uso");
    expect(es).toContain(valid.LEGAL_PRIVACY_CONTACT_EMAIL);
    expect(es).toContain("/legal/privacidad");
    expect(legalText(PRIVACY_SIMPLIFIED.en, entity, "en")).toContain(
      "/legal/privacy",
    );
  });

  it("renderLegalText marks missing tokens", () => {
    const template =
      "{{entity.name}} en {{entity.address}} (RFC {{entity.rfc}}).";
    expect(legalSegments(template, null, "es")).toEqual([
      { missing: "name" },
      { text: " en " },
      { missing: "address" },
      { text: " (RFC " },
      { missing: "rfc" },
      { text: ")." },
    ]);
    const entity = legalConfig(valid).entity!;
    const segments = legalSegments(template, entity, "es");
    expect(segments[0]).toEqual({ text: valid.LEGAL_ENTITY_NAME });
    expect(segments[4]).toEqual({ missing: "rfc" });
    expect(legalText("{{entity.privacyContactName}}", entity, "en")).toBe(
      "Personal data department",
    );
  });

  it("the terms, the privacy notice and the DPA cover integrated card payments: Mercado Pago and Clip, card brand/type/last 4, credential custody, the transmission on the restaurant's instructions (critic R40, P2-SECURITY-2)", () => {
    const text = (doc: LegalDocumentKey, id: string, locale: "es" | "en") =>
      LEGAL_CONTENT[doc][locale].sections
        .find((x) => x.id === id)!
        .paragraphs.join(" ")
        .toLowerCase();
    for (const [locale, last4, custody, noProcess] of [
      [
        "es",
        "últimos 4 dígitos",
        "guarda cifradas",
        "no es un procesador de pagos",
      ],
      [
        "en",
        "last 4 digits",
        "keeps them encrypted",
        "is not a payment processor",
      ],
    ] as const) {
      for (const provider of ["mercado pago", "clip"]) {
        expect(text("terms", "pagos-terminal", locale)).toContain(provider);
        expect(text("dpa", "objeto", locale)).toContain(provider);
        expect(text("dpa", "transferencias", locale)).toContain(provider);
        expect(text("privacy", "restaurantes", locale)).toContain(provider);
      }
      expect(text("terms", "pagos-terminal", locale)).toContain(noProcess);
      expect(text("dpa", "objeto", locale)).toContain(last4);
      expect(text("dpa", "objeto", locale)).toContain(custody);
      expect(text("privacy", "restaurantes", locale)).toContain(last4);
      // Never the full number: the text says so (the adapters discard it).
      expect(text("dpa", "objeto", locale)).toMatch(
        locale === "es" ? /número completo/ : /full number/,
      );
    }
    // The old clause («staff only record ...») is gone: it is false with integrated charging.
    expect(text("terms", "pagos-terminal", "es")).not.toContain(
      "no procesa los pagos de tus comensales",
    );
  });

  it("every published version's text is pinned: a text change without a new version fails (LEGAL-8, Código de Comercio Art. 49)", () => {
    // Add a line here when a new version ships; never edit an existing one.
    const PUBLISHED: Record<
      "privacy" | "terms" | "dpa" | "billing_consent",
      Record<string, string>
    > = {
      privacy: {
        "2026-10-06":
          "30c412cea63b811aca906f95f7f7964b6ba69580e4d6a14e2d07d5caeac27e85",
        "2026-10-09":
          "1c37179a8ff9afd8f94966ecfdab0ec4b155075f169175f77bdef79911a960be",
        "2026-10-10":
          "3bd07765ed2c90e3852d6e9e92ab1f7d83dab005089f243e8fc006b9d18fe056",
        "2026-10-11":
          "a3e2d7b02ec5c5e73a9813179268760731dca59f5ee2cc6bea4c45d833c43364",
      },
      terms: {
        "2026-10-06":
          "419e6f331b875a5e68eee218d1307d92757fc471eb8f214f445dcce3e2ab3bcd",
        "2026-10-10":
          "7ff6ac52f5582ea2e83f48b43e5f9dc33ad7caeb30eab7351802065110fc669a",
      },
      dpa: {
        "2026-10-06":
          "e27b6ca16653d26a9a31627f7837a96e5c341a4ddf75daa78efc322dc4cc23bb",
        "2026-10-09":
          "06879bab89b58dbe2111c757ca0e22d29044ba2e8b5bd079205acb0962ecb999",
        "2026-10-10":
          "661b53ef49689fbdb606180b0ca401ecacf5aefead19a690af8462db60bde99e",
        "2026-10-11":
          "75954771549e4868e3613b39fe21040ec8581dee92fdd8a9cae2d491a780526e",
      },
      billing_consent: {
        "2026-10-06":
          "f8d6b72d4a9f528126e3e292bc06d88e41e8ceed87289da561e14cd8e6cba90f",
        "2026-10-09":
          "d13021aecb6b7a425b0fa80bd161b74707c090979fbe239c9c4cc456e2a3e68e",
        "2026-10-10":
          "e14afa1e67538213a45810489a62553a14e0f30fb9f1f962c66ec5122027e364",
        "2026-10-11":
          "4a45d035598bab58f36b1c864cebd39a3d4141830a97e735efc67c55d0698c40",
      },
    };
    for (const doc of Object.keys(PUBLISHED) as Array<keyof typeof PUBLISHED>) {
      const version =
        LEGAL_DOCUMENTS[doc === "billing_consent" ? "privacy" : doc].version;
      expect(
        PUBLISHED[doc][version],
        `${doc} ${version}: changed text needs a new version (and a line here)`,
      ).toBe(legalContentHash(doc));
    }
    // The versions PR #12 shipped to production (LD-83): their lines above are exactly the
    // release's, and a later text never reuses their ids (P2V-GATE-2). The payments text is
    // 2026-10-10, a later version that keeps the club's paragraphs (CLUB_LEGAL_VERSION).
    expect(PUBLISHED.privacy["2026-10-09"]).toBe(
      "1c37179a8ff9afd8f94966ecfdab0ec4b155075f169175f77bdef79911a960be",
    );
    expect(PUBLISHED.dpa["2026-10-09"]).toBe(
      "06879bab89b58dbe2111c757ca0e22d29044ba2e8b5bd079205acb0962ecb999",
    );
    // PR #13 shipped 2026-10-10 to production (LD-95): its lines above are exactly the release's,
    // and the kiosk text (KIOSK-OPS-2) is 2026-10-11, a later version of the privacy notice and the
    // DPA that keeps the club's and the payments' paragraphs; the terms stay at 2026-10-10.
    expect(PUBLISHED.privacy["2026-10-10"]).toBe(
      "3bd07765ed2c90e3852d6e9e92ab1f7d83dab005089f243e8fc006b9d18fe056",
    );
    expect(PUBLISHED.dpa["2026-10-10"]).toBe(
      "661b53ef49689fbdb606180b0ca401ecacf5aefead19a690af8462db60bde99e",
    );
    expect(PUBLISHED.terms["2026-10-10"]).toBe(
      "7ff6ac52f5582ea2e83f48b43e5f9dc33ad7caeb30eab7351802065110fc669a",
    );
    expect(PUBLISHED.billing_consent["2026-10-10"]).toBe(
      "e14afa1e67538213a45810489a62553a14e0f30fb9f1f962c66ec5122027e364",
    );
    for (const doc of ["privacy", "dpa"] as const) {
      expect(LEGAL_DOCUMENTS[doc].version).not.toBe(CLUB_LEGAL_VERSION);
      expect(LEGAL_DOCUMENTS[doc].version).not.toBe("2026-10-10");
      expect(LEGAL_DOCUMENTS[doc].previousVersion).toBe("2026-10-10");
      expect(materialChange(LEGAL_DOCUMENTS[doc]), doc).toBe(false);
    }
    expect(LEGAL_DOCUMENTS.terms.version).toBe("2026-10-10");
    expect(LEGAL_DOCUMENTS.terms.previousVersion).toBe("2026-10-06");
  });

  it("the privacy notice and the DPA cover the kiosk: the gm_kiosk cookie, the tablet's data, Cloudflare's menu photos (critic R40, KIOSK-OPS-2)", () => {
    const text = (doc: LegalDocumentKey, id: string, locale: "es" | "en") =>
      LEGAL_CONTENT[doc][locale].sections
        .find((x) => x.id === id)!
        .paragraphs.join(" ");
    for (const [locale, photos, days] of [
      ["es", "fotos del menú", "400 días"],
      ["en", "menu photo", "400 days"],
    ] as const) {
      // The cookie list presents itself as complete: every cookie the server sets is in it.
      for (const cookie of [
        "gm_session",
        "gm_device",
        "gm_account",
        "gm_owner_browser",
        "gm_google_flow",
        KIOSK_COOKIE,
      ])
        expect(text("privacy", "cookies", locale), locale).toContain(cookie);
      expect(text("privacy", "cookies", locale)).toContain(days);
      expect(text("dpa", "objeto", locale)).toContain(KIOSK_COOKIE);
      expect(text("dpa", "objeto", locale)).toContain(days);
      for (const [doc, id] of [
        ["privacy", "encargados-transferencias"],
        ["dpa", "subencargados"],
      ] as const)
        expect(text(doc, id, locale), `${doc} ${locale}`).toMatch(
          new RegExp(`Cloudflare \\([^)]*${photos}[^)]*\\)`),
        );
    }
    // 400 days is the cookie's real lifetime.
    expect(KIOSK_COOKIE_MAX_AGE_SECONDS).toBe(400 * 86_400);
  });

  it("legalContentHash is stable and changes with content", () => {
    const first = legalContentHash("privacy");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(legalContentHash("privacy")).toBe(first);
    expect(legalContentHash("terms")).not.toBe(first);
    expect(legalContentHash("dpa")).not.toBe(legalContentHash("terms"));
  });
});
