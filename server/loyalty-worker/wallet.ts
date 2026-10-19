import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import http2 from "node:http2";
import { signAppleBundle } from "./apple-bundle.js";
import { importPKCS8, SignJWT } from "jose";
import type { Tx } from "../db.js";
import type { JobHandler } from "../jobs.js";
import { entitlement } from "../entitlements.js";
import { engagementSettings } from "../../shared/loyalty-engagement.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (key: string) => Buffer.from(process.env[key] ?? "", "base64");
const appleReady = () =>
  [
    "APPLE_TEAM_ID",
    "APPLE_PASS_TYPE_ID",
    "APPLE_PASS_CERT_BASE64",
    "APPLE_PASS_KEY_BASE64",
    "APPLE_WWDR_CERT_BASE64",
    "LOYALTY_WALLET_SIGNING_SECRET",
  ].every((k) => Boolean(process.env[k])) &&
  (process.env.LOYALTY_WALLET_SIGNING_SECRET?.length ?? 0) >= 32;
export type WalletSnapshot = {
  tenantId: string;
  memberId: string;
  restaurant: string;
  program: string;
  stamps: number;
  required: number;
  rewards: number;
  reward: string;
  scan: string;
  referral: string | null;
  generation: string;
  active: boolean;
};
export function googleObject(s: WalletSnapshot, issuer: string) {
  return {
    id: `${issuer}.${s.tenantId}_${s.memberId}_${s.scan}`,
    classId: `${issuer}.${s.tenantId}_club`,
    state: s.active ? "ACTIVE" : "INACTIVE",
    barcode: { type: "QR_CODE", value: `gm-club:${s.scan}` },
    accountId: s.memberId,
    loyaltyPoints: {
      label: "SELLOS",
      balance: { string: `${Math.max(0, s.stamps)} / ${s.required}` },
    },
    secondaryLoyaltyPoints: { label: "PREMIOS", balance: { int: s.rewards } },
    textModulesData: [
      { id: "reward", header: "RECOMPENSA", body: s.reward },
      ...(s.referral
        ? [{ id: "referral", header: "RECOMIENDA", body: s.referral }]
        : []),
    ],
  };
}
async function googlePass(
  s: WalletSnapshot,
  origin: string,
  signal: AbortSignal,
) {
  const issuer = process.env.GOOGLE_WALLET_ISSUER_ID;
  if (!issuer || !process.env.GOOGLE_WALLET_SA_KEY_BASE64) return null;
  const sa = JSON.parse(bytes("GOOGLE_WALLET_SA_KEY_BASE64").toString("utf8"));
  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/wallet_object.issuer",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal,
  });
  const token = (await tokenRes.json()) as any;
  if (!tokenRes.ok || !token.access_token)
    throw Error("loyalty_wallet_oauth_failed");
  const api = async (method: string, path: string, body?: unknown) =>
    fetch(`https://walletobjects.googleapis.com/walletobjects/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  const object = googleObject(s, issuer),
    classId = object.classId;
  const cls = {
    id: classId,
    issuerName: s.restaurant,
    programName: s.program,
    programLogo: { sourceUri: { uri: `${origin}/brand/icon-192.png` } },
    hexBackgroundColor: "#153E32",
    reviewStatus: "UNDER_REVIEW",
    countryCode: "MX",
  };
  const upsert = async (resource: string, id: string, payload: unknown) => {
    const res = await api(
      "PATCH",
      `${resource}/${encodeURIComponent(id)}`,
      payload,
    );
    if (res.ok) return;
    if (res.status !== 404) throw Error("loyalty_wallet_update_failed");
    const created = await api("POST", resource, payload);
    if (!created.ok && created.status !== 409)
      throw Error("loyalty_wallet_create_failed");
    if (created.status === 409) {
      const patched = await api(
        "PATCH",
        `${resource}/${encodeURIComponent(id)}`,
        payload,
      );
      if (!patched.ok) throw Error("loyalty_wallet_update_failed");
    }
  };
  await upsert("loyaltyClass", classId, cls);
  await upsert("loyaltyObject", object.id, object);
  const jwt = await new SignJWT({
    typ: "savetowallet",
    origins: [origin],
    payload: { loyaltyObjects: [{ id: object.id }] },
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email)
    .setAudience("google")
    .setIssuedAt()
    .sign(key);
  return `https://pay.google.com/gp/v/save/${jwt}`;
}
async function applePass(s: WalletSnapshot, origin: string) {
  if (!appleReady()) return null;
  const auth = createHmac("sha256", process.env.LOYALTY_WALLET_SIGNING_SECRET!)
    .update(`${s.tenantId}:${s.memberId}:${s.generation}`)
    .digest("hex");
  const iconRoot =
    process.env.NODE_ENV === "production"
      ? "dist/brand/wallet"
      : "public/brand/wallet";
  const images = Object.fromEntries(
    await Promise.all(
      ["icon.png", "icon@2x.png", "icon@3x.png"].map(async (f) => [
        f,
        await readFile(`${iconRoot}/${f}`),
      ]),
    ),
  );
  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID,
    teamIdentifier: process.env.APPLE_TEAM_ID,
    organizationName: s.restaurant,
    description: s.program,
    serialNumber: `${s.tenantId}.${s.memberId}`,
    webServiceURL: `${origin}/api/club/wallet/${s.tenantId}/${s.memberId}`,
    authenticationToken: auth,
    backgroundColor: "rgb(21, 62, 50)",
    foregroundColor: "rgb(255, 255, 255)",
    labelColor: "rgb(230, 240, 230)",
    sharingProhibited: true,
    voided: !s.active,
    storeCard: {
      primaryFields: [
        {
          key: "stamps",
          label: "SELLOS",
          value: `${Math.max(0, s.stamps)} / ${s.required}`,
          changeMessage: "Tu tarjeta ahora tiene %@ sellos.",
        },
      ],
      secondaryFields: [{ key: "rewards", label: "PREMIOS", value: s.rewards }],
      backFields: [
        { key: "reward", label: "RECOMPENSA", value: s.reward },
        ...(s.referral
          ? [{ key: "referral", label: "RECOMIENDA", value: s.referral }]
          : []),
      ],
    },
  };
  const files = {
    ...images,
    "pass.json": Buffer.from(
      JSON.stringify({
        ...passJson,
        barcodes: [
          {
            format: "PKBarcodeFormatQR",
            message: `gm-club:${s.scan}`,
            messageEncoding: "iso-8859-1",
          },
        ],
      }),
    ),
  };
  const data = await signAppleBundle(files, {
    wwdr: bytes("APPLE_WWDR_CERT_BASE64"),
    cert: bytes("APPLE_PASS_CERT_BASE64"),
    key: bytes("APPLE_PASS_KEY_BASE64"),
    passphrase: process.env.APPLE_PASS_KEY_PASSPHRASE,
  });
  return {
    data: data.toString("base64"),
    authHash: hash(auth),
    type: process.env.APPLE_PASS_TYPE_ID!,
  };
}
async function push(token: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const client = http2.connect("https://api.push.apple.com", {
      cert: bytes("APPLE_PASS_CERT_BASE64"),
      key: bytes("APPLE_PASS_KEY_BASE64"),
      passphrase: process.env.APPLE_PASS_KEY_PASSPHRASE,
    });
    let finished = false;
    const finish = (status: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      client.destroy();
      resolve(status);
    };
    const abort = () => finish(0),
      timer = setTimeout(abort, 10000);
    signal.addEventListener("abort", abort, { once: true });
    client.on("error", abort);
    if (signal.aborted) {
      abort();
      return;
    }
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      "apns-topic": process.env.APPLE_PASS_TYPE_ID,
      "apns-push-type": "alert",
      "content-type": "application/json",
    });
    let status = 0;
    req.on("response", (h) => {
      status = Number(h[":status"]);
    });
    req.on("data", () => {});
    req.on("end", () => finish(status));
    req.on("error", abort);
    req.end("{}");
  });
}
/** Retire only the token APNs rejected; a concurrent registration may have replaced it. */
export async function retireWalletDevice(tx: Tx, memberId: string, deviceHash: string, pushToken: string) {
  await tx`update loyalty_wallet_devices set push_token='',unregistered_at=clock_timestamp()
    where member_id=${memberId} and device_hash=${deviceHash} and push_token=${pushToken} and unregistered_at is null`;
}

export const walletHandler: JobHandler = async (ctx) => {
  const memberId = (ctx.job.payload as any)?.memberId;
  if (
    typeof memberId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      memberId,
    )
  )
    return { status: "dead", code: "loyalty_payload_invalid" };
  const claimed = await ctx.tenant(async (tx) => {
    const [row] =
      await tx`insert into loyalty_wallet_passes(tenant_id,member_id,generation_hash,sync_job_id,sync_until)
   select ${ctx.job.tenantId},${memberId},'',${ctx.job.id},now()+interval '90 seconds'
   where exists(select 1 from loyalty_member_cards where member_id=${memberId})
   on conflict(tenant_id,member_id) do update set sync_job_id=excluded.sync_job_id,sync_until=excluded.sync_until
   where loyalty_wallet_passes.sync_until is null or loyalty_wallet_passes.sync_until<now()
    or loyalty_wallet_passes.sync_job_id=excluded.sync_job_id returning member_id`;
    return Boolean(row);
  });
  if (!claimed) {
    const [card] = await ctx.tenant(
      (tx) =>
        tx`select 1 from loyalty_member_cards where member_id=${memberId}`,
    );
    return card
      ? { status: "retry", code: "loyalty_wallet_busy", afterMs: 10000 }
      : undefined;
  }
  try {
    const s = await ctx.tenant(async (tx) => {
      const [m] =
        await tx`select m.*,c.scan_token,c.referral_code,c.access_hash,c.revoked_at from loyalty_members m
   join loyalty_member_cards c on c.tenant_id=m.tenant_id and c.member_id=m.id where m.id=${memberId}`;
      if (!m) return null;
      const [p] = await tx`select * from loyalty_settings`,
        [row] = await tx`select settings from loyalty_engagement_settings`,
        [r] =
          await tx`select name from restaurants where id=${ctx.job.tenantId}`;
      const e = engagementSettings.parse(row?.settings ?? {});
      return {
        tenantId: ctx.job.tenantId,
        memberId,
        restaurant: r.name,
        program: p?.program_name || `${r.name} Club`,
        stamps: m.redacted_at ? 0 : m.stamps,
        required: p?.stamps_required ?? 10,
        rewards: m.redacted_at ? 0 : m.rewards,
        reward: p?.reward_description ?? "",
        scan: m.scan_token,
        referral: e.referralsEnabled ? m.referral_code : null,
        generation: m.access_hash,
        active: Boolean(
          !m.redacted_at &&
          !m.revoked_at &&
          p?.enabled &&
          e.walletEnabled &&
          (await entitlement(tx)).plan === "pro",
        ),
      } as WalletSnapshot;
    });
    if (!s) return;
    if (!s.active) {
      const [existing] = await ctx.tenant(
        (tx) =>
          tx`select apple_pass_secret,google_url_secret from loyalty_wallet_passes where member_id=${memberId}`,
      );
      if (!existing?.apple_pass_secret && !existing?.google_url_secret) return;
    }
    const origin = process.env.APP_URL;
    if (!origin || !origin.startsWith("https://"))
      return { status: "blocked", code: "loyalty_wallet_origin_required" };
    if (!appleReady() && !process.env.GOOGLE_WALLET_SA_KEY_BASE64)
      return { status: "blocked", code: "loyalty_wallet_not_configured" };
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
    // Individual providers can fail independently; completed artifacts remain usable.
    const apple = await applePass(s, new URL(origin).origin);
    if (apple)
      await ctx.tenant(async (tx) => {
        await tx`insert into loyalty_wallet_passes(tenant_id,member_id,generation_hash,apple_auth_hash,apple_pass_secret,pass_type)
   values(${s.tenantId},${memberId},${s.generation},${apple.authHash},${apple.data},${apple.type})
   on conflict(tenant_id,member_id) do update set generation_hash=excluded.generation_hash,apple_auth_hash=excluded.apple_auth_hash,
   apple_pass_secret=excluded.apple_pass_secret,pass_type=excluded.pass_type,updated_at=clock_timestamp()`;
      });
    if (apple) {
      const devices = await ctx.tenant(
        (tx) =>
          tx`select device_hash,push_token from loyalty_wallet_devices where member_id=${memberId} and unregistered_at is null`,
      );
      await Promise.all(
        devices.map(async (d) => {
          const status = await push(d.push_token, signal);
          if (status === 410)
            await ctx.tenant(async (tx) => {
              await retireWalletDevice(tx, memberId, d.device_hash, d.push_token);
            });
        }),
      );
    }
    const google = await googlePass(s, new URL(origin).origin, signal);
    if (google)
      await ctx.tenant(async (tx) => {
        await tx`insert into loyalty_wallet_passes(tenant_id,member_id,generation_hash,google_url_secret)
   values(${s.tenantId},${memberId},${s.generation},${google}) on conflict(tenant_id,member_id)
   do update set generation_hash=excluded.generation_hash,google_url_secret=excluded.google_url_secret,updated_at=clock_timestamp()`;
      });
  } finally {
    await ctx.tenant(async (tx) => {
      await tx`update loyalty_wallet_passes set sync_job_id=null,sync_until=null where member_id=${memberId} and sync_job_id=${ctx.job.id}`;
    });
  }
};
