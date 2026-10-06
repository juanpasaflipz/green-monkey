import { useEffect, useState } from "react";
import type { Locale, Session } from "../../shared/domain";
import { api, ApiError } from "../api";
import { Button, Field } from "../components/ui";
import { strings, translateError } from "../i18n";
import "./account.css";

type Privacy = { privacyNoticeUrl: string | null; version: number };
type ExportTable = { name: string; columns: number };

/** A same-origin download inside the step-up window, without exposing a reusable link. */
function startDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Settings › Privacidad y datos (account 031): the restaurant's own privacy
 * notice URL for QR/kiosk diners (owners edit, managers read) and the owner
 * data export (JSON or one table as CSV). Every export first calls
 * /account-data/tables, so a shared terminal asks for the owner's PIN (access
 * step-up) before the download starts.
 */
export function AccountPrivacy({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const owner = session.role === "owner";
  const terminal = session.access?.deviceKind === "terminal";
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [url, setUrl] = useState("");
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [tables, setTables] = useState<ExportTable[]>([]);
  const [table, setTable] = useState("");
  const [exportState, setExportState] = useState("");
  const [exportError, setExportError] = useState("");
  async function load() {
    try {
      const p = await api<Privacy>("/account/restaurant-privacy");
      setPrivacy(p);
      setUrl(p.privacyNoticeUrl ?? "");
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }
  useEffect(() => {
    void load();
    // A personal owner browser needs no PIN: list the tables right away.
    if (owner && !terminal) void listTables().catch(() => undefined);
  }, []);
  async function save(next: string | null) {
    if (!privacy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const saved = await api<Privacy>(
        "/account/restaurant-privacy",
        {
          operationId,
          expectedVersion: privacy.version,
          privacyNoticeUrl: next,
        },
        { idempotent: true },
      );
      setPrivacy(saved);
      setUrl(saved.privacyNoticeUrl ?? "");
      setOperationId(crypto.randomUUID());
      setMessage(t.accountPrivacySaved);
    } catch (e) {
      const code = (e as Error).message;
      if (code === "step_up_cancelled") return;
      setError(
        code === "invalid_input"
          ? t.accountPrivacyUrlInvalid
          : translateError(code, locale),
      );
      if (code === "settings_changed") {
        setOperationId(crypto.randomUUID());
        void load();
      }
    } finally {
      setBusy(false);
    }
  }
  async function listTables() {
    const list = await api<ExportTable[]>("/account-data/tables");
    setTables(list);
    setTable(
      (current) =>
        current ||
        (list.find((x) => x.name === "orders") ?? list[0])?.name ||
        "",
    );
    return list;
  }
  async function download(kind: "json" | "csv") {
    setExportError("");
    setExportState(t.accountExportPreparing);
    try {
      const list = await listTables();
      const chosen =
        table || (list.find((x) => x.name === "orders") ?? list[0])?.name;
      if (kind === "csv" && !chosen) return;
      startDownload(
        kind === "json"
          ? `/api/account-data/export.json?tenant=${encodeURIComponent(session.tenantId)}`
          : `/api/account-data/export/csv/${encodeURIComponent(chosen!)}?tenant=${encodeURIComponent(session.tenantId)}`,
      );
      setExportState(t.accountExportStarted);
    } catch (e) {
      setExportState("");
      const code = e instanceof ApiError ? e.message : "export_aborted";
      if (code !== "step_up_cancelled")
        setExportError(translateError(code, locale));
    }
  }
  return (
    <section
      className="panel account-privacy"
      aria-labelledby="account-privacy-title"
    >
      <h2 id="account-privacy-title">{t.accountPrivacyTitle}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(url.trim() || null);
        }}
      >
        <Field label={t.accountPrivacyUrlLabel}>
          <input
            type="url"
            inputMode="url"
            value={url}
            maxLength={500}
            placeholder="https://"
            readOnly={!owner}
            disabled={!privacy || busy}
            aria-describedby="account-privacy-hint"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <p id="account-privacy-hint" className="muted">
          {t.accountPrivacyUrlHint}
        </p>
        {!owner && <p className="muted">{t.accountPrivacyOwnerOnly}</p>}
        {owner && (
          <div className="row">
            <Button type="submit" variant="primary" disabled={!privacy || busy}>
              {t.accountPrivacySave}
            </Button>
            {privacy?.privacyNoticeUrl && (
              <Button disabled={busy} onClick={() => void save(null)}>
                {t.accountPrivacyRemove}
              </Button>
            )}
          </div>
        )}
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
      {owner && (
        <div className="account-export">
          <h3>{t.accountExportTitle}</h3>
          <p className="muted">{t.accountExportHint}</p>
          {terminal && <p className="muted">{t.accountExportStepUpHint}</p>}
          <div className="row">
            <Button onClick={() => void download("json")}>
              {t.accountExportJson}
            </Button>
          </div>
          <div className="row">
            <Field label={t.accountExportTable}>
              <select value={table} onChange={(e) => setTable(e.target.value)}>
                {tables.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
            <Button onClick={() => void download("csv")}>
              {t.accountExportCsv}
            </Button>
          </div>
          <p aria-live="polite" className="muted">
            {exportState}
          </p>
          {exportError && (
            <p role="alert" className="error">
              {exportError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
