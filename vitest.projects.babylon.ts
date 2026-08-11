import { defineConfig } from "vitest/config";

/**
 * Babylon-touching tests run through NullEngine, which needs no canvas and so
 * runs in Node (engineplan section 2.3: NullEngine is the test seam).
 */
export default defineConfig({
  test: {
    environment: "node",
  },
});
