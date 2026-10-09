import { defineArea } from "./define";

// Payments (Wave 4, migration 037): card terminals, the "Pagado por plataforma"
// tender and per-platform prices (LD-72). Registered as `payments`, before
// loyalty and kiosk (critic R29). The cash*/cfdi* keys keep the names the
// critic bound (R29) and live here, in the payments area.
export default defineArea({
  es: {
    // Payment dialog
    payMethodCash: "Efectivo",
    payMethodCard: "Tarjeta",
    payMethodPlatform: "Plataforma",
    payOtherTerminal: "Otra terminal",
    payTerminal: "Terminal",
    payUseAsDefault: "Usar siempre en este dispositivo",
    payDefaultSaved: "Terminal predeterminada guardada",
    payTerminalManualOnly: "solo manual",
    payPlatform: "Plataforma",
    payPlatformOrderNumber: "Número de pedido de la plataforma (opcional)",
    payPlatformConfirm: "La plataforma ya cobró este pedido",
    payPlatformPaidIn: "Pagado en {platform}",
    payPlatformOtherName: "Nombre de la plataforma",
    payPlatformBalance:
      "La plataforma cubre todo el saldo: {amount}. Sin propina.",
    payPlatformPriceList: "Pedido con precios de {platform}",
    payCardOnTerminal: "Tarjeta · {terminal}",
    payCardLast4: "{brand} •••• {last4}",
    platformUberEats: "Uber Eats",
    platformRappi: "Rappi",
    platformDidi: "DiDi Food",
    platformOther: "Otra",
    // Ringing an order at a platform's prices (LD-72)
    payPriceList: "Precios",
    payPriceListPos: "Mostrador",
    payPriceListHint:
      "Los productos toman el precio de la plataforma; sin precio propio, el del mostrador.",
    payPriceListLocked:
      "La orden usa los precios de {platform}. Las rondas nuevas también.",
    // Configuración → Pagos con tarjeta y plataformas
    paySettingsTitle: "Pagos con tarjeta y plataformas",
    paySettingsHint:
      "Terminales de tarjeta con su comisión, plataformas de entrega y sus precios. Las comisiones solo las ven propietarios y gerentes.",
    payTerminals: "Terminales",
    payTerminalsEmpty:
      "Sin terminales. Agrega la terminal del banco para separar el corte por terminal.",
    payAddTerminal: "Agregar terminal",
    payEditTerminal: "Editar",
    payArchiveTerminal: "Archivar",
    payArchiveTerminalConfirm:
      "¿Archivar {name}? Sus cobros anteriores conservan el nombre.",
    payTerminalName: "Nombre",
    payTerminalKind: "Tipo",
    payTerminalKindManual: "Manual",
    payTerminalKindMp: "Mercado Pago Point",
    payTerminalKindClip: "Clip",
    payFeeRate: "Comisión (% con IVA)",
    payFeeRateHint: "Vacío: sin comisión registrada.",
    payTerminalState: "Estado",
    payTerminalActive: "Activa",
    payTerminalInactive: "Inactiva",
    payTerminalArchived: "Archivada",
    payDefaultOn: "Predeterminada en",
    payDeviceDefault: "Terminal predeterminada de este dispositivo",
    payNoDefault: "Sin terminal predeterminada",
    payIntegratedSoon:
      "Mercado Pago Point y Clip integrados llegan en la siguiente fase; mientras tanto regístralas como terminales manuales.",
    paySave: "Guardar",
    paySaved: "Guardado",
    payPlatforms: "Plataformas de entrega",
    payPlatformsHint:
      "Pedidos que la plataforma ya cobró. No cuentan como efectivo ni tarjeta.",
    payPlatformEnabled: "Activa",
    payCommission: "Comisión estimada (%)",
    payCommissionHint: "Vacío: sin comisión registrada.",
    payPlatformPrices: "Precios por plataforma",
    payPlatformPricesHint:
      "Precio de cada producto en cada plataforma. Vacío: se usa el precio del mostrador.",
    payPlatformPricesSearch: "Buscar producto",
    payPlatformPricesSaved: "Precios guardados",
    payPlatformPricesNone: "No hay plataformas activas.",
    payPosPrice: "Mostrador",
    payInvalidPercent: "Escribe un porcentaje válido (por ejemplo 3.6).",
    payInvalidPrice: "Escribe un precio válido.",
    // Drawer (Caja) and corte
    cashCardByTerminal: "Tarjeta por terminal",
    cashBatchTotal: "Total del lote",
    cashBatchDifference: "Diferencia del lote",
    cashPlatforms:
      "Pagado por plataformas (no cuenta como efectivo ni tarjeta)",
    cashUnresolvedAttempts:
      "Hay cobros en terminal sin resolver. Un gerente debe resolverlos antes de cerrar.",
    cashTerminalFees: "Comisiones estimadas",
    cashPlatformCommissions: "Comisiones de plataformas (estimadas)",
    cashKioskSales: "Del kiosco: {count} · {amount}",
    payAttemptKiosk: "Kiosco · {label}",
    payAttemptOrder: "Orden #{number}",
    // CFDI settings
    cfdiPlatformForm: "Forma de pago SAT para pedidos pagados por plataforma",
    cfdiPlatformFormHint:
      "Confírmala con tu contador antes de facturar en vivo. Nunca se usa 99 (se timbra PUE).",
    cfdiForm31:
      "31 Intermediario pagos (recomendado; confirma con tu contador)",
    cfdiForm03: "03 Transferencia electrónica de fondos",
    cfdiForm04: "04 Tarjeta de crédito",
    cfdiForm28: "28 Tarjeta de débito",
    // Reports
    payReportsByTerminal: "Por terminal",
    payReportsByPlatform: "Por plataforma",
    payReportsFees: "Comisiones",
    payReportsFeesEstimated: "estimadas",
    payReportsNetAfterFees: "Neto después de comisiones",
    payReportsCommission: "Comisión estimada",
    payReportsMarginAfterFees: "Margen después de comisiones",
    payReportsPlatformSales: "Plataformas",
    payRefundPlatform: "Reembolso por plataforma (sin efectivo)",
    payCsvProvider: "Proveedor",
    payCsvProviderReference: "Referencia del proveedor",
    payCsvCardBrand: "Marca de tarjeta",
    payCsvCardLast4: "Últimos 4",
    payCsvFeeSource: "Origen de la comisión",
    payCsvFeeProvider: "del proveedor",
    payOfflineSavePlatform: "Guardar pago por plataforma",
    payOfflineHintPlatform:
      "Sin conexión: el pago por plataforma se guarda en este dispositivo y se registra al reconectar. No cuenta como efectivo.",
    payProblemPlatformRequired: "Elige la plataforma.",
    payProblemPlatformName: "Escribe el nombre de la plataforma.",
    payProblemPlatformFullBalance:
      "La plataforma cubre todo el saldo: el importe debe ser el saldo completo.",
    payProblemPlatformReference:
      "El número de pedido admite hasta 40 caracteres.",
    payProblemPlatformConfirm:
      "Confirma que la plataforma ya cobró este pedido.",
    payOpTerminalSaved: "Terminal guardada",
    payOpTerminalArchived: "Terminal archivada",
    payOpPlatformsSaved: "Plataformas guardadas",
    payOpPlatformPricesSaved: "Precios por plataforma guardados",
    payOpDeviceTerminalSet: "Terminal predeterminada del dispositivo",
  },
  en: {
    payMethodCash: "Cash",
    payMethodCard: "Card",
    payMethodPlatform: "Platform",
    payOtherTerminal: "Other terminal",
    payTerminal: "Terminal",
    payUseAsDefault: "Always use on this device",
    payDefaultSaved: "Default terminal saved",
    payTerminalManualOnly: "manual only",
    payPlatform: "Platform",
    payPlatformOrderNumber: "Platform order number (optional)",
    payPlatformConfirm: "The platform already charged this order",
    payPlatformPaidIn: "Paid on {platform}",
    payPlatformOtherName: "Platform name",
    payPlatformBalance:
      "The platform covers the whole balance: {amount}. No tip.",
    payPlatformPriceList: "Order at {platform} prices",
    payCardOnTerminal: "Card · {terminal}",
    payCardLast4: "{brand} •••• {last4}",
    platformUberEats: "Uber Eats",
    platformRappi: "Rappi",
    platformDidi: "DiDi Food",
    platformOther: "Other",
    payPriceList: "Prices",
    payPriceListPos: "Counter",
    payPriceListHint:
      "Products take the platform's price; without their own price, the counter price.",
    payPriceListLocked: "The order uses {platform} prices. New rounds do too.",
    paySettingsTitle: "Card and platform payments",
    paySettingsHint:
      "Card terminals with their fees, delivery platforms and their prices. Only owners and managers see fees.",
    payTerminals: "Terminals",
    payTerminalsEmpty:
      "No terminals. Add the bank terminal to split the drawer close by terminal.",
    payAddTerminal: "Add terminal",
    payEditTerminal: "Edit",
    payArchiveTerminal: "Archive",
    payArchiveTerminalConfirm:
      "Archive {name}? Its earlier charges keep the name.",
    payTerminalName: "Name",
    payTerminalKind: "Type",
    payTerminalKindManual: "Manual",
    payTerminalKindMp: "Mercado Pago Point",
    payTerminalKindClip: "Clip",
    payFeeRate: "Fee (% incl. VAT)",
    payFeeRateHint: "Empty: no fee recorded.",
    payTerminalState: "Status",
    payTerminalActive: "Active",
    payTerminalInactive: "Inactive",
    payTerminalArchived: "Archived",
    payDefaultOn: "Default on",
    payDeviceDefault: "This device's default terminal",
    payNoDefault: "No default terminal",
    payIntegratedSoon:
      "Integrated Mercado Pago Point and Clip arrive in the next phase; meanwhile record them as manual terminals.",
    paySave: "Save",
    paySaved: "Saved",
    payPlatforms: "Delivery platforms",
    payPlatformsHint:
      "Orders the platform already charged. They count as neither cash nor card.",
    payPlatformEnabled: "Active",
    payCommission: "Estimated commission (%)",
    payCommissionHint: "Empty: no commission recorded.",
    payPlatformPrices: "Prices by platform",
    payPlatformPricesHint:
      "Each product's price on each platform. Empty: the counter price is used.",
    payPlatformPricesSearch: "Find a product",
    payPlatformPricesSaved: "Prices saved",
    payPlatformPricesNone: "No active platforms.",
    payPosPrice: "Counter",
    payInvalidPercent: "Enter a valid percentage (for example 3.6).",
    payInvalidPrice: "Enter a valid price.",
    cashCardByTerminal: "Card by terminal",
    cashBatchTotal: "Batch total",
    cashBatchDifference: "Batch difference",
    cashPlatforms: "Paid by platforms (not cash or card)",
    cashUnresolvedAttempts:
      "There are unresolved terminal charges. A manager must resolve them before closing.",
    cashTerminalFees: "Estimated fees",
    cashPlatformCommissions: "Platform commissions (estimated)",
    cashKioskSales: "From the kiosk: {count} · {amount}",
    payAttemptKiosk: "Kiosk · {label}",
    payAttemptOrder: "Order #{number}",
    cfdiPlatformForm: "SAT payment form for platform-paid orders",
    cfdiPlatformFormHint:
      "Confirm it with your accountant before invoicing live. 99 is never used (invoices are PUE).",
    cfdiForm31:
      "31 Payment intermediary (recommended; confirm with your accountant)",
    cfdiForm03: "03 Electronic funds transfer",
    cfdiForm04: "04 Credit card",
    cfdiForm28: "28 Debit card",
    payReportsByTerminal: "By terminal",
    payReportsByPlatform: "By platform",
    payReportsFees: "Fees",
    payReportsFeesEstimated: "estimated",
    payReportsNetAfterFees: "Net after fees",
    payReportsCommission: "Estimated commission",
    payReportsMarginAfterFees: "Margin after fees",
    payReportsPlatformSales: "Platforms",
    payRefundPlatform: "Platform refund (no cash)",
    payCsvProvider: "Provider",
    payCsvProviderReference: "Provider reference",
    payCsvCardBrand: "Card brand",
    payCsvCardLast4: "Last 4",
    payCsvFeeSource: "Fee source",
    payCsvFeeProvider: "from the provider",
    payOfflineSavePlatform: "Save platform payment",
    payOfflineHintPlatform:
      "Offline: the platform payment is saved on this device and recorded when you reconnect. It does not count as cash.",
    payProblemPlatformRequired: "Choose the platform.",
    payProblemPlatformName: "Enter the platform's name.",
    payProblemPlatformFullBalance:
      "The platform covers the whole balance: the amount must be the full balance.",
    payProblemPlatformReference: "The order number takes up to 40 characters.",
    payProblemPlatformConfirm:
      "Confirm that the platform already charged this order.",
    payOpTerminalSaved: "Terminal saved",
    payOpTerminalArchived: "Terminal archived",
    payOpPlatformsSaved: "Platforms saved",
    payOpPlatformPricesSaved: "Platform prices saved",
    payOpDeviceTerminalSet: "Device default terminal",
  },
  errors: {
    payments_provider_unavailable: [
      "El cobro integrado no está disponible por ahora. Usa Terminal externa.",
      "Integrated charging is not available right now. Use External terminal.",
    ],
    payments_provider_not_configured: [
      "Conecta la cuenta del proveedor en Configuración antes de usar esta terminal integrada.",
      "Connect the provider account in Settings before using this integrated terminal.",
    ],
    payments_terminal_not_found: [
      "Esa terminal ya no existe. Elige otra.",
      "That terminal no longer exists. Choose another one.",
    ],
    payments_terminal_inactive: [
      "Esa terminal está archivada o inactiva. Elige otra.",
      "That terminal is archived or inactive. Choose another one.",
    ],
    payments_terminal_not_integrated: [
      "Esa terminal no está integrada: registra el cobro manualmente.",
      "That terminal is not integrated: record the charge manually.",
    ],
    payments_terminal_busy: [
      "Terminal en uso: hay otro cobro en proceso. Inténtalo en unos segundos.",
      "Terminal in use: another charge is in progress. Try again in a few seconds.",
    ],
    payments_terminal_limit: [
      "Llegaste al máximo de 20 terminales activas. Archiva una antes de agregar otra.",
      "You reached the limit of 20 active terminals. Archive one before adding another.",
    ],
    payments_terminal_name_taken: [
      "Ya hay una terminal con ese nombre.",
      "There is already a terminal with that name.",
    ],
    payments_device_taken: [
      "Ese dispositivo del proveedor ya está configurado en otra terminal.",
      "That provider device is already configured on another terminal.",
    ],
    payments_order_attempt_live: [
      "Esta orden tiene un cobro en terminal en curso. Espera a que termine o pide a un gerente que lo resuelva.",
      "This order has a terminal charge in progress. Wait for it to finish or ask a manager to resolve it.",
    ],
    payments_attempt_unresolved: [
      "Hay cobros en terminal sin resolver. Un gerente debe resolverlos antes de cerrar.",
      "There are unresolved terminal charges. A manager must resolve them before closing.",
    ],
    payments_attempts_live: [
      "Hay cobros en terminal en curso. Espera a que terminen.",
      "There are terminal charges in progress. Wait for them to finish.",
    ],
    payments_amount_below_min: [
      "El importe es menor al mínimo de la terminal ($5.00).",
      "The amount is below the terminal's minimum ($5.00).",
    ],
    payments_currency_unsupported: [
      "La terminal integrada solo cobra en pesos mexicanos.",
      "The integrated terminal only charges in Mexican pesos.",
    ],
    payments_attempt_not_found: [
      "No encontramos ese cobro en terminal.",
      "We could not find that terminal charge.",
    ],
    payments_not_cancellable: [
      "Ya se cobró: no se puede cancelar.",
      "It was already charged: it cannot be cancelled.",
    ],
    payments_cancel_on_terminal: [
      "La terminal ya tomó el cobro. Cancélalo en la terminal.",
      "The terminal already took the charge. Cancel it on the terminal.",
    ],
    payments_not_approved: [
      "Ese cobro no está aprobado.",
      "That charge is not approved.",
    ],
    payments_settle_order_changed: [
      "El cobro se aprobó pero la orden cambió. Un gerente debe resolverlo.",
      "The charge was approved but the order changed. A manager must resolve it.",
    ],
    payments_paid_short: [
      "La terminal cobró menos de lo pedido. Un gerente debe resolverlo.",
      "The terminal charged less than requested. A manager must resolve it.",
    ],
    payments_allocation_changed: [
      "Los productos de este pago cambiaron. Un gerente debe resolverlo.",
      "The items of this payment changed. A manager must resolve it.",
    ],
    payments_provider_mismatch: [
      "Los datos del proveedor no coinciden con este cobro. Un gerente debe revisarlo.",
      "The provider's data do not match this charge. A manager must review it.",
    ],
    payments_provider_says_paid: [
      "El proveedor reporta el cobro como pagado: no se puede marcar como no cobrado.",
      "The provider reports the charge as paid: it cannot be marked as not charged.",
    ],
    payments_reference_required: [
      "Escribe la referencia del proveedor.",
      "Enter the provider's reference.",
    ],
    payments_note_required: [
      "Explica la resolución (al menos 10 caracteres).",
      "Explain the resolution (at least 10 characters).",
    ],
    payments_platform_required: [
      "Elige la plataforma (y escribe su nombre si es Otra).",
      "Choose the platform (and type its name if it is Other).",
    ],
    payments_platform_disabled: [
      "Esa plataforma está desactivada en Configuración.",
      "That platform is turned off in Settings.",
    ],
    payments_platform_full_balance: [
      "La plataforma debe cubrir todo el saldo de la orden.",
      "The platform must cover the order's whole balance.",
    ],
    payments_platform_no_tip: [
      "Un pago por plataforma no lleva propina.",
      "A platform payment carries no tip.",
    ],
    payments_platform_confirm_required: [
      "Confirma que la plataforma ya cobró este pedido.",
      "Confirm that the platform already charged this order.",
    ],
    payments_platform_price_list: [
      "La orden se registró con precios de otra plataforma. Cóbrala con esa plataforma.",
      "The order was rung at another platform's prices. Charge it with that platform.",
    ],
    payments_platform_refund_requires_batch: [
      "Reembolsa los pagos por plataforma desde Reembolsar en la orden.",
      "Refund platform payments from Refund on the order.",
    ],
    payments_price_changed: [
      "Alguien cambió estos precios. Revisa y vuelve a guardar.",
      "Someone changed these prices. Review and save again.",
    ],
    payments_settings_changed: [
      "Alguien cambió esta configuración. Revisa y vuelve a guardar.",
      "Someone changed these settings. Review and save again.",
    ],
    payments_credentials_invalid_format: [
      "Las credenciales no tienen el formato esperado. Cópialas de nuevo del portal del proveedor.",
      "The credentials do not have the expected format. Copy them again from the provider's portal.",
    ],
    payments_credentials_rejected: [
      "El proveedor rechazó las credenciales.",
      "The provider rejected the credentials.",
    ],
    payments_account_country: [
      "La cuenta de Mercado Pago no es de México.",
      "The Mercado Pago account is not from Mexico.",
    ],
    payments_upload_unavailable: [
      "No se pueden guardar credenciales por ahora. Inténtalo más tarde.",
      "Credentials cannot be saved right now. Try again later.",
    ],
    payments_provider_unreachable: [
      "No pudimos comunicarnos con el proveedor. Cobra sin integración si es urgente.",
      "We could not reach the provider. Charge without integration if it is urgent.",
    ],
    payments_provider_rejected: [
      "El proveedor rechazó la solicitud.",
      "The provider rejected the request.",
    ],
    payments_terminal_offline: [
      "La terminal no está conectada.",
      "The terminal is not connected.",
    ],
    payments_terminal_queue_busy: [
      "La terminal tiene un cobro pendiente. Cancélalo en la terminal o reiníciala.",
      "The terminal has a pending charge. Cancel it on the terminal or restart it.",
    ],
    payments_device_mode_rejected: [
      "El proveedor no aceptó el cambio de modo.",
      "The provider did not accept the mode change.",
    ],
    payments_clip_create_outcome_unknown: [
      "No sabemos si Clip recibió el cobro. Revisa el lector antes de intentar otra vez.",
      "We don't know whether Clip received the charge. Check the reader before trying again.",
    ],
    payments_refunded_before_settle: [
      "El cobro se reembolsó en el proveedor antes de registrarse.",
      "The charge was refunded at the provider before it was recorded.",
    ],
    payments_terminal_unknown: [
      "La terminal registrada sin conexión ya no existe; el cobro se guardó sin terminal.",
      "The terminal recorded offline no longer exists; the charge was saved without a terminal.",
    ],
    report_method_unknown: [
      "Hay un pago con una forma de pago desconocida. Contacta a soporte.",
      "There is a payment with an unknown method. Contact support.",
    ],
    cfdi_payment_method_unknown: [
      "Este ticket tiene una forma de pago que no se puede facturar. Contacta a soporte.",
      "This ticket has a payment method that cannot be invoiced. Contact support.",
    ],
  },
});
