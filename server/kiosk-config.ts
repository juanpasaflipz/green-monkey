// Kiosk and menu-photo switches and the media store configuration (039; specs/kiosk-w4.md
// §2.14, §4.7; critic R36). Pure: the modules read the values at runtime; kioskWebConfig only
// refuses to start with a value they would reject (contract C-9). Names only, never values.
import { ConfigError } from "./config-error.js";

type Env = Record<string, string | undefined>;

function flag(env: Env, name: string, invalid: string): boolean {
  const v = env[name]?.trim();
  if (v === "true" || !v) return true;
  if (v === "false") return false;
  throw Error(invalid);
}

/** KIOSK_SELF_CHECKOUT_ENABLED: unset or "true" on, "false" off (the kiosk falls back to holds). */
export function kioskSelfCheckoutEnabled(env: Env = process.env): boolean {
  return flag(env, "KIOSK_SELF_CHECKOUT_ENABLED", "kiosk_flag_invalid");
}

/** MENU_PHOTOS_ENABLED: unset or "true" on, "false" off (no upload, no photos, media 404). */
export function menuPhotosEnabled(env: Env = process.env): boolean {
  return flag(env, "MENU_PHOTOS_ENABLED", "media_flag_invalid");
}

export type MediaStoreConfig =
  | { driver: "fs"; root: string }
  | {
      driver: "r2";
      accountId: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

/**
 * MEDIA_STORE: unset means no store (photos cannot be uploaded; the menu shows text tiles), so a
 * deployment without the R2 media bucket keeps starting. "fs" needs MEDIA_FS_ROOT (development and
 * CI only); "r2" needs the bucket-scoped, non-expiring token (MEDIA_R2_*).
 */
export function mediaStoreConfig(
  env: Env = process.env,
): MediaStoreConfig | null {
  const driver = env.MEDIA_STORE?.trim();
  if (!driver) return null;
  if (driver === "fs") {
    const root = env.MEDIA_FS_ROOT?.trim();
    if (!root) throw Error("media_store_invalid");
    return { driver, root };
  }
  if (driver === "r2") {
    const accountId = env.MEDIA_R2_ACCOUNT_ID?.trim() ?? "";
    const bucket = env.MEDIA_R2_BUCKET?.trim() ?? "";
    const accessKeyId = env.MEDIA_R2_ACCESS_KEY_ID?.trim() ?? "";
    const secretAccessKey = env.MEDIA_R2_SECRET_ACCESS_KEY?.trim() ?? "";
    if (
      !/^[a-f0-9]{32}$/.test(accountId) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
      !accessKeyId ||
      !secretAccessKey
    )
      throw Error("media_store_invalid");
    return { driver, accountId, bucket, accessKeyId, secretAccessKey };
  }
  throw Error("media_store_invalid");
}

/** Web startup checks (between config-rules.ts' area markers). */
export function kioskWebConfig(env: Env, appEnv: string): void {
  try {
    kioskSelfCheckoutEnabled(env);
  } catch {
    throw new ConfigError("kiosk_flag_invalid");
  }
  let photos: boolean;
  try {
    photos = menuPhotosEnabled(env);
  } catch {
    throw new ConfigError("media_flag_invalid");
  }
  let store: MediaStoreConfig | null;
  try {
    store = mediaStoreConfig(env);
  } catch {
    throw new ConfigError("media_store_invalid");
  }
  // The local filesystem driver never serves a deployed environment's photos.
  if (
    photos &&
    store?.driver === "fs" &&
    (appEnv === "staging" || appEnv === "production")
  )
    throw new ConfigError("media_store_fs_deployed");
}
