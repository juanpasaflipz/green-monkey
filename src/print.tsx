import { useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Locale } from "../shared/domain";
import { strings } from "./i18n";
import { Button, Modal } from "./components/ui";

/**
 * Browser/OS printing for any 58 or 80 mm thermal printer with an OS driver.
 * One document at a time is rendered into #print-root; print CSS hides the rest
 * of the page while body.printing-doc is set. The page size is left to the
 * driver's roll size (@page margin 0, no size), so only the content width is
 * set: 72 mm on 80 mm paper and 48 mm on 58 mm paper. Browser printing never
 * confirms that paper came out.
 */
export type PaperWidth = "80" | "58";
export type PrintSettings = {
  paper: PaperWidth;
  kitchenOnSend: boolean;
  kdsAutoPrint: boolean;
};
const KEY = "gm-print-settings";
const defaults: PrintSettings = {
  paper: "80",
  kitchenOnSend: false,
  kdsAutoPrint: false,
};

function read(): PrintSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return defaults;
    return {
      paper: raw.paper === "58" ? "58" : "80",
      kitchenOnSend: raw.kitchenOnSend === true,
      kdsAutoPrint: raw.kdsAutoPrint === true,
    };
  } catch {
    return defaults;
  }
}
let current: PrintSettings | null = null;
const listeners = new Set<() => void>();
function snapshot() {
  return (current ??= read());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    listener();
  };
  window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storage);
  };
}
/** Current per-device print settings, outside React (never throws). */
export function readPrintSettings(): PrintSettings {
  return snapshot();
}
export function savePrintSettings(patch: Partial<PrintSettings>) {
  current = { ...snapshot(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Storage blocked: the setting lasts for this page only. */
  }
  for (const listener of listeners) listener();
}
/** Per-device print settings (localStorage "gm-print-settings"). */
export function usePrintSettings(): [
  PrintSettings,
  (p: Partial<PrintSettings>) => void,
] {
  const settings = useSyncExternalStore(subscribe, snapshot, () => defaults);
  return [settings, savePrintSettings];
}

let queue: Promise<void> = Promise.resolve();
/**
 * Renders one document into #print-root and opens the print dialog. An array
 * prints one section per element with a page break between sections. Calls are
 * serialized so auto-printed tickets never overwrite each other. This is the
 * only caller of window.print() in the app (wave contracts D20).
 */
export function printDocument(
  content: ReactNode | ReactNode[],
  paper: PaperWidth = readPrintSettings().paper,
): Promise<void> {
  const node = Array.isArray(content) ? (
    <PrintSections>{content}</PrintSections>
  ) : (
    content
  );
  const job = queue.then(() => printNow(node, paper));
  queue = job.catch(() => {});
  return job;
}

/** Cleans up the previous document if its afterprint never arrived. */
let pendingCleanup: (() => void) | null = null;
/** Safety net for engines that never fire afterprint. */
const ORPHAN_CLEANUP_MS = 120_000;

async function printNow(node: ReactNode, paper: PaperWidth) {
  pendingCleanup?.();
  let host = document.getElementById("print-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "print-root";
    host.setAttribute("aria-hidden", "true");
    document.body.appendChild(host);
  }
  const target = host;
  const root = createRoot(target);
  flushSync(() =>
    root.render(<div className={"print-doc paper-" + paper}>{node}</div>),
  );
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener("afterprint", cleanup);
    if (pendingCleanup === cleanup) pendingCleanup = null;
    try {
      root.unmount();
    } catch {
      /* The container was already emptied. */
    }
    target.replaceChildren();
    document.body.classList.remove("printing-doc");
  };
  pendingCleanup = cleanup;
  window.addEventListener("afterprint", cleanup);
  document.body.classList.add("printing-doc");
  // Chromium blocks inside print() and fires afterprint before it returns.
  // Engines whose print() returns at once (iOS/iPadOS Safari) take the
  // snapshot later, so the document stays until afterprint, the next print
  // job, or the safety timer.
  window.print();
  if (!done) timer = setTimeout(cleanup, ORPHAN_CLEANUP_MS);
}

/** Several documents (for example one ticket per station) in one print job. */
function PrintSections({ children }: { children: ReactNode[] }) {
  return (
    <>
      {children.map((child, i) => (
        <section className="print-section" key={i}>
          {child}
        </section>
      ))}
    </>
  );
}

export function PrintSettingsDialog({
  locale,
  close,
  scope,
}: {
  locale: Locale;
  close: () => void;
  scope: "selling" | "kitchen";
}) {
  const t = strings[locale];
  const [settings, save] = usePrintSettings();
  return (
    <Modal title={t.servicePrintSettings} close={close} closeLabel={t.close}>
      <fieldset className="field">
        <legend>{t.servicePrintPaper}</legend>
        {(["80", "58"] as const).map((paper) => (
          <label className="option" key={paper}>
            <input
              type="radio"
              name="print-paper"
              checked={settings.paper === paper}
              onChange={() => save({ paper })}
            />
            <span>
              {paper === "80" ? t.servicePrintPaper80 : t.servicePrintPaper58}
            </span>
          </label>
        ))}
      </fieldset>
      {scope === "selling" ? (
        <label className="option">
          <input
            type="checkbox"
            checked={settings.kitchenOnSend}
            onChange={(e) => save({ kitchenOnSend: e.target.checked })}
          />
          <span>{t.servicePrintKitchenOnSend}</span>
        </label>
      ) : (
        <>
          <label className="option">
            <input
              type="checkbox"
              checked={settings.kdsAutoPrint}
              onChange={(e) => save({ kdsAutoPrint: e.target.checked })}
            />
            <span>{t.servicePrintKdsAuto}</span>
          </label>
          <p className="muted">{t.servicePrintSilentHint}</p>
        </>
      )}
      <p className="muted tiny">{t.servicePrintUnconfirmed}</p>
      <Button variant="primary" className="full" onClick={close}>
        {t.serviceLineNoteDone}
      </Button>
    </Modal>
  );
}
