import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "./memory-adapter";
import { OpfsStorageAdapter } from "./web-adapter";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { createFakeDocumentsFs } from "./test-support/fake-documents-fs";

const ASSET_COUNT = 500;

describe("write microbench (synthetic 500 assets)", () => {
  it("writes 500 small files under a second on the memory adapter", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Bench.babproject");
    await storage.mkdir("assets", true);
    const start = performance.now();
    for (let i = 0; i < ASSET_COUNT; i++) {
      await storage.writeBinary(
        `assets/asset-${i}.bin`,
        new Uint8Array([i % 256, 1, 2, 3]),
      );
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(await storage.exists(`assets/asset-${ASSET_COUNT - 1}.bin`)).toBe(true);
  });

  it("writes 500 small files on the OPFS adapter (memory fallback in jsdom)", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    await storage.openDocumentsProject("OpfsBench.babproject");
    await storage.mkdir("assets", true);
    const start = performance.now();
    for (let i = 0; i < ASSET_COUNT; i++) {
      await storage.writeBinary(
        `assets/asset-${i}.bin`,
        new Uint8Array([i % 256, 1, 2, 3]),
      );
    }
    const elapsed = performance.now() - start;
    // jsdom uses the in-memory OPFS fallback; real OPFS is exercised in Playwright.
    expect(elapsed).toBeLessThan(2000);
    expect(await storage.exists(`assets/asset-${ASSET_COUNT - 1}.bin`)).toBe(true);
  });

  it("costs one bridge crossing per asset on the Documents tier", async () => {
    const fs = createFakeDocumentsFs();
    const writeFile = vi.spyOn(fs, "writeFile");
    const storage = new DocumentsStorageAdapter(fs);
    await storage.openDocumentsProject("DocsBench.babproject");
    await storage.mkdir("assets", true);

    for (let i = 0; i < ASSET_COUNT; i++) {
      await storage.writeBinary(
        `assets/asset-${i}.bin`,
        new Uint8Array([i % 256, 1, 2, 3]),
      );
    }

    // One base64 Capacitor call per asset: the cost model behind the §19
    // decision recorded in docs/architecture/vfs.md. Device numbers still
    // need an iPad; the mitigation this locks in is writing only dirty assets.
    expect(writeFile).toHaveBeenCalledTimes(ASSET_COUNT);
  });

});
