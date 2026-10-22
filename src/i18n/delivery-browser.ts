export default {
  es: {
    deliveryBrowserAuditConnect: "Conexión de delivery autorizada",
    deliveryBrowserAuditVerify: "Cuenta de delivery verificada",
    deliveryBrowserAuditSelect: "Tienda de delivery elegida",
    deliveryBrowserAuditDisconnect: "Conexión de delivery revocada",
  },
  en: {
    deliveryBrowserAuditConnect: "Delivery connection authorized",
    deliveryBrowserAuditVerify: "Delivery account verified",
    deliveryBrowserAuditSelect: "Delivery store selected",
    deliveryBrowserAuditDisconnect: "Delivery connection revoked",
  },
  errors: {
    delivery_reconnect: [
      "La plataforma solicita iniciar sesión otra vez.",
      "The platform needs you to sign in again.",
    ],
    delivery_unavailable: [
      "Esta conexión todavía no está disponible.",
      "This connection is not available yet.",
    ],
    delivery_busy: [
      "La conexión está en proceso. Espera un momento.",
      "This connection is in progress. Please wait.",
    ],
    delivery_stale: [
      "La conexión cambió. Actualiza la página.",
      "The connection changed. Refresh the page.",
    ],
    delivery_login_expired: [
      "El inicio de sesión venció. Vuelve a conectar.",
      "Sign-in expired. Reconnect to continue.",
    ],
    delivery_store_invalid: [
      "Elige una tienda de esta cuenta.",
      "Choose a store from this account.",
    ],
  },
} as const;
