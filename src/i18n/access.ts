import { defineArea } from "./define";

export default defineArea({
  es: {
    accessArtHint:
      "Cada dispositivo se vincula una vez con un código. Después, cada persona entra con su nombre y su PIN.",
    accessPairTitle: "Vincular este dispositivo",
    accessPairHint:
      "Pide a un responsable que genere un código en su teléfono (Configuración → Dispositivos) y escríbelo aquí.",
    accessPairCode: "Código de vinculación",
    accessPairSubmit: "Vincular",
    accessPairDone: "Dispositivo vinculado a {restaurant}.",
    accessOwnerTitle: "¿Eres el propietario?",
    accessOwnerHint:
      "Crea tu restaurante o entra con Google desde tu propio teléfono o computadora, no desde una terminal compartida.",
    accessTerminalNoGoogle:
      "Esta es una terminal compartida. La cuenta del propietario (Google) se administra desde tu propio teléfono o computadora.",
    accessWho: "¿Quién entra?",
    accessDeviceLabel: "Dispositivo: {name}",
    accessPinFor: "PIN de {name}",
    accessUsePassword: "Usar contraseña",
    accessUsePin: "Usar PIN",
    accessSignIn: "Entrar",
    accessDeleteDigit: "Borrar",
    accessChooseOther: "Elegir a otra persona",
    accessNoStaff:
      "Aún no hay empleados con PIN en esta sucursal. El propietario puede agregarlos en Equipo.",
    accessLockedUntil: "Bloqueado en este dispositivo hasta las {time}",
    accessHardLocked:
      "Bloqueado por demasiados intentos. Solo el propietario puede desbloquearlo o cambiar el PIN.",
    accessNotYou:
      "¿Este no es tu restaurante o dispositivo? Pide a un responsable que lo desvincule.",
    accessDemoTitle: "Acceso de demostración",
    accessLockTitle: "Pantalla bloqueada",
    accessLockNow: "Bloquear pantalla",
    accessSwitchUser: "Cambiar de usuario",
    accessContinueAs: "Continuar como {name}",
    accessNotNow: "Ahora no",
    accessLockCheckAgain: "Comprobar de nuevo",
    accessOfflineUnlockHint:
      "Sin conexión no se puede verificar el PIN. Las ventas se registran a nombre de {name}.",
    accessSwitchOffline: "Cambiar de usuario requiere conexión.",
    accessGateOffline:
      "Sin conexión. Para entrar en este dispositivo hace falta conexión; esta pantalla se actualiza sola cuando vuelva.",
    accessGateSalesKept:
      "Las ventas guardadas en este dispositivo se conservan y se enviarán cuando vuelva la conexión.",
    accessGoogleAgain: "Continuar con Google",
    accessPendingTitle: "Ventas sin enviar",
    accessPendingBody:
      "Hay {n} ventas guardadas en este dispositivo que aún no se envían. Se enviarán cuando {name} vuelva a entrar aquí; si no regresa, un responsable puede conciliarlas en Sincronización.",
    accessPendingPayment: "Hay un cobro por confirmar.",
    accessPendingSending: "Enviando ventas pendientes…",
    accessStay: "Quedarme",
    accessLeaveAnyway: "Salir de todos modos",
    accessSwitchAnyway: "Cambiar de todos modos",
    accessOfflineLogoutTitle: "Sin conexión",
    accessOfflineLogoutBody:
      "Si sales ahora, nadie podrá entrar en este dispositivo hasta que vuelva la conexión. Las ventas guardadas se conservan. Si solo te vas un momento, bloquea la pantalla.",
    accessExpiryWarning:
      "La sesión de {name} termina a las {time}. Renueva con tu PIN para no interrumpir el servicio.",
    accessRenew: "Renovar ahora",
    accessRenewTitle: "Renueva la sesión de {name}",
    accessStepUpTitle: "Confirma con tu PIN",
    accessStepUpHint: "Esta acción necesita que confirmes que eres {name}.",
    accessConfirm: "Confirmar",
    accessBusy: "Un momento…",
    accessApprovalTitle: "Autorización de gerente",
    accessApprovalHint:
      "El gerente escribe su PIN en este dispositivo. La autorización vale solo para esta acción.",
    accessApprover: "Gerente que autoriza",
    accessApproverPin: "PIN del gerente",
    accessApprovalSelf: "Confirma con tu PIN",
    accessApproversNone:
      "No hay gerentes con PIN en esta sucursal. El propietario puede crear el suyo en Equipo → Mi PIN para terminales compartidas.",
    accessApproversFailed: "No se pudo cargar la lista de gerentes.",
    accessStaffAdd: "Agregar empleado",
    accessStaffName: "Nombre",
    accessStaffLogin: "Usuario",
    accessStaffRole: "Rol",
    accessStaffStatus: "Estado",
    accessStaffLastSeen: "Último acceso",
    accessStaffAccess: "Acceso",
    accessStaffActions: "Acciones",
    accessStaffActive: "Activo",
    accessStaffInactive: "Inactivo",
    accessStaffLocked: "Bloqueado",
    accessStaffUnlockOwnerOnly: "Solo el propietario puede desbloquear a {name}.",
    accessStaffPin: "PIN",
    accessStaffGoogle: "Google",
    accessStaffGooglePin: "Google y PIN",
    accessStaffNoPin: "Sin PIN",
    accessStaffPinSince: "PIN del {date}",
    accessStaffEdit: "Editar",
    accessStaffEditTitle: "Editar a {name}",
    accessStaffSave: "Guardar cambios",
    accessStaffUsername: "Usuario (opcional)",
    accessStaffUsernameHint:
      "Si lo dejas vacío se genera a partir del nombre. Solo minúsculas, números, punto, guion y guion bajo.",
    accessStaffNewPin: "PIN nuevo (6 a 8 dígitos)",
    accessStaffConfirmPin: "Confirma el PIN",
    accessStaffPinMismatch: "Los PIN no coinciden.",
    accessStaffSetPin: "Guardar PIN",
    accessStaffMyPin: "Mi PIN para terminales compartidas",
    accessStaffMyPinHint:
      "Úsalo para entrar en las cajas y la cocina sin abrir tu cuenta de Google en ellas.",
    accessStaffUnlock: "Desbloquear",
    accessStaffLockedOn: "Bloqueado en {n} dispositivos hasta las {time}",
    accessStaffDeactivate: "Desactivar empleado",
    accessStaffDeactivateConfirm:
      "{name} ya no podrá entrar en ningún dispositivo y se cerrarán sus sesiones abiertas. Sus ventas y registros se conservan.",
    accessStaffDeactivateGoogle:
      "También pierde el acceso con Google a esta sucursal.",
    accessStaffDeactivatePending:
      "Si tiene ventas sin enviar en algún dispositivo, quedarán para conciliación de un responsable.",
    accessStaffDeactivatePersonal:
      "También se desvincularán sus dispositivos personales: {names}.",
    accessStaffDeactivateTerminals:
      "Vinculó estas terminales compartidas, que seguirán vinculadas: {names}. Revísalas en Dispositivos y desvincula las que no reconozcas.",
    accessStaffReactivate: "Reactivar",
    accessStaffOwnerFixed: "El rol de propietario no se puede cambiar aquí.",
    accessStaffSaved: "Cambios guardados",
    accessStaffCreated: "{name} se agregó. Usuario: {login}.",
    accessStaffDeactivated: "{name} se desactivó y sus sesiones se cerraron.",
    accessStaffReactivated: "{name} se reactivó.",
    accessStaffPinSaved:
      "PIN actualizado. Las sesiones abiertas de {name} se cerraron.",
    accessStaffUnlocked: "{name} se desbloqueó.",
    accessStaffFreeUnselected: "No seleccionado en Free",
    accessDevicesTitle: "Dispositivos",
    accessDevicesHint:
      "Las terminales compartidas se vinculan con un código de un solo uso. Desvincula de inmediato un dispositivo perdido o robado.",
    accessDevicesPair: "Vincular un dispositivo",
    accessDevicesName: "Nombre del dispositivo",
    accessDevicesNameHint: "Por ejemplo: Caja 1, Cocina, Barra.",
    accessDevicesDefaultName: "Caja 1",
    accessDevicesGenerate: "Generar código",
    accessDevicesCodeHint:
      "En el dispositivo nuevo abre {url}, elige «Vincular este dispositivo» y escribe el código.",
    accessDevicesExpiresIn: "Vence en {time}",
    accessDevicesCodeExpired: "El código venció. Genera otro.",
    accessDevicesPaired: "Vinculado: {name}",
    accessDevicesPairedFree:
      "En Free solo un dispositivo inicia ventas. Si este será tu caja, selecciónalo en «Registro y equipo Free».",
    accessDevicesOpenCodes: "Códigos activos",
    accessDevicesCancelCode: "Cancelar código",
    accessDevicesThis: "Este dispositivo",
    accessDevicesKind: "Tipo",
    accessDevicesTerminal: "Terminal compartida",
    accessDevicesPairedBy: "Vinculado por {name}",
    accessDevicesPersonal: "Personal · {name}",
    accessDevicesShared:
      "Lo usan varios empleados. Vincúlalo como terminal con un código.",
    accessDevicesStatusActive: "Activo",
    accessDevicesStatusRevoked: "Desvinculado",
    accessDevicesStatusExpired: "Vinculación vencida",
    accessDevicesLastSeen: "Última actividad",
    accessDevicesInUse: "En uso por {name}",
    accessDevicesEndSession: "Cerrar sesión",
    accessDevicesSessionEnded: "Se cerró la sesión en «{name}».",
    accessDevicesEdit: "Editar",
    accessDevicesEditTitle: "Editar «{name}»",
    accessDevicesAutoLock: "Bloqueo automático",
    accessDevicesAutoLockDefault:
      "Predeterminado (3 min; nunca en cocina ni al entrar con Google en un dispositivo personal)",
    accessDevicesNever: "Nunca",
    accessDevicesMinutes: "{n} min",
    accessDevicesRevoke: "Desvincular",
    accessDevicesRevokeConfirm:
      "«{name}» dejará de funcionar de inmediato y se cerrarán sus sesiones. Para usarlo de nuevo necesitará un código nuevo.",
    accessDevicesRevokeDrawer:
      "Este dispositivo tiene una caja abierta. Si todavía funciona, ciérrala antes en él (Caja → Cerrar caja). Si lo desvinculas, la caja queda abierta y por ahora ningún dispositivo puede cerrarla: cuenta el efectivo, guarda el conteo y pide a soporte que la cierre.",
    accessDevicesRevokeDrawerAck:
      "Entiendo que la caja queda abierta y que soporte la cerrará con mi conteo.",
    accessDevicesRevokeSelf:
      "Estás desvinculando este mismo dispositivo; se cerrará tu sesión.",
    accessDevicesRevoked: "«{name}» se desvinculó.",
    accessDevicesFree: "Seleccionado para vender en Free",
    accessDevicesNeverSeen: "—",
    accessDevicesShowRevoked: "Mostrar desvinculados",
    accessOpDevicePaired: "Dispositivo vinculado",
    accessOpDeviceRenamed: "Dispositivo editado",
    accessOpDeviceRevoked: "Dispositivo desvinculado",
    accessOpDeviceSessionEnded: "Sesión cerrada en un dispositivo",
    accessOpPairingCodeCreated: "Código de vinculación generado",
    accessOpPairingCodeCancelled: "Código de vinculación cancelado",
    accessOpEmployeeCreated: "Empleado agregado",
    accessOpEmployeeUpdated: "Empleado editado",
    accessOpEmployeeDeactivated: "Empleado desactivado",
    accessOpEmployeeReactivated: "Empleado reactivado",
    accessOpEmployeePinReset: "PIN cambiado",
    accessOpEmployeeUnlocked: "Empleado desbloqueado",
  },
  en: {
    accessArtHint:
      "Each device is paired once with a code. After that, each person signs in with their name and PIN.",
    accessPairTitle: "Pair this device",
    accessPairHint:
      "Ask a manager to create a code on their phone (Settings → Devices) and type it here.",
    accessPairCode: "Pairing code",
    accessPairSubmit: "Pair",
    accessPairDone: "Device paired with {restaurant}.",
    accessOwnerTitle: "Are you the owner?",
    accessOwnerHint:
      "Create your restaurant or sign in with Google from your own phone or computer, not from a shared terminal.",
    accessTerminalNoGoogle:
      "This is a shared terminal. The owner's Google account is managed from your own phone or computer.",
    accessWho: "Who is signing in?",
    accessDeviceLabel: "Device: {name}",
    accessPinFor: "PIN for {name}",
    accessUsePassword: "Use password",
    accessUsePin: "Use PIN",
    accessSignIn: "Sign in",
    accessDeleteDigit: "Delete",
    accessChooseOther: "Choose someone else",
    accessNoStaff:
      "There are no employees with a PIN at this location yet. The owner can add them in Team.",
    accessLockedUntil: "Locked on this device until {time}",
    accessHardLocked:
      "Locked after too many attempts. Only the owner can unlock it or change the PIN.",
    accessNotYou: "Not your restaurant or device? Ask a manager to unpair it.",
    accessDemoTitle: "Demo access",
    accessLockTitle: "Screen locked",
    accessLockNow: "Lock screen",
    accessSwitchUser: "Switch user",
    accessContinueAs: "Continue as {name}",
    accessNotNow: "Not now",
    accessLockCheckAgain: "Check again",
    accessOfflineUnlockHint:
      "Offline, the PIN cannot be verified. Sales are recorded under {name}.",
    accessSwitchOffline: "Switching user requires a connection.",
    accessGateOffline:
      "Offline. Signing in on this device needs a connection; this screen updates by itself when it returns.",
    accessGateSalesKept:
      "Sales saved on this device are kept and will be sent when the connection returns.",
    accessGoogleAgain: "Continue with Google",
    accessPendingTitle: "Unsent sales",
    accessPendingBody:
      "There are {n} sales saved on this device that have not been sent. They will be sent when {name} signs in here again; otherwise a manager can reconcile them in Synchronization.",
    accessPendingPayment: "A payment still needs confirmation.",
    accessPendingSending: "Sending pending sales…",
    accessStay: "Stay signed in",
    accessLeaveAnyway: "Sign out anyway",
    accessSwitchAnyway: "Switch anyway",
    accessOfflineLogoutTitle: "Offline",
    accessOfflineLogoutBody:
      "If you sign out now, nobody can sign in on this device until the connection returns. Saved sales are kept. If you are only stepping away, lock the screen.",
    accessExpiryWarning:
      "{name}'s session ends at {time}. Renew with your PIN to avoid interrupting service.",
    accessRenew: "Renew now",
    accessRenewTitle: "Renew {name}'s session",
    accessStepUpTitle: "Confirm with your PIN",
    accessStepUpHint: "This action needs you to confirm you are {name}.",
    accessConfirm: "Confirm",
    accessBusy: "One moment…",
    accessApprovalTitle: "Manager approval",
    accessApprovalHint:
      "The manager enters their PIN on this device. The approval covers this action only.",
    accessApprover: "Approving manager",
    accessApproverPin: "Manager PIN",
    accessApprovalSelf: "Confirm with your PIN",
    accessApproversNone:
      "No manager has a PIN at this location. The owner can set theirs in Team → My PIN for shared terminals.",
    accessApproversFailed: "The list of managers could not be loaded.",
    accessStaffAdd: "Add employee",
    accessStaffName: "Name",
    accessStaffLogin: "Username",
    accessStaffRole: "Role",
    accessStaffStatus: "Status",
    accessStaffLastSeen: "Last sign-in",
    accessStaffAccess: "Access",
    accessStaffActions: "Actions",
    accessStaffActive: "Active",
    accessStaffInactive: "Inactive",
    accessStaffLocked: "Locked",
    accessStaffUnlockOwnerOnly: "Only the owner can unlock {name}.",
    accessStaffPin: "PIN",
    accessStaffGoogle: "Google",
    accessStaffGooglePin: "Google and PIN",
    accessStaffNoPin: "No PIN",
    accessStaffPinSince: "PIN set {date}",
    accessStaffEdit: "Edit",
    accessStaffEditTitle: "Edit {name}",
    accessStaffSave: "Save changes",
    accessStaffUsername: "Username (optional)",
    accessStaffUsernameHint:
      "Leave it empty to generate one from the name. Lower case letters, digits, dot, hyphen and underscore only.",
    accessStaffNewPin: "New PIN (6 to 8 digits)",
    accessStaffConfirmPin: "Confirm the PIN",
    accessStaffPinMismatch: "The PINs do not match.",
    accessStaffSetPin: "Save PIN",
    accessStaffMyPin: "My PIN for shared terminals",
    accessStaffMyPinHint:
      "Use it on registers and kitchen screens instead of opening your Google account there.",
    accessStaffUnlock: "Unlock",
    accessStaffLockedOn: "Locked on {n} devices until {time}",
    accessStaffDeactivate: "Deactivate employee",
    accessStaffDeactivateConfirm:
      "{name} will no longer be able to sign in on any device and their open sessions will close. Their sales and records are kept.",
    accessStaffDeactivateGoogle:
      "They also lose Google access to this location.",
    accessStaffDeactivatePending:
      "Any unsent sales on a device will wait for a manager's reconciliation.",
    accessStaffDeactivatePersonal:
      "Their personal devices will be unpaired too: {names}.",
    accessStaffDeactivateTerminals:
      "They paired these shared terminals, which stay paired: {names}. Review them in Devices and unpair any you do not recognize.",
    accessStaffReactivate: "Reactivate",
    accessStaffOwnerFixed: "The owner role cannot be changed here.",
    accessStaffSaved: "Changes saved",
    accessStaffCreated: "{name} was added. Username: {login}.",
    accessStaffDeactivated:
      "{name} was deactivated and their sessions were closed.",
    accessStaffReactivated: "{name} was reactivated.",
    accessStaffPinSaved: "PIN updated. {name}'s open sessions were closed.",
    accessStaffUnlocked: "{name} was unlocked.",
    accessStaffFreeUnselected: "Not selected on Free",
    accessDevicesTitle: "Devices",
    accessDevicesHint:
      "Shared terminals are paired with a single-use code. Unpair a lost or stolen device right away.",
    accessDevicesPair: "Pair a device",
    accessDevicesName: "Device name",
    accessDevicesNameHint: "For example: Register 1, Kitchen, Bar.",
    accessDevicesDefaultName: "Register 1",
    accessDevicesGenerate: "Create code",
    accessDevicesCodeHint:
      'On the new device open {url}, choose "Pair this device" and type the code.',
    accessDevicesExpiresIn: "Expires in {time}",
    accessDevicesCodeExpired: "The code expired. Create another one.",
    accessDevicesPaired: "Paired: {name}",
    accessDevicesPairedFree:
      "On Free only one device starts sales. If this one will be your register, select it in \"Free register and team\".",
    accessDevicesOpenCodes: "Active codes",
    accessDevicesCancelCode: "Cancel code",
    accessDevicesThis: "This device",
    accessDevicesKind: "Type",
    accessDevicesTerminal: "Shared terminal",
    accessDevicesPairedBy: "Paired by {name}",
    accessDevicesPersonal: "Personal · {name}",
    accessDevicesShared:
      "Several employees use it. Pair it as a terminal with a code.",
    accessDevicesStatusActive: "Active",
    accessDevicesStatusRevoked: "Unpaired",
    accessDevicesStatusExpired: "Pairing expired",
    accessDevicesLastSeen: "Last activity",
    accessDevicesInUse: "In use by {name}",
    accessDevicesEndSession: "Sign out session",
    accessDevicesSessionEnded: 'The session on "{name}" was closed.',
    accessDevicesEdit: "Edit",
    accessDevicesEditTitle: 'Edit "{name}"',
    accessDevicesAutoLock: "Auto-lock",
    accessDevicesAutoLockDefault:
      "Default (3 min; never for kitchen or a Google sign-in on a personal device)",
    accessDevicesNever: "Never",
    accessDevicesMinutes: "{n} min",
    accessDevicesRevoke: "Unpair",
    accessDevicesRevokeConfirm:
      '"{name}" stops working immediately and its sessions close. It will need a new code to be used again.',
    accessDevicesRevokeDrawer:
      "This device has an open drawer. If it still works, close the drawer on it first (Cash drawer → Close drawer). If you unpair it, the drawer stays open and for now no device can close it: count the cash, keep the count and ask support to close it.",
    accessDevicesRevokeDrawerAck:
      "I understand the drawer stays open and support will close it with my count.",
    accessDevicesRevokeSelf:
      "You are unpairing this device; your session will end.",
    accessDevicesRevoked: '"{name}" was unpaired.',
    accessDevicesFree: "Selected for selling on Free",
    accessDevicesNeverSeen: "—",
    accessDevicesShowRevoked: "Show unpaired",
    accessOpDevicePaired: "Device paired",
    accessOpDeviceRenamed: "Device edited",
    accessOpDeviceRevoked: "Device unpaired",
    accessOpDeviceSessionEnded: "Device session closed",
    accessOpPairingCodeCreated: "Pairing code created",
    accessOpPairingCodeCancelled: "Pairing code cancelled",
    accessOpEmployeeCreated: "Employee added",
    accessOpEmployeeUpdated: "Employee edited",
    accessOpEmployeeDeactivated: "Employee deactivated",
    accessOpEmployeeReactivated: "Employee reactivated",
    accessOpEmployeePinReset: "PIN changed",
    accessOpEmployeeUnlocked: "Employee unlocked",
  },
  errors: {
    unauthorized: [
      "Tu sesión no es válida. Vuelve a entrar.",
      "Your session is not valid. Sign in again.",
    ],
    session_expired: [
      "Tu sesión terminó. Ingresa tu PIN para continuar.",
      "Your session ended. Enter your PIN to continue.",
    ],
    session_ended: [
      "La sesión se cerró en este dispositivo. Ingresa tu PIN para continuar.",
      "The session was closed on this device. Enter your PIN to continue.",
    ],
    session_revoked: [
      "Un responsable cerró esta sesión o desactivó al empleado.",
      "A manager closed this session or deactivated the employee.",
    ],
    session_locked: [
      "La conexión volvió y la pantalla sigue bloqueada. Ingresa tu PIN para continuar.",
      "The connection is back and the screen is still locked. Enter your PIN to continue.",
    ],
    session_changed: [
      "La sesión cambió en otra pestaña. Recarga para continuar.",
      "The session changed in another tab. Reload to continue.",
    ],
    device_not_paired: [
      "Este dispositivo no está vinculado. Ingresa un código de vinculación.",
      "This device is not paired. Enter a pairing code.",
    ],
    device_revoked: [
      "Este dispositivo fue desvinculado o su vinculación venció. Pide un código nuevo a un responsable.",
      "This device was unpaired or its pairing expired. Ask a manager for a new code.",
    ],
    owner_reauth_required: [
      "Este dispositivo fue desvinculado. Vuelve a iniciar sesión con Google para entrar desde aquí.",
      "This device was unpaired. Sign in with Google again to enter from here.",
    ],
    device_is_terminal: [
      "Esta es una terminal compartida. Entra con tu PIN; la cuenta del propietario se administra desde tu propio dispositivo.",
      "This is a shared terminal. Sign in with your PIN; the owner account is managed from your own device.",
    ],
    pairing_code_invalid: [
      "El código no es válido o ya venció. Pide uno nuevo.",
      "The code is invalid or expired. Ask for a new one.",
    ],
    pairing_code_limit: [
      "Hay demasiados códigos activos. Cancela alguno o espera a que venzan.",
      "Too many active codes. Cancel one or wait for them to expire.",
    ],
    pairing_code_unavailable: [
      "Ese código ya se usó, venció o fue cancelado.",
      "That code was already used, expired or cancelled.",
    ],
    too_many_attempts: [
      "Demasiados intentos desde esta red. Espera un minuto.",
      "Too many attempts from this network. Wait a minute.",
    ],
    invalid_pin: ["PIN incorrecto.", "Incorrect PIN."],
    invalid_login: [
      "Usuario o contraseña incorrectos.",
      "Incorrect username or password.",
    ],
    employee_unavailable: [
      "Este empleado ya no está activo en la sucursal.",
      "This employee is no longer active at this location.",
    ],
    pin_locked: [
      "Demasiados intentos en este dispositivo. Espera o pide a un responsable que lo desbloquee.",
      "Too many attempts on this device. Wait or ask a manager to unlock it.",
    ],
    pin_hard_locked: [
      "Este empleado está bloqueado por demasiados intentos. El propietario debe desbloquearlo o cambiar su PIN.",
      "This employee is locked after too many attempts. The owner must unlock them or change their PIN.",
    ],
    unlock_owner_only: [
      "Solo el propietario puede desbloquear a gerentes, a propietarios o un bloqueo por demasiados intentos.",
      "Only the owner can unlock managers, owners or a lock after too many attempts.",
    ],
    unlock_limit: [
      "Este empleado ya se desbloqueó 3 veces hoy. Pide al propietario que lo desbloquee o cambie su PIN.",
      "This employee was already unlocked 3 times today. Ask the owner to unlock them or change their PIN.",
    ],
    pin_invalid_format: [
      "El PIN debe tener de 6 a 8 dígitos.",
      "The PIN must have 6 to 8 digits.",
    ],
    pair_device: [
      "Este dispositivo no está vinculado. Pide un código de vinculación a un responsable.",
      "This device is not paired. Ask a manager for a pairing code.",
    ],
    step_up_required: [
      "Confirma con tu PIN para continuar.",
      "Confirm with your PIN to continue.",
    ],
    step_up_cancelled: ["Acción cancelada.", "Action cancelled."],
    approval_required: [
      "Esta acción requiere la autorización de un gerente.",
      "This action requires a manager approval.",
    ],
    approval_denied: [
      "PIN de gerente incorrecto o el empleado no es gerente.",
      "Manager PIN is incorrect or the employee is not a manager.",
    ],
    self_disable: [
      "No puedes desactivar tu propio acceso.",
      "You cannot deactivate your own access.",
    ],
    self_role_change: [
      "No puedes cambiar tu propio rol.",
      "You cannot change your own role.",
    ],
    owner_role_locked: [
      "El rol de propietario no se puede asignar ni quitar desde aquí.",
      "The owner role cannot be assigned or removed here.",
    ],
    owner_cannot_be_deactivated: [
      "El propietario no se puede desactivar.",
      "The owner cannot be deactivated.",
    ],
    login_taken: [
      "Ese usuario ya existe en esta sucursal.",
      "That username already exists at this location.",
    ],
    employee_not_found: [
      "No se encontró al empleado. Actualiza la lista.",
      "Employee not found. Refresh the list.",
    ],
    device_unavailable: [
      "El dispositivo no existe o ya fue desvinculado.",
      "The device does not exist or was already unpaired.",
    ],
    open_drawer_ack_required: [
      "Este dispositivo tiene una caja abierta. Lee el aviso y confírmalo para desvincularlo.",
      "This device has an open drawer. Read the notice and confirm it to unpair.",
    ],
    missing_tenant: [
      "No se identificó la sucursal. Vuelve a entrar.",
      "The location could not be identified. Sign in again.",
    ],
  },
});
