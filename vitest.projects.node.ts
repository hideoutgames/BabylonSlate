import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // No DOM reads styles here, so stylesheet imports stay Vitest's empty stub (`?raw` and `?inline` CSS too); a
    // stylesheet audit reads the file itself.
    fileParallelism: true,
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 1),
  },
});
