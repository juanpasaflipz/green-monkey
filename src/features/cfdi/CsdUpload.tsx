/**
 * CSD upload (spec §2.3 "CSD block", §4.6): the .cer and .key files go to `POST /cfdi/csd` as
 * base64 with the password. The web process checks them and seals them for the worker; the
 * password field is cleared after every attempt and never stored. One operationId per chosen pair
 * of files, kept across retries of the same files and renewed after a success (MON-3).
 *
 * The idle lock keeps this form mounted behind the lock screen (cfdi-rebase §2 item 4, review
 * CFDI-R10), so a typed password is also cleared when the session or employee changes, when the
 * page is hidden, and once it has sat untouched for as long as the idle lock allows (at most 2
 * minutes): it never outlives a lock.
 */
import { useEffect, useId, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { api } from "../../api";
import { strings, errorNotice } from "../../i18n";
import { Button } from "../../components/ui";

/** ArrayBuffer → base64 without spreading large arrays into String.fromCharCode. */
export function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(base64Of(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("cfdi_csd_invalid"));
    reader.readAsArrayBuffer(file);
  });
}

/** How long a typed CSD password may sit untouched: the idle-lock time, at most 2 minutes. */
export function passwordLifetimeMs(idleLockSeconds: number | null): number {
  const cap = 120;
  return (
    Math.max(
      5,
      Math.min(
        idleLockSeconds && idleLockSeconds > 0 ? idleLockSeconds : cap,
        cap,
      ),
    ) * 1000
  );
}

/** Files over 16 KB are not CSD files (the route caps each at 16 KB of base64). */
const MAX_BYTES = 12_000;

export function CsdUpload({
  session,
  locale,
  onDone,
}: {
  session: Session;
  locale: Locale;
  onDone: () => void;
}) {
  const t = strings[locale];
  const id = useId();
  const [cer, setCer] = useState<File | null>(null);
  const [key, setKey] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const owner = session.role === "owner";
  const idleLockSeconds = session.access?.idleLockSeconds ?? null;

  // A new session or employee never sees the previous one's password.
  useEffect(() => {
    setPassword("");
  }, [session.id, session.employeeId]);

  // Cleared when the page is hidden and before any idle lock can show over this form.
  useEffect(() => {
    if (!password) return;
    const clear = () => setPassword("");
    const hidden = () => {
      if (document.visibilityState === "hidden") clear();
    };
    const timer = setTimeout(clear, passwordLifetimeMs(idleLockSeconds));
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", clear);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", clear);
    };
  }, [password, idleLockSeconds]);

  async function upload() {
    if (!cer || !key || !password) return;
    setBusy(true);
    setError("");
    setNotice("");
    const secret = password;
    setPassword("");
    try {
      if (cer.size > MAX_BYTES || key.size > MAX_BYTES)
        throw new Error("cfdi_csd_invalid");
      const [cerB64, keyB64] = await Promise.all([
        readFile(cer),
        readFile(key),
      ]);
      await api("/cfdi/csd", {
        operationId,
        cer: cerB64,
        key: keyB64,
        password: secret,
      });
      setOperationId(crypto.randomUUID());
      setCer(null);
      setKey(null);
      setInputKey((n) => n + 1);
      setNotice(t.cfdiCsdUploaded);
      onDone();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cfdi-csd-form" key={inputKey}>
      <p className="muted">{t.cfdiCsdHint}</p>
      <label className="field">
        <span>{t.cfdiCsdCer}</span>
        <input
          type="file"
          accept=".cer"
          disabled={!owner || busy}
          onChange={(e) => {
            setCer(e.target.files?.[0] ?? null);
            setOperationId(crypto.randomUUID());
          }}
        />
      </label>
      <label className="field">
        <span>{t.cfdiCsdKey}</span>
        <input
          type="file"
          accept=".key"
          disabled={!owner || busy}
          onChange={(e) => {
            setKey(e.target.files?.[0] ?? null);
            setOperationId(crypto.randomUUID());
          }}
        />
      </label>
      <label className="field">
        <span>{t.cfdiCsdPassword}</span>
        <input
          type="password"
          autoComplete="off"
          value={password}
          disabled={!owner || busy}
          maxLength={256}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <div className="row wrap">
        <Button
          variant="primary"
          disabled={!owner || busy || !cer || !key || !password}
          onClick={() => void upload()}
        >
          {t.cfdiCsdUpload}
        </Button>
      </div>
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
