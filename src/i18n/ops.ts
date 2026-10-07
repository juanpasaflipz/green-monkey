import { defineArea } from "./define";

export default defineArea({
  es: {
    opsOpJobRequeued: "Tarea reintentada",
    opsOpJobCancelled: "Tarea cancelada",
    opsSupportReference: "Referencia de soporte: {ref}",
  },
  en: {
    opsOpJobRequeued: "Task retried",
    opsOpJobCancelled: "Task cancelled",
    opsSupportReference: "Support reference: {ref}",
  },
  errors: {
    server_draining: [
      "El servicio se está actualizando. Intenta de nuevo en unos segundos; no se perdió nada.",
      "The service is updating. Try again in a few seconds; nothing was lost.",
    ],
    job_not_requeueable: [
      "Esta tarea no se puede reintentar.",
      "This task cannot be retried.",
    ],
    job_not_cancellable: [
      "Esta tarea ya terminó; no se puede cancelar.",
      "This task has already finished; it cannot be cancelled.",
    ],
    // body-parser's other client errors (server/api-errors.ts, POL-R3-3).
    request_size_invalid: [
      "La solicitud llegó incompleta. Inténtalo de nuevo.",
      "The request arrived incomplete. Try again.",
    ],
    unsupported_encoding: [
      "La solicitud no se pudo leer. Actualiza la pantalla e inténtalo de nuevo.",
      "The request could not be read. Refresh the screen and try again.",
    ],
    unsupported_charset: [
      "La solicitud no se pudo leer. Actualiza la pantalla e inténtalo de nuevo.",
      "The request could not be read. Refresh the screen and try again.",
    ],
    too_many_parameters: [
      "La solicitud tiene demasiados datos. Reduce los datos e inténtalo de nuevo.",
      "The request has too many fields. Reduce the data and try again.",
    ],
  },
});
