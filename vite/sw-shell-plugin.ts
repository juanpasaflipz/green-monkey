import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Placeholder in public/sw.js replaced by the build id at build time. */
export const BUILD_ID_PLACEHOLDER = '"__GM_BUILD_ID__"';
const ASSETS_PLACEHOLDER = "const SHELL_ASSETS = [];";

/**
 * Bakes the build id and the hashed asset list into the service worker source.
 * The worker never reads its revision from the registration URL (OFF-10).
 */
export function transformServiceWorker(
  source: string,
  { buildId, assets }: { buildId: string; assets: string[] },
): string {
  if (
    !source.includes(BUILD_ID_PLACEHOLDER) ||
    !source.includes(ASSETS_PLACEHOLDER)
  )
    throw Error("service worker placeholders missing");
  return source
    .replace(BUILD_ID_PLACEHOLDER, JSON.stringify(buildId))
    .replace(
      ASSETS_PLACEHOLDER,
      `const SHELL_ASSETS = ${JSON.stringify(assets)};`,
    );
}

/** Emits dist/sw.js for this build and stamps index.html with the same build id. */
export function swShellPlugin(buildId: string): Plugin {
  return {
    name: "complete-offline-shell",
    // Vite removes CSS-only JavaScript chunks after normal plugins run. Build
    // the cache list afterward or a nonexistent chunk prevents SW installation.
    enforce: "post",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { name: "gm-build", content: buildId },
          injectTo: "head",
        },
      ];
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => name.startsWith("assets/"))
        .map((name) => "/" + name);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: transformServiceWorker(
          readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
          { buildId, assets },
        ),
      });
    },
  };
}
