import { afterEach, describe, expect, it } from "vitest";
import {
  legalConfig,
  legalContentHash,
  logLegalStartup,
  signupOpen,
} from "../server/legal";
import { setLogSink } from "../server/logging";
import {
  LEGAL_CONTENT,
  LEGAL_DOCUMENTS,
  PRIVACY_SIMPLIFIED,
  acceptancePending,
  compareLegalVersions,
  legalSegments,
  legalText,
  pendingDocuments,
  type LegalDocumentKey,
} from "../shared/legal";
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

  it("pendingDocuments: missing, older than requiresAcceptanceSince, entity change, unpublished acceptance after publish", () => {
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
    ).toEqual(["privacy"]);
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

  it("simplified notice contains entity name, purposes, limiting option and integral link (Art. 16-II)", () => {
    const entity = legalConfig(valid).entity!;
    const es = legalText(PRIVACY_SIMPLIFIED.es, entity, "es");
    expect(es).toContain(valid.LEGAL_ENTITY_NAME);
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

  it("legalContentHash is stable and changes with content", () => {
    const first = legalContentHash("privacy");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(legalContentHash("privacy")).toBe(first);
    expect(legalContentHash("terms")).not.toBe(first);
    expect(legalContentHash("dpa")).not.toBe(legalContentHash("terms"));
  });
});
