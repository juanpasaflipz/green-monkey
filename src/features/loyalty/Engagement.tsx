import { dateTime } from "../../datetime";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Locale } from "../../../shared/domain";
import {
  ENGAGEMENT_DEFAULTS,
  type EngagementSettings,
} from "../../../shared/loyalty-engagement";
import { api } from "../../api";
import { Button, Field } from "../../components/ui";
import { errorNotice } from "../../i18n";

export function EngagementSettingsPanel({
  locale,
  online,
}: {
  locale: Locale;
  online: boolean;
}) {
  const es = locale === "es",
    [form, setForm] = useState<EngagementSettings>(ENGAGEMENT_DEFAULTS),
    [version, setVersion] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (online)
      api<EngagementSettings & { version: number }>("/loyalty/engagement")
        .then((v) => {
          setVersion(v.version);
          const { version: _, ...settings } = v;
          setForm(settings);
        })
        .catch((e) => setError(errorNotice(e, locale)));
  }, [online, locale]);
  const set = <K extends keyof EngagementSettings>(
    key: K,
    value: EngagementSettings[K],
  ) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const v = await api<EngagementSettings & { version: number }>(
        "/loyalty/engagement",
        { ...form, expectedVersion: version, operationId: crypto.randomUUID() },
      );
      setVersion(v.version);
      setSaved(true);
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section">
      <h3>
        {es
          ? "Recomendaciones, tarjetas y mensajes"
          : "Referrals, cards and messages"}
      </h3>
      <p className="muted">
        {es
          ? "Las opciones se guardan con el club activo. SMS y Wallet requieren que el operador configure los proveedores."
          : "Save these options while the club is active. SMS and Wallet require provider setup by your operator."}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <fieldset disabled={!online || busy || version === null}>
        <label className="check">
          <input
            type="checkbox"
            checked={form.referralsEnabled}
            onChange={(e) => set("referralsEnabled", e.target.checked)}
          />
          {es ? "Premiar recomendaciones" : "Reward referrals"}
        </label>
        <Field
          label={es ? "Sellos para cada persona" : "Stamps for each person"}
        >
          <input
            type="number"
            min="1"
            max="20"
            value={form.referralBonus}
            onChange={(e) => set("referralBonus", Number(e.target.value))}
          />
        </Field>
        <p className="muted">
          {es
            ? "Una recomendación por nuevo socio, durante sus primeros 7 días. Ambos reciben el bono."
            : "One referral per new member, within their first 7 days. Both receive the bonus."}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={form.walletEnabled}
            onChange={(e) => set("walletEnabled", e.target.checked)}
          />
          {es
            ? "Apple Wallet y Google Wallet"
            : "Apple Wallet and Google Wallet"}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.smsEnabled}
            onChange={(e) => set("smsEnabled", e.target.checked)}
          />
          {es
            ? "Mensajes automáticos a socios con consentimiento"
            : "Automatic messages to members who opted in"}
        </label>
        <Field
          label={
            es
              ? "Recordar premios después de (días)"
              : "Remind about rewards after (days)"
          }
        >
          <input
            type="number"
            min="1"
            max="90"
            value={form.reminderDays}
            onChange={(e) => set("reminderDays", Number(e.target.value))}
          />
        </Field>
        <Field
          label={es ? "Enlace para reseñas (HTTPS)" : "Review link (HTTPS)"}
        >
          <input
            type="url"
            maxLength={500}
            value={form.reviewUrl}
            onChange={(e) => set("reviewUrl", e.target.value)}
          />
        </Field>
        <Button onClick={() => void save()}>
          {busy ? "…" : es ? "Guardar opciones" : "Save options"}
        </Button>
      </fieldset>
      {saved && (
        <p role="status">{es ? "Opciones guardadas." : "Options saved."}</p>
      )}
    </section>
  );
}
export function MemberCardControl({
  memberId,
  locale,
  online,
  onIssued,
}: {
  memberId: string;
  locale: Locale;
  online: boolean;
  onIssued?: () => void;
}) {
  const es = locale === "es",
    [path, setPath] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setPath("");
    setError("");
  }, [memberId]);
  const issue = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ path: string }>(
        `/loyalty/members/${memberId}/card`,
        {},
      );
      setPath(r.path);
      onIssued?.();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="loyalty-member-card-control">
      <Button disabled={!online || busy} onClick={() => void issue()}>
        {es
          ? "Crear o reemplazar tarjeta digital"
          : "Create or replace digital card"}
      </Button>
      <p className="muted">
        {es
          ? "Entrega la tarjeta al socio presente. Reemplazarla desactiva el enlace y QR anteriores."
          : "Give the card to the member present. Replacing it disables the previous link and QR."}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {path && (
        <div className="loyalty-issued-card">
          <QRCodeSVG
            aria-label={es ? "Enlace QR de la tarjeta" : "Card link QR code"}
            value={`${location.origin}${path}`}
            size={192}
          />
          <a href={path} target="_blank" rel="noopener noreferrer">
            {es ? "Abrir tarjeta" : "Open card"}
          </a>
        </div>
      )}
    </div>
  );
}
export function MemberEngagement({
  memberId,
  locale,
  timezone,
  online,
  onBalanceChanged,
}: {
  memberId: string;
  locale: Locale;
  timezone: string;
  online: boolean;
  onBalanceChanged: () => void;
}) {
  const es = locale === "es",
    [activity, setActivity] = useState<any>(null),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api<any>(`/loyalty/members/${memberId}/activity`)
      .then(setActivity)
      .catch((e) => setError(errorNotice(e, locale)));
  useEffect(() => {
    if (online) void load();
  }, [memberId, online]);
  const refer = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/loyalty/referrals", {
        operationId: crypto.randomUUID(),
        memberId,
        code,
      });
      setCode("");
      await load();
      onBalanceChanged();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/loyalty/members/${memberId}/card/revoke`, {});
      await load();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  };
  const status: Record<string, string> = es
    ? {
        queued: "En cola",
        sending: "Enviando",
        sent: "Enviado",
        delivered: "Entregado",
        failed: "Falló",
        unknown: "Entrega por verificar",
        skipped: "Omitido",
      }
    : {
        queued: "Queued",
        sending: "Sending",
        sent: "Sent",
        delivered: "Delivered",
        failed: "Failed",
        unknown: "Delivery uncertain",
        skipped: "Skipped",
      };
  const kinds: Record<string, string> = es
    ? {
        welcome: "Bienvenida",
        stamp: "Sellos",
        reward: "Premio",
        referral: "Recomendación",
        reminder: "Recordatorio",
      }
    : {
        welcome: "Welcome",
        stamp: "Stamps",
        reward: "Reward",
        referral: "Referral",
        reminder: "Reminder",
      };
  return (
    <section>
      <h3>{es ? "Tarjeta y recomendaciones" : "Card and referrals"}</h3>
      <MemberCardControl
        memberId={memberId}
        locale={locale}
        online={online}
        onIssued={() => void load()}
      />
      <Button disabled={!online || busy} onClick={() => void revoke()}>
        {es ? "Desactivar tarjeta" : "Deactivate card"}
      </Button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {activity && (
        <p>
          {es ? "Código" : "Code"}: {activity.referralCode ?? "—"} ·{" "}
          {activity.referrals} {es ? "recomendaciones" : "referrals"} · +
          {activity.stamps} {es ? "sellos" : "stamps"}
        </p>
      )}
      <Field label={es ? "Código de quien lo recomendó" : "Referrer’s code"}>
        <input
          value={code}
          maxLength={16}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
      </Field>
      <Button
        disabled={!online || busy || code.length !== 16}
        onClick={() => void refer()}
      >
        {es ? "Aplicar recomendación" : "Apply referral"}
      </Button>
      <h3>{es ? "Mensajes recientes" : "Recent messages"}</h3>
      {activity?.messages.length === 0 && (
        <p className="muted">{es ? "No hay mensajes." : "No messages yet."}</p>
      )}
      <ul>
        {activity?.messages.map((m: any, i: number) => (
          <li key={i}>
            {kinds[m.kind] ?? m.kind} · {status[m.state] ?? m.state} ·{" "}
            {dateTime(m.created_at, timezone, locale)}
          </li>
        ))}
      </ul>
    </section>
  );
}
