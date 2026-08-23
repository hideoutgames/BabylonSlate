import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonslate/core";
import { ResourceCache } from "./resource-cache";
import { accountedTextureBytes } from "./texture-bytes";

/** Valid KTX2 container bytes with dimensions (for accounting sniffing). */
function ktx2Bytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(28);
  bytes.set(
    [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a],
    0,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

describe("ResourceCache eviction hysteresis", () => {
  it("triggers at the ceiling and trims to the 80% target", () => {
    const cache = new ResourceCache({ byteCeiling: 1000 });
    // Two unreferenced-after-release entries push past the ceiling.
    cache.account("a", 600);
    cache.account("b", 600);
    // Referenced entries are never evicted even though we're over.
    expect(cache.accountedBytes()).toBe(1200);
    expect(cache.stats().evictions).toBe(0);

    cache.release("a");
    cache.release("b");
    // Next sweep point (any account call) evicts down to <=800, not just <=1000.
    cache.account("c", 1);
    expect(cache.accountedBytes()).toBeLessThanOrEqual(801);
    expect(cache.stats().evictions).toBeGreaterThan(0);
    expect(cache.accountedBytes()).toBeGreaterThanOrEqual(600); // kept newest
    cache.dispose();
  });

  it("does nothing while under the ceiling", () => {
    const cache = new ResourceCache({ byteCeiling: 1000 });
    cache.account("a", 400);
    cache.release("a");
    cache.account("b", 400);
    expect(cache.accountedBytes()).toBe(800);
    expect(cache.stats().evictions).toBe(0);
    expect(cache.stats().ceiling).toBe(1000);
    cache.dispose();
  });

  it("accounts KTX2 textures at ASTC rates via header sniff", async () => {
    const engine = new NullEngine();
    const cache = new ResourceCache();
    const texture = cache.getTexture(
      "ktx2-guid",
      engine,
      ktx2Bytes(1000, 500),
      {},
    );
    expect(texture).toBeDefined();
    expect(cache.accountedBytes()).toBe(
      accountedTextureBytes(1000, 500, "astc4x4", true),
    );
    cache.releaseGpuTextures();
    cache.dispose();
    engine.dispose();
  });
});
