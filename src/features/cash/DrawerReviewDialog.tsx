import { useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { api } from "../../api";
import { Button, Field, Modal } from "../../components/ui";
import { strings, translateError, type Key } from "../../i18n";
import { fill } from "../discounts/format";
import "./cash.css";

/**
 * "Revisar diferencia de caja": one immutable manager explanation of a closed
 * drawer's cash difference (POST /cash/drawers/:id/review).
 */
export function DrawerReviewDialog({
  drawerId,
  session: _session,
  locale,
  money,
  figures,
  close,
  saved,
}: {
  drawerId: string;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  figures: { expected: number; counted: number };
  close: () => void;
  saved: () => void | Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const [operationId] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={t("discountsReviewTitle")}
      close={close}
      closeLabel={t("close")}
    >
      <form
        className="cash-close"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`/cash/drawers/${drawerId}/review`, {
              operationId,
              note: note.trim(),
            });
            await saved();
          } catch (err) {
            setError(translateError((err as Error).message, locale));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {fill(t("discountsReviewFigures"), {
            expected: money(figures.expected),
            counted: money(figures.counted),
            difference: money(figures.counted - figures.expected),
          })}
        </p>
        <Field label={t("discountsReviewNote")}>
          <textarea
            required
            minLength={3}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row wrap">
          <Button onClick={close}>{t("discountsCancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("discountsReviewSave")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
