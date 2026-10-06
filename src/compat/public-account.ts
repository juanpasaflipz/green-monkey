// COMPAT SHIM S4 (public ordering Phase A, LD-P2). Account (031) ships these
// strings as the i18n keys accountGuestNameLabel, accountGuestNameHint,
// accountGuestPrivacyLink, accountGuestNoNotice, accountGuestPlatformPrivacy
// and accountGuestOrderingUnavailable (account.md §5.4, verbatim). B3 replaces
// guestCopy(locale) with strings[locale].accountGuest* and deletes this file;
// it never reaches integration/v1. Not i18n keys, so key uniqueness is unaffected.
import type { Locale } from "../../shared/domain";

export type GuestCopy = {
  nameLabel: string;
  nameHint: string;
  /** "{restaurant}" is replaced with the restaurant name. */
  privacyLink: string;
  noNotice: string;
  platformPrivacy: string;
  orderingUnavailable: string;
};

const copy: Record<Locale, GuestCopy> = {
  es: {
    nameLabel: "Nombre (opcional)",
    nameHint:
      "Solo para llamarte cuando tu pedido esté listo. Puedes usar un apodo.",
    privacyLink: "Aviso de privacidad de {restaurant}",
    noNotice:
      "Este restaurante aún no publicó un aviso de privacidad; no escribas datos personales.",
    platformPrivacy:
      "Pedido procesado con Green Monkey · Privacidad de la plataforma",
    orderingUnavailable:
      "Los pedidos en línea no están disponibles por ahora. Pide en el mostrador.",
  },
  en: {
    nameLabel: "Name (optional)",
    nameHint:
      "Only to call you when your order is ready. You can use a nickname.",
    privacyLink: "{restaurant} privacy notice",
    noNotice:
      "This restaurant hasn't published a privacy notice yet; don't enter personal data.",
    platformPrivacy: "Order processed with Green Monkey · Platform privacy",
    orderingUnavailable:
      "Online ordering is unavailable right now. Please order at the counter.",
  },
};

export function guestCopy(locale: Locale): GuestCopy {
  return copy[locale];
}

export const PLATFORM_PRIVACY_PATH = "/legal/privacidad#restaurantes";
