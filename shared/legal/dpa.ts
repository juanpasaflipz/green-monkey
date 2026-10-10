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
          "Datos de tarjeta de los cobros con terminal integrada, cuando el restaurante conecta su cuenta de Mercado Pago o de Clip: la marca, el tipo (crédito, débito o prepago) y los últimos 4 dígitos que reporta el proveedor. Green Monkey no recibe ni guarda el número completo, la fecha de vencimiento, el código de seguridad ni el nombre del titular. Las credenciales del restaurante con ese proveedor (token de acceso, llaves y clave de notificaciones): Green Monkey las recibe en un sobre cifrado, las guarda cifradas solo para enviar los cobros a las terminales del restaurante y consultar su resultado, y las borra cuando el restaurante desconecta la cuenta o las reemplaza.",
          "Receptores de CFDI, cuando el restaurante activa la facturación electrónica: RFC, nombre o razón social, régimen fiscal, código postal y correo electrónico de quien pide su factura, que Green Monkey envía a Facturapi para timbrar el CFDI y entregarlo por correo.",
          "El certificado de sello digital (CSD) del restaurante y su contraseña: Green Monkey los recibe en un sobre cifrado, los entrega a Facturapi para que pueda timbrar los CFDI del restaurante y borra su copia.",
          "Socios del club de lealtad, cuando el restaurante activa el club: nombre o apodo, teléfono, historial de compras en el club (órdenes vinculadas con su fecha y total, sellos y premios), el registro de su consentimiento (canal, fecha y el aviso de privacidad del restaurante vigente) y su preferencia sobre promociones; de los socios que el restaurante importa de otro sistema, además, sus visitas, su gasto y su última visita en ese sistema. Green Monkey los trata solo para llevar el club por cuenta del restaurante, no envía mensajes a los socios y borra el nombre y el teléfono cuando el restaurante lo indica o tras 24 meses sin actividad.",
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
          "El responsable autoriza a los siguientes subencargados: Google (inicio de sesión), Stripe (pagos de la suscripción), Neon (base de datos), Railway (hospedaje), Cloudflare (almacenamiento cifrado de los respaldos), GitHub (ejecución automatizada de los respaldos) y, solo si el restaurante activa la facturación electrónica, Facturapi (timbrado de CFDI a través de un proveedor autorizado de certificación y envío del CFDI por correo). Algunos pueden ubicarse fuera de México. Los datos de los socios del club de lealtad se tratan con los mismos subencargados de base de datos, hospedaje y respaldos (Neon, Railway, Cloudflare y GitHub); el club no agrega subencargados. Green Monkey avisará en la aplicación, al menos 15 días antes, de cualquier subencargado nuevo.",
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
          "Al terminar el servicio, el responsable puede exportar sus datos durante 30 días. La exportación no incluye los archivos XML y PDF de los CFDI timbrados: el responsable los descarga del registro de facturas o mediante la descarga masiva del SAT y debe conservarlos 5 años (artículo 30 del Código Fiscal de la Federación).",
          "Después, Green Monkey bloquea los datos y los suprime o anonimiza al vencer el plazo de conservación, salvo los que deba conservar por ley. Los respaldos cifrados de la base de datos contienen esos datos hasta que expiran (35 días los diarios y hasta 1,900 días los mensuales); mientras tanto se tratan como bloqueados y solo se usan para recuperar el servicio ante un desastre.",
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
          "Green Monkey no transfiere los datos a terceros, salvo las comunicaciones que la ley exige o que hace por instrucción del responsable, como el envío de los datos de un CFDI a un proveedor autorizado de certificación para su timbrado y, por su conducto, al SAT (artículo 36); y las órdenes de autoridad competente, que informará al responsable cuando la ley lo permita. Los datos de los socios del club de lealtad no se transfieren ni se comparten con terceros: solo el responsable los consulta y los exporta.",
          "Por instrucción del responsable, cuando conecta su cuenta de Mercado Pago o de Clip, Green Monkey envía a ese proveedor, con las credenciales del restaurante, el importe, la propina, una referencia y una descripción («Orden» y su número) de cada cobro con terminal integrada, y recibe de él su resultado, la comisión y los datos de tarjeta de la sección 2. Mercado Pago y Clip prestan su servicio al restaurante conforme a sus propios contratos con él; no son subencargados de Green Monkey.",
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
          "Card data of integrated terminal payments, when the restaurant connects its Mercado Pago or Clip account: the brand, type (credit, debit or prepaid) and last 4 digits the provider reports. Green Monkey never receives or stores the full number, the expiry date, the security code or the cardholder's name. The restaurant's credentials with that provider (access token, keys and notification secret): Green Monkey receives them in an encrypted envelope, keeps them encrypted only to send charges to the restaurant's terminals and check their outcome, and deletes them when the restaurant disconnects or replaces the account.",
          "CFDI recipients, when the restaurant enables electronic invoicing: the RFC, name or legal name, tax regime, postal code and email of whoever requests an invoice, which Green Monkey sends to Facturapi to stamp the CFDI and deliver it by email.",
          "The restaurant's digital seal certificate (CSD) and its password: Green Monkey receives them in an encrypted envelope, hands them to Facturapi so it can stamp the restaurant's CFDI, and deletes its copy.",
          "Loyalty club members, when the restaurant enables the club: name or nickname, phone, purchase history in the club (linked orders with their date and total, stamps and rewards), the record of their consent (channel, date and the restaurant's privacy notice in force) and their preference on promotions; for members the restaurant imports from another system, also their visits, spend and last visit there. Green Monkey processes them only to run the club on the restaurant's behalf, sends members no messages, and erases the name and phone when the restaurant instructs it or after 24 months without activity.",
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
          "The controller authorizes the following sub-processors: Google (sign-in), Stripe (subscription payments), Neon (database), Railway (hosting), Cloudflare (encrypted backup storage), GitHub (automated backup runs) and, only if the restaurant enables electronic invoicing, Facturapi (CFDI stamping through an authorized certification provider and CFDI delivery by email). Some may be located outside Mexico. Loyalty club members' data is processed with the same database, hosting and backup sub-processors (Neon, Railway, Cloudflare and GitHub); the club adds no sub-processor. Green Monkey will give notice in the app, at least 15 days in advance, of any new sub-processor.",
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
          "When the service ends, the controller can export its data for 30 days. The export does not include the stamped CFDI XML and PDF files: the controller downloads them from the invoice register or through the SAT's bulk download and must keep them for 5 years (Federal Tax Code, article 30).",
          "Afterwards, Green Monkey blocks the data and deletes or anonymizes it when the retention period expires, except data it must keep by law. Encrypted database backups contain that data until they expire (35 days for daily ones and up to 1,900 days for monthly ones); meanwhile they are treated as blocked and used only to recover the service after a disaster.",
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
          "Green Monkey does not transfer the data to third parties, except communications the law requires or that it makes on the controller's instructions, such as sending a CFDI's data to an authorized certification provider for stamping and, through it, to the SAT (article 36); and orders from a competent authority, which it will report to the controller where the law allows. Loyalty club members' data is neither transferred nor shared with third parties: only the controller views and exports it.",
          "On the controller's instructions, when it connects its Mercado Pago or Clip account, Green Monkey sends that provider, with the restaurant's credentials, the amount, tip, a reference and a description («Orden» and its number) of each integrated terminal charge, and receives from it the outcome, the fee and the card data in section 2. Mercado Pago and Clip serve the restaurant under their own contracts with it; they are not Green Monkey's sub-processors.",
        ],
      },
    ],
  },
};
