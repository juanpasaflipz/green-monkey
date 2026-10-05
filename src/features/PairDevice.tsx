import { useState } from "react";
import type { Locale } from "../../shared/domain";
import { strings, translateError } from "../i18n";
import { api } from "../api";
import { Button, Field } from "../components/ui";
import { finishPendingLogout } from "../access/session";

/** "Vincular este dispositivo": redeems a single-use pairing code (GAP-2). */
export function PairDevice({
  locale,
  onPaired,
}: {
  locale: Locale;
  onPaired: (restaurant: string) => void;
}) {
  const t = strings[locale];
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="access-card" aria-labelledby="pair-title">
      <h2 id="pair-title">{t.accessPairTitle}</h2>
      <p className="muted">{t.accessPairHint}</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await finishPendingLogout();
            const result = await api<{ restaurant: { name: string } }>(
              "/access/pair",
              { code },
            );
            setCode("");
            onPaired(result.restaurant.name);
          } catch (err) {
            const message = (err as Error).message;
            setError(
              translateError(
                message === "invalid_input" ? "pairing_code_invalid" : message,
                locale,
              ),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t.accessPairCode}>
          <input
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={12}
            required
          />
        </Field>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          className="full"
          disabled={busy || code.replace(/[\s-]/g, "").length < 8}
        >
          {busy ? t.accessBusy : t.accessPairSubmit}
        </Button>
      </form>
    </section>
  );
}
