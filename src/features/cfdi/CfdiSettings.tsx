/**
 * Settings → "Facturación electrónica (CFDI)" (spec §2.3, §2.4, §2.6): availability badge,
 * prerequisites and activation, the issuing organization and CSD blocks, the settings form, the
 * live-mode checklist, and the register and global periods in <details>. Owner edits with
 * step-up (api() asks for the PIN); a manager sees it read-only. While the organization is being
 * set up, a CSD is processing or live mode is requested, GET /cfdi/settings is polled every 3 s
 * (single-flight, 2 min at most).
 *
 * Rehearsal fixes (LD-51): activation asks for the global periodicity with RESICO's monthly rule
 * (F2); the issuer block shows the RFC only once Facturapi reports it (F9) and, in the shared
 * sandbox, the platform's test organization that stamps, without the legal-sync note (F3, F8);
 * the periodicity field states the one in force on the server's business date, a pending change
 * and why it waits (F10, CFDIFIX-5/6); the self-invoicing window explains how the global
 * periodicity in force, and a different one chosen, shortens it (F1).
 *
 * Second opinion (LD-55): the save's status says whether a periodicity change applied today or
 * waits, and until when (UX-2), and the select is described by the periodicity line; a
 * self-invoicing change that would shorten printed deadlines waits and says so (UX-4); RESICO's
 * activation shows no change hint (UX-3); the shared issuer note says the rules follow the
 * restaurant's own régimen, or that its profile stamps while Facturapi has not reported the test
 * organization (UX-6); an own organization's pending RFC says the CSD upload confirms it (UX-7).
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  CARD_PAYMENT_FORMS,
  CFDI_USES,
  PERIODICITIES,
  RESICO_REGIME,
  periodicityOn,
  type CardForm,
  type CfdiOrganizationView,
  type CfdiSettingsInput,
  type CfdiSettingsView,
  type CfdiUse,
  type PendingSelfInvoice,
  type Periodicity,
  type PeriodicityChangeBlock,
} from "../../../shared/cfdi";
import { REGIMEN_FISCAL } from "../../../shared/sat";
import { api } from "../../api";
import {
  strings,
  errorNotice,
  translateError,
  withSupportReference,
  type Key,
} from "../../i18n";
import { Badge, Button, Field } from "../../components/ui";
import { prefetchCfdiStatus } from "./status";
import { useFiscalContext } from "../fiscal/context";
import { CsdUpload } from "./CsdUpload";
import { CfdiDocuments } from "./CfdiDocuments";
import { GlobalPeriods } from "./GlobalPeriods";
import { dateLabel, shortDate, t as tr } from "./format";
import "./cfdi.css";

const POLL_MS = 3000;
const POLL_LIMIT_MS = 120_000;
const MANIFEST_URL = "https://www.facturapi.io/manifiesto";

const PERIODICITY_KEYS: Record<Periodicity, Key> = {
  day: "cfdiPeriodicityDay",
  week: "cfdiPeriodicityWeek",
  fortnight: "cfdiPeriodicityFortnight",
  month: "cfdiPeriodicityMonth",
};
const BOUND_KEYS: Record<Periodicity, Key> = {
  day: "cfdiBoundDay",
  week: "cfdiBoundWeek",
  fortnight: "cfdiBoundFortnight",
  month: "cfdiBoundMonth",
};

/** "Diaria", "Mensual", … in a sentence ("Periodicidad actual: mensual."). */
function periodicityName(p: Periodicity, locale: Locale): string {
  const label = strings[locale][PERIODICITY_KEYS[p]].split(" (")[0];
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The issuer block's facts (LD-51 F3, F8, F9): the RFC only once Facturapi reports it ("pendiente"
 * before); in the shared sandbox, the platform's test organization that stamps, with the note that
 * the restaurant's profile is not used, and no legal-sync note (nothing is synced there).
 */
export function OrganizationFacts({
  org,
  locale,
}: {
  org: CfdiOrganizationView;
  locale: Locale;
}) {
  const t = strings[locale];
  const shared = org.sharedIssuer;
  // The RFC Facturapi reports; before it does, what fills it (UX-7): an own organization's comes
  // with its CSD; an organization in error shows none (waiting will not help).
  const pendingRfc =
    org.status === "error"
      ? "—"
      : org.source === "own" &&
          (org.csd.status === "missing" || org.csd.status === "error")
        ? t.cfdiIssuerPendingCsd
        : t.cfdiIssuerPending;
  return (
    <>
      <dl className="cfdi-facts">
        <dt>{t.cfdiOrgStatus}</dt>
        <dd>
          {org.status === "provisioning" && t.cfdiOrgConfiguring}
          {org.status === "ready" && t.cfdiOrgReady}
          {org.status === "error" &&
            tr(locale, "cfdiOrgError", {
              error: orgErrorText(org.errorCode, locale),
            })}
        </dd>
        {shared?.legalName && (
          <>
            <dt>{t.cfdiIssuerLegalName}</dt>
            <dd>{shared.legalName}</dd>
          </>
        )}
        <dt>{t.cfdiIssuerRfc}</dt>
        <dd className={org.taxId ? "mono" : "muted"}>
          {org.taxId ?? pendingRfc}
        </dd>
        {shared?.regime && (
          <>
            <dt>{t.cfdiIssuerRegime}</dt>
            <dd>
              {shared.regime} —{" "}
              {REGIMEN_FISCAL[shared.regime]?.[locale] ?? shared.regime}
            </dd>
          </>
        )}
        {shared?.postalCode && (
          <>
            <dt>{t.cfdiIssuerPostalCode}</dt>
            <dd className="mono">{shared.postalCode}</dd>
          </>
        )}
      </dl>
      {org.source === "shared_sandbox" && (
        <p className="cfdi-warning" role="note">
          <strong>{t.cfdiSharedIssuerTitle}.</strong>{" "}
          {shared && !shared.complete
            ? t.cfdiSharedIssuerFallback
            : t.cfdiSharedIssuerNote}
        </p>
      )}
      {org.source === "own" && org.legalSyncedVersion !== null && (
        <p className="muted">
          {tr(locale, "cfdiLegalSynced", { n: org.legalSyncedVersion })}
        </p>
      )}
      {org.source === "own" &&
        org.status === "ready" &&
        (org.legalSyncedVersion ?? 0) < org.fiscalProfileVersion && (
          <p className="muted">{t.cfdiLegalPending}</p>
        )}
    </>
  );
}

const DEFERRED_KEYS: Record<PeriodicityChangeBlock, Key> = {
  globals: "cfdiDeferredGlobals",
  overdue: "cfdiDeferredOverdue",
  deadline: "cfdiDeferredDeadline",
};

/**
 * The periodicity in force and a pending change (LD-51 F10): the select shows what the owner
 * chose, these lines what applies on the server's business date (a pending change is in force
 * from its first day even before the tick promotes it, CFDIFIX-6), from when the change does and,
 * when it could not apply at once, why (CFDIFIX-5).
 */
export function PeriodicityStatus({
  settings,
  businessDate,
  locale,
  id,
}: {
  settings: Pick<
    NonNullable<CfdiSettingsView["settings"]>,
    "globalPeriodicity" | "nextPeriodicity" | "nextPeriodicityFrom"
  > &
    Partial<
      Pick<NonNullable<CfdiSettingsView["settings"]>, "periodicityDeferred">
    >;
  businessDate: string;
  locale: Locale;
  /** Describes the periodicity select (aria-describedby, UX-2). */
  id?: string;
}) {
  const current = periodicityOn(businessDate, settings);
  const pending =
    settings.nextPeriodicity &&
    settings.nextPeriodicityFrom &&
    settings.nextPeriodicityFrom > businessDate
      ? { next: settings.nextPeriodicity, from: settings.nextPeriodicityFrom }
      : null;
  const deferred = pending ? (settings.periodicityDeferred ?? null) : null;
  return (
    <p className="muted" id={id}>
      {tr(locale, "cfdiPeriodicityCurrent", {
        current: periodicityName(current, locale),
      })}
      {pending && (
        <>
          {" "}
          {tr(locale, "cfdiPeriodicityFrom", {
            next: periodicityName(pending.next, locale),
            date: dateLabel(pending.from, locale),
          })}
        </>
      )}
      {deferred && (
        <>
          {" "}
          {tr(locale, "cfdiPeriodicityDeferred", {
            reason: tr(locale, DEFERRED_KEYS[deferred.reason]),
          })}
        </>
      )}
    </p>
  );
}

/**
 * How the global periodicity shortens self-invoicing while the portal does not reissue globals
 * (LD-51 F1): the ticket can be self-invoiced only until its global is built. `periodicity` is the
 * one bounding this month's tickets; `next`, a different one chosen in the form or pending from
 * next month, gets its own sentence (CFDIFIX-6).
 */
export function SelfInvoiceBound({
  periodicity,
  next = null,
  graceMinutes,
  locale,
}: {
  periodicity: Periodicity;
  next?: Periodicity | null;
  graceMinutes: number;
  locale: Locale;
}) {
  return (
    <p className="muted tiny">
      {tr(locale, "cfdiSelfInvoiceBound", {
        when: tr(locale, BOUND_KEYS[periodicity], { n: graceMinutes }),
      })}
      {next && next !== periodicity && (
        <>
          {" "}
          {tr(locale, "cfdiSelfInvoiceBoundNext", {
            next: periodicityName(next, locale),
            when: tr(locale, BOUND_KEYS[next], { n: graceMinutes }),
          })}
        </>
      )}
    </p>
  );
}
/**
 * The activation step's periodicity (LD-51 F2): the select, RESICO's monthly rule and how the
 * periodicity bounds self-invoicing; the "you can change it later" hint only when the restaurant
 * can change it (not RESICO, LD-55 CFDIFIX-UX-3).
 */
export function ActivationPeriodicity({
  value,
  onChange,
  resico,
  busy,
  graceMinutes,
  locale,
}: {
  value: Periodicity;
  onChange: (p: Periodicity) => void;
  resico: boolean;
  busy: boolean;
  graceMinutes: number;
  locale: Locale;
}) {
  const t = strings[locale];
  return (
    <>
      <Field label={t.cfdiPeriodicity}>
        <select
          value={resico ? "month" : value}
          disabled={busy || resico}
          onChange={(e) => onChange(e.target.value as Periodicity)}
        >
          {PERIODICITIES.map((p) => (
            <option key={p} value={p}>
              {t[PERIODICITY_KEYS[p]]}
            </option>
          ))}
        </select>
      </Field>
      {resico && <p className="muted">{t.cfdiResicoMonthly}</p>}
      <p className="muted tiny">{t.cfdiPeriodicityHint}</p>
      <SelfInvoiceBound
        periodicity={resico ? "month" : value}
        graceMinutes={graceMinutes}
        locale={locale}
      />
      {!resico && <p className="muted tiny">{t.cfdiActivatePeriodicityHint}</p>}
    </>
  );
}

/** A self-invoicing change that waits (LD-55 CFDIFIX-FISCAL-5 / UX-4): from when. */
export function SelfInvoicePendingStatus({
  pending,
  locale,
}: {
  pending: PendingSelfInvoice | null;
  locale: Locale;
}) {
  if (!pending) return null;
  return (
    <p className="muted">
      {tr(locale, "cfdiSelfInvoicePendingStatus", {
        date: dateLabel(pending.from, locale),
      })}
    </p>
  );
}

/**
 * A refused settings save, translated. Terms that would cut the deadline receipts printed while a
 * self-invoicing change waits (CFDIFIX-R2-2) name the date that change applies from.
 */
export function settingsSaveError(
  error: unknown,
  settings: Pick<
    NonNullable<CfdiSettingsView["settings"]>,
    "selfInvoicePending"
  >,
  locale: Locale,
): string {
  const code = (error as { message?: unknown } | null | undefined)?.message;
  if (
    code === "cfdi_self_invoice_pending_printed" &&
    settings.selfInvoicePending
  )
    return withSupportReference(
      tr(locale, "cfdiSelfInvoicePendingPrinted", {
        date: dateLabel(settings.selfInvoicePending.from, locale),
      }),
      error,
      locale,
    );
  return errorNotice(error, locale);
}

/** Whether `next` self-invoicing terms end earlier than `prev` for some ticket (UX-4 hint). */
export function selfInvoiceShortens(
  prev: Pick<
    Form,
    "selfInvoicePolicy" | "selfInvoiceDays" | "portalReissueGlobal"
  >,
  next: Pick<
    Form,
    "selfInvoicePolicy" | "selfInvoiceDays" | "portalReissueGlobal"
  >,
): boolean {
  if (prev.portalReissueGlobal && !next.portalReissueGlobal) return true;
  if (next.selfInvoicePolicy !== "days") return false;
  // A month-end window lasts at most 31 days; a window of days shortens it below that.
  return prev.selfInvoicePolicy === "month"
    ? next.selfInvoiceDays < 31
    : next.selfInvoiceDays < prev.selfInvoiceDays;
}

/**
 * What a save did that the owner must hear (UX-2): a periodicity change that applied today, or
 * that waits (until when, and why); a self-invoicing change that waits. Read with the status
 * "Configuración de facturación guardada"; empty when nothing of that changed.
 */
export function settingsSavedNote(
  prev: NonNullable<CfdiSettingsView["settings"]>,
  next: NonNullable<CfdiSettingsView["settings"]>,
  businessDate: string,
  locale: Locale,
): string {
  const parts: string[] = [];
  const pendingNow =
    next.nextPeriodicity &&
    next.nextPeriodicityFrom &&
    next.nextPeriodicityFrom > businessDate
      ? { to: next.nextPeriodicity, from: next.nextPeriodicityFrom }
      : null;
  const changedPending =
    pendingNow &&
    (pendingNow.to !== prev.nextPeriodicity ||
      pendingNow.from !== prev.nextPeriodicityFrom);
  if (pendingNow && changedPending)
    parts.push(
      tr(locale, "cfdiSavedPeriodicityLater", {
        next: periodicityName(pendingNow.to, locale),
        date: dateLabel(pendingNow.from, locale),
        reason: tr(
          locale,
          DEFERRED_KEYS[next.periodicityDeferred?.reason ?? "deadline"],
        ),
      }),
    );
  else if (
    periodicityOn(businessDate, next) !== periodicityOn(businessDate, prev)
  )
    parts.push(
      tr(locale, "cfdiSavedPeriodicityNow", {
        next: periodicityName(periodicityOn(businessDate, next), locale),
      }),
    );
  const si = next.selfInvoicePending;
  if (
    si &&
    !(
      prev.selfInvoicePending &&
      prev.selfInvoicePending.from === si.from &&
      prev.selfInvoicePending.policy === si.policy &&
      prev.selfInvoicePending.days === si.days &&
      prev.selfInvoicePending.reissue === si.reissue
    )
  )
    parts.push(
      tr(locale, "cfdiSavedSelfInvoiceLater", {
        date: dateLabel(si.from, locale),
      }),
    );
  return parts.join(" ");
}

const USE_KEYS: Record<CfdiUse, Key> = {
  G03: "cfdiUseG03",
  G01: "cfdiUseG01",
  S01: "cfdiUseS01",
};

type Form = Omit<CfdiSettingsInput, "operationId" | "expectedVersion">;

function formOf(s: NonNullable<CfdiSettingsView["settings"]>): Form {
  return {
    enabled: s.enabled,
    // RESICO issues monthly globals: the form always carries month (CFDI-UX-1, SAT-4).
    globalPeriodicity: s.resicoMonthly
      ? "month"
      : (s.nextPeriodicity ?? s.globalPeriodicity),
    globalAuto: s.globalAuto,
    conceptMode: s.conceptMode,
    conceptDescription: s.conceptDescription,
    cardPaymentForm: s.cardPaymentForm,
    defaultUse: s.defaultUse,
    selfInvoiceEnabled: s.selfInvoiceEnabled,
    // A self-invoicing change that waits is what the owner chose (as the periodicity's).
    selfInvoicePolicy: s.selfInvoicePending?.policy ?? s.selfInvoicePolicy,
    selfInvoiceDays: s.selfInvoicePending?.days ?? s.selfInvoiceDays,
    portalReissueGlobal: s.selfInvoicePending?.reissue ?? s.portalReissueGlobal,
    supportEmail: s.supportEmail,
  };
}

/** The header badge (spec §2.3). */
export function cfdiBadge(v: CfdiSettingsView): { key: Key; tone: string } {
  if (!v.prerequisites.platform)
    return { key: "cfdiBadgeUnavailable", tone: "neutral" };
  if (!v.settings) return { key: "cfdiBadgeOff", tone: "neutral" };
  const a = v.attention;
  if (
    v.organization?.status === "error" ||
    v.organization?.csd.status === "expired" ||
    a.overdueGlobals > 0 ||
    a.rejectedSubstitutions > 0
  )
    return { key: "cfdiBadgeAttention", tone: "red" };
  if (!v.settings.enabled) return { key: "cfdiBadgeOff", tone: "neutral" };
  return v.settings.mode === "live"
    ? { key: "cfdiBadgeLive", tone: "green" }
    : { key: "cfdiBadgeTest", tone: "amber" };
}

/**
 * The organization's error, translated. A missing code (never stored: error rows carry one) reads
 * as Facturapi's unexpected error rather than the bare generic "error" (CFDI-INT-6).
 */
export function orgErrorText(code: string | null, locale: Locale): string {
  return translateError(code ?? "cfdi_unexpected_error", locale);
}

/** Something the worker is still doing: poll until it settles. */
export function settling(v: CfdiSettingsView | null): boolean {
  if (!v?.settings) return false;
  const upload = v.organization?.csd.lastUpload?.status;
  return (
    v.organization?.status === "provisioning" ||
    v.organization?.csd.status === "processing" ||
    upload === "queued" ||
    upload === "processing" ||
    (!!v.settings.liveRequested && v.settings.mode === "test")
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={ok ? "cfdi-check ok" : "cfdi-check missing"}>
      <span aria-hidden="true">{ok ? "✓" : "✗"}</span> {children}
    </li>
  );
}

/** A <details> whose content mounts (and loads) the first time it opens. */
function LazyDetails({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="cfdi-section"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) setOpened(true);
      }}
    >
      <summary>{summary}</summary>
      {opened && children}
    </details>
  );
}

export function CfdiSettings({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const titleId = useId();
  const tz = session.restaurant.timezone;
  const [data, setData] = useState<CfdiSettingsView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const periodicityStatusId = useId();
  const [stillWorking, setStillWorking] = useState(false);
  const [formOperation, setFormOperation] = useState(() => crypto.randomUUID());
  const [activateOperation, setActivateOperation] = useState(() =>
    crypto.randomUUID(),
  );
  const [liveOperation, setLiveOperation] = useState(() => crypto.randomUUID());
  const [retryOperation, setRetryOperation] = useState(() =>
    crypto.randomUUID(),
  );
  const [liveFrom, setLiveFrom] = useState("");
  const [activatePeriodicity, setActivatePeriodicity] =
    useState<Periodicity>("month");
  const alive = useRef(true);
  // The poll keeps its 2-minute budget when the parent passes a refreshed session object.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const apply = useCallback((v: CfdiSettingsView, resetForm: boolean) => {
    setData(v);
    if (resetForm || !v.settings)
      setForm(v.settings ? formOf(v.settings) : null);
    setLiveFrom((d) => d || v.live.defaultFrom);
  }, []);

  const load = useCallback(
    async (resetForm: boolean) => {
      try {
        const v = await api<CfdiSettingsView>("/cfdi/settings");
        if (alive.current) apply(v, resetForm);
        return v;
      } catch (e) {
        if (alive.current) setError(errorNotice(e, locale));
        return null;
      }
    },
    [apply, locale],
  );

  useEffect(() => {
    alive.current = true;
    void load(true);
    return () => {
      alive.current = false;
    };
  }, [load]);

  // Datos fiscales sits on the same screen: when it saves (FiscalSettings refreshes the
  // fiscal context), re-read the prerequisites, so "Completa los datos fiscales" and the
  // disabled "Activar en modo prueba" do not outlive the save. Form edits are kept.
  const fiscal = useFiscalContext();
  const seenFiscal = useRef(fiscal);
  useEffect(() => {
    if (seenFiscal.current === fiscal) return;
    seenFiscal.current = fiscal;
    void load(false);
  }, [fiscal, load]);

  // Poll while the worker is settling something (single-flight, 2 min).
  const polling = settling(data);
  useEffect(() => {
    if (!polling) return;
    setStillWorking(false);
    const started = Date.now();
    let inFlight = false;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || inFlight) return;
      if (Date.now() - started > POLL_LIMIT_MS) {
        stopped = true;
        clearInterval(timer);
        setStillWorking(true);
        return;
      }
      inFlight = true;
      try {
        const v = await api<CfdiSettingsView>("/cfdi/settings");
        if (!stopped && alive.current) {
          setData(v);
          if (!settling(v)) void prefetchCfdiStatus(sessionRef.current);
        }
      } catch {
        stopped = true;
        clearInterval(timer);
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [polling]);

  async function post(
    path: string,
    body: unknown,
    after: (v: CfdiSettingsView) => void,
    resetForm = false,
    notice: (e: unknown) => string = (e) => errorNotice(e, locale),
  ) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const v = await api<CfdiSettingsView>(path, body);
      after(v);
      apply(v, resetForm);
      void prefetchCfdiStatus(session);
    } catch (e) {
      setError(notice(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data)
    return (
      <section className="panel cfdi-settings" aria-labelledby={titleId}>
        <h2 id={titleId}>{t.cfdiTitle}</h2>
        <p role="status">{error || t.loading}</p>
      </section>
    );

  const badge = cfdiBadge(data);
  const settings = data.settings;
  const org = data.organization;
  const owner = data.canEdit;
  const pre = data.prerequisites;
  const prereqsOk =
    pre.platform && pre.fiscalComplete && pre.currency && pre.legalNameLength;
  // RESICO issues monthly globals (D4, SAT-4): the activation shows it and sends month.
  const resico = pre.regime === RESICO_REGIME;
  const set = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setSaved(false);
  };
  const csd = org?.csd;
  const csdSoon =
    csd?.status === "valid" &&
    !!csd.validUntil &&
    Date.parse(csd.validUntil) < Date.now() + 30 * 86_400_000;
  const csdLive =
    csd?.status === "valid" &&
    !!csd.validUntil &&
    Date.parse(csd.validUntil) > Date.now() + 7 * 86_400_000;
  const uploadBusy = ["queued", "processing"].includes(
    csd?.lastUpload?.status ?? "",
  );
  const a = data.attention;

  return (
    <section className="panel cfdi-settings" aria-labelledby={titleId}>
      <div className="row between wrap">
        <h2 id={titleId}>{t.cfdiTitle}</h2>
        <Badge tone={badge.tone}>{t[badge.key]}</Badge>
      </div>
      {!owner && <p className="muted">{t.cfdiOwnerOnly}</p>}
      {data.provider === "disabled" && (
        <p className="muted">{t.cfdiPlatformDisabled}</p>
      )}
      {data.provider === "sandbox_shared" && (
        <p className="cfdi-warning" role="note">
          {t.cfdiSharedSandbox}
        </p>
      )}

      {!settings && (
        <div className="cfdi-activation">
          <h3>{t.cfdiPrerequisites}</h3>
          <ul className="cfdi-checklist">
            <Check ok={pre.platform}>
              {pre.platform ? t.cfdiPrereqPlatform : t.cfdiPlatformDisabled}
            </Check>
            <Check ok={pre.fiscalComplete}>
              {pre.fiscalComplete ? t.cfdiPrereqFiscalOk : t.cfdiPrereqFiscal}
            </Check>
            <Check ok={pre.currency}>
              {pre.currency ? t.cfdiPrereqCurrencyOk : t.cfdiPrereqCurrency}
            </Check>
            <Check ok={pre.legalNameLength}>
              {pre.legalNameLength
                ? t.cfdiPrereqLegalNameOk
                : t.cfdiPrereqLegalName}
            </Check>
          </ul>
          <p>{t.cfdiIntro}</p>
          {owner && (
            <>
              <ActivationPeriodicity
                value={activatePeriodicity}
                onChange={setActivatePeriodicity}
                resico={resico}
                busy={busy}
                graceMinutes={data.globalGraceMinutes}
                locale={locale}
              />
              <Button
                variant="primary"
                disabled={busy || !prereqsOk}
                onClick={() =>
                  void post(
                    "/cfdi/activate",
                    {
                      operationId: activateOperation,
                      expectedVersion: 0,
                      globalPeriodicity: resico ? "month" : activatePeriodicity,
                    },
                    () => setActivateOperation(crypto.randomUUID()),
                    true,
                  )
                }
              >
                {t.cfdiActivate}
              </Button>
            </>
          )}
        </div>
      )}

      {settings && org && (
        <div className="cfdi-block">
          <h3>{t.cfdiOrgTitle}</h3>
          <OrganizationFacts org={org} locale={locale} />
          {org.status === "provisioning" && (
            <p role="status">
              {stillWorking ? t.cfdiStillWorking : t.cfdiProvisioning}
            </p>
          )}
          {org.status === "error" && (
            <Button
              disabled={busy}
              onClick={() =>
                void post(
                  "/cfdi/organization/retry",
                  { operationId: retryOperation },
                  () => setRetryOperation(crypto.randomUUID()),
                )
              }
            >
              {t.cfdiRetry}
            </Button>
          )}
        </div>
      )}

      {settings && org?.source === "own" && csd && (
        <div className="cfdi-block">
          <h3>{t.cfdiCsdTitle}</h3>
          <p
            className={
              csd.status === "expired" || csd.status === "error"
                ? "error"
                : csdSoon
                  ? "cfdi-warning"
                  : undefined
            }
          >
            {(csd.status === "processing" || uploadBusy) && t.cfdiCsdProcessing}
            {!uploadBusy && csd.status === "missing" && t.cfdiCsdMissing}
            {!uploadBusy &&
              csd.status === "valid" &&
              csd.validUntil &&
              tr(locale, "cfdiCsdValidUntil", {
                date: shortDate(csd.validUntil, tz, locale),
              })}
            {!uploadBusy && csd.status === "expired" && t.cfdiCsdExpired}
            {!uploadBusy &&
              csd.status === "error" &&
              tr(locale, "cfdiCsdRejected", {
                error: translateError(
                  csd.lastUpload?.errorCode ?? "cfdi_csd_invalid",
                  locale,
                ),
              })}
          </p>
          {!uploadBusy &&
            csd.lastUpload?.status === "rejected" &&
            csd.status !== "error" && (
              <p className="error">
                {tr(locale, "cfdiCsdRejected", {
                  error: translateError(
                    csd.lastUpload.errorCode ?? "cfdi_csd_invalid",
                    locale,
                  ),
                })}
              </p>
            )}
          {owner && !uploadBusy && org.provisioned && (
            <CsdUpload
              session={session}
              locale={locale}
              onDone={() => void load(false)}
            />
          )}
          {owner && !org.provisioned && (
            <p className="muted">{t.cfdiCsdAfterOrg}</p>
          )}
        </div>
      )}

      {settings && form && (
        <form
          className="cfdi-block cfdi-settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void post(
              "/cfdi/settings",
              {
                operationId: formOperation,
                expectedVersion: settings.version,
                ...form,
                globalPeriodicity: settings.resicoMonthly
                  ? "month"
                  : form.globalPeriodicity,
                conceptDescription: form.conceptDescription.trim(),
                supportEmail: form.supportEmail?.trim() || null,
              },
              (v) => {
                setFormOperation(crypto.randomUUID());
                setSavedNote(
                  v.settings
                    ? settingsSavedNote(
                        settings,
                        v.settings,
                        v.businessDate,
                        locale,
                      )
                    : "",
                );
                setSaved(true);
              },
              true,
              (e) => settingsSaveError(e, settings, locale),
            );
          }}
        >
          <h3>{t.cfdiSettingsTitle}</h3>
          <fieldset disabled={!owner || busy}>
            <label className="option">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              {t.cfdiEnabled}
            </label>
            {settings.enabled && !form.enabled && (
              <p className="cfdi-warning" role="note">
                {t.cfdiPauseConfirm}
              </p>
            )}
            <Field label={t.cfdiPeriodicity}>
              <select
                value={
                  settings.resicoMonthly ? "month" : form.globalPeriodicity
                }
                aria-describedby={periodicityStatusId}
                disabled={settings.resicoMonthly}
                onChange={(e) =>
                  set({ globalPeriodicity: e.target.value as Periodicity })
                }
              >
                {PERIODICITIES.map((p) => (
                  <option key={p} value={p}>
                    {t[PERIODICITY_KEYS[p]]}
                  </option>
                ))}
              </select>
            </Field>
            {settings.resicoMonthly && (
              <p className="muted">{t.cfdiResicoMonthly}</p>
            )}
            <PeriodicityStatus
              settings={settings}
              businessDate={data.businessDate}
              locale={locale}
              id={periodicityStatusId}
            />
            <p className="muted tiny">{t.cfdiPeriodicityHint}</p>
            {!settings.resicoMonthly && (
              <p className="muted tiny">{t.cfdiPeriodicityChangeHint}</p>
            )}
            <label className="option">
              <input
                type="checkbox"
                checked={form.globalAuto}
                onChange={(e) => set({ globalAuto: e.target.checked })}
              />
              {t.cfdiGlobalAuto}
            </label>
            <fieldset>
              <legend>{t.cfdiConceptMode}</legend>
              <label className="option">
                <input
                  type="radio"
                  name="cfdi-concept-mode"
                  checked={form.conceptMode === "grouped"}
                  onChange={() => set({ conceptMode: "grouped" })}
                />
                {t.cfdiConceptGrouped}
              </label>
              <label className="option">
                <input
                  type="radio"
                  name="cfdi-concept-mode"
                  checked={form.conceptMode === "itemized"}
                  onChange={() => set({ conceptMode: "itemized" })}
                />
                {t.cfdiConceptItemized}
              </label>
            </fieldset>
            <Field label={t.cfdiConceptDescription}>
              <input
                value={form.conceptDescription}
                maxLength={200}
                required
                onChange={(e) => set({ conceptDescription: e.target.value })}
              />
            </Field>
            <fieldset>
              <legend>{t.cfdiCardForm}</legend>
              {CARD_PAYMENT_FORMS.map((f) => (
                <label className="option" key={f}>
                  <input
                    type="radio"
                    name="cfdi-card-form"
                    checked={form.cardPaymentForm === f}
                    onChange={() => set({ cardPaymentForm: f as CardForm })}
                  />
                  {f === "04" ? t.cfdiCardCredit : t.cfdiCardDebit}
                </label>
              ))}
              <p className="muted tiny">{t.cfdiCardFormHint}</p>
            </fieldset>
            <Field label={t.cfdiDefaultUse}>
              <select
                value={form.defaultUse}
                onChange={(e) => set({ defaultUse: e.target.value as CfdiUse })}
              >
                {CFDI_USES.map((u) => (
                  <option key={u} value={u}>
                    {t[USE_KEYS[u]]}
                  </option>
                ))}
              </select>
            </Field>
            <label className="option">
              <input
                type="checkbox"
                checked={form.selfInvoiceEnabled}
                onChange={(e) => set({ selfInvoiceEnabled: e.target.checked })}
              />
              {t.cfdiSelfInvoiceToggle}
            </label>
            <p className="muted tiny">{t.cfdiSelfInvoice}</p>
            <fieldset disabled={!form.selfInvoiceEnabled}>
              <legend>{t.cfdiSelfInvoiceWindow}</legend>
              <label className="option">
                <input
                  type="radio"
                  name="cfdi-window"
                  checked={form.selfInvoicePolicy === "month"}
                  onChange={() => set({ selfInvoicePolicy: "month" })}
                />
                {t.cfdiWindowMonth}
              </label>
              <label className="option">
                <input
                  type="radio"
                  name="cfdi-window"
                  checked={form.selfInvoicePolicy === "days"}
                  onChange={() => set({ selfInvoicePolicy: "days" })}
                />
                {tr(locale, "cfdiWindowDays", { n: form.selfInvoiceDays })}
              </label>
              {form.selfInvoicePolicy === "days" && (
                <Field label={t.cfdiWindowDaysLabel}>
                  <input
                    type="number"
                    min={1}
                    max={90}
                    required
                    value={form.selfInvoiceDays}
                    onChange={(e) =>
                      set({
                        selfInvoiceDays: Math.min(
                          90,
                          Math.max(1, Math.trunc(Number(e.target.value) || 1)),
                        ),
                      })
                    }
                  />
                </Field>
              )}
            </fieldset>
            <label className="option">
              <input
                type="checkbox"
                checked={form.portalReissueGlobal}
                onChange={(e) => set({ portalReissueGlobal: e.target.checked })}
              />
              {t.cfdiPortalReissueToggle}
            </label>
            <p className="muted tiny">{t.cfdiPortalReissue}</p>
            <SelfInvoicePendingStatus
              pending={settings.selfInvoicePending}
              locale={locale}
            />
            {form.selfInvoiceEnabled &&
              selfInvoiceShortens(
                {
                  selfInvoicePolicy: settings.selfInvoicePolicy,
                  selfInvoiceDays: settings.selfInvoiceDays,
                  portalReissueGlobal: settings.portalReissueGlobal,
                },
                form,
              ) && (
                <p className="cfdi-warning" role="note">
                  {t.cfdiSelfInvoiceShortenHint}
                </p>
              )}
            {form.selfInvoiceEnabled && !form.portalReissueGlobal && (
              <SelfInvoiceBound
                periodicity={periodicityOn(data.businessDate, settings)}
                next={settings.resicoMonthly ? "month" : form.globalPeriodicity}
                graceMinutes={data.globalGraceMinutes}
                locale={locale}
              />
            )}
            <Field label={t.cfdiSupportEmail}>
              <input
                type="email"
                value={form.supportEmail ?? ""}
                maxLength={254}
                autoComplete="off"
                onChange={(e) => set({ supportEmail: e.target.value || null })}
              />
            </Field>
            {owner && (
              <Button variant="primary" type="submit">
                {t.cfdiSaveSettings}
              </Button>
            )}
          </fieldset>
          {saved && (
            <p role="status">
              {t.cfdiSaved}
              {savedNote && `. ${savedNote}`}
            </p>
          )}
        </form>
      )}

      {settings && settings.mode === "live" && settings.liveFrom && (
        <p className="cfdi-block">
          <strong>
            {tr(locale, "cfdiLiveSince", {
              date: dateLabel(settings.liveFrom, locale),
            })}
          </strong>
        </p>
      )}
      {settings && settings.mode === "test" && org?.source === "own" && (
        <div className="cfdi-block">
          <h3>{t.cfdiLiveTitle}</h3>
          <ul className="cfdi-checklist">
            <Check ok={pre.fiscalComplete}>{t.cfdiLiveFiscal}</Check>
            <Check ok={csdLive}>{t.cfdiLiveCsd}</Check>
            <Check ok={org.productionReady}>
              {t.cfdiLiveReady}
              {org.pendingSteps.length > 0 && (
                <ul>
                  {org.pendingSteps.map((step, i) => (
                    <li key={`${step.type}-${i}`}>
                      {step.description}
                      {/manifiesto/i.test(
                        `${step.type} ${step.description}`,
                      ) && (
                        <>
                          {" "}
                          <a
                            href={MANIFEST_URL}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {t.cfdiLiveManifest}
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Check>
            <Check ok={data.live.platformEnabled}>
              {data.live.platformEnabled
                ? t.cfdiLivePlatform
                : t.cfdiLivePlatformMissing}
            </Check>
          </ul>
          {settings.liveRequested ? (
            <p role="status">
              {stillWorking ? t.cfdiStillWorking : t.cfdiGoingLive}
            </p>
          ) : (
            owner && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void post(
                    "/cfdi/live",
                    {
                      operationId: liveOperation,
                      expectedVersion: settings.version,
                      liveFrom,
                    },
                    () => setLiveOperation(crypto.randomUUID()),
                  );
                }}
              >
                <fieldset disabled={busy || !data.live.canRequest}>
                  <Field label={t.cfdiLiveFrom}>
                    <input
                      type="date"
                      required
                      value={liveFrom}
                      min={data.live.minFrom}
                      max={data.live.maxFrom}
                      onChange={(e) => {
                        setLiveFrom(e.target.value);
                        setLiveOperation(crypto.randomUUID());
                      }}
                    />
                  </Field>
                  <p>
                    <strong>{t.cfdiLiveWarning}</strong>
                  </p>
                  <Button variant="danger" type="submit">
                    {t.cfdiGoLive}
                  </Button>
                </fieldset>
              </form>
            )
          )}
          {data.live.failure && !settings.liveRequested && (
            <p className="error">
              {tr(locale, "cfdiLiveFailed", {
                reason: translateError(data.live.failure, locale),
              })}
            </p>
          )}
        </div>
      )}

      {settings &&
        (a.overdueGlobals > 0 ||
          a.failedDocuments > 0 ||
          a.stuckDocuments > 0 ||
          a.rejectedSubstitutions > 0 ||
          a.csdExpiresSoon) && (
          <ul className="cfdi-attention" aria-label={t.cfdiBadgeAttention}>
            {a.overdueGlobals > 0 && (
              <li>
                {tr(locale, "cfdiAttentionOverdue", { n: a.overdueGlobals })}
              </li>
            )}
            {a.failedDocuments + a.stuckDocuments > 0 && (
              <li>
                {tr(locale, "cfdiAttentionDocuments", {
                  n: a.failedDocuments + a.stuckDocuments,
                })}
              </li>
            )}
            {a.rejectedSubstitutions > 0 && (
              <li>
                {tr(locale, "cfdiAttentionSubstitutions", {
                  n: a.rejectedSubstitutions,
                })}
              </li>
            )}
            {a.csdExpiresSoon && <li>{t.cfdiAttentionCsd}</li>}
          </ul>
        )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {settings && (
        <>
          <LazyDetails summary={t.cfdiDocumentsTitle}>
            <CfdiDocuments session={session} locale={locale} />
          </LazyDetails>
          <LazyDetails summary={t.cfdiGlobalsTitle}>
            <GlobalPeriods session={session} locale={locale} />
          </LazyDetails>
        </>
      )}
    </section>
  );
}
