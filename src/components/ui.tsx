import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      type="button"
      className={`button ${variant} ${className}`}
      {...props}
    />
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty">
      <div className="empty-symbol">＋</div>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
    </div>
  );
}
/**
 * Where Modal portals its dialog: document.body, unless a page provides its own root. The kiosk
 * provides its main.diner.kiosk, so «Texto grande», «Modo alcance» and the kiosk's 64 px targets
 * apply inside its dialogs too (KIOSK-UX-07).
 */
export const ModalRoot = createContext<HTMLElement | null>(null);

export function Modal({
  title,
  close,
  closeLabel,
  children,
  wide = false,
  footer,
}: {
  title: string;
  close: () => void;
  closeLabel: string;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const root = useContext(ModalRoot);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return createPortal(
    <dialog
      aria-labelledby={titleId}
      className={[wide ? "wide" : "", footer ? "has-footer" : ""].join(" ")}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modal-head">
        {/* tabIndex -1: a dialog whose focused control went away (a discarded
            Borradores entry) moves the focus here, never to <body>. */}
        <h2 id={titleId} tabIndex={-1}>
          {title}
        </h2>
        <Button variant="ghost" aria-label={closeLabel} onClick={close}>
          <X size={22} />
        </Button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </dialog>,
    root ?? document.body,
  );
}
