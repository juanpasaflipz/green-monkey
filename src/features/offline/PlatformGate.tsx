import type { ReactNode } from "react";
import { platformSupport } from "../../platform";
import { strings } from "../../i18n";
import "./offline.css";

/** Refuses browsers missing what offline selling needs (OFF-11, §2.10). */
export function PlatformGate({ children }: { children: ReactNode }) {
  const support = platformSupport();
  if (support.ok) return <>{children}</>;
  const locale = (() => {
    try {
      return localStorage.getItem("gm-locale") === "en" ? "en" : "es";
    } catch {
      return "es";
    }
  })();
  return (
    <main className="platform-gate" role="alert">
      <h1>{strings[locale].offlineUnsupportedTitle}</h1>
      <p>{strings[locale].offlineUnsupportedBody}</p>
      <p className="muted tiny">{support.missing.join(", ")}</p>
    </main>
  );
}
