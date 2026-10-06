import { defineArea } from "./define";

export default defineArea({
  es: {
    // Legal documents and acceptance (FIT-12)
    accountLegalPrivacy: "Aviso de privacidad",
    accountLegalTerms: "Términos del servicio",
    accountLegalDpa: "Contrato de encargo de datos",
    accountLegalIndexTitle: "Documentos legales",
    accountLegalIndexHint:
      "Cómo tratamos los datos personales y las condiciones para usar Green Monkey.",
    accountLegalContact: "Contacto",
    accountLegalDraftBanner:
      "Documento no vigente: faltan datos del responsable. No lo uses como aviso de privacidad.",
    accountLegalPendingField: "Dato pendiente de publicar",
    accountLegalVersion: "Versión {version}",
    accountLegalChanges: "Cambios en esta versión",
    accountLegalSpanishPrevails:
      "En caso de diferencia, prevalece la versión en español.",
    accountLegalOffline:
      "Conéctate para ver la versión vigente de este documento.",
    accountLegalBack: "Volver al inicio",
    accountLegalPrint: "Imprimir",
    accountLegalLoading: "Cargando documento…",
    accountSimplifiedNotice:
      "{entity} es responsable de tus datos personales. Usaremos tu nombre y correo de Google para crear y proteger tu cuenta, prestarte el servicio, facturar tu suscripción y darte soporte. No los usamos para publicidad. Para limitar su uso o ejercer tus derechos ARCO escribe a {email}.",
    accountSimplifiedNoticeLink: "Lee el aviso de privacidad integral",
    accountSimplifiedNoticeDraft:
      "Entorno de prueba: el aviso de privacidad aún no está publicado.",
    accountSignupPaused:
      "La creación de cuentas nuevas está pausada mientras publicamos el aviso de privacidad. Si ya tienes cuenta, entra con Google.",
    accountGoogleExisting: "Entrar con Google",
    accountAcceptTermsDpa:
      "Acepto los Términos del servicio y el Contrato de encargo de datos de mi restaurante.",
    accountAcceptTerms: "Acepto los Términos del servicio.",
    accountAcceptDpa: "Acepto el Contrato de encargo de datos de {org}.",
    accountAcknowledgePrivacy: "Leí el Aviso de privacidad.",
    accountLegalDraftAcceptance: "Documentos en borrador (entorno de prueba)",
    accountLegalAcceptanceTitle: "Documentos legales",
    accountLegalUpdatedTitle: "Actualizamos nuestros documentos",
    accountLegalUpdatedBody:
      "Revisa los cambios y acepta para seguir administrando tu cuenta. Tu restaurante sigue operando mientras tanto.",
    accountLegalAccept: "Aceptar y continuar",
    accountLegalDpaPendingPrimary:
      "La persona titular debe aceptar el contrato de encargo actualizado.",
    // Help and support (GAP-5)
    accountHelp: "Ayuda",
    accountHelpAndPrivacy: "Ayuda y privacidad",
    accountHelpTitle: "Ayuda y soporte",
    accountHelpNotConfigured:
      "El contacto de soporte aún no está configurado en este entorno.",
    accountHelpEmail: "Correo",
    accountHelpPhone: "Teléfono",
    accountHelpWhatsapp: "WhatsApp",
    accountHelpHours: "Horario",
    accountHelpCenter: "Centro de ayuda",
    accountHelpRestaurantId: "ID del restaurante",
    accountHelpDeviceId: "ID del dispositivo",
    accountHelpVersion: "Versión de la app",
    accountHelpCopy: "Copiar",
    accountHelpCopied: "Copiado",
    accountHelpLegal: "Documentos legales",
    accountHelpClose: "Cerrar",
    // Restaurant privacy URL and data export
    accountPrivacyTitle: "Privacidad y datos",
    accountPrivacyUrlLabel: "Enlace al aviso de privacidad de tu restaurante",
    accountPrivacyUrlHint:
      "Se muestra a tus comensales en pedidos QR y kiosco, donde escriben su nombre. Tu restaurante es responsable de esos datos; usa una dirección https.",
    accountPrivacyUrlInvalid: "Usa un enlace que empiece con https://",
    accountPrivacySave: "Guardar enlace",
    accountPrivacySaved: "Enlace guardado",
    accountPrivacyRemove: "Quitar enlace",
    accountPrivacyNone: "Sin enlace configurado.",
    accountPrivacyOwnerOnly:
      "Solo la persona propietaria puede cambiar este enlace.",
    accountExportTitle: "Exportar datos del restaurante",
    accountExportHint:
      "Descarga tus registros: ventas, pagos, caja, menú, inventario, equipo y auditoría. Los importes están en centavos. No incluye contraseñas ni PIN.",
    accountExportJson: "Descargar todo (JSON)",
    accountExportCsv: "Descargar tabla (CSV)",
    accountExportTable: "Tabla",
    accountExportInterrupted:
      "La descarga se interrumpió; vuelve a intentarlo.",
    accountExportStepUpHint: "En terminales compartidas te pediremos tu PIN.",
    accountExportPreparing: "Preparando la descarga…",
    accountExportStarted: "La descarga comenzó.",
    // Account console: owners, transfers, recovery (GAP-5)
    accountConsoleTitle: "Cuenta y propietarios",
    accountLoading: "Cargando…",
    accountCancel: "Cancelar",
    accountConfirm: "Confirmar",
    accountYou: "tú",
    accountFormerAccount: "Cuenta anterior",
    accountOwnersTitle: "Propietarios",
    accountPrimaryOwner: "Titular",
    accountCoOwner: "Copropietario",
    accountCoOwnerSince: "Desde {date}",
    accountCoOwnerNone: "Aún no hay copropietarios.",
    accountCoOwnerPending:
      "Invitación pendiente para {email} · caduca el {date}",
    accountCoOwnerInvite: "Invitar copropietario",
    accountCoOwnerInviteHint:
      "Tendrá control total de sucursales, equipo y configuración. La facturación y la transferencia de propiedad quedan con el titular. Máximo {n}.",
    // Distinct from the staff invitation's "Correo de Google" on the same screen.
    accountCoOwnerEmail: "Correo de Google del copropietario",
    accountCoOwnerCreate: "Crear invitación",
    accountCoOwnerLink:
      "Enlace de invitación — compártelo solo con esa persona. Caduca el {date}.",
    accountCoOwnerInvited:
      "Te invitaron como copropietario de {org}: tendrás control total de sus sucursales, equipo y configuración. La facturación y la transferencia de propiedad quedan con la persona titular.",
    accountInvitedAs: "Te invitaron como {role} en {restaurant}.",
    accountInvitationEmailMismatch:
      "Esta invitación es para otro correo. Entra con la cuenta de Google invitada.",
    accountCoOwnerRemove: "Quitar copropietario",
    accountCoOwnerRemoveConfirm:
      "Se cerrarán sus sesiones y perderá acceso a todas las sucursales.",
    accountCoOwnerLeave: "Dejar de ser copropietario",
    accountCoOwnerLeaveConfirm:
      "Perderás acceso a todas las sucursales de {org}.",
    accountCoOwnerBillingNote:
      "La facturación y nuevas sucursales las administra la persona titular.",
    accountRoleCoOwner: "Copropietario",
    accountTransferTitle: "Transferir propiedad",
    accountTransferHint:
      "La nueva persona titular controlará todo, incluida la facturación. El método de pago guardado en Stripe sigue activo hasta que lo cambie.",
    accountTransferEmail: "Correo de Google de la nueva persona titular",
    accountTransferStay: "Seguir como copropietario",
    accountTransferStayFull:
      "Ya hay {n} copropietarios; no puedes quedarte como copropietario.",
    accountTransferConfirmName: "Escribe {name} para confirmar",
    accountTransferCreate: "Crear enlace de transferencia",
    accountTransferLink:
      "Enlace de transferencia — compártelo solo con esa persona. Caduca el {date}.",
    accountTransferLinkLost:
      "Enlace creado. Si lo perdiste, cancela esta transferencia y crea otra.",
    accountTransferPendingOut:
      "Transferencia pendiente a {email}. Caduca el {date}.",
    accountTransferSupportInitiated:
      "Soporte inició una transferencia de propiedad hacia {email}. Se podrá completar desde el {date}. Si no la reconoces, cancélala ahora.",
    accountTransferRecoveryInitiated:
      "Se usó un código de recuperación para transferir la propiedad a {email}. Se podrá completar desde el {date}. Si no fuiste tú, cancélala y genera códigos nuevos.",
    accountTransferCancel: "Cancelar transferencia",
    accountTransferIncoming:
      "Te ofrecen la titularidad de {org} ({n} sucursales).",
    accountTransferFrom: "Ofrecida por {name}",
    accountTransferPreviousStays:
      "La persona titular actual seguirá como copropietaria.",
    accountTransferIncludesBilling: "Incluye la facturación de la suscripción.",
    accountTransferOnHold: "Podrás aceptarla a partir del {date}.",
    accountTransferAccept: "Aceptar y convertirme en titular",
    accountTransferDecline: "Rechazar",
    accountTransferDone:
      "Ahora eres titular. Revisa dispositivos vinculados, la selección Free y el correo de facturación en Stripe.",
    accountTransferEmailMismatch:
      "Esta transferencia es para otro correo. Entra con la cuenta de Google indicada.",
    accountRecoveryTitle: "Códigos de recuperación",
    accountRecoveryHint:
      "Si pierdes tu cuenta de Google, entra con otra cuenta de Google y usa un código para recuperar la titularidad. Cada código funciona una vez.",
    accountRecoveryGenerate: "Generar códigos nuevos",
    accountRecoveryShownOnce:
      "Guárdalos ahora: no volveremos a mostrarlos. Generar nuevos invalida los anteriores.",
    accountRecoveryPrint: "Imprimir",
    accountRecoveryCopyAll: "Copiar códigos",
    accountRecoveryRemaining: "{n} códigos disponibles · generados el {date}",
    accountRecoveryNone: "Aún no generas códigos.",
    accountRecoveryRedeemTitle: "¿Perdiste acceso a tu cuenta anterior?",
    accountRecoveryRedeemLabel: "Código de recuperación",
    accountRecoveryRedeem: "Recuperar titularidad",
    accountRecoveryScheduled:
      "Recuperación programada. Podrás completarla a partir del {date}.",
    accountRecoverySupport:
      "¿Sin códigos? Contacta a soporte para una verificación de identidad.",
    accountReauth:
      "Por seguridad, vuelve a iniciar sesión con Google para continuar.",
    accountReauthButton: "Iniciar sesión de nuevo",
    accountSupportActions: "Acciones de soporte",
    accountSupportActionLabel: "Soporte de Green Monkey · ticket {ticket}",
    accountSupportAction_lookup: "Consulta de cuenta",
    accountSupportAction_unlock_employee: "Desbloqueo de empleado",
    accountSupportAction_grant_entitlement: "Pro otorgado",
    accountSupportAction_end_entitlement: "Pro finalizado",
    accountSupportAction_transfer_ownership: "Transferencia iniciada",
    accountSupportAction_cancel_transfer: "Transferencia cancelada",
    accountSupportAction_set_free_device: "Dispositivo Free cambiado",
    accountEvents: "Actividad de la cuenta",
    accountEventsNone: "Sin actividad registrada.",
    accountEvent_co_owner_invited: "Copropietario invitado",
    accountEvent_co_owner_added: "Copropietario agregado",
    accountEvent_co_owner_removed: "Copropietario quitado",
    accountEvent_co_owner_left: "Copropietario salió",
    accountEvent_transfer_requested: "Transferencia solicitada",
    accountEvent_transfer_canceled: "Transferencia cancelada",
    accountEvent_transfer_completed: "Transferencia completada",
    accountEvent_recovery_codes_generated: "Códigos de recuperación generados",
    accountEvent_recovery_code_redeemed: "Código de recuperación usado",
    accountEvent_tax_profile_updated: "Datos de facturación actualizados",
    // SaaS tax (GAP-6)
    accountTaxProfile: "Datos de facturación de la suscripción",
    accountTaxRfc: "RFC",
    accountTaxLegalName: "Razón social (como en tu Constancia)",
    accountTaxRegime: "Régimen fiscal",
    accountTaxPostalCode: "Código postal fiscal",
    accountTaxUse: "Uso del CFDI",
    accountTaxInvoiceEmail: "Correo para recibir el CFDI",
    accountTaxProfileHint:
      "Guardamos estos datos para emitir la factura de tu suscripción cuando esté disponible.",
    accountTaxSave: "Guardar datos de facturación",
    accountTaxSaved: "Datos de facturación guardados",
    accountTaxNotConfigured:
      "Precio antes de impuestos. El IVA y la factura (CFDI) de la suscripción aún no están configurados.",
    accountTaxIncluded: "{price} + IVA 16 % = {total}",
    // Plan notices (GAP-1)
    accountNoticeTrialEnding:
      "La prueba Pro termina el {date}. Si no agregaste una forma de pago, este restaurante pasará a Free: solo {device} y dos empleados podrán iniciar ventas.",
    accountNoticeTrialEndingStaff:
      "La prueba Pro termina hoy a las {time}. Avísale al propietario.",
    accountNoticeGrantEnding:
      "El acceso Pro otorgado por soporte termina el {date}.",
    accountNoticePaymentFailed:
      "No se pudo cobrar la suscripción. Pro está suspendido y aplican los límites Free hasta actualizar el pago.",
    accountNoticePaymentFailedStaff:
      "Pro está suspendido por un pago pendiente. Avísale al propietario.",
    accountNoticeProEnded:
      "Pro terminó el {date}. Aplican los límites Free: solo {device} y dos empleados pueden iniciar ventas.",
    accountNoticeContinuation:
      "Esta caja sigue vendiendo hasta cerrarla o hasta las {time}. Después aplicarán los límites Free.",
    accountNoticeBlocked:
      "Free: este dispositivo o empleado no está seleccionado para iniciar ventas. Solo {device} puede hacerlo. Puedes cobrar órdenes abiertas y consultar registros.",
    accountNoticeNoDevice: "el dispositivo seleccionado",
    accountNoticeReviewPlan: "Revisar plan",
    accountNoticeUpdatePayment: "Actualizar pago",
    accountNoticeChangeSelection: "Cambiar selección",
    accountNoticeDismiss: "Ocultar",
    accountNoticeBlockedFallback:
      "Free: esta sucursal, dispositivo o empleado no está seleccionado para iniciar ventas. El propietario puede cambiar la selección en Cuenta y Configuración. Puedes terminar cobros y consultar registros.",
    accountNoticeLegalPending: "Hay documentos legales por aceptar en Cuenta.",
    accountNoticeSupportAction:
      "Soporte realizó una acción en tu cuenta el {date}: {action}.",
    accountFreeAuto:
      "Automático: el dispositivo y empleados que abrieron caja más recientemente.",
    accountFreeManual: "Manual: tu selección.",
    accountFreeBackToAuto: "Volver a automático",
    accountFreeLimitsSummary:
      "En Free solo el dispositivo y los dos empleados seleccionados pueden iniciar ventas. Los demás pueden cobrar órdenes abiertas y consultar registros.",
    accountSupportGrantPrefix: "Pro otorgado por soporte",
    accountPublicOrderingSoon: "Kiosco y pedidos QR: próximamente.",
    // Diner-facing public ordering copy (key names pinned for wave 3, LD-P12)
    accountGuestNameLabel: "Nombre (opcional)",
    accountGuestNameHint:
      "Solo para llamarte cuando tu pedido esté listo. Puedes usar un apodo.",
    accountGuestPrivacyLink: "Aviso de privacidad de {restaurant}",
    accountGuestNoNotice:
      "Este restaurante aún no publicó un aviso de privacidad; no escribas datos personales.",
    accountGuestPlatformPrivacy:
      "Pedido procesado con Green Monkey · Privacidad de la plataforma",
    accountGuestOrderingUnavailable:
      "Los pedidos en línea no están disponibles por ahora. Pide en el mostrador.",
    // Landing (Landing.tsx keeps them inline for its lightweight bundle)
    accountLandingFooterSupport: "Soporte",
    accountLandingFaqDataQ: "¿De quién son mis datos?",
    accountLandingFaqDataA:
      "De tu restaurante. Puedes descargarlos en CSV o JSON desde Configuración en cualquier momento, también en Free.",
    accountLandingFaqHelpQ: "¿Cómo obtengo ayuda?",
    accountLandingFaqHelpA:
      "Desde la app, en Ayuda, o por los canales de soporte que aparecen al pie de esta página.",
    // Audit operation labels (src/labels.ts)
    accountOpOwnerSeat: "Acceso de propietario otorgado",
    accountOpOwnerSeatRevoked: "Acceso de propietario retirado",
    accountOpCoOwnerAdded: "Copropietario agregado",
    accountOpOwnershipTransferred: "Propiedad transferida",
    accountOpDataExport: "Datos exportados",
    accountOpRestaurantPrivacy: "Aviso de privacidad del restaurante actualizado",
    accountOpFreeSelectionMode: "Selección Free en automático",
    accountOpFreeSlotAuto: "Selección Free movida automáticamente",
  },
  en: {
    accountLegalPrivacy: "Privacy notice",
    accountLegalTerms: "Terms of service",
    accountLegalDpa: "Data processing agreement",
    accountLegalIndexTitle: "Legal documents",
    accountLegalIndexHint:
      "How we handle personal data and the conditions for using Green Monkey.",
    accountLegalContact: "Contact",
    accountLegalDraftBanner:
      "Not in effect: the data controller's details are missing. Do not rely on this document.",
    accountLegalPendingField: "Not yet published",
    accountLegalVersion: "Version {version}",
    accountLegalChanges: "Changes in this version",
    accountLegalSpanishPrevails:
      "If the versions differ, the Spanish version prevails.",
    accountLegalOffline: "Connect to see the current version of this document.",
    accountLegalBack: "Back to home",
    accountLegalPrint: "Print",
    accountLegalLoading: "Loading document…",
    accountSimplifiedNotice:
      "{entity} is the controller of your personal data. We use your Google name and email to create and protect your account, provide the service, bill your subscription and support you. We do not use them for advertising. To limit their use or exercise your ARCO rights, write to {email}.",
    accountSimplifiedNoticeLink: "Read the full privacy notice",
    accountSimplifiedNoticeDraft:
      "Test environment: the privacy notice is not published yet.",
    accountSignupPaused:
      "New account creation is paused while we publish our privacy notice. If you already have an account, sign in with Google.",
    accountGoogleExisting: "Sign in with Google",
    accountAcceptTermsDpa:
      "I accept the Terms of service and my restaurant's Data processing agreement.",
    accountAcceptTerms: "I accept the Terms of service.",
    accountAcceptDpa: "I accept the Data processing agreement for {org}.",
    accountAcknowledgePrivacy: "I have read the Privacy notice.",
    accountLegalDraftAcceptance: "Draft documents (test environment)",
    accountLegalAcceptanceTitle: "Legal documents",
    accountLegalUpdatedTitle: "We updated our documents",
    accountLegalUpdatedBody:
      "Review the changes and accept to keep managing your account. Your restaurant keeps operating meanwhile.",
    accountLegalAccept: "Accept and continue",
    accountLegalDpaPendingPrimary:
      "The primary owner must accept the updated data processing agreement.",
    accountHelp: "Help",
    accountHelpAndPrivacy: "Help and privacy",
    accountHelpTitle: "Help and support",
    accountHelpNotConfigured:
      "Support contact is not configured in this environment yet.",
    accountHelpEmail: "Email",
    accountHelpPhone: "Phone",
    accountHelpWhatsapp: "WhatsApp",
    accountHelpHours: "Hours",
    accountHelpCenter: "Help center",
    accountHelpRestaurantId: "Restaurant ID",
    accountHelpDeviceId: "Device ID",
    accountHelpVersion: "App version",
    accountHelpCopy: "Copy",
    accountHelpCopied: "Copied",
    accountHelpLegal: "Legal documents",
    accountHelpClose: "Close",
    accountPrivacyTitle: "Privacy and data",
    accountPrivacyUrlLabel: "Link to your restaurant's privacy notice",
    accountPrivacyUrlHint:
      "Shown to guests on QR and kiosk ordering, where they enter their name. Your restaurant is the controller of that data; use an https address.",
    accountPrivacyUrlInvalid: "Use a link that starts with https://",
    accountPrivacySave: "Save link",
    accountPrivacySaved: "Link saved",
    accountPrivacyRemove: "Remove link",
    accountPrivacyNone: "No link configured.",
    accountPrivacyOwnerOnly: "Only the owner can change this link.",
    accountExportTitle: "Export restaurant data",
    accountExportHint:
      "Download your records: sales, payments, cash, menu, inventory, team and audit. Amounts are in cents. Passwords and PINs are not included.",
    accountExportJson: "Download everything (JSON)",
    accountExportCsv: "Download table (CSV)",
    accountExportTable: "Table",
    accountExportInterrupted: "The download was interrupted; try again.",
    accountExportStepUpHint: "On shared terminals we will ask for your PIN.",
    accountExportPreparing: "Preparing the download…",
    accountExportStarted: "The download started.",
    accountConsoleTitle: "Account and owners",
    accountLoading: "Loading…",
    accountCancel: "Cancel",
    accountConfirm: "Confirm",
    accountYou: "you",
    accountFormerAccount: "Former account",
    accountOwnersTitle: "Owners",
    accountPrimaryOwner: "Primary owner",
    accountCoOwner: "Co-owner",
    accountCoOwnerSince: "Since {date}",
    accountCoOwnerNone: "No co-owners yet.",
    accountCoOwnerPending: "Pending invitation for {email} · expires {date}",
    accountCoOwnerInvite: "Invite co-owner",
    accountCoOwnerInviteHint:
      "They get full control of locations, team and settings. Billing and ownership transfer stay with the primary owner. Up to {n}.",
    accountCoOwnerEmail: "Co-owner's Google email",
    accountCoOwnerCreate: "Create invitation",
    accountCoOwnerLink:
      "Invitation link — share it only with that person. Expires {date}.",
    accountCoOwnerInvited:
      "You were invited as a co-owner of {org}: you'll have full control of its locations, team and settings. Billing and ownership transfer stay with the primary owner.",
    accountInvitedAs: "You were invited as {role} at {restaurant}.",
    accountInvitationEmailMismatch:
      "This invitation is for another email. Sign in with the invited Google account.",
    accountCoOwnerRemove: "Remove co-owner",
    accountCoOwnerRemoveConfirm:
      "Their sessions will be closed and they will lose access to every location.",
    accountCoOwnerLeave: "Leave co-ownership",
    accountCoOwnerLeaveConfirm:
      "You will lose access to every location of {org}.",
    accountCoOwnerBillingNote:
      "Billing and new locations are managed by the primary owner.",
    accountRoleCoOwner: "Co-owner",
    accountTransferTitle: "Transfer ownership",
    accountTransferHint:
      "The new primary owner will control everything, including billing. The payment method saved in Stripe stays active until they change it.",
    accountTransferEmail: "New primary owner's Google email",
    accountTransferStay: "Stay as a co-owner",
    accountTransferStayFull:
      "There are already {n} co-owners; you cannot stay as a co-owner.",
    accountTransferConfirmName: "Type {name} to confirm",
    accountTransferCreate: "Create transfer link",
    accountTransferLink:
      "Transfer link — share it only with that person. Expires {date}.",
    accountTransferLinkLost:
      "Link created. If you lost it, cancel this transfer and create another.",
    accountTransferPendingOut: "Transfer pending to {email}. Expires {date}.",
    accountTransferSupportInitiated:
      "Support started an ownership transfer to {email}. It can be completed from {date}. If you don't recognize it, cancel it now.",
    accountTransferRecoveryInitiated:
      "A recovery code was used to transfer ownership to {email}. It can be completed from {date}. If this wasn't you, cancel it and generate new codes.",
    accountTransferCancel: "Cancel transfer",
    accountTransferIncoming:
      "You are offered primary ownership of {org} ({n} locations).",
    accountTransferFrom: "Offered by {name}",
    accountTransferPreviousStays:
      "The current primary owner will stay as a co-owner.",
    accountTransferIncludesBilling: "Includes subscription billing.",
    accountTransferOnHold: "You can accept it from {date}.",
    accountTransferAccept: "Accept and become primary owner",
    accountTransferDecline: "Decline",
    accountTransferDone:
      "You are now the primary owner. Review paired devices, the Free selection and the billing email in Stripe.",
    accountTransferEmailMismatch:
      "This transfer is for another email. Sign in with the indicated Google account.",
    accountRecoveryTitle: "Recovery codes",
    accountRecoveryHint:
      "If you lose your Google account, sign in with another Google account and use a code to recover primary ownership. Each code works once.",
    accountRecoveryGenerate: "Generate new codes",
    accountRecoveryShownOnce:
      "Save them now: we won't show them again. Generating new ones invalidates the old ones.",
    accountRecoveryPrint: "Print",
    accountRecoveryCopyAll: "Copy codes",
    accountRecoveryRemaining: "{n} codes left · generated {date}",
    accountRecoveryNone: "You haven't generated codes yet.",
    accountRecoveryRedeemTitle: "Lost access to your previous account?",
    accountRecoveryRedeemLabel: "Recovery code",
    accountRecoveryRedeem: "Recover ownership",
    accountRecoveryScheduled:
      "Recovery scheduled. You can complete it from {date}.",
    accountRecoverySupport: "No codes? Contact support for an identity check.",
    accountReauth: "For security, sign in with Google again to continue.",
    accountReauthButton: "Sign in again",
    accountSupportActions: "Support actions",
    accountSupportActionLabel: "Green Monkey support · ticket {ticket}",
    accountSupportAction_lookup: "Account lookup",
    accountSupportAction_unlock_employee: "Employee unlocked",
    accountSupportAction_grant_entitlement: "Pro granted",
    accountSupportAction_end_entitlement: "Pro ended",
    accountSupportAction_transfer_ownership: "Transfer started",
    accountSupportAction_cancel_transfer: "Transfer canceled",
    accountSupportAction_set_free_device: "Free device changed",
    accountEvents: "Account activity",
    accountEventsNone: "No activity recorded.",
    accountEvent_co_owner_invited: "Co-owner invited",
    accountEvent_co_owner_added: "Co-owner added",
    accountEvent_co_owner_removed: "Co-owner removed",
    accountEvent_co_owner_left: "Co-owner left",
    accountEvent_transfer_requested: "Transfer requested",
    accountEvent_transfer_canceled: "Transfer canceled",
    accountEvent_transfer_completed: "Transfer completed",
    accountEvent_recovery_codes_generated: "Recovery codes generated",
    accountEvent_recovery_code_redeemed: "Recovery code used",
    accountEvent_tax_profile_updated: "Billing details updated",
    accountTaxProfile: "Subscription billing details",
    accountTaxRfc: "RFC",
    accountTaxLegalName: "Legal name (as on your tax certificate)",
    accountTaxRegime: "Tax regime",
    accountTaxPostalCode: "Tax postal code",
    accountTaxUse: "CFDI use",
    accountTaxInvoiceEmail: "Email to receive the CFDI",
    accountTaxProfileHint:
      "We keep these details to issue your subscription invoice once available.",
    accountTaxSave: "Save billing details",
    accountTaxSaved: "Billing details saved",
    accountTaxNotConfigured:
      "Price before taxes. VAT and the subscription invoice (CFDI) are not configured yet.",
    accountTaxIncluded: "{price} + 16% VAT = {total}",
    accountNoticeTrialEnding:
      "The Pro trial ends {date}. If no payment method was added, this restaurant returns to Free: only {device} and two employees can start sales.",
    accountNoticeTrialEndingStaff:
      "The Pro trial ends today at {time}. Let the owner know.",
    accountNoticeGrantEnding: "Pro access granted by support ends {date}.",
    accountNoticePaymentFailed:
      "The subscription payment failed. Pro is suspended and Free limits apply until payment is updated.",
    accountNoticePaymentFailedStaff:
      "Pro is suspended due to a pending payment. Let the owner know.",
    accountNoticeProEnded:
      "Pro ended {date}. Free limits apply: only {device} and two employees can start sales.",
    accountNoticeContinuation:
      "This register keeps selling until it closes or until {time}. Free limits apply afterwards.",
    accountNoticeBlocked:
      "Free: this device or employee is not selected to start sales. Only {device} can. You can collect open orders and view records.",
    accountNoticeNoDevice: "the selected device",
    accountNoticeReviewPlan: "Review plan",
    accountNoticeUpdatePayment: "Update payment",
    accountNoticeChangeSelection: "Change selection",
    accountNoticeDismiss: "Dismiss",
    accountNoticeBlockedFallback:
      "Free: this location, device or employee is not selected to start sales. The owner can change selections in Account and Settings. You can finish payments and view records.",
    accountNoticeLegalPending:
      "There are legal documents to accept in Account.",
    accountNoticeSupportAction:
      "Support performed an action on your account on {date}: {action}.",
    accountFreeAuto:
      "Automatic: the device and employees that most recently opened a drawer.",
    accountFreeManual: "Manual: your selection.",
    accountFreeBackToAuto: "Back to automatic",
    accountFreeLimitsSummary:
      "On Free only the selected device and two employees can start sales. Others can collect open orders and view records.",
    accountSupportGrantPrefix: "Pro granted by support",
    accountPublicOrderingSoon: "Kiosk and QR ordering: coming soon.",
    accountGuestNameLabel: "Name (optional)",
    accountGuestNameHint:
      "Only to call you when your order is ready. You can use a nickname.",
    accountGuestPrivacyLink: "{restaurant} privacy notice",
    accountGuestNoNotice:
      "This restaurant hasn't published a privacy notice yet; don't enter personal data.",
    accountGuestPlatformPrivacy:
      "Order processed with Green Monkey · Platform privacy",
    accountGuestOrderingUnavailable:
      "Online ordering is unavailable right now. Please order at the counter.",
    accountLandingFooterSupport: "Support",
    accountLandingFaqDataQ: "Who owns my data?",
    accountLandingFaqDataA:
      "Your restaurant. You can download it as CSV or JSON from Settings at any time, on Free too.",
    accountLandingFaqHelpQ: "How do I get help?",
    accountLandingFaqHelpA:
      "In the app, under Help, or through the support channels at the bottom of this page.",
    accountOpOwnerSeat: "Owner access granted",
    accountOpOwnerSeatRevoked: "Owner access removed",
    accountOpCoOwnerAdded: "Co-owner added",
    accountOpOwnershipTransferred: "Ownership transferred",
    accountOpDataExport: "Data exported",
    accountOpRestaurantPrivacy: "Restaurant privacy notice updated",
    accountOpFreeSelectionMode: "Free selection set to automatic",
    accountOpFreeSlotAuto: "Free selection moved automatically",
  },
  errors: {
    legal_acceptance_required: [
      "Acepta los documentos actualizados para continuar.",
      "Accept the updated documents to continue.",
    ],
    legal_version_mismatch: [
      "Los documentos cambiaron. Recarga y vuelve a aceptar.",
      "The documents changed. Reload and accept again.",
    ],
    signup_paused: [
      "La creación de cuentas nuevas está pausada temporalmente.",
      "New account creation is temporarily paused.",
    ],
    reauthentication_required: [
      "Por seguridad, vuelve a iniciar sesión con Google para continuar.",
      "For security, sign in with Google again to continue.",
    ],
    co_owner_limit: [
      "Ya se alcanzó el máximo de copropietarios.",
      "The co-owner limit has been reached.",
    ],
    co_owner_primary_only: [
      "Solo la persona titular puede hacer esto.",
      "Only the primary owner can do this.",
    ],
    co_owner_not_found: [
      "Esa persona ya no es copropietaria.",
      "That person is no longer a co-owner.",
    ],
    transfer_pending_exists: [
      "Ya hay una transferencia pendiente. Cancélala antes de crear otra.",
      "A transfer is already pending. Cancel it before creating another.",
    ],
    transfer_unavailable: [
      "Esta transferencia ya no está disponible.",
      "This transfer is no longer available.",
    ],
    transfer_on_hold: [
      "Esta transferencia aún está en periodo de espera.",
      "This transfer is still in its waiting period.",
    ],
    transfer_target_owns_organization: [
      "Esa cuenta ya es titular de otra organización.",
      "That account already owns another organization.",
    ],
    transfer_self: [
      "No puedes transferirte la propiedad a ti mismo.",
      "You cannot transfer ownership to yourself.",
    ],
    invalid_confirmation: [
      "El nombre no coincide. Escríbelo exactamente.",
      "The name does not match. Type it exactly.",
    ],
    recovery_code_invalid: [
      "Código no válido o ya usado.",
      "Invalid or already used code.",
    ],
    recovery_nothing_to_recover: [
      "Esa cuenta no es titular de ninguna organización.",
      "That account does not own any organization.",
    ],
    export_busy: [
      "Ya hay una exportación en curso. Intenta en unos minutos.",
      "An export is already running. Try again in a few minutes.",
    ],
    export_table_unknown: [
      "Esa tabla no está disponible para exportar.",
      "That table is not available for export.",
    ],
    export_aborted: [
      "La descarga se interrumpió; vuelve a intentarlo.",
      "The download was interrupted; try again.",
    ],
    tax_profile_disabled: [
      "Los datos de facturación de la suscripción no están habilitados.",
      "Subscription billing details are not enabled.",
    ],
    profile_changed: [
      "Los datos cambiaron en otra sesión. Recarga antes de guardar.",
      "The details changed in another session. Reload before saving.",
    ],
    public_ordering_disabled: [
      "Los pedidos en línea no están disponibles por ahora. Pide en el mostrador.",
      "Online ordering is unavailable right now. Please order at the counter.",
    ],
  },
});
