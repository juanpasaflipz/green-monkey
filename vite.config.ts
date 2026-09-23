import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
const buildId =
  process.env.RAILWAY_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  `${process.env.npm_package_version ?? "dev"}-${Date.now()}`;
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "complete-offline-shell",
      generateBundle(_options, bundle) {
        const assets = Object.keys(bundle)
          .filter((name) => name.startsWith("assets/"))
          .map((name) => "/" + name);
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: readFileSync(
            new URL("./public/sw.js", import.meta.url),
            "utf8",
          ).replace(
            "const SHELL_ASSETS = [];",
            `const SHELL_ASSETS = ${JSON.stringify(assets)};`,
          ),
        });
      },
    },
  ],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules\/(react|react-dom|scheduler)\//,
            },
            { name: "dexie", test: /node_modules\/dexie\// },
            { name: "validation", test: /node_modules\/zod\// },
            { name: "time", test: /node_modules\/(@js-temporal|jsbi)\// },
          ],
        },
      },
    },
  },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3001" } },
});
