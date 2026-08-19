import { defineConfig } from "vitest/config";

const coverage = process.argv.includes("--coverage");

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.jsdom.ts"],
    // Needed so `?raw` stylesheet imports resolve; Vitest stubs CSS by default.
    css: true,
    ...(coverage ? { maxWorkers: 4 } : {}),
  },
});
