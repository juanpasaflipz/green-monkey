/**
 * The fictional-but-plausible legal and support values CI publishes (account
 * §2.2, LD-3). One canonical copy: tests/fixtures/legal-ci.ts re-exports it;
 * tests/fixtures/legal-ci.sh, the commented lines of .env.example and the
 * browser and account-http steps of .github/workflows/qualification.yml carry
 * the same literals (tests/legal-fixtures.test.ts keeps them equal). They are
 * FICTIONAL test values: in production (APP_ENV=production or Railway's
 * production environment) legalConfig refuses each of them like a placeholder,
 * so a copied block can never publish a fictional data controller (ACC-18).
 */
export const LEGAL_CI_ENV = {
  LEGAL_ENTITY_NAME: "Nopal Verde Software S.A. de C.V.",
  LEGAL_ENTITY_ADDRESS:
    "Calle Jacaranda 120, Col. Centro, 06000 Ciudad de México, CDMX",
  LEGAL_PRIVACY_CONTACT_EMAIL: "privacidad@nopalverde.mx",
  LEGAL_JURISDICTION: "Ciudad de México",
  SUPPORT_EMAIL: "soporte@nopalverde.mx",
  SUPPORT_PHONE: "+525512345678",
  SUPPORT_HOURS: "Lun–Sáb 9:00–21:00 (hora del centro)",
} as const;
