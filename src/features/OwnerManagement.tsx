import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { PRO_OFFER } from "../../shared/plans";
import { Button, Field } from "../components/ui";
import { responseError } from "../api";
import { strings, errorNotice, withSupportReference, type Key } from "../i18n";
import type { AccountConfig } from "./accountConfig";

type Restaurant = {
  id: string;
  name: string;
  organization_id: string;
  currency: string;
  timezone: string;
  activation_pending: boolean;
  free_location: boolean;
};
type Invitation = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  revoked: boolean;
  accepted_at: string | null;
};
type Status = {
  hostedUrl: string | null;
  billing: { interval: "month" | "year" } | null;
  operation: {
    id: string;
    kind: string;
    state: string;
    tenant_id: string;
    result: {
      amountDue?: number;
      locations?: number;
      expiresAt?: number;
      trialEnd?: number | null;
      expired?: boolean;
      applied?: boolean;
    };
  } | null;
};

export function OwnerManagement({
  locale,
  csrf,
  restaurants,
  roles = {},
  config = null,
  billingSandbox,
  refresh,
}: {
  locale: Locale;
  csrf: string;
  restaurants: Restaurant[];
  /** account (031): the account's role per organization. */
  roles?: Record<string, "primary" | "co_owner">;
  config?: AccountConfig | null;
  billingSandbox: boolean;
  refresh: () => Promise<void>;
}) {
  const es = locale === "es";
  const [selected, setSelected] = useState(restaurants[0]?.id ?? "");
  const restaurant = restaurants.find((r) => r.id === selected);
  // Co-owners manage staff and the Free location; billing and new locations
  // stay with the primary owner (account 031, D8).
  const coOwner =
    !!restaurant && roles[restaurant.organization_id] === "co_owner";
  const taxNote =
    config?.saasTax.mode === "tax_rate"
      ? es
        ? " + IVA 16 %."
        : " + 16% VAT."
      : " " + strings[locale].accountTaxNotConfigured;
  const roleLabel = (role: string) =>
    role === "co_owner"
      ? strings[locale].accountRoleCoOwner
      : (strings[locale][role as Key] ?? role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [link, setLink] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [consent, setConsent] = useState("");
  function savedOperation(kind: string, fingerprint: string) {
    const key = "gm-owner-command:" + kind;
    const raw = sessionStorage.getItem(key);
    const prior = raw ? JSON.parse(raw) : null;
    if (prior?.fingerprint === fingerprint && typeof prior.id === "string")
      return prior.id as string;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, id }));
    return id;
  }
  const money = (minor: number) =>
    new Intl.NumberFormat(es ? "es-MX" : "en-US", {
      style: "currency",
      currency: "MXN",
    }).format(minor / 100);
  async function request(path: string, body?: unknown) {
    const response = await fetch(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-csrf-token": csrf,
            },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok) {
      // With its status and request id, so a server error shows the
      // "Referencia de soporte" (docs/RUNBOOK.md "Signals").
      const error = await response.json().catch(() => ({}));
      throw responseError(response, error, "request_failed");
    }
    return response.json();
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      const code = (e as Error).message;
      setError(
        // account (031): a material change waits for the console's acceptance.
        code === "legal_acceptance_required"
          ? errorNotice(e, locale)
          : code === "pro_required"
            ? es
              ? "La sucursal de origen necesita Pro activo para agregar otra ubicación."
              : "The source location needs active Pro to add another location."
            : withSupportReference(
                es
                  ? "No se pudo completar. Revisa la conexión y vuelve a intentar; una solicitud pendiente puede tardar."
                  : "Could not complete. Check your connection and retry; a pending request may take a moment.",
                e,
                locale,
              ),
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const invites = await request(
          `/api/auth/account/invitations?tenantId=${selected}`,
        );
        const billing =
          billingSandbox && restaurant?.activation_pending
            ? await request(`/api/billing/status?tenantId=${selected}`)
            : null;
        if (live) {
          setInvitations(invites);
          setStatus(billing);
        }
        if (
          live &&
          billing?.operation?.tenant_id === selected &&
          billing.operation.result?.applied
        )
          await refresh();
      } catch (e) {
        if (live)
          setError(
            withSupportReference(
              es
                ? "No se pudo actualizar la administración."
                : "Could not refresh management.",
              e,
              locale,
            ),
          );
      }
    }
    if (selected) void load();
    const timer = setInterval(() => {
      if (selected && restaurant?.activation_pending) void load();
    }, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, billingSandbox, restaurant?.activation_pending]);
  const operation =
    status?.operation?.tenant_id === selected ? status.operation : null;
  const quote =
    operation?.kind === "location_quote" && operation.state === "succeeded"
      ? operation.result
      : null;
  const quoteValid = !!quote?.expiresAt && quote.expiresAt * 1000 > Date.now();
  const pending =
    operation && ["pending", "running", "review"].includes(operation.state);
  return (
    <details className="panel">
      <summary>
        {es ? "Administrar sucursales y acceso" : "Manage locations and access"}
      </summary>
      <Field label={es ? "Sucursal" : "Location"}>
        <select
          disabled={busy}
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setStatus(null);
            setInvitations([]);
            setLink("");
            setConsent("");
            setError("");
          }}
        >
          {restaurants.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      {restaurant && !restaurant.activation_pending && (
        <section>
          <p>
            {restaurant.free_location
              ? es
                ? "Sucursal seleccionada para Free."
                : "Selected Free location."
              : es
                ? "Esta sucursal requiere Pro para iniciar ventas. Puedes seleccionarla como tu única sucursal Free."
                : "This location requires Pro to start sales. You can select it as your only Free location."}
          </p>
          {!restaurant.free_location && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await request("/api/auth/account/free-location", {
                    tenantId: selected,
                  });
                  await refresh();
                })
              }
            >
              {es ? "Usar esta sucursal en Free" : "Use this location on Free"}
            </Button>
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {coOwner && (
        <p className="muted">{strings[locale].accountCoOwnerBillingNote}</p>
      )}
      {restaurant?.activation_pending && !coOwner && (
        <section>
          <h3>{es ? "Activar sucursal" : "Activate location"}</h3>
          <p>
            {es
              ? "La sucursal permanece inactiva hasta que Stripe confirme la actualización. Se conserva la fecha de renovación o fin de prueba de tu organización."
              : "The location stays inactive until Stripe confirms the update. Your organization’s renewal or trial end date stays the same."}
          </p>
          {billingSandbox && (
            <>
              <p>
                {es
                  ? "Prueba de facturación en sandbox."
                  : "Sandbox billing test."}
              </p>
              {quote && quoteValid && (
                <>
                  <p>
                    {es ? "Importe ahora: " : "Amount now: "}
                    {money(quote.amountDue ?? 0)}
                  </p>
                  <p>
                    {es ? "Nuevo total recurrente: " : "New recurring total: "}
                    {money(
                      (quote.locations ?? 0) *
                        (status?.billing?.interval === "year"
                          ? PRO_OFFER.annualMinor
                          : PRO_OFFER.monthlyMinor),
                    )}
                    {status?.billing?.interval === "year"
                      ? es
                        ? "/año"
                        : "/year"
                      : es
                        ? "/mes"
                        : "/month"}
                    {taxNote}
                  </p>
                  {quote.trialEnd && (
                    <p>
                      {es ? "Fin de prueba: " : "Trial ends: "}
                      {new Date(quote.trialEnd * 1000).toLocaleDateString(
                        es ? "es-MX" : "en-US",
                      )}
                    </p>
                  )}
                  <label className="opening-day">
                    <input
                      type="checkbox"
                      checked={consent === operation?.id}
                      onChange={(e) =>
                        setConsent(e.target.checked ? operation!.id : "")
                      }
                    />
                    {es
                      ? "Acepto el importe indicado y el nuevo total por las sucursales de mi organización."
                      : "I accept the quoted amount and the new total for my organization’s locations."}
                  </label>
                  <Button
                    disabled={busy || consent !== operation?.id}
                    onClick={() =>
                      void run(async () => {
                        await request("/api/billing/locations/confirm", {
                          quoteId: operation!.id,
                          consent: true,
                        });
                        setConsent("");
                        setStatus(
                          await request(
                            `/api/billing/status?tenantId=${selected}`,
                          ),
                        );
                      })
                    }
                  >
                    {es ? "Confirmar activación" : "Confirm activation"}
                  </Button>
                </>
              )}
              {!pending && (!quote || !quoteValid) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request("/api/billing/locations/quote", {
                        tenantId: selected,
                      });
                      setStatus(
                        await request(
                          `/api/billing/status?tenantId=${selected}`,
                        ),
                      );
                    })
                  }
                >
                  {es ? "Consultar importe" : "Get quote"}
                </Button>
              )}
              {pending && (
                <p role="status">
                  {operation.state === "review"
                    ? es
                      ? "La actualización necesita revisión; no vuelvas a crear la sucursal."
                      : "The update needs review; do not create the location again."
                    : es
                      ? "Actualización pendiente…"
                      : "Update pending…"}
                </p>
              )}
              {status?.hostedUrl && (
                <a className="button" href={status.hostedUrl}>
                  {es
                    ? "Completar pago en Stripe"
                    : "Complete payment in Stripe"}
                </a>
              )}
            </>
          )}
        </section>
      )}
      {restaurant && !restaurant.activation_pending && (
        <>
          <h3>{es ? "Invitar a tu equipo" : "Invite your team"}</h3>
          <p>
            {es
              ? "Crea un enlace para compartir. Caduca en 7 días y requiere la cuenta de Google del correo indicado."
              : "Create a link to share. It expires in 7 days and requires the Google account for the specified email."}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const body = {
                tenantId: selected,
                email: String(f.get("email")).trim(),
                role: f.get("role"),
              };
              const fingerprint = JSON.stringify(body);
              const operationId = savedOperation("invite", fingerprint);
              void run(async () => {
                const result = await request("/api/auth/account/invitations", {
                  ...body,
                  operationId,
                });
                setLink(new URL(result.path, location.origin).href);
                setInvitations(
                  await request(
                    `/api/auth/account/invitations?tenantId=${selected}`,
                  ),
                );
              });
            }}
          >
            <Field label={es ? "Correo de Google" : "Google email"}>
              <input name="email" type="email" required maxLength={254} />
            </Field>
            <Field label={es ? "Rol" : "Role"}>
              <select name="role">
                <option value="cashier">{es ? "Caja" : "Cashier"}</option>
                <option value="server">{es ? "Mesero" : "Server"}</option>
                <option value="kitchen">{es ? "Cocina" : "Kitchen"}</option>
                <option value="manager">{es ? "Gerente" : "Manager"}</option>
              </select>
            </Field>
            <Button type="submit" disabled={busy}>
              {es ? "Crear enlace" : "Create link"}
            </Button>
          </form>
          {link && (
            <Field
              label={
                es
                  ? "Enlace de invitación — copia y comparte"
                  : "Invitation link — copy and share"
              }
            >
              <input
                value={link}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
              />
            </Field>
          )}
          {invitations.map((i) => (
            <div key={i.id} className="panel">
              <p>
                {i.email} · {roleLabel(i.role)}
              </p>
              <p>
                {i.accepted_at
                  ? es
                    ? "Aceptada"
                    : "Accepted"
                  : i.revoked
                    ? es
                      ? "Revocada"
                      : "Revoked"
                    : new Date(i.expires_at).getTime() <= Date.now()
                      ? es
                        ? "Caducada"
                        : "Expired"
                      : es
                        ? "Pendiente"
                        : "Pending"}
              </p>
              {!i.accepted_at && !i.revoked && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await request("/api/auth/account/invitations/revoke", {
                        id: i.id,
                        tenantId: selected,
                      });
                      setLink("");
                      sessionStorage.removeItem("gm-owner-command:invite");
                      setInvitations(
                        await request(
                          `/api/auth/account/invitations?tenantId=${selected}`,
                        ),
                      );
                    })
                  }
                >
                  {es ? "Revocar enlace" : "Revoke link"}
                </Button>
              )}
            </div>
          ))}
          {!coOwner && (
            <>
              <h3>{es ? "Agregar sucursal" : "Add location"}</h3>
              <p>
                {es
                  ? "Requiere Pro. Cada sucursal cuesta MXN 799/mes o MXN 7,990/año."
                  : "Requires Pro. Each location costs MXN 799/month or MXN 7,990/year."}
                {taxNote}{" "}
                {es
                  ? "Después de crearla podrás revisar y confirmar el importe proporcional. No inicia otra prueba."
                  : "After creating it, review and confirm the prorated amount. This does not start another trial."}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const body = {
                    sourceTenantId: selected,
                    restaurantName: f.get("restaurantName"),
                    currency: restaurant.currency,
                    timezone: f.get("timezone"),
                    cutoff: 240,
                    openingDays: [1, 2, 3, 4, 5, 6, 7],
                  };
                  const fingerprint = JSON.stringify(body);
                  const operationId = savedOperation("location", fingerprint);
                  void run(async () => {
                    const result = await request(
                      "/api/auth/account/locations",
                      {
                        ...body,
                        operationId,
                      },
                    );
                    await refresh();
                    setSelected(result.tenantId);
                    setStatus(null);
                  });
                }}
              >
                <Field
                  label={
                    es ? "Nombre de la nueva sucursal" : "New location name"
                  }
                >
                  <input name="restaurantName" required maxLength={100} />
                </Field>
                <Field label={es ? "Zona horaria" : "Time zone"}>
                  <input
                    key={selected}
                    name="timezone"
                    required
                    defaultValue={restaurant.timezone}
                  />
                </Field>
                <p>
                  {es
                    ? "Horario inicial: todos los días, corte a las 04:00. Puedes ajustarlo en configuración al entrar."
                    : "Initial hours: every day, business day starts at 04:00. Adjust in settings after entering."}
                </p>
                <Button type="submit" disabled={busy}>
                  {es ? "Crear sucursal pendiente" : "Create pending location"}
                </Button>
              </form>
            </>
          )}
        </>
      )}
    </details>
  );
}
