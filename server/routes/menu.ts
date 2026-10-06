import type { PreAuthContext, RouteContext } from "../http.js";
import { id } from "../../shared/domain.js";
import { menuRevision } from "../menu-read.js";
import {
  archiveCategory,
  archiveGroup,
  archiveProduct,
  menuEditor,
  reorderCategories,
  reorderProducts,
  saveCategory,
  saveGroup,
  saveMenuProduct,
  setOptionAvailability,
  setProductAvailability,
} from "../menu.js";
import {
  archiveArea,
  archiveTable,
  bulkTables,
  floorPayload,
  reorderAreas,
  reorderTables,
  saveArea,
  saveTable,
} from "../floor.js";
import {
  archiveStockItem,
  listStockItems,
  saveNegativeStockPolicy,
  saveStockItem,
  stockMovements,
} from "../stock-items.js";

/** menu area routes that must run before authentication. */
export function registerPreAuth(_ctx: PreAuthContext) {}

/**
 * Menu editor, floor plan and stock item setup. Paths do not collide with the
 * legacy /inventory/:id route registered earlier in index.ts.
 */
export function register({ route }: RouteContext) {
  route("get", "/menu", (tx, s) => menuEditor(tx, s));
  // Every signed-in role polls this so 86'd items leave the POS promptly.
  route("get", "/menu/revision", (tx) => menuRevision(tx));
  route("post", "/menu/categories/save", (tx, s, req) =>
    saveCategory(tx, s, req.body),
  );
  route("post", "/menu/categories/reorder", (tx, s, req) =>
    reorderCategories(tx, s, req.body),
  );
  route("post", "/menu/categories/archive", (tx, s, req) =>
    archiveCategory(tx, s, req.body),
  );
  route("post", "/menu/products/save", (tx, s, req) =>
    saveMenuProduct(tx, s, req.body),
  );
  route("post", "/menu/products/reorder", (tx, s, req) =>
    reorderProducts(tx, s, req.body),
  );
  route("post", "/menu/products/archive", (tx, s, req) =>
    archiveProduct(tx, s, req.body),
  );
  route("post", "/menu/products/availability", (tx, s, req) =>
    setProductAvailability(tx, s, req.body),
  );
  route("post", "/menu/groups/save", (tx, s, req) =>
    saveGroup(tx, s, req.body),
  );
  route("post", "/menu/groups/archive", (tx, s, req) =>
    archiveGroup(tx, s, req.body),
  );
  route("post", "/menu/groups/option-availability", (tx, s, req) =>
    setOptionAvailability(tx, s, req.body),
  );

  route("get", "/floor", (tx, s) => floorPayload(tx, s));
  route("post", "/floor/areas/save", (tx, s, req) => saveArea(tx, s, req.body));
  route("post", "/floor/areas/reorder", (tx, s, req) =>
    reorderAreas(tx, s, req.body),
  );
  route("post", "/floor/areas/archive", (tx, s, req) =>
    archiveArea(tx, s, req.body),
  );
  route("post", "/floor/tables/save", (tx, s, req) =>
    saveTable(tx, s, req.body),
  );
  route("post", "/floor/tables/bulk", (tx, s, req) =>
    bulkTables(tx, s, req.body),
  );
  route("post", "/floor/tables/reorder", (tx, s, req) =>
    reorderTables(tx, s, req.body),
  );
  route("post", "/floor/tables/archive", (tx, s, req) =>
    archiveTable(tx, s, req.body),
  );

  route("get", "/stock-items", (tx, s) => listStockItems(tx, s));
  route("post", "/stock-items/save", (tx, s, req) =>
    saveStockItem(tx, s, req.body),
  );
  route("post", "/stock-items/archive", (tx, s, req) =>
    archiveStockItem(tx, s, req.body),
  );
  route("post", "/stock-items/policy", (tx, s, req) =>
    saveNegativeStockPolicy(tx, s, req.body),
  );
  route("get", "/stock-items/:id/movements", (tx, s, req) =>
    stockMovements(tx, s, id.parse(req.params.id), req.query),
  );
}
