import type { Locale } from "../../../shared/domain";
import {
  PAYMENTS_LIMITS,
  type PlatformCode,
  type PlatformOption,
} from "../../../shared/payments";
import { strings, type Key } from "../../i18n";
import { Field } from "../../components/ui";

export const PLATFORM_KEYS: Record<PlatformCode, Key> = {
  uber_eats: "platformUberEats",
  rappi: "platformRappi",
  didi_food: "platformDidi",
  other: "platformOther",
};

/**
 * Payments (037): "Pagado por plataforma". The platform covers the whole
 * balance with no tip (Q6); Uber Eats, Rappi and DiDi need the platform's
 * order number (LD-75; «Otra»'s is optional) and the cashier confirms the
 * platform already charged the order.
 */
export function PlatformFields({
  platforms,
  platform,
  onPlatform,
  label,
  onLabel,
  reference,
  onReference,
  confirmed,
  onConfirmed,
  locale,
  disabled,
  problem,
  errorIdOf,
  values,
}: {
  platforms: PlatformOption[];
  platform: PlatformCode | null;
  onPlatform: (p: PlatformCode) => void;
  label: string;
  onLabel: (v: string) => void;
  reference: string;
  onReference: (v: string) => void;
  confirmed: boolean;
  onConfirmed: (v: boolean) => void;
  locale: Locale;
  disabled?: boolean;
  problem: { field: string; key: string } | null;
  errorIdOf: (field: string) => string | undefined;
  /** Values for the problem text's {platform} and {list} (LD-75 price-list problems). */
  values?: Record<string, string>;
}) {
  const t = (k: Key) => strings[locale][k];
  const inline = (field: string) =>
    problem?.field === field ? (
      <p className="error field-error" id={errorIdOf(field)}>
        {Object.entries(values ?? {}).reduce(
          (text, [name, value]) => text.replaceAll(`{${name}}`, value),
          String(t(problem.key as Key)),
        )}
      </p>
    ) : null;
  return (
    <>
      <div
        className="service-tabs wrap"
        role="group"
        aria-label={t("payPlatform")}
      >
        {platforms.map((p) => (
          <button
            key={p.platform}
            type="button"
            disabled={disabled}
            aria-pressed={platform === p.platform}
            className={platform === p.platform ? "selected" : ""}
            onClick={() => onPlatform(p.platform)}
          >
            {t(PLATFORM_KEYS[p.platform])}
          </button>
        ))}
      </div>
      {platform === "other" && (
        <Field label={t("payPlatformOtherName")}>
          <input
            value={label}
            maxLength={40}
            autoComplete="off"
            aria-invalid={problem?.field === "platform" || undefined}
            aria-describedby={errorIdOf("platform")}
            onChange={(e) => onLabel(e.target.value)}
          />
        </Field>
      )}
      {inline("platform")}
      <Field
        label={t(
          platform === "other"
            ? "payPlatformOrderNumberOptional"
            : "payPlatformOrderNumber",
        )}
      >
        <input
          value={reference}
          maxLength={PAYMENTS_LIMITS.platformReferenceMax}
          autoComplete="off"
          aria-invalid={problem?.field === "reference" || undefined}
          aria-describedby={errorIdOf("reference")}
          onChange={(e) => onReference(e.target.value)}
        />
      </Field>
      {inline("reference")}
      <label className="option">
        <input
          type="checkbox"
          checked={confirmed}
          aria-describedby={errorIdOf("confirmed")}
          onChange={(e) => onConfirmed(e.target.checked)}
        />
        {t("payPlatformConfirm")}
      </label>
      {inline("confirmed")}
    </>
  );
}
