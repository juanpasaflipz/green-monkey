import type { Group } from "../../../shared/domain";
import type { MenuEditorPayload } from "../../../shared/menu";

/**
 * Availability ("86") is live state: the list shows a switch at once, before
 * the server confirms it and the editor payload reloads (OWNER-4).
 */
export function withProductAvailable(
  payload: MenuEditorPayload,
  productId: string,
  available: boolean,
): MenuEditorPayload {
  return {
    ...payload,
    products: payload.products.map((p) =>
      p.id === productId ? { ...p, available } : p,
    ),
  };
}

/**
 * One choice switched on or off: the group card and every product compiled
 * with that group (its "Opción obligatoria agotada" badge) follow at once.
 */
export function withOptionAvailable(
  payload: MenuEditorPayload,
  groupId: string,
  optionId: string,
  available: boolean,
): MenuEditorPayload {
  const patch = <G extends Group>(g: G): G =>
    g.id === groupId
      ? {
          ...g,
          options: g.options.map((o) =>
            o.id === optionId ? { ...o, available } : o,
          ),
        }
      : g;
  return {
    ...payload,
    groups: payload.groups.map(patch),
    products: payload.products.map((p) =>
      p.groups.some((g) => g.id === groupId)
        ? { ...p, groups: p.groups.map(patch) }
        : p,
    ),
  };
}
