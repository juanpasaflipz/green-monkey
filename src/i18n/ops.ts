import { defineArea } from "./define";

export default defineArea({
  es: {},
  en: {},
  errors: {
    server_draining: [
      "El servicio se está actualizando. Intenta de nuevo en unos segundos; no se perdió nada.",
      "The service is updating. Try again in a few seconds; nothing was lost.",
    ],
    job_not_requeueable: [
      "Esta tarea no se puede reintentar.",
      "This task cannot be retried.",
    ],
  },
});
