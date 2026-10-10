// «Pantalla» in Vender (kiosk 039, specs/kiosk-w4.md §2.9): this device's display choices. Grid
// photos default to on for a shared terminal and off for a personal device (a phone).
import { useId } from "react";
import type { Locale } from "../../shared/domain";
import type { DeviceKind } from "../../shared/access";
import { strings } from "../i18n";
import { Button, Modal } from "../components/ui";
import { gridPhotosOn, useDisplaySettings } from "../display";

export function DisplaySettingsDialog({
  locale,
  deviceKind,
  close,
}: {
  locale: Locale;
  deviceKind: DeviceKind | undefined;
  close: () => void;
}) {
  const t = strings[locale];
  const [settings, save] = useDisplaySettings();
  const hintId = useId();
  return (
    <Modal title={t.menuDisplaySettings} close={close} closeLabel={t.close}>
      <label className="option">
        <input
          type="checkbox"
          checked={gridPhotosOn(settings, deviceKind)}
          aria-describedby={hintId}
          onChange={(e) => save({ gridPhotos: e.target.checked })}
        />
        <span>{t.menuGridPhotos}</span>
      </label>
      <p className="muted" id={hintId}>
        {t.menuGridPhotosHint}
      </p>
      <Button variant="primary" className="full" onClick={close}>
        {t.serviceLineNoteDone}
      </Button>
    </Modal>
  );
}
