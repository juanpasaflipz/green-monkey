import {
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { X } from "lucide-react";
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
export function Modal({
  title,
  close,
  closeLabel,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  closeLabel: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      aria-labelledby={titleId}
      className={wide ? "wide" : ""}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <Button variant="ghost" aria-label={closeLabel} onClick={close}>
          <X size={22} />
        </Button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
