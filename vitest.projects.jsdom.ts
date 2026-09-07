import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.jsdom.ts"],
    // Needed so `?raw` stylesheet imports resolve; Vitest stubs CSS by default.
    css: true,
    fileParallelism: true,
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 1),
  },
});
