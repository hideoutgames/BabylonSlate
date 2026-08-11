import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "./memory-adapter";

describe("write microbench (synthetic 500 assets)", () => {
  it("writes 500 small files under a second on the memory adapter", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Bench.babproject");
    await storage.mkdir("assets", true);
    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      await storage.writeBinary(
        `assets/asset-${i}.bin`,
        new Uint8Array([i % 256, 1, 2, 3]),
      );
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(await storage.exists("assets/asset-499.bin")).toBe(true);
  });
});
