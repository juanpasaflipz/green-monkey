import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Locale, Session } from "../../shared/domain";
import type { ManagedDevice, PairingCodeRow } from "../../shared/access";
import { ACCESS } from "../../shared/access";
import { strings, errorNotice } from "../i18n";
import { api } from "../api";
import { Badge, Button, Field, Modal } from "../components/ui";
import { serverSignOut } from "../access/session";
import "../access/access.css";

function useOperation() {
  const [id, setId] = useState(() => crypto.randomUUID());
  return [id, () => setId(crypto.randomUUID())] as const;
}
function relative(iso: string | null, locale: Locale) {
  if (!iso) return strings[locale].accessDevicesNeverSeen;
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(
    locale === "es" ? "es-MX" : "en-US",
    {
      numeric: "auto",
    },
  );
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(Math.round(seconds), "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86400), "day");
}
function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Settings → Dispositivos (SEC-5/GAP-2): paired devices with their kind, status,
 * last activity and live session; rename and auto-lock, end session, unpair;
 * single-use pairing codes for new terminals.
 */
export function DeviceManagement({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const owner = session.role === "owner";
  const [devices, setDevices] = useState<ManagedDevice[] | null>(null);
  const [codes, setCodes] = useState<PairingCodeRow[]>([]);
  const [showRevoked, setShowRevoked] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [editing, setEditing] = useState<ManagedDevice | null>(null);
  const [revoking, setRevoking] = useState<ManagedDevice | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [endOperation, renewEnd] = useOperation();
  const [cancelBusy, setCancelBusy] = useState("");
  async function load() {
    try {
      const [list, open] = await Promise.all([
        api<ManagedDevice[]>("/access/devices"),
        api<PairingCodeRow[]>("/access/pairing-codes"),
      ]);
      setDevices(list);
      setCodes(open);
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const canManage = (d: ManagedDevice) =>
    d.status !== "revoked" && (d.kind === "terminal" || owner);
  const visible = (devices ?? []).filter(
    (d) => showRevoked || d.status !== "revoked",
  );
  const openCodes = codes.filter((c) => c.state === "open");
  return (
    <section
      className="panel device-management"
      aria-labelledby="devices-title"
    >
      <div className="row between wrap">
        <h2 id="devices-title">{t.accessDevicesTitle}</h2>
        <Button variant="primary" onClick={() => setPairing(true)}>
          <Plus size={18} aria-hidden="true" />
          {t.accessDevicesPair}
        </Button>
      </div>
      <p className="muted">{t.accessDevicesHint}</p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {openCodes.length > 0 && (
        <div className="open-codes">
          <h3>{t.accessDevicesOpenCodes}</h3>
          <ul>
            {openCodes.map((c) => (
              <li key={c.id} className="row between wrap">
                <span>
                  <strong>{c.deviceName}</strong> ·{" "}
                  {t.accessDevicesExpiresIn.replace(
                    "{time}",
                    countdown(new Date(c.expiresAt).getTime() - Date.now()),
                  )}
                </span>
                <Button
                  variant="ghost"
                  disabled={cancelBusy === c.id}
                  aria-label={`${t.accessDevicesCancelCode} · ${c.deviceName}`}
                  onClick={async () => {
                    setCancelBusy(c.id);
                    setError("");
                    try {
                      await api(`/access/pairing-codes/${c.id}/cancel`, {});
                      await load();
                    } catch (e) {
                      setError(errorNotice(e, locale));
                    } finally {
                      setCancelBusy("");
                    }
                  }}
                >
                  {t.accessDevicesCancelCode}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {devices && (
        <ul className="device-list">
          {visible.map((d) => (
            <li key={d.id} className="device-row">
              <div className="device-main">
                <div className="row wrap device-title">
                  <strong>{d.name}</strong>
                  {d.current && (
                    <Badge tone="green">{t.accessDevicesThis}</Badge>
                  )}
                  <Badge
                    tone={
                      d.status === "active"
                        ? "green"
                        : d.status === "expired"
                          ? "amber"
                          : "red"
                    }
                  >
                    {
                      {
                        active: t.accessDevicesStatusActive,
                        revoked: t.accessDevicesStatusRevoked,
                        expired: t.accessDevicesStatusExpired,
                      }[d.status]
                    }
                  </Badge>
                  {d.freeSlot && <Badge>{t.accessDevicesFree}</Badge>}
                </div>
                <p className="muted tiny">
                  {d.kind === "terminal"
                    ? t.accessDevicesTerminal +
                      (d.pairedBy
                        ? ` · ${t.accessDevicesPairedBy.replace("{name}", d.pairedBy)}`
                        : "")
                    : t.accessDevicesPersonal.replace(
                        "{name}",
                        d.pairedBy ?? "—",
                      )}
                  {" · "}
                  {t.accessDevicesLastSeen}: {relative(d.lastSeenAt, locale)}
                  {d.liveSession &&
                    ` · ${t.accessDevicesInUse.replace("{name}", d.liveSession.employeeName)}`}
                </p>
                {d.sharedWarning && d.status === "active" && (
                  <p className="warning-note tiny">{t.accessDevicesShared}</p>
                )}
              </div>
              {canManage(d) && (
                <div className="row wrap device-actions">
                  <Button
                    aria-label={`${t.accessDevicesEdit} · ${d.name}`}
                    onClick={() => {
                      setNotice("");
                      setEditing(d);
                    }}
                  >
                    {t.accessDevicesEdit}
                  </Button>
                  {!d.current && d.liveSession && (
                    <Button
                      aria-label={`${t.accessDevicesEndSession} · ${d.name}`}
                      onClick={async () => {
                        setError("");
                        try {
                          await api(`/access/devices/${d.id}/end-session`, {
                            operationId: endOperation,
                          });
                          renewEnd();
                          setNotice(
                            t.accessDevicesSessionEnded.replace(
                              "{name}",
                              d.name,
                            ),
                          );
                          await load();
                        } catch (e) {
                          setError(errorNotice(e, locale));
                        }
                      }}
                    >
                      {t.accessDevicesEndSession}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    aria-label={`${t.accessDevicesRevoke} · ${d.name}`}
                    onClick={() => {
                      setNotice("");
                      setRevoking(d);
                    }}
                  >
                    {t.accessDevicesRevoke}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(devices ?? []).some((d) => d.status === "revoked") && (
        <label className="opening-day">
          <input
            type="checkbox"
            checked={showRevoked}
            onChange={(e) => setShowRevoked(e.target.checked)}
          />
          {t.accessDevicesShowRevoked}
        </label>
      )}
      {pairing && (
        <PairingDialog
          locale={locale}
          close={() => {
            setPairing(false);
            void load();
          }}
        />
      )}
      {editing && (
        <EditDevice
          device={editing}
          locale={locale}
          close={() => setEditing(null)}
          saved={async () => {
            setEditing(null);
            setNotice(t.accessStaffSaved);
            await load();
          }}
        />
      )}
      {revoking && (
        <RevokeDevice
          device={revoking}
          locale={locale}
          close={() => setRevoking(null)}
          revoked={async () => {
            const current = revoking.current;
            setRevoking(null);
            if (current) {
              // This browser is no longer paired: sign out and show the gate.
              await serverSignOut(session.id);
              location.assign("/app");
              return;
            }
            setNotice(t.accessDevicesRevoked.replace("{name}", revoking.name));
            await load();
          }}
        />
      )}
    </section>
  );
}

function PairingDialog({
  locale,
  close,
}: {
  locale: Locale;
  close: () => void;
}) {
  const t = strings[locale];
  const [name, setName] = useState(t.accessDevicesDefaultName);
  const [code, setCode] = useState<{
    id: string;
    code: string;
    deviceName: string;
    expiresAt: string;
  } | null>(null);
  const [state, setState] = useState<PairingCodeRow["state"]>("open");
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [free, setFree] = useState(false);
  useEffect(() => {
    // On Free the first device to sign in (often the owner's phone) holds the
    // selling slot, so a new terminal may need to be selected explicitly.
    void api<{ plan: string }>("/plan")
      .then((p) => setFree(p.plan === "free"))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!code || state !== "open") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      try {
        const rows = await api<PairingCodeRow[]>("/access/pairing-codes");
        const row = rows.find((r) => r.id === code.id);
        if (row && row.state !== "open") setState(row.state);
      } catch {
        /* Keep counting down; the next poll retries. */
      }
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [code, state]);
  const remaining = code ? new Date(code.expiresAt).getTime() - now : 0;
  const expired = Boolean(code) && (state === "expired" || remaining <= 0);
  return (
    <Modal title={t.accessDevicesPair} close={close} closeLabel={t.close}>
      {!code ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setCode(await api("/access/pairing-codes", { deviceName: name }));
              setState("open");
              setNow(Date.now());
            } catch (err) {
              setError(errorNotice(err, locale));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={t.accessDevicesName}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              autoComplete="off"
              aria-describedby="device-name-hint"
            />
          </Field>
          <p id="device-name-hint" className="tiny muted">
            {t.accessDevicesNameHint}
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
            disabled={busy || !name.trim()}
          >
            {busy ? t.accessBusy : t.accessDevicesGenerate}
          </Button>
        </form>
      ) : state === "consumed" ? (
        <>
          <p role="status" className="pairing-done">
            {t.accessDevicesPaired.replace("{name}", code.deviceName)}
          </p>
          {free && <p className="muted">{t.accessDevicesPairedFree}</p>}
        </>
      ) : expired || state === "cancelled" ? (
        <>
          <p role="status">{t.accessDevicesCodeExpired}</p>
          <Button onClick={() => setCode(null)}>
            {t.accessDevicesGenerate}
          </Button>
        </>
      ) : (
        <div className="pairing-code">
          <p className="muted pairing-code-label">{t.accessPairCode}</p>
          <p className="pairing-code-value">{code.code}</p>
          <p role="timer" aria-live="off">
            {t.accessDevicesExpiresIn.replace("{time}", countdown(remaining))}
          </p>
          <p>
            {t.accessDevicesCodeHint.replace("{url}", `${location.origin}/app`)}
          </p>
        </div>
      )}
    </Modal>
  );
}

function EditDevice({
  device,
  locale,
  close,
  saved,
}: {
  device: ManagedDevice;
  locale: Locale;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const t = strings[locale];
  const [operationId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(device.name);
  const [idle, setIdle] = useState(
    device.idleLockSeconds === null
      ? "default"
      : String(device.idleLockSeconds),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={t.accessDevicesEditTitle.replace("{name}", device.name)}
      close={close}
      closeLabel={t.close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`/access/devices/${device.id}`, {
              operationId,
              name,
              idleLockSeconds: idle === "default" ? null : Number(idle),
            });
            await saved();
          } catch (err) {
            setError(errorNotice(err, locale));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t.accessDevicesName}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            required
            autoComplete="off"
          />
        </Field>
        <Field label={t.accessDevicesAutoLock}>
          <select value={idle} onChange={(e) => setIdle(e.target.value)}>
            <option value="default">{t.accessDevicesAutoLockDefault}</option>
            {ACCESS.idleLockChoices.map((s) => (
              <option key={s} value={String(s)}>
                {s === 0
                  ? t.accessDevicesNever
                  : t.accessDevicesMinutes.replace("{n}", String(s / 60))}
              </option>
            ))}
          </select>
        </Field>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {t.accessStaffSave}
        </Button>
      </form>
    </Modal>
  );
}

function RevokeDevice({
  device,
  locale,
  close,
  revoked,
}: {
  device: ManagedDevice;
  locale: Locale;
  close: () => void;
  revoked: () => Promise<void>;
}) {
  const t = strings[locale];
  const [operationId] = useState(() => crypto.randomUUID());
  const [ack, setAck] = useState(false);
  // A drawer opened after the list loaded is reported by the server; the
  // acknowledgement then appears here (ACC-FLOOR-11).
  const [openDrawer, setOpenDrawer] = useState(device.openDrawer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={t.accessDevicesRevoke}
      close={close}
      closeLabel={t.cancel}
      footer={
        <div className="row between">
          <Button onClick={close}>{t.cancel}</Button>
          <Button
            variant="danger"
            disabled={busy || (openDrawer && !ack)}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api(`/access/devices/${device.id}/revoke`, {
                  operationId,
                  acknowledgeOpenDrawer: ack,
                });
                await revoked();
              } catch (e) {
                const code = (e as Error).message;
                if (code === "open_drawer_ack_required") setOpenDrawer(true);
                setError(errorNotice(e, locale));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.accessDevicesRevoke}
          </Button>
        </div>
      }
    >
      <p>{t.accessDevicesRevokeConfirm.replace("{name}", device.name)}</p>
      {device.current && <p className="error">{t.accessDevicesRevokeSelf}</p>}
      {openDrawer && (
        <>
          <p>{t.accessDevicesRevokeDrawer}</p>
          <label className="opening-day">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {t.accessDevicesRevokeDrawerAck}
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}
