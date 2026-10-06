import type { LegalDocumentContent } from "../legal.js";

/**
 * Data-processing agreement ("contrato de encargo de datos") between the
 * restaurant's organization (responsable) and Green Monkey (persona
 * encargada). Accepted by the primary owner per organization. DRAFT pending
 * review by Mexican counsel (account decision D2). Section ids are fixed
 * (tests/legal.test.ts). Spanish governs.
 */
export const dpaContent: LegalDocumentContent = {
  es: {
    title: "Contrato de encargo de datos",
    sections: [
      {
        id: "partes",
        title: "1. Partes",
        paragraphs: [
          "La organización titular del restaurante, representada por su persona titular que acepta este contrato, actúa como responsable de los datos personales de sus empleados y comensales.",
          "{{entity.name}}, con domicilio en {{entity.address}}, actúa como persona encargada que trata esos datos por cuenta del responsable para prestar el servicio Green Monkey (Ley Federal de Protección de Datos Personales en Posesión de los Particulares, artículo 2, fracción XII).",
        ],
      },
      {
        id: "objeto",
        title: "2. Objeto y categorías de datos",
        paragraphs: [
          "Empleados: nombre, usuario, rol, PIN cifrado, turnos y tarifa por hora. La tarifa por hora es un dato financiero o patrimonial: el restaurante debe obtener el consentimiento expreso de sus empleados (artículo 7).",
          "Comensales: nombre o alias en las órdenes y notas de las órdenes. Una nota de alergia vinculada a un nombre es un dato sensible (artículos 2, fracción VI, y 8); recomendamos usar alias.",
        ],
      },
      {
        id: "instrucciones",
        title: "3. Instrucciones",
        paragraphs: [
          "Green Monkey trata los datos únicamente para prestar el servicio conforme a las instrucciones del responsable expresadas en la configuración de la aplicación, y no los usa para fines propios.",
        ],
      },
      {
        id: "confidencialidad",
        title: "4. Confidencialidad",
        paragraphs: [
          "Green Monkey guarda confidencialidad sobre los datos y la exige a las personas que los tratan, incluso después de terminada la relación (artículo 20).",
        ],
      },
      {
        id: "seguridad",
        title: "5. Seguridad",
        paragraphs: [
          "Green Monkey aplica medidas de seguridad administrativas, técnicas y físicas (artículo 18), entre ellas la separación de datos por restaurante, credenciales con privilegios mínimos, cifrado en tránsito y registros de auditoría.",
        ],
      },
      {
        id: "subencargados",
        title: "6. Subencargados",
        paragraphs: [
          "El responsable autoriza a los siguientes subencargados: Google (inicio de sesión), Stripe (pagos de la suscripción), Neon (base de datos) y Railway (hospedaje). Algunos pueden ubicarse fuera de México. Green Monkey avisará en la aplicación antes de agregar otro.",
        ],
      },
      {
        id: "vulneraciones",
        title: "7. Vulneraciones",
        paragraphs: [
          "Green Monkey avisará al responsable sin demora injustificada de cualquier vulneración de seguridad que afecte los datos, con la información disponible para que el responsable cumpla el artículo 19.",
        ],
      },
      {
        id: "arco",
        title: "8. Derechos ARCO",
        paragraphs: [
          "Green Monkey ayudará al responsable a atender las solicitudes de acceso, rectificación, cancelación u oposición de sus empleados y comensales, y le reenviará las que reciba directamente.",
        ],
      },
      {
        id: "terminacion",
        title: "9. Terminación",
        paragraphs: [
          "Al terminar el servicio, el responsable puede exportar sus datos durante 30 días. Después, Green Monkey los bloquea y los suprime al vencer el plazo de conservación, salvo los que deba conservar por ley.",
        ],
      },
      {
        id: "auditoria",
        title: "10. Información y auditoría",
        paragraphs: [
          "Green Monkey proporcionará, a solicitud razonable del responsable, la información necesaria para demostrar el cumplimiento de este contrato.",
        ],
      },
      {
        id: "transferencias",
        title: "11. Transferencias",
        paragraphs: [
          "Green Monkey no transfiere los datos a terceros, salvo por orden de autoridad competente, y en ese caso lo informará al responsable cuando la ley lo permita.",
        ],
      },
    ],
  },
  en: {
    title: "Data processing agreement",
    sections: [
      {
        id: "partes",
        title: "1. Parties",
        paragraphs: [
          "The organization that owns the restaurant, represented by its primary owner who accepts this agreement, acts as the controller of its employees' and guests' personal data.",
          "{{entity.name}}, with its address at {{entity.address}}, acts as the processor that processes that data on the controller's behalf to provide the Green Monkey service (Federal Law on the Protection of Personal Data Held by Private Parties, article 2, section XII).",
        ],
      },
      {
        id: "objeto",
        title: "2. Subject matter and data categories",
        paragraphs: [
          "Employees: name, login, role, hashed PIN, shifts and hourly rate. The hourly rate is financial or property data: the restaurant must obtain its employees' express consent (article 7).",
          "Guests: name or alias on orders and order notes. An allergy note tied to a name is sensitive data (articles 2, section VI, and 8); we recommend using aliases.",
        ],
      },
      {
        id: "instrucciones",
        title: "3. Instructions",
        paragraphs: [
          "Green Monkey processes the data only to provide the service according to the controller's instructions as expressed in the app's settings, and does not use it for its own purposes.",
        ],
      },
      {
        id: "confidencialidad",
        title: "4. Confidentiality",
        paragraphs: [
          "Green Monkey keeps the data confidential and requires the same of the people who process it, also after the relationship ends (article 20).",
        ],
      },
      {
        id: "seguridad",
        title: "5. Security",
        paragraphs: [
          "Green Monkey applies administrative, technical and physical security measures (article 18), including per-restaurant data separation, least-privilege credentials, encryption in transit and audit logs.",
        ],
      },
      {
        id: "subencargados",
        title: "6. Sub-processors",
        paragraphs: [
          "The controller authorizes the following sub-processors: Google (sign-in), Stripe (subscription payments), Neon (database) and Railway (hosting). Some may be located outside Mexico. Green Monkey will give notice in the app before adding another.",
        ],
      },
      {
        id: "vulneraciones",
        title: "7. Breaches",
        paragraphs: [
          "Green Monkey will notify the controller without undue delay of any security breach affecting the data, with the information available so the controller can comply with article 19.",
        ],
      },
      {
        id: "arco",
        title: "8. ARCO rights",
        paragraphs: [
          "Green Monkey will help the controller answer access, rectification, cancellation or objection requests from its employees and guests, and will forward any it receives directly.",
        ],
      },
      {
        id: "terminacion",
        title: "9. Termination",
        paragraphs: [
          "When the service ends, the controller can export its data for 30 days. Afterwards, Green Monkey blocks it and deletes it when the retention period expires, except data it must keep by law.",
        ],
      },
      {
        id: "auditoria",
        title: "10. Information and audits",
        paragraphs: [
          "Green Monkey will provide, at the controller's reasonable request, the information needed to demonstrate compliance with this agreement.",
        ],
      },
      {
        id: "transferencias",
        title: "11. Transfers",
        paragraphs: [
          "Green Monkey does not transfer the data to third parties, except by order of a competent authority, and will then inform the controller where the law allows.",
        ],
      },
    ],
  },
};
