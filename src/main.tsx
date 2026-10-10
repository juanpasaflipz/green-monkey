import React from "react";
import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import Landing from "./marketing/Landing";
const App = lazy(() => import("./App"));
const SelfInvoicePortal = lazy(
  () => import("./features/cfdi/SelfInvoicePortal"),
);
const LegalPage = lazy(() => import("./legal/LegalPage"));
const PublicOrdering = lazy(() => import("./features/PublicOrdering"));
const JoinPage = lazy(() => import("./features/loyalty/JoinPage"));
import { PlatformGate } from "./features/offline/PlatformGate";
import { registerServiceWorker } from "./service-worker";
import "@fontsource-variable/inter/opsz.css";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<p role="status">Green Monkey…</p>}>
      {/^\/legal(\/|$)/.test(location.pathname) ? (
        <LegalPage />
      ) : /^\/(f|factura)(\/|$)/.test(location.pathname) ? (
        <SelfInvoicePortal />
      ) : /^\/(qr|kiosk)(\/|$)/.test(location.pathname) ? (
        <PublicOrdering />
      ) : /^\/club\/?$/.test(location.pathname) ? (
        <JoinPage />
      ) : location.pathname === "/" &&
        !new URLSearchParams(location.search).has("account") &&
        !new URLSearchParams(location.search).has("auth_error") ? (
        <Landing />
      ) : (
        <PlatformGate>
          <App />
        </PlatformGate>
      )}
    </Suspense>
  </React.StrictMode>,
);
const publicPage = /^\/(f|factura|qr|kiosk|club)(\/|$)/.test(location.pathname);
// The worker is registered at a fixed URL with its build id baked in (OFF-10).
if ("serviceWorker" in navigator && import.meta.env.PROD && !publicPage)
  void registerServiceWorker();
