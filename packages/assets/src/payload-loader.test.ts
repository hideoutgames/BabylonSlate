import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { encodeAssetDocument } from "./asset-document";
import { encodeHasset, MAX_HASSET_HEADER_BYTES } from "./hasset";
import { createVfsBlobStore } from "./blob-store";
import { projectContentRoot } from "./content-root";
import { AccountedPayloadLoader, readAssetCatalog, SPECULATIVE_CATALOG_READ_BYTES } from "./payload-loader";
import { AssetRegistry } from "./registry";
import type { StorageReadOptions } from "@haptic/core";

async function fixture() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("demand-loading");
  return storage;
}

const header = {
  guid: "asset", type: "Model", name: "Asset", engineVersion: "0.0.0",
  version: 1, mode: "thin" as const, dependencies: [], payload: {},
  dependencyMetadataVersion: 1, requiredDependencies: [],
};

const chunk = (id: string, data: Uint8Array) => ({ id, kind: id, mime: "application/octet-stream", data });

/** Models external same-size saves on a filesystem with a coarse timestamp. */
class WeakRevisionStorage extends MemoryStorageAdapter {
  override readonly hasStrongSourceRevisions = false;

  override async readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string, options?: StorageReadOptions) {
    if (expectedRevision !== undefined && expectedRevision !== "same-timestamp-and-size") {
      throw new Error("Source revision changed");
    }
    return { ...await super.readBinaryRange(path, offset, length, undefined, options), revision: "same-timestamp-and-size" };
  }
}

describe("bounded catalog and payload loading", () => {
  it.each(["inline", "blob"])("forwards cancellation to a pending %s transport read and permits retry", async (kind) => {
    const storage = await fixture();
    const blobs = createVfsBlobStore(storage);
    const data = new Uint8Array([1, 2, 3]);
    await storage.writeBinary("assets/source.hasset", await encodeHasset({
      header, chunks: [chunk("source", data)],
      ...(kind === "blob" ? { blobThreshold: 1, writeBlob: blobs.writeBlob } : {}),
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const locator = registry.getByGuid("asset")!.locator!;
    const controller = new AbortController();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    let transportSignal: AbortSignal | undefined;
    const stalled = <T>(signal: AbortSignal) => new Promise<T>((_resolve, reject) => {
      transportSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started();
    });
    const readBinary = storage.readBinary.bind(storage);
    const fullRead = vi.spyOn(storage, "readBinary").mockImplementation((path, options) =>
      kind === "blob" && options?.signal ? stalled<Uint8Array>(options.signal) : readBinary(path, options));
    const readRange = storage.readBinaryRange.bind(storage);
    const rangeRead = vi.spyOn(storage, "readBinaryRange").mockImplementation((path, offset, length, revision, options) =>
      kind === "inline" && offset === locator.payloadOffset && options?.signal
        ? stalled<Awaited<ReturnType<typeof readRange>>>(options.signal)
        : readRange(path, offset, length, revision, options));
    const load = registry.readChunk("asset", "source", locator.revision, { signal: controller.signal });
    const rejected = expect(load).rejects.toMatchObject({ name: "AbortError" });
    await pending;
    expect(transportSignal).toBe(controller.signal);
    controller.abort();
    await rejected;
    expect(registry.payloadLoader.snapshot()).toMatchObject({ failed: 1, pending: 0, accountedPayloadBytes: 0 });
    fullRead.mockRestore();
    rangeRead.mockRestore();
    expect(await registry.readChunk("asset", "source")).toEqual(data);
  });

  it("isolates a canceled scoped catalog refresh from an unsignaled shared refresh", async () => {
    const storage = new WeakRevisionStorage("documents");
    await storage.openDocumentsProject("catalog-cancellation");
    await storage.writeBinary("assets/source.hasset", await encodeHasset({ header, chunks: [chunk("source", new Uint8Array([1]))] }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const original = registry.getByGuid("asset")!.locator;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = storage.readBinaryRange.bind(storage);
    const controller = new AbortController();
    const reads = vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      if (args[1] === 0 && args[2] === 12) {
        const signal = args[4]?.signal;
        if (signal) await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        else await gate;
      }
      return read(...args);
    });
    const unscoped = registry.getAssetLocator("asset");
    const scoped = registry.getAssetLocator("asset", { signal: controller.signal });
    const rejected = expect(scoped).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    // The uncancelled request must remain usable, even when both refreshes
    // initially resolve the same indexed asset object.
    release();
    await rejected;
    expect(await unscoped).toBe(original);
    reads.mockRestore();
    expect(await registry.getAssetLocator("asset", { signal: new AbortController().signal })).toBe(original);
  });

  it("keeps canceled noninterruptible I/O pending until the storage operation settles", async () => {
    const storage = await fixture();
    await storage.writeBinary("assets/source.hasset", await encodeHasset({ header, chunks: [chunk("source", new Uint8Array([1, 2, 3]))] }));
    const { locator, header: catalog } = await readAssetCatalog(storage, "assets/source.hasset");
    const loader = new AccountedPayloadLoader(storage);
    const read = storage.readBinaryRange.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reads = vi.spyOn(storage, "readBinaryRange").mockImplementation(async (path, offset, length, revision) => {
      const result = await read(path, offset, length, revision);
      if (offset === locator.payloadOffset) await gate;
      return result;
    });
    const controller = new AbortController();
    const loaded = loader.loadChunk(locator, catalog.chunks[0]!, undefined, undefined, { signal: controller.signal });
    const rejected = expect(loaded).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await Promise.resolve();
    expect(loader.snapshot()).toMatchObject({ pending: 1, failed: 0, accountedPayloadBytes: 0 });
    release();
    await rejected;
    expect(loader.snapshot()).toMatchObject({ pending: 0, failed: 1, accountedPayloadBytes: 0 });
    reads.mockRestore();
  });

  it("opens a mixed inline/blob catalog without reading its payloads or legacy atlas documents", async () => {
    const storage = await fixture();
    const blobs = createVfsBlobStore(storage);
    const inline = new Uint8Array(2 * 1024 * 1024);
    const inlineFile = await encodeHasset({ header, chunks: [chunk("source", inline)] });
    const blobFile = await encodeHasset({
      header: { ...header, guid: "blob" }, chunks: [chunk("source", new Uint8Array(1024 * 1024))],
      writeBlob: (hash, data) => blobs.writeBlob(hash, data),
    });
    const legacyFile = await encodeAssetDocument({
      guid: "legacy", name: "Legacy atlas", type: "Sprite", version: 1,
      payload: { textureAsset: "unused", frames: [] },
    });
    await storage.writeBinary("assets/inline.hasset", inlineFile);
    await storage.writeBinary("assets/blob.hasset", blobFile);
    await storage.writeBinary("assets/legacy.hasset", legacyFile);
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
    // At most one speculative read per file: never the payloads themselves.
    expect(bytesRead).toBeLessThanOrEqual(3 * SPECULATIVE_CATALOG_READ_BYTES);
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
    await storage.writeBinary("assets/document.hasset", bytes);
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
    bytes.set(new TextEncoder().encode("HAPT"));
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 1, true);
    view.setUint32(8, MAX_HASSET_HEADER_BYTES + 1, true);
    await storage.writeBinary("assets/bad.hasset", bytes);
    const reads = vi.spyOn(storage, "readBinaryRange");
    await expect(readAssetCatalog(storage, "assets/bad.hasset")).rejects.toThrow("header length");
    expect(reads).toHaveBeenCalledTimes(1);
    view.setUint32(8, 100, true);
    await storage.writeBinary("assets/bad.hasset", bytes);
    await expect(readAssetCatalog(storage, "assets/bad.hasset")).rejects.toThrow("Truncated");
  });

  it("rejects an old snapshot after a same-size save and resolves a fresh snapshot for retry", async () => {
    const storage = await fixture();
    const path = "assets/source.hasset";
    await storage.writeBinary(path, await encodeHasset({ header, chunks: [chunk("source", new Uint8Array([1, 2, 3]))] }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const stale = registry.getByGuid("asset")!;
    await storage.writeBinary(path, await encodeHasset({ header, chunks: [chunk("source", new Uint8Array([4, 5, 6]))] }));
    await expect(registry.payloadLoader.loadChunk(stale.locator!, stale.header.chunks[0]!)).rejects.toThrow(/chang|revision/i);
    expect(await registry.readChunk("asset", "source")).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("reads only the selected blob and rejects corrupt bytes without accounting them as valid payload", async () => {
    const storage = await fixture();
    const blobs = createVfsBlobStore(storage);
    await storage.writeBinary("assets/blob.hasset", await encodeHasset({
      header, chunks: [chunk("selected", new Uint8Array([1, 2])), chunk("unused", new Uint8Array([3, 4, 5]))],
      blobThreshold: 1, writeBlob: (hash, data) => blobs.writeBlob(hash, data),
    }));
    const { header: catalog, locator } = await readAssetCatalog(storage, "assets/blob.hasset");
    const selected = catalog.chunks[0]!;
    const fullReads = vi.spyOn(storage, "readBinary");
    const loader = new AccountedPayloadLoader(storage);
    expect(await loader.loadChunk(locator, selected)).toEqual(new Uint8Array([1, 2]));
    expect(fullReads.mock.calls.map(([path]) => path)).toEqual([`assets/.blobs/${selected.sha256}`]);
    await storage.writeBinary(`assets/.blobs/${selected.sha256}`, new Uint8Array([9, 9]));
    loader.resetAccounting();
    await expect(loader.loadChunk(locator, selected)).rejects.toThrow("Hash mismatch");
    expect(loader.accountedPayloadBytes).toBe(0);
    await storage.writeBinary(`assets/.blobs/${selected.sha256}`, new Uint8Array([1, 2]));
    expect(await loader.loadChunk(locator, selected)).toEqual(new Uint8Array([1, 2]));
    const snapshot = loader.snapshot();
    expect(snapshot).toMatchObject({ requests: 3, succeeded: 2, failed: 1, pending: 0, accountedPayloadBytes: 2 });
    expect(snapshot.recentRequests).toEqual([
      { id: 1, path: locator.path, chunkId: "selected", revision: locator.revision, requestedBytes: 2, payloadBytes: 2, status: "succeeded" },
      { id: 2, path: locator.path, chunkId: "selected", revision: locator.revision, requestedBytes: 2, payloadBytes: 2, status: "failed", error: expect.stringContaining("Hash mismatch") },
      { id: 3, path: locator.path, chunkId: "selected", revision: locator.revision, requestedBytes: 2, payloadBytes: 2, status: "succeeded" },
    ]);
    snapshot.recentRequests[0]!.path = "changed-copy";
    expect(loader.snapshot().recentRequests[0]!.path).toBe(locator.path);
  });

  it("bounds request history while preserving aggregate failure counts", async () => {
    const storage = await fixture();
    await storage.writeBinary("assets/inline.hasset", await encodeHasset({ header, chunks: [chunk("source", new Uint8Array([1]))] }));
    const { locator, header: catalog } = await readAssetCatalog(storage, "assets/inline.hasset");
    const loader = new AccountedPayloadLoader(storage);
    const invalid = { ...catalog.chunks[0]!, locator: { inline: { offset: locator.totalSize, length: 1 } } };
    for (let index = 0; index < 130; index += 1) {
      await expect(loader.loadChunk(locator, invalid)).rejects.toThrow("Invalid bounds");
    }
    const snapshot = loader.snapshot();
    expect(snapshot).toMatchObject({ requests: 130, failed: 130, succeeded: 0, pending: 0, accountedPayloadBytes: 0 });
    expect(snapshot.recentRequests).toHaveLength(128);
    expect(snapshot.recentRequests[0]!.id).toBe(3);
    expect(snapshot.recentRequests.at(-1)!.id).toBe(130);
  });

  it.each([
    ["a header that fits the speculative read, before a large payload", 64, 1024 * 1024, [[0, SPECULATIVE_CATALOG_READ_BYTES]]],
    ["a whole file smaller than the speculative read", 64, 16, "whole"],
    ["a header longer than the speculative read", 12_000, 16, "split"],
  ] as const)("reads the same catalog in fewer range reads with a size hint: %s", async (_name, metaLength, payloadLength, expected) => {
    const storage = await fixture();
    const path = "assets/hinted.hasset";
    const file = await encodeHasset({
      header: { ...header, payload: { note: "n".repeat(metaLength) } },
      chunks: [chunk("source", new Uint8Array(payloadLength).fill(7))],
    });
    await storage.writeBinary(path, file);
    const exact = await readAssetCatalog(storage, path);
    const reads = vi.spyOn(storage, "readBinaryRange");

    expect(await readAssetCatalog(storage, path, {}, file.byteLength)).toEqual(exact);
    const ranges = reads.mock.calls.map(([, offset, length]) => [offset, length]);
    if (expected === "whole") expect(ranges).toEqual([[0, file.byteLength]]);
    else if (expected === "split") expect(ranges).toEqual([[0, SPECULATIVE_CATALOG_READ_BYTES], [SPECULATIVE_CATALOG_READ_BYTES, exact.locator.payloadOffset - SPECULATIVE_CATALOG_READ_BYTES]]);
    else expect(ranges).toEqual(expected);
  });

  it("indexes each listed asset of a scan with one range read", async () => {
    const storage = await fixture();
    await storage.mkdir("assets/nested", true);
    for (const [path, guid] of [["assets/a.hasset", "a"], ["assets/nested/b.hasset", "b"], ["assets/nested/c.hasset", "c"]] as const) {
      await storage.writeBinary(path, await encodeHasset({ header: { ...header, guid }, chunks: [chunk("source", new Uint8Array(64 * 1024))] }));
    }
    const reads = vi.spyOn(storage, "readBinaryRange");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.list().map((asset) => asset.header.guid).sort()).toEqual(["a", "b", "c"]);
    expect(reads.mock.calls.map(([path, offset, length]) => `${path} ${offset}+${length}`).sort()).toEqual([
      `assets/a.hasset 0+${SPECULATIVE_CATALOG_READ_BYTES}`,
      `assets/nested/b.hasset 0+${SPECULATIVE_CATALOG_READ_BYTES}`,
      `assets/nested/c.hasset 0+${SPECULATIVE_CATALOG_READ_BYTES}`,
    ]);
  });

  it("reads the same catalog when the size hint no longer matches the file", async () => {
    const storage = await fixture();
    const path = "assets/stale.hasset";
    const file = await encodeHasset({ header, chunks: [chunk("source", new Uint8Array([1, 2, 3]))] });
    await storage.writeBinary(path, file);
    const exact = await readAssetCatalog(storage, path);
    // Shrunk since it was listed: the oversized read fails and is made again as the exact reads.
    expect(await readAssetCatalog(storage, path, {}, file.byteLength + 100)).toEqual(exact);
    // Grown since it was listed: the hinted read is short of the header, and the rest is read after it.
    expect(await readAssetCatalog(storage, path, {}, 20)).toEqual(exact);
    await expect(readAssetCatalog(storage, "assets/missing.hasset", {}, 4096)).rejects.toThrow("File not found");
  });

  it("rejects a revision change between a speculative read and the rest of its header", async () => {
    const storage = await fixture();
    const path = "assets/changing-long.hasset";
    const original = await encodeHasset({ header: { ...header, payload: { note: "n".repeat(12_000) } }, chunks: [] });
    await storage.writeBinary(path, original);
    const read = storage.readBinaryRange.bind(storage);
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[1] === 0) await storage.writeBinary(path, original);
      return result;
    });
    await expect(readAssetCatalog(storage, path, {}, original.byteLength)).rejects.toThrow(/chang|revision/i);
  });

  it("rejects a revision change between reading a prefix and its header", async () => {
    const storage = await fixture();
    const path = "assets/changing.hasset";
    const original = await encodeHasset({ header, chunks: [chunk("source", new Uint8Array([1]))] });
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
    const path = "assets/material.hasset";
    await storage.writeBinary(path, await encodeHasset({ header: { ...header, type: "Material", payload: { roughness: 1 } }, chunks: [] }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const original = await registry.getAssetLocator("asset");
    await storage.writeBinary(path, await encodeHasset({ header: { ...header, type: "Material", payload: { roughness: 2 } }, chunks: [] }));
    expect((await registry.getAssetLocator("asset")).revision).not.toBe(original.revision);
    expect((await registry.readAssetDocument("asset")).payload).toEqual({ roughness: 2 });
  });

  it("refreshes same-size header-only documents even when storage timestamps do not change", async () => {
    const storage = new WeakRevisionStorage("documents");
    await storage.openDocumentsProject("weak-revision");
    const path = "assets/material.hasset";
    const bytes = (roughness: number) => encodeHasset({
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
    const path = "assets/source.hasset";
    const bytes = (value: number) => encodeHasset({
      header: { ...header, payload: { value } }, chunks: [chunk("source", new Uint8Array([1, 2, 3]))],
    });
    await storage.writeBinary(path, await bytes(1));
    const old = await readAssetCatalog(storage, path);
    await storage.writeBinary(path, await bytes(2));
    const loader = new AccountedPayloadLoader(storage);
    await expect(loader.loadChunk(old.locator, old.header.chunks[0]!)).rejects.toThrow("Asset changed");
    expect(loader.accountedPayloadBytes).toBe(0);
  });

  it("reads an inline chunk on strong storage in one range read and caches verified hashes per storageRevision", async () => {
    const storage = await fixture();
    const path = "assets/inline-fast.hasset";
    const payload = new Uint8Array([11, 22, 33, 44]);
    await storage.writeBinary(path, await encodeHasset({ header, chunks: [chunk("source", payload)] }));
    const { header: catalog, locator } = await readAssetCatalog(storage, path);
    const entry = catalog.chunks[0]!;
    const loader = new AccountedPayloadLoader(storage);
    const rangeSpy = vi.spyOn(storage, "readBinaryRange");
    const digestSpy = vi.spyOn(crypto.subtle, "digest");

    // First read: exactly 1 range read (no post-read validateAssetSourceLocator) and 1 SHA-256 verification.
    expect(await loader.loadChunk(locator, entry)).toEqual(payload);
    expect(rangeSpy).toHaveBeenCalledTimes(1);
    expect(digestSpy).toHaveBeenCalledTimes(1);

    // Second read at the same storageRevision: still 1 range read and 0 SHA-256 calls.
    expect(await loader.loadChunk(locator, entry)).toEqual(payload);
    expect(rangeSpy).toHaveBeenCalledTimes(2);
    expect(digestSpy).toHaveBeenCalledTimes(1);

    // A rewritten file bumps storageRevision, forcing re-verification and rejecting corruption.
    const nextPayload = new Uint8Array([55, 66, 77, 88]);
    await storage.writeBinary(path, await encodeHasset({ header, chunks: [chunk("source", nextPayload)] }));
    const next = await readAssetCatalog(storage, path);
    const badEntry = { ...next.header.chunks[0]!, sha256: "0".repeat(64) };
    digestSpy.mockClear();
    await expect(loader.loadChunk(next.locator, badEntry)).rejects.toThrow("Hash mismatch");
    expect(digestSpy).toHaveBeenCalledTimes(1);
    rangeSpy.mockRestore();
    digestSpy.mockRestore();
  });

  it("caches verified externalized blob hashes per strong blob revision and re-hashes on overwrite", async () => {
    const storage = await fixture();
    const blobs = createVfsBlobStore(storage);
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    await storage.writeBinary("assets/blob-fast.hasset", await encodeHasset({
      header, chunks: [chunk("source", payload)],
      blobThreshold: 1, writeBlob: (hash, data) => blobs.writeBlob(hash, data),
    }));
    const { header: catalog, locator } = await readAssetCatalog(storage, "assets/blob-fast.hasset");
    const entry = catalog.chunks[0]!;
    const loader = new AccountedPayloadLoader(storage, { blobs });
    const digestSpy = vi.spyOn(crypto.subtle, "digest");

    // First read: verifies SHA-256 once and caches the verified blob revision.
    expect(await loader.loadChunk(locator, entry)).toEqual(payload);
    expect(digestSpy).toHaveBeenCalledTimes(1);

    // Second read at the same strong blob revision: skips SHA-256 completely.
    expect(await loader.loadChunk(locator, entry)).toEqual(payload);
    expect(digestSpy).toHaveBeenCalledTimes(1);

    // Same-size in-place corruption bumps the blob's strong revision, forcing re-hash and rejection.
    await storage.writeBinary(`assets/.blobs/${entry.sha256}`, new Uint8Array([99, 99, 99, 99, 99]));
    await expect(loader.loadChunk(locator, entry)).rejects.toThrow("Hash mismatch");
    expect(digestSpy).toHaveBeenCalledTimes(2);
    digestSpy.mockRestore();
  });

  it("memoizes AssetRegistry.list() across calls until an asset index change occurs", async () => {
    const storage = await fixture();
    await storage.writeBinary("assets/one.hasset", await encodeHasset({ header: { ...header, guid: "one" }, chunks: [] }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const first = registry.list();
    const second = registry.list();
    expect(second).toBe(first);
    expect(registry.list({ type: "Model" })).toBe(registry.list({ type: "Model" }));
    await storage.writeBinary("assets/two.hasset", await encodeHasset({ header: { ...header, guid: "two" }, chunks: [] }));
    await registry.reindexPath("assets/two.hasset");
    const after = registry.list();
    expect(after).not.toBe(first);
    expect(after).toHaveLength(2);
  });
});
