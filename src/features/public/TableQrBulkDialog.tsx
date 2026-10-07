import { useState } from "react";
import type { Locale } from "../../../shared/domain";
import {
  PUBLIC_LIMITS,
  type PublicLinkView,
  type RevealedLink,
} from "../../../shared/public-ordering";
import { strings, translateError, type Key } from "../../i18n";
import { api } from "../../api";
import { Button, Modal } from "../../components/ui";
import { fill } from "../menu/format";
import { printCards } from "./LinkRevealDialog";
import { refreshPublicInbox } from "./usePublicInbox";
import { PrivacyNoticeWarning } from "./PrivacyNoticeWarning";

/**
 * "Códigos QR de mesas": create (and with the option, replace) the codes of
 * many tables at once and print one card per table.
 */
export function TableQrBulkDialog({
  tables,
  links,
  restaurant,
  locale,
  privacyMissing = false,
  onOpenPrivacy,
  onClose,
  onChanged,
}: {
  tables: { id: string; name: string }[];
  links: PublicLinkView[];
  restaurant: string;
  locale: Locale;
  /** The restaurant has no privacy notice yet (PUBLIC-SECURITY-4). */
  privacyMissing?: boolean;
  onOpenPrivacy?: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const withCode = new Set(
    links
      .filter((l) => l.kind === "table" && !l.revokedAt)
      .map((l) => l.tableId),
  );
  const [chosen, setChosen] = useState<Set<string>>(
    () =>
      new Set(tables.filter((tb) => !withCode.has(tb.id)).map((tb) => tb.id)),
  );
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    created: RevealedLink[];
    skipped: { tableId: string }[];
  } | null>(null);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const ids = tables.map((tb) => tb.id).filter((id) => chosen.has(id));
      const r = await api<{
        created: RevealedLink[];
        skipped: { tableId: string }[];
      }>("/ordering/links/tables", {
        tableIds: ids.slice(0, PUBLIC_LIMITS.bulkTables),
        replaceExisting: replace,
      });
      setResult(r);
      onChanged();
      refreshPublicInbox();
      if (r.created.length) void printCards(r.created, restaurant);
    } catch (e) {
      const code = (e as Error).message;
      if (code !== "step_up_cancelled") setError(translateError(code, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("publicBulkTitle")}
      close={onClose}
      closeLabel={t("close")}
      footer={
        result ? (
          <div className="row wrap">
            {result.created.length > 0 && (
              <Button
                variant="primary"
                onClick={() => void printCards(result.created, restaurant)}
              >
                {t("publicPrint")}
              </Button>
            )}
            <Button onClick={onClose}>{t("close")}</Button>
          </div>
        ) : (
          <Button
            variant="primary"
            disabled={busy || chosen.size === 0}
            onClick={() => void create()}
          >
            {t("publicBulkCreate")}
          </Button>
        )
      }
    >
      {privacyMissing && (
        <PrivacyNoticeWarning locale={locale} onOpen={onOpenPrivacy} />
      )}
      {result ? (
        <>
          <p className="warning-panel">{t("publicRevealOnce")}</p>
          <p>
            {result.created.length === 1
              ? t("publicBulkCreatedOne")
              : t("publicBulkCreated", { n: result.created.length })}
          </p>
          {result.skipped.length > 0 && (
            <p>
              {result.skipped.length === 1
                ? t("publicBulkSkippedOne")
                : t("publicBulkSkipped", { n: result.skipped.length })}
            </p>
          )}
        </>
      ) : (
        <>
          <fieldset className="public-bulk-tables">
            <legend>{t("publicBulkTitle")}</legend>
            {tables.map((tb) => (
              <label className="option" key={tb.id}>
                <input
                  type="checkbox"
                  checked={chosen.has(tb.id)}
                  onChange={(e) =>
                    setChosen((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(tb.id);
                      else next.delete(tb.id);
                      return next;
                    })
                  }
                />
                <span>
                  {tb.name}
                  {withCode.has(tb.id) && (
                    <small className="muted"> · {t("publicBulkHasCode")}</small>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="option">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            <span>{t("publicBulkReplace")}</span>
          </label>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
