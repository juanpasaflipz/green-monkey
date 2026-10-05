import { defineArea } from "./define";

export default defineArea({
  es: {
    offlineStatusOnline: "Conectado",
    offlineStatusOffline: "Sin conexión",
    offlineStatusManual: "Sin conexión (manual)",
    offlineStatusSlow: "Conexión lenta",
    offlineStatusSyncing: "Sincronizando",
    offlineQueuedCount: "{n} por sincronizar",
    offlineBannerOffline:
      "Sin conexión con el servidor. Las ventas se guardan en este dispositivo y se envían al volver la conexión.",
    offlineBannerManual:
      "Trabajando sin conexión por decisión del equipo. Las ventas se guardan en este dispositivo.",
    offlineBannerAvailable: "La conexión volvió.",
    offlineBannerSlow:
      "La conexión está lenta. Si los cobros tardan, trabaja sin conexión.",
    offlineBannerKitchen:
      "Sin conexión: esta pantalla no recibe pedidos nuevos. Pide las comandas impresas o en voz al mostrador.",
    offlineWindowUntil: "Puedes vender sin conexión hasta las {time}.",
    offlineWindowEnding:
      "El periodo sin conexión termina a las {time}. Conecta el dispositivo antes para renovarlo.",
    offlineWindowExpired:
      "El periodo sin conexión terminó a las {time}. No se pueden guardar ventas nuevas hasta reconectar e iniciar sesión. Usa papel y captúralas después.",
    offlineFiscalLate:
      "Hay ventas sin sincronizar de hace más de 20 horas. Si no se sincronizan pronto, su factura global se emitirá fuera de plazo; conéctate o pide a un gerente que las revise.",
    offlineClockSkew:
      "La hora de este dispositivo difiere {min} min de la del servidor. Activa la hora automática.",
    offlineLastContact: "Último contacto con el servidor: {time}",
    offlineNeverContacted:
      "Sin contacto con el servidor desde que se abrió la app.",
    offlineWorkOffline: "Trabajar sin conexión",
    offlineGoOnline: "Volver a conectarme",
    offlineWorkOfflineHint:
      "Las ventas se guardan en este dispositivo; la sincronización sigue en segundo plano cuando hay conexión.",
    offlineViewSync: "Ver sincronización",
    offlineTickets: "Comandas ({n})",
    offlineSendLocal: "Enviar (sin conexión)",
    offlineSaveExternal: "Guardar cobro con terminal",
    offlineHintCash:
      "Sin conexión: el cobro se guarda en este dispositivo. Cocina no recibe la orden por la red; imprime o canta la comanda.",
    offlineHintExternal:
      "Confirma que la terminal aprobó el cobro y escribe su referencia. No se verifica con el banco.",
    offlineProvisional: "Número provisional {n}",
    offlineProvisionalHint: "El número definitivo se asigna al sincronizar.",
    offlinePrintKitchen: "Imprimir comanda",
    offlinePrintReceipt: "Imprimir recibo",
    offlinePrintSetting: "Al guardar sin conexión",
    offlinePrintAsk: "Preguntar",
    offlinePrintAutoKitchen: "Imprimir comanda",
    offlinePrintAutoBoth: "Imprimir comanda y recibo",
    offlineTicketHeader: "COMANDA · SIN CONEXIÓN",
    offlineTicketFooter:
      "Número provisional. Se sincroniza al volver la conexión.",
    offlineTicketRound: "Ronda {n}",
    offlineTicketsTitle: "Comandas sin conexión",
    offlineTicketsHint:
      "Lista local de este dispositivo. Cocina no la ve; úsala para cantar y reimprimir comandas.",
    offlineTicketsEmpty:
      "No hay comandas sin conexión en las últimas 24 horas.",
    offlineTicketPending: "Pendiente",
    offlineTicketReady: "Lista",
    offlineTicketDelivered: "Entregada",
    offlineReprint: "Reimprimir",
    offlineOpenOrders: "Órdenes abiertas",
    offlineOpenOrdersCached:
      "Órdenes guardadas antes de perder la conexión ({time})",
    offlineOpenOrdersLocal: "Órdenes creadas en este dispositivo",
    offlineOpenOrdersEmpty:
      "No hay órdenes abiertas guardadas en este dispositivo.",
    offlineKindSale: "Venta",
    offlineKindOrder: "Orden enviada",
    offlineKindRound: "Ronda",
    offlineKindPayment: "Cobro",
    offlineRowPending: "Pendiente",
    offlineRowSyncing: "Sincronizando",
    offlineRowConflict: "Requiere revisión",
    offlineRowSynced: "Registrado en el servidor",
    offlineRowArchived: "Archivado",
    offlineRowWaitingAuth: "Esperando inicio de sesión",
    offlineRowWaitingDependency: "Esperando la orden original",
    offlineNextAttempt: "Siguiente intento en {s} s",
    offlineMapped: "{provisional} → #{number}",
    offlineReview: "Revisar",
    offlineReviewCash: "Revisar efectivo",
    offlineReconcile: "Conciliar cobro",
    offlineArchive: "Archivar registro local",
    offlineArchiveTitle: "Archivar sin registrar venta",
    offlineArchiveWarning:
      "El registro no se sumará a ventas ni a caja. Se guarda una copia en el servidor con tu nombre y el motivo. Úsalo solo si no se puede verificar o ya se capturó de otra forma.",
    offlineArchiveReason: "Motivo",
    offlineArchiveConfirm: "Entiendo que este registro no se sumará a ventas.",
    offlineArchiveSubmit: "Archivar",
    offlineArchivedList: "Registros locales archivados",
    offlineArchivedBy: "Archivado por {name}",
    offlineArchivedDrawerNote:
      "Este dispositivo archivó {amount} de ventas locales de esta caja. Ese efectivo puede aparecer como sobrante.",
    offlineArchivedDrawerTerminal:
      "También archivó {amount} de cobros con terminal de esta caja; no afectan el efectivo.",
    offlineAttemptParked:
      "Un pago anterior requiere revisión de un gerente en Sincronización; no cobres otra vez esa orden. Puedes seguir con otras órdenes.",
    offlineAttemptResolvedOther:
      "El pago anterior de la orden #{n} sí se registró.",
    offlineAttemptInReview: "En revisión",
    offlineKitchenReviewTitle: "Ventas sin conexión por revisar ({n})",
    offlineKitchenReviewHint:
      "Se vendieron sin conexión. Confirma si cocina ya las preparó para no repetirlas.",
    offlineKitchenAlreadyServed: "Ya se preparó",
    offlineKitchenPrepare: "Preparar ahora",
    offlineKitchenAllServed: "Marcar todas como ya preparadas",
    offlineKitchenAllServedConfirm:
      "¿Marcar {n} comandas como ya preparadas? No aparecerán en cocina.",
    offlineKitchenSold: "Vendida {time} · sincronizada {synced}",
    offlineKitchenDeliveryPrinted: "Comanda impresa en caja",
    offlineKitchenDeliveryList: "Comanda en la lista del dispositivo",
    offlineUpdateReady: "Hay una nueva versión lista.",
    offlineUpdateApply: "Actualizar ahora",
    offlineUpdateBlocked:
      "Sincroniza las ventas pendientes antes de actualizar.",
    offlineUnsupportedTitle: "Este navegador no es compatible",
    offlineUnsupportedBody:
      "Green Monkey necesita Chrome o Edge 111+, Safari 16.4+ (iPadOS/iOS 16.4 o posterior) o Firefox 114+. Actualiza el navegador o usa otro dispositivo.",
    offlineNoServiceWorker:
      "Este navegador no permite abrir la app sin conexión (por ejemplo, en modo privado).",
    offlineInstallHint:
      "Instala Green Monkey en la pantalla de inicio para conservar mejor los datos sin conexión.",
    offlinePersistGranted:
      "Conservación local concedida automáticamente; no sustituye una copia.",
    offlinePersistDenied:
      "El navegador no concedió la conservación local. Descarga una copia con frecuencia.",
    offlineLoginNoServer:
      "Sin conexión con el servidor. Iniciar sesión requiere conexión.",
    offlineLoginPending:
      "Este dispositivo tiene {n} registros sin sincronizar. Se enviarán cuando la misma persona inicie sesión en este dispositivo, o un gerente puede revisarlos.",
    offlineLoginDownload: "Descargar respaldo",
    offlineSyncCounts:
      "{pending} pendientes · {conflict} por revisar · {synced} registrados · {archived} archivados",
    offlineLoadMore: "Cargar más",
    offlineRecordedAt: "Registrado {time}",
    offlineCancel: "Cancelar",
    offlineDecided: "Otra persona ya decidió esta comanda.",
    offlineOpSynced: "Venta sin conexión sincronizada",
    offlineOpKitchenDecision: "Decisión de cocina sobre venta sin conexión",
    offlineOpArchived: "Registro local archivado",
    offlineOpPaymentReconciled: "Cobro sin conexión conciliado",
    offlineOpSettingsChanged: "Servicio de mesa sin conexión cambiado",
    offlinePayCachedWarning:
      "Esta orden se guardó antes de perder la conexión. Si pudo cobrarse en otro dispositivo, no la cobres hasta confirmarlo.",
    offlineSentToDevice:
      "Comanda guardada en este dispositivo. Cocina no la recibe por la red: imprímela o cántala.",
    offlineAvailableOnReconnect:
      "Disponible al volver la conexión. Sin conexión, esta cuenta no acepta productos ni cobros en este restaurante.",
    offlineTableServiceOffHint:
      "Sin conexión solo se cobran órdenes nuevas completas. Enviar a cocina sin cobrar estará disponible al volver la conexión.",
    offlineTableServiceTitle: "Servicio de mesa sin conexión",
    offlineTableServiceBeta: "Beta",
    offlineTableServiceHint:
      "Permite, sin conexión, enviar a cocina sin cobrar, agregar rondas y cobrar cuentas abiertas (completas o en partes). Está en prueba y viene apagado. Apagado, sin conexión solo se cobran órdenes nuevas completas, en efectivo o con terminal externa.",
    offlineTableServiceOn: "Activar servicio de mesa sin conexión",
    offlineTableServiceUnknown:
      "Conéctate para consultar o cambiar este ajuste.",
    offlineKitchenOtherStation: "{n} por revisar en {station}.",
    offlineLoginManual:
      "Este dispositivo está en modo sin conexión. Puedes iniciar sesión; las ventas se guardarán aquí hasta que vuelvas a conectarte.",
    offlineReconcileIntoOrder:
      "Registraremos el cobro en la orden #{n}, en la caja original. No se cobra al cliente otra vez. Si a la orden le queda saldo, cóbralo o anúlalo en la orden.",
    offlineReconcileIntoOrderConfirm:
      "Verifiqué el dinero original y que corresponde a la orden #{n}.",
    offlineExistingOrderCharge:
      "Esta venta ya existe en línea como la orden #{n}, con saldo de {due}, y no se puede conciliar aquí. Cobra esa orden en línea con el dinero ya recibido, sin cobrarle otra vez al cliente, y archiva este registro.",
    offlineExistingOrderPaid:
      "Esta venta ya existe en línea como la orden #{n} y no le queda saldo. No cobres otra vez: archiva este registro con el motivo.",
    offlineExistingOrderSent:
      "Esta orden ya existe en línea como la #{n} y la cocina ya la recibió. Archiva este registro: sus cobros sin conexión se podrán conciliar en la orden #{n}.",
    offlineExistingOrderWillSync:
      "Esta orden ya existe en línea como la #{n} y la cocina ya la recibió. Este registro se sincroniza con ella: no lo archives.",
    offlineExistingOrderOtherDraft:
      "Con el mismo identificador ya existe en línea la orden #{n}, con otros productos. Este registro no se puede sincronizar: archívalo. Sus cobros sin conexión se conciliarán solo como dinero; agrega en línea los productos que falten.",
    offlineDependentsRounds:
      "Sus rondas sin conexión no se pueden conciliar. Antes de conciliar sus cobros o de cobrar la orden #{n}, agrégalas en línea a la orden #{n}:",
    offlineDependentRound: "Ronda: {items}",
    offlineDependentPayment: "Cobro sin conexión de {amount}",
    offlineReviewTitleCash: "Conciliar efectivo ya recibido",
    offlineReviewTitleExternal: "Conciliar cobro con terminal ya recibido",
    offlineReviewTitleOrder: "Revisar orden enviada",
    offlineReviewTitleRound: "Revisar ronda",
    offlineReviewExternal: "Revisar cobro con terminal",
    offlineMethodCash: "efectivo",
    offlineMethodExternal: "terminal externa",
    offlineReviewSession: "Sesión original",
    offlineReviewSessionRevoked:
      "revocada (empleado o dispositivo dado de baja)",
    offlineReviewSessionValid: "válida",
    offlineReviewOnServer: "En el servidor",
    offlineReviewRecorded: "ya registrado",
    offlineReviewArchived: "archivado",
    offlineReviewNotYet: "aún no",
    offlineAutoSyncOther:
      "Este registro se envía solo cuando {name} inicie sesión en {device}. Concilia solo si eso no es posible: conciliar conserva el dinero, pero no los productos, la cocina ni el inventario.",
    offlineAutoSyncSelf:
      "Este registro se envía solo desde este dispositivo con tu sesión: usa Reintentar sincronización. Concilia solo si no se sincroniza.",
    offlineReconcileAnyway: "Conciliar de todos modos",
    offlineMarkRecorded: "Marcar como registrado",
    offlineAlreadyRecorded:
      "Este registro ya está en el servidor: no lo concilies ni lo archives. Márcalo como registrado.",
    offlineAlreadyArchived: "Este registro ya se archivó en el servidor.",
    offlineNoMoney:
      "Las órdenes enviadas y las rondas no llevan cobro que conciliar: se sincronizan solas o se archivan. Si archivas una, agrega sus productos en línea.",
    offlineNotReconcilable:
      "No se puede conciliar por el motivo indicado. Archívalo solo si el dinero ya se registró de otra forma o se devolvió al cliente.",
    offlineReconcileRecovery:
      "Conservaremos el importe original en la caja original. No se cobra al cliente otra vez. No se reconstruyen precios por producto ni se envía a cocina o descuenta inventario; revisa esas tareas por separado.",
    offlineReconcileRecoveryExternal:
      "Registraremos el cobro con terminal original en la caja original, como una orden de conciliación; no suma efectivo a la caja. No se cobra al cliente otra vez. No se reconstruyen precios por producto ni se envía a cocina o descuenta inventario; revisa esas tareas por separado.",
    offlineReconcileConfirmCash:
      "Verifiqué el efectivo original y revisaré cocina e inventario.",
    offlineReconcileConfirmExternal:
      "Verifiqué el cobro con terminal original y su referencia, y revisaré cocina e inventario.",
    offlineReconcileConfirmIntoOrderExternal:
      "Verifiqué el cobro con terminal original y que corresponde a la orden #{n}.",
    offlineReconcileReason: "Motivo de conciliación",
    offlineReconcileSubmitCash: "Registrar efectivo verificado",
    offlineReconcileSubmitExternal: "Registrar cobro verificado",
    offlineRetryScope:
      "Reintentar envía los registros de {name} en este dispositivo. Los de otras personas se envían cuando esa persona inicia sesión aquí.",
    offlineRowOtherEmployee:
      "Lo registró otra persona: se envía cuando esa persona inicie sesión en este dispositivo. Reintentar no lo envía.",
    offlineAttemptRecord: "Registrar cobro verificado",
    offlineAttemptDiscard: "Descartar intento (no se cobró)",
    offlineAttemptRecordHint:
      "Registraremos este cobro en su orden, en la caja original del intento. Hazlo solo si verificaste que el cliente pagó; no se le cobra otra vez.",
    offlineAttemptDiscardHint:
      "El intento se cierra sin registrar dinero y la orden vuelve a poder cobrarse. Hazlo solo si verificaste que el cliente no pagó.",
    offlineAttemptReason: "Motivo",
    offlineAttemptConfirm: "Lo verifiqué con la caja y con el cliente.",
    offlineAttemptSubmitRecord: "Registrar cobro",
    offlineAttemptSubmitDiscard: "Descartar intento",
    offlineAttemptDiscarded: "Un gerente descartó este intento: no se cobró.",
    offlineAttemptDismiss: "Cerrar intento",
    offlineOpAttemptRecorded: "Pago por confirmar registrado por un gerente",
    offlineOpAttemptDiscarded: "Pago por confirmar descartado por un gerente",
  },
  en: {
    offlineStatusOnline: "Connected",
    offlineStatusOffline: "Offline",
    offlineStatusManual: "Offline (manual)",
    offlineStatusSlow: "Slow connection",
    offlineStatusSyncing: "Syncing",
    offlineQueuedCount: "{n} to sync",
    offlineBannerOffline:
      "No connection to the server. Sales are saved on this device and sent when the connection returns.",
    offlineBannerManual:
      "Working offline by choice. Sales are saved on this device.",
    offlineBannerAvailable: "The connection is back.",
    offlineBannerSlow:
      "The connection is slow. If payments take too long, work offline.",
    offlineBannerKitchen:
      "Offline: this screen is not receiving new orders. Ask the counter for printed or called-out tickets.",
    offlineWindowUntil: "You can sell offline until {time}.",
    offlineWindowEnding:
      "The offline period ends at {time}. Reconnect before then to renew it.",
    offlineWindowExpired:
      "The offline period ended at {time}. New sales cannot be saved until you reconnect and sign in. Use paper and enter them later.",
    offlineFiscalLate:
      "Some sales have been unsynced for more than 20 hours. If they do not sync soon, their global invoice will be issued late; reconnect or ask a manager to review them.",
    offlineClockSkew:
      "This device's clock differs from the server by {min} min. Turn on automatic time.",
    offlineLastContact: "Last server contact: {time}",
    offlineNeverContacted: "No server contact since the app opened.",
    offlineWorkOffline: "Work offline",
    offlineGoOnline: "Go back online",
    offlineWorkOfflineHint:
      "Sales are saved on this device; sync continues in the background whenever the server is reachable.",
    offlineViewSync: "View sync",
    offlineTickets: "Tickets ({n})",
    offlineSendLocal: "Send (offline)",
    offlineSaveExternal: "Save terminal payment",
    offlineHintCash:
      "Offline: the payment is saved on this device. The kitchen does not receive the order over the network; print or call out the ticket.",
    offlineHintExternal:
      "Confirm the terminal approved the charge and enter its reference. It is not verified with the bank.",
    offlineProvisional: "Provisional number {n}",
    offlineProvisionalHint: "The final number is assigned when it syncs.",
    offlinePrintKitchen: "Print kitchen ticket",
    offlinePrintReceipt: "Print receipt",
    offlinePrintSetting: "When saving offline",
    offlinePrintAsk: "Ask",
    offlinePrintAutoKitchen: "Print kitchen ticket",
    offlinePrintAutoBoth: "Print ticket and receipt",
    offlineTicketHeader: "KITCHEN TICKET · OFFLINE",
    offlineTicketFooter:
      "Provisional number. Syncs when the connection returns.",
    offlineTicketRound: "Round {n}",
    offlineTicketsTitle: "Offline tickets",
    offlineTicketsHint:
      "Local list on this device. The kitchen cannot see it; use it to call out and reprint tickets.",
    offlineTicketsEmpty: "No offline tickets in the last 24 hours.",
    offlineTicketPending: "Pending",
    offlineTicketReady: "Ready",
    offlineTicketDelivered: "Delivered",
    offlineReprint: "Reprint",
    offlineOpenOrders: "Open orders",
    offlineOpenOrdersCached:
      "Orders saved before the connection dropped ({time})",
    offlineOpenOrdersLocal: "Orders created on this device",
    offlineOpenOrdersEmpty: "No open orders are saved on this device.",
    offlineKindSale: "Sale",
    offlineKindOrder: "Order sent",
    offlineKindRound: "Round",
    offlineKindPayment: "Payment",
    offlineRowPending: "Pending",
    offlineRowSyncing: "Syncing",
    offlineRowConflict: "Needs review",
    offlineRowSynced: "Recorded on server",
    offlineRowArchived: "Archived",
    offlineRowWaitingAuth: "Waiting for sign-in",
    offlineRowWaitingDependency: "Waiting for the original order",
    offlineNextAttempt: "Next attempt in {s} s",
    offlineMapped: "{provisional} → #{number}",
    offlineReview: "Review",
    offlineReviewCash: "Review cash",
    offlineReconcile: "Reconcile payment",
    offlineArchive: "Archive local record",
    offlineArchiveTitle: "Archive without recording a sale",
    offlineArchiveWarning:
      "The record will not be added to sales or the drawer. A copy is kept on the server with your name and reason. Use this only if it cannot be verified or was already entered another way.",
    offlineArchiveReason: "Reason",
    offlineArchiveConfirm:
      "I understand this record will not be added to sales.",
    offlineArchiveSubmit: "Archive",
    offlineArchivedList: "Archived local records",
    offlineArchivedBy: "Archived by {name}",
    offlineArchivedDrawerNote:
      "This device archived {amount} of local sales from this drawer. That cash may show as an overage.",
    offlineArchivedDrawerTerminal:
      "It also archived {amount} of terminal payments from this drawer; they do not affect the cash.",
    offlineAttemptParked:
      "An earlier payment needs manager review in Sync; do not charge that order again. You can continue with other orders.",
    offlineAttemptResolvedOther:
      "The earlier payment for order #{n} was recorded.",
    offlineAttemptInReview: "In review",
    offlineKitchenReviewTitle: "Offline sales to review ({n})",
    offlineKitchenReviewHint:
      "These were sold offline. Confirm whether the kitchen already prepared them so they are not made twice.",
    offlineKitchenAlreadyServed: "Already prepared",
    offlineKitchenPrepare: "Prepare now",
    offlineKitchenAllServed: "Mark all as already prepared",
    offlineKitchenAllServedConfirm:
      "Mark {n} tickets as already prepared? They will not appear in the kitchen.",
    offlineKitchenSold: "Sold {time} · synced {synced}",
    offlineKitchenDeliveryPrinted: "Ticket printed at the counter",
    offlineKitchenDeliveryList: "Ticket on the device list",
    offlineUpdateReady: "A new version is ready.",
    offlineUpdateApply: "Update now",
    offlineUpdateBlocked: "Sync pending sales before updating.",
    offlineUnsupportedTitle: "This browser is not supported",
    offlineUnsupportedBody:
      "Green Monkey needs Chrome or Edge 111+, Safari 16.4+ (iPadOS/iOS 16.4 or later) or Firefox 114+. Update the browser or use another device.",
    offlineNoServiceWorker:
      "This browser cannot open the app offline (for example, in private mode).",
    offlineInstallHint:
      "Install Green Monkey on the home screen to better preserve offline data.",
    offlinePersistGranted:
      "Local persistence granted automatically; it does not replace a backup.",
    offlinePersistDenied:
      "The browser did not grant local persistence. Download a backup often.",
    offlineLoginNoServer:
      "No connection to the server. Signing in requires a connection.",
    offlineLoginPending:
      "This device has {n} unsynced records. They will be sent when the same person signs in on this device, or a manager can review them.",
    offlineLoginDownload: "Download backup",
    offlineSyncCounts:
      "{pending} pending · {conflict} to review · {synced} recorded · {archived} archived",
    offlineLoadMore: "Load more",
    offlineRecordedAt: "Recorded {time}",
    offlineCancel: "Cancel",
    offlineDecided: "Someone else already decided this ticket.",
    offlineOpSynced: "Offline sale synced",
    offlineOpKitchenDecision: "Kitchen decision on an offline sale",
    offlineOpArchived: "Local record archived",
    offlineOpPaymentReconciled: "Offline payment reconciled",
    offlineOpSettingsChanged: "Offline table service changed",
    offlinePayCachedWarning:
      "This order was saved before the connection dropped. If it may have been paid on another device, do not charge it until you confirm.",
    offlineSentToDevice:
      "Kitchen ticket saved on this device. The kitchen does not receive it over the network: print it or call it out.",
    offlineAvailableOnReconnect:
      "Available when the connection returns. Offline, this check takes no items or payments in this restaurant.",
    offlineTableServiceOffHint:
      "Offline, only new orders paid in full can be saved. Sending to the kitchen without paying is available when the connection returns.",
    offlineTableServiceTitle: "Offline table service",
    offlineTableServiceBeta: "Beta",
    offlineTableServiceHint:
      "Lets staff, while offline, send to the kitchen without paying, add rounds and charge open checks (in full or in part). It is in testing and off by default. When off, offline selling is limited to new orders paid in full, in cash or by an external terminal.",
    offlineTableServiceOn: "Turn on offline table service",
    offlineTableServiceUnknown: "Connect to read or change this setting.",
    offlineKitchenOtherStation: "{n} to review at {station}.",
    offlineLoginManual:
      "This device is in offline mode. You can sign in; sales are saved here until you go back online.",
    offlineReconcileIntoOrder:
      "We will record the payment on order #{n}, in the original drawer. The customer is not charged again. If the order still has a balance, collect or void it on the order.",
    offlineReconcileIntoOrderConfirm:
      "I verified the original money and that it belongs to order #{n}.",
    offlineExistingOrderCharge:
      "This sale already exists online as order #{n}, with a balance of {due}, and cannot be reconciled here. Charge that order online with the money already received, without charging the customer again, and archive this record.",
    offlineExistingOrderPaid:
      "This sale already exists online as order #{n} and has no balance left. Do not charge again: archive this record with the reason.",
    offlineExistingOrderSent:
      "This order already exists online as #{n} and the kitchen already received it. Archive this record: its offline payments can then be reconciled on order #{n}.",
    offlineExistingOrderWillSync:
      "This order already exists online as #{n} and the kitchen already received it. This record syncs into it: do not archive it.",
    offlineExistingOrderOtherDraft:
      "Order #{n} already exists online under the same identifier, with other items. This record cannot sync: archive it. Its offline payments will be reconciled as money only; add any missing items online.",
    offlineDependentsRounds:
      "Its offline rounds cannot be reconciled. Before reconciling its payments or charging order #{n}, add them online to order #{n}:",
    offlineDependentRound: "Round: {items}",
    offlineDependentPayment: "Offline payment of {amount}",
    offlineReviewTitleCash: "Reconcile cash already received",
    offlineReviewTitleExternal: "Reconcile terminal payment already received",
    offlineReviewTitleOrder: "Review sent order",
    offlineReviewTitleRound: "Review round",
    offlineReviewExternal: "Review terminal payment",
    offlineMethodCash: "cash",
    offlineMethodExternal: "external terminal",
    offlineReviewSession: "Original session",
    offlineReviewSessionRevoked: "revoked (employee or device deactivated)",
    offlineReviewSessionValid: "valid",
    offlineReviewOnServer: "On the server",
    offlineReviewRecorded: "already recorded",
    offlineReviewArchived: "archived",
    offlineReviewNotYet: "not yet",
    offlineAutoSyncOther:
      "This record is sent by itself when {name} signs in on {device}. Reconcile only if that is not possible: reconciling keeps the money, but not the items, the kitchen or the inventory.",
    offlineAutoSyncSelf:
      "This record is sent by itself from this device with your session: use Retry sync. Reconcile only if it does not sync.",
    offlineReconcileAnyway: "Reconcile anyway",
    offlineMarkRecorded: "Mark as recorded",
    offlineAlreadyRecorded:
      "This record is already on the server: do not reconcile or archive it. Mark it as recorded.",
    offlineAlreadyArchived: "This record was already archived on the server.",
    offlineNoMoney:
      "Sent orders and rounds carry no payment to reconcile: they sync by themselves or are archived. If you archive one, add its items online.",
    offlineNotReconcilable:
      "It cannot be reconciled for the reason shown. Archive it only if the money was already recorded another way or returned to the guest.",
    offlineReconcileRecovery:
      "We will preserve the original amount in the original drawer. The customer is not charged again. Item prices are not reconstructed, kitchen tickets are not sent and inventory is not deducted; review those tasks separately.",
    offlineReconcileRecoveryExternal:
      "We will record the original terminal payment in the original drawer, as a reconciliation order; it adds no cash to the drawer. The customer is not charged again. Item prices are not reconstructed, kitchen tickets are not sent and inventory is not deducted; review those tasks separately.",
    offlineReconcileConfirmCash:
      "I verified the original cash and will review kitchen and inventory.",
    offlineReconcileConfirmExternal:
      "I verified the original terminal payment and its reference, and will review kitchen and inventory.",
    offlineReconcileConfirmIntoOrderExternal:
      "I verified the original terminal payment and that it belongs to order #{n}.",
    offlineReconcileReason: "Reconciliation reason",
    offlineReconcileSubmitCash: "Record verified cash",
    offlineReconcileSubmitExternal: "Record verified payment",
    offlineRetryScope:
      "Retry sends {name}'s records on this device. Other people's records are sent when that person signs in here.",
    offlineRowOtherEmployee:
      "Saved by someone else: it is sent when that person signs in on this device. Retry does not send it.",
    offlineAttemptRecord: "Record verified payment",
    offlineAttemptDiscard: "Discard attempt (not charged)",
    offlineAttemptRecordHint:
      "We will record this payment on its order, in the attempt's original drawer. Do it only if you verified the guest paid; they are not charged again.",
    offlineAttemptDiscardHint:
      "The attempt is closed without recording money and the order can be charged again. Do it only if you verified the guest did not pay.",
    offlineAttemptReason: "Reason",
    offlineAttemptConfirm: "I verified it with the drawer and with the guest.",
    offlineAttemptSubmitRecord: "Record payment",
    offlineAttemptSubmitDiscard: "Discard attempt",
    offlineAttemptDiscarded:
      "A manager discarded this attempt: it was not charged.",
    offlineAttemptDismiss: "Close attempt",
    offlineOpAttemptRecorded: "Pending payment recorded by a manager",
    offlineOpAttemptDiscarded: "Pending payment discarded by a manager",
  },
  errors: {
    network_unavailable: [
      "Sin conexión con el servidor. Puedes seguir vendiendo; las ventas se guardan en este dispositivo.",
      "No connection to the server. You can keep selling; sales are saved on this device.",
    ],
    request_timeout: [
      "El servidor tardó demasiado en responder. Revisa la conexión o trabaja sin conexión.",
      "The server took too long to respond. Check the connection or work offline.",
    ],
    server_unavailable: [
      "El servidor no está disponible por ahora. Las ventas se pueden guardar en este dispositivo.",
      "The server is unavailable right now. Sales can be saved on this device.",
    ],
    invalid_response: [
      "Respuesta inesperada del servidor. Intenta de nuevo.",
      "Unexpected server response. Try again.",
    ],
    rate_limited: [
      "Demasiadas solicitudes. Espera unos segundos.",
      "Too many requests. Wait a few seconds.",
    ],
    provisional_number_out_of_range: [
      "Este dispositivo ya usó los 9,999 números provisionales de hoy. Vuelve a conectarte para seguir vendiendo.",
      "This device has used all 9,999 provisional numbers for today. Reconnect to keep selling.",
    ],
    database_unavailable: [
      "El servidor no puede consultar sus datos por ahora. Las ventas se pueden guardar en este dispositivo.",
      "The server cannot reach its data right now. Sales can be saved on this device.",
    ],
    offline_evidence_invalid: [
      "No se pudo verificar este registro local (sesión, caja o dispositivo no coinciden). Un gerente puede archivarlo con un motivo.",
      "This local record could not be verified (session, drawer or device do not match). A manager can archive it with a reason.",
    ],
    offline_recorded_in_future: [
      "La hora de este dispositivo está adelantada. Reintentaremos automáticamente; ajusta la hora del dispositivo.",
      "This device's clock is ahead. We will retry automatically; fix the device time.",
    ],
    offline_outside_lease: [
      "La venta quedó fuera del periodo sin conexión autorizado. Requiere revisión de un gerente.",
      "The sale falls outside the authorized offline period. A manager must review it.",
    ],
    offline_catalog_changed: [
      "El producto cambió desde la venta. Un gerente debe conciliarla.",
      "The product changed after the sale. A manager must reconcile it.",
    ],
    offline_dependency_pending: [
      "Esperando a que se sincronice la orden original.",
      "Waiting for the original order to sync.",
    ],
    offline_dependency_archived: [
      "La orden original fue archivada. Un gerente debe revisar este registro.",
      "The original order was archived. A manager must review this record.",
    ],
    offline_order_closed: [
      "La orden ya no acepta cambios: está cerrada, cancelada o en conciliación, o ya tiene ticket con folio. Un gerente debe revisar este registro.",
      "The order no longer accepts changes: it is closed, cancelled or under reconciliation, or it already has a numbered ticket. A manager must review this record.",
    ],
    offline_check_paid: [
      "Esta cuenta ya está pagada. Envía lo nuevo como orden nueva para la misma mesa.",
      "This check is already paid. Send the new items as a new order for the same table.",
    ],
    offline_lines_already_sent: [
      "Estos productos ya se enviaron en línea a esta orden (la respuesta se perdió). Un gerente debe revisar el registro; si la orden ya los tiene, archívalo.",
      "These items were already sent online to this order (the response was lost). A manager must review the record; if the order already has them, archive it.",
    ],
    offline_table_service_off: [
      "Sin conexión solo se guardan órdenes nuevas cobradas completas. Enviar a cocina sin cobrar, agregar a una cuenta abierta y los pagos parciales están disponibles al volver la conexión.",
      "Offline, only new orders paid in full can be saved. Sending to the kitchen without paying, adding to an open check and partial payments are available when the connection returns.",
    ],
    offline_clock_moved_back: [
      "La hora de este dispositivo se atrasó desde la última conexión. Conéctate para verificar la hora antes de guardar ventas sin conexión.",
      "This device's clock moved back since it last connected. Connect to check the time before saving offline sales.",
    ],
    offline_payment_exceeds_due: [
      "El cobro supera el saldo actual de la orden (quizá ya se cobró). Un gerente debe revisarlo; no cobres otra vez.",
      "The payment exceeds the order's current balance (it may already be paid). A manager must review it; do not charge again.",
    ],
    offline_archived: [
      "Este registro local fue archivado por un gerente.",
      "This local record was archived by a manager.",
    ],
    offline_already_synced: [
      "Este registro ya está en el servidor.",
      "This record is already on the server.",
    ],
    offline_reconcile_unsupported: [
      "Este registro no tiene cobro que conciliar. Archívalo con un motivo o vuelve a capturarlo en línea.",
      "This record has no payment to reconcile. Archive it with a reason or enter it again online.",
    ],
    offline_prefix_exhausted: [
      "No hay más prefijos de dispositivo disponibles. Contacta a soporte.",
      "No device prefixes are left. Contact support.",
    ],
    offline_window_expired: [
      "El periodo sin conexión de esta sesión terminó. Conéctate e inicia sesión para seguir vendiendo.",
      "This session's offline period ended. Reconnect and sign in to keep selling.",
    ],
    offline_drawer_missing: [
      "Abre caja con conexión antes de cobrar sin conexión.",
      "Open the drawer while online before taking offline payments.",
    ],
    offline_payment_pending_for_order: [
      "Esta orden tiene un pago por confirmar. Se resolverá al volver la conexión; no cobres otra vez.",
      "This order has a payment awaiting confirmation. It will be resolved when the connection returns; do not charge again.",
    ],
    offline_round_pending_for_order: [
      "Esta orden tiene productos guardados sin conexión que aún no se sincronizan, y el saldo del servidor no los incluye. Los estamos sincronizando; vuelve a cobrar en unos segundos.",
      "This order has items saved offline that have not synced yet, and the server balance does not include them. We are syncing them now; charge again in a few seconds.",
    ],
    offline_round_other_employee_for_order: [
      "Esta orden tiene productos que otra persona guardó sin conexión en este dispositivo y que aún no se sincronizan, y el saldo del servidor no los incluye. Se sincronizan cuando esa persona vuelve a iniciar sesión aquí; si no puede, un gerente debe revisarlos en Sincronización antes de cobrar.",
      "This order has items another person saved offline on this device that have not synced yet, and the server balance does not include them. They sync when that person signs in here again; if they cannot, a manager must review them on the Sync screen before charging.",
    ],
    offline_round_review_for_order: [
      "Esta orden tiene productos guardados sin conexión que no se pudieron sincronizar, y el saldo del servidor no los incluye. Un gerente debe revisarlos en Sincronización antes de cobrar.",
      "This order has items saved offline that could not sync, and the server balance does not include them. A manager must review them on the Sync screen before charging.",
    ],
    offline_order_outdated: [
      "La orden cambió: ya incluye productos guardados sin conexión. Revisa el importe y vuelve a cobrar.",
      "The order changed: it now includes items saved offline. Check the amount and charge again.",
    ],
    offline_split_unavailable: [
      "Dividir por productos no está disponible sin conexión. Divide por importe.",
      "Item split is unavailable offline. Split by amount.",
    ],
    offline_storage_full: [
      "No hay espacio en este dispositivo para guardar la venta. Libera espacio y descarga un respaldo.",
      "There is no space on this device to save the sale. Free up space and download a backup.",
    ],
    offline_amount_exceeds_due: [
      "El importe supera el saldo de la orden guardada en este dispositivo.",
      "The amount exceeds the balance of the order saved on this device.",
    ],
    offline_amount_invalid: [
      "Escribe un importe mayor que cero.",
      "Enter an amount greater than zero.",
    ],
    offline_record_invalid: [
      "No se pudo guardar este registro sin conexión. Revisa la orden e intenta de nuevo.",
      "This offline record could not be saved. Check the order and try again.",
    ],
    offline_order_not_cached: [
      "Esta orden no está guardada en este dispositivo. Ábrela desde Órdenes abiertas o cóbrala al volver la conexión.",
      "This order is not saved on this device. Open it from Open orders or charge it when the connection returns.",
    ],
    offline_record_conflict: [
      "El servidor no puede aplicar este registro porque choca con datos que ya tiene (por ejemplo, un producto repetido). No se reintenta solo: un gerente debe revisarlo; concilia su cobro o archívalo.",
      "The server cannot apply this record because it collides with data it already has (for example, a repeated item). It is not retried by itself: a manager must review it; reconcile its payment or archive it.",
    ],
    offline_why_conflict: [
      "No se sincroniza solo: la sesión, el empleado o el dispositivo que lo registró ya no está activo, o no tenía permiso de vender sin conexión. Un gerente debe revisarlo en Sincronización.",
      "It does not sync by itself: the session, employee or device that saved it is no longer active, or was not allowed to sell offline. A manager must review it on the Sync screen.",
    ],
    offline_why_session_revoked: [
      "La sesión que lo registró se revocó (el empleado o el dispositivo se dio de baja), así que no se sincroniza solo. Concilia su cobro o archívalo.",
      "The session that saved it was revoked (the employee or device was deactivated), so it does not sync by itself. Reconcile its payment or archive it.",
    ],
    offline_why_employee_inactive: [
      "El empleado que lo registró está inactivo, así que no se sincroniza solo. Concilia su cobro o archívalo; si reactivas al empleado, se envía cuando inicie sesión en ese dispositivo.",
      "The employee who saved it is inactive, so it does not sync by itself. Reconcile its payment or archive it; if you reactivate the employee, it is sent when they sign in on that device.",
    ],
    offline_why_device_inactive: [
      "El dispositivo que lo registró está dado de baja, así que no se sincroniza solo. Concilia su cobro o archívalo.",
      "The device that saved it is deactivated, so it does not sync by itself. Reconcile its payment or archive it.",
    ],
    offline_why_selling_not_authorized: [
      "La sesión que lo registró no tenía permiso para vender sin conexión. Concilia su cobro o archívalo.",
      "The session that saved it was not allowed to sell offline. Reconcile its payment or archive it.",
    ],
    offline_why_settings_changed: [
      "Se registró con otra configuración del restaurante y no se sincroniza solo; actualizar no lo cambia. Un gerente debe conciliar su cobro o archivarlo.",
      "It was saved under other restaurant settings and does not sync by itself; refreshing does not change that. A manager must reconcile its payment or archive it.",
    ],
    offline_why_settings_items: [
      "Se registró con otra configuración del restaurante y no se sincroniza. No lleva cobro que conciliar: archívalo y agrega sus productos en línea.",
      "It was saved under other restaurant settings and does not sync. It carries no payment to reconcile: archive it and add its items online.",
    ],
    offline_why_price_items: [
      "El precio cambió desde que se registró y no se sincroniza. No lleva cobro que conciliar: archívalo y agrega sus productos en línea con el precio actual.",
      "The price changed since it was saved and it does not sync. It carries no payment to reconcile: archive it and add its items online at the current price.",
    ],
    offline_why_catalog_items: [
      "Un producto cambió desde que se registró y no se sincroniza. No lleva cobro que conciliar: archívalo y agrega sus productos en línea.",
      "A product changed since it was saved and it does not sync. It carries no payment to reconcile: archive it and add its items online.",
    ],
  },
});
