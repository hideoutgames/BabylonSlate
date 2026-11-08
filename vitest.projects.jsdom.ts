import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.jsdom.ts"],
    // Tests read computed styles: role queries skip what a stylesheet hides (`display: none`, `visibility: hidden`)
    // and components read values such as the windowed lists' `overflow`. So the stylesheets load into the document
    // instead of Vitest's default empty stub.
    css: true,
    fileParallelism: true,
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 1),
  },
});
