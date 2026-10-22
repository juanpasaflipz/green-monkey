import type { RouteContext } from "../http.js";
import {
  deliveryAction,
  deliveryLogin,
  deliveryView,
} from "../delivery/service.js";

export function register({ app, route }: RouteContext) {
  app.use("/api/delivery", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  route("get", "/delivery", deliveryView);
  route("post", "/delivery/:provider", (tx, s, req) =>
    deliveryAction(tx, s, req.params.provider, req.body),
  );
  route("post", "/delivery/:provider/login", (tx, s, req) =>
    deliveryLogin(tx, s, req.params.provider),
  );
}
