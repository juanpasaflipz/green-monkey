import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Locale } from "../../shared/domain";
import { Button, Field } from "../components/ui";
import { strings, translateError, type Key } from "../i18n";
import type { AccountConfig } from "./accountConfig";
import { LegalAcceptance, type LegalAccepted } from "./LegalAcceptance";
import {
  ENTITY_UPDATED_CHANGE,
  LEGAL_DOCUMENTS,
  type LegalDocumentKey,
} from "../../shared/legal";
import {
  REGIMEN_FISCAL,
  USE_LABELS,
  regimeAllowedFor,
  rfcKind,
  usoCfdiAllowed,
} from "../../shared/sat";
import "./account.css";

type TaxProfile = {
  rfc: string;
  legalName: string;
  taxRegime: string;
  postalCode: string;
  cfdiUse: string;
  invoiceEmail: string | null;
  version: number;
};
type Organization = {
  id: string;
  name: string;
  role: "primary" | "co_owner";
  primary: { name: string | null; email: string | null; isMe: boolean };
  coOwners: Array<{
    accountId: string;
    name: string;
    email: string;
    addedAt: string;
  }>;
  coOwnerLimit: number;
  pendingCoOwnerInvitations: Array<{
    id: string;
    email: string;
    expiresAt: string;
  }>;
  dpa: { version: string | null; acceptedAt: string | null; pending: boolean };
  transfer: {
    id: string;
    initiatedBy: string;
    toEmailMasked: string;
    availableAt: string;
    expiresAt: string;
    previousOwnerStays: boolean;
  } | null;
  supportActions: Array<{ action: string; ticket: string; createdAt: string }>;
  events: Array<{
    kind: string;
    actorName: string | null;
    subjectName: string | null;
    createdAt: string;
  }>;
  taxProfile: TaxProfile | null | "disabled";
};
type LegalNotice = {
  document: LegalDocumentKey;
  kind: "announced" | "updated" | "entity_updated";
  version: string;
  effectiveFrom: string;
};
type Overview = {
  account: { id: string; email: string; name: string };
  legal: {
    status: string;
    pending: Array<"terms" | "privacy">;
    dpaPending: string[];
    notices: LegalNotice[];
    dpaNoticeOrganizations: string[];
    accepted: Partial<Record<"terms" | "privacy", { version: string }>>;
    billingConsent: boolean;
  };
  memberships: number;
  freshSession: boolean;
  organizations: Organization[];
  incomingTransfers: Array<{
    id: string;
    organizationName: string;
    locations: number;
    fromName: string | null;
    initiatedBy: string;
    availableAt: string;
    expiresAt: string;
  }>;
  recoveryCodes: { remaining: number; generatedAt: string | null };
};
type Preview = {
  id: string;
  organizationName: string;
  locations: number;
  fromName: string | null;
  previousOwnerStays: boolean;
  initiatedBy: string;
  availableAt: string;
  expiresAt: string;
  hasSubscription: boolean;
  emailMatches: boolean;
  onHold: boolean;
  needsLegal: Array<"terms" | "privacy">;
};
class CenterError extends Error {}

/**
 * The account console (account 031, GAP-5): legal re-acceptance, owners and
 * co-owners, ownership transfer (outgoing and incoming), recovery codes and
 * redemption, support actions, account activity and the optional SaaS billing
 * profile. Never rendered on shared terminals (OwnerAccess returns early), and
 * the server refuses every command from one anyway (device_is_terminal).
 */
export function AccountCenter({
  locale,
  csrf,
  config,
  refresh,
  reloadConfig,
  transferToken,
  clearTransferToken,
}: {
  locale: Locale;
  csrf: string;
  config: AccountConfig | null;
  refresh: () => Promise<void>;
  /** Reads /api/account-config past every cache (changed documents, UX-10). */
  reloadConfig: () => Promise<void>;
  transferToken: string;
  clearTransferToken: () => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const tag = locale === "es" ? "es-MX" : "en-US";
  const date = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(tag, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(iso))
      : "";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [notice, setNotice] = useState("");
  // One acceptance per panel (ACC-13): the re-acceptance boxes never enable
  // a transfer, and each incoming transfer keeps its own boxes.
  const [reaccepted, setReaccepted] = useState<LegalAccepted | null>(null);
  const [previewAccepted, setPreviewAccepted] = useState<LegalAccepted | null>(
    null,
  );
  const [incomingAccepted, setIncomingAccepted] = useState<
    Record<string, LegalAccepted | null>
  >({});
  const [codes, setCodes] = useState<string[] | null>(null);
  const [link, setLink] = useState<{
    kind: "invite" | "transfer";
    path: string;
    expiresAt: string;
  } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirming, setConfirming] = useState("");
  const [inviteOp, setInviteOp] = useState(() => crypto.randomUUID());
  const [transferOp, setTransferOp] = useState(() => crypto.randomUUID());
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});
  const [noticeAccepted, setNoticeAccepted] = useState<LegalAccepted | null>(
    null,
  );
  // Errors and the sign-in prompt render at the top of the console: move the
  // focus there (and so into view) when a command fails (UX-2).
  const messages = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error || reauth) messages.current?.focus();
  }, [error, reauth]);
  async function load() {
    try {
      const response = await fetch("/api/auth/account-center", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new CenterError(String(response.status));
      setOverview(await response.json());
    } catch {
      setError(translateError("network_unavailable", locale));
    }
  }
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch("/api/auth/account-center/" + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new CenterError(data.error ?? "server_unavailable");
    return data as T;
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    setReauth(false);
    try {
      await fn();
      await load();
      await refresh();
    } catch (e) {
      const code = (e as Error).message;
      if (code === "reauthentication_required") setReauth(true);
      else setError(translateError(code, locale));
      if (code === "transfer_unavailable") {
        clearTransferToken();
        setPreview(null);
      }
      // The documents changed since this page loaded: read the served
      // versions again so the boxes ask for them (UX-10).
      if (code === "legal_version_mismatch") {
        setReaccepted(null);
        setPreviewAccepted(null);
        setIncomingAccepted({});
        setNoticeAccepted(null);
        await reloadConfig();
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!transferToken) return;
    post<Preview>("transfers/preview", { token: transferToken })
      .then(setPreview)
      .catch((e) => {
        setError(translateError((e as Error).message, locale));
        clearTransferToken();
      });
  }, [transferToken]);
  if (!overview)
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : (
      <p role="status">{t("accountLoading")}</p>
    );
  const published = overview.legal.status === "published";
  // Anyone who already belongs somewhere (an owner, a co-owner, a Google
  // member such as an invited manager: LEGAL-4) or accepted before re-accepts
  // here. A brand-new account accepts with its first command instead
  // (signup, invitation or transfer each carry the boxes), so this panel
  // never doubles the signup form's checkboxes.
  const member =
    overview.organizations.length > 0 ||
    overview.memberships > 0 ||
    Object.keys(overview.legal.accepted ?? {}).length > 0;
  const legalPending =
    published &&
    member &&
    (overview.legal.pending.length > 0 || overview.legal.dpaPending.length > 0);
  // Announced material changes, newer minor versions and new responsable data
  // (LEGAL-3): shown, never gating; accepting records the new versions.
  const notices = legalPending ? [] : (overview.legal.notices ?? []);
  const announced = notices
    .filter((n) => n.kind === "announced")
    .map((n) => n.effectiveFrom)
    .sort()[0];
  // The express billing consent (UX-3) a primary never recorded is asked
  // with the next acceptance.
  const consentDue =
    published &&
    !overview.legal.billingConsent &&
    overview.organizations.some((o) => o.role === "primary");
  const fresh = overview.freshSession;
  const reauthAhead = !fresh && (
    <div className="reauth-ahead" role="note">
      <p>{t("accountReauthAhead")}</p>
      <a className="button" href="/api/auth/google/start">
        {t("accountReauthButton")}
      </a>
    </div>
  );
  const day = (d: string) =>
    new Intl.DateTimeFormat(tag, { dateStyle: "long" }).format(
      new Date(`${d}T12:00:00-06:00`),
    );
  const form = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return new FormData(e.currentTarget);
  };
  const documentTitle: Record<LegalDocumentKey, Key> = {
    terms: "accountLegalTerms",
    privacy: "accountLegalPrivacy",
    dpa: "accountLegalDpa",
  };
  // Documents the re-acceptance panel asks for, each with its change list.
  const pendingDocuments: LegalDocumentKey[] = [
    ...overview.legal.pending,
    ...(overview.legal.dpaPending.length ? (["dpa"] as const) : []),
  ];
  // A transfer contracts for the organization: terms, privacy and its DPA.
  const transferReady = (accepted: LegalAccepted | null | undefined) =>
    Boolean(
      accepted?.terms &&
      accepted.privacy &&
      accepted.dpa &&
      (accepted.billingConsent || !published),
    );
  // New versions remount the boxes unchecked (UX-10).
  const versionsKey = (c: AccountConfig) =>
    [
      c.legal.documents.terms.version,
      c.legal.documents.privacy.version,
      c.legal.documents.dpa.version,
    ].join(":");
  // The checkboxes need the published versions; without them (offline or a
  // failed load) say so and offer a retry instead of a dead button.
  const legalUnavailable = (
    <div role="alert" className="row">
      <span>{t("accountLegalUnavailable")}</span>
      <Button disabled={busy} onClick={() => void refresh()}>
        {t("retry")}
      </Button>
    </div>
  );
  const noOrganization = overview.organizations.length === 0;
  const recovery = (
    <>
      <div className="panel recovery">
        <h3>{t("accountRecoveryTitle")}</h3>
        <p className="muted">{t("accountRecoveryHint")}</p>
        <p>
          {overview.recoveryCodes.generatedAt
            ? t("accountRecoveryRemaining")
                .replace("{n}", String(overview.recoveryCodes.remaining))
                .replace("{date}", date(overview.recoveryCodes.generatedAt))
            : t("accountRecoveryNone")}
        </p>
        {codes && (
          <div className="recovery-codes">
            <p role="alert">{t("accountRecoveryShownOnce")}</p>
            <ol aria-label={t("accountRecoveryTitle")}>
              {codes.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ol>
            <div className="row">
              <Button
                onClick={() =>
                  void navigator.clipboard?.writeText(codes.join("\n"))
                }
              >
                {t("accountRecoveryCopyAll")}
              </Button>
              <Button onClick={() => window.print()}>
                {t("accountRecoveryPrint")}
              </Button>
            </div>
          </div>
        )}
        {reauthAhead}
        {confirming === "regenerate" ? (
          <div className="row">
            <span>
              {t("accountRecoveryRegenerateConfirm").replace(
                "{n}",
                String(overview.recoveryCodes.remaining),
              )}
            </span>
            <Button
              variant="danger"
              disabled={busy || !fresh}
              onClick={() =>
                void run(async () => {
                  const result = await post<{ codes: string[] }>(
                    "recovery-codes",
                    {},
                  );
                  setCodes(result.codes);
                  setConfirming("");
                })
              }
            >
              {t("accountConfirm")}
            </Button>
            <Button onClick={() => setConfirming("")}>
              {t("accountCancel")}
            </Button>
          </div>
        ) : (
          <Button
            disabled={busy || !fresh}
            onClick={() =>
              // Printed codes still unused are voided: ask first (UX-14).
              overview.recoveryCodes.remaining > 0
                ? setConfirming("regenerate")
                : void run(async () => {
                    const result = await post<{ codes: string[] }>(
                      "recovery-codes",
                      {},
                    );
                    setCodes(result.codes);
                  })
            }
          >
            {t("accountRecoveryGenerate")}
          </Button>
        )}
      </div>
      {!overview.organizations.some((o) => o.role === "primary") && (
        <form
          className="panel account-form"
          onSubmit={(e) => {
            const f = form(e);
            void run(async () => {
              const result = await post<{ availableAt: string }>(
                "recovery/redeem",
                {
                  code: String(f.get("code") ?? "").trim(),
                },
              );
              setNotice(
                t("accountRecoveryScheduled").replace(
                  "{date}",
                  date(result.availableAt),
                ),
              );
            });
          }}
        >
          <h3>{t("accountRecoveryRedeemTitle")}</h3>
          <Field label={t("accountRecoveryRedeemLabel")}>
            <input
              name="code"
              required
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              pattern="[0-9A-Za-z]{4}(-[0-9A-Za-z]{4}){5}"
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {t("accountRecoveryRedeem")}
          </Button>
          <p className="muted">{t("accountRecoverySupport")}</p>
        </form>
      )}
    </>
  );
  return (
    <section className="account-center" aria-labelledby="account-center-title">
      <h2 id="account-center-title">{t("accountConsoleTitle")}</h2>
      <div ref={messages} tabIndex={-1} className="account-messages">
        {reauth && (
          <div role="alert" className="panel warning-panel">
            <p>{t("accountReauth")}</p>
            <a className="button" href="/api/auth/google/start">
              {t("accountReauthButton")}
            </a>
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
      {legalPending && (
        <div className="panel warning-panel">
          <h3>{t("accountLegalUpdatedTitle")}</h3>
          <p>{t("accountLegalUpdatedBody")}</p>
          {pendingDocuments.map((d) => (
            <div className="legal-changes" key={d}>
              <h4>
                {t(documentTitle[d])} · {LEGAL_DOCUMENTS[d].version}
              </h4>
              <p className="muted">{t("accountLegalChanges")}</p>
              <ul>
                {LEGAL_DOCUMENTS[d].changes[locale].map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
          {config ? (
            <LegalAcceptance
              key={versionsKey(config)}
              mode="reacceptance"
              dpa={overview.legal.dpaPending.length > 0}
              billingConsent={consentDue}
              config={config}
              locale={locale}
              onChange={setReaccepted}
            />
          ) : (
            legalUnavailable
          )}
          <Button
            variant="primary"
            disabled={busy || !config || !reaccepted}
            onClick={() =>
              void run(async () => {
                await post("legal/accept", {
                  locale,
                  ...(overview.legal.pending.includes("terms")
                    ? { terms: reaccepted!.terms }
                    : {}),
                  ...(overview.legal.pending.includes("privacy")
                    ? { privacy: reaccepted!.privacy }
                    : {}),
                  ...(overview.legal.dpaPending.length
                    ? {
                        dpa: overview.legal.dpaPending.map(
                          (organizationId) => ({
                            organizationId,
                            version: config!.legal.documents.dpa.version,
                          }),
                        ),
                      }
                    : {}),
                  ...(reaccepted!.billingConsent
                    ? { billingConsent: reaccepted!.billingConsent }
                    : {}),
                });
                setReaccepted(null);
              })
            }
          >
            {t("accountLegalAccept")}
          </Button>
        </div>
      )}
      {published && member && notices.length > 0 && (
        <div
          className="panel"
          role="region"
          aria-label={
            announced
              ? t("accountLegalAnnouncedTitle")
              : t("accountLegalNoticeTitle")
          }
        >
          <h3>
            {announced
              ? t("accountLegalAnnouncedTitle")
              : t("accountLegalNoticeTitle")}
          </h3>
          <p>
            {announced
              ? t("accountLegalAnnouncedBody").replace("{date}", day(announced))
              : t("accountLegalNoticeBody")}
          </p>
          {notices.map((n) => (
            <div className="legal-changes" key={n.document}>
              <h4>
                <a
                  href={
                    locale === "es"
                      ? LEGAL_DOCUMENTS[n.document].path
                      : LEGAL_DOCUMENTS[n.document].enPath
                  }
                  target="_blank"
                  rel="noopener"
                >
                  {t(documentTitle[n.document])}
                </a>{" "}
                · {n.version}
              </h4>
              <p className="muted">
                {n.kind === "announced"
                  ? t("accountLegalEffectiveFuture").replace(
                      "{date}",
                      day(n.effectiveFrom),
                    )
                  : t("accountLegalChanges")}
              </p>
              <ul>
                {(n.kind === "entity_updated"
                  ? [ENTITY_UPDATED_CHANGE[locale]]
                  : LEGAL_DOCUMENTS[n.document].changes[locale]
                ).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
          {config ? (
            <LegalAcceptance
              key={versionsKey(config)}
              mode="reacceptance"
              dpa={overview.legal.dpaNoticeOrganizations.length > 0}
              billingConsent={consentDue}
              config={config}
              locale={locale}
              onChange={setNoticeAccepted}
            />
          ) : (
            legalUnavailable
          )}
          <Button
            disabled={busy || !config || !noticeAccepted}
            onClick={() =>
              void run(async () => {
                const has = (d: LegalDocumentKey) =>
                  notices.some((n) => n.document === d);
                await post("legal/accept", {
                  locale,
                  ...(has("terms") ? { terms: noticeAccepted!.terms } : {}),
                  ...(has("privacy")
                    ? { privacy: noticeAccepted!.privacy }
                    : {}),
                  ...(overview.legal.dpaNoticeOrganizations.length
                    ? {
                        dpa: overview.legal.dpaNoticeOrganizations.map(
                          (organizationId) => ({
                            organizationId,
                            version: config!.legal.documents.dpa.version,
                          }),
                        ),
                      }
                    : {}),
                  ...(noticeAccepted!.billingConsent
                    ? { billingConsent: noticeAccepted!.billingConsent }
                    : {}),
                });
                setNoticeAccepted(null);
              })
            }
          >
            {t("accountLegalAcceptOptional")}
          </Button>
        </div>
      )}
      {preview && (
        <div
          className="panel"
          role="region"
          aria-label={t("accountTransferTitle")}
        >
          <h3>{t("accountTransferTitle")}</h3>
          <p>
            {t("accountTransferIncoming")
              .replace("{org}", preview.organizationName)
              .replace("{n}", String(preview.locations))}
          </p>
          {preview.fromName && (
            <p>
              {t("accountTransferFrom").replace("{name}", preview.fromName)}
            </p>
          )}
          {preview.previousOwnerStays && (
            <p>{t("accountTransferPreviousStays")}</p>
          )}
          {preview.hasSubscription && (
            <p>{t("accountTransferIncludesBilling")}</p>
          )}
          {!preview.emailMatches && (
            <p role="alert">{t("accountTransferEmailMismatch")}</p>
          )}
          {preview.onHold ? (
            <p role="status">
              {t("accountTransferOnHold").replace(
                "{date}",
                date(preview.availableAt),
              )}
            </p>
          ) : config ? (
            <LegalAcceptance
              mode="transfer"
              config={config}
              locale={locale}
              organizationName={preview.organizationName}
              onChange={setPreviewAccepted}
            />
          ) : (
            legalUnavailable
          )}
          {!preview.onHold && reauthAhead}
          <div className="row">
            <Button
              variant="primary"
              disabled={
                busy ||
                !fresh ||
                preview.onHold ||
                !preview.emailMatches ||
                !transferReady(previewAccepted)
              }
              onClick={() =>
                void run(async () => {
                  await post("transfers/accept", {
                    token: transferToken,
                    legalAccepted: previewAccepted,
                    locale,
                  });
                  clearTransferToken();
                  setPreview(null);
                  setNotice(t("accountTransferDone"));
                })
              }
            >
              {t("accountTransferAccept")}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await post("transfers/cancel", { token: transferToken });
                  clearTransferToken();
                  setPreview(null);
                })
              }
            >
              {t("accountTransferDecline")}
            </Button>
          </div>
        </div>
      )}
      {overview.incomingTransfers.map((incoming) => {
        const held = new Date(incoming.availableAt).getTime() > Date.now();
        return (
          <div className="panel" key={incoming.id}>
            <h3>{t("accountTransferTitle")}</h3>
            <p>
              {(incoming.initiatedBy === "recovery_code"
                ? t("accountTransferIncomingRecovery")
                : t("accountTransferIncoming")
              )
                .replace("{org}", incoming.organizationName)
                .replace("{n}", String(incoming.locations))}
            </p>
            {incoming.fromName && incoming.initiatedBy !== "recovery_code" && (
              <p>
                {t("accountTransferFrom").replace("{name}", incoming.fromName)}
              </p>
            )}
            {held ? (
              <p role="status">
                {t("accountTransferOnHold").replace(
                  "{date}",
                  date(incoming.availableAt),
                )}
              </p>
            ) : config ? (
              <LegalAcceptance
                mode="transfer"
                config={config}
                locale={locale}
                organizationName={incoming.organizationName}
                onChange={(accepted) =>
                  setIncomingAccepted((all) => ({
                    ...all,
                    [incoming.id]: accepted,
                  }))
                }
              />
            ) : (
              legalUnavailable
            )}
            {!held && reauthAhead}
            <div className="row">
              <Button
                variant="primary"
                disabled={
                  busy ||
                  held ||
                  !fresh ||
                  !transferReady(incomingAccepted[incoming.id])
                }
                onClick={() =>
                  void run(async () => {
                    await post("transfers/accept", {
                      transferId: incoming.id,
                      legalAccepted: incomingAccepted[incoming.id],
                      locale,
                    });
                    setNotice(t("accountTransferDone"));
                  })
                }
              >
                {t("accountTransferAccept")}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    post("transfers/cancel", { transferId: incoming.id }).then(
                      () => undefined,
                    ),
                  )
                }
              >
                {t("accountTransferDecline")}
              </Button>
            </div>
          </div>
        );
      })}
      {overview.organizations.map((org) => {
        const primary = org.role === "primary";
        const full = org.coOwners.length >= org.coOwnerLimit;
        return (
          <div
            className="panel"
            key={org.id}
            role="group"
            aria-label={org.name}
          >
            <h3>
              {t("accountOwnersTitle")} · {org.name}
            </h3>
            {org.transfer && primary && (
              <div role="alert" className="warning-panel">
                <p>
                  {(org.transfer.initiatedBy === "support"
                    ? t("accountTransferSupportInitiated")
                    : org.transfer.initiatedBy === "recovery_code"
                      ? t("accountTransferRecoveryInitiated")
                      : t("accountTransferPendingOut")
                  )
                    .replace("{email}", org.transfer.toEmailMasked)
                    .replace(
                      "{date}",
                      date(
                        org.transfer.initiatedBy === "owner"
                          ? org.transfer.expiresAt
                          : org.transfer.availableAt,
                      ),
                    )}
                </p>
                {org.transfer.initiatedBy === "owner" && (
                  <p>
                    {org.transfer.previousOwnerStays
                      ? t("accountTransferPendingStays")
                      : t("accountTransferPendingLeaves")}
                  </p>
                )}
                {org.transfer.initiatedBy === "owner" && !link && (
                  <p className="muted">{t("accountTransferLinkLost")}</p>
                )}
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      post("transfers/cancel", {
                        transferId: org.transfer!.id,
                      }).then(() => setLink(null)),
                    )
                  }
                >
                  {t("accountTransferCancel")}
                </Button>
              </div>
            )}
            <ul className="owners">
              <li>
                <strong>{t("accountPrimaryOwner")}</strong>:{" "}
                {org.primary.name ?? "—"}
                {org.primary.email ? ` <${org.primary.email}>` : ""}
                {org.primary.isMe ? ` (${t("accountYou")})` : ""}
              </li>
              {org.coOwners.length === 0 && (
                <li className="muted">{t("accountCoOwnerNone")}</li>
              )}
              {org.coOwners.map((c) => (
                <li key={c.accountId}>
                  <strong>{t("accountCoOwner")}</strong>: {c.name} &lt;{c.email}
                  &gt; ·{" "}
                  {t("accountCoOwnerSince").replace("{date}", date(c.addedAt))}
                  {c.accountId === overview.account.id &&
                    ` (${t("accountYou")})`}
                  {primary &&
                    (confirming === "remove:" + c.accountId ? (
                      <span className="row">
                        <span>{t("accountCoOwnerRemoveConfirm")}</span>
                        {reauthAhead}
                        <Button
                          variant="danger"
                          disabled={busy || !fresh}
                          onClick={() =>
                            void run(() =>
                              post("co-owners/remove", {
                                organizationId: org.id,
                                accountId: c.accountId,
                              }).then(() => setConfirming("")),
                            )
                          }
                        >
                          {t("accountConfirm")}
                        </Button>
                        <Button onClick={() => setConfirming("")}>
                          {t("accountCancel")}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => setConfirming("remove:" + c.accountId)}
                      >
                        {t("accountCoOwnerRemove")}
                      </Button>
                    ))}
                </li>
              ))}
              {org.pendingCoOwnerInvitations.map((i) => (
                <li key={i.id} className="muted">
                  {t("accountCoOwnerPending")
                    .replace("{email}", i.email)
                    .replace("{date}", date(i.expiresAt))}
                </li>
              ))}
            </ul>
            {!primary && (
              <>
                <p className="muted">{t("accountCoOwnerBillingNote")}</p>
                {org.dpa.pending && (
                  <p className="muted">{t("accountLegalDpaPendingPrimary")}</p>
                )}
                {confirming === "leave:" + org.id ? (
                  <div className="row">
                    <span>
                      {t("accountCoOwnerLeaveConfirm").replace(
                        "{org}",
                        org.name,
                      )}
                    </span>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await post("co-owners/leave", {
                            organizationId: org.id,
                          });
                          setConfirming("");
                        })
                      }
                    >
                      {t("accountConfirm")}
                    </Button>
                    <Button onClick={() => setConfirming("")}>
                      {t("accountCancel")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => setConfirming("leave:" + org.id)}
                  >
                    {t("accountCoOwnerLeave")}
                  </Button>
                )}
              </>
            )}
            {primary && (
              <form
                className="account-form"
                onSubmit={(e) => {
                  const f = form(e);
                  void run(async () => {
                    const created = await post<{
                      path: string;
                      expiresAt: string;
                    }>("co-owners/invite", {
                      operationId: inviteOp,
                      organizationId: org.id,
                      email: String(f.get("email") ?? "").trim(),
                    });
                    setLink({
                      kind: "invite",
                      path: location.origin + created.path,
                      expiresAt: created.expiresAt,
                    });
                    setInviteOp(crypto.randomUUID());
                  });
                }}
              >
                <h4>{t("accountCoOwnerInvite")}</h4>
                <p className="muted">
                  {t("accountCoOwnerInviteHint").replace(
                    "{n}",
                    String(org.coOwnerLimit),
                  )}
                </p>
                {!full && reauthAhead}
                <Field label={t("accountCoOwnerEmail")}>
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="off"
                    disabled={full || !fresh}
                  />
                </Field>
                <Button type="submit" disabled={busy || full || !fresh}>
                  {t("accountCoOwnerCreate")}
                </Button>
              </form>
            )}
            {link && (
              <div className="panel">
                <p>
                  {(link.kind === "invite"
                    ? t("accountCoOwnerLink")
                    : t("accountTransferLink")
                  ).replace("{date}", date(link.expiresAt))}
                </p>
                <input
                  readOnly
                  value={link.path}
                  aria-label={
                    link.kind === "invite"
                      ? t("accountCoOwnerInvite")
                      : t("accountTransferTitle")
                  }
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  onClick={() => void navigator.clipboard?.writeText(link.path)}
                >
                  {t("accountHelpCopy")}
                </Button>
              </div>
            )}
            {primary && !org.transfer && (
              <form
                className="account-form"
                onSubmit={(e) => {
                  const f = form(e);
                  void run(async () => {
                    const created = await post<{
                      path: string;
                      expiresAt: string;
                    }>("transfers", {
                      operationId: transferOp,
                      organizationId: org.id,
                      email: String(f.get("email") ?? "").trim(),
                      previousOwnerStays: f.get("stays") === "on",
                      confirmName: String(f.get("confirmName") ?? ""),
                    });
                    setLink({
                      kind: "transfer",
                      path: location.origin + created.path,
                      expiresAt: created.expiresAt,
                    });
                    setTransferOp(crypto.randomUUID());
                  });
                }}
              >
                <h4>{t("accountTransferTitle")}</h4>
                <p className="muted">{t("accountTransferHint")}</p>
                {reauthAhead}
                <Field label={t("accountTransferEmail")}>
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="off"
                    disabled={!fresh}
                  />
                </Field>
                <label className="opening-day">
                  <input
                    type="checkbox"
                    name="stays"
                    checked={!full && !leaving[org.id]}
                    onChange={(e) =>
                      setLeaving((all) => ({
                        ...all,
                        [org.id]: !e.target.checked,
                      }))
                    }
                    disabled={full || !fresh}
                  />
                  {t("accountTransferStay")}
                </label>
                {!full && leaving[org.id] && (
                  <p role="note" className="warning">
                    {t("accountTransferLeaveWarning")}
                  </p>
                )}
                {full && (
                  <p className="muted">
                    {t("accountTransferStayFull").replace(
                      "{n}",
                      String(org.coOwners.length),
                    )}
                  </p>
                )}
                <Field
                  label={t("accountTransferConfirmName").replace(
                    "{name}",
                    org.name,
                  )}
                >
                  <input
                    name="confirmName"
                    required
                    autoComplete="off"
                    disabled={!fresh}
                  />
                </Field>
                <Button
                  type="submit"
                  variant="danger"
                  disabled={busy || !fresh}
                >
                  {t("accountTransferCreate")}
                </Button>
              </form>
            )}
            {org.taxProfile !== "disabled" && (
              <TaxProfileForm
                locale={locale}
                organizationId={org.id}
                profile={org.taxProfile}
                editable={primary}
                busy={busy}
                save={(body) =>
                  run(async () => {
                    await post("tax-profile", body);
                    setNotice(t("accountTaxSaved"));
                  })
                }
              />
            )}
            {org.supportActions.length > 0 && (
              <>
                <h4>{t("accountSupportActions")}</h4>
                <ul className="account-log">
                  {org.supportActions.map((a) => (
                    <li key={a.createdAt + a.ticket}>
                      {date(a.createdAt)} ·{" "}
                      {strings[locale][
                        `accountSupportAction_${a.action}` as Key
                      ] ?? a.action}{" "}
                      ·{" "}
                      {t("accountSupportActionLabel").replace(
                        "{ticket}",
                        a.ticket,
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h4>{t("accountEvents")}</h4>
            {org.events.length === 0 ? (
              <p className="muted">{t("accountEventsNone")}</p>
            ) : (
              <ul className="account-log">
                {org.events.map((e, i) => (
                  <li key={e.createdAt + i}>
                    {date(e.createdAt)} ·{" "}
                    {strings[locale][`accountEvent_${e.kind}` as Key] ?? e.kind}{" "}
                    · {e.actorName ?? t("accountFormerAccount")}
                    {e.subjectName && e.subjectName !== e.actorName
                      ? ` → ${e.subjectName}`
                      : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {/* A new account's first screen is its restaurant form (UX-8): the
          recovery panels wait behind a disclosure until it owns something. */}
      {noOrganization ? (
        <details className="account-recovery-more">
          <summary>{t("accountRecoveryMore")}</summary>
          {recovery}
        </details>
      ) : (
        recovery
      )}
    </section>
  );
}

function TaxProfileForm({
  locale,
  organizationId,
  profile,
  editable,
  busy,
  save,
}: {
  locale: Locale;
  organizationId: string;
  profile: TaxProfile | null;
  editable: boolean;
  busy: boolean;
  save: (body: unknown) => Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const [rfc, setRfc] = useState(profile?.rfc ?? "");
  const [regime, setRegime] = useState(profile?.taxRegime ?? "");
  const [use, setUse] = useState(profile?.cfdiUse ?? "G03");
  const kind = rfcKind(rfc.trim().toUpperCase());
  const regimes = Object.entries(REGIMEN_FISCAL).filter(
    ([code]) => !kind || regimeAllowedFor(code, kind),
  );
  const uses = (
    Object.keys(USE_LABELS) as Array<keyof typeof USE_LABELS>
  ).filter((u) => u !== "G02" && (!regime || usoCfdiAllowed(regime, u)));
  return (
    <form
      className="account-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const email = String(f.get("invoiceEmail") ?? "").trim();
        void save({
          organizationId,
          expectedVersion: profile?.version ?? 0,
          rfc: rfc.trim().toUpperCase(),
          legalName: String(f.get("legalName") ?? "").trim(),
          taxRegime: regime,
          postalCode: String(f.get("postalCode") ?? "").trim(),
          cfdiUse: use,
          invoiceEmail: email || null,
        });
      }}
    >
      <h4>{t("accountTaxProfile")}</h4>
      <p className="muted">{t("accountTaxProfileHint")}</p>
      <fieldset disabled={!editable || busy}>
        <Field label={t("accountTaxRfc")}>
          <input
            value={rfc}
            onChange={(e) => setRfc(e.target.value)}
            maxLength={13}
            required
          />
        </Field>
        <Field label={t("accountTaxLegalName")}>
          <input
            name="legalName"
            defaultValue={profile?.legalName}
            maxLength={254}
            required
          />
        </Field>
        <Field label={t("accountTaxRegime")}>
          <select
            value={regime}
            onChange={(e) => setRegime(e.target.value)}
            required
          >
            <option value="" />
            {regimes.map(([code, r]) => (
              <option key={code} value={code}>
                {code} · {locale === "es" ? r.es : r.en}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("accountTaxPostalCode")}>
          <input
            name="postalCode"
            defaultValue={profile?.postalCode}
            inputMode="numeric"
            pattern="\d{5}"
            required
          />
        </Field>
        <Field label={t("accountTaxUse")}>
          <select value={use} onChange={(e) => setUse(e.target.value)}>
            {uses.map((u) => (
              <option key={u} value={u}>
                {u} · {USE_LABELS[u][locale]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("accountTaxInvoiceEmail")}>
          <input
            name="invoiceEmail"
            type="email"
            defaultValue={profile?.invoiceEmail ?? ""}
          />
        </Field>
        {editable && (
          <Button type="submit" variant="primary">
            {t("accountTaxSave")}
          </Button>
        )}
      </fieldset>
    </form>
  );
}
