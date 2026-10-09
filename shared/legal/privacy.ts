import type { LegalDocumentContent } from "../legal.js";

/**
 * Platform privacy notice (aviso de privacidad integral), LFPDPPP published in
 * the DOF on 20 March 2025. DRAFT pending review by Mexican counsel (account
 * decision D2); it is in force only once the legal entity is configured and the
 * status is "published". Section ids are fixed: tests/legal.test.ts asserts
 * them in both languages, and pages link to them (#restaurantes, #arco).
 * Spanish governs.
 */

/**
 * Simplified notice shown where data is collected (Art. 16-II: Art. 15 I-IV
 * plus where to read the integral notice): the responsable's identity and
 * domicilio (I), the data and that no sensitive data is collected (II), the
 * purposes (III) and how to limit use (IV). The one source for every screen
 * that shows it (rendered with legalText; LEGAL-1).
 */
export const PRIVACY_SIMPLIFIED = {
  es: "{{entity.name}}, con domicilio en {{entity.address}}, es responsable de tus datos personales. Tratamos tu nombre, tu correo y el identificador que te asigna Google, y datos técnicos de sesión (cookies, dispositivos vinculados y direcciones IP); no recabamos datos personales sensibles. Los usamos para crear y proteger tu cuenta, prestarte el servicio, facturar tu suscripción y darte soporte. No los usamos para publicidad. Para limitar su uso o ejercer tus derechos ARCO escribe a {{entity.privacyContactEmail}}. Consulta el aviso de privacidad integral en /legal/privacidad.",
  en: "{{entity.name}}, with its address at {{entity.address}}, is the controller of your personal data. We process your name, your email and the identifier Google assigns you, and technical session data (cookies, paired devices and IP addresses); we collect no sensitive personal data. We use them to create and protect your account, provide the service, bill your subscription and support you. We do not use them for advertising. To limit their use or exercise your ARCO rights, write to {{entity.privacyContactEmail}}. Read the full privacy notice at /legal/privacy.",
} as const;

/**
 * The express consent §2 describes (LFPDPPP Art. 7; UX-3, LEGAL-7): its own
 * checkbox wherever a person becomes a primary owner (signup, transfer),
 * recorded as its own evidence row (document "billing_consent", versioned with
 * this notice). Never folded into "Leí el Aviso de privacidad".
 */
export const BILLING_CONSENT = {
  es: "Consiento expresamente el tratamiento de mis datos financieros y patrimoniales para facturar la suscripción de mi restaurante, como explica el Aviso de privacidad.",
  en: "I expressly consent to the processing of my financial and property data to bill my restaurant's subscription, as the Privacy notice explains.",
} as const;

export const privacyContent: LegalDocumentContent = {
  es: {
    title: "Aviso de privacidad",
    sections: [
      {
        id: "simplificado",
        title: "Aviso de privacidad simplificado",
        paragraphs: [PRIVACY_SIMPLIFIED.es],
      },
      {
        id: "responsable",
        title: "1. Responsable",
        paragraphs: [
          "{{entity.name}}, con domicilio en {{entity.address}}, es responsable del tratamiento de los datos personales que recabamos a través de Green Monkey (artículo 15, fracción I, de la Ley Federal de Protección de Datos Personales en Posesión de los Particulares).",
          "RFC: {{entity.rfc}}.",
          "Nuestro {{entity.privacyContactName}} atiende las solicitudes relacionadas con tus datos personales en {{entity.privacyContactEmail}}.",
        ],
      },
      {
        id: "datos",
        title: "2. Datos que tratamos",
        paragraphs: [
          "Datos de identificación y contacto de propietarios y miembros invitados: nombre, correo electrónico y el identificador que te asigna Google al iniciar sesión.",
          "Datos de sesión y seguridad: cookies técnicas, dispositivos vinculados, identificadores de solicitud y direcciones IP que usamos solo de forma transitoria para limitar intentos y prevenir abusos.",
          "Datos de facturación de la suscripción: Stripe procesa los datos de tarjeta; Green Monkey no almacena números de tarjeta. De forma opcional, los datos fiscales que captures para la factura de tu suscripción (RFC, razón social, régimen fiscal y código postal).",
          "Datos fiscales de tu restaurante que captures (RFC, nombre o razón social, régimen fiscal y código postal) y, si activas la facturación electrónica, su certificado de sello digital (CSD): lo recibimos en un sobre cifrado, lo entregamos a Facturapi para timbrar tus CFDI y borramos nuestra copia.",
          "Las comunicaciones que tengas con soporte.",
          "No solicitamos datos personales sensibles (artículo 15, fracción II).",
          "Los datos financieros o patrimoniales relacionados con la facturación de tu suscripción se tratan con tu consentimiento expreso (artículo 7), que otorgas con una casilla propia, distinta de la que confirma que leíste este aviso, al crear tu restaurante o al aceptar la titularidad de una organización. Guardamos la versión y la fecha de ese consentimiento, y puedes revocarlo como indica la sección 8.",
        ],
      },
      {
        id: "finalidades",
        title: "3. Finalidades",
        paragraphs: [
          "Finalidades primarias, necesarias para la relación contigo: crear y proteger tu cuenta, prestarte el servicio, facturar tu suscripción, darte soporte, mantener la seguridad y prevenir fraudes, y cumplir obligaciones legales.",
          "Finalidades secundarias: ninguna. No usamos tus datos para mercadotecnia ni publicidad. Si en el futuro quisiéramos usarlos para una finalidad distinta, te pediremos un nuevo consentimiento (artículo 11) (artículo 15, fracción III).",
        ],
      },
      {
        id: "limitar",
        title: "4. Cómo limitar el uso o la divulgación de tus datos",
        paragraphs: [
          "Puedes pedirnos limitar el uso o la divulgación de tus datos escribiendo a {{entity.privacyContactEmail}}, y ajustar desde tu cuenta quién tiene acceso a tus restaurantes. No mantenemos listas de mercadotecnia, por lo que no hay listas de exclusión que consultar (artículo 15, fracción IV).",
        ],
      },
      {
        id: "encargados-transferencias",
        title: "5. Encargados y transferencias",
        paragraphs: [
          "Para prestar el servicio usamos proveedores que tratan datos por nuestra cuenta como personas encargadas, sin que ello sea una transferencia: Google (inicio de sesión), Stripe (pagos de la suscripción), Neon (base de datos), Railway (hospedaje), Cloudflare (almacenamiento cifrado de los respaldos), GitHub (ejecución automatizada de los respaldos) y, solo cuando un restaurante activa la facturación electrónica, Facturapi (timbrado de CFDI a través de un proveedor autorizado de certificación y envío del CFDI por correo). Algunos pueden ubicarse fuera de México.",
          "Solo transferimos datos en los supuestos del artículo 36, como una orden de autoridad competente o un requerimiento legal; esas transferencias no requieren tu consentimiento (artículos 35 y 36).",
          "Los datos de los socios del club de lealtad de un restaurante se guardan con los mismos proveedores de base de datos, hospedaje y respaldos (Neon, Railway, Cloudflare y GitHub); el club no agrega proveedores ni transferencias.",
        ],
      },
      {
        id: "restaurantes",
        title: "6. Datos de comensales y empleados de los restaurantes",
        paragraphs: [
          "Cuando un restaurante registra en Green Monkey datos de sus empleados o comensales, el restaurante es el responsable de esos datos y Green Monkey actúa como persona encargada conforme al contrato de encargo de datos (artículo 2, fracción XII).",
          "Esto incluye los datos fiscales que un comensal captura para pedir su factura (RFC, nombre o razón social, régimen fiscal, código postal y correo), que Green Monkey envía a Facturapi para timbrar y entregar el CFDI por cuenta del restaurante.",
          "También incluye a los socios del club de lealtad de un restaurante, cuando el restaurante lo activa: nombre o apodo, teléfono, historial de compras en el club y el registro de su consentimiento. El aviso de privacidad del restaurante informa el club. Green Monkey solo lleva los sellos y premios por cuenta del restaurante, no envía mensajes a los socios ni transfiere sus datos, y borra el nombre y el teléfono cuando el restaurante lo pide o tras 24 meses sin actividad.",
          "Si eres comensal o empleado, dirige tus solicitudes de derechos ARCO al restaurante. Si recibimos una, la reenviaremos al restaurante correspondiente.",
        ],
      },
      {
        id: "arco",
        title: "7. Derechos ARCO",
        paragraphs: [
          "Puedes acceder a tus datos, rectificarlos, cancelarlos u oponerte a su tratamiento enviando una solicitud a {{entity.privacyContactEmail}} con los requisitos del artículo 28: tu nombre y un medio para comunicarte contigo, los documentos que acrediten tu identidad o la de tu representante, la descripción clara de los datos y del derecho que quieres ejercer, y cualquier elemento que facilite localizarlos.",
          "Te responderemos en un máximo de 20 días hábiles y, si procede, haremos efectiva la respuesta dentro de los 15 días hábiles siguientes (artículo 31). El trámite es gratuito (artículo 34).",
        ],
      },
      {
        id: "revocacion",
        title: "8. Revocación del consentimiento",
        paragraphs: [
          "Puedes revocar tu consentimiento por el mismo medio. La revocación no tiene efectos retroactivos (artículo 7) y puede impedir que sigamos prestándote el servicio.",
        ],
      },
      {
        id: "cookies",
        title: "9. Cookies y almacenamiento local",
        paragraphs: [
          "Usamos solo cookies técnicas necesarias para el funcionamiento y la seguridad: gm_session, gm_device, gm_account, gm_owner_browser y gm_google_flow. El punto de venta guarda en el navegador (localStorage e IndexedDB) las ventas sin conexión y tus preferencias.",
          "No usamos herramientas de analítica ni publicidad de terceros.",
        ],
      },
      {
        id: "conservacion",
        title: "10. Conservación",
        paragraphs: [
          "Conservamos tus datos mientras tu cuenta esté activa. Después los bloqueamos: solo los conservamos para atender las responsabilidades derivadas de nuestra relación y, al terminar el plazo legal aplicable, los suprimimos o anonimizamos (artículos 2, fracción III, y 10). Los registros fiscales se conservan 5 años (artículo 30 del Código Fiscal de la Federación) y la evidencia de tu aceptación de estos documentos, 10 años (artículo 49 del Código de Comercio), ligada solo al identificador de tu cuenta.",
          "Los respaldos cifrados de la base de datos (diarios, guardados 35 días, y mensuales, guardados hasta 1,900 días) también contienen esos datos. Su acceso está restringido, se tratan como datos bloqueados, solo se usan para recuperar el servicio ante un desastre y se eliminan al cumplir su plazo. Si alguna vez restauramos uno, volvemos a aplicar las cancelaciones atendidas después de su fecha.",
        ],
      },
      {
        id: "seguridad",
        title: "11. Seguridad",
        paragraphs: [
          "Aplicamos medidas administrativas, técnicas y físicas para proteger tus datos (artículo 18): cifrado en tránsito, separación de datos por restaurante en la base de datos, credenciales con privilegios mínimos, PIN con límites de intentos y registros de auditoría.",
          "Si ocurre una vulneración que afecte de forma significativa tus derechos, te lo informaremos de inmediato (artículo 19).",
        ],
      },
      {
        id: "cambios",
        title: "12. Cambios a este aviso",
        paragraphs: [
          "Te avisaremos dentro de la aplicación de cada nueva versión de este aviso, con su fecha de entrada en vigor. Los cambios materiales se anuncian al menos 15 días antes de entrar en vigor y, desde esa fecha, te pediremos aceptarlos para seguir administrando tu cuenta; tu restaurante sigue operando mientras tanto. Los cambios menores y la actualización de los datos del responsable se te muestran en la aplicación sin pedirte una nueva aceptación (artículo 15, fracción VI).",
        ],
      },
      {
        id: "autoridad",
        title: "13. Autoridad",
        paragraphs: [
          "Si consideras que tu derecho a la protección de datos personales fue vulnerado, puedes acudir a la Secretaría Anticorrupción y Buen Gobierno (artículo 2, fracción XV, y artículos 40 y siguientes).",
        ],
      },
    ],
  },
  en: {
    title: "Privacy notice",
    sections: [
      {
        id: "simplificado",
        title: "Simplified privacy notice",
        paragraphs: [PRIVACY_SIMPLIFIED.en],
      },
      {
        id: "responsable",
        title: "1. Data controller",
        paragraphs: [
          "{{entity.name}}, with its address at {{entity.address}}, is the controller of the personal data we collect through Green Monkey (Federal Law on the Protection of Personal Data Held by Private Parties, article 15, section I).",
          "RFC (tax ID): {{entity.rfc}}.",
          "Our {{entity.privacyContactName}} handles requests about your personal data at {{entity.privacyContactEmail}}.",
        ],
      },
      {
        id: "datos",
        title: "2. Data we process",
        paragraphs: [
          "Identification and contact data of owners and invited members: name, email address and the identifier Google assigns you when you sign in.",
          "Session and security data: technical cookies, paired devices, request identifiers and IP addresses that we use only transiently to limit attempts and prevent abuse.",
          "Subscription billing data: Stripe processes card data; Green Monkey stores no card numbers. Optionally, the tax details you enter for your subscription invoice (RFC, legal name, tax regime and postal code).",
          "Your restaurant's tax details that you enter (RFC, name or legal name, tax regime and postal code) and, if you enable electronic invoicing, its digital seal certificate (CSD): we receive it in an encrypted envelope, hand it to Facturapi to stamp your CFDI and delete our copy.",
          "Your communications with support.",
          "We do not request sensitive personal data (article 15, section II).",
          "Financial or property data related to billing your subscription are processed with your express consent (article 7), which you give with a checkbox of its own, separate from the one confirming you read this notice, when you create your restaurant or accept the ownership of an organization. We keep the version and date of that consent, and you can withdraw it as section 8 explains.",
        ],
      },
      {
        id: "finalidades",
        title: "3. Purposes",
        paragraphs: [
          "Primary purposes, necessary for our relationship with you: create and protect your account, provide the service, bill your subscription, support you, keep the service secure and prevent fraud, and comply with legal obligations.",
          "Secondary purposes: none. We do not use your data for marketing or advertising. If we ever wanted to use it for another purpose, we would ask for your consent again (article 11) (article 15, section III).",
        ],
      },
      {
        id: "limitar",
        title: "4. How to limit the use or disclosure of your data",
        paragraphs: [
          "You can ask us to limit the use or disclosure of your data by writing to {{entity.privacyContactEmail}}, and you can manage from your account who has access to your restaurants. We keep no marketing lists, so there are no opt-out lists to check (article 15, section IV).",
        ],
      },
      {
        id: "encargados-transferencias",
        title: "5. Processors and transfers",
        paragraphs: [
          "To provide the service we use providers that process data on our behalf as processors, which is not a transfer: Google (sign-in), Stripe (subscription payments), Neon (database), Railway (hosting), Cloudflare (encrypted backup storage), GitHub (automated backup runs) and, only when a restaurant enables electronic invoicing, Facturapi (CFDI stamping through an authorized certification provider and CFDI delivery by email). Some may be located outside Mexico.",
          "We transfer data only in the cases of article 36, such as an order from a competent authority or a legal requirement; those transfers do not require your consent (articles 35 and 36).",
          "A restaurant's loyalty club members' data is kept with the same database, hosting and backup providers (Neon, Railway, Cloudflare and GitHub); the club adds no providers and no transfers.",
        ],
      },
      {
        id: "restaurantes",
        title: "6. Data of restaurant guests and employees",
        paragraphs: [
          "When a restaurant records data about its employees or guests in Green Monkey, the restaurant is the controller of that data and Green Monkey acts as a processor under the data processing agreement (article 2, section XII).",
          "This includes the tax details a guest enters to request an invoice (RFC, name or legal name, tax regime, postal code and email), which Green Monkey sends to Facturapi to stamp and deliver the CFDI on the restaurant's behalf.",
          "It also includes a restaurant's loyalty club members, when the restaurant enables the club: name or nickname, phone, purchase history in the club and the record of their consent. The restaurant's privacy notice covers the club. Green Monkey only keeps the stamps and rewards on the restaurant's behalf, sends members no messages, does not transfer their data, and erases the name and phone when the restaurant asks or after 24 months without activity.",
          "If you are a guest or an employee, send your ARCO requests to the restaurant. If we receive one, we will forward it to the restaurant concerned.",
        ],
      },
      {
        id: "arco",
        title: "7. ARCO rights",
        paragraphs: [
          "You can access, rectify or cancel your data, or object to its processing, by sending a request to {{entity.privacyContactEmail}} with the contents of article 28: your name and a way to reach you, documents proving your identity or your representative's, a clear description of the data and the right you want to exercise, and anything that helps locate the data.",
          "We will answer within 20 business days and, where applicable, make the answer effective within the following 15 business days (article 31). The process is free of charge (article 34).",
        ],
      },
      {
        id: "revocacion",
        title: "8. Withdrawing consent",
        paragraphs: [
          "You can withdraw your consent through the same channel. Withdrawal has no retroactive effect (article 7) and may prevent us from continuing to provide the service.",
        ],
      },
      {
        id: "cookies",
        title: "9. Cookies and local storage",
        paragraphs: [
          "We use only technical cookies needed for operation and security: gm_session, gm_device, gm_account, gm_owner_browser and gm_google_flow. The point of sale stores offline sales and your preferences in the browser (localStorage and IndexedDB).",
          "We use no third-party analytics or advertising tools.",
        ],
      },
      {
        id: "conservacion",
        title: "10. Retention",
        paragraphs: [
          "We keep your data while your account is active. Afterwards we block it: we keep it only to answer for responsibilities arising from our relationship and, once the applicable legal period ends, we delete or anonymize it (articles 2, section III, and 10). Tax records are kept for 5 years (Federal Tax Code, article 30) and the evidence of your acceptance of these documents for 10 years (Commercial Code, article 49), tied only to your account identifier.",
          "Encrypted database backups (daily ones kept 35 days, monthly ones kept up to 1,900 days) also contain that data. Access to them is restricted, they are treated as blocked data, they are used only to recover the service after a disaster, and they are deleted when their period ends. If we ever restore one, we re-apply the cancellations handled after its date.",
        ],
      },
      {
        id: "seguridad",
        title: "11. Security",
        paragraphs: [
          "We apply administrative, technical and physical measures to protect your data (article 18): encryption in transit, per-restaurant data separation in the database, least-privilege credentials, PINs with attempt limits, and audit logs.",
          "If a breach significantly affects your rights, we will inform you immediately (article 19).",
        ],
      },
      {
        id: "cambios",
        title: "12. Changes to this notice",
        paragraphs: [
          "We will notify you inside the app of every new version of this notice, with the date it takes effect. Material changes are announced at least 15 days before they take effect and, from that date, we will ask you to accept them to keep managing your account; your restaurant keeps operating meanwhile. Minor changes and updates to the controller's details are shown in the app without asking you to accept again (article 15, section VI).",
        ],
      },
      {
        id: "autoridad",
        title: "13. Authority",
        paragraphs: [
          "If you believe your right to personal data protection was violated, you can turn to the Ministry of Anti-Corruption and Good Government (Secretaría Anticorrupción y Buen Gobierno; article 2, section XV, and articles 40 onwards).",
        ],
      },
    ],
  },
};
