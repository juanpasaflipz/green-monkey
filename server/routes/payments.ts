// Payments (037) routes. P1: the payment dialog's options, Configuración (terminals,
// platforms, platform prices) and each device's default terminal. P2 adds the integrated
// charge routes and the pre-auth provider webhooks (critic R31: before authentication).
import type { PreAuthContext, RouteContext } from "../http.js";
import { id } from "../../shared/domain.js";
import {
  archiveTerminal,
  paymentOptions,
  paymentSettingsView,
  savePlatformPrices,
  savePlatforms,
  saveTerminal,
  setDeviceTerminal,
} from "../payments/settings.js";

/** Provider webhooks (P2) register here, before authentication. */
export function registerPreAuth(_ctx: PreAuthContext) {}

export function register({ route }: RouteContext) {
  route("get", "/payments/options", (tx, s) => paymentOptions(tx, s));
  route("get", "/payments/settings", (tx, s) => paymentSettingsView(tx, s));
  route("post", "/payments/terminals", (tx, s, req) =>
    saveTerminal(tx, s, req.body),
  );
  route("post", "/payments/terminals/:id/archive", (tx, s, req) =>
    archiveTerminal(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/payments/platforms", (tx, s, req) =>
    savePlatforms(tx, s, req.body),
  );
  route("post", "/payments/platform-prices", (tx, s, req) =>
    savePlatformPrices(tx, s, req.body),
  );
  route("post", "/payments/devices/:deviceId/terminal", (tx, s, req) =>
    setDeviceTerminal(tx, s, id.parse(req.params.deviceId), req.body),
  );
}
