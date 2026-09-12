import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PublicOrdering } from "./features/PublicOrdering";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/^\/(qr|kiosk)\//.test(location.pathname) ? <PublicOrdering /> : <App />}
  </React.StrictMode>,
);
if ("serviceWorker" in navigator && import.meta.env.PROD)
  void navigator.serviceWorker.register("/sw.js");
