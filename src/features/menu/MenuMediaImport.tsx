// «Importar fotos» (039; critic R42/Q7, MenuMediaImport): the owner picks the operator's JSON
// manifest and the downloaded photos, reviews the product each item maps to (proposed by name),
// and imports. Each photo goes through the normal upload pipeline (encodePhoto in the browser,
// the server's WebP validation, LD-88) with an operation id derived from the product, its version
// and the file's bytes, so a retried request or a re-run never stores a second copy; a product
// that already has a photo is skipped unless the owner chooses to replace it. Every photo's audit
// row names the import; the run's report (imported, unmatched, missing, skipped, failed) is one
// more audit row and stays on screen.
import { useId, useMemo, useState } from "react";
import type { Locale, Product } from "../../../shared/domain";
import {
  MEDIA_IMPORT_LIMITS,
  importDigestInput,
  importOperationId,
  importStatus,
  mediaManifest,
  proposeMapping,
  type ImportOutcome,
  type ImportStatus,
  type MediaManifest,
} from "../../../shared/media-import";
import { api } from "../../api";
import { errorNotice, translateError } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { encodePhoto } from "./ProductPhotoField";
import { translator } from "./format";

async function sha256Hex(data: BufferSource | string): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Result = { outcome: ImportOutcome; assetId?: string; code?: string };
type Phase = "pick" | "review" | "running" | "done";
const STATUS_KEYS = {
  ready: "menuImportStatusReady",
  unmatched: "menuImportStatusUnmatched",
  missing_file: "menuImportStatusMissing",
  has_photo: "menuImportStatusHasPhoto",
  duplicate: "menuImportStatusDuplicate",
} as const;

export function MenuMediaImport({
  products,
  locale,
  online,
  onClose,
  onImported,
}: {
  products: Product[];
  locale: Locale;
  online: boolean;
  onClose: () => void;
  /** At least one photo was attached: the menu reloads. */
  onImported: () => void;
}) {
  const t = translator(locale);
  const ids = useId();
  const [phase, setPhase] = useState<Phase>("pick");
  const [manifest, setManifest] = useState<MediaManifest | null>(null);
  const [manifestSha, setManifestSha] = useState("");
  const [manifestError, setManifestError] = useState("");
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [replace, setReplace] = useState(false);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [waitingS, setWaitingS] = useState(0);
  const [error, setError] = useState("");
  const [reportSaved, setReportSaved] = useState(false);
  const active = useMemo(
    () =>
      products
        .filter((p) => !p.archived)
        .sort((a, b) => a.name[locale].localeCompare(b.name[locale], locale)),
    [products, locale],
  );

  async function readManifest(file: File | undefined) {
    setManifest(null);
    setManifestError("");
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = mediaManifest.parse(JSON.parse(text));
      setManifest(parsed);
      setManifestSha(await sha256Hex(text));
      setMapping(proposeMapping(parsed.items, products));
    } catch {
      setManifestError(t("menuImportManifestInvalid"));
    }
  }
  /** Each item's status in list order (a product an earlier item takes is a duplicate). */
  const statuses = useMemo(() => {
    const out: Record<string, ImportStatus> = {};
    if (!manifest) return out;
    const taken = new Set<string>();
    const names = new Set(files.keys());
    for (const item of manifest.items) {
      const productId = mapping[item.id] ?? null;
      out[item.id] = importStatus(item, productId, {
        files: names,
        products,
        replace,
        takenBefore: taken,
      });
      if (productId) taken.add(productId);
    }
    return out;
  }, [manifest, mapping, files, products, replace]);
  const count = (s: ImportStatus) =>
    Object.values(statuses).filter((x) => x === s).length;
  const ready = manifest?.items.filter((i) => statuses[i.id] === "ready") ?? [];

  async function uploadOne(
    batchId: string,
    item: MediaManifest["items"][number],
  ): Promise<Result> {
    const productId = mapping[item.id]!;
    const product = products.find((p) => p.id === productId)!;
    const file = files.get(item.file)!;
    try {
      const body = await encodePhoto(file);
      const fileHash = await sha256Hex(await file.arrayBuffer());
      const operationId = importOperationId(
        await sha256Hex(
          importDigestInput(productId, product.version, fileHash),
        ),
      );
      for (let tries = 0, busy = 0; ; tries++) {
        try {
          const r = await api<{ image: { id: string } | null }>(
            `/menu/products/${productId}/image`,
            {},
            {
              raw: { body, type: "application/octet-stream" },
              headers: {
                "x-gm-operation-id": operationId,
                "x-gm-import": batchId,
                "x-gm-import-item": item.id,
              },
              timeoutMs: 60_000,
            },
          );
          return { outcome: "imported", assetId: r.image?.id };
        } catch (e) {
          // Another upload in flight on the server (KV-SECURITY-1): a short wait, the same upload.
          if (
            (e as Error).message === "media_busy" &&
            busy < MEDIA_IMPORT_LIMITS.busyRetries
          ) {
            busy += 1;
            tries -= 1;
            await wait(MEDIA_IMPORT_LIMITS.busyWaitMs);
            continue;
          }
          // The per-tenant upload limit (30 per 10 minutes): wait and retry the same upload.
          if (
            (e as Error).message !== "media_rate_limited" ||
            tries >= MEDIA_IMPORT_LIMITS.rateLimitRetries
          )
            throw e;
          for (let s = MEDIA_IMPORT_LIMITS.rateLimitWaitMs / 1000; s > 0; s--) {
            setWaitingS(s);
            await wait(1000);
          }
          setWaitingS(0);
        }
      }
    } catch (e) {
      const code = (e as Error).message;
      return {
        outcome: "failed",
        code: /^[a-z0-9_]{1,64}$/.test(code) ? code : "media_invalid",
      };
    }
  }

  async function commit() {
    if (!manifest) return;
    setPhase("running");
    setError("");
    const batchId = crypto.randomUUID();
    const out: Record<string, Result> = {};
    setProgress({ done: 0, total: ready.length });
    for (const [n, item] of ready.entries()) {
      out[item.id] = await uploadOne(batchId, item);
      setResults({ ...out });
      setProgress({ done: n + 1, total: ready.length });
    }
    for (const item of manifest.items)
      if (!out[item.id])
        out[item.id] = {
          outcome: statuses[item.id] as Exclude<ImportStatus, "ready">,
        };
    setResults(out);
    setPhase("done");
    if (Object.values(out).some((r) => r.outcome === "imported")) onImported();
    try {
      await api("/menu/media-import", {
        operationId: batchId,
        source: manifest.source,
        manifestSha256: manifestSha,
        replace,
        items: manifest.items.map((item) => ({
          id: item.id,
          name: item.name,
          productId: mapping[item.id] ?? null,
          outcome: out[item.id].outcome,
          assetId: out[item.id].assetId ?? null,
          code: out[item.id].code ?? null,
        })),
      });
      setReportSaved(true);
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }

  const statusText = (id: string) => {
    const r = results[id];
    if (r?.outcome === "imported") return t("menuImportStatusImported");
    if (r?.outcome === "failed")
      return t("menuImportStatusFailed", {
        reason: translateError(r.code ?? "media_invalid", locale),
      });
    return t(STATUS_KEYS[statuses[id] ?? "unmatched"]);
  };
  const productName = (id: string | null) =>
    (id && products.find((p) => p.id === id)?.name[locale]) || "—";
  const imported = Object.values(results).filter(
    (r) => r.outcome === "imported",
  ).length;
  const notImported =
    manifest?.items.filter((i) => results[i.id]?.outcome !== "imported") ?? [];

  const footer =
    phase === "pick" ? (
      <Button
        variant="primary"
        disabled={!manifest || files.size === 0}
        onClick={() => setPhase("review")}
      >
        {t("menuImportReview")}
      </Button>
    ) : phase === "review" ? (
      <div className="row wrap">
        <Button onClick={() => setPhase("pick")}>{t("menuImportBack")}</Button>
        <Button
          variant="primary"
          disabled={!online || ready.length === 0}
          onClick={() => void commit()}
        >
          {t("menuImportCommit", { n: ready.length })}
        </Button>
      </div>
    ) : phase === "done" ? (
      <Button variant="primary" onClick={onClose}>
        {t("menuImportClose")}
      </Button>
    ) : undefined;

  return (
    <Modal
      title={t("menuImportTitle")}
      close={() => phase !== "running" && onClose()}
      closeLabel={t("menuImportClose")}
      wide
      footer={footer}
    >
      {phase === "pick" && (
        <>
          <p>{t("menuImportIntro")}</p>
          <Field label={t("menuImportManifest")}>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => void readManifest(e.target.files?.[0])}
            />
          </Field>
          {manifestError && (
            <p className="error" role="alert">
              {manifestError}
            </p>
          )}
          <Field label={t("menuImportFiles")}>
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) =>
                setFiles(
                  new Map(
                    [...(e.target.files ?? [])].map(
                      (f) => [f.name, f] as const,
                    ),
                  ),
                )
              }
            />
          </Field>
          {files.size > 0 && (
            <p className="muted">
              {t("menuImportFilesChosen", { n: files.size })}
            </p>
          )}
        </>
      )}
      {phase !== "pick" && manifest && (
        <>
          {phase === "review" && (
            <>
              <p role="status">
                {t("menuImportSummary", {
                  ready: count("ready"),
                  unmatched: count("unmatched"),
                  missing: count("missing_file"),
                  has: count("has_photo"),
                  duplicate: count("duplicate"),
                })}
              </p>
              <label className="option">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                <span>{t("menuImportReplace")}</span>
              </label>
            </>
          )}
          {phase === "running" && (
            <p role="status" aria-live="polite">
              {waitingS > 0
                ? t("menuImportWaiting", { s: waitingS })
                : t("menuImportProgress", progress)}
            </p>
          )}
          {phase === "done" && (
            <p role="status">
              {t("menuImportDone", {
                imported,
                skipped: notImported.length,
              })}
              {reportSaved ? ` ${t("menuImportReportSaved")}` : ""}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div
            className="data-table"
            role="region"
            aria-label={t("menuImportTitle")}
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("menuImportSource")}</th>
                  <th scope="col">{t("menuImportFile")}</th>
                  <th scope="col">{t("menuImportProduct")}</th>
                  <th scope="col">{t("menuImportStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {(phase === "done" ? notImported : manifest.items).map(
                  (item) => (
                    <tr key={item.id}>
                      <td>
                        {item.name} <small className="muted">({item.id})</small>
                      </td>
                      <td>{item.file}</td>
                      <td>
                        {phase === "review" ? (
                          <select
                            id={`${ids}-${item.id}`}
                            aria-label={`${t("menuImportProduct")}: ${item.name}`}
                            value={mapping[item.id] ?? ""}
                            onChange={(e) =>
                              setMapping((m) => ({
                                ...m,
                                [item.id]: e.target.value || null,
                              }))
                            }
                          >
                            <option value="">{t("menuImportSkip")}</option>
                            {active.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name[locale]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          productName(mapping[item.id] ?? null)
                        )}
                      </td>
                      <td>{statusText(item.id)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          {phase === "done" && notImported.length > 0 && (
            <p className="muted">{t("menuImportNotImported")}</p>
          )}
        </>
      )}
    </Modal>
  );
}
