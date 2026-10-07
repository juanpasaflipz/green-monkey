import { useRef, useState } from "react";
import type { Locale } from "../../../shared/domain";
import {
  REJECT_REASONS,
  type InboxHold,
  type RejectReason,
} from "../../../shared/public-ordering";
import { errorNotice, strings, type Key } from "../../i18n";
import { api } from "../../api";
import { Button, Modal } from "../../components/ui";
import { fill } from "../menu/format";

const reasonKey: Record<RejectReason, Key> = {
  unavailable: "publicReasonUnavailable",
  duplicate: "publicReasonDuplicate",
  not_present: "publicReasonNotPresent",
  closed: "publicReasonClosed",
  abuse: "publicReasonAbuse",
  other: "publicReasonOther",
};

/**
 * "Rechazar": a reason, and for managers rejecting abuse, deactivating the
 * printed code in the same step. Never asks for a PIN. One operation id per
 * opened dialog, so a retry after a lost response replays the stored result.
 */
export function RejectDialog({
  hold,
  locale,
  manager,
  onClose,
  onDone,
}: {
  hold: InboxHold;
  locale: Locale;
  manager: boolean;
  onClose: () => void;
  onDone: (code?: string) => void;
}) {
  const t = strings[locale];
  const operationId = useRef(crypto.randomUUID());
  const [reason, setReason] = useState<RejectReason>("unavailable");
  const [revoke, setRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api(`/ordering/holds/${hold.id}/reject`, {
        operationId: operationId.current,
        reason,
        revokeLink: manager && reason === "abuse" && revoke,
      });
      onDone();
    } catch (e) {
      const code = (e as Error).message;
      if (
        code === "public_order_not_pending" ||
        code === "public_order_expired"
      )
        return onDone(code);
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={fill(t.publicRejectTitle, { label: hold.label })}
      close={onClose}
      closeLabel={t.close}
      footer={
        <div className="row wrap">
          <Button variant="danger" disabled={busy} onClick={confirm}>
            {t.publicRejectConfirm}
          </Button>
          <Button disabled={busy} onClick={onClose}>
            {t.cancel}
          </Button>
        </div>
      }
    >
      <fieldset className="public-reasons">
        <legend>{t.publicRejectReason}</legend>
        {REJECT_REASONS.map((r) => (
          <label className="option" key={r}>
            <input
              type="radio"
              name={`reject-${hold.id}`}
              checked={reason === r}
              onChange={() => setReason(r)}
            />
            <span>{t[reasonKey[r]]}</span>
          </label>
        ))}
      </fieldset>
      {manager && reason === "abuse" && (
        <label className="option">
          <input
            type="checkbox"
            checked={revoke}
            onChange={(e) => setRevoke(e.target.checked)}
          />
          <span>{t.publicRejectAndRevoke}</span>
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
