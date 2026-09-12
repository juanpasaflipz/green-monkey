import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
