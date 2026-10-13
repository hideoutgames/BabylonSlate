import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { DEFAULT_BLOB_THRESHOLD, decodeBabasset, encodeBabasset } from "./babasset";
import { BLOBS_DIR } from "./babproject";
import { createVfsBlobStore } from "./blob-store";
import { sha256Hex } from "./bytes";
import { projectContentRoot } from "./content-root";
import { AssetRegistry } from "./registry";

const PATH = "assets/tex.babasset";
/** Large enough to live in the blob store, as an imported image does. */
const PIXELS = new Uint8Array(DEFAULT_BLOB_THRESHOLD + 5).map((_, index) => index % 253);

/** KTX2 identifier plus pixelWidth / pixelHeight. */
function ktx2(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

/** A compressed Texture whose source pixels are a blob and whose one encode is off the 4x4 grid. */
async function compressedTexture() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("rewrite.babproject");
  await storage.mkdir("assets", true);
  const blobs = createVfsBlobStore(storage);
  await storage.writeBinary(PATH, await encodeBabasset({
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [], dependencies: [],
      guid: "tex-1", type: "Texture", name: "Tex", engineVersion: "0.0.0", version: 1, mode: "thin", parentClass: null,
      payload: {
        usage: "albedo", compressionState: "compressed", ktx2ChunkId: "ktx2:old",
        ktx2Width: 1, ktx2Height: 1, ktx2Sha256: await sha256Hex(ktx2(1, 1)),
      },
    },
    chunks: [
      { id: "pixels", kind: "pixels", mime: "image/png", data: PIXELS },
      { id: "ktx2:old", kind: "ktx2", mime: "image/ktx2", data: ktx2(1, 1) },
    ],
    writeBlob: (sha256, data) => blobs.writeBlob(sha256, data),
  }));
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  return { storage, registry, blobs, pixelsBlob: `${BLOBS_DIR}/${await sha256Hex(PIXELS)}` };
}

describe("Texture state writes", () => {
  it("record a compression state without reading the source pixels, keeping every chunk and the encode's digest", async () => {
    const { storage, registry, blobs } = await compressedTexture();
    const reads = vi.spyOn(storage, "readBinary");
    const writes = vi.spyOn(storage, "writeBinary");

    await registry.setCompressionState("tex-1", "encoding");

    // Neither the file nor the pixels blob was read whole, and the blob was not stored again.
    expect(reads).not.toHaveBeenCalled();
    expect(writes.mock.calls.map(([path]) => path)).toEqual([PATH]);
    writes.mockRestore();
    reads.mockRestore();

    const header = registry.getByGuid("tex-1")!.header;
    expect(header.payload).toMatchObject({ compressionState: "encoding", ktx2ChunkId: "ktx2:old", ktx2Width: 1, ktx2Height: 1 });
    expect(header.payload.ktx2Sha256).toBe(header.chunks.find((entry) => entry.id === "ktx2:old")!.sha256);
    // The rewritten file still verifies every chunk against its digest.
    const decoded = await decodeBabasset(await storage.readBinary(PATH), (sha256) => blobs.readBlob(sha256));
    expect(decoded.chunks.get("pixels")).toEqual(PIXELS);
    expect(decoded.chunks.get("ktx2:old")).toEqual(ktx2(1, 1));
    expect(decoded.header.chunks.map((entry) => entry.id)).toEqual(["pixels", "ktx2:old"]);
  });

  it("still refuse to rewrite a Texture whose source blob is missing", async () => {
    const { storage, registry, pixelsBlob } = await compressedTexture();
    await storage.remove(pixelsBlob);
    const before = await storage.readBinary(PATH);

    await expect(registry.setCompressionState("tex-1", "encoding")).rejects.toThrow();

    expect(await storage.readBinary(PATH)).toEqual(before);
  });

  it("commit an encode without reading the source pixels, and still drop an older off-grid encode", async () => {
    const { storage, registry, blobs, pixelsBlob } = await compressedTexture();
    const reads = vi.spyOn(storage, "readBinary");

    const committed = await registry.commitCompressedTexture({
      assetGuid: "tex-1", ktx2: ktx2(8, 8), wallMs: 3, chunkId: "ktx2:new",
      settings: { format: "uastc", quality: 2, maxDimension: 2048, generateMipmaps: true },
    });

    expect(committed).toBe(true);
    expect(reads.mock.calls.map(([path]) => path)).not.toContain(pixelsBlob);
    reads.mockRestore();
    const header = registry.getByGuid("tex-1")!.header;
    expect(header.chunks.map((entry) => entry.id)).toEqual(["pixels", "ktx2:new"]);
    expect(header.payload).toMatchObject({ compressionState: "compressed", ktx2ChunkId: "ktx2:new", ktx2Width: 8, ktx2Height: 8 });
    expect(header.payload.ktx2Sha256).toBe(await sha256Hex(ktx2(8, 8)));
    expect(header.payload.ktx2Sha256).toBe(header.chunks.find((entry) => entry.id === "ktx2:new")!.sha256);
    const decoded = await decodeBabasset(await storage.readBinary(PATH), (sha256) => blobs.readBlob(sha256));
    expect(decoded.chunks.get("pixels")).toEqual(PIXELS);
    expect(decoded.chunks.get("ktx2:new")).toEqual(ktx2(8, 8));
  });
});
