import type { LegalDocumentContent } from "../legal.js";

/**
 * Terms of service. DRAFT pending review by Mexican counsel (account decision
 * D2); in force only while the legal entity is configured and published.
 * Section ids are fixed (tests/legal.test.ts). Spanish governs.
 */
export const termsContent: LegalDocumentContent = {
  es: {
    title: "Términos del servicio",
    sections: [
      {
        id: "partes",
        title: "1. Partes y aceptación",
        paragraphs: [
          "Estos términos regulan el uso de Green Monkey, el punto de venta para restaurantes que presta {{entity.name}}, con domicilio en {{entity.address}} (en adelante, «Green Monkey»), a la persona titular de la cuenta y a la organización o restaurante que representa (en adelante, «tú» o «el restaurante»).",
          "Los aceptas por medios electrónicos al marcar la casilla correspondiente al crear tu cuenta, tu restaurante o al aceptar una invitación o transferencia; esa aceptación tiene la misma validez que una firma (Código Civil Federal, artículo 1803; Código de Comercio, artículo 80). Guardamos la versión y la fecha de cada aceptación.",
        ],
      },
      {
        id: "servicio",
        title: "2. El servicio",
        paragraphs: [
          "Green Monkey es un servicio en etapa beta. Ofrecemos un plan Free con límites y un plan Pro de pago cuando esté disponible. Las funciones de cada plan se describen en la aplicación y en la página de precios.",
        ],
      },
      {
        id: "cuentas",
        title: "3. Cuentas, accesos y dispositivos",
        paragraphs: [
          "La persona titular administra la organización, su facturación y la transferencia de la propiedad. Puede invitar hasta tres copropietarios con control total de sucursales, equipo y configuración.",
          "Una transferencia de la titularidad también puede iniciarse sin que la persona titular la pida: (a) con uno de sus códigos de recuperación, y entonces queda en espera 24 horas; o (b) por el soporte de Green Monkey, después de verificar la identidad de quien la solicita y su facultad sobre el negocio, y entonces queda en espera al menos 24 horas (72 horas de forma predeterminada). Durante la espera la persona titular ve un aviso en su cuenta y en el punto de venta, solo dentro de la aplicación (no enviamos correo), y puede cancelarla. Si no la cancela, la nueva persona titular puede completarla al terminar la espera.",
          "El personal de soporte de Green Monkey accede a los datos de tu cuenta y de tus restaurantes solo a través de herramientas que registran cada acción con su motivo; puedes consultar esas acciones en tu cuenta («Acciones de soporte»).",
          "Los empleados entran con PIN en dispositivos vinculados. Eres responsable de a quién das acceso, de mantener seguros tus PIN y dispositivos y de desvincular los que ya no uses.",
        ],
      },
      {
        id: "planes",
        title: "4. Planes, prueba y precios",
        paragraphs: [
          "Los precios están en pesos mexicanos (MXN), antes de impuestos. La prueba de Pro no requiere tarjeta; al terminar sin una forma de pago, el restaurante regresa a Free.",
          "No hay periodo de gracia: cuando Pro termina, se aplican los límites de Free. Una caja que ya estaba abierta puede terminar su turno, hasta 16 horas después de abrirse.",
        ],
      },
      {
        id: "pagos-terminal",
        title: "5. Pagos de tus comensales",
        paragraphs: [
          "Green Monkey no es un procesador de pagos y no recibe el dinero de tus comensales. El personal registra en Green Monkey los cobros hechos en una terminal externa y, si conectas tu cuenta de Mercado Pago o de Clip, también puede enviar el importe de un cobro a tu propia terminal integrada.",
          "Cobros con terminal integrada: al conectar tu cuenta de Mercado Pago o de Clip, Green Monkey guarda cifradas sus credenciales solo para enviar a tus terminales el importe y la propina de cada cobro que inicie tu personal y para consultar su resultado. Tu proveedor procesa el cobro conforme a tu contrato con él; Green Monkey registra el pago cuando el proveedor lo confirma, con la marca, el tipo y los últimos 4 dígitos de la tarjeta que reporta y su comisión. Al desconectar la cuenta, Green Monkey borra las credenciales.",
          "Eres responsable de tu relación con tu proveedor de pagos, de sus comisiones, contracargos y reembolsos (que se hacen en la aplicación del proveedor). Un cobro cuyo resultado no se puede confirmar queda «sin confirmar» hasta que una persona gerente lo resuelve con el historial del proveedor.",
        ],
      },
      {
        id: "fiscal",
        title: "6. Obligaciones fiscales",
        paragraphs: [
          "El restaurante es responsable de sus propias obligaciones fiscales. Green Monkey no presta asesoría fiscal. Las funciones de CFDI solo aplican donde están habilitadas y configuradas por el restaurante.",
        ],
      },
      {
        id: "datos",
        title: "7. Tus datos",
        paragraphs: [
          "Los datos de tu restaurante son tuyos. Puedes descargarlos en cualquier momento desde Configuración, también en el plan Free.",
          "Green Monkey trata los datos de tus empleados y comensales como persona encargada conforme al contrato de encargo de datos.",
        ],
      },
      {
        id: "uso-aceptable",
        title: "8. Uso aceptable",
        paragraphs: [
          "No debes usar el servicio para actividades ilícitas, intentar acceder a datos de otros restaurantes, eludir los límites de los planes o las medidas de seguridad, ni interferir con el funcionamiento del servicio.",
        ],
      },
      {
        id: "disponibilidad",
        title: "9. Disponibilidad",
        paragraphs: [
          "Durante la beta prestamos el servicio con nuestro mejor esfuerzo y sin un nivel de servicio garantizado. El modo sin conexión tiene límites descritos en la aplicación: las ventas guardadas en un dispositivo se sincronizan al volver la conexión.",
        ],
      },
      {
        id: "soporte",
        title: "10. Soporte",
        paragraphs: [
          "Los canales de soporte se muestran en la aplicación, en Ayuda, y al pie del sitio. Cada acción que soporte realiza en tu cuenta queda registrada y la puedes consultar en tu cuenta.",
        ],
      },
      {
        id: "suspension-terminacion",
        title: "11. Suspensión y terminación",
        paragraphs: [
          "Puedes dejar de usar el servicio cuando quieras. Podemos suspender una cuenta que incumpla estos términos. Al terminar, tienes 30 días para exportar tus datos; después los bloqueamos y los suprimimos conforme al aviso de privacidad, salvo los que debamos conservar por ley.",
        ],
      },
      {
        id: "responsabilidad",
        title: "12. Responsabilidad",
        paragraphs: [
          "Hasta donde lo permita la ley, la responsabilidad total de Green Monkey frente a ti se limita al importe que hayas pagado por el servicio en los últimos 12 meses.",
        ],
      },
      {
        id: "cambios",
        title: "13. Cambios",
        paragraphs: [
          "Te avisaremos dentro de la aplicación de cada nueva versión de estos términos, con su fecha de entrada en vigor. Los cambios materiales se anuncian al menos 15 días antes de entrar en vigor y, desde esa fecha, te pediremos aceptarlos para seguir administrando tu cuenta; tu restaurante sigue operando mientras tanto. Los cambios menores y la actualización de los datos de Green Monkey se muestran en la aplicación sin pedirte una nueva aceptación.",
        ],
      },
      {
        id: "ley-jurisdiccion",
        title: "14. Ley aplicable y jurisdicción",
        paragraphs: [
          "Estos términos se rigen por las leyes federales de los Estados Unidos Mexicanos. Para su interpretación y cumplimiento, las partes se someten a los tribunales competentes de {{entity.jurisdiction}}.",
        ],
      },
      {
        id: "idioma",
        title: "15. Idioma",
        paragraphs: [
          "Estos términos se ofrecen en español y en inglés. En caso de diferencia, prevalece la versión en español.",
        ],
      },
    ],
  },
  en: {
    title: "Terms of service",
    sections: [
      {
        id: "partes",
        title: "1. Parties and acceptance",
        paragraphs: [
          'These terms govern the use of Green Monkey, the restaurant point of sale provided by {{entity.name}}, with its address at {{entity.address}} ("Green Monkey"), to the account holder and the organization or restaurant they represent ("you" or "the restaurant").',
          "You accept them electronically by ticking the corresponding box when you create your account or restaurant, or accept an invitation or transfer; that acceptance has the same validity as a signature (Federal Civil Code, article 1803; Commercial Code, article 80). We keep the version and date of each acceptance.",
        ],
      },
      {
        id: "servicio",
        title: "2. The service",
        paragraphs: [
          "Green Monkey is a beta service. We offer a Free plan with limits and a paid Pro plan when available. The features of each plan are described in the app and on the pricing page.",
        ],
      },
      {
        id: "cuentas",
        title: "3. Accounts, access and devices",
        paragraphs: [
          "The primary owner manages the organization, its billing and the transfer of ownership. They can invite up to three co-owners with full control of locations, team and settings.",
          "An ownership transfer can also start without the primary owner asking for it: (a) with one of their recovery codes, and it is then held for 24 hours; or (b) by Green Monkey support, after verifying the requester's identity and authority over the business, and it is then held for at least 24 hours (72 hours by default). During the hold the primary owner sees a warning in their account and in the point of sale, only inside the app (we send no email), and can cancel it. If they do not, the new primary owner can complete it when the hold ends.",
          "Green Monkey support staff access your account's and restaurants' data only through tools that record every action with its reason; you can review those actions in your account (\"Support actions\").",
          "Employees sign in with a PIN on paired devices. You are responsible for whom you give access to, for keeping your PINs and devices secure, and for unpairing devices you no longer use.",
        ],
      },
      {
        id: "planes",
        title: "4. Plans, trial and prices",
        paragraphs: [
          "Prices are in Mexican pesos (MXN), before taxes. The Pro trial needs no card; if it ends without a payment method, the restaurant returns to Free.",
          "There is no grace period: when Pro ends, Free limits apply. A drawer that was already open may finish its shift, up to 16 hours after it opened.",
        ],
      },
      {
        id: "pagos-terminal",
        title: "5. Your guests' payments",
        paragraphs: [
          "Green Monkey is not a payment processor and does not receive your guests' money. Staff record in Green Monkey the payments taken on an external terminal and, if you connect your Mercado Pago or Clip account, can also send a payment's amount to your own integrated terminal.",
          "Integrated terminal payments: when you connect your Mercado Pago or Clip account, Green Monkey keeps its credentials encrypted only to send your terminals the amount and tip of each charge your staff starts and to check its outcome. Your provider processes the charge under your contract with it; Green Monkey records the payment once the provider confirms it, with the card brand, type and last 4 digits it reports and its fee. When you disconnect the account, Green Monkey deletes the credentials.",
          "You are responsible for your relationship with your payment provider, its fees, chargebacks and refunds (made in the provider's app). A charge whose outcome cannot be confirmed stays «unconfirmed» until a manager resolves it with the provider's history.",
        ],
      },
      {
        id: "fiscal",
        title: "6. Tax obligations",
        paragraphs: [
          "The restaurant is responsible for its own tax obligations. Green Monkey does not give tax advice. CFDI features apply only where enabled and configured by the restaurant.",
        ],
      },
      {
        id: "datos",
        title: "7. Your data",
        paragraphs: [
          "Your restaurant's data is yours. You can download it at any time from Settings, on the Free plan too.",
          "Green Monkey processes your employees' and guests' data as a processor under the data processing agreement.",
        ],
      },
      {
        id: "uso-aceptable",
        title: "8. Acceptable use",
        paragraphs: [
          "You must not use the service for unlawful activities, try to access other restaurants' data, circumvent plan limits or security measures, or interfere with the operation of the service.",
        ],
      },
      {
        id: "disponibilidad",
        title: "9. Availability",
        paragraphs: [
          "During the beta we provide the service on a best-effort basis with no guaranteed service level. Offline mode has limits described in the app: sales saved on a device sync when the connection returns.",
        ],
      },
      {
        id: "soporte",
        title: "10. Support",
        paragraphs: [
          "Support channels are shown in the app, under Help, and at the bottom of the website. Every action support performs on your account is recorded, and you can review it in your account.",
        ],
      },
      {
        id: "suspension-terminacion",
        title: "11. Suspension and termination",
        paragraphs: [
          "You may stop using the service at any time. We may suspend an account that breaches these terms. After termination you have 30 days to export your data; afterwards we block it and delete it as described in the privacy notice, except data we must keep by law.",
        ],
      },
      {
        id: "responsabilidad",
        title: "12. Liability",
        paragraphs: [
          "To the extent permitted by law, Green Monkey's total liability to you is limited to the amount you paid for the service in the last 12 months.",
        ],
      },
      {
        id: "cambios",
        title: "13. Changes",
        paragraphs: [
          "We will notify you inside the app of every new version of these terms, with the date it takes effect. Material changes are announced at least 15 days before they take effect and, from that date, we will ask you to accept them to keep managing your account; your restaurant keeps operating meanwhile. Minor changes and updates to Green Monkey's details are shown in the app without asking you to accept again.",
        ],
      },
      {
        id: "ley-jurisdiccion",
        title: "14. Governing law and jurisdiction",
        paragraphs: [
          "These terms are governed by the federal laws of the United Mexican States. For their interpretation and enforcement, the parties submit to the competent courts of {{entity.jurisdiction}}.",
        ],
      },
      {
        id: "idioma",
        title: "15. Language",
        paragraphs: [
          "These terms are offered in Spanish and English. If the versions differ, the Spanish version prevails.",
        ],
      },
    ],
  },
};
