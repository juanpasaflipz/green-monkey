import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  MENU_LIMITS,
  type DiningArea,
  type DiningTable,
} from "../../../shared/menu";
import {
  areaInput,
  tableInput,
  tablesBulkInput,
} from "../../../shared/menu-schema";
import { api } from "../../api";
import { translateError } from "../../i18n";
import { Badge, Button, Empty, Field, Modal } from "../../components/ui";
import { translator } from "./format";

type Floor = { areas: DiningArea[]; tables: DiningTable[] };
type Dialog =
  | { kind: "area"; area?: DiningArea }
  | { kind: "table"; table?: DiningTable; areaId?: string | null }
  | { kind: "bulk"; areaId?: string | null };

function swap<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + delta, 0, item);
  return next;
}

/** Menú e inventario → Mesas: areas and tables. */
export function FloorWorkspace({
  session: _session,
  locale,
  online,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
}) {
  const t = translator(locale);
  const [floor, setFloor] = useState<Floor | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<(Dialog & { key: string }) | null>(null);

  async function load() {
    try {
      setFloor(await api<Floor>("/floor"));
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function run(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await api(path, { operationId: crypto.randomUUID(), ...body });
      setStatus(t("menuSaved"));
      await load();
      return true;
    } catch (e) {
      setError(translateError((e as Error).message, locale));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!floor)
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : (
      <p className="muted">{t("loading")}</p>
    );
  const locked = !online || busy;
  const activeAreas = floor.areas.filter((a) => !a.archived);
  const areas = floor.areas.filter((a) => showArchived || !a.archived);
  const groups = [
    { key: "none", area: null as DiningArea | null, title: t("menuNoArea") },
    ...activeAreas.map((a) => ({ key: a.id, area: a, title: a.name })),
  ].map((g) => ({
    ...g,
    tables: floor.tables.filter(
      (tb) =>
        (showArchived || !tb.archived) &&
        (g.area
          ? tb.areaId === g.area.id
          : !tb.areaId || !activeAreas.some((a) => a.id === tb.areaId)),
    ),
  }));
  const open = (d: Dialog) => setDialog({ ...d, key: crypto.randomUUID() });

  return (
    <div className="menu-workspace">
      <p role="status" className="menu-status">
        {status}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!online && <p className="warning-panel">{t("menuOfflineHint")}</p>}
      <div className="menu-toolbar">
        <Button
          variant="primary"
          disabled={!online}
          onClick={() => open({ kind: "table" })}
        >
          {t("menuTableNew")}
        </Button>
        <Button disabled={!online} onClick={() => open({ kind: "bulk" })}>
          {t("menuTablesBulk")}
        </Button>
        <Button disabled={!online} onClick={() => open({ kind: "area" })}>
          {t("menuAreaNew")}
        </Button>
        <label className="menu-check">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span>{t("menuShowArchived")}</span>
        </label>
      </div>
      <section className="menu-section-list">
        <h2 className="menu-section-title">{t("menuAreas")}</h2>
        {areas.length ? (
          <ul className="menu-list">
            {areas.map((a) => {
              const index = activeAreas.findIndex((x) => x.id === a.id);
              return (
                <li className="menu-row" key={a.id}>
                  <div className="menu-row-main">
                    <strong>{a.name}</strong>
                    {a.archived && <Badge>{t("menuArchivedBadge")}</Badge>}
                  </div>
                  <div className="row wrap menu-row-actions">
                    {!a.archived && (
                      <>
                        <Button
                          variant="ghost"
                          disabled={locked || index <= 0}
                          aria-label={t("menuMoveUp", { name: a.name })}
                          onClick={() =>
                            void run("/floor/areas/reorder", {
                              ids: swap(activeAreas, index, -1).map(
                                (x) => x.id,
                              ),
                            })
                          }
                        >
                          ↑
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={locked || index === activeAreas.length - 1}
                          aria-label={t("menuMoveDown", { name: a.name })}
                          onClick={() =>
                            void run("/floor/areas/reorder", {
                              ids: swap(activeAreas, index, 1).map((x) => x.id),
                            })
                          }
                        >
                          ↓
                        </Button>
                      </>
                    )}
                    <Button
                      aria-label={t("menuEditItem", { name: a.name })}
                      disabled={!online}
                      onClick={() => open({ kind: "area", area: a })}
                    >
                      {t("menuEdit")}
                    </Button>
                    <Button
                      disabled={locked}
                      onClick={() =>
                        void run("/floor/areas/archive", {
                          id: a.id,
                          expectedVersion: a.version,
                          archived: !a.archived,
                        })
                      }
                    >
                      {t(a.archived ? "menuRestore" : "menuArchive")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">{t("menuAreasEmpty")}</p>
        )}
      </section>
      {floor.tables.some((tb) => !tb.archived) || showArchived ? (
        groups
          .filter((g) => g.tables.length || g.area)
          .map((g) => {
            const active = g.tables.filter((tb) => !tb.archived);
            return (
              <section className="menu-section-list" key={g.key}>
                <h2 className="menu-section-title">
                  {g.title}
                  <small>{active.length}</small>
                </h2>
                <ul className="menu-list">
                  {g.tables.map((tb) => {
                    const index = active.findIndex((x) => x.id === tb.id);
                    return (
                      <li className="menu-row" key={tb.id}>
                        <div className="menu-row-main">
                          <strong>{tb.name}</strong>
                          <div className="menu-badges">
                            {tb.seats !== null && (
                              <span className="muted tiny">
                                {t("menuTableSeatsCount", { n: tb.seats })}
                              </span>
                            )}
                            {tb.open && (
                              <Badge tone="amber">{t("menuTableOpen")}</Badge>
                            )}
                            {tb.archived && (
                              <Badge>{t("menuArchivedBadge")}</Badge>
                            )}
                          </div>
                        </div>
                        <div className="row wrap menu-row-actions">
                          {!tb.archived && (
                            <>
                              <Button
                                variant="ghost"
                                disabled={locked || index <= 0}
                                aria-label={t("menuMoveUp", { name: tb.name })}
                                onClick={() =>
                                  void run("/floor/tables/reorder", {
                                    scopeId: g.area?.id ?? null,
                                    ids: swap(active, index, -1).map(
                                      (x) => x.id,
                                    ),
                                  })
                                }
                              >
                                ↑
                              </Button>
                              <Button
                                variant="ghost"
                                disabled={locked || index === active.length - 1}
                                aria-label={t("menuMoveDown", {
                                  name: tb.name,
                                })}
                                onClick={() =>
                                  void run("/floor/tables/reorder", {
                                    scopeId: g.area?.id ?? null,
                                    ids: swap(active, index, 1).map(
                                      (x) => x.id,
                                    ),
                                  })
                                }
                              >
                                ↓
                              </Button>
                            </>
                          )}
                          <Button
                            aria-label={t("menuEditItem", { name: tb.name })}
                            disabled={!online}
                            onClick={() => open({ kind: "table", table: tb })}
                          >
                            {t("menuEdit")}
                          </Button>
                          <Button
                            disabled={locked || (tb.open && !tb.archived)}
                            title={
                              tb.open && !tb.archived
                                ? translateError("table_in_use", locale)
                                : undefined
                            }
                            aria-label={`${t(tb.archived ? "menuRestore" : "menuArchive")} ${tb.name}`}
                            onClick={() =>
                              void run("/floor/tables/archive", {
                                id: tb.id,
                                expectedVersion: tb.version,
                                archived: !tb.archived,
                              })
                            }
                          >
                            {t(tb.archived ? "menuRestore" : "menuArchive")}
                          </Button>
                        </div>
                        {tb.open && !tb.archived && (
                          <p className="tiny muted menu-row-note">
                            {translateError("table_in_use", locale)}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
      ) : (
        <Empty title={t("menuFloorEmpty")} />
      )}
      {dialog?.kind === "area" && (
        <AreaDialog
          key={dialog.key}
          area={dialog.area}
          locale={locale}
          online={online}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setStatus(t("menuSaved"));
            void load();
          }}
        />
      )}
      {dialog?.kind === "table" && (
        <TableDialog
          key={dialog.key}
          table={dialog.table}
          areas={activeAreas}
          locale={locale}
          online={online}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setStatus(t("menuSaved"));
            void load();
          }}
        />
      )}
      {dialog?.kind === "bulk" && (
        <BulkTablesDialog
          key={dialog.key}
          areas={activeAreas}
          locale={locale}
          online={online}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setStatus(t("menuSaved"));
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Shared submit state for the small floor dialogs (one operationId each). */
function useSubmit(locale: Locale, onSaved: () => void) {
  const [operationId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await api(path, { operationId, ...body });
      onSaved();
    } catch (e) {
      const code = (e as Error).message;
      setError(
        translateError(
          code === "operation_conflict" ? "menu_changed" : code,
          locale,
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return { operationId, error, setError, busy, submit };
}

function AreaDialog({
  area,
  locale,
  online,
  onClose,
  onSaved,
}: {
  area?: DiningArea;
  locale: Locale;
  online: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = translator(locale);
  const [id] = useState(() => area?.id ?? crypto.randomUUID());
  const [name, setName] = useState(area?.name ?? "");
  const [invalid, setInvalid] = useState(false);
  const { operationId, error, busy, submit } = useSubmit(locale, onSaved);
  return (
    <Modal
      title={t(area ? "menuAreaEdit" : "menuAreaNew")}
      close={onClose}
      closeLabel={t("close")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const body = { id, expectedVersion: area?.version ?? 0, name };
          const ok = areaInput.safeParse({ operationId, ...body }).success;
          setInvalid(!ok);
          if (ok) void submit("/floor/areas/save", body);
        }}
      >
        <Field label={`${t("menuAreaName")} *`}>
          <input
            value={name}
            maxLength={60}
            required
            aria-invalid={invalid ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          className="full"
          disabled={busy || !online}
        >
          {t("menuSave")}
        </Button>
      </form>
    </Modal>
  );
}

function TableDialog({
  table,
  areas,
  locale,
  online,
  onClose,
  onSaved,
}: {
  table?: DiningTable;
  areas: DiningArea[];
  locale: Locale;
  online: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = translator(locale);
  const [id] = useState(() => table?.id ?? crypto.randomUUID());
  const [name, setName] = useState(table?.name ?? "");
  const [areaId, setAreaId] = useState(
    table?.areaId && areas.some((a) => a.id === table.areaId)
      ? table.areaId
      : "",
  );
  const [seats, setSeats] = useState(table?.seats ? String(table.seats) : "");
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const { operationId, error, busy, submit } = useSubmit(locale, onSaved);
  return (
    <Modal
      title={t(table ? "menuTableEdit" : "menuTableNew")}
      close={onClose}
      closeLabel={t("close")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const body = {
            id,
            expectedVersion: table?.version ?? 0,
            name,
            areaId: areaId || null,
            seats: seats.trim() ? Number(seats) : null,
          };
          const parsed = tableInput.safeParse({ operationId, ...body });
          setInvalid(
            new Set(
              parsed.success
                ? []
                : parsed.error.issues.map((i) => String(i.path[0])),
            ),
          );
          if (parsed.success) void submit("/floor/tables/save", body);
        }}
      >
        <Field label={`${t("menuTableName")} *`}>
          <input
            value={name}
            maxLength={40}
            required
            aria-invalid={invalid.has("name") ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t("menuTableArea")}>
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">{t("menuNoArea")}</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("menuTableSeats")}>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            value={seats}
            aria-invalid={invalid.has("seats") ? true : undefined}
            onChange={(e) => setSeats(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          className="full"
          disabled={busy || !online}
        >
          {t("menuSave")}
        </Button>
      </form>
    </Modal>
  );
}

function BulkTablesDialog({
  areas,
  locale,
  online,
  onClose,
  onSaved,
}: {
  areas: DiningArea[];
  locale: Locale;
  online: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = translator(locale);
  const [areaId, setAreaId] = useState("");
  const [prefix, setPrefix] = useState("Mesa");
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("12");
  const [seats, setSeats] = useState("");
  const { operationId, error, busy, submit } = useSubmit(locale, onSaved);
  const body = {
    areaId: areaId || null,
    prefix,
    from: Number(from),
    to: Number(to),
    seats: seats.trim() ? Number(seats) : null,
  };
  const valid = tablesBulkInput.safeParse({ operationId, ...body }).success;
  const name = (n: number) => `${prefix.trim()} ${n}`.trim();
  return (
    <Modal title={t("menuTablesBulk")} close={onClose} closeLabel={t("close")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void submit("/floor/tables/bulk", body);
        }}
      >
        <Field label={t("menuTableArea")}>
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">{t("menuNoArea")}</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("menuTablesPrefix")}>
          <input
            value={prefix}
            maxLength={30}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </Field>
        <div className="form-grid">
          <Field label={t("menuTablesFrom")}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={999}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label={t("menuTablesTo")}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={999}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
        <Field label={t("menuTableSeats")}>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
          />
        </Field>
        <p aria-live="polite" className={valid ? "muted" : "error"}>
          {valid
            ? t("menuTablesPreview", {
                first: name(body.from),
                last: name(body.to),
                n: body.to - body.from + 1,
              })
            : t("menuTablesPreviewInvalid", {
                max: MENU_LIMITS.tablesPerBatch,
              })}
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          className="full"
          disabled={busy || !online || !valid}
        >
          {t("menuSave")}
        </Button>
      </form>
    </Modal>
  );
}
