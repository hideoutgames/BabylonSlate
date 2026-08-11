import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vitest.projects.node.ts",
        test: {
          name: "node",
          include: [
            "packages/core/**/*.test.ts",
            "packages/test-kit/**/*.test.ts",
            "packages/render/**/*.test.ts",
            "packages/graph-ui/**/*.test.ts",
          ],
        },
      },
      {
        extends: "./vitest.projects.jsdom.ts",
        test: {
          name: "jsdom",
          include: [
            "packages/editor-kit/**/*.test.tsx",
            "packages/vfs/**/*.test.ts",
            "apps/editor/**/*.test.ts",
          ],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        "**/scoped-storage-adapter.ts",
        "apps/**",
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 45,
        statements: 60,
      },
    },
  },
});
