import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { DEFAULT_BLOB_THRESHOLD, decodeBabasset, encodeBabasset, type BabassetHeader, type ChunkInput } from "./babasset";
import { carryStoredChunks, storedBabassetMatches } from "./babasset-carry";
import { BLOBS_DIR } from "./babproject";
import { createVfsBlobStore } from "./blob-store";
import { readAssetCatalog } from "./payload-loader";

const PATH = "assets/Tex.babasset";
const HEADER: Omit<BabassetHeader, "chunks"> = {
  dependencyMetadataVersion: 1, requiredDependencies: [], dependencies: [],
  guid: "tex-1", type: "Texture", name: "Tex", engineVersion: "0.0.0", version: 1, mode: "thin", parentClass: null,
  payload: { compressionState: "compressed" },
};
const BIG = new Uint8Array(DEFAULT_BLOB_THRESHOLD + 17).map((_, index) => (index * 7) % 251);
const SMALL = new Uint8Array([9, 8, 7, 6, 5]);

const chunk = (id: string, data: Uint8Array, kind = id): ChunkInput => ({ id, kind, mime: "application/octet-stream", data });

/** A stored file with a document, a blob-sized `pixels` chunk and a small inline `note`. */
async function stored(chunks: ChunkInput[] = [chunk("document", new Uint8Array([1, 2, 3])), chunk("pixels", BIG), chunk("note", SMALL)]) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("carry.babproject");
  await storage.mkdir("assets", true);
  const blobs = createVfsBlobStore(storage);
  const writeBlob = (sha256: string, data: Uint8Array) => blobs.writeBlob(sha256, data);
  await storage.writeBinary(PATH, await encodeBabasset({ header: HEADER, chunks, writeBlob }));
  return { storage, blobs, writeBlob, catalog: await readAssetCatalog(storage, PATH) };
}

describe("carrying stored chunks into a rewrite", () => {
  it("writes the bytes a full decode and re-encode would, without reading or hashing the blob", async () => {
    const { storage, blobs, writeBlob, catalog } = await stored();
    const originalBytes = await storage.readBinary(PATH);
    const readBlob = vi.spyOn(blobs, "readBlob");
    const uploads = vi.fn(writeBlob);

    const carried = await carryStoredChunks(storage, blobs, catalog, { omit: new Set(["document"]) });
    const document = chunk("document", new TextEncoder().encode('{"edited":true}'));
    const rewritten = await encodeBabasset({ header: HEADER, chunks: [document, ...carried!], writeBlob: uploads });

    expect(readBlob).not.toHaveBeenCalled();
    expect(uploads).not.toHaveBeenCalled();
    // The reference: decode every chunk (reading the blob) and encode them afresh.
    const decoded = await decodeBabasset(originalBytes, (sha256) => blobs.readBlob(sha256));
    const reference = await encodeBabasset({
      header: HEADER,
      chunks: [document, ...["pixels", "note"].map((id) => chunk(id, decoded.chunks.get(id)!))],
      writeBlob,
    });
    expect(rewritten).toEqual(reference);
    const reread = await decodeBabasset(rewritten, (sha256) => blobs.readBlob(sha256));
    expect(reread.chunks.get("pixels")).toEqual(BIG);
    expect(reread.chunks.get("note")).toEqual(SMALL);
    expect(reread.chunks.get("document")).toEqual(document.data);
  });

  it("gives up, so the caller decodes in full, when a blob is missing or short", async () => {
    const missing = await stored();
    await missing.storage.remove(`${BLOBS_DIR}/${missing.catalog.header.chunks.find((entry) => entry.id === "pixels")!.sha256}`);
    expect(await carryStoredChunks(missing.storage, missing.blobs, missing.catalog)).toBeNull();

    const torn = await stored();
    const pixels = torn.catalog.header.chunks.find((entry) => entry.id === "pixels")!;
    await torn.storage.writeBinary(`${BLOBS_DIR}/${pixels.sha256}`, BIG.subarray(0, 100));
    expect(await carryStoredChunks(torn.storage, torn.blobs, torn.catalog)).toBeNull();
  });

  it("checks the bytes it copies or reads against the table, and leaves a blob's check to every later read", async () => {
    // An inline chunk that no longer matches its digest is not copied forward.
    const inline = await stored();
    const original = await inline.storage.readBinary(PATH);
    const damaged = original.slice();
    damaged[damaged.length - 1] ^= 0xff;
    await inline.storage.writeBinary(PATH, damaged);
    const damagedCatalog = await readAssetCatalog(inline.storage, PATH);
    expect(await carryStoredChunks(inline.storage, inline.blobs, damagedCatalog)).toBeNull();

    // A same-length blob with other bytes is only found when its bytes are read.
    const blob = await stored();
    const pixels = blob.catalog.header.chunks.find((entry) => entry.id === "pixels")!;
    const flipped = BIG.slice();
    flipped[0] ^= 0xff;
    await blob.storage.writeBinary(`${BLOBS_DIR}/${pixels.sha256}`, flipped);
    expect(await carryStoredChunks(blob.storage, blob.blobs, blob.catalog, { load: (entry) => entry.id === "pixels" })).toBeNull();
    const carried = await carryStoredChunks(blob.storage, blob.blobs, blob.catalog, { omit: new Set(["document"]) });
    const rewritten = await encodeBabasset({ header: HEADER, chunks: [chunk("document", SMALL), ...carried!], writeBlob: blob.writeBlob });
    // Carrying kept the digest, so the damaged blob is still rejected, not blessed.
    await expect(decodeBabasset(rewritten, (sha256) => blob.blobs.readBlob(sha256))).rejects.toThrow(/Hash mismatch for chunk pixels/);
  });

  it("returns the chunks it was asked to load with their bytes, and leaves the others carried", async () => {
    const { storage, blobs, catalog } = await stored();
    const readBlob = vi.spyOn(blobs, "readBlob");
    const result = (await carryStoredChunks(storage, blobs, catalog, { load: (entry) => entry.id === "note" }))!;
    expect(result.map((entry) => entry.id)).toEqual(["document", "pixels", "note"]);
    expect(result.map((entry) => "data" in entry)).toEqual([false, false, true]);
    expect((result[2] as ChunkInput).data).toEqual(SMALL);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("does not carry an inline chunk a re-encode would move to the blob store", async () => {
    const { storage, blobs } = await stored();
    // Written without a blob store, so the large chunk sits inline.
    await storage.writeBinary(PATH, await encodeBabasset({ header: HEADER, chunks: [chunk("document", SMALL), chunk("pixels", BIG)] }));
    const catalog = await readAssetCatalog(storage, PATH);
    expect(await carryStoredChunks(storage, blobs, catalog)).toBeNull();
    const loaded = await carryStoredChunks(storage, blobs, catalog, { load: (entry) => entry.id === "pixels" });
    expect((loaded![1] as ChunkInput).data).toEqual(BIG);
  });
});

describe("storedBabassetMatches", () => {
  it("is true only for the same header, so an edited document is still written", async () => {
    const { storage, catalog, writeBlob } = await stored();
    const same = await encodeBabasset({ header: HEADER, chunks: [chunk("document", new Uint8Array([1, 2, 3])), chunk("pixels", BIG), chunk("note", SMALL)], writeBlob });
    expect(await storedBabassetMatches(storage, catalog, same)).toBe(true);

    const edited = await encodeBabasset({ header: HEADER, chunks: [chunk("document", new Uint8Array([1, 2, 4])), chunk("pixels", BIG), chunk("note", SMALL)], writeBlob });
    expect(await storedBabassetMatches(storage, catalog, edited)).toBe(false);

    const retitled = await encodeBabasset({ header: { ...HEADER, name: "Renamed" }, chunks: [chunk("document", new Uint8Array([1, 2, 3])), chunk("pixels", BIG), chunk("note", SMALL)], writeBlob });
    expect(await storedBabassetMatches(storage, catalog, retitled)).toBe(false);
  });

  it("is false once the file changed after it was read", async () => {
    const { storage, catalog, writeBlob } = await stored();
    const same = await encodeBabasset({ header: HEADER, chunks: [chunk("document", new Uint8Array([1, 2, 3])), chunk("pixels", BIG), chunk("note", SMALL)], writeBlob });
    await storage.writeBinary(PATH, await encodeBabasset({ header: { ...HEADER, name: "Other" }, chunks: [chunk("document", SMALL)], writeBlob }));
    expect(await storedBabassetMatches(storage, catalog, same)).toBe(false);
  });
});
