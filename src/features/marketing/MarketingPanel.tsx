import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  MARKETING_DEFAULTS,
  type MarketingChannel,
  type MarketingSettings,
  type Segment,
} from "../../../shared/marketing";
import { api } from "../../api";
import { dateTime } from "../../datetime";
import { Badge, Button, Field } from "../../components/ui";
import { errorNotice } from "../../i18n";
import "./marketing.css";

type Overview = {
  settings: MarketingSettings & { version: number };
  channels: Record<MarketingChannel, boolean>;
  members: number;
  optedIn: number;
  confirmed: number;
};
type Counts = {
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  unknown: number;
};
type Campaign = {
  id: string;
  version: number;
  name: string;
  channels: MarketingChannel[];
  body: string;
  segment: Segment;
  state: string;
  scheduledAt: string | null;
  audience: number | null;
  messages: Counts;
};
type Automation = {
  key: string;
  name: { es: string; en: string };
  defaultBody: string;
  configured: boolean;
  active: boolean;
  channels: MarketingChannel[];
  body: string;
  params: { inactiveDays: number; everyVisits: number; averageCheck: number };
  messages: Counts | null;
};
type Results = {
  attributionDays: number;
  sent: number;
  failed: number;
  skipped: number;
  unknown: number;
  attributedOrders: number;
  attributedSales: number;
  averageOrder: number;
  byCampaign: {
    id: string;
    name: string;
    sent: number;
    orders: number;
    sales: number;
  }[];
};
const CHANNELS: MarketingChannel[] = ["sms", "whatsapp"];
const channelName = { sms: "SMS", whatsapp: "WhatsApp" } as const;
const SEGMENT = [
  ["minVisits", "Visitas mínimas", "Minimum visits"],
  ["maxVisits", "Visitas máximas", "Maximum visits"],
  [
    "visitedWithinDays",
    "Visitó en los últimos (días)",
    "Visited in the last (days)",
  ],
  [
    "notVisitedForDays",
    "No visita desde hace (días)",
    "Has not visited for (days)",
  ],
  [
    "joinedWithinDays",
    "Se unió en los últimos (días)",
    "Joined in the last (days)",
  ],
] as const;
const STATE: Record<string, [string, string, string]> = {
  draft: ["Borrador", "Draft", "neutral"],
  scheduled: ["Programada", "Scheduled", "amber"],
  sending: ["Enviando", "Sending", "amber"],
  sent: ["Enviada", "Sent", "green"],
  cancelled: ["Cancelada", "Cancelled", "red"],
};
const PARAM: Record<
  string,
  ["inactiveDays" | "everyVisits" | "averageCheck", string, string] | undefined
> = {
  miss_you: ["inactiveDays", "Días sin visita", "Days without a visit"],
  repeat_guest: [
    "everyVisits",
    "Cada cuántas visitas",
    "Every how many visits",
  ],
  big_spender: [
    "averageCheck",
    "Ticket promedio mínimo (centavos)",
    "Minimum average check (minor units)",
  ],
};
const blank = () => ({
  id: crypto.randomUUID() as string,
  version: 0,
  name: "",
  channels: ["sms"] as MarketingChannel[],
  body: "",
  segment: {} as Segment,
});

/**
 * Configuración › Club de lealtad › Marketing (047, docs/MARKETING.md): the switch,
 * who can be reached, campaigns, daily automations and the attribution estimate.
 * Managers and owners on Pro with the club on; everything is server-enforced.
 */
export function MarketingPanel({
  session,
  locale,
  online,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
}) {
  const es = locale === "es";
  const L = (a: string, b: string) => (es ? a : b);
  const money = (n: number) =>
    new Intl.NumberFormat(es ? "es-MX" : "en-US", {
      style: "currency",
      currency: session.restaurant.currency,
    }).format(n / 100);
  const [overview, setOverview] = useState<Overview | null>(null),
    [form, setForm] = useState<MarketingSettings>(MARKETING_DEFAULTS),
    [campaigns, setCampaigns] = useState<Campaign[]>([]),
    [automations, setAutomations] = useState<Automation[]>([]),
    [results, setResults] = useState<Results | null>(null),
    [editing, setEditing] = useState<ReturnType<typeof blank> | null>(null),
    [preview, setPreview] = useState<{
      matching: number;
      reachable: number;
    } | null>(null),
    [sending, setSending] = useState<Campaign | null>(null),
    [when, setWhen] = useState(""),
    [automation, setAutomation] = useState<Automation | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = async () => {
    const o = await api<Overview>("/marketing");
    setOverview(o);
    const { version: _version, ...settings } = o.settings;
    setForm(settings);
    setCampaigns(await api<Campaign[]>("/marketing/campaigns"));
    setAutomations(await api<Automation[]>("/marketing/automations"));
    setResults(await api<Results>("/marketing/performance?days=30"));
  };
  useEffect(() => {
    if (online) void load().catch((e) => setError(errorNotice(e, locale)));
  }, [online, locale]);
  const act = async (fn: () => Promise<unknown>, done = "") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      setNotice(done);
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  };
  const canSend = (channels: MarketingChannel[]) =>
    !!overview && channels.some((c) => overview.channels[c]);
  const toggle = (list: MarketingChannel[], c: MarketingChannel) =>
    list.includes(c) ? list.filter((x) => x !== c) : [...list, c];
  const channelBoxes = (
    value: MarketingChannel[],
    onChange: (next: MarketingChannel[]) => void,
  ) => (
    <fieldset>
      <legend>
        {L(
          "Canales (en orden de preferencia)",
          "Channels (in order of preference)",
        )}
      </legend>
      {CHANNELS.map((c) => (
        <label className="check" key={c}>
          <input
            type="checkbox"
            checked={value.includes(c)}
            onChange={() => onChange(toggle(value, c))}
          />
          {channelName[c]}
          {value.includes(c) ? ` (${value.indexOf(c) + 1})` : ""}
          {overview && !overview.channels[c]
            ? L(" · sin habilitar", " · not enabled")
            : ""}
        </label>
      ))}
    </fieldset>
  );
  const counts = (m: Counts) =>
    `${L("Enviados", "Sent")}: ${m.sent} · ${L("En cola", "Queued")}: ${m.queued} · ${L("Fallidos", "Failed")}: ${m.failed} · ${L("Omitidos", "Skipped")}: ${m.skipped}` +
    (m.unknown ? ` · ${L("Por verificar", "To verify")}: ${m.unknown}` : "");
  return (
    <section className="settings-section marketing-panel">
      <h3>Marketing</h3>
      <p className="muted">
        {L(
          "Campañas y mensajes automáticos para socios del club que aceptaron promociones y confirmaron su teléfono. Nada se envía hasta activar esta opción y hasta que el operador habilite un canal.",
          "Campaigns and automated messages for club members who accepted offers and confirmed their phone. Nothing is sent until this is switched on and your operator enables a channel.",
        )}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {overview && (
        <>
          <div className="marketing-tiles">
            {(
              [
                [L("Socios", "Members"), overview.members],
                [L("Aceptaron promociones", "Opted in"), overview.optedIn],
                [
                  L("Teléfono confirmado", "Phone confirmed"),
                  overview.confirmed,
                ],
              ] as const
            ).map(([label, value]) => (
              <div className="marketing-tile" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <p className="muted">
            {CHANNELS.map(
              (c) =>
                `${channelName[c]}: ${overview.channels[c] ? L("habilitado", "enabled") : L("sin habilitar", "not enabled")}`,
            ).join(" · ")}
            {". "}
            {L(
              "A quien acepta promociones se le pide confirmar su teléfono con un enlace, una vez al día.",
              "Members who opt in are asked to confirm their phone through a link, once a day.",
            )}
          </p>
          <fieldset disabled={!online || busy}>
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />
              {L("Activar marketing del club", "Turn on club marketing")}
            </label>
            <div className="marketing-grid">
              <Field
                label={L(
                  "Días mínimos entre mensajes automáticos",
                  "Minimum days between automated messages",
                )}
              >
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={form.frequencyCapDays}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      frequencyCapDays: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field
                label={L(
                  "Ventana de atribución (días)",
                  "Attribution window (days)",
                )}
              >
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={form.attributionDays}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      attributionDays: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field
                label={L(
                  "Hora local de envío automático (9–19)",
                  "Local hour for automated sends (9–19)",
                )}
              >
                <input
                  type="number"
                  min="9"
                  max="19"
                  value={form.sendHour}
                  onChange={(e) =>
                    setForm({ ...form, sendHour: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <Button
              onClick={() =>
                void act(
                  () =>
                    api("/marketing/settings", {
                      ...form,
                      expectedVersion: overview.settings.version,
                      operationId: crypto.randomUUID(),
                    }),
                  L(
                    "Opciones de marketing guardadas.",
                    "Marketing options saved.",
                  ),
                )
              }
            >
              {L("Guardar opciones de marketing", "Save marketing options")}
            </Button>
          </fieldset>

          <h4>{L("Campañas", "Campaigns")}</h4>
          {!editing && (
            <Button
              disabled={!online || busy}
              onClick={() => {
                setPreview(null);
                setEditing(blank());
              }}
            >
              {L("Nueva campaña", "New campaign")}
            </Button>
          )}
          {editing && (
            <fieldset className="marketing-editor" disabled={!online || busy}>
              <legend>{L("Campaña", "Campaign")}</legend>
              <Field label={L("Nombre de la campaña", "Campaign name")}>
                <input
                  value={editing.name}
                  maxLength={80}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                />
              </Field>
              {channelBoxes(editing.channels, (channels) =>
                setEditing({ ...editing, channels }),
              )}
              <Field label={L("Mensaje", "Message")}>
                <textarea
                  rows={4}
                  maxLength={600}
                  value={editing.body}
                  onChange={(e) =>
                    setEditing({ ...editing, body: e.target.value })
                  }
                />
              </Field>
              <p className="muted">
                {L(
                  "Puedes usar {{name}} y {{restaurant}}. Los SMS terminan con la instrucción STOP. WhatsApp usa la plantilla aprobada del operador.",
                  "You can use {{name}} and {{restaurant}}. SMS ends with the STOP instruction. WhatsApp uses your operator's approved template.",
                )}
              </p>
              <div className="marketing-grid">
                {SEGMENT.map(([key, a, b]) => (
                  <Field
                    key={key}
                    label={`${L(a, b)} (${L("opcional", "optional")})`}
                  >
                    <input
                      inputMode="numeric"
                      value={editing.segment[key] ?? ""}
                      onChange={(e) => {
                        const { [key]: _old, ...rest } = editing.segment;
                        const n = Number.parseInt(e.target.value, 10);
                        setPreview(null);
                        setEditing({
                          ...editing,
                          segment:
                            Number.isFinite(n) && n >= 0
                              ? { ...rest, [key]: n }
                              : rest,
                        });
                      }}
                    />
                  </Field>
                ))}
              </div>
              <div className="row wrap">
                <Button
                  onClick={async () => {
                    try {
                      setPreview(
                        await api("/marketing/audience", {
                          segment: editing.segment,
                        }),
                      );
                    } catch (e) {
                      setError(errorNotice(e, locale));
                    }
                  }}
                >
                  {L("Calcular audiencia", "Calculate audience")}
                </Button>
                <Button
                  variant="primary"
                  disabled={
                    !editing.name.trim() ||
                    !editing.body.trim() ||
                    !editing.channels.length
                  }
                  onClick={() =>
                    void act(
                      async () => {
                        const { version, ...campaign } = editing;
                        await api("/marketing/campaigns", {
                          operationId: crypto.randomUUID(),
                          expectedVersion: version,
                          campaign,
                        });
                        setEditing(null);
                      },
                      L(
                        "Campaña guardada como borrador.",
                        "Campaign saved as a draft.",
                      ),
                    )
                  }
                >
                  {L("Guardar borrador", "Save draft")}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  {L("Cancelar", "Cancel")}
                </Button>
              </div>
              {preview && (
                <p role="status">
                  {L("Coinciden", "Matching")}: {preview.matching} ·{" "}
                  {L("Recibirán el mensaje", "Will receive it")}:{" "}
                  <strong>{preview.reachable}</strong>
                </p>
              )}
            </fieldset>
          )}
          {campaigns.map((c) => (
            <article className="marketing-card" key={c.id}>
              <header className="row between">
                <strong>{c.name}</strong>
                <Badge tone={STATE[c.state]?.[2]}>
                  {L(
                    STATE[c.state]?.[0] ?? c.state,
                    STATE[c.state]?.[1] ?? c.state,
                  )}
                </Badge>
              </header>
              <p className="muted">
                {c.channels.map((x) => channelName[x]).join(" → ")}
                {c.state === "scheduled" && c.scheduledAt
                  ? ` · ${dateTime(c.scheduledAt, session.restaurant.timezone, locale)}`
                  : ""}
                {c.state !== "draft" && c.state !== "scheduled"
                  ? ` · ${counts(c.messages)}`
                  : ""}
              </p>
              <div className="row wrap">
                {c.state === "draft" && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setPreview(null);
                        setEditing({
                          id: c.id,
                          version: c.version,
                          name: c.name,
                          channels: c.channels,
                          body: c.body,
                          segment: c.segment,
                        });
                      }}
                    >
                      {L("Editar", "Edit")}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => {
                        setWhen("");
                        setSending(c);
                      }}
                    >
                      {L("Enviar o programar", "Send or schedule")}
                    </Button>
                  </>
                )}
                {(c.state === "scheduled" || c.state === "sending") && (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api("/marketing/campaigns/cancel", {
                          operationId: crypto.randomUUID(),
                          campaignId: c.id,
                        }),
                      )
                    }
                  >
                    {L("Cancelar envío", "Cancel send")}
                  </Button>
                )}
              </div>
              {sending?.id === c.id && (
                <fieldset className="marketing-editor" disabled={busy}>
                  <legend>{L("Confirmar envío", "Confirm send")}</legend>
                  <p>
                    {L(
                      "Los mensajes se envían una sola vez y no se pueden recuperar.",
                      "Messages are sent once and cannot be recalled.",
                    )}
                  </p>
                  {!canSend(c.channels) && (
                    <p role="status" className="error">
                      {L(
                        "Ningún canal de esta campaña está habilitado todavía.",
                        "No channel of this campaign is enabled yet.",
                      )}
                    </p>
                  )}
                  <Field
                    label={L(
                      "Fecha y hora (opcional, para programar)",
                      "Date and time (optional, to schedule)",
                    )}
                  >
                    <input
                      type="datetime-local"
                      value={when}
                      onChange={(e) => setWhen(e.target.value)}
                    />
                  </Field>
                  <div className="row wrap">
                    <Button
                      variant="primary"
                      disabled={
                        !canSend(c.channels) || !overview.settings.enabled
                      }
                      onClick={() =>
                        void act(async () => {
                          await api("/marketing/campaigns/launch", {
                            operationId: crypto.randomUUID(),
                            campaignId: c.id,
                            expectedVersion: c.version,
                            scheduledAt: when
                              ? new Date(when).toISOString()
                              : null,
                          });
                          setSending(null);
                        })
                      }
                    >
                      {when
                        ? L("Programar", "Schedule")
                        : L("Enviar ahora", "Send now")}
                    </Button>
                    <Button variant="ghost" onClick={() => setSending(null)}>
                      {L("Cancelar", "Cancel")}
                    </Button>
                  </div>
                </fieldset>
              )}
            </article>
          ))}

          <h4>{L("Automatizaciones diarias", "Daily automations")}</h4>
          <p className="muted">
            {L(
              "Se evalúan una vez al día. Cada socio recibe como máximo un mensaje automático por periodo.",
              "Evaluated once a day. Each member gets at most one automated message per period.",
            )}
          </p>
          {automations.map((a) => (
            <article className="marketing-card" key={a.key}>
              <header className="row between">
                <strong>{a.name[locale]}</strong>
                <Badge tone={a.active ? "green" : "neutral"}>
                  {a.active ? L("Activa", "Active") : L("Pausada", "Paused")}
                </Badge>
              </header>
              {a.messages && <p className="muted">{counts(a.messages)}</p>}
              {automation?.key === a.key ? (
                <fieldset className="marketing-editor" disabled={busy}>
                  <legend>{a.name[locale]}</legend>
                  {channelBoxes(automation.channels, (channels) =>
                    setAutomation({ ...automation, channels }),
                  )}
                  <Field label={L("Mensaje", "Message")}>
                    <textarea
                      rows={3}
                      maxLength={600}
                      value={automation.body}
                      onChange={(e) =>
                        setAutomation({ ...automation, body: e.target.value })
                      }
                    />
                  </Field>
                  {PARAM[a.key] && (
                    <Field label={L(PARAM[a.key]![1], PARAM[a.key]![2])}>
                      <input
                        type="number"
                        min="1"
                        value={automation.params[PARAM[a.key]![0]]}
                        onChange={(e) =>
                          setAutomation({
                            ...automation,
                            params: {
                              ...automation.params,
                              [PARAM[a.key]![0]]: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                  )}
                  <div className="row wrap">
                    {[true, false].map((active) => (
                      <Button
                        key={String(active)}
                        variant={active ? "primary" : "secondary"}
                        disabled={
                          !automation.channels.length || !automation.body.trim()
                        }
                        onClick={() =>
                          void act(async () => {
                            await api("/marketing/automations", {
                              operationId: crypto.randomUUID(),
                              key: a.key,
                              active,
                              channels: automation.channels,
                              body: automation.body,
                              params: automation.params,
                            });
                            setAutomation(null);
                          })
                        }
                      >
                        {active
                          ? L("Guardar y activar", "Save and turn on")
                          : L("Guardar en pausa", "Save paused")}
                      </Button>
                    ))}
                    <Button variant="ghost" onClick={() => setAutomation(null)}>
                      {L("Cancelar", "Cancel")}
                    </Button>
                  </div>
                </fieldset>
              ) : (
                <Button
                  disabled={!online || busy}
                  onClick={() => setAutomation(a)}
                >
                  {L("Configurar", "Configure")}: {a.name[locale]}
                </Button>
              )}
            </article>
          ))}

          {results && (
            <>
              <h4>{L("Resultados (30 días)", "Results (30 days)")}</h4>
              <p className="muted">
                {L(
                  `Estimación: una orden se atribuye al último mensaje enviado a ese socio en los ${results.attributionDays} días previos.`,
                  `Estimate: an order is attributed to the last message sent to that member in the ${results.attributionDays} days before it.`,
                )}
              </p>
              <div className="marketing-tiles">
                {(
                  [
                    [
                      L("Venta atribuida", "Attributed sales"),
                      money(results.attributedSales),
                    ],
                    [
                      L("Órdenes atribuidas", "Attributed orders"),
                      results.attributedOrders,
                    ],
                    [
                      L("Ticket promedio", "Average order"),
                      money(results.averageOrder),
                    ],
                    [L("Mensajes enviados", "Messages sent"), results.sent],
                  ] as const
                ).map(([label, value]) => (
                  <div className="marketing-tile" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              {results.byCampaign.length > 0 && (
                <table className="loyalty-table">
                  <thead>
                    <tr>
                      <th>{L("Campaña", "Campaign")}</th>
                      <th>{L("Enviados", "Sent")}</th>
                      <th>{L("Órdenes", "Orders")}</th>
                      <th>{L("Venta", "Sales")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.byCampaign.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>{c.sent}</td>
                        <td>{c.orders}</td>
                        <td>{money(c.sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
