import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string | null;
}

let cached: BuildInfo | null = null;

/** Parses build-info.json; anything malformed reads as an unstamped local build. */
export function parseBuildInfo(text: string | null): BuildInfo {
  const fallback: BuildInfo = { version: "0.0.0", commit: "local", builtAt: null };
  if (!text) return fallback;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const version =
      typeof data.version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(data.version)
        ? data.version
        : fallback.version;
    const commit =
      typeof data.commit === "string" &&
      (/^[0-9a-f]{7,40}$/.test(data.commit) || data.commit === "local")
        ? data.commit
        : fallback.commit;
    const builtAt =
      typeof data.builtAt === "string" && !Number.isNaN(Date.parse(data.builtAt))
        ? new Date(data.builtAt).toISOString()
        : null;
    return { version, commit, builtAt };
  } catch {
    return fallback;
  }
}

/**
 * The deployed revision. CD stamps build-info.json (scripts/ops/stamp-build.mjs)
 * before uploading, so /api/version reports what was built, not a variable
 * someone typed (OPS-1).
 */
export function buildInfo(path = resolve("build-info.json")): BuildInfo {
  if (cached && path === resolve("build-info.json")) return cached;
  let text: string | null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  const info = parseBuildInfo(text);
  if (path === resolve("build-info.json")) cached = info;
  return info;
}
