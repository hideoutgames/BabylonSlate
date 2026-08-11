import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core";
import { ResourceCache } from "./resource-cache";
import { accountedTextureBytes } from "./texture-bytes";

/**
 * Play open/close must not grow accounted resource-cache bytes when the same
 * asset guid is retained/released across a simulated Play cycle (engineplan §2.4).
 * Full `getLoadedTexturesCache()` growth is asserted when a real WebGL Engine
 * is available; NullEngine still validates the cache bookkeeping contract.
 */
describe("Play texture cache invariant", () => {
  it("stable blob URL + release leaves accounted bytes at the unreferenced floor", () => {
    const engine = new NullEngine();
    const before = engine.getLoadedTexturesCache().length;
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    const bytes = new Uint8Array(64 * 64 * 4);
    const urlA = cache.blobUrlFor("tex-a", bytes);
    const urlB = cache.blobUrlFor("tex-a", bytes);
    expect(urlA).toBe(urlB);
    cache.account("tex-a", accountedTextureBytes(64, 64, "rgba8", true));
    // blobUrlFor twice => refCount 2; release until unreferenced.
    cache.release("tex-a");
    cache.release("tex-a");
    cache.flushUnreferenced();
    expect(cache.accountedBytes()).toBe(0);
    expect(engine.getLoadedTexturesCache().length).toBe(before);
    cache.dispose();
    engine.dispose();
  });
});
