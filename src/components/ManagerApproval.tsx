import { useEffect, useState } from "react";
import type { Locale, Session } from "../../shared/domain";
import type { Approver } from "../../shared/access";
import { strings } from "../i18n";
import { api } from "../api";
import { Button, Field } from "./ui";

export type ApprovalValue = { employeeId: string; secret: string };

/**
 * Active owners and managers with a usable PIN on this restaurant, whether the
 * list failed to load, and a reload.
 */
export function useApproverList() {
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState("loading");
    void api<Approver[]>("/access/approvers")
      .then((rows) => {
        if (!current) return;
        setApprovers(rows);
        setState("loaded");
      })
      .catch(() => {
        if (current) setState("failed");
      });
    return () => {
      current = false;
    };
  }, [attempt]);
  return { approvers, state, reload: () => setAttempt((n) => n + 1) };
}
/** Active owners and managers with a usable PIN on this restaurant. */
export function useApprovers() {
  return useApproverList().approvers;
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
  const { approvers, state, reload } = useApproverList();
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
      {/* Say why nobody can approve and what to do (ACC-FLOOR-10). */}
      {state === "failed" && (
        <p role="alert" className="error">
          {t.accessApproversFailed}{" "}
          <Button variant="ghost" onClick={reload}>
            {t.retry}
          </Button>
        </p>
      )}
      {state === "loaded" && approvers.length === 0 && (
        <p role="alert" className="error">
          {t.accessApproversNone}
        </p>
      )}
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
