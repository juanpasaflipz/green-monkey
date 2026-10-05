import React from "react";
import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import Landing from "./marketing/Landing";
const App = lazy(() => import("./App"));
import { PublicOrdering } from "./features/PublicOrdering";
import { registerServiceWorker } from "./service-worker";
import "@fontsource-variable/inter/opsz.css";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<p role="status">Green Monkey…</p>}>
      {/^\/(qr|kiosk)\//.test(location.pathname) ? (
        <PublicOrdering />
      ) : location.pathname === "/" &&
        !new URLSearchParams(location.search).has("account") &&
        !new URLSearchParams(location.search).has("auth_error") ? (
        <Landing />
      ) : (
        <App />
      )}
    </Suspense>
  </React.StrictMode>,
);
// The worker is registered at a fixed URL with its build id baked in (OFF-10).
if ("serviceWorker" in navigator && import.meta.env.PROD)
  void registerServiceWorker();
