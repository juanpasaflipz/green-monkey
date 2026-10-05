import { currencyExponent } from "../../shared/domain";
import { useEffect, useState } from "react";
import { api } from "../api";
import { strings, translateError, type Key } from "../i18n";
import { Button, Field, Modal } from "../components/ui";
import { minor, type Session, type Locale } from "../../shared/domain";
export function ManagementTools({
  view,
  session,
  locale,
  refresh,
}: {
  view: string;
  session: Session;
  locale: Locale;
  refresh: () => Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const scale = 10 ** exponent;
  const parseAmount = (s: string) => minor(s, exponent);
  const [mode, setMode] = useState("");
  const [error, setError] = useState("");
  const [catalog, setCatalog] = useState<any[]>([]);
  const [stock, setStock] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [team, setTeam] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [recipe, setRecipe] = useState<{ stockId: string; quantity: string }[]>(
    [],
  );
  const [rawImport, setRawImport] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [records, setRecords] = useState<any[]>([]);
  const [link, setLink] = useState("");
  const [linkChannel, setLinkChannel] = useState("qr");
  useEffect(() => {
    if (mode) {
      setError("");
      void Promise.all([
        api("/catalog").then(setCatalog),
        api("/inventory").then(setStock),
        api("/suppliers").then(setSuppliers),
        api("/team").then(setTeam),
      ]).catch((e) => setError(translateError(e.message, locale)));
    }
  }, [mode]);
  async function save(path: string, body: unknown) {
    try {
      await api(path, body);
      setMode("");
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }
  return (
    <>
      <div className="row wrap">
        {view === "inventory" && (
          <>
            <Button
              onClick={() => {
                setSelected(null);
                setRecipe([]);
                setMode("menu");
              }}
            >
              {t("editMenu")}
            </Button>
            <Button onClick={() => setMode("supplier")}>
              {t("addSupplier")}
            </Button>
            <Button onClick={() => setMode("receiving")}>
              {t("receivePurchase")}
            </Button>
          </>
        )}
        {view === "team" && (
          <>
            <Button onClick={() => setMode("shift")}>{t("shifts")}</Button>
            <Button
              onClick={async () => {
                setRecords(await api("/shifts"));
                setMode("payroll");
              }}
            >
              {t("payroll")}
            </Button>
          </>
        )}
        {view === "settings" && (
          <>
            <Button onClick={() => setMode("import")}>{t("importMenu")}</Button>
            <select
              aria-label={t("orderingLinks")}
              value={linkChannel}
              onChange={(e) => setLinkChannel(e.target.value)}
            >
              <option value="qr">QR</option>
              <option value="kiosk">Kiosco / Kiosk</option>
            </select>
            <Button
              onClick={async () => {
                try {
                  const result = await api("/ordering-links", {
                    channel: linkChannel,
                    tableId: null,
                  });
                  setLink(location.origin + result.path);
                } catch (e) {
                  setError(translateError((e as Error).message, locale));
                }
              }}
            >
              {t("createLink")}
            </Button>
            {link && (
              <a href={link} target="_blank" rel="noreferrer">
                {t("orderingLinks")}
              </a>
            )}
          </>
        )}
        {view === "finance" && (
          <Button onClick={() => setMode("expense")}>{t("addExpense")}</Button>
        )}
      </div>
      {mode && (
        <Modal
          title={t(
            (
              {
                menu: "editMenu",
                supplier: "addSupplier",
                receiving: "receivePurchase",
                shift: "shifts",
                payroll: "payroll",
                import: "importMenu",
                expense: "addExpense",
              } as Record<string, Key>
            )[mode],
          )}
          close={() => setMode("")}
          closeLabel={t("close")}
          wide={mode === "menu"}
        >
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {mode === "payroll" ? (
            <>
              {records.map((r) => (
                <div className="report-row" key={r.id}>
                  <span>
                    {r.name}
                    <small>
                      {new Date(r.started_at).toLocaleString(locale, {
                        timeZone: session.restaurant.timezone,
                      })}{" "}
                      →{" "}
                      {r.ended_at
                        ? new Date(r.ended_at).toLocaleString(locale, {
                            timeZone: session.restaurant.timezone,
                          })
                        : t("active")}
                    </small>
                  </span>
                  <strong>
                    {new Intl.NumberFormat(locale, {
                      style: "currency",
                      currency: session.restaurant.currency,
                    }).format(r.estimated_pay / scale)}
                  </strong>
                </div>
              ))}
              <p>{t("estimateHint")}</p>
            </>
          ) : mode === "import" ? (
            <>
              <p>{t("importHint")}</p>
              <Field label={t("importFile")}>
                <input
                  type="file"
                  accept="application/json"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setRawImport(await file.text());
                      setPreview(null);
                    }
                  }}
                />
              </Field>
              <Button
                onClick={async () => {
                  try {
                    setPreview(
                      await api("/imports/preview", JSON.parse(rawImport)),
                    );
                  } catch (e) {
                    setError(translateError((e as Error).message, locale));
                  }
                }}
              >
                {t("previewImport")}
              </Button>
              {preview && (
                <div className="panel">
                  <p>
                    {t("accepted")}: {preview.counts.accepted} · {t("rejected")}
                    : {preview.counts.rejected}
                  </p>
                  <p>
                    {preview.sourceTenantId} → {preview.targetTenantId}
                  </p>
                  {preview.rejected.map((r: any) => (
                    <p key={r.row}>
                      {r.row}: {r.reason}
                    </p>
                  ))}
                  <Button
                    variant="primary"
                    disabled={preview.rejected.length > 0}
                    onClick={() =>
                      void save("/imports/commit", JSON.parse(rawImport))
                    }
                  >
                    {t("confirmImport")}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                const f = new FormData(e.currentTarget);
                const operationId = crypto.randomUUID();
                const val = (key: string) => String(f.get(key) ?? "");
                try {
                  if (mode === "menu")
                    void save("/catalog/save", {
                      operationId,
                      id: selected?.id ?? crypto.randomUUID(),
                      name: { es: val("es"), en: val("en") },
                      category: { es: val("catEs"), en: val("catEn") },
                      price: parseAmount(val("price")),
                      available: f.get("available") === "on",
                      station: val("station"),
                      expectedVersion: selected?.version ?? 0,
                      cost: val("cost") ? parseAmount(val("cost")) : null,
                      recipe,
                    });
                  if (mode === "supplier")
                    void save("/suppliers", { operationId, name: val("name") });
                  if (mode === "receiving")
                    void save("/receiving", {
                      operationId,
                      supplierId: val("supplierId"),
                      stockId: val("stockId"),
                      quantity: val("quantity"),
                      cost: parseAmount(val("cost")),
                      expiresOn: val("expiry") || null,
                      reason: val("reason"),
                    });
                  if (mode === "shift")
                    void save("/shifts", {
                      operationId,
                      employeeId: val("employeeId"),
                      hourlyRate: parseAmount(val("rate")),
                      action: val("action"),
                    });
                  if (mode === "expense")
                    void save("/expenses", {
                      operationId,
                      amount: parseAmount(val("amount")),
                      kind: val("kind"),
                      reason: val("reason"),
                    });
                } catch (e) {
                  setError(translateError((e as Error).message, locale));
                }
              }}
            >
              {mode === "menu" && (
                <>
                  <Field label={t("product")}>
                    <select
                      onChange={(e) => {
                        const product =
                          catalog.find((p) => p.id === e.target.value) ?? null;
                        setSelected(product);
                        setRecipe(
                          (product?.recipe ?? []).map(
                            (line: { stockId: string; quantity: string }) => ({
                              ...line,
                            }),
                          ),
                        );
                      }}
                    >
                      <option value="">{t("newProduct")}</option>
                      {catalog.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name[locale]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div key={selected?.id ?? "new"}>
                    <div className="form-grid">
                      <Field label="Nombre · Español">
                        <input
                          name="es"
                          defaultValue={selected?.name.es}
                          required
                        />
                      </Field>
                      <Field label="Name · English">
                        <input
                          name="en"
                          defaultValue={selected?.name.en}
                          required
                        />
                      </Field>
                      <Field label="Categoría · Español">
                        <input
                          name="catEs"
                          defaultValue={selected?.category.es}
                          required
                        />
                      </Field>
                      <Field label="Category · English">
                        <input
                          name="catEn"
                          defaultValue={selected?.category.en}
                          required
                        />
                      </Field>
                      <Field label={t("price")}>
                        <input
                          name="price"
                          inputMode="decimal"
                          defaultValue={selected ? selected.price / scale : ""}
                          required
                        />
                      </Field>
                      <Field label={t("cost")}>
                        <input
                          name="cost"
                          inputMode="decimal"
                          defaultValue={
                            selected?.cost !== null && selected
                              ? selected.cost / scale
                              : ""
                          }
                        />
                      </Field>
                    </div>
                    <Field label={t("station")}>
                      <select
                        name="station"
                        defaultValue={selected?.station ?? "kitchen"}
                      >
                        <option value="kitchen">{t("kitchen")}</option>
                        <option value="bar">{t("bar")}</option>
                      </select>
                    </Field>
                    <fieldset>
                      <legend>{t("recipe")}</legend>
                      {recipe.map((line, index) => (
                        <div className="form-grid" key={index}>
                          <Field label={`${t("stock")} ${index + 1}`}>
                            <select
                              required
                              value={line.stockId}
                              onChange={(e) =>
                                setRecipe(
                                  recipe.map((r, i) =>
                                    i === index
                                      ? { ...r, stockId: e.target.value }
                                      : r,
                                  ),
                                )
                              }
                            >
                              <option value="">—</option>
                              {stock.map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.name} ({i.unit})
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label={`${t("quantity")} ${index + 1}`}>
                            <input
                              required
                              inputMode="decimal"
                              value={line.quantity}
                              onChange={(e) =>
                                setRecipe(
                                  recipe.map((r, i) =>
                                    i === index
                                      ? { ...r, quantity: e.target.value }
                                      : r,
                                  ),
                                )
                              }
                            />
                          </Field>
                          <Button
                            aria-label={`${t("remove")} ${t("recipe")} ${index + 1}`}
                            onClick={() =>
                              setRecipe(recipe.filter((_, i) => i !== index))
                            }
                          >
                            {t("remove")}
                          </Button>
                        </div>
                      ))}
                      <Button
                        disabled={recipe.length >= 30}
                        onClick={() =>
                          setRecipe([...recipe, { stockId: "", quantity: "1" }])
                        }
                      >
                        {t("addIngredient")}
                      </Button>
                    </fieldset>
                    <label className="option">
                      <input
                        name="available"
                        type="checkbox"
                        defaultChecked={selected?.available ?? true}
                      />
                      {t("available")}
                    </label>
                  </div>
                </>
              )}
              {mode === "supplier" && (
                <Field label={t("name")}>
                  <input name="name" required />
                </Field>
              )}
              {mode === "receiving" && (
                <>
                  <Field label={t("supplier")}>
                    <select name="supplierId" required>
                      {suppliers.map((s) => (
                        <option value={s.id} key={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("stock")}>
                    <select name="stockId" required>
                      {stock.map((s) => (
                        <option value={s.id} key={s.id}>
                          {s.name} ({s.unit})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("quantity")}>
                    <input name="quantity" required inputMode="decimal" />
                  </Field>
                  <Field label={t("cost")}>
                    <input name="cost" required inputMode="decimal" />
                  </Field>
                  <Field label={t("expiry")}>
                    <input name="expiry" type="date" />
                  </Field>
                  <Field label={t("reason")}>
                    <input name="reason" required minLength={3} />
                  </Field>
                </>
              )}
              {mode === "shift" && (
                <>
                  <Field label={t("employee")}>
                    <select name="employeeId">
                      {team.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("hourlyRate")}>
                    <input
                      name="rate"
                      required
                      defaultValue="0"
                      inputMode="decimal"
                    />
                  </Field>
                  <Field label={t("action")}>
                    <select name="action">
                      <option value="start">{t("startShift")}</option>
                      <option value="end">{t("endShift")}</option>
                    </select>
                  </Field>
                </>
              )}
              {mode === "expense" && (
                <>
                  <Field label={t("amount")}>
                    <input name="amount" required inputMode="decimal" />
                  </Field>
                  <Field label={t("kind")}>
                    <select name="kind">
                      <option value="fixed">{t("fixed")}</option>
                      <option value="variable">{t("variable")}</option>
                    </select>
                  </Field>
                  <Field label={t("reason")}>
                    <input name="reason" required minLength={3} />
                  </Field>
                </>
              )}
              <Button className="full" variant="primary" type="submit">
                {t("save")}
              </Button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
