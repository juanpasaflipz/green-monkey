/**
 * The fictional-but-plausible legal and support values CI uses (account §2.2,
 * LD-3). One canonical copy: .github/workflows/qualification.yml sets the same
 * literals on the browser and account-http steps, and tests/legal.test.ts
 * proves the production-mode detector publishes them. They are FICTIONAL test
 * values: never copy them to Railway or any deployed environment.
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
