import React from "react";
import { createRoot } from "react-dom/client";
import { DeliveryConnections } from "../../../src/features/delivery/DeliveryConnections";
import type { Session } from "../../../shared/domain";
import "../../../src/styles.css";
const session = { tenantId: "synthetic", role: "owner" } as Session;
createRoot(document.getElementById("root")!).render(
  <DeliveryConnections session={session} locale="es" online={true} />,
);
