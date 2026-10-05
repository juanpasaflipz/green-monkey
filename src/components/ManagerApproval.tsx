import { useEffect, useState } from "react";
import type { Locale, Session } from "../../shared/domain";
import type { Approver } from "../../shared/access";
import { strings } from "../i18n";
import { api } from "../api";
import { Field } from "./ui";

export type ApprovalValue = { employeeId: string; secret: string };

/** Active owners and managers with a usable PIN on this restaurant. */
export function useApprovers() {
  const [approvers, setApprovers] = useState<Approver[]>([]);
  useEffect(() => {
    let current = true;
    void api<Approver[]>("/access/approvers")
      .then((rows) => {
        if (current) setApprovers(rows);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  return approvers;
}

/**
 * One-shot manager approval for a sensitive command: the approving manager is
 * chosen from a list (no usernames to type) and enters their PIN on this
 * device. A manager or owner on a shared terminal confirms with their own PIN.
 */
export function ManagerApproval({
  session,
  locale,
  value,
  onChange,
}: {
  session: Session;
  locale: Locale;
  value: ApprovalValue;
  onChange: (v: ApprovalValue) => void;
}) {
  const t = strings[locale];
  const approvers = useApprovers();
  const isManager = ["owner", "manager"].includes(session.role);
  useEffect(() => {
    if (value.employeeId || !approvers.length) return;
    const self = approvers.find((a) => a.id === session.employeeId);
    onChange({
      ...value,
      employeeId: isManager && self ? self.id : approvers[0]!.id,
    });
  }, [approvers]);
  const self = value.employeeId === session.employeeId;
  return (
    <fieldset className="manager-approval">
      <legend>{t.accessApprovalTitle}</legend>
      <p className="muted tiny">{t.accessApprovalHint}</p>
      <Field label={t.accessApprover}>
        <select
          value={value.employeeId}
          required
          onChange={(e) =>
            onChange({ employeeId: e.target.value, secret: "" })
          }
        >
          {!value.employeeId && <option value="">—</option>}
          {approvers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={self ? t.accessApprovalSelf : t.accessApproverPin}>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          required
          minLength={4}
          maxLength={200}
          value={value.secret}
          onChange={(e) => onChange({ ...value, secret: e.target.value })}
        />
      </Field>
    </fieldset>
  );
}
