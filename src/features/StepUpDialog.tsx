import { useState } from "react";
import type { Locale, Session } from "../../shared/domain";
import { strings, translateError } from "../i18n";
import { api } from "../api";
import { Modal } from "../components/ui";
import { PinPad } from "./PinPad";

/**
 * "Confirma con tu PIN": re-verifies the current employee before a sensitive
 * command on a shared terminal. api() then retries the identical request.
 */
export function StepUpDialog({
  session,
  locale,
  onConfirmed,
  onCancel,
}: {
  session: Session;
  locale: Locale;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const t = strings[locale];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={t.accessStepUpTitle} close={onCancel} closeLabel={t.cancel}>
      <p>{t.accessStepUpHint.replace("{name}", session.name)}</p>
      <PinPad
        employee={session}
        locale={locale}
        busy={busy}
        error={error}
        submitLabel={t.accessConfirm}
        onSubmit={async (secret) => {
          setBusy(true);
          setError("");
          try {
            await api("/access/step-up", { secret });
            onConfirmed();
          } catch (e) {
            setError(translateError((e as Error).message, locale));
          } finally {
            setBusy(false);
          }
        }}
      />
    </Modal>
  );
}
