import { defineArea } from "./define";

/**
 * Guest marketing on the club (047, docs/MARKETING.md). Message text sent to members is
 * Spanish constants in shared/marketing.ts, like the club's own messages.
 */
export default defineArea({
  es: {
    marketingOpSettings: "Opciones de marketing actualizadas",
    marketingOpCampaignSaved: "Campaña guardada",
    marketingOpCampaignLaunched: "Campaña enviada",
    marketingOpCampaignScheduled: "Campaña programada",
    marketingOpCampaignCancelled: "Campaña cancelada",
    marketingOpAutomation: "Automatización de marketing actualizada",
  },
  en: {
    marketingOpSettings: "Marketing options updated",
    marketingOpCampaignSaved: "Campaign saved",
    marketingOpCampaignLaunched: "Campaign sent",
    marketingOpCampaignScheduled: "Campaign scheduled",
    marketingOpCampaignCancelled: "Campaign cancelled",
    marketingOpAutomation: "Marketing automation updated",
  },
  errors: {
    marketing_disabled: [
      "El marketing del club no está activo.",
      "Club marketing is not on.",
    ],
    channel_not_configured: [
      "Ninguno de los canales elegidos está habilitado para enviar todavía.",
      "None of the selected channels is enabled to send yet.",
    ],
    campaign_locked: [
      "Esta campaña ya no se puede modificar en su estado actual.",
      "This campaign can no longer be changed in its current state.",
    ],
    stale_campaign: [
      "La campaña cambió. Vuelve a abrirla y confirma de nuevo.",
      "The campaign changed. Open it again and confirm.",
    ],
    invalid_schedule: [
      "Elige una fecha y hora futuras para programar el envío.",
      "Choose a future date and time to schedule the send.",
    ],
  },
});
