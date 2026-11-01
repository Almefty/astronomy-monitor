import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  build: { chunkSizeWarningLimit: 600 },
  // satellite.js's optional WebAssembly builds are never used (src/viz/passes.ts runs the JavaScript SGP4);
  // bundling them fails and would add ~420 KB. See src/viz/satellite-no-wasm.ts. ("/…" = project root.)
  resolve: { alias: [{ find: /^#wasm-(single|multi)-thread$/, replacement: "/src/viz/satellite-no-wasm.ts" }] },
});
