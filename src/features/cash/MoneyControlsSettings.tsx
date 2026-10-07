import { useEffect, useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Session,
} from "../../../shared/domain";
import { parseMoneyInput } from "../../../shared/service";
import {
  percentToBps,
  type MoneyControlsView,
  type StaffRole,
} from "../../../shared/discounts";
import { api } from "../../api";
import { Button, Field } from "../../components/ui";
import { strings, errorNotice, translateError, type Key } from "../../i18n";
import { fill } from "../discounts/format";
import {
  loadMoneyControls,
  setMoneyControls,
} from "../discounts/useMoneyControls";
import "./cash.css";

type Form = {
  limits: Record<StaffRole, { percent: string; amount: string }>;
  blindClose: boolean;
  expectedRoles: ("manager" | "cashier" | "server")[];
  closeRoles: StaffRole[];
};

/**
 * Configuración → "Descuentos y corte de caja" (§2.8): staff discount limits,
 * blind count, who sees expected cash and who closes the drawer. The owner
 * edits (step-up on terminals, asked by the server); managers read only.
 * Saving checks the version this form was loaded with.
 */
export function MoneyControlsSettings({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const scale = 10 ** exponent;
  const [view, setView] = useState<MoneyControlsView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const fromView = (v: MoneyControlsView): Form => ({
    limits: {
      cashier: {
        percent: String(v.limits.cashier.maxPercentBps / 100),
        amount: (v.limits.cashier.maxAmount / scale).toFixed(exponent),
      },
      server: {
        percent: String(v.limits.server.maxPercentBps / 100),
        amount: (v.limits.server.maxAmount / scale).toFixed(exponent),
      },
    },
    blindClose: v.blindClose,
    expectedRoles: v.expectedRoles,
    closeRoles: v.closeRoles,
  });
  async function load(force = false): Promise<boolean> {
    try {
      const v = await loadMoneyControls(session, force);
      setView(v);
      setForm(fromView(v));
      setOperationId(crypto.randomUUID());
      setError("");
      return true;
    } catch (e) {
      setError(t("discountsControlsLoadFailed"));
      void e;
      return false;
    }
  }
  useEffect(() => {
    void load(true);
  }, [session.id]);
  if (!view || !form)
    return (
      <section className="panel money-controls">
        <h2>{t("discountsControlsTitle")}</h2>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p>{t("loading")}</p>
        )}
      </section>
    );
  const readOnly = !view.canEdit;
  // "0", "0.0" and "0.00" all mean no discount without approval (0 bps);
  // percentToBps itself rejects 0 (DSC-R7).
  const percentOf = (text: string) =>
    /^0+(\.0{1,2})?$/.test(text.trim()) ? 0 : percentToBps(text);
  const toggle = <T extends string>(list: T[], value: T, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((x) => x !== value);
  async function save() {
    if (!form || !view) return;
    setError("");
    setStatus("");
    const limits = {} as Record<
      StaffRole,
      { maxPercentBps: number; maxAmount: number }
    >;
    for (const role of ["cashier", "server"] as const) {
      const bps = percentOf(form.limits[role].percent);
      let amount: number;
      try {
        amount = parseMoneyInput(form.limits[role].amount, exponent, {
          emptyAsZero: true,
        });
      } catch {
        setError(translateError("money_controls_invalid", locale));
        return;
      }
      if (bps === null) {
        setError(translateError("money_controls_invalid", locale));
        return;
      }
      limits[role] = { maxPercentBps: bps, maxAmount: amount };
    }
    setBusy(true);
    try {
      const saved = await api<MoneyControlsView>("/discounts/controls", {
        operationId,
        expectedVersion: view.version,
        limits,
        blindClose: form.blindClose,
        expectedRoles: form.expectedRoles,
        closeRoles: form.closeRoles,
      });
      setMoneyControls(saved, session);
      setView(saved);
      setForm(fromView(saved));
      setOperationId(crypto.randomUUID());
      setStatus(t("discountsControlsSaved"));
    } catch (e) {
      const code = (e as Error).message;
      if (code === "money_controls_changed") {
        // Another device saved first: show its values with the current
        // version, so the next save can succeed (DSC-R7).
        if (await load(true)) setError(t("discountsControlsReloaded"));
      } else if (code === "operation_conflict") {
        // An earlier save with this id was recorded (CONCURRENCY-4): show the
        // saved values; load() starts a new operation for the next save.
        if (await load(true)) setError(t("discountsOperationRecorded"));
      } else setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  const roleName: Record<string, Key> = {
    manager: "discountsRoleManager",
    cashier: "discountsRoleCashier",
    server: "discountsRoleServer",
  };
  return (
    <section
      className="panel money-controls"
      aria-labelledby="money-controls-title"
    >
      <h2 id="money-controls-title">{t("discountsControlsTitle")}</h2>
      {readOnly && (
        <p className="muted" role="note">
          {t("discountsControlsOwnerOnly")}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="field" disabled={readOnly}>
          <legend>{t("discountsControlsLimits")}</legend>
          <p className="muted tiny">{t("discountsControlsLimitsHint")}</p>
          {(["cashier", "server"] as const).map((role) => (
            <div className="form-grid" key={role}>
              <strong>{t(roleName[role])}</strong>
              <Field
                label={`${t(roleName[role])} · ${t("discountsControlsMaxPercent")}`}
              >
                <input
                  inputMode="decimal"
                  value={form.limits[role].percent}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      limits: {
                        ...form.limits,
                        [role]: {
                          ...form.limits[role],
                          percent: e.target.value,
                        },
                      },
                    })
                  }
                />
              </Field>
              <Field
                label={`${t(roleName[role])} · ${t("discountsControlsMaxAmount")}`}
              >
                <input
                  inputMode="decimal"
                  value={form.limits[role].amount}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      limits: {
                        ...form.limits,
                        [role]: {
                          ...form.limits[role],
                          amount: e.target.value,
                        },
                      },
                    })
                  }
                />
              </Field>
            </div>
          ))}
        </fieldset>
        <fieldset className="field" disabled={readOnly}>
          <label className="choice">
            <input
              type="checkbox"
              checked={form.blindClose}
              onChange={(e) =>
                setForm({ ...form, blindClose: e.target.checked })
              }
            />
            {t("discountsControlsBlind")}
          </label>
        </fieldset>
        <fieldset className="field" disabled={readOnly}>
          <legend>{t("discountsControlsExpectedRoles")}</legend>
          {(["manager", "cashier", "server"] as const).map((role) => (
            <label className="choice" key={role}>
              <input
                type="checkbox"
                checked={form.expectedRoles.includes(role)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    expectedRoles: toggle(
                      form.expectedRoles,
                      role,
                      e.target.checked,
                    ),
                  })
                }
              />
              {t(roleName[role])}
            </label>
          ))}
        </fieldset>
        <fieldset className="field" disabled={readOnly}>
          <legend>{t("discountsControlsCloseRoles")}</legend>
          {(["cashier", "server"] as const).map((role) => (
            <label className="choice" key={role}>
              <input
                type="checkbox"
                checked={form.closeRoles.includes(role)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    closeRoles: toggle(form.closeRoles, role, e.target.checked),
                  })
                }
              />
              {t(roleName[role])}
            </label>
          ))}
        </fieldset>
        <p className="muted tiny">{t("discountsControlsAlwaysOwner")}</p>
        {view.updatedByName && view.updatedAt && (
          <p className="muted tiny">
            {fill(t("discountsControlsUpdated"), {
              name: view.updatedByName,
              time: new Date(view.updatedAt).toLocaleString(locale, {
                timeZone: session.restaurant.timezone,
              }),
            })}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="notice" role="status">
            {status}
          </p>
        )}
        {!readOnly && (
          <Button variant="primary" type="submit" disabled={busy}>
            {t("discountsControlsSave")}
          </Button>
        )}
      </form>
    </section>
  );
}
