/**
 * "Importar socios de POS Lite" (038 §6), shown only while the club is off. The browser parses
 * the operator's export file and previews it with the shared, pure previewLoyaltyImport; the
 * owner picks the reward policy, commits pages of 500 (step-up) and sees "Verificado" when the
 * server's totals equal the preview and the file's own summary. The file never leaves this page.
 */
import { useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  IMPORT_POLICIES,
  RECENT_DAYS,
  importPages,
  importVerified,
  posLiteExport,
  previewLoyaltyImport,
  type ImportPolicy,
  type ImportPreview,
  type PosLiteExport,
} from "../../../shared/loyalty-import";
import { errorNotice, type Key } from "../../i18n";
import { printDocument } from "../../print";
import { Button, Field } from "../../components/ui";
import { loyaltyApi } from "./loyaltyApi";
import { fill, tr } from "./format";

const REASON: Record<string, Key> = {
  phone: "loyaltyImportReasonPhone",
  country: "loyaltyImportReasonCountry",
  name: "loyaltyImportReasonName",
  duplicate: "loyaltyImportReasonDuplicate",
};
/** importVerified's field names, in words (LOYALTY-UX-14). */
const FIELD: Record<string, Key> = {
  members: "loyaltyImportFieldMembers",
  importStamps: "loyaltyImportFieldImportStamps",
  importRewards: "loyaltyImportFieldImportRewards",
  stamps: "loyaltyImportFieldStamps",
  rewards: "loyaltyImportFieldRewards",
  summary: "loyaltyImportFieldSummary",
};
const POLICY: Record<ImportPolicy, Key> = {
  recent: "loyaltyImportPolicyRecent",
  all: "loyaltyImportPolicyAll",
  none: "loyaltyImportPolicyNone",
};

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function LoyaltyImport({
  session,
  locale,
  online,
  stampsRequired,
  onApplySettings,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  stampsRequired: number;
  onApplySettings: (s: ImportPreview["suggested"]) => void;
}) {
  const t = tr(locale);
  const [file, setFile] = useState<{ data: PosLiteExport; hash: string } | null>(null);
  const [policy, setPolicy] = useState<ImportPolicy>("recent");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** A page failed: Importar becomes Reintentar (committed pages replay, LOYALTY-OPS-10). */
  const [failed, setFailed] = useState(false);
  const [verdict, setVerdict] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const preview = file
    ? previewLoyaltyImport(file.data, { policy, now: Date.now(), stampsRequired })
    : null;
  async function read(f: File) {
    setError("");
    setVerdict(null);
    setProgress(null);
    setFailed(false);
    try {
      const text = await f.text();
      const parsed = posLiteExport.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error("invalid");
      if (parsed.data.targetTenantId !== session.tenantId)
        throw new Error("loyalty_import_scope");
      setFile({ data: parsed.data, hash: await sha256(text) });
    } catch (e) {
      setFile(null);
      setError(
        (e as Error).message === "loyalty_import_scope"
          ? errorNotice(e, locale)
          : t("loyaltyImportInvalid"),
      );
    }
  }
  async function commit() {
    if (!file || !preview) return;
    setError("");
    const pages = importPages(preview.accepted);
    let batchId = "";
    setFailed(false);
    try {
      for (const [i, rows] of pages.entries()) {
        setProgress({ done: i * 500, total: preview.accepted.length });
        const r = await loyaltyApi.importPage({
          batchHash: file.hash,
          sourceTenantId: file.data.sourceTenantId,
          targetTenantId: file.data.targetTenantId,
          policy,
          stampsRequired,
          page: i,
          pages: pages.length,
          rows,
        });
        batchId = r.batchId;
      }
      setProgress({ done: preview.accepted.length, total: preview.accepted.length });
      setVerdict(importVerified(preview, await loyaltyApi.importStatus(batchId)));
    } catch (e) {
      setProgress(null);
      setFailed(true);
      setError(errorNotice(e, locale));
    }
  }
  // Balances convert at the saved stamps per card: pos-lite's must be saved first (LOYALTY-OPS-3).
  const saveFirst =
    preview?.suggested.stampsRequired != null &&
    preview.suggested.stampsRequired !== stampsRequired;
  const printLists = () =>
    preview &&
    printDocument(
      <div className="loyalty-sheet" lang={locale}>
        <h1>{t("loyaltyImportPrintTitle")}</h1>
        <h2>{fill(t("loyaltyImportRejected"), { n: preview.rejected.length })}</h2>
        <ul>
          {preview.rejected.map((r) => (
            <li key={r.legacyId}>
              {r.legacyId} · {r.name || "—"} · {r.maskedPhone} · {t(REASON[r.reason]!)}
            </li>
          ))}
        </ul>
        <h2>{fill(t("loyaltyImportToConfirm"), { n: preview.toConfirm.length })}</h2>
        <ul>
          {preview.toConfirm.map((r, i) => (
            <li key={r.legacyId + i}>
              {r.legacyId} · {r.name} · {r.maskedPhone} · {r.completedAt?.slice(0, 10) ?? ""}
            </li>
          ))}
        </ul>
      </div>,
    );
  const words = (v: string) => {
    const [key, ...rest] = v.split(" ");
    return [FIELD[key!] ? t(FIELD[key!]!) : key, ...rest].join(" ");
  };
  return (
    <section className="loyalty-import" aria-labelledby="loyalty-import-title">
      <h3 id="loyalty-import-title">{t("loyaltyImportTitle")}</h3>
      <Field label={t("loyaltyImportFile")}>
        <input
          type="file"
          accept="application/json,.json"
          disabled={!online}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
          }}
        />
      </Field>
      {preview && (
        <>
          <p role="status">
            {fill(t("loyaltyImportSummary"), {
              members: preview.expected.members,
              stamps: preview.expected.importStamps,
              rewards: preview.expected.importRewards,
            })}
          </p>
          <Field label={t("loyaltyImportRewardsPolicy")}>
            <select value={policy} onChange={(e) => setPolicy(e.target.value as ImportPolicy)}>
              {IMPORT_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {fill(t(POLICY[p]), { days: RECENT_DAYS })}
                </option>
              ))}
            </select>
          </Field>
          {preview.rejected.length > 0 && (
            <details>
              <summary>{fill(t("loyaltyImportRejected"), { n: preview.rejected.length })}</summary>
              <ul>
                {preview.rejected.map((r) => (
                  <li key={r.legacyId}>
                    {r.name || "—"} · {r.maskedPhone} · {t(REASON[r.reason]!)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.toConfirm.length > 0 && (
            <details>
              <summary>{fill(t("loyaltyImportToConfirm"), { n: preview.toConfirm.length })}</summary>
              <ul>
                {preview.toConfirm.map((r, i) => (
                  <li key={r.legacyId + i}>
                    {r.name} · {r.maskedPhone} · {r.completedAt?.slice(0, 10) ?? ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.stale > 0 && (
            <p className="muted">{fill(t("loyaltyImportStale"), { n: preview.stale })}</p>
          )}
          {saveFirst && (
            <p className="warning-panel" role="note">
              {fill(t("loyaltyImportSaveFirst"), {
                n: preview.suggested.stampsRequired!,
                saved: stampsRequired,
              })}
            </p>
          )}
          <div className="row wrap">
            <Button onClick={() => onApplySettings(preview.suggested)}>
              {t("loyaltyImportApply")}
            </Button>
            {(preview.rejected.length > 0 || preview.toConfirm.length > 0) && (
              <Button onClick={() => void printLists()}>{t("loyaltyImportPrint")}</Button>
            )}
            <Button
              variant="primary"
              disabled={!online || !preview.accepted.length || !!progress || saveFirst}
              onClick={() => void commit()}
            >
              {t(failed ? "loyaltyImportRetry" : "loyaltyImportCommit")}
            </Button>
          </div>
          {progress && progress.done < progress.total && (
            <p role="status">
              {fill(t("loyaltyImportProgress"), { done: progress.done, total: progress.total })}
            </p>
          )}
          {verdict &&
            (verdict.length === 0 ? (
              <p role="status" className="success">
                {t("loyaltyImportVerified")}
              </p>
            ) : (
              <p role="alert" className="error">
                {fill(t("loyaltyImportMismatch"), { detail: verdict.map(words).join(", ") })}
              </p>
            ))}
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
