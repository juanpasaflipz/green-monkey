import { useRef, useState } from "react";
import type { Locale } from "../../../shared/domain";
import type {
  PublicLinkView,
  RevealedLink,
} from "../../../shared/public-ordering";
import { errorNotice, strings, type Key } from "../../i18n";
import { api } from "../../api";
import { Button, Modal } from "../../components/ui";
import { fill } from "../menu/format";
import { QrCard } from "./QrCard";
import { RevealControls, linkUrl } from "./LinkRevealDialog";
import { refreshPublicInbox } from "./usePublicInbox";
import { PrivacyNoticeWarning } from "./PrivacyNoticeWarning";

export function shortDate(iso: string, locale: Locale, timezone: string) {
  return new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
    day: "numeric",
    month: "short",
    timeZone: timezone,
  }).format(new Date(iso));
}
export function shortDateTime(iso: string, locale: Locale, timezone: string) {
  return new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(new Date(iso));
}

/**
 * One table's QR code (Menú e inventario → Mesas): create it, or see when it
 * was created and replace or deactivate it. A code is shown only once, so
 * printing again means replacing it.
 */
export function TableQrDialog({
  table,
  link,
  restaurant,
  timezone,
  locale,
  privacyMissing = false,
  onOpenPrivacy,
  onClose,
  onChanged,
}: {
  table: { id: string; name: string };
  link: PublicLinkView | null;
  restaurant: string;
  timezone: string;
  locale: Locale;
  /** The restaurant has no privacy notice yet (PUBLIC-SECURITY-4). */
  privacyMissing?: boolean;
  onOpenPrivacy?: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revokeKey = useRef(crypto.randomUUID());
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChanged();
      refreshPublicInbox();
    } catch (e) {
      const code = (e as Error).message;
      if (code !== "step_up_cancelled") setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  const create = () =>
    run(async () =>
      setRevealed(
        await api<RevealedLink>("/ordering/links", {
          kind: "table",
          tableId: table.id,
        }),
      ),
    );
  const rotate = () =>
    run(async () =>
      setRevealed(
        await api<RevealedLink>(`/ordering/links/${link!.id}/rotate`, {}),
      ),
    );
  const revoke = () =>
    run(async () => {
      await api(`/ordering/links/${link!.id}/revoke`, {
        operationId: revokeKey.current,
      });
      onClose();
    });
  return (
    <Modal
      title={t("publicTableQrFor", { name: table.name })}
      close={onClose}
      closeLabel={t("close")}
      wide
    >
      {privacyMissing && (
        <PrivacyNoticeWarning locale={locale} onOpen={onOpenPrivacy} />
      )}
      {revealed ? (
        <>
          <p className="warning-panel">{t("publicRevealOnce")}</p>
          <div className="qr-preview">
            <QrCard
              restaurant={restaurant}
              place={table.name}
              url={linkUrl(revealed)}
              kind="table"
            />
          </div>
          <RevealControls
            link={revealed}
            restaurant={restaurant}
            locale={locale}
          />
        </>
      ) : link ? (
        <>
          <p>
            {t("publicTableQrActive", {
              ref: link.ref,
              date: shortDate(link.createdAt, locale, timezone),
            })}
          </p>
          <p className="muted">
            {link.lastHoldAt
              ? t("publicLastOrder", {
                  date: shortDateTime(link.lastHoldAt, locale, timezone),
                })
              : t("publicNoOrdersYet")}
          </p>
          <p className="muted tiny">{t("publicReprintHint")}</p>
          {confirm ? (
            <div className="warning-panel">
              <p>
                {confirm === "rotate"
                  ? t("publicReplaceConfirm")
                  : t("publicRevokeConfirm")}
              </p>
              <div className="row wrap">
                <Button
                  variant={confirm === "rotate" ? "primary" : "danger"}
                  disabled={busy}
                  onClick={() =>
                    void (confirm === "rotate" ? rotate() : revoke())
                  }
                >
                  {confirm === "rotate"
                    ? t("publicReplaceAndPrint")
                    : t("publicRevoke")}
                </Button>
                <Button disabled={busy} onClick={() => setConfirm(null)}>
                  {t("cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="row wrap">
              <Button variant="primary" onClick={() => setConfirm("rotate")}>
                {t("publicReplaceAndPrint")}
              </Button>
              <Button variant="danger" onClick={() => setConfirm("revoke")}>
                {t("publicRevoke")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted">{t("publicTableQrNone")}</p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void create()}
          >
            {t("publicCreateQr")}
          </Button>
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
