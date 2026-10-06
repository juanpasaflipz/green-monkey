import { QRCodeSVG } from "qrcode.react";
import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { Modal } from "../../components/ui";
import { fill } from "../menu/format";
import { PLATFORM_PRIVACY_PATH } from "./dinerRoute";

/**
 * The kiosk's privacy notices in an in-page dialog (PRIVACY-2, UX-5): a
 * kiosk never navigates away from /kiosk#token, so each notice is a QR code
 * the diner scans to read it on their own phone. The idle reset closes it.
 */
export function PrivacyDialog({
  locale,
  restaurant,
  privacyNoticeUrl,
  onClose,
}: {
  locale: Locale;
  restaurant: string;
  privacyNoticeUrl: string | null;
  onClose: () => void;
}) {
  const t = strings[locale];
  const platformUrl = new URL(PLATFORM_PRIVACY_PATH, location.origin).href;
  const notices = [
    ...(privacyNoticeUrl
      ? [
          {
            title: fill(t.accountGuestPrivacyLink, { restaurant }),
            url: privacyNoticeUrl,
          },
        ]
      : []),
    { title: t.accountGuestPlatformPrivacy, url: platformUrl },
  ];
  return (
    <Modal title={t.publicPrivacy} close={onClose} closeLabel={t.close}>
      {!privacyNoticeUrl && <p>{t.accountGuestNoNotice}</p>}
      <p className="muted">{t.publicPrivacyScan}</p>
      <div className="diner-privacy-codes">
        {notices.map((n) => (
          <figure key={n.url} className="diner-privacy-code">
            <QRCodeSVG
              value={n.url}
              size={168}
              level="M"
              marginSize={4}
              title={n.title}
              role="img"
            />
            <figcaption>{n.title}</figcaption>
          </figure>
        ))}
      </div>
    </Modal>
  );
}
