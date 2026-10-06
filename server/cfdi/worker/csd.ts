/**
 * cfdi_csd (spec §4.8.2): opens a sealed CSD upload box, sends it to Facturapi
 * (PUT /organizations/{id}/certificate) and WIPES the box on every terminal outcome (DB test 14).
 * The files and password live only in this handler's locals.
 */
import type { JobContext, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { lastAttempt, retryOrExhaust } from "../jobs.js";
import { fiscalFacts, loadOrganization } from "../store.js";
import { openUploadBox } from "../vault.js";
import { classify, event, MINUTE, runtimeOr } from "./common.js";
import { userKey } from "./runtime.js";

async function terminal(
  tx: Tx,
  ctx: JobContext,
  upload: { id: string; secretId: string },
  outcome:
    | { accepted: true }
    | { accepted: false; code: string; previous: "valid" | null },
) {
  await tx`
    update cfdi_secrets set payload_secret = null, wiped_at = now()
    where id = ${upload.secretId} and wiped_at is null`;
  if (outcome.accepted)
    await tx`
      update cfdi_csd_uploads set status = 'accepted', processed_at = now()
      where id = ${upload.id} and status in ('queued','processing')`;
  else {
    await tx`
      update cfdi_csd_uploads set status = 'rejected', error_code = ${outcome.code}, processed_at = now()
      where id = ${upload.id} and status in ('queued','processing')`;
    if (outcome.previous)
      await tx`
        update cfdi_organizations set csd_status = ${outcome.previous}
        where csd_status = 'processing'`;
    else
      await tx`
        update cfdi_organizations set csd_status = 'error', error_code = ${outcome.code}
        where csd_status = 'processing'`;
  }
  await event(
    tx,
    ctx,
    null,
    outcome.accepted ? "csd_accepted" : "csd_rejected",
    {
      uploadId: upload.id,
      ...(outcome.accepted ? {} : { code: outcome.code }),
    },
  );
}

export async function csdJob(ctx: JobContext): Promise<JobOutcome> {
  const uploadId = (ctx.job.payload as { uploadId?: string } | null)?.uploadId;
  if (!uploadId) return { status: "dead", code: "cfdi_invalid_payload" };
  const { rt, outcome } = await runtimeOr(ctx);
  if (!rt) return outcome;
  const loaded = await ctx.tenant(async (tx) => {
    const [u] = await tx`
      select u.id, u.secret_id, u.status, u.cert_rfc, s.payload_secret
      from cfdi_csd_uploads u join cfdi_secrets s on s.tenant_id = u.tenant_id and s.id = u.secret_id
      where u.id = ${uploadId}`;
    if (!u || !["queued", "processing"].includes(u.status)) return null;
    const org = await loadOrganization(tx);
    const facts = await fiscalFacts(tx);
    // A CSD that was valid before this upload stays in force if the new one is refused.
    const previous =
      org?.csdSerial &&
      org.csdValidUntil &&
      Date.parse(org.csdValidUntil) > Date.now()
        ? ("valid" as const)
        : null;
    if (org && org.source === "own" && org.providerOrgId) {
      await tx`update cfdi_csd_uploads set status = 'processing' where id = ${uploadId} and status = 'queued'`;
      await tx`update cfdi_organizations set csd_status = 'processing' where csd_status <> 'processing'`;
    }
    return {
      upload: { id: u.id as string, secretId: u.secret_id as string },
      box: u.payload_secret as string | null,
      org,
      rfc: facts.rfc,
      previous,
    };
  });
  if (!loaded) return { status: "done" };
  const { upload, org, previous } = loaded;
  const reject = (code: string) =>
    ctx
      .tenant((tx) =>
        terminal(tx, ctx, upload, { accepted: false, code, previous }),
      )
      .then((): JobOutcome => ({ status: "done" }));
  if (!loaded.box) return reject("cfdi_csd_invalid");
  if (!org || org.source !== "own") return reject("cfdi_csd_not_supported");
  if (!org.providerOrgId)
    return retryOrExhaust(ctx.job, {
      code: "cfdi_org_not_ready",
      afterMs: MINUTE,
    });
  if (!rt.ring) return reject("cfdi_unavailable");

  try {
    const files = await openUploadBox(rt.ring, loaded.box, {
      tenantId: ctx.job.tenantId,
      id: upload.secretId,
    });
    const result = await rt.client.uploadCertificate(
      userKey(rt),
      org.providerOrgId,
      files,
    );
    files.password = "";
    const cert = result.certificate;
    const until = cert?.expires_at ? new Date(cert.expires_at) : null;
    const taxId = result.legal?.tax_id ?? null;
    await ctx.tenant(async (tx) => {
      await terminal(tx, ctx, upload, { accepted: true });
      await tx`
        update cfdi_organizations set
          csd_status = ${until && until.getTime() <= Date.now() ? "expired" : "valid"},
          csd_serial = coalesce(${cert?.serial_number ?? null}, csd_serial),
          csd_valid_until = coalesce(${until}, csd_valid_until),
          legal_tax_id = coalesce(${taxId}, legal_tax_id),
          production_ready = ${result.is_production_ready},
          pending_steps = ${tx.json(result.pending_steps.slice(0, 20).map((s) => ({ type: String(s.type).slice(0, 60), description: String(s.description ?? "").slice(0, 500) })) as never)},
          error_code = case when status = 'error' then error_code else null end,
          checked_at = now()`;
      // The CSD RFC must be the restaurant's (cfdi_csd_rfc_mismatch until a new CSD is uploaded).
      if (
        taxId &&
        loaded.rfc &&
        taxId.toUpperCase() !== loaded.rfc.toUpperCase()
      ) {
        await tx`update cfdi_organizations set csd_status = 'error', error_code = 'cfdi_csd_rfc_mismatch'`;
        await event(tx, ctx, null, "csd_rfc_mismatch", { uploadId });
      }
    });
    return { status: "done" };
  } catch (e) {
    const failure = classify(e);
    if (!failure.retry && !failure.unknownOutcome) return reject(failure.code);
    if (lastAttempt(ctx.job)) return reject("cfdi_provider_unavailable");
    return retryOrExhaust(ctx.job, {
      code: failure.code,
      afterMs: failure.afterMs,
    });
  }
}
