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
  },
});
