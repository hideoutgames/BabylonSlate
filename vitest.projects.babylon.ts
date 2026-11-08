import { defineConfig } from "vitest/config";

/**
 * Babylon-touching tests run through NullEngine, which needs no canvas and so
 * runs in Node (engineplan section 2.3: NullEngine is the test seam).
 */
export default defineConfig({
  test: {
    environment: "node",
    // Every NullEngine has the engine-wide registrations a shipped Engine loads before it exists (create-engine.ts and
    // webgpu-engine.ts import babylon-registrations.ts), and takes the light block's path as a shipped Engine does
    // (uniform buffers, the atlas's textures). Node gets the PointerEvent and FileReader globals every shipped host has.
    setupFiles: [
      "./packages/render/src/babylon-registrations.ts",
      "./packages/render/src/test-support/light-block-engine.ts",
      "./packages/render/src/test-support/node-dom-polyfills.ts",
    ],
    fileParallelism: true,
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 1),
  },
});
