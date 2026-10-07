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
  const [stock, setStock] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [team, setTeam] = useState<any[]>([]);
  // MON-3: one idempotency key per opened dialog, so a retried submit after a
  // lost response replays instead of recording the same command twice.
  const [dialogOperationId, setDialogOperationId] = useState(() =>
    crypto.randomUUID(),
  );
  useEffect(() => setDialogOperationId(crypto.randomUUID()), [mode]);
  const [rawImport, setRawImport] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [records, setRecords] = useState<any[]>([]);
  useEffect(() => {
    if (mode) {
      setError("");
      void Promise.all([
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
      setDialogOperationId(crypto.randomUUID());
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
                const operationId = dialogOperationId;
                const val = (key: string) => String(f.get(key) ?? "");
                try {
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
