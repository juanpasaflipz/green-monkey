import { useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { api } from "../../api";
import { db, type Pending } from "../../offline";
import { settleAlreadySynced } from "../../offline-queue";
import { Button, Field } from "../../components/ui";
import { translateError } from "../../i18n";
import { withLocks } from "../../platform";
import { translator } from "./format";

/**
 * Manager archive of a local record that will never be recorded as a sale
 * (OFF-8). The evidence is kept on the server with the manager and reason.
 */
export function ArchiveRecordForm({
  row,
  locale,
  done,
}: {
  row: Pending;
  session: Session;
  locale: Locale;
  done: () => void;
}) {
  const t = translator(locale);
  // One archive command per dialog: a retried submit replays, never duplicates.
  const [operationId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      await withLocks("green-monkey-sync:" + row.scope, async () => {
        try {
          await api(
            "/offline/archive",
            {
              operationId,
              record: row.body,
              localError: row.error ? row.error.slice(0, 100) : null,
              reason,
              confirmed: true,
            },
            { idempotent: true },
          );
          await db.pending.update(row.id, {
            status: "archived",
            archivedAt: Date.now(),
            waitReason: undefined,
          });
        } catch (e) {
          if ((e as Error).message !== "offline_already_synced") throw e;
          await settleAlreadySynced(row);
        }
      });
      done();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3>{t("offlineArchiveTitle")}</h3>
      <p className="warning-panel">{t("offlineArchiveWarning")}</p>
      <Field label={t("offlineArchiveReason")}>
        <textarea
          required
          minLength={10}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <label className="row">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {t("offlineArchiveConfirm")}
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <Button
          type="submit"
          variant="danger"
          disabled={busy || !confirmed || reason.trim().length < 10}
        >
          {t("offlineArchiveSubmit")}
        </Button>
        <Button onClick={done}>{t("offlineCancel")}</Button>
      </div>
    </form>
  );
}
