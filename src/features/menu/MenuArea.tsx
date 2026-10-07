import type { Locale, Session } from "../../../shared/domain";
import type { Key } from "../../i18n";
import { FloorWorkspace } from "./FloorWorkspace";
import { MenuWorkspace } from "./MenuWorkspace";
import { StockItemsWorkspace } from "./StockItemsWorkspace";
import { translator } from "./format";
import "./menu.css";

/** Views under the "Menú e inventario" rail item (owner and manager only). */
export const setupViews = ["menu", "stock", "inventory", "floor"];
const labels: Record<string, Key> = {
  menu: "menuNavMenu",
  stock: "menuNavStock",
  inventory: "menuNavInventory",
  floor: "menuNavFloor",
};

export function SetupNav({
  view,
  setView,
  locale,
}: {
  view: string;
  setView: (view: string) => void;
  locale: Locale;
}) {
  const t = translator(locale);
  return (
    <nav className="operations-tabs" aria-label={t("menuNavLabel")}>
      {setupViews.map((key) => (
        <button
          key={key}
          className={view === key ? "selected" : ""}
          aria-current={view === key ? "page" : undefined}
          onClick={() => setView(key)}
        >
          {t(labels[key])}
        </button>
      ))}
    </nav>
  );
}

/** Menu, ingredient and floor editors; "inventory" stays in Operations. */
export function MenuArea({
  view,
  session,
  locale,
  online,
  navigate,
}: {
  view: string;
  session: Session;
  locale: Locale;
  online: boolean;
  navigate: (view: string) => void;
}) {
  const t = translator(locale);
  return (
    <>
      <div className="section-title">
        <div>
          <span className="eyebrow">{t("menuNavLabel")}</span>
          <h1>
            {t(
              view === "floor"
                ? "menuFloorTitle"
                : (labels[view] ?? "menuNavMenu"),
            )}
          </h1>
        </div>
      </div>
      {view === "menu" && (
        <MenuWorkspace
          session={session}
          locale={locale}
          online={online}
          navigate={navigate}
        />
      )}
      {view === "stock" && (
        <StockItemsWorkspace
          session={session}
          locale={locale}
          online={online}
        />
      )}
      {view === "floor" && (
        <FloorWorkspace
          session={session}
          locale={locale}
          online={online}
          navigate={navigate}
        />
      )}
    </>
  );
}
