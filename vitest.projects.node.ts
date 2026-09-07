import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Node-based stylesheet audits still need real ?raw CSS, not Vitest's empty CSS stub.
    css: true,
    fileParallelism: true,
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 1),
  },
});
