import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { AssetRegistry } from "./registry";
import { EncodeQueue } from "./encode-queue";
import { projectContentRoot } from "./content-root";
import { AREA_EMISSION_EDGE, currentAreaEmissionChunk, encodeAreaEmission } from "./area-emission";
import { encodeBabasset, readBabassetHeader } from "./babasset";

async function fixture() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("emission.babproject");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  registry.setEncodePipeline(new EncodeQueue());
  const asset = await registry.createAsset("project", "Pattern.babasset", { guid: "pattern", type: "Texture", name: "Pattern", version: 1, dependencies: [], payload: { width: 2, height: 2, usage: "emissive" }, chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: new Uint8Array([1, 2, 3]) }] });
  const process = vi.fn(async ({ sourceHash }: { sourceHash: string }) => encodeAreaEmission(new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(200), sourceHash));
  return { storage, registry, asset, process };
}

describe("area emission asset representation", () => {
  it("persists a reusable representation with the ordinary Texture and retains its source", async () => {
    const { storage, registry, asset, process } = await fixture();
    const first = await registry.prepareAreaEmission("pattern", process);
    const next = await registry.prepareAreaEmission("pattern", process);
    expect(next.byteLength).toBe(first.byteLength);
    expect(process).toHaveBeenCalledTimes(1);
    const header = readBabassetHeader(await storage.readBinary(asset.path));
    expect(header.guid).toBe("pattern");
    expect(header.payload.usage).toBe("emissive");
    expect(header.chunks.some((chunk) => chunk.id === "pixels")).toBe(true);
    expect(currentAreaEmissionChunk(header)).toBeDefined();
    // Reopen through a new registry, with no editor memory cache.
    const reopened = new AssetRegistry(storage);
    await reopened.mountRoot(projectContentRoot());
    reopened.setEncodePipeline(new EncodeQueue());
    await reopened.prepareAreaEmission("pattern", process);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("discards a completed result if the source changed while the worker was running", async () => {
    const { storage, registry, asset, process } = await fixture();
    const prepare = registry.prepareAreaEmission("pattern", async (request) => {
      const { chunks: _chunks, ...header } = readBabassetHeader(await storage.readBinary(asset.path));
      await storage.writeBinary(asset.path, await encodeBabasset({ header, chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: new Uint8Array([4, 5, 6]) }] }));
      await registry.reindexPath(asset.path);
      return process(request);
    });
    await expect(prepare).rejects.toThrow("stale results were discarded");
    expect(currentAreaEmissionChunk(readBabassetHeader(await storage.readBinary(asset.path)))).toBeUndefined();
    await registry.prepareAreaEmission("pattern", process);
    expect(currentAreaEmissionChunk(readBabassetHeader(await storage.readBinary(asset.path)))).toBeDefined();
  });

  it("cancels a queued job without allocating a worker or preventing the next job", async () => {
    const queue = new EncodeQueue();
    queue.pause();
    const controller = new AbortController();
    const work = vi.fn(async () => 1);
    const cancelled = queue.enqueueDerived(work, controller.signal);
    const assertion = expect(cancelled).rejects.toThrow("cancel");
    controller.abort(new Error("cancel"));
    await assertion;
    const next = queue.enqueueDerived(async () => 2);
    expect(queue.depth).toBe(1);
    queue.resume();
    expect(await next).toBe(2);
    expect(work).not.toHaveBeenCalled();
    await expect.poll(() => queue.depth).toBe(0);
  });

  it("retains prepared emission through rename and duplicate, and does not recreate a deleted asset", async () => {
    const { registry, process } = await fixture();
    await registry.prepareAreaEmission("pattern", process);
    const renamed = await registry.renameAsset("pattern", "Renamed");
    expect(currentAreaEmissionChunk(renamed.header)).toBeDefined();
    const copy = await registry.duplicateAsset("pattern", "project");
    await registry.prepareAreaEmission(copy.header.guid, process);
    expect(process).toHaveBeenCalledTimes(1);
    await registry.prepareAreaEmission(copy.header.guid, process);
    await registry.deleteAsset("pattern");
    await expect(registry.prepareAreaEmission("pattern", process)).rejects.toThrow("raster Texture");
    expect(registry.getByGuid(copy.header.guid)).toBeDefined();
  });
});
