import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Locale, Session } from "../../shared/domain";
import type { StaffRow } from "../../shared/access";
import { strings, errorNotice, translateError, type Key } from "../i18n";
import { api } from "../api";
import { Badge, Button, Field, Modal } from "../components/ui";
import { lockTime } from "./PinPad";
import { dateTime } from "../datetime";
import "../access/access.css";

/**
 * A new PIN: 6 to 8 digits. Checked on submit with the specific message
 * (pin_invalid_format) instead of the browser's generic validation bubble,
 * which never names the rule (FOH-8; restaurant-day A4.3).
 */
const PIN_FORMAT = /^\d{6,8}$/;

const ROLES = ["manager", "cashier", "server", "kitchen"] as const;

/** A stable operationId per dialog action; renewed only after it succeeds. */
function useOperation() {
  const [id, setId] = useState(() => crypto.randomUUID());
  return [id, () => setId(crypto.randomUUID())] as const;
}
function shortDate(iso: string, locale: Locale) {
  return new Date(iso).toLocaleDateString(locale === "es" ? "es-MX" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
/**
 * Managers unlock cashiers, servers and kitchen staff, and never a hard lock;
 * owners and managers are unlocked by the owner only (A5).
 */
function managerUnlockable(row: StaffRow) {
  return (
    ["cashier", "server", "kitchen"].includes(row.role) && !row.locked.hard
  );
}
function locked(row: StaffRow) {
  return (
    row.locked.hard ||
    (row.locked.until !== null &&
      new Date(row.locked.until).getTime() > Date.now())
  );
}

/**
 * Team (SEC-3): owners add staff with a PIN, edit name and role, reset PINs
 * (including their own PIN for shared terminals), deactivate and reactivate;
 * owners unlock anyone, managers unlock cashiers, servers and kitchen staff
 * (SEC-2/A5).
 */
export function StaffManagement({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const owner = session.role === "owner";
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [free, setFree] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [unlockOperation, renewUnlock] = useOperation();
  async function load() {
    try {
      const [staff, plan] = await Promise.all([
        api<StaffRow[]>("/access/staff"),
        api<{ plan: string }>("/plan").catch(() => ({ plan: "pro" })),
      ]);
      setRows(staff);
      setFree(plan.plan === "free");
      setEditing((current) =>
        current ? (staff.find((r) => r.id === current.id) ?? null) : null,
      );
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function unlock(row: StaffRow) {
    setError("");
    try {
      await api(`/access/staff/${row.id}/unlock`, {
        operationId: unlockOperation,
      });
      renewUnlock();
      setNotice(t.accessStaffUnlocked.replace("{name}", row.name));
      await load();
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  const accessLabel = (row: StaffRow) =>
    ({
      pin: t.accessStaffPin,
      google: t.accessStaffGoogle,
      google_and_pin: t.accessStaffGooglePin,
      none: t.accessStaffNoPin,
    })[row.access];
  return (
    <section className="staff-management" aria-label={t.team}>
      {owner && (
        <div className="row wrap">
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus size={18} aria-hidden="true" />
            {t.accessStaffAdd}
          </Button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {rows && (
        <div className="data-table">
          <table>
            <thead>
              <tr>
                <th>{t.accessStaffName}</th>
                <th>{t.accessStaffLogin}</th>
                <th>{t.accessStaffRole}</th>
                <th>{t.accessStaffStatus}</th>
                <th>{t.accessStaffLastSeen}</th>
                <th>{t.accessStaffAccess}</th>
                <th>
                  <span className="visually-hidden">
                    {t.accessStaffActions}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.active ? "" : "muted"}>
                  <td>
                    <strong>{row.name}</strong>
                  </td>
                  <td>{row.login.startsWith("account-") ? "—" : row.login}</td>
                  <td>{t[row.role as Key]}</td>
                  <td>
                    <div className="badge-stack">
                      <Badge tone={row.active ? "green" : "neutral"}>
                        {row.active
                          ? t.accessStaffActive
                          : t.accessStaffInactive}
                      </Badge>
                      {locked(row) && (
                        <Badge tone="red">{t.accessStaffLocked}</Badge>
                      )}
                      {free &&
                        row.active &&
                        row.role !== "owner" &&
                        row.freeSlot === null && (
                          <Badge tone="amber">
                            {t.accessStaffFreeUnselected}
                          </Badge>
                        )}
                    </div>
                    {locked(row) && (
                      <p className="tiny muted">
                        {row.locked.hard || !row.locked.until
                          ? t.accessHardLocked
                          : t.accessStaffLockedOn
                              .replace(
                                "{n}",
                                String(Math.max(1, row.locked.devices)),
                              )
                              .replace(
                                "{time}",
                                lockTime(row.locked.until, locale),
                              )}
                      </p>
                    )}
                  </td>
                  <td>
                    {row.lastSignInAt
                      ? dateTime(
                          row.lastSignInAt,
                          session.restaurant.timezone,
                          locale,
                        )
                      : "—"}
                  </td>
                  <td>
                    {accessLabel(row)}
                    {row.pinSetAt && (
                      <span className="tiny muted block">
                        {t.accessStaffPinSince.replace(
                          "{date}",
                          shortDate(row.pinSetAt, locale),
                        )}
                      </span>
                    )}
                  </td>
                  <td className="actions">
                    {owner ? (
                      <Button
                        aria-label={`${t.accessStaffEdit} ${row.name}`}
                        onClick={() => {
                          setNotice("");
                          setEditing(row);
                        }}
                      >
                        {t.accessStaffEdit}
                      </Button>
                    ) : (
                      locked(row) &&
                      (managerUnlockable(row) ? (
                        <Button
                          aria-label={`${t.accessStaffUnlock} ${row.name}`}
                          onClick={() => void unlock(row)}
                        >
                          {t.accessStaffUnlock}
                        </Button>
                      ) : (
                        <span className="tiny muted">
                          {t.accessStaffUnlockOwnerOnly.replace(
                            "{name}",
                            row.name,
                          )}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <AddStaff
          locale={locale}
          close={() => setAdding(false)}
          saved={async (row) => {
            setAdding(false);
            setNotice(
              t.accessStaffCreated
                .replace("{name}", row.name)
                .replace("{login}", row.login),
            );
            await load();
          }}
        />
      )}
      {editing && (
        <EditStaff
          row={editing}
          locale={locale}
          close={() => setEditing(null)}
          saved={async (message) => {
            setNotice(message);
            await load();
          }}
        />
      )}
    </section>
  );
}

function PinFields({
  locale,
  pin,
  confirm,
  setPin,
  setConfirm,
  label,
}: {
  locale: Locale;
  pin: string;
  confirm: string;
  setPin: (v: string) => void;
  setConfirm: (v: string) => void;
  label?: string;
}) {
  const t = strings[locale];
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 8);
  return (
    <>
      <Field label={label ?? t.accessStaffNewPin}>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={8}
          required
          value={pin}
          onChange={(e) => setPin(digits(e.target.value))}
        />
      </Field>
      <Field label={t.accessStaffConfirmPin}>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={8}
          required
          value={confirm}
          onChange={(e) => setConfirm(digits(e.target.value))}
        />
      </Field>
    </>
  );
}

function AddStaff({
  locale,
  close,
  saved,
}: {
  locale: Locale;
  close: () => void;
  saved: (row: StaffRow) => Promise<void>;
}) {
  const t = strings[locale];
  const [operationId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("cashier");
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={t.accessStaffAdd} close={close} closeLabel={t.close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          if (!PIN_FORMAT.test(pin))
            return setError(translateError("pin_invalid_format", locale));
          if (pin !== confirm) return setError(t.accessStaffPinMismatch);
          setBusy(true);
          try {
            const row = await api<StaffRow>("/access/staff", {
              operationId,
              name,
              role,
              pin,
              ...(login.trim() ? { login: login.trim() } : {}),
            });
            await saved(row);
          } catch (err) {
            setError(errorNotice(err, locale));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t.accessStaffName}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            autoComplete="off"
          />
        </Field>
        <Field label={t.accessStaffRole}>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t[r as Key]}
              </option>
            ))}
          </select>
        </Field>
        <PinFields
          locale={locale}
          pin={pin}
          confirm={confirm}
          setPin={setPin}
          setConfirm={setConfirm}
        />
        <Field label={t.accessStaffUsername}>
          <input
            value={login}
            onChange={(e) => setLogin(e.target.value.toLowerCase())}
            maxLength={40}
            pattern="[a-z0-9][a-z0-9._\-]{1,39}"
            autoComplete="off"
            aria-describedby="staff-login-hint"
          />
        </Field>
        <p id="staff-login-hint" className="tiny muted">
          {t.accessStaffUsernameHint}
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          className="full"
          disabled={busy}
        >
          {busy ? t.accessBusy : t.save}
        </Button>
      </form>
    </Modal>
  );
}

function EditStaff({
  row,
  locale,
  close,
  saved,
}: {
  row: StaffRow;
  locale: Locale;
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const t = strings[locale];
  const [saveOperation, renewSave] = useOperation();
  const [pinOperation, renewPin] = useOperation();
  const [unlockOperation, renewUnlock] = useOperation();
  const [activeOperation, renewActive] = useOperation();
  const [name, setName] = useState(row.name);
  const [role, setRole] = useState(row.role);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ownerRow = row.role === "owner";
  // Deactivation unpairs the personal devices; terminals stay for review (ACC-R6-2).
  const personalDevices = row.pairedDevices.filter(
    (d) => d.kind === "personal",
  );
  const pairedTerminals = row.pairedDevices.filter(
    (d) => d.kind === "terminal",
  );
  async function run(
    path: string,
    body: object,
    renew: () => void,
    message: string,
  ) {
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      renew();
      await saved(message);
      return true;
    } catch (e) {
      setError(errorNotice(e, locale));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t.accessStaffEditTitle.replace("{name}", row.name)}
      close={close}
      closeLabel={t.close}
      wide
    >
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run(
            `/access/staff/${row.id}`,
            { operationId: saveOperation, name, role },
            renewSave,
            t.accessStaffSaved,
          );
        }}
      >
        <Field label={t.accessStaffName}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            autoComplete="off"
          />
        </Field>
        <Field label={t.accessStaffRole}>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={ownerRow || row.isSelf}
          >
            {(ownerRow ? ["owner"] : ROLES).map((r) => (
              <option key={r} value={r}>
                {t[r as Key]}
              </option>
            ))}
          </select>
        </Field>
        {ownerRow && <p className="tiny muted">{t.accessStaffOwnerFixed}</p>}
        <Button type="submit" variant="primary" disabled={busy}>
          {t.accessStaffSave}
        </Button>
      </form>
      <hr />
      {/* A3 (account 031): another owner's PIN is theirs to set (owner_pin_self_only). */}
      {ownerRow && !row.isSelf ? (
        <p className="muted">{t.accessStaffOwnerPinSelf}</p>
      ) : (
        <form
          aria-labelledby={`pin-${row.id}`}
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            if (!PIN_FORMAT.test(pin))
              return setError(translateError("pin_invalid_format", locale));
            if (pin !== confirm) return setError(t.accessStaffPinMismatch);
            if (
              await run(
                `/access/staff/${row.id}/pin`,
                { operationId: pinOperation, pin },
                renewPin,
                t.accessStaffPinSaved.replace("{name}", row.name),
              )
            ) {
              setPin("");
              setConfirm("");
            }
          }}
        >
          <h3 id={`pin-${row.id}`}>
            {row.isSelf ? t.accessStaffMyPin : t.accessStaffPin}
          </h3>
          {row.isSelf && <p className="muted">{t.accessStaffMyPinHint}</p>}
          <PinFields
            locale={locale}
            pin={pin}
            confirm={confirm}
            setPin={setPin}
            setConfirm={setConfirm}
          />
          <Button type="submit" disabled={busy}>
            {t.accessStaffSetPin}
          </Button>
        </form>
      )}
      {locked(row) && (
        <>
          <hr />
          <p>
            {row.locked.hard || !row.locked.until
              ? t.accessHardLocked
              : t.accessStaffLockedOn
                  .replace("{n}", String(Math.max(1, row.locked.devices)))
                  .replace("{time}", lockTime(row.locked.until, locale))}
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void run(
                `/access/staff/${row.id}/unlock`,
                { operationId: unlockOperation },
                renewUnlock,
                t.accessStaffUnlocked.replace("{name}", row.name),
              )
            }
          >
            {t.accessStaffUnlock}
          </Button>
        </>
      )}
      {!ownerRow && !row.isSelf && (
        <>
          <hr />
          {row.active ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {t.accessStaffDeactivate}
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  `/access/staff/${row.id}/active`,
                  { operationId: activeOperation, active: true },
                  renewActive,
                  t.accessStaffReactivated.replace("{name}", row.name),
                )
              }
            >
              {t.accessStaffReactivate}
            </Button>
          )}
        </>
      )}
      {confirming && (
        <Modal
          title={t.accessStaffDeactivate}
          close={() => setConfirming(false)}
          closeLabel={t.cancel}
          footer={
            <div className="row between">
              <Button onClick={() => setConfirming(false)}>{t.cancel}</Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  if (
                    await run(
                      `/access/staff/${row.id}/active`,
                      { operationId: activeOperation, active: false },
                      renewActive,
                      t.accessStaffDeactivated.replace("{name}", row.name),
                    )
                  )
                    setConfirming(false);
                }}
              >
                {t.accessStaffDeactivate}
              </Button>
            </div>
          }
        >
          <p>{t.accessStaffDeactivateConfirm.replace("{name}", row.name)}</p>
          {row.access !== "pin" && row.access !== "none" && (
            <p>{t.accessStaffDeactivateGoogle}</p>
          )}
          <p>{t.accessStaffDeactivatePending}</p>
          {personalDevices.length > 0 && (
            <p>
              {t.accessStaffDeactivatePersonal.replace(
                "{names}",
                personalDevices.map((d) => d.name).join(", "),
              )}
            </p>
          )}
          {personalDevices.some((d) => d.current) && (
            <p className="warning-note">{t.accessDevicesRevokeSelf}</p>
          )}
          {pairedTerminals.length > 0 && (
            <p>
              {t.accessStaffDeactivateTerminals.replace(
                "{names}",
                pairedTerminals.map((d) => d.name).join(", "),
              )}
            </p>
          )}
        </Modal>
      )}
    </Modal>
  );
}
