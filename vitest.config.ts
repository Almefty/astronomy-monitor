import { defineConfig } from "vitest/config";

// Unit tests run in Node (the normalizers use only web-standard APIs); kept separate
// from vite.config.ts so the Cloudflare plugin isn't started for tests.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
