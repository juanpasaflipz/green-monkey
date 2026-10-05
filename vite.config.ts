import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { swShellPlugin } from "./vite/sw-shell-plugin.ts";
const buildId =
  process.env.RAILWAY_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  `${process.env.npm_package_version ?? "dev"}-${Date.now()}`;
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), tailwindcss(), swShellPlugin(buildId)],
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
