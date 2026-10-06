import { useState } from "react";
import type { Locale, Session } from "../../shared/domain";
import { strings, translateError } from "../i18n";
import { api, isSessionRejection, type ApiError } from "../api";
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
  onSessionEnded,
}: {
  session: Session;
  locale: Locale;
  onConfirmed: () => void;
  onCancel: () => void;
  /** The session itself was rejected (401): the command fails with that error. */
  onSessionEnded: (error: ApiError) => void;
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
            // /access/* 401s skip the global handler; a session that ended
            // while the prompt was open shows its lock instead of a PIN error
            // that repeats on every attempt (ACC-FLOOR-12).
            if (isSessionRejection(e)) {
              window.dispatchEvent(
                new CustomEvent("gm-unauthorized", {
                  detail: (e as ApiError).message,
                }),
              );
              onSessionEnded(e as ApiError);
              return;
            }
            setError(translateError((e as Error).message, locale));
          } finally {
            setBusy(false);
          }
        }}
      />
    </Modal>
  );
}
