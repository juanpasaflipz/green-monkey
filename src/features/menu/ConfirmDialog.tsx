import { useRef, useState } from "react";
import { Button, Modal } from "../../components/ui";
import type { Translate } from "./format";

/**
 * Small confirmation on top of an editor or list. Escape, the close button
 * and the system back gesture (a dialog cancel event) all mean "keep going
 * as before", never the confirmed action.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  t,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  t: Translate;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} close={onCancel} closeLabel={t("close")}>
      <p>{message}</p>
      <div className="row wrap menu-confirm-actions">
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button onClick={onCancel}>{cancelLabel}</Button>
      </div>
    </Modal>
  );
}

/**
 * Guards actions that would drop unsaved edits (close, Duplicar, a template).
 * `guard(action)` runs the action at once when the form is unchanged and
 * otherwise asks "¿Descartar los cambios?" first.
 *
 * Render `anchor` inside the guarded Modal. A second close request with no
 * click or typing in between (Escape or the Android back gesture again)
 * reaches the dialog as a cancel event the browser does not let the page
 * prevent, so the editor dialog closes natively while it is still mounted;
 * "Seguir editando" then shows it again instead of leaving an invisible form.
 */
export function useDiscardGuard(dirty: boolean, t: Translate) {
  const [pending, setPending] = useState<{
    message: string;
    confirm: string;
    action: () => void;
  } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const keepEditing = () => {
    setPending(null);
    const editor = ref.current?.closest("dialog");
    if (editor && !editor.open) editor.showModal();
  };
  const guard = (
    action: () => void,
    message = t("menuDiscardMessage"),
    confirm = t("menuDiscard"),
  ) => (dirty ? setPending({ message, confirm, action }) : action());
  const dialog = pending ? (
    <ConfirmDialog
      title={t("menuDiscardTitle")}
      message={pending.message}
      confirmLabel={pending.confirm}
      cancelLabel={t("menuKeepEditing")}
      danger
      t={t}
      onCancel={keepEditing}
      onConfirm={() => {
        const { action } = pending;
        setPending(null);
        action();
      }}
    />
  ) : null;
  const anchor = <span ref={ref} hidden />;
  return { guard, dialog, anchor };
}
