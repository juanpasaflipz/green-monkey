import type { ReactNode } from "react";
import "./printing.css";

/**
 * Shared print layout (reports 029, spec §2.10/§5.5) for the cortes, the corte del día, the
 * report sheet and the kitchen cancellation chits. Rendered inside service's `.print-doc`
 * container (src/print.tsx), which sets the 72/48 mm width; nothing here fixes a width. Long
 * labels wrap, amounts never do. Boxed notes reuse service's DocNote (KitchenTicket.tsx).
 */
export function DocHeader({
  name,
  title,
  lines = [],
  flag,
}: {
  name: string;
  title: string;
  lines?: ReactNode[];
  flag?: string;
}) {
  return (
    <header className="doc-header">
      <h2 className="doc-title">{name}</h2>
      <p className="doc-flag">{title}</p>
      {flag && <p className="doc-flag">{flag}</p>}
      {lines.map((line, i) => (
        <p className="doc-meta" key={i}>
          {line}
        </p>
      ))}
    </header>
  );
}

export function DocSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="doc-section">
      {title && <h3 className="doc-section-title">{title}</h3>}
      {children}
    </section>
  );
}

/** One label/amount row: `.doc-row` → `.doc-label` + `.doc-amount` (acceptance reportValue). */
export function DocRow({
  label,
  value,
  strong = false,
  indent = false,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={
        "doc-row" + (strong ? " strong" : "") + (indent ? " indent" : "")
      }
    >
      <span className="doc-label">{label}</span>
      <span className="doc-amount">{value}</span>
    </div>
  );
}

export function DocRule() {
  return <hr className="doc-rule" />;
}

export function DocSignature({ label }: { label: string }) {
  return <p className="doc-signature">{label}</p>;
}

export function DocFooter({ children }: { children: ReactNode }) {
  return <p className="doc-footer">{children}</p>;
}
