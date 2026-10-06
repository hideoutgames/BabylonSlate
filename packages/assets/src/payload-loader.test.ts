import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeAssetDocument } from "./asset-document";
import { encodeBabasset, MAX_BABASSET_HEADER_BYTES } from "./babasset";
import { createVfsBlobStore } from "./blob-store";
import { projectContentRoot } from "./content-root";
import { AccountedPayloadLoader, readAssetCatalog } from "./payload-loader";
import { AssetRegistry } from "./registry";

async function fixture() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("demand-loading");
  return storage;
}

const header = {
  guid: "asset", type: "Model", name: "Asset", engineVersion: "0.0.0",
  version: 1, mode: "thin" as const, dependencies: [], payload: {},
};

const chunk = (id: string, data: Uint8Array) => ({ id, kind: id, mime: "application/octet-stream", data });

/** Models external same-size saves on a filesystem with a coarse timestamp. */
class WeakRevisionStorage extends MemoryStorageAdapter {
  override readonly hasStrongSourceRevisions = false;

  override async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string) {
    if (expectedRevision !== undefined && expectedRevision !== "same-timestamp-and-size") {
      throw new Error("Source revision changed");
    }
    return { ...await super.readBinaryRange(path, offset, length), revision: "same-timestamp-and-size" };
  }
}

describe("bounded catalog and payload loading", () => {
  it("opens a mixed inline/blob catalog without reading its payloads or legacy atlas documents", async () => {
    const storage = await fixture();
    const blobs = createVfsBlobStore(storage);
    const inline = new Uint8Array(2 * 1024 * 1024);
    const inlineFile = await encodeBabasset({ header, chunks: [chunk("source", inline)] });
    const blobFile = await encodeBabasset({
      header: { ...header, guid: "blob" }, chunks: [chunk("source", new Uint8Array(1024 * 1024))],
      writeBlob: (hash, data) => blobs.writeBlob(hash, data),
    });
    const legacyFile = await encodeAssetDocument({
      guid: "legacy", name: "Legacy atlas", type: "Sprite", version: 1,
      payload: { textureAsset: "unused", frames: [] },
    });
    await storage.writeBinary("assets/inline.babasset", inlineFile);
    await storage.writeBinary("assets/blob.babasset", blobFile);
    await storage.writeBinary("assets/legacy.babasset", legacyFile);
    const fullReads = vi.spyOn(storage, "readBinary");
    const boundedRead = storage.readBinaryRange.bind(storage);
    let bytesRead = 0;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      const result = await boundedRead(...args);
      bytesRead += result.actualBytesRead;
      return result;
    });
    const registry = new AssetRegistry(storage);
    registry.setAtlasStatusListener(() => undefined);
    await registry.mountRoot(projectContentRoot());
    await Promise.resolve();
    expect(registry.list()).toHaveLength(3);
    expect(fullReads).not.toHaveBeenCalled();
    expect(bytesRead).toBeLessThan(4096);
    expect(registry.accountedPayloadBytes).toBe(0);
    const before = bytesRead;
    const loaded = await registry.readChunk("asset", "source");
    expect(loaded.byteLength).toBe(inline.byteLength);
    expect(loaded.every((byte) => byte === 0)).toBe(true);
    expect(bytesRead - before).toBe(inline.byteLength);
    expect(fullReads).not.toHaveBeenCalled();
  });

  it("opens a document without reading its retained source or other representations", async () => {
    const storage = await fixture();
    const bytes = await encodeAssetDocument({
      guid: "doc", name: "Doc", type: "Model", version: 1, payload: { meshes: [] },
    }, { extraChunks: [chunk("source", new Uint8Array(1024 * 1024))] });
    await storage.writeBinary("assets/document.babasset", bytes);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const read = storage.readBinaryRange.bind(storage);
    let payloadRead = 0;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      const result = await read(...args);
      payloadRead += result.actualBytesRead;
      return result;
    });
    expect((await registry.readAssetDocument("doc")).payload).toEqual({ meshes: [] });
    expect(payloadRead).toBe(13);
  });

  it("rejects invalid header lengths before allocating or requesting the header", async () => {
    const storage = await fixture();
    const bytes = new Uint8Array(12);
    bytes.set(new TextEncoder().encode("BABA"));
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 1, true);
    view.setUint32(8, MAX_BABASSET_HEADER_BYTES + 1, true);
    await storage.writeBinary("assets/bad.babasset", bytes);
    const reads = vi.spyOn(storage, "readBinaryRange");
    await expect(readAssetCatalog(storage, "assets/bad.babasset")).rejects.toThrow("header length");
    expect(reads).toHaveBeenCalledTimes(1);
    view.setUint32(8, 100, true);
    await storage.writeBinary("assets/bad.babasset", bytes);
    await expect(readAssetCatalog(storage, "assets/bad.babasset")).rejects.toThrow("Truncated");
  });

  it("rejects an old snapshot after a same-size save and resolves a fresh snapshot for retry", async () => {
    const storage = await fixture();
    const path = "assets/source.babasset";
    await storage.writeBinary(path, await encodeBabasset({ header, chunks: [chunk("source", new Uint8Array([1, 2, 3]))] }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const stale = registry.getByGuid("asset")!;
    await storage.writeBinary(path, await encodeBabasset({ header, chunks: [chunk("source", new Uint8Array([4, 5, 6]))] }));
    await expect(registry.payloadLoader.loadChunk(stale.locator!, stale.header.chunks[0]!)).rejects.toThrow(/chang|revision/i);
    expect(await registry.readChunk("asset", "source")).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("reads only the selected blob and rejects corrupt bytes without accounting them as valid payload", async () => {
    const storage = await fixture();
    const blobs = createVfsBlobStore(storage);
    await storage.writeBinary("assets/blob.babasset", await encodeBabasset({
      header, chunks: [chunk("selected", new Uint8Array([1, 2])), chunk("unused", new Uint8Array([3, 4, 5]))],
      blobThreshold: 1, writeBlob: (hash, data) => blobs.writeBlob(hash, data),
    }));
    const { header: catalog, locator } = await readAssetCatalog(storage, "assets/blob.babasset");
    const selected = catalog.chunks[0]!;
    const fullReads = vi.spyOn(storage, "readBinary");
    const loader = new AccountedPayloadLoader(storage);
    expect(await loader.loadChunk(locator, selected)).toEqual(new Uint8Array([1, 2]));
    expect(fullReads.mock.calls.map(([path]) => path)).toEqual([`assets/.blobs/${selected.sha256}`]);
    await storage.writeBinary(`assets/.blobs/${selected.sha256}`, new Uint8Array([9, 9]));
    loader.resetAccounting();
    await expect(loader.loadChunk(locator, selected)).rejects.toThrow("Hash mismatch");
    expect(loader.accountedPayloadBytes).toBe(0);
  });

  it("rejects a revision change between reading a prefix and its header", async () => {
    const storage = await fixture();
    const path = "assets/changing.babasset";
    const original = await encodeBabasset({ header, chunks: [chunk("source", new Uint8Array([1]))] });
    await storage.writeBinary(path, original);
    const read = storage.readBinaryRange.bind(storage);
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[1] === 0 && args[2] === 12) await storage.writeBinary(path, original);
      return result;
    });
    await expect(readAssetCatalog(storage, path)).rejects.toThrow(/chang|revision/i);
  });

  it("refreshes header-only documents before a cache lookup can publish a stale revision", async () => {
    const storage = await fixture();
    const path = "assets/material.babasset";
    await storage.writeBinary(path, await encodeBabasset({ header: { ...header, type: "Material", payload: { roughness: 1 } }, chunks: [] }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const original = await registry.getAssetLocator("asset");
    await storage.writeBinary(path, await encodeBabasset({ header: { ...header, type: "Material", payload: { roughness: 2 } }, chunks: [] }));
    expect((await registry.getAssetLocator("asset")).revision).not.toBe(original.revision);
    expect((await registry.readAssetDocument("asset")).payload).toEqual({ roughness: 2 });
  });

  it("refreshes same-size header-only documents even when storage timestamps do not change", async () => {
    const storage = new WeakRevisionStorage("documents");
    await storage.openDocumentsProject("weak-revision");
    const path = "assets/material.babasset";
    const bytes = (roughness: number) => encodeBabasset({
      header: { ...header, type: "Material", payload: { roughness } }, chunks: [],
    });
    await storage.writeBinary(path, await bytes(1));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const original = await registry.getAssetLocator("asset");
    expect(await registry.getAssetLocator("asset")).toBe(original);
    await storage.writeBinary(path, await bytes(2));
    const replacement = await registry.getAssetLocator("asset");
    expect(replacement.storageRevision).toBe(original.storageRevision);
    expect(replacement.revision).not.toBe(original.revision);
    expect((await registry.readAssetDocument("asset")).payload).toEqual({ roughness: 2 });
  });

  it("rejects a changed header on weak storage even when its selected payload still matches", async () => {
    const storage = new WeakRevisionStorage("documents");
    await storage.openDocumentsProject("weak-revision");
    const path = "assets/source.babasset";
    const bytes = (value: number) => encodeBabasset({
      header: { ...header, payload: { value } }, chunks: [chunk("source", new Uint8Array([1, 2, 3]))],
    });
    await storage.writeBinary(path, await bytes(1));
    const old = await readAssetCatalog(storage, path);
    await storage.writeBinary(path, await bytes(2));
    const loader = new AccountedPayloadLoader(storage);
    await expect(loader.loadChunk(old.locator, old.header.chunks[0]!)).rejects.toThrow("Asset changed");
    expect(loader.accountedPayloadBytes).toBe(0);
  });
});
